import { setTimeout as delay } from 'node:timers/promises';
import { BotError } from './browser.js';
import { reviewFingerprint } from './notifications.js';

export async function runCycle({ client, store, config, submit = false, signal, log = () => {}, notify, approvalGate, approvedOnly = false }) {
  if (approvalGate && !submit) throw new Error('슬랙 승인 모드는 실제 신청 모드에서 사용하세요.');
  if (approvedOnly && !approvalGate) throw new Error('승인 건 처리는 슬랙 승인 모드에서만 사용할 수 있습니다.');
  const report = { startedAt: new Date().toISOString(), mode: submit ? 'submit' : 'preview', complete: false, results: [] };
  const slackCooldowns = {};
  for (const entry of Object.values(store.data.campaigns)) {
    const retry = entry.notice?.slackRetry;
    if (retry?.target && Number.isFinite(retry.at)) slackCooldowns[retry.target] = Math.max(slackCooldowns[retry.target] ?? 0, retry.at);
  }
  try {
    const scan = await client.scan(signal);
    report.scanned = scan.campaigns.length;
    report.complete = scan.complete;
    const campaigns = approvalGate?.prioritize ? await approvalGate.prioritize(scan.campaigns, { approvedOnly }) : scan.campaigns;
    let planned = 0;
    for (const campaign of campaigns) {
      signal?.throwIfAborted();
      if (store.blocks(campaign.id)) {
        const result = { ...campaign, status: 'history-skipped', previousStatus: store.get(campaign.id).status, reason: '신청 기록으로 재실행 방지' };
        report.results.push(result); log(result); continue;
      }
      let attempted = false;
      let plan;
      let approval;
      try {
        const previous = store.get(campaign.id);
        const decision = approvalGate ? await approvalGate.decision(campaign.id) : await store.getSizeDecision(campaign.id);
        plan = await client.plan(campaign, decision, { allOptions: Boolean(approvalGate) });
        if (approvalGate && ['planned', 'needs-size-review'].includes(plan.status)) {
          approval = await approvalGate.check(campaign, plan, { allowNewRequests: !approvedOnly });
          if (!approval.approved) {
            const result = { ...campaign, ...plan, status: approval.status, reason: approval.reason, approvalRequestId: approval.requestId };
            await store.set(campaign.id, result); report.results.push(result); log(result);
            await delay(config.actionDelayMs, undefined, { signal });
            continue;
          }
        }
        if (plan.status !== 'planned') {
          const result = { ...campaign, ...plan };
          if (result.status === 'needs-size-review') {
            const fingerprint = reviewFingerprint(result);
            result.notice = previous?.notice?.fingerprint === fingerprint
              ? { ...previous.notice, fingerprint } : { fingerprint, channels: [] };
          }
          await store.set(campaign.id, result);
          if (result.status === 'needs-size-review' && notify) {
            try {
              const delivery = await notify(result, result.notice.channels, { slackCooldowns });
              if (delivery.slackRetry?.target && Number.isFinite(delivery.slackRetry.at)) {
                slackCooldowns[delivery.slackRetry.target] = Math.max(slackCooldowns[delivery.slackRetry.target] ?? 0, delivery.slackRetry.at);
              }
              result.notice = { ...result.notice, ...delivery, attemptedAt: new Date().toISOString() };
            } catch {
              result.notice.errors = ['알림 전송에 실패했습니다. 다음 주기에 다시 시도합니다.'];
            }
            await store.set(campaign.id, result);
          }
          report.results.push(result); log(result);
          await delay(config.actionDelayMs, undefined, { signal });
          continue;
        }
        // 정기 확인에서는 신청 상한에 도달해도 남은 공고의 승인 알림을 계속 보냅니다.
        if (approvalGate && planned >= config.maxApplicationsPerRun) {
          const result = { ...campaign, ...plan, status: 'approval-queued',
            reason: '승인된 신청은 다음 처리 묶음에서 이어서 진행합니다.', approvalRequestId: approval.requestId };
          await store.set(campaign.id, result); report.results.push(result); log(result);
          continue;
        }
        planned++;
        if (!submit) {
          const result = { ...campaign, ...plan };
          await store.set(campaign.id, result);
          report.results.push(result); log(result);
        } else {
          await client.prepare(plan);
          signal?.throwIfAborted();
          if (approvalGate) await approvalGate.claim(approval.requestId, plan);
          await store.set(campaign.id, { ...campaign, ...plan, status: 'submitting' });
          attempted = true;
          const receipt = await client.submit(plan);
          const { note, ...saved } = receipt ?? {};
          const result = { ...campaign, ...plan, ...saved, status: 'submitted' };
          await store.set(campaign.id, result);
          if (approvalGate) {
            try { result.slackOutcomeSent = await approvalGate.complete(approval.requestId, 'submitted', note); }
            catch { result.slackOutcomeSent = false; }
          }
          report.results.push(result); log(result);
        }
      } catch (error) {
        if (signal?.aborted && !attempted) throw error;
        // 사이트가 신청을 받지 않았다고 확인된 경우(notSubmitted)는 결과 불확실로 막지 않습니다.
        const notSent = attempted && error instanceof BotError && error.notSubmitted === true;
        const uncertain = attempted && !notSent;
        const site = client.siteName ?? '무신사';
        const result = { ...campaign, ...(plan ?? {}), status: uncertain ? 'uncertain' : (error.code ?? 'error'),
          reason: uncertain ? `제출 결과를 확인하지 못했습니다. ${site} 신청 내역을 확인한 후 resolve 명령을 사용하세요.`
            : error instanceof BotError ? error.message : '브라우저 작업을 완료하지 못했습니다.' };
        await store.set(campaign.id, result);
        if (!attempted && approval?.approved && approvalGate?.problem) {
          try { await approvalGate.problem(approval.requestId, result.reason); } catch {}
        }
        if (notSent && approvalGate?.notSent) {
          try { await approvalGate.notSent(approval.requestId, result.reason, { retry: error.fatal }); } catch {}
        }
        if (uncertain && approvalGate) {
          try { await approvalGate.complete(approval.requestId, 'uncertain'); } catch {}
        }
        report.results.push(result); log(result);
        if (uncertain) throw new BotError('uncertain', result.reason, true);
        if (!(error instanceof BotError) || error.fatal) throw error;
      }
      if (planned >= config.maxApplicationsPerRun && (!approvalGate || approvedOnly)) break;
      await delay(config.actionDelayMs, undefined, { signal });
    }
    return report;
  } finally {
    report.finishedAt = new Date().toISOString();
    await store.report(report);
  }
}
