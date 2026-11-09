import { setTimeout as delay } from 'node:timers/promises';
import { BotError } from '../browser.js';
import { matchCampaign, campaignExclusionReason } from '../filters.js';
import { planProof } from '../approvals.js';
import { seoulDate } from '../platforms.js';
import { SiteClient, notSubmitted, clipMessage } from './base.js';

export const ORIGIN = 'https://4910.kr';
const API = 'https://api.a-bly.com/aglo/api';
/** 사이트 안내: 한 모집에서 5개 미만으로 신청하면 당첨 대상에서 제외됩니다. */
export const MIN_ENTRIES = 5;
const RECRUITING = 2;

// 아래 함수는 Orca 탭(4910) 안에서 실행됩니다. 바깥 변수를 참조하지 않습니다.
// 사이트와 같은 헤더를 붙입니다. 로그인 토큰은 쿠키에서 읽어 요청에만 쓰고 결과에 넣지 않습니다.
async function ablyRequest({ url, method = 'GET', timeout }) {
  const cookie = name => {
    const found = document.cookie.split('; ').find(part => part.startsWith(`${name}=`));
    return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
  };
  const headers = { 'X-Device-Type': 'PCWeb', 'X-App-Version': '0.1.0', 'X-App-Type': 'AGLO' };
  const member = cookie('ably-jwt-token'), anonymous = cookie('ably-anonymous-token'), device = cookie('HTTP_X_DEVICE_ID');
  if (member) headers.Authorization = `JWT ${member}`;
  else if (anonymous) headers['X-Anonymous-Token'] = anonymous;
  if (device) headers['X-Device-Id'] = device;
  try {
    const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeout) });
    let json = null;
    try { json = await response.json(); } catch {}
    return { status: response.status, member: Boolean(member), json };
  } catch { return { status: 0, member: Boolean(member), json: null }; }
}

/** 4910 패션 스태프는 옵션·배송지 없이 상품마다 '상품 신청'만 합니다. 승인 버튼 하나로 보냅니다. */
export function entryChoice(sno, detail) {
  return { productUniqueId: String(detail.goods.sno), optionNo: Number(sno), productName: detail.goods.name ?? '',
    selectedSize: '상품 신청', choiceKey: '옵션1', selectionKind: 'option', steps: ['NONE'] };
}

const validDetail = (detail, sno) => detail && typeof detail === 'object' && Number.isSafeInteger(detail.goods?.sno)
  && Number.isSafeInteger(detail.status) && typeof detail.participation_status?.is_entered === 'boolean'
  && typeof detail.participation_status.is_enterable === 'boolean' && (detail.preuser_goods_sno === undefined || detail.preuser_goods_sno === sno);

export class FourNineTenClient extends SiteClient {
  constructor(tab, config, { origin = ORIGIN, api = API } = {}) {
    super(tab, config, { origin, startPath: '/preuser', siteName: '4910' });
    this.api = api; this.prepared = null;
  }
  async request(path, what, method = 'GET') {
    const response = await this.inPage(ablyRequest, { url: `${this.api}${path}`, method });
    this.checkBlocked(response, what);
    return response;
  }
  async isLoggedIn() {
    const response = await this.request('/preuser/participants/me/participations/?limit=1&status=entered', '로그인 확인');
    return response.member && response.status === 200;
  }
  async scan(signal) {
    await this.goto(this.startPath);
    const found = new Map();
    let complete = false, lastSno = null;
    for (let page = 1; page <= this.config.maxPages; page++) {
      signal?.throwIfAborted();
      const response = await this.request(`/preuser-goods/?limit=20&status=recruiting${lastSno ? `&last_sno=${lastSno}` : ''}`, '공고 목록');
      const list = response.json?.preuser_goods_list;
      if (response.status !== 200 || !Array.isArray(list)) throw new BotError('source-changed', '4910 패션 스태프 목록 응답 형식이 변경됐습니다.', true);
      for (const item of list) {
        const goods = item?.goods;
        const goodsSno = goods?.item?.sno ?? goods?.sno;
        const name = goods?.render?.data?.name ?? goods?.name;
        if (!Number.isSafeInteger(item?.preuser_goods_sno) || !Number.isSafeInteger(goodsSno) || typeof name !== 'string') {
          throw new BotError('source-changed', '4910 패션 스태프 상품 번호·이름을 확인할 수 없습니다.', true);
        }
        const brand = goods.render?.data?.market_name ?? goods.market?.name ?? goods.brand_name ?? '';
        const id = String(item.preuser_goods_sno);
        const campaign = { id, title: [brand, name].filter(Boolean).join(' '), brand, goodsSno: String(goodsSno),
          endDate: seoulDate(item.recruit_finished_at), applicants: item.entered_count, recruitment: item.capacity,
          url: `${this.origin}/preuser/goods/${goodsSno}?preuser_goods_sno=${id}` };
        if (matchCampaign(campaign, this.config)) found.set(id, campaign);
      }
      lastSno = response.json.last_sno;
      if (!list.length || lastSno === null || lastSno === undefined) { complete = true; break; }
      await delay(this.config.actionDelayMs, undefined, { signal });
    }
    return { campaigns: [...found.values()], complete };
  }
  async detail(sno) {
    const response = await this.request(`/preuser-goods/${encodeURIComponent(sno)}/`, '상품 상세');
    if (response.status !== 200 || !validDetail(response.json, Number(sno))) throw new BotError('source-changed', '4910 패션 스태프 상세 응답 형식이 변경됐습니다.', true);
    return response.json;
  }
  async plan(campaign, decision = null) {
    const detail = await this.detail(campaign.id);
    const status = detail.participation_status;
    if (status.is_entered) return { status: 'already-applied', reason: '사이트에서 이미 신청한 상품입니다.' };
    if (detail.status !== RECRUITING) return { status: 'skipped', reason: '모집 중이 아닙니다.' };
    if (!status.is_enterable) return { status: 'skipped', reason: '사이트에서 신청할 수 없는 상태입니다.' };
    const excluded = campaignExclusionReason({ ...campaign, title: [campaign.brand, detail.goods.name ?? campaign.title].filter(Boolean).join(' ') }, this.config);
    if (excluded) return { status: 'skipped', reason: excluded };
    const choice = entryChoice(campaign.id, { ...detail, goods: { ...detail.goods, name: detail.goods.name ?? campaign.title } });
    const base = { eventId: campaign.id, goodsSno: String(detail.goods.sno) };
    if (decision && decision.productUniqueId === choice.productUniqueId && decision.optionNo === choice.optionNo) {
      return { ...base, status: 'planned', ...choice, choices: [choice], reason: '슬랙에서 승인한 상품' };
    }
    return { ...base, status: 'needs-size-review', selectionKind: 'option',
      reason: `승인하면 신청합니다. 이번 모집에서 ${MIN_ENTRIES}개 이상 신청해야 당첨 대상입니다.`,
      review: { productUniqueId: choice.productUniqueId, productName: choice.productName,
        productUrl: campaign.url, availableSizes: [choice.selectedSize], measurements: [], choices: [choice] } };
  }
  async prepare(plan) {
    this.prepared = null;
    await this.goto(this.startPath);
    if (!await this.isLoggedIn()) throw new BotError('login-required', '4910 로그인이 필요합니다. npm run 4910:login으로 Orca 탭에서 로그인하세요.', true);
    const detail = await this.detail(plan.eventId);
    if (detail.participation_status.is_entered) throw new BotError('already-applied', '사이트에서 이미 신청한 상품입니다.');
    if (detail.status !== RECRUITING || !detail.participation_status.is_enterable) throw new BotError('closed', '모집이 끝났거나 신청할 수 없는 상태라 신청하지 않습니다.');
    if (planProof(entryChoice(plan.eventId, detail)) !== planProof(plan)) {
      throw new BotError('option-changed', '상품 구성이 사이트에서 바뀌어 신청하지 않습니다.');
    }
    this.prepared = plan.eventId;
  }
  async enteredNow(sno) {
    try { return (await this.detail(sno)).participation_status.is_entered === true; }
    catch { return null; }
  }
  /** 이번 모집에서 신청한 상품 수(최대 100개까지 셈). 확인하지 못하면 null. */
  async enteredCount() {
    try {
      let count = 0, lastSno = null;
      for (let page = 0; page < 5; page++) {
        const response = await this.request(`/preuser/participants/me/participations/?limit=20&status=entered${lastSno ? `&last_sno=${lastSno}` : ''}`, '신청 목록');
        const list = response.json?.participation_list;
        if (response.status !== 200 || !Array.isArray(list)) return null;
        count += list.length;
        if (list.length < 20) return count;
        lastSno = list.at(-1)?.sno;
        if (!lastSno) return count;
      }
      return count;
    } catch { return null; }
  }
  async submit(plan) {
    if (this.prepared !== plan.eventId) throw new BotError('unexpected-page', '신청 준비가 끝나지 않은 상품이라 제출하지 않습니다.', true);
    this.prepared = null;
    const response = await this.request(`/preuser-goods/${encodeURIComponent(plan.eventId)}/participants/enter/`, '상품 신청', 'POST');
    const accepted = response.status >= 200 && response.status < 300;
    const entered = await this.enteredNow(plan.eventId);
    if (entered === true || (accepted && entered === null)) {
      const count = await this.enteredCount();
      return { confirmedAt: new Date().toISOString(), ...(count === null ? {} : { enteredCount: count,
        note: count >= MIN_ENTRIES ? `이번 모집 신청 ${count}개 (${MIN_ENTRIES}개 이상 충족)` : `이번 모집 신청 ${count}개 · ${MIN_ENTRIES - count}개 더 신청해야 당첨 대상입니다.` }) };
    }
    if (entered === false && response.status === 401) {
      throw notSubmitted('login-required', '4910 로그인이 만료되어 신청하지 않았습니다. npm run 4910:login으로 다시 로그인하세요.', true);
    }
    if (entered === false && response.status >= 400 && response.status < 500) {
      const message = response.json?.message ?? response.json?.error_message ?? response.json?.detail;
      throw notSubmitted('apply-rejected', `4910이 신청을 받지 않았습니다${message ? `: ${clipMessage(message)}` : ` (HTTP ${response.status})`}`);
    }
    throw new BotError('uncertain', '4910 신청 결과를 확인하지 못했습니다.');
  }
}
