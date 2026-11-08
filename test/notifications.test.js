import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../src/config.js';
import { planOptions } from '../src/sizing.js';
import { StateStore, acquireLock } from '../src/store.js';
import { runCycle } from '../src/runner.js';
import { createSizeNotifier, reviewFingerprint } from '../src/notifications.js';

const profile = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8')).profile;
const config = validateConfig({ profile, maxApplicationsPerRun: 1, actionDelayMs: 500 });
const product = { uniqueId: '100', name: '블랙 셔츠', isRepresentative: true,
  optionItems: ['M', 'L'].map((size, i) => ({ no: i + 1, activated: true, outOfStock: false,
    optionValues: [{ name: '블랙', optionName: '컬러' }, { name: size, optionName: '사이즈' }] })) };
const event = { eventId: 1, name: '블랙 셔츠', eventCategory: 'TOP', products: [product] };
const ambiguousTable = { headers: ['총장', '가슴단면'], rows: [
  { size: 'M', values: [67, 54] }, { size: 'L', values: [69, 56] },
] };
const campaign = { id: '1', title: '블랙 셔츠', url: 'https://www.musinsa.com/preuser/events/1' };
const review = () => ({ ...campaign, ...planOptions(event, product, config, ambiguousTable) });

test('M/L 적합도가 비슷하거나 실측 범위 경계에 가까우면 자동 선택하지 않는다', () => {
  assert.equal(review().status, 'needs-size-review');
  assert.equal(review().review.measurements.length, 2);
  assert.equal(planOptions(event, product, config, null).status, 'needs-size-review');
  const edge = { headers: ['총장', '가슴단면'], rows: [{ size: 'M', values: [63.5, 54] }] };
  assert.equal(planOptions(event, product, config, edge).status, 'needs-size-review');
});

test('낯선 사이즈 표기는 확인 요청하되 명백한 품절은 일반 건너뛰기로 구분한다', () => {
  const p = { ...product, optionItems: [{ ...product.optionItems[0], optionValues: [{ name: '260~265', optionName: '사이즈' }] }] };
  assert.equal(planOptions({ ...event, eventCategory: 'SHOE', products: [p] }, p, config).status, 'needs-size-review');
  const soldOut = { ...product, optionItems: product.optionItems.map(i => ({ ...i, outOfStock: true })) };
  assert.equal(planOptions(event, soldOut, config).status, 'skipped');
});

test('상품명은 실행 코드와 분리하고 이미 보낸 알림 채널은 중복 전송하지 않는다', async () => {
  const calls = [], output = [];
  const notify = createSizeNotifier(config, { platform: 'darwin', execute: async (...args) => calls.push(args), write: t => output.push(t) });
  const entry = { ...review(), title: '테스트 " & do shell script "whoami" $(touch /tmp/never-run)' };
  const first = await notify(entry);
  const second = await notify(entry, first.channels);
  assert.equal(calls.length, 1);
  assert.equal(output.length, 1);
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.equal(calls[0][1][1].includes('whoami'), false);
  assert.equal(calls[0][1][3].includes('whoami'), true);
  assert.deepEqual(second.channels, ['terminal', 'desktop']);
  assert.equal(reviewFingerprint(entry), reviewFingerprint({ ...entry, applicants: 100000 }));
});

test('맥 알림 전송 실패는 성공으로 기록하지 않아 다음 주기에 재시도한다', async () => {
  let attempts = 0;
  const notify = createSizeNotifier(config, { platform: 'darwin', execute: async () => {
    attempts++; if (attempts === 1) throw new Error('native delivery failed');
  }, write: () => {} });
  const first = await notify(review());
  assert.deepEqual(first.channels, ['terminal']);
  assert.equal(first.errors.length, 1);
  const second = await notify(review(), first.channels);
  assert.deepEqual(second.channels, ['terminal', 'desktop']);
  assert.equal(attempts, 2);
});

test('한 회차의 맥 알림 상한을 넘은 공고는 다음 회차에 알릴 수 있다', async () => {
  let notices = 0;
  const dependencies = { platform: 'darwin', execute: async () => { notices++; }, write: () => {} };
  const notify = createSizeNotifier(config, dependencies);
  for (let i = 0; i < 3; i++) await notify({ ...review(), id: String(i + 1) });
  const deferred = await notify({ ...review(), id: '4' });
  assert.equal(notices, 3);
  assert.equal(deferred.deferred, true);
  assert.deepEqual(deferred.channels, ['terminal']);
  const nextCycle = await createSizeNotifier(config, dependencies)({ ...review(), id: '4' }, deferred.channels);
  assert.equal(notices, 4);
  assert.deepEqual(nextCycle.channels, ['terminal', 'desktop']);
});

test('사이즈 확인을 기다리는 공고가 다른 공고의 처리를 막지 않는다', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'musinsa-review-continue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new StateStore(dir).load();
  const submitted = [];
  const client = {
    async scan() { return { campaigns: [campaign, { ...campaign, id: '2' }], complete: true }; },
    async plan(c) { return c.id === '1' ? review() : { status: 'planned', steps: ['260'] }; },
    async prepare() {}, async submit(plan) { submitted.push(plan.steps); return {}; },
  };
  await runCycle({ client, store, config, submit: true });
  assert.deepEqual(submitted, [['260']]);
  assert.equal(store.get('1').status, 'needs-size-review');
  assert.equal(store.get('2').status, 'submitted');
});

test('확인 대기·알림 중복 방지·사용자 선택은 재시작 후에도 유지되고 실행 중에 선택 가능하다', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'musinsa-review-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new StateStore(dir).load();
  let notices = 0, prepares = 0, submits = 0;
  const notify = createSizeNotifier(config, { platform: 'darwin', execute: async () => { notices++; }, write: () => {} });
  const client = {
    async scan() { return { campaigns: [campaign], complete: true }; },
    async plan(c, decision) { return planOptions(event, product, config, ambiguousTable, decision); },
    async prepare() { prepares++; }, async submit() { submits++; return { confirmedAt: 'confirmed' }; },
  };
  await runCycle({ client, store, config, submit: true, notify });
  assert.equal(prepares, 0); assert.equal(submits, 0); assert.equal(notices, 1);
  const restarted = await new StateStore(dir).load();
  await runCycle({ client, store: restarted, config, submit: true, notify });
  assert.equal(notices, 1);
  const release = await acquireLock(dir);
  try {
    const anotherProcess = await new StateStore(dir).load();
    await assert.rejects(anotherProcess.chooseSize('1', 'XL'), /사이즈를 정확히/);
    await anotherProcess.chooseSize('1', 'l');
  } finally { await release(); }
  await runCycle({ client, store: restarted, config, submit: true, notify });
  assert.equal(prepares, 1); assert.equal(submits, 1);
  assert.deepEqual(restarted.get('1').steps, ['블랙', 'L']);
  const oldProductDecision = { campaignId: '1', productUniqueId: '999', size: 'M' };
  assert.equal(planOptions(event, product, config, ambiguousTable, oldProductDecision).status, 'needs-size-review');
});
