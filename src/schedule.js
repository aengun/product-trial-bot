const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 한국 시간의 정해진 시각에 맞춥니다. 확인 작업에 걸린 시간만큼 주기가 밀리지 않습니다. */
export function nextScheduledRun(schedule, now = Date.now()) {
  const local = new Date(now + SEOUL_OFFSET_MS);
  for (let day = 0; day < 2; day++) {
    for (let hour = schedule.startHour; hour <= schedule.endHour; hour += schedule.intervalHours) {
      const at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hour) - SEOUL_OFFSET_MS;
      if (at >= now) return at;
    }
  }
  throw new Error('다음 알림 시각을 계산할 수 없습니다.');
}

export const formatScheduledTime = timestamp => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(timestamp);

/**
 * onError가 있으면 오류가 나도 종료하지 않습니다. 정기 확인이 실패하면 retryMs 뒤 최대 maxRetries번
 * 다시 시도하고(다음 정기 시각을 넘기지 않음), 승인 건 처리가 실패하면 다음 승인·정기 시각까지 기다립니다.
 */
export async function watchSchedule({ schedule, runScheduled, runApproved = async () => false,
  wait, signal, now = Date.now, log = () => {}, onError, retryMs = 10 * 60 * 1000, maxRetries = 3, runNow = false }) {
  // runNow: 시작하자마자 정기 확인을 한 번 하고 이후 정기 시각을 따릅니다(--now). 기본은 다음 정기 시각까지 기다립니다.
  let nextAt = runNow ? now() : nextScheduledRun(schedule, now()), retries = 0;
  const attempt = async run => {
    try { return { ok: true, value: await run() }; }
    catch (error) {
      if (signal?.aborted || !onError) throw error;
      await onError(error);
      return { ok: false };
    }
  };
  for (;;) {
    signal?.throwIfAborted();
    if (now() >= nextAt) {
      const { ok } = await attempt(runScheduled);
      const regular = nextScheduledRun(schedule, now() + 1);
      if (!ok && retries < maxRetries) { retries++; nextAt = Math.min(now() + retryMs, regular); }
      else { retries = 0; nextAt = regular; }
      continue;
    }
    // 버튼 승인으로 깨어나도 신규 공고 알림 시각은 바꾸지 않습니다.
    const approved = await attempt(runApproved);
    if (approved.ok && approved.value) continue;
    signal?.throwIfAborted();
    if (now() >= nextAt) continue;
    log(`다음 공고 확인·알림: ${formatScheduledTime(nextAt)} (한국 시간). 옵션 버튼은 계속 접수합니다.`);
    await wait(Math.max(1, nextAt - now()), signal);
  }
}
