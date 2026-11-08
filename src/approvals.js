import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { normalize } from './filters.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function planProof(plan) {
  return hash({ productUniqueId: plan.productUniqueId, optionNo: plan.optionNo,
    steps: plan.steps });
}
export const choiceLabel = choice => choice.steps.map(step => normalize(step) === 'none' ? '기본 구성' : step).join(' / ');
export const buttonValue = (request, choice) => JSON.stringify({ requestId: request.id, revision: request.uiRevision, proof: planProof(choice) });
export const rejectValue = request => JSON.stringify({ requestId: request.id, revision: request.uiRevision, action: 'reject' });
export const REJECT_ACTION = 'musinsa_reject';
const fingerprint = (campaign, choices) => hash({ campaignId: campaign.id, choices });
export function validChoice(plan) {
  return /^\d+$/.test(plan?.productUniqueId ?? '') && Number.isSafeInteger(plan.optionNo) && plan.optionNo > 0
    && typeof plan.selectedSize === 'string' && plan.selectedSize.trim().length > 0
    && Array.isArray(plan.steps) && plan.steps.length > 0 && plan.steps.length < 8
    && plan.steps.every(x => typeof x === 'string' && x.trim() && x.length <= 300);
}
export function approvalChoices(plan) {
  return (plan.choices ?? plan.review?.choices ?? (plan.status === 'planned' ? [plan] : [])).filter(validChoice)
    .map((p, index) => ({ productUniqueId: p.productUniqueId, optionNo: p.optionNo, selectedSize: p.selectedSize,
      choiceKey: p.choiceKey ?? `옵션${index + 1}`,
      productName: p.productName, steps: p.steps, ...(p.selectionKind ? { selectionKind: p.selectionKind } : {}) }));
}

const combinationText = text => normalize(text).replace(/\s*[/*×,]\s*/g, ' ').replace(/\s+/g, ' ').trim();
function matchingChoices(choices, text) {
  const number = /^(?:옵션\s*|#)?(\d+)$/.exec(text);
  if (number) {
    const numbered = choices.filter(choice => normalize(choice.choiceKey) === `옵션${Number(number[1])}`);
    if (numbered.length) return numbered;
  }
  return choices.filter(choice => normalize(choice.selectedSize) === text
    || combinationText(choice.steps.join(' / ')) === combinationText(text)
    || combinationText(choice.steps.filter(step => step !== choice.productName).join(' / ')) === combinationText(text));
}

function approve(request, choice, userId, now) {
  request.selectedChoice = choice; request.status = 'approved'; request.approvedAt = now; request.approvedBy = userId;
  return { request, approved: true, text: `${choiceLabel(choice)} 신청 접수. 결과를 이 스레드로 알려드립니다.` };
}
function reject(request, userId, now) {
  request.status = 'rejected'; request.rejectedAt = now; request.rejectedBy = userId;
  return { request, rejected: true, text: '거절했습니다. 이 체험단은 신청하지 않고 다시 알리지 않습니다.' };
}

async function atomicWrite(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

export class ApprovalStore {
  constructor(directory, { now = Date.now } = {}) {
    this.directory = join(directory, 'slack-approvals'); this.now = now;
  }
  path(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('올바르지 않은 승인 요청 번호입니다.');
    return join(this.directory, `${id}.json`);
  }
  async list() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const paths = (await readdir(this.directory)).filter(x => /^[0-9a-f-]{36}\.json$/.test(x));
    return await Promise.all(paths.map(async name => {
      const request = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (request.version !== 1 || !request.id || !Array.isArray(request.choices)
        || typeof request.status !== 'string' || !Number.isFinite(request.expiresAt)) throw new Error('슬랙 승인 기록 형식을 확인하세요.');
      return request;
    }));
  }
  async mutate(id, transform) {
    const path = this.path(id), lockPath = `${path}.lock`;
    let lock;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (e) { if (e.code !== 'EEXIST') throw e; await delay(25); }
    }
    if (!lock) throw new Error('승인 요청을 다른 작업이 처리 중입니다.');
    try {
      const request = JSON.parse(await readFile(path, 'utf8'));
      const result = await transform(request);
      if (result?.save !== false) await atomicWrite(path, request);
      return result;
    } finally { await lock.close(); await unlink(lockPath); }
  }
  async ensure(campaign, plan, binding) {
    const choices = approvalChoices(plan);
    const proof = fingerprint(campaign, choices, plan.review?.measurements ?? []);
    // 거절한 공고는 승인 요청 만료 후에도 다시 알리지 않습니다.
    const matching = (await this.list()).filter(r => r.campaign.id === campaign.id && this.matchesBinding(r, binding)
      && (r.status === 'rejected' || (r.fingerprint === proof
        && (r.expiresAt > this.now() || ['processing', 'submitted', 'uncertain'].includes(r.status))
        && !['stale', 'expired', 'excluded'].includes(r.status)))).sort((a, b) => b.createdAt - a.createdAt);
    if (matching.length) return { request: matching[0], created: false };
    const createdAt = this.now();
    const deadline = Date.parse(`${campaign.endDate ?? ''}T23:59:59+09:00`);
    const expiresAt = Number.isFinite(deadline) ? deadline : createdAt + 24 * 60 * 60 * 1000;
    const request = { version: 1, id: randomUUID(), fingerprint: proof, campaign: {
      id: campaign.id, title: campaign.title, url: campaign.url, endDate: campaign.endDate, category: plan.category ?? campaign.category,
    }, choices, selectedChoice: null, replyMode: 'option-submit', uiRevision: randomUUID(),
    reason: plan.reason ?? '', measurements: plan.review?.measurements ?? [],
    ...(plan.selectionKind ? { selectionKind: plan.selectionKind } : {}), binding,
    createdAt, expiresAt, status: 'posting', processedEvents: [] };
    await atomicWrite(this.path(request.id), request);
    return { request, created: true };
  }
  matchesBinding(request, binding) {
    return ['teamId', 'channelId', 'userId'].every(k => request.binding[k] === binding[k]);
  }
  /** 기존 24시간 만료 알림도 모집 중이면 원래 메시지에서 계속 승인할 수 있게 합니다. */
  async keepPendingUntilDeadline(binding) {
    for (const request of await this.list()) {
      if (!['pending', 'expired'].includes(request.status) || !this.matchesBinding(request, binding)) continue;
      const deadline = Date.parse(`${request.campaign.endDate ?? ''}T23:59:59+09:00`);
      if (!Number.isFinite(deadline) || deadline <= this.now() || deadline <= request.expiresAt) continue;
      await this.mutate(request.id, r => {
        if (!['pending', 'expired'].includes(r.status) || !this.matchesBinding(r, binding)) return { save: false };
        r.expiresAt = deadline; r.status = 'pending';
        return { request: r };
      });
    }
  }
  async posted(id, channel, ts) {
    return this.mutate(id, r => {
      if (r.status !== 'posting' || channel !== r.binding.channelId || !/^\d+\.\d+$/.test(ts)) throw new Error('슬랙 승인 메시지를 확인하지 못했습니다.');
      r.threadTs = ts; r.status = 'pending';
      if (r.replyMode === 'option-submit') r.replyModeSinceTs = ts;
      return { request: r };
    });
  }
  async refresh(id, campaign, plan, binding, { sinceTs = '9999999999.999999', revision = randomUUID() } = {}) {
    return this.mutate(id, r => {
      if (!['pending', 'approved'].includes(r.status) || !this.matchesBinding(r, binding)) return { save: false };
      const choices = approvalChoices(plan), measurements = plan.review?.measurements ?? [];
      const selected = r.status === 'approved' && r.selectedChoice
        ? choices.find(choice => planProof(choice) === planProof(r.selectedChoice)) : null;
      r.choices = choices; r.selectedChoice = selected ?? null;
      r.status = selected ? 'approved' : 'pending';
      if (!selected) { delete r.approvedAt; delete r.approvedBy; }
      r.fingerprint = fingerprint(campaign, choices, measurements);
      r.campaign = { id: campaign.id, title: campaign.title, url: campaign.url, endDate: campaign.endDate, category: plan.category ?? campaign.category };
      r.measurements = measurements; r.reason = plan.reason ?? '';
      r.replyMode = 'option-submit'; r.replyModeSinceTs = sinceTs; r.uiRevision = revision;
      r.selectionKind = plan.selectionKind;
      return { request: r };
    });
  }
  async approvedFor(campaignId, binding) {
    return (await this.list()).filter(r => r.campaign.id === campaignId && this.matchesBinding(r, binding)
      && r.status === 'approved' && r.expiresAt > this.now()).sort((a, b) => b.approvedAt - a.approvedAt)[0] ?? null;
  }
  async reply({ eventId, teamId, message }, binding) {
    if (!eventId || message?.type !== 'message' || message.subtype || message.bot_id || message.edited
      || message.user !== binding.userId || message.channel !== binding.channelId || teamId !== binding.teamId
      || !/^\d+\.\d+$/.test(message.thread_ts ?? '') || !/^\d+\.\d+$/.test(message.ts ?? '')
      || typeof message.text !== 'string' || message.text.length > 100) return { ignored: true };
    const request = (await this.list()).find(r => r.threadTs === message.thread_ts && this.matchesBinding(r, binding));
    if (!request) return { ignored: true };
    return this.mutate(request.id, r => {
      const key = `${message.user}:${message.ts}`;
      if (r.processedEvents.includes(eventId) || r.processedEvents.includes(key)) return { ignored: true, save: false };
      if (!['pending', 'approved'].includes(r.status)) return { ignored: true, save: false };
      r.processedEvents = [...r.processedEvents, eventId, key].slice(-200);
      if (r.expiresAt <= this.now()) {
        r.status = 'expired'; return { request: r, text: '승인 요청이 만료되었습니다. 새 알림에서 확인해 주세요.' };
      }
      // 이미 승인한 요청은 중복·추가 답장으로 옵션을 바꾸지 않습니다.
      if (r.status === 'approved') return { request: r, text: '이미 승인된 요청입니다. 같은 신청을 다시 실행하지 않습니다.' };
      const text = normalize(message.text);
      if (['거절', '취소', '건너뛰기'].includes(text)) return reject(r, message.user, this.now());
      let explicitApproval = text === '승인', size = null;
      const generic = r.selectionKind === 'option' || r.choices.some(choice => choice.selectionKind === 'option');
      const example = r.choices[0]?.choiceKey ?? '옵션1';
      const approval = /^승인\s+(.+)$/.exec(text) ?? /^(.+?)\s*으로\s*신청$/.exec(text);
      if (approval) { explicitApproval = true; size = approval[1]; }
      else if (text !== '승인') size = text;
      const direct = r.replyMode === 'option-submit';
      // 옛 알림에서 사이즈만 골랐던 댓글을 새 방식의 신청 지시로 재해석하지 않습니다.
      if (direct && !explicitApproval && Number(message.ts) < Number(r.replyModeSinceTs ?? r.threadTs)) {
        return { ignored: true, save: false };
      }
      if (size) {
        const choices = direct ? matchingChoices(r.choices, size) : r.choices.filter(c => normalize(c.selectedSize) === normalize(size));
        if (choices.length !== 1) return { request: r, text: direct
          ? `색상·사이즈 조합 버튼을 누르거나 옵션 번호로 답장해 주세요. 예: ${example}`
          : `선택 가능한 ${generic ? '옵션' : '사이즈'}: ${r.choices.map(c => c.selectedSize).join(', ') || '확인 가능한 옵션 없음'}. 예: ${example}` };
        r.selectedChoice = choices[0];
      }
      if (!r.selectedChoice && explicitApproval && r.choices.length === 1) r.selectedChoice = r.choices[0];
      if (!r.selectedChoice) return { request: r, text: `원하는 조합 버튼을 누르거나 옵션 번호로 답장해 주세요. 예: ${example}` };
      if (!direct && !explicitApproval) return { request: r, text: `${r.selectedChoice.selectedSize} 선택 완료. 신청하려면 이 스레드에 ‘승인’이라고 답장하세요.` };
      return approve(r, r.selectedChoice, message.user, this.now());
    });
  }
  async selectAction(body, action, binding) {
    if (body?.type !== 'block_actions' || action?.type !== 'button'
      || body.user?.id !== binding.userId || body.team?.id !== binding.teamId || body.channel?.id !== binding.channelId
      || !/^\d+\.\d+$/.test(action.action_ts ?? '') || typeof action.value !== 'string' || action.value.length > 512) return { ignored: true };
    let value;
    try { value = JSON.parse(action.value); } catch { return { ignored: true }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ignored: true };
    const rejecting = action.action_id === REJECT_ACTION;
    if (!/^[0-9a-f-]{36}$/.test(value.requestId ?? '') || !/^[0-9a-f-]{36}$/.test(value.revision ?? '')
      || (rejecting ? value.action !== 'reject' : !/^[0-9a-f]{64}$/.test(value.proof ?? ''))) return { ignored: true };
    const threadTs = body.message?.thread_ts ?? body.message?.ts ?? body.container?.message_ts;
    const request = (await this.list()).find(r => r.id === value.requestId && r.threadTs === threadTs
      && this.matchesBinding(r, binding));
    if (!request) return { ignored: true };
    return this.mutate(request.id, r => {
      if (r.status !== 'pending' || r.uiRevision !== value.revision || r.expiresAt <= this.now()) return { ignored: true, save: false };
      if (rejecting) {
        const key = `button:${body.user.id}:${action.action_ts}`;
        if (r.processedEvents.includes(key)) return { ignored: true, save: false };
        r.processedEvents = [...r.processedEvents, key].slice(-200);
        return reject(r, body.user.id, this.now());
      }
      const index = r.choices.findIndex(choice => planProof(choice) === value.proof);
      if (index < 0 || action.action_id !== `musinsa_choose_${index + 1}`) return { ignored: true, save: false };
      const key = `button:${body.user.id}:${action.action_ts}`;
      if (r.processedEvents.includes(key)) return { ignored: true, save: false };
      r.processedEvents = [...r.processedEvents, key].slice(-200);
      return approve(r, r.choices[index], body.user.id, this.now());
    });
  }
  async claim(id, plan) {
    return this.mutate(id, r => {
      if (r.status !== 'approved' || r.expiresAt <= this.now() || !validChoice(plan)
        || planProof(r.selectedChoice) !== planProof(plan)) throw new Error('승인 상태 또는 옵션이 변경되어 신청하지 않습니다.');
      r.status = 'processing'; r.processingAt = this.now(); return { request: r };
    });
  }
  async finish(id, status) {
    return this.mutate(id, r => {
      if (r.status !== 'processing') throw new Error('처리 중인 승인 요청이 아닙니다.');
      if (!['submitted', 'uncertain'].includes(status)) throw new Error('올바르지 않은 처리 결과입니다.');
      r.status = status; r.finishedAt = this.now(); return { request: r };
    });
  }
  async mark(id, status) {
    return this.mutate(id, r => { r.status = status; return { request: r }; });
  }
}
