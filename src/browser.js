import { setTimeout as delay } from 'node:timers/promises';
import { CONSENTS } from './config.js';
import { normalize, matchCampaign, campaignExclusionReason, CATEGORY_NAMES } from './filters.js';
import { representativeProduct, planOptions, extractSizeTable, sizeTableFromApi } from './sizing.js';
import { OrcaError } from './orca.js';

export const ORIGIN = 'https://www.musinsa.com';
export class BotError extends Error {
  constructor(code, message, fatal = false) { super(message); this.code = code; this.fatal = fatal; }
}

// 아래 함수들은 Orca 탭 안에서 실행됩니다. 바깥 변수를 참조하지 않습니다.

/** 조건에 맞는 요소를 찾아 상태를 돌려줍니다. mark를 주면 유일한 요소에 클릭용 표시를 붙입니다. */
function locate({ selector, role, name, visibleOnly = false, child, nth, require = 'present', mark, texts = false }) {
  const isVisible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const a11yHidden = e => { for (let n = e; n; n = n.parentElement) { if (n.getAttribute('aria-hidden') === 'true' || getComputedStyle(n).display === 'none') return true; } return getComputedStyle(e).visibility === 'hidden'; };
  const label = e => (e.getAttribute('aria-label') ?? e.textContent).replace(/\s+/g, ' ').trim();
  const roles = { button: 'button, [role="button"], input[type="button"], input[type="submit"]', link: 'a[href], [role="link"]' };
  let nodes = [...document.querySelectorAll(selector ?? roles[role])];
  if (role) nodes = nodes.filter(e => !a11yHidden(e));
  if (name !== undefined) nodes = nodes.filter(e => label(e) === name);
  if (visibleOnly) nodes = nodes.filter(isVisible);
  if (child) nodes = nodes.length === 1 ? [...nodes[0].querySelectorAll(child)] : [];
  const listed = texts ? nodes.map(e => e.textContent) : undefined;
  if (nth !== undefined) nodes = nodes[nth] ? [nodes[nth]] : [];
  document.querySelectorAll('[data-musinsa-bot]').forEach(e => e.removeAttribute('data-musinsa-bot'));
  const e = nodes[0];
  if (!e && require !== 'none') return null;
  if (require === 'visible' && !isVisible(e)) return null;
  if (mark && nodes.length === 1) e.setAttribute('data-musinsa-bot', mark);
  return { count: nodes.length, texts: listed, visible: !!e && isVisible(e),
    enabled: !!e && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !e.closest('fieldset:disabled'),
    checked: !!e && (typeof e.checked === 'boolean' ? e.checked : e.getAttribute('aria-checked') === 'true') };
}

function pageState() {
  const blocked = !!document.querySelector('iframe[src*="captcha"], iframe[title*="CAPTCHA"], #captcha')
    || /자동입력 방지|로봇이 아닙니다|접근이 제한되었습니다|Access Denied|인증이 필요합니다/.test(document.body?.innerText ?? '');
  return { href: location.href, blocked };
}

function noVisible(selector) {
  return ![...document.querySelectorAll(selector)].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; });
}

function hasVisibleText({ text, exact }) {
  if (!exact) return new RegExp(text).test(document.body?.innerText ?? '');
  return [...document.querySelectorAll('body *')].some(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && e.textContent.replace(/\s+/g, ' ').trim() === text;
  });
}

function checkboxIds() {
  const hidden = e => { for (let n = e; n; n = n.parentElement) { if (n.getAttribute('aria-hidden') === 'true' || getComputedStyle(n).display === 'none') return true; } return getComputedStyle(e).visibility === 'hidden'; };
  return [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(e => !hidden(e)).map(e => e.id);
}

export class MusinsaClient {
  /** tab: Orca 내장 브라우저 탭(OrcaTab). */
  constructor(tab, config, { origin = ORIGIN } = {}) {
    this.tab = tab; this.config = config; this.origin = origin; this.marks = 0;
    this.goodsApi = origin === ORIGIN ? 'https://goods-detail.musinsa.com' : origin;
  }
  async start() { await this.goto('/preuser/main'); }
  async run(action) {
    try { return await action(); }
    catch (error) {
      if (error instanceof OrcaError && error.code === 'dialog') throw new BotError('dialog', error.message);
      throw error;
    }
  }
  wait(fn, arg, message) { return this.run(() => this.tab.waitFor(fn, arg, { timeoutMs: this.config.timeoutMs, message })); }
  async click(query, what) {
    const mark = `m${++this.marks}`;
    const found = await this.run(() => this.tab.evaluate(locate, { ...query, mark }));
    if (found?.count !== 1) throw new BotError('source-changed', `${what}을(를) 화면에서 하나로 특정하지 못했습니다.`, true);
    await this.run(() => this.tab.click(`[data-musinsa-bot="${mark}"]`));
  }
  async assertPage() {
    const state = await this.run(() => this.tab.evaluate(pageState));
    const url = new URL(state.href);
    if (/member\.one\.musinsa\.com$/.test(url.hostname) || /\/auth\/login/.test(url.pathname)) {
      throw new BotError('login-required', '로그인이 필요합니다. npm run login으로 Orca 탭에서 로그인하세요.', true);
    }
    if (url.origin !== this.origin) throw new BotError('unexpected-page', '예상하지 못한 페이지로 이동해 중단합니다.', true);
    if (state.blocked) throw new BotError('access-blocked', '접근 제한 또는 추가 인증 화면입니다. Orca 탭에서 확인하세요.', true);
  }
  async goto(path) {
    const status = await this.run(() => this.tab.goto(`${this.origin}${path}`, { timeoutMs: this.config.timeoutMs }));
    if ([401, 403, 429].includes(status)) throw new BotError('access-blocked', `페이지 접근이 제한됐습니다 (HTTP ${status}).`, true);
    if (status >= 400) throw new BotError('page-error', `페이지 요청 실패 (HTTP ${status}).`);
    await this.assertPage();
  }
  async readApi(path) {
    await this.assertPage();
    const response = await this.run(() => this.tab.evaluate(async ({ path, timeout }) => {
      try {
        const r = await fetch(path, { signal: AbortSignal.timeout(timeout) });
        return { status: r.status, body: await r.json() };
      } catch { return { status: 0 }; }
    }, { path, timeout: this.config.timeoutMs }));
    if ([401, 403, 429].includes(response.status)) throw new BotError('access-blocked', `데이터 접근이 제한됐습니다 (HTTP ${response.status}).`, true);
    if (response.status !== 200 || !response.body || !('data' in response.body)) {
      throw new BotError('source-changed', '공고 데이터를 읽지 못했습니다. API 응답 형식 또는 접속 상태를 확인하세요.', true);
    }
    return response.body.data;
  }
  /** 새 탭의 첫 로드 직후에는 세션 복원이 끝나지 않았을 수 있어 잠시 다시 확인합니다. */
  async isLoggedIn({ settleMs = 5000 } = {}) {
    await this.assertPage();
    const url = this.origin === ORIGIN ? 'https://my.musinsa.com/api/member/v1/login-status' : '/api/member/v1/login-status';
    const check = ({ url, timeout }) => fetch(url, { credentials: 'include', signal: AbortSignal.timeout(timeout) })
      .then(r => r.ok ? r.json() : null).then(j => j?.data?.loggedIn === true).catch(() => false);
    try { return await this.run(() => this.tab.waitFor(check, { url, timeout: this.config.timeoutMs }, { timeoutMs: settleMs })); }
    catch (error) { if (error instanceof OrcaError && error.code === 'timeout') return false; throw error; }
  }
  async scan(signal) {
    await this.goto('/preuser/main');
    const filters = await this.readApi('/preuser/api/v1/event/filters');
    if (!Array.isArray(filters?.categories)) throw new BotError('source-changed', '카테고리 응답 형식이 변경됐습니다.', true);
    const found = new Map(); let complete = true;
    const categories = this.config.categories.includes('전체') && this.config.excludeCategories.length
      ? filters.categories.filter(category => category.id !== 'ALL').map(category => category.description)
      : this.config.categories;
    for (const name of categories.filter(name => !this.config.excludeCategories.includes(name))) {
      const category = filters.categories.find(x => x.description === name);
      if (!category) throw new BotError('source-changed', `카테고리가 없습니다: ${name}`, true);
      let hasNext = true;
      for (let page = 1; page <= this.config.maxPages && hasNext; page++) {
        signal?.throwIfAborted();
        const query = new URLSearchParams({ page: String(page), size: '18', sort: 'LATEST_REGISTRATION' });
        if (category.id !== 'ALL') query.set('category', category.id);
        if (this.config.gender !== 'A') {
          query.append('genders', this.config.gender); query.append('genders', 'P');
        }
        const data = await this.readApi(`/preuser/api/v1/event/events?${query}`);
        if (!Array.isArray(data?.content) || typeof data.hasNext !== 'boolean') throw new BotError('source-changed', '공고 목록 응답 형식이 변경됐습니다.', true);
        for (const item of data.content) {
          if (!/^\d+$/.test(String(item.id)) || typeof item.name !== 'string') throw new BotError('source-changed', '체험단 번호·제목을 확인할 수 없습니다.', true);
          if (item.state !== 'OPEN') continue;
          const campaign = { id: String(item.id), title: item.name, brand: item.brand?.name ?? '',
            category: name, endDate: item.endDate, applicants: item.applicantsCount,
            recruitment: item.recruitmentCount, url: `${this.origin}/preuser/events/${item.id}` };
          if (matchCampaign(campaign, this.config)) found.set(campaign.id, campaign);
        }
        hasNext = data.hasNext;
        if (hasNext) await delay(this.config.actionDelayMs, undefined, { signal });
      }
      if (hasNext) complete = false;
    }
    return { campaigns: [...found.values()], complete };
  }
  /**
   * 상품 페이지 실측표가 쓰는 API를 먼저 읽습니다. 페이지 이동이 없어 빠릅니다.
   * API를 읽지 못했거나 형식이 바뀌었을 때만 같은 탭에서 상품 페이지의 실측표를 읽습니다.
   */
  async sizeTable(product) {
    if (!/^\d+$/.test(String(product.uniqueId))) return null;
    const data = await this.run(() => this.tab.evaluate(async ({ url, timeout }) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
        return r.ok ? (await r.json())?.data ?? null : null;
      } catch { return null; }
    }, { url: `${this.goodsApi}/api2/goods/${product.uniqueId}/actual-size`, timeout: this.config.timeoutMs }));
    if (Array.isArray(data?.sizes)) return sizeTableFromApi(data);
    const status = await this.run(() => this.tab.goto(`${this.origin}/products/${product.uniqueId}`, { timeoutMs: this.config.timeoutMs }));
    if (status >= 400) return null;
    if (new URL(await this.run(() => this.tab.url())).origin !== this.origin) return null;
    await this.wait(() => Array.from(document.querySelectorAll('table')).some(t => t.textContent.includes('가슴단면'))).catch(error => {
      if (error instanceof BotError) throw error;
    });
    return await this.run(() => this.tab.evaluate(extractSizeTable));
  }
  /** 공고 API만 읽어 옵션을 정합니다. 체험단 페이지는 실제 신청할 때(prepare)만 엽니다. */
  async plan(campaign, decision = null, { allOptions = false } = {}) {
    const event = await this.readApi(`/preuser/api/v1/event/events/${campaign.id}`);
    if (String(event?.eventId) !== campaign.id) throw new BotError('source-changed', '체험단 상세 번호가 일치하지 않습니다.', true);
    if (event.isRegistration) return { status: 'already-applied', reason: '사이트에서 이미 신청한 체험단입니다.' };
    if (event.state !== 'OPEN') return { status: 'skipped', reason: '모집이 종료되었습니다.' };
    const category = CATEGORY_NAMES[event.eventCategory] ?? campaign.category;
    const excluded = campaignExclusionReason({ ...campaign, title: event.name, category }, this.config);
    if (excluded) return { status: 'skipped', reason: excluded };
    const selectedProduct = decision?.productUniqueId
      ? event.products?.find(product => String(product.uniqueId) === decision.productUniqueId) : null;
    const product = decision?.productUniqueId
      ? representativeProduct({ ...event, products: selectedProduct ? [selectedProduct] : [] }, this.config)
      : representativeProduct(event, this.config);
    const table = this.config.profile && ['TOP', 'OUTER'].includes(event.eventCategory)
      && !this.config.campaignOptions[campaign.id]?.length && !decision && product ? await this.sizeTable(product) : null;
    const plan = { ...planOptions(event, product, this.config, table, decision), eventId: campaign.id,
      category };
    if (allOptions && plan.status === 'skipped' && plan.choices?.length) {
      return { ...plan, status: 'needs-size-review', review: {
        productUniqueId: product ? String(product.uniqueId) : plan.choices[0].productUniqueId,
        productName: product?.name ?? plan.choices[0].productName,
        productUrl: `${this.origin}/products/${product?.uniqueId ?? plan.choices[0].productUniqueId}`,
        availableSizes: [...new Set(plan.choices.map(choice => choice.selectedSize))], measurements: [], choices: plan.choices,
      } };
    }
    return plan;
  }
  async prepare(plan) {
    const { selectors } = this.config;
    await this.goto(`/preuser/events/${plan.eventId}`);
    if (!await this.isLoggedIn()) throw new BotError('login-required', '로그인이 필요합니다. npm run login으로 Orca 탭에서 로그인하세요.', true);
    const apply = await this.wait(locate, { selector: selectors.apply, require: 'visible' }, '신청 버튼이 보이지 않습니다.');
    if (apply.count !== 1) throw new BotError('source-changed', '신청 버튼을 하나로 특정하지 못했습니다.', true);
    if (!apply.enabled) throw new BotError('ineligible', '등급·모집 상태 등 신청 조건을 충족하지 않습니다.');
    await this.click({ selector: selectors.apply }, '신청 버튼');
    // 인증 리다이렉트나 마케팅 수신 동의 화면을 지나쳤다고 간주하지 않습니다.
    await this.wait(selector => document.querySelector(selector) || /login/.test(location.pathname), selectors.optionBox).catch(error => {
      if (error.code === 'dialog') throw error;
    });
    await this.assertPage();
    const boxes = await this.run(() => this.tab.evaluate(locate, { selector: selectors.optionBox, require: 'none' }));
    if (!boxes.count) throw new BotError('interaction-required', '옵션 화면이 열리지 않았습니다. 로그인·수신 동의·추가 인증을 Orca 탭에서 확인하세요.', true);
    for (let i = 0; i < plan.steps.length; i++) {
      const box = { selector: selectors.optionBox, nth: i };
      await this.wait(locate, { ...box, require: 'visible' }, '옵션 선택 칸이 보이지 않습니다.');
      await this.click(box, '옵션 선택 칸');
      const list = { selector: selectors.optionList, visibleOnly: true };
      const shown = await this.wait(locate, { ...list, require: 'visible' }, '옵션 목록이 열리지 않았습니다.');
      if (shown.count !== 1) throw new BotError('source-changed', '옵션 목록을 하나로 특정하지 못했습니다.', true);
      const rows = await this.run(() => this.tab.evaluate(locate, { ...list, child: 'li', texts: true, require: 'none' }));
      const indices = (rows.texts ?? []).flatMap((t, index) => normalize(t) === normalize(plan.steps[i]) ? [index] : []);
      if (indices.length !== 1) throw new BotError('option-changed', `옵션이 변경됐거나 유일하지 않습니다: ${plan.steps[i]}`);
      await this.click({ ...list, child: 'li', nth: indices[0] }, `옵션 ${plan.steps[i]}`);
      await this.wait(noVisible, selectors.optionList, '옵션 목록이 닫히지 않았습니다.');
    }
    const next = await this.wait(locate, { role: 'button', name: '선택 완료' }, '선택 완료 버튼이 보이지 않습니다.');
    if (next.count !== 1 || !next.enabled) throw new BotError('option-changed', '옵션 선택을 완료하지 못했습니다.');
    await this.click({ role: 'button', name: '선택 완료' }, '선택 완료 버튼');
    await this.wait(path => location.pathname === path, `/preuser/apply/${plan.eventId}`, '신청서 화면으로 이동하지 않았습니다.');
    await this.assertPage();
    const selected = await this.run(() => this.tab.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('PREUSER-EVENT-OPTION-DATA')); } catch { return null; }
    }));
    if (String(selected?.productUniqueId) !== plan.productUniqueId || String(selected?.productOptionNo) !== String(plan.optionNo)) {
      throw new BotError('option-changed', '선택한 상품·옵션이 계획과 일치하지 않아 중단합니다.', true);
    }
    await this.wait(locate, { role: 'button', name: '신청 완료', require: 'visible' }, '신청 완료 버튼이 보이지 않습니다.');
    if (await this.run(() => this.tab.evaluate(hasVisibleText, { text: '등록한 배송지가 없습니다.', exact: true }))) {
      throw new BotError('address-required', '무신사 기본 배송지를 등록해야 합니다.', true);
    }
    const missing = Object.keys(CONSENTS).filter(id => !this.config.acceptedConsentIds.includes(id));
    if (missing.length) throw new BotError('consent-required', `사이트의 약관을 확인한 후 acceptedConsentIds를 설정하세요: ${missing.join(', ')}`, true);
    // 새 필수 동의가 추가되면 자동 제출하지 않습니다.
    const ids = await this.run(() => this.tab.evaluate(checkboxIds));
    if (ids.length !== 5 || ids.some(id => id !== 'all' && !(id in CONSENTS))
      || Object.keys(CONSENTS).some(id => !ids.includes(id))) {
      throw new BotError('consent-changed', '사이트의 동의 항목이 변경되어 제출하지 않습니다.', true);
    }
    for (const id of Object.keys(CONSENTS)) {
      const checkbox = { selector: `[id="${id}"]` };
      const state = () => this.run(() => this.tab.evaluate(locate, checkbox));
      if (!(await state())?.checked) await this.checkConsent(id);
      if (!(await state())?.checked) throw new BotError('consent-changed', '동의 체크 상태를 확인하지 못했습니다.', true);
    }
    const submit = await this.run(() => this.tab.evaluate(locate, { role: 'button', name: '신청 완료' }));
    if (submit?.count !== 1 || !submit.enabled) throw new BotError('form-not-ready', '신청서의 필수 항목이 충족되지 않았습니다.');
  }
  /** 체크박스가 꾸며진 라벨에 가려져 있으면 연결된 라벨을 누릅니다. */
  async checkConsent(id) {
    try { await this.click({ selector: `[id="${id}"]` }, '동의 체크박스'); }
    catch (error) {
      if (!(error instanceof OrcaError) || error.code === 'dialog') throw error;
      await this.click({ selector: `label[for="${id}"]` }, '동의 항목');
    }
  }
  async submit(plan) {
    await this.assertPage();
    if (new URL(await this.run(() => this.tab.url())).pathname !== `/preuser/apply/${plan.eventId}`) throw new BotError('unexpected-page', '제출할 체험단 번호가 일치하지 않습니다.', true);
    await this.click({ role: 'button', name: '신청 완료' }, '신청 완료 버튼');
    await this.wait(hasVisibleText, { text: '신청이 완료되었습니다', exact: false }, '신청 완료 문구를 확인하지 못했습니다.');
    return { confirmedAt: new Date().toISOString() };
  }
}
