import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScheduledRun, watchSchedule } from '../src/schedule.js';
import { validateConfig } from '../src/config.js';

const schedule = { timeZone: 'Asia/Seoul', startHour: 8, endHour: 22, intervalHours: 2 };
const at = (time, date = '2026-11-08') => Date.parse(`${date}T${time}:00+09:00`);

test('매일 오전 8시부터 짝수 시각에 확인하고 밤 10시 이후에는 다음 날 8시를 기다린다', () => {
  assert.equal(nextScheduledRun(schedule, at('07:59')), at('08:00'));
  assert.equal(nextScheduledRun(schedule, at('08:00')), at('08:00'));
  assert.equal(nextScheduledRun(schedule, at('08:01')), at('10:00'));
  assert.equal(nextScheduledRun(schedule, at('21:59')), at('22:00'));
  assert.equal(nextScheduledRun(schedule, at('22:01')), at('08:00', '2026-11-09'));
  assert.equal(nextScheduledRun(schedule, at('23:59', '2026-12-31')), at('08:00', '2027-01-01'));
});

test('하루 한 번 오전 8시 설정은 낮에 재시작해도 다음 날 8시를 기다린다', async () => {
  const daily = { timeZone: 'Asia/Seoul', startHour: 8, endHour: 8, intervalHours: 24 };
  validateConfig({ schedule: daily });
  assert.equal(nextScheduledRun(daily, at('07:59')), at('08:00'));
  assert.equal(nextScheduledRun(daily, at('08:00')), at('08:00'));
  assert.equal(nextScheduledRun(daily, at('08:01')), at('08:00', '2026-11-09'));
  assert.equal(nextScheduledRun(daily, at('23:59', '2026-12-31')), at('08:00', '2027-01-01'));
  const done = new Error('test complete');
  let scans = 0;
  await assert.rejects(watchSchedule({ schedule: daily, now: () => at('11:15'),
    runScheduled: async () => { scans++; },
    wait: async ms => { assert.equal(ms, 20 * 60 * 60 * 1000 + 45 * 60 * 1000); throw done; },
  }), error => error === done);
  assert.equal(scans, 0);
});

test('버튼으로 일찍 깨어나도 정기 알림을 보내지 않고 확인 작업 시간도 주기를 밀지 않는다', async () => {
  let clock = at('07:30'), waiting = 0, pending = false;
  const scans = [], approvals = [], abort = new AbortController(), done = new Error('test complete');
  await assert.rejects(watchSchedule({ schedule, signal: abort.signal, now: () => clock,
    runScheduled: async () => {
      scans.push(clock); clock += 12 * 60 * 1000;
      if (scans.length === 2) abort.abort(done);
    },
    runApproved: async () => { if (pending) { approvals.push(clock); pending = false; } return false; },
    wait: async ms => {
      if (waiting++ === 0) { assert.equal(ms, 30 * 60 * 1000); clock = at('07:45'); pending = true; }
      else clock += ms;
    },
  }), error => error === done);
  assert.deepEqual(scans, [at('08:00'), at('10:00')]);
  assert.deepEqual(approvals, [at('07:45')]);
});

test('정기 시각 사이에 재시작해도 즉시 새 알림을 보내지 않는다', async () => {
  let scans = 0;
  const done = new Error('test complete');
  await assert.rejects(watchSchedule({ schedule, now: () => at('11:15'),
    runScheduled: async () => { scans++; },
    wait: async ms => { assert.equal(ms, 45 * 60 * 1000); throw done; },
  }), error => error === done);
  assert.equal(scans, 0);
});

test('정기 알림 설정의 시간대·시각·간격과 오타를 검증한다', () => {
  assert.deepEqual(validateConfig({ schedule }).schedule, schedule);
  assert.equal(validateConfig({}).schedule, null);
  for (const invalid of [[], { ...schedule, timeZone: 'UTC' }, { ...schedule, intervalHours: 0 },
    { ...schedule, startHour: 23, endHour: 8 }, { ...schedule, endHour: 24 }, { ...schedule, typo: 1 }]) {
    assert.throws(() => validateConfig({ schedule: invalid }), /schedule/);
  }
});

test('오류를 넘겨받으면 종료하지 않고 10분 뒤 최대 3번 다시 확인하며 승인 처리 오류로 바로 반복하지 않는다', async () => {
  let clock = at('07:59'), scans = 0, approvedRuns = 0;
  const errors = [], waits = [], abort = new AbortController(), done = new Error('test complete');
  await assert.rejects(watchSchedule({ schedule, signal: abort.signal, now: () => clock,
    runScheduled: async () => { scans++; if (scans <= 4) throw new Error(`scan ${scans}`); abort.abort(done); },
    runApproved: async () => { approvedRuns++; throw new Error('approved'); },
    onError: async error => { errors.push(error.message); },
    wait: async ms => { waits.push(ms); clock += ms; },
  }), error => error === done);
  // 08:00 실패 → 08:10·08:20·08:30 재시도 실패 → 다음 정기 시각 10:00에 성공
  assert.equal(scans, 5);
  assert.deepEqual(errors.filter(m => m.startsWith('scan')), ['scan 1', 'scan 2', 'scan 3', 'scan 4']);
  assert.equal(errors.filter(m => m === 'approved').length, approvedRuns);
  assert.equal(clock, at('10:00'));
  assert.ok(waits.every(ms => ms > 0), '승인 처리 오류 뒤에는 다음 시각까지 기다린다');
});

test('onError가 없으면 기존처럼 오류로 종료한다', async () => {
  await assert.rejects(watchSchedule({ schedule, now: () => at('08:00'),
    runScheduled: async () => { throw new Error('boom'); }, wait: async () => {} }), /boom/);
});
