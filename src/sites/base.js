import { BotError } from '../browser.js';
import { OrcaError } from '../orca.js';
import { CONSENTS } from '../config.js';

// 아래 함수는 Orca 탭 안에서 실행됩니다. 바깥 변수를 참조하지 않습니다.
function pageState() {
  const blocked = !!document.querySelector('iframe[src*="captcha"], iframe[title*="CAPTCHA"], #captcha')
    || /자동입력 방지|로봇이 아닙니다|접근이 제한되었습니다|Access Denied/.test(document.body?.innerText ?? '');
  return { href: location.href, blocked };
}

/**
 * 사이트 API로 공고를 읽고 신청하는 클라이언트의 공통 부분입니다. 요청은 로그인한 Orca 탭 안에서
 * 사이트와 같은 방식으로 보내고, 토큰·배송지 같은 값은 탭 밖으로 꺼내지 않습니다.
 */
export class SiteClient {
  constructor(tab, config, { origin, startPath, siteName }) {
    this.tab = tab; this.config = config; this.origin = origin; this.startPath = startPath; this.siteName = siteName;
  }
  async run(action) {
    try { return await action(); }
    catch (error) {
      if (error instanceof OrcaError && error.code === 'dialog') throw new BotError('dialog', error.message);
      throw error;
    }
  }
  async start() { await this.goto(this.startPath); }
  async goto(path) {
    const status = await this.run(() => this.tab.goto(`${this.origin}${path}`, { timeoutMs: this.config.timeoutMs }));
    if ([401, 403, 429].includes(status)) throw new BotError('access-blocked', `페이지 접근이 제한됐습니다 (HTTP ${status}).`, true);
    if (status >= 400) throw new BotError('page-error', `페이지 요청 실패 (HTTP ${status}).`);
    await this.assertPage();
  }
  async assertPage() {
    const state = await this.run(() => this.tab.evaluate(pageState));
    if (new URL(state.href).origin !== this.origin) throw new BotError('unexpected-page', `${this.siteName} 밖의 페이지로 이동해 중단합니다.`, true);
    if (state.blocked) throw new BotError('access-blocked', '접근 제한 또는 추가 인증 화면입니다. Orca 탭에서 확인하세요.', true);
  }
  /** 사이트 탭 안에서 pageFunction(arg)를 실행합니다. 결과에는 응답 상태와 필요한 값만 담습니다. */
  async inPage(pageFunction, arg) {
    await this.assertPage();
    return await this.run(() => this.tab.evaluate(pageFunction, { ...arg, timeout: this.config.timeoutMs }));
  }
  checkBlocked(response, what) {
    if ([403, 429].includes(response?.status)) throw new BotError('access-blocked', `${what} 접근이 제한됐습니다 (HTTP ${response.status}).`, true);
  }
  /** 무신사 통합 회원 사이트는 같은 필수 동의 4가지를 신청서에서 요구합니다. */
  requireConsents() {
    const missing = Object.keys(CONSENTS).filter(id => !this.config.acceptedConsentIds.includes(id));
    if (missing.length) throw new BotError('consent-required', `사이트의 약관을 확인한 후 acceptedConsentIds를 설정하세요: ${missing.join(', ')}`, true);
  }
}

/** 서버가 신청을 받지 않았다고 확인된 오류입니다. 제출 결과 불확실(uncertain)로 처리하지 않습니다. */
export function notSubmitted(code, message, fatal = false) {
  return Object.assign(new BotError(code, message, fatal), { notSubmitted: true });
}

export const clipMessage = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
