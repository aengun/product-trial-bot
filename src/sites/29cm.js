import { setTimeout as delay } from 'node:timers/promises';
import { BotError } from '../browser.js';
import { matchCampaign, campaignExclusionReason } from '../filters.js';
import { sizeText } from '../sizing.js';
import { validChoice, planProof, choiceLabel } from '../approvals.js';
import { PLATFORMS, seoulDate } from '../platforms.js';
import { SiteClient, notSubmitted, clipMessage } from './base.js';

export const ORIGIN = 'https://www.29cm.co.kr';
const PREUSER_API = 'https://preuser-api.29cm.co.kr';
const PRODUCT_API = 'https://bff-api.29cm.co.kr';
const ADDRESS_API = 'https://user-api.29cm.co.kr/api/v4/delivery-addresses/recent';

// 아래 함수들은 Orca 탭(29CM) 안에서 실행됩니다. 바깥 변수를 참조하지 않습니다.
// 사이트와 같이 쿠키 로그인을 쓰고, access_token이 있으면 Bearer 헤더를 붙입니다. 토큰은 결과에 넣지 않습니다.

async function cmRequest({ url, timeout }) {
  const token = (document.cookie.match(/(?:^|; )access_token=([^;]*)/)?.[1] ?? '').trim();
  const headers = token && document.cookie.includes('x-device-id') ? { Authorization: `Bearer ${decodeURIComponent(token)}` } : {};
  try {
    const response = await fetch(url, { credentials: 'include', headers, signal: AbortSignal.timeout(timeout) });
    let json = null;
    try { json = await response.json(); } catch {}
    return { status: response.status, json };
  } catch { return { status: 0, json: null }; }
}

/** 상품 상세 응답은 크므로 카테고리 이름만 돌려줍니다. */
async function cmProductCategories({ url, timeout }) {
  const token = (document.cookie.match(/(?:^|; )access_token=([^;]*)/)?.[1] ?? '').trim();
  const headers = token && document.cookie.includes('x-device-id') ? { Authorization: `Bearer ${decodeURIComponent(token)}` } : {};
  try {
    const response = await fetch(url, { credentials: 'include', headers, signal: AbortSignal.timeout(timeout) });
    if (response.status !== 200) return { status: response.status, categories: null };
    const info = (await response.json())?.data?.frontCategoryInfo;
    return { status: 200, categories: Array.isArray(info)
      ? info.map(c => [String(c?.category1Name ?? ''), String(c?.category2Name ?? '')]) : null };
  } catch { return { status: 0, categories: null }; }
}

/** 기본 배송지가 정확히 하나인지만 확인합니다. 주소·연락처는 탭 밖으로 꺼내지 않습니다. */
async function cmAddressCheck({ url, timeout }) {
  const token = (document.cookie.match(/(?:^|; )access_token=([^;]*)/)?.[1] ?? '').trim();
  const headers = token && document.cookie.includes('x-device-id') ? { Authorization: `Bearer ${decodeURIComponent(token)}` } : {};
  try {
    const response = await fetch(url, { credentials: 'include', headers, signal: AbortSignal.timeout(timeout) });
    if (response.status !== 200) return { status: response.status, primary: 0 };
    const list = (await response.json())?.data;
    return { status: 200, primary: Array.isArray(list) ? list.filter(a => a?.isPrimary === true && a.isDeleted !== true).length : 0 };
  } catch { return { status: 0, primary: 0 }; }
}

/**
 * 29CM 앱의 신청서와 같은 요청을 보냅니다: 기본 배송지(기존 배송지)와 선택 옵션.
 * 배송지는 탭 안에서만 읽어 요청에 넣고, 결과에는 응답 상태와 서버 안내 문구만 담습니다.
 */
async function cmApply({ url, addressUrl, itemId, optionId, timeout }) {
  const token = (document.cookie.match(/(?:^|; )access_token=([^;]*)/)?.[1] ?? '').trim();
  const auth = token && document.cookie.includes('x-device-id') ? { Authorization: `Bearer ${decodeURIComponent(token)}` } : {};
  let list;
  try {
    const response = await fetch(addressUrl, { credentials: 'include', headers: auth, signal: AbortSignal.timeout(timeout) });
    if (response.status !== 200) return { stage: 'address', status: response.status };
    list = (await response.json())?.data;
  } catch { return { stage: 'address', status: 0 }; }
  const primary = Array.isArray(list) ? list.filter(a => a?.isPrimary === true && a.isDeleted !== true) : [];
  if (primary.length !== 1) return { stage: 'address', status: 200, primary: primary.length };
  const a = primary[0];
  const body = { itemId, ...(optionId === null ? {} : { optionId }), addressName: a.addressName, receiverName: a.receiverName,
    receiverZipcode: a.receiverZipcode, receiverPhone: a.receiverPhone, receiverAdditionalPhone: a.receiverAdditionalPhone,
    receiverAddress: a.receiverAddress1, receiverDetailAddress: a.receiverAddress2, etcMessage: a.etcMessage,
    isNewDeliveryAddress: false };
  try {
    const response = await fetch(url, { method: 'POST', credentials: 'include',
      headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    let json = null;
    try { json = await response.json(); } catch {}
    return { stage: 'apply', status: response.status, result: json?.meta?.result ?? null,
      message: typeof json?.meta?.message === 'string' ? json.meta.message : null,
      applied: typeof json?.data?.preuserEventApplicantKey === 'string' };
  } catch { return { stage: 'apply', status: 0 }; }
}

/** 옵션 트리의 끝(실제 optionId)마다 선택지 하나. 옵션이 없는 상품은 '기본 구성' 하나입니다. */
export function optionChoices(detail) {
  const productUniqueId = String(detail.itemId), productName = detail.itemName;
  const choice = (optionNo, steps, selectedSize, index) => ({ productUniqueId, optionNo, productName, selectedSize,
    choiceKey: `옵션${index + 1}`, selectionKind: 'option', steps });
  if (detail.itemOptionType === 'NO_OPTION') return [choice(detail.itemId, ['NONE'], '기본 구성', 0)];
  const leaves = [];
  const walk = (node, path) => {
    for (const child of node?.childList ?? []) {
      const value = String(child?.optionItemValue ?? '').trim() || String(child?.optionItemLabel ?? '').trim();
      const next = [...path, { label: String(child?.optionItemLabel ?? ''), value }];
      if (child?.option) leaves.push({ optionId: child.option.optionId, path: next });
      else walk(child, next);
    }
  };
  walk(detail.itemOptionTreeNode, []);
  return leaves.map((leaf, index) => choice(leaf.optionId, leaf.path.map(p => p.value),
    leaf.path.find(p => /size|사이즈/i.test(p.label))?.value ?? leaf.path.map(p => p.value).join(' / '), index))
    .filter(validChoice);
}

/** 29CM 상품 카테고리로 여성 전용·키즈·뷰티를 구분합니다. 남성·공용·생활 카테고리가 하나라도 있으면 여성 전용이 아닙니다. */
/** 프로필의 상의·하의·신발 사이즈와 정확히 같은 옵션 값입니다. 슬랙 버튼에 추천으로 표시만 합니다. */
export function profileSizes(choices, profile) {
  if (!profile) return [];
  const wanted = new Set([...(profile.topSizes ?? []), ...(profile.bottomSizes ?? []), profile.shoeSize].filter(Boolean).map(sizeText));
  return [...new Set(choices.flatMap(choice => choice.steps).filter(step => wanted.has(sizeText(step))))];
}

export function categoryInfo(categories) {
  const names = (categories ?? []).map(([first]) => first).filter(Boolean);
  return {
    // 공용 상품은 여성 카테고리가 먼저 와도 남성·생활 카테고리를 표시합니다.
    label: names.find(name => !/^여성|우먼|women/i.test(name)) ?? names[0] ?? '',
    kids: names.some(name => /키즈|아동|유아|베이비|kids/i.test(name)),
    womenOnly: names.length > 0 && names.every(name => /^여성|우먼|women/i.test(name)),
    beauty: names.some(name => /뷰티|beauty/i.test(name)),
  };
}

export function exclusionReason(campaign, categories, config) {
  const info = categoryInfo(categories);
  if (info.kids && config.excludeCategories?.includes('키즈')) return '키즈 제외';
  if (config.gender === 'M' && info.womenOnly) return '여성 상품 제외';
  return campaignExclusionReason({ ...campaign, category: info.beauty ? '뷰티' : info.label }, config);
}

const inWindow = (detail, now = Date.now()) => Date.parse(detail.recruitStartAt) <= now && now <= Date.parse(detail.recruitEndAt);

export class TwentyNineClient extends SiteClient {
  constructor(tab, config, { origin = ORIGIN, preuserApi = PREUSER_API, productApi = PRODUCT_API, addressApi = ADDRESS_API, settleMs = 3000 } = {}) {
    super(tab, config, { origin, startPath: '/preuser', siteName: '29CM' });
    Object.assign(this, { preuserApi, productApi, addressApi, settleMs });
    this.prepared = null;
  }
  async request(url, what) {
    const response = await this.inPage(cmRequest, { url });
    this.checkBlocked(response, what);
    return response;
  }
  /** 로그인 쿠키가 만료 직전이면 사이트가 탭을 열 때 갱신하므로, 처음 실패하면 한 번 다시 열어 확인합니다. */
  async isLoggedIn() {
    const check = async () => {
      const response = await this.request(`${this.preuserApi}/api/v4/preuser/events/my-applications/count`, '로그인 확인');
      return response.status === 200 && response.json?.meta?.result === 'SUCCESS';
    };
    if (await check()) return true;
    await this.goto(this.startPath);
    await delay(this.settleMs);
    return await check();
  }
  async scan(signal) {
    await this.goto(this.startPath);
    const found = new Map(), now = Date.now();
    let complete = false;
    for (let page = 1; page <= this.config.maxPages; page++) {
      signal?.throwIfAborted();
      const response = await this.request(`${this.preuserApi}/api/v4/preuser/events?page=${page}&size=50`, '공고 목록');
      const data = response.json?.data;
      if (response.status !== 200 || response.json?.meta?.result !== 'SUCCESS' || !Array.isArray(data?.list)
        || typeof data.pagination?.hasNext !== 'boolean') throw new BotError('source-changed', '29CM 체험단 목록 응답 형식이 변경됐습니다.', true);
      let open = 0;
      for (const item of data.list) {
        const end = Date.parse(item?.recruitEndAt);
        if (!PLATFORMS['29cm'].idPattern.test(item?.preuserEventKey ?? '') || typeof item.itemName !== 'string'
          || !Number.isSafeInteger(item.itemId) || !Number.isFinite(end)) throw new BotError('source-changed', '29CM 체험단 번호·상품을 확인할 수 없습니다.', true);
        if (end < now) continue;
        open++;
        const brand = item.frontBrandNameKor || item.frontBrandNameEng || '';
        const campaign = { id: item.preuserEventKey, title: [brand, item.itemName].filter(Boolean).join(' '), brand,
          itemId: String(item.itemId), endDate: seoulDate(item.recruitEndAt), applicants: item.applicantCount,
          recruitment: item.totalWinnerLimit, url: `${this.origin}/preuser/event/${item.preuserEventKey}` };
        if (matchCampaign(campaign, this.config)) found.set(campaign.id, campaign);
      }
      // 목록은 모집 마감이 늦은 순서입니다. 한 페이지가 모두 마감됐으면 뒤 페이지도 마감된 공고입니다.
      if (!data.pagination.hasNext || open === 0) { complete = true; break; }
      await delay(this.config.actionDelayMs, undefined, { signal });
    }
    return { campaigns: [...found.values()], complete };
  }
  async detail(key) {
    const response = await this.request(`${this.preuserApi}/api/v4/preuser/events/${encodeURIComponent(key)}`, '공고 상세');
    const detail = response.json?.data;
    if (response.status !== 200 || response.json?.meta?.result !== 'SUCCESS' || detail?.preuserEventKey !== key
      || !Number.isSafeInteger(detail.itemId) || typeof detail.itemName !== 'string'
      || !['OPTION', 'NO_OPTION'].includes(detail.itemOptionType)) throw new BotError('source-changed', '29CM 체험단 상세 응답 형식이 변경됐습니다.', true);
    return detail;
  }
  async categories(itemId) {
    const response = await this.inPage(cmProductCategories, { url: `${this.productApi}/api/v5/product-detail/${itemId}` });
    this.checkBlocked(response, '상품 정보');
    return response.categories;
  }
  /** 공고 API만 읽어 옵션을 정합니다. 슬랙에서 고른 옵션(decision)이 있어야 신청 계획이 됩니다. */
  async plan(campaign, decision = null) {
    const detail = await this.detail(campaign.id);
    if (detail.isUserApplied === true) return { status: 'already-applied', reason: '사이트에서 이미 신청한 체험단입니다.' };
    if (!inWindow(detail)) return { status: 'skipped', reason: '모집 기간이 아닙니다.' };
    const categories = await this.categories(detail.itemId);
    const category = categoryInfo(categories).label || undefined;
    const excluded = exclusionReason({ ...campaign, title: [campaign.brand, detail.itemName].filter(Boolean).join(' ') }, categories, this.config);
    if (excluded) return { status: 'skipped', reason: excluded, category };
    const choices = optionChoices(detail);
    if (!choices.length) return { status: 'skipped', reason: '신청 가능한 옵션을 확인할 수 없습니다.', category };
    const base = { eventId: campaign.id, category };
    const chosen = decision && choices.find(c => c.productUniqueId === decision.productUniqueId && c.optionNo === decision.optionNo);
    const recommended = profileSizes(choices, this.config.profile);
    if (chosen) return { ...base, status: 'planned', ...chosen, choices, reason: `슬랙에서 선택한 옵션: ${choiceLabel(chosen)}` };
    return { ...base, status: 'needs-size-review', selectionKind: 'option',
      reason: decision ? '선택한 옵션이 사이트에서 바뀌었습니다. 다시 선택해 주세요.' : '신청할 옵션을 선택해 주세요.',
      review: { productUniqueId: String(detail.itemId), productName: detail.itemName, productUrl: `${this.origin}/products/${detail.itemId}`,
        availableSizes: [...new Set(choices.map(c => c.selectedSize))], measurements: [], choices,
        ...(recommended.length ? { recommendation: { productUniqueId: String(detail.itemId), sizes: recommended } } : {}) } };
  }
  async prepare(plan) {
    this.prepared = null;
    await this.goto(this.startPath);
    if (!await this.isLoggedIn()) throw new BotError('login-required', '29CM 로그인이 필요합니다. npm run 29cm:login으로 Orca 탭에서 로그인하세요.', true);
    this.requireConsents();
    const detail = await this.detail(plan.eventId);
    if (detail.isUserApplied === true) throw new BotError('already-applied', '사이트에서 이미 신청한 체험단입니다.');
    if (!inWindow(detail)) throw new BotError('closed', '모집 기간이 끝나 신청하지 않습니다.');
    if (!optionChoices(detail).some(choice => planProof(choice) === planProof(plan))) {
      throw new BotError('option-changed', '선택한 옵션이 사이트에서 바뀌어 신청하지 않습니다.');
    }
    const address = await this.inPage(cmAddressCheck, { url: this.addressApi });
    this.checkBlocked(address, '배송지');
    if (address.status === 401) throw new BotError('login-required', '29CM 로그인이 필요합니다. npm run 29cm:login으로 Orca 탭에서 로그인하세요.', true);
    if (address.status !== 200) throw new BotError('source-changed', '29CM 배송지 목록을 읽지 못했습니다.', true);
    if (address.primary !== 1) throw new BotError('address-required', '29CM 기본 배송지를 하나 등록해야 합니다.', true);
    this.prepared = { eventId: plan.eventId, optionId: detail.itemOptionType === 'NO_OPTION' ? null : plan.optionNo };
  }
  /** 서버 응답이 애매하면 공고의 신청 여부로 다시 확인합니다. */
  async appliedNow(key) {
    try { return (await this.detail(key)).isUserApplied === true; }
    catch { return null; }
  }
  async submit(plan) {
    if (this.prepared?.eventId !== plan.eventId) throw new BotError('unexpected-page', '신청 준비가 끝나지 않은 공고라 제출하지 않습니다.', true);
    const { optionId } = this.prepared;
    this.prepared = null;
    const response = await this.inPage(cmApply, { url: `${this.preuserApi}/api/v4/preuser/events/${encodeURIComponent(plan.eventId)}/apply`,
      addressUrl: this.addressApi, itemId: Number(plan.productUniqueId), optionId });
    const loginExpired = () => notSubmitted('login-required', '29CM 로그인이 만료되어 신청하지 않았습니다. npm run 29cm:login으로 다시 로그인하세요.', true);
    if (response.stage === 'address') {
      if (response.status === 401) throw loginExpired();
      throw notSubmitted('address-required', response.primary === undefined
        ? '29CM 배송지를 읽지 못해 신청하지 않았습니다.' : '29CM 기본 배송지를 하나 등록해야 합니다.', true);
    }
    if (response.status === 200 && response.result === 'SUCCESS' && response.applied) return { confirmedAt: new Date().toISOString() };
    const applied = await this.appliedNow(plan.eventId);
    if (applied === true) return { confirmedAt: new Date().toISOString() };
    if (applied === false && response.status === 401) throw loginExpired();
    if (applied === false && response.status >= 400 && response.status < 500) {
      throw notSubmitted('apply-rejected', `29CM가 신청을 받지 않았습니다${response.message ? `: ${clipMessage(response.message)}` : ` (HTTP ${response.status})`}`);
    }
    throw new BotError('uncertain', '29CM 신청 결과를 확인하지 못했습니다.');
  }
}
