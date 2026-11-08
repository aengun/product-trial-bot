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

export async function watchSchedule({ schedule, runScheduled, runApproved = async () => false,
  wait, signal, now = Date.now, log = () => {} }) {
  let nextAt = nextScheduledRun(schedule, now());
  for (;;) {
    signal?.throwIfAborted();
    if (now() >= nextAt) {
      await runScheduled();
      nextAt = nextScheduledRun(schedule, now() + 1);
      continue;
    }
    // 버튼 승인으로 깨어나도 신규 공고 알림 시각은 바꾸지 않습니다.
    if (await runApproved()) continue;
    signal?.throwIfAborted();
    if (now() >= nextAt) continue;
    log(`다음 공고 확인·알림: ${formatScheduledTime(nextAt)} (한국 시간). 옵션 버튼은 계속 접수합니다.`);
    await wait(Math.max(1, nextAt - now()), signal);
  }
}
