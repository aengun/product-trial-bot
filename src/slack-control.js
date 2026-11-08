import bolt from '@slack/bolt';
import { setTimeout as delay } from 'node:timers/promises';
import { ApprovalStore, planProof, validChoice, buttonValue, choiceLabel } from './approvals.js';
import { campaignLink } from './slack.js';
import { CATEGORY_NAMES } from './filters.js';

export function slackControlSettings(env = process.env) {
  if (!/^xoxb-[A-Za-z0-9-]+$/.test(env.SLACK_BOT_TOKEN ?? '')) throw new Error('.env의 SLACK_BOT_TOKEN(xoxb-) 설정이 필요합니다.');
  if (!/^xapp-[A-Za-z0-9-]+$/.test(env.SLACK_APP_TOKEN ?? '')) throw new Error('.env의 SLACK_APP_TOKEN(xapp-, connections:write) 설정이 필요합니다.');
  if (!/^[UW][A-Z0-9]+$/.test(env.SLACK_APPROVER_USER_ID ?? '')) throw new Error('.env의 SLACK_APPROVER_USER_ID에 본인 멤버 ID를 설정하세요.');
  if (!/^[CG][A-Z0-9]+$/.test(env.SLACK_CHANNEL_ID ?? '')) throw new Error('.env의 SLACK_CHANNEL_ID에 알림 채널 ID를 설정하세요.');
  return { botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN,
    userId: env.SLACK_APPROVER_USER_ID, channelId: env.SLACK_CHANNEL_ID };
}

export function approvalPayload(request) {
  const title = request.campaign.title.replace(/\s*체험단\s*\d+명\s*모집\s*$/, '').trim();
  const active = ['posting', 'pending'].includes(request.status);
  const statusText = { submitted: '신청 완료', uncertain: '신청 결과 확인 필요', approved: '선택 접수',
    processing: '신청 중', expired: '모집 마감', stale: '옵션 갱신 필요', rejected: '건너뛴 공고',
    excluded: `제외 · ${request.excludedReason ?? '필터 설정'}` }[request.status] ?? '확인 필요';
  const categoryName = CATEGORY_NAMES[request.campaign.category] ?? request.campaign.category;
  const category = categoryName !== '전체' && Object.values(CATEGORY_NAMES).includes(categoryName) ? ` · ${categoryName}` : '';
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `━━ 체험단 #${request.campaign.id}${category} ━━`.slice(0, 150) } },
    { type: 'section', text: { type: 'plain_text', text: active
      ? `${title}\n옵션 ${request.choices.length}개 · 누르면 신청`
      : `${title}\n${statusText}${request.selectedChoice && request.status !== 'excluded' ? `: ${choiceLabel(request.selectedChoice)}` : ''}` } },
  ];
  const groups = new Map();
  request.choices.forEach((choice, index) => {
    if (!groups.has(choice.productUniqueId)) groups.set(choice.productUniqueId, []);
    groups.get(choice.productUniqueId).push({ choice, index });
  });
  const rowSize = Math.max(4, Math.ceil(request.choices.length / 40));
  if (rowSize > 25) throw new Error('한 알림에 표시할 수 있는 조합 수를 초과했습니다.');
  if (active) for (const group of groups.values()) {
    if (groups.size > 1) blocks.push({ type: 'section', text: { type: 'plain_text', text: group[0].choice.productName.slice(0, 2900) } });
    for (let offset = 0; offset < group.length; offset += rowSize) {
      blocks.push({ type: 'actions', block_id: `${request.id}:${request.uiRevision}:${group[0].index}:${offset}`,
        elements: group.slice(offset, offset + rowSize).map(({ choice, index }) => {
          const steps = groups.size > 1 && choice.steps[0] === choice.productName ? choice.steps.slice(1) : choice.steps;
          const label = choiceLabel({ steps });
          return { type: 'button', action_id: `musinsa_choose_${index + 1}`,
            text: { type: 'plain_text', text: `${index + 1}. ${label}`.slice(0, 75) },
            accessibility_label: `${choice.choiceKey ?? `옵션${index + 1}`} ${label}`.slice(0, 75), value: buttonValue(request, choice) };
        }) });
    }
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${campaignLink(request.campaign.url)}|공고 보기>`, verbatim: true } },
    { type: 'divider' });
  if (blocks.length > 50) throw new Error('조합 버튼이 Slack 메시지의 블록 수 한도를 초과했습니다.');
  return {
    channel: request.binding.channelId,
    text: `체험단 #${request.campaign.id} · ${title}`.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
    blocks,
  };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel() { return 'error'; }, setName() {} };

export class SlackApprovalController {
  constructor(directory, { env = process.env, now = Date.now, wait = delay, appFactory = options => new bolt.App(options),
    log = message => console.log(message) } = {}) {
    this.settings = slackControlSettings(env); this.now = now; this.log = log;
    this.waitInterval = wait; this.messageQueue = Promise.resolve();
    this.requests = new ApprovalStore(directory, { now });
    this.app = appFactory({ token: this.settings.botToken, appToken: this.settings.appToken, socketMode: true,
      ignoreSelf: true, logger: silentLogger, clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10000 } });
    this.dirty = false; this.waiters = new Set(); this.postedThisCycle = 0; this.postLimit = 5; this.nextPostAt = 0;
    this.app.event('message', async ({ event, body }) => {
      try {
        await this.handleReply(event, body.event_id, body.team_id);
      } catch { this.log('슬랙 답장을 처리하지 못했습니다. 승인 기록을 확인하세요.'); }
    });
    this.app.action(/^musinsa_choose_\d+$/, async ({ ack, body, action }) => {
      await ack();
      try { await this.acceptResult(await this.requests.selectAction(body, action, this.binding)); }
      catch { this.log('슬랙 옵션 버튼을 처리하지 못했습니다. 선택 기록을 확인하세요.'); }
    });
    this.app.error(async () => this.log('슬랙 연결에서 오류가 발생했습니다. 토큰과 앱 설정을 확인하세요.'));
  }
  async start() {
    try {
      const auth = await this.app.client.auth.test();
      if (!auth.ok || !/^T[A-Z0-9]+$/.test(auth.team_id ?? '')) throw new Error();
      this.binding = { teamId: auth.team_id, channelId: this.settings.channelId, userId: this.settings.userId };
      await this.app.start();
    } catch { throw new Error('슬랙 답장 연결을 시작하지 못했습니다. 토큰, Socket Mode, 이벤트 권한을 확인하세요.'); }
    try {
      const recovered = await this.recoverReplies();
      if (recovered) this.log(`봇이 꺼져 있던 동안의 슬랙 승인 ${recovered}건을 복구했습니다.`);
    } catch { this.log('이전 슬랙 답장을 복구하지 못했습니다. 새 답장은 계속 수신합니다.'); }
  }
  async handleReply(message, eventId, teamId) {
    const result = await this.requests.reply({ message, eventId, teamId }, this.binding);
    return this.acceptResult(result);
  }
  async acceptResult(result) {
    if (result.approved) this.wake();
    if (result.text) await this.postThread(result.request, result.text);
    if (result.approved) await this.updateRequestMessage(result.request.id).catch(() => this.log('선택 접수는 저장했지만 버튼 표시를 갱신하지 못했습니다.'));
    return result;
  }
  /** Socket Mode가 꺼져 있을 때 놓친 답장을 실제 채널 기록에서 복구합니다. */
  async recoverReplies() {
    const pending = (await this.requests.list()).filter(r => r.status === 'pending' && r.expiresAt > this.now()
      && r.threadTs && this.requests.matchesBinding(r, this.binding));
    if (!pending.length) return 0;
    const byThread = new Map(pending.map(r => [r.threadTs, r]));
    const oldest = pending.map(r => r.threadTs).sort()[0];
    const parents = [];
    let cursor;
    do {
      const page = await this.app.client.conversations.history({ channel: this.binding.channelId,
        oldest, inclusive: true, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!page.ok || !Array.isArray(page.messages)) throw new Error('슬랙 채널 기록 읽기 실패');
      parents.push(...page.messages.filter(m => byThread.has(m.ts) && m.reply_count > 0));
      cursor = page.response_metadata?.next_cursor;
      if (cursor) await this.waitInterval(1250);
    } while (cursor);
    let recovered = 0;
    for (const parent of parents) {
      const messages = [];
      cursor = undefined;
      do {
        await this.waitInterval(1250);
        const page = await this.app.client.conversations.replies({ channel: this.binding.channelId,
          ts: parent.ts, limit: 100, ...(cursor ? { cursor } : {}) });
        if (!page.ok || !Array.isArray(page.messages)) throw new Error('슬랙 스레드 읽기 실패');
        messages.push(...page.messages);
        cursor = page.response_metadata?.next_cursor;
      } while (cursor);
      for (const message of messages.sort((a, b) => Number(a.ts) - Number(b.ts))) {
        if (message.ts === parent.ts) continue;
        const result = await this.handleReply({ ...message, channel: this.binding.channelId },
          `history:${this.binding.channelId}:${message.ts}`, this.binding.teamId);
        if (result.approved) recovered++;
      }
    }
    return recovered;
  }
  async stop() { await this.app.stop(); }
  beginCycle(limit) { this.postedThisCycle = 0; this.postLimit = limit; }
  budgetReached() { return this.postedThisCycle >= this.postLimit; }
  wake() { this.dirty = true; for (const wake of this.waiters) wake(); }
  async wait(timeoutMs, signal) {
    if (this.dirty) { this.dirty = false; return; }
    await new Promise((resolve, reject) => {
      let timer;
      const clean = () => { clearTimeout(timer); this.waiters.delete(wake); signal?.removeEventListener('abort', abort); };
      const wake = () => { clean(); this.dirty = false; resolve(); };
      const abort = () => { clean(); reject(signal.reason ?? new Error('종료 요청')); };
      if (signal?.aborted) return abort();
      this.waiters.add(wake); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(wake, timeoutMs);
    });
  }
  async decision(campaignId) {
    const request = await this.requests.approvedFor(campaignId, this.binding);
    return request ? { campaignId, productUniqueId: request.selectedChoice.productUniqueId,
      optionNo: request.selectedChoice.optionNo, size: request.selectedChoice.selectedSize } : null;
  }
  async approvedCampaignIds() {
    return [...new Set((await this.requests.list()).filter(r => r.status === 'approved'
      && r.expiresAt > this.now() && this.requests.matchesBinding(r, this.binding)).map(r => r.campaign.id))];
  }
  async prioritize(campaigns, { approvedOnly = false } = {}) {
    const approved = new Set(await this.approvedCampaignIds());
    return campaigns.filter(campaign => !approvedOnly || approved.has(campaign.id))
      .sort((a, b) => Number(approved.has(b.id)) - Number(approved.has(a.id)));
  }
  async check(campaign, plan, { allowNewRequests = true } = {}) {
    const approved = await this.requests.approvedFor(campaign.id, this.binding);
    if (approved) {
      if (plan.status === 'planned' && validChoice(plan) && planProof(approved.selectedChoice) === planProof(plan)) {
        return { approved: true, requestId: approved.id };
      }
      await this.requests.mark(approved.id, 'stale');
      await this.postThread(approved, '승인 이후 상품·사이즈·재고 옵션이 변경되어 신청을 보류했습니다. 새 승인 요청을 확인해 주세요.').catch(() => {});
    }
    if (!allowNewRequests) return { approved: false, status: 'approval-pending', reason: '다음 정기 알림 시각에 새 옵션을 안내합니다.' };
    const { request, created } = await this.requests.ensure(campaign, plan, this.binding);
    if (request.status === 'posting' && !created) {
      return { approved: false, status: 'approval-delivery-uncertain', reason: '이전 승인 알림의 전송 결과를 확인할 수 없어 자동 재전송하지 않습니다.' };
    }
    if (created) {
      if (this.budgetReached()) {
        await this.requests.mark(request.id, 'stale');
        return { approved: false, status: 'approval-pending', reason: '다음 회차에 슬랙 승인 요청을 보냅니다.' };
      }
      this.postedThisCycle++;
      try {
        const result = await this.postMessage(approvalPayload(request));
        if (!result.ok) throw Object.assign(new Error(), { definiteFailure: true });
        if (result.channel !== this.binding.channelId || !/^\d+\.\d+$/.test(result.ts ?? '')) throw new Error();
        await this.requests.posted(request.id, result.channel, result.ts);
      } catch (error) {
        const definite = error.definiteFailure || ['not_in_channel', 'channel_not_found', 'missing_scope', 'invalid_auth',
          'account_inactive', 'token_revoked', 'is_archived', 'no_permission'].includes(error.data?.error);
        await this.requests.mark(request.id, definite ? 'stale' : 'delivery-uncertain');
        throw new Error('슬랙 승인 알림 전송을 확인하지 못했습니다. 채널에 봇을 초대하고 chat:write 권한을 확인하세요.');
      }
    }
    if (['processing', 'submitted', 'uncertain'].includes(request.status)) return { approved: false, status: 'approval-locked', reason: '이미 처리 중이거나 결과가 기록된 승인 요청입니다.' };
    if (request.status === 'rejected') return { approved: false, status: 'approval-rejected', reason: '슬랙에서 이 신청을 거절했습니다.' };
    if (request.status === 'delivery-uncertain') return { approved: false, status: 'approval-delivery-uncertain', reason: '승인 요청의 전송 결과가 불확실합니다.' };
    return { approved: false, status: 'approval-pending', reason: '슬랙 알림에서 옵션 선택을 기다립니다.', requestId: request.id };
  }
  async claim(id, plan) { await this.requests.claim(id, plan); }
  async problem(id, reason) {
    const result = await this.requests.mutate(id, r => {
      if (r.lastIssue === reason) return { save: false };
      r.lastIssue = reason; return { request: r };
    });
    if (result.request) await this.postThread(result.request, `신청을 진행하지 못했습니다. ${reason}`);
  }
  async complete(id, status) {
    const { request } = await this.requests.finish(id, status);
    try {
      await this.postThread(request, status === 'submitted'
        ? `${choiceLabel(request.selectedChoice)} 신청 완료를 확인했습니다.`
        : '제출 결과를 확인하지 못했습니다. 중복 신청을 막기 위해 재시도하지 않습니다. 무신사 신청 내역을 확인해 주세요.');
    } catch { return false; }
    await this.updateRequestMessage(id).catch(() => {});
    return true;
  }
  async updateRequestMessage(id) {
    const work = this.messageQueue.then(async () => {
      const request = (await this.requests.list()).find(request => request.id === id);
      if (!request?.threadTs || !this.requests.matchesBinding(request, this.binding)) return;
      const payload = approvalPayload(request);
      if (this.nextPostAt > this.now()) await this.waitInterval(this.nextPostAt - this.now());
      this.nextPostAt = this.now() + 1250;
      const result = await this.app.client.chat.update({ channel: payload.channel, ts: request.threadTs,
        text: payload.text, blocks: payload.blocks, parse: 'none', link_names: false });
      if (!result.ok) throw new Error('슬랙 선택 표시 갱신 실패');
      return result;
    });
    this.messageQueue = work.catch(() => {});
    return work;
  }
  async postThread(request, text) {
    if (!request.threadTs || !this.requests.matchesBinding(request, this.binding)) return;
    const result = await this.postMessage({ channel: this.binding.channelId, thread_ts: request.threadTs,
      text, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false });
    if (!result.ok) throw new Error('슬랙 결과 알림 실패');
  }
  async postMessage(payload) {
    const work = this.messageQueue.then(async () => {
      if (this.nextPostAt > this.now()) await this.waitInterval(this.nextPostAt - this.now());
      this.nextPostAt = this.now() + 1100;
      return this.app.client.chat.postMessage(payload);
    });
    this.messageQueue = work.catch(() => {});
    return work;
  }
}
