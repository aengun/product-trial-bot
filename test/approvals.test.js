import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalStore, planProof, buttonValue, recommendationFor, approvalChoices } from '../src/approvals.js';
import { SlackApprovalController, slackControlSettings, approvalPayload } from '../src/slack-control.js';
import { StateStore } from '../src/store.js';
import { runCycle } from '../src/runner.js';
import { BotError } from '../src/browser.js';

const binding = { teamId: 'TTEST', channelId: 'CTEST', userId: 'UTEST' };
const env = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test', SLACK_CHANNEL_ID: 'CTEST', SLACK_APPROVER_USER_ID: 'UTEST' };
const campaign = { id: '123', title: '검정 셔츠', url: 'https://www.musinsa.com/preuser/events/123' };
const choice = (size = 'M', optionNo = 1) => ({ productUniqueId: '100', productName: '셔츠', optionNo, selectedSize: size, steps: ['검정', size] });
const review = { status: 'needs-size-review', reason: 'M/L 확인 필요', review: { choices: [choice(), choice('L', 2)], measurements: [] } };
const plan = { status: 'planned', ...choice() };
const message = (text, extra = {}) => ({ type: 'message', user: 'UTEST', channel: 'CTEST', ts: '1700000001.000001', thread_ts: '1700000000.000001', text, ...extra });
const envelope = (text, extra = {}) => ({ eventId: 'Ev1', teamId: 'TTEST', message: message(text), ...extra });

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'musinsa-approval-test-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function pending(t, selectedPlan = review, options) {
  const dir = await temporary(t), store = new ApprovalStore(dir, options);
  const { request } = await store.ensure(campaign, selectedPlan, binding);
  await store.posted(request.id, 'CTEST', '1700000000.000001');
  return { dir, store, request };
}

function fakeAppFactory({ failPost = false } = {}) {
  const events = {}, posts = [], updates = [];
  let clock = 10000;
  const app = { client: {
    auth: { async test() { return { ok: true, team_id: 'TTEST' }; } },
    chat: { async postMessage(payload) {
      posts.push(payload); if (failPost) throw new Error('private network failure');
      return { ok: true, channel: 'CTEST', ts: `1700000000.${String(posts.length).padStart(6, '0')}` };
    }, async update(payload) { updates.push(payload); return { ok: true }; } },
  }, event(name, fn) { events[name] = fn; }, action(pattern, fn) { events.action = fn; }, error() {}, async start() {}, async stop() {} };
  return { appFactory: () => app, app, events, posts, updates, now: () => clock, wait: async ms => { clock += ms; } };
}

test('답장 연결 설정은 토큰 원문을 오류에 출력하지 않고 누락 값을 검증한다', () => {
  assert.throws(() => slackControlSettings({}), /SLACK_BOT_TOKEN/);
  assert.throws(() => slackControlSettings({ ...env, SLACK_APP_TOKEN: 'SECRET_BAD_VALUE' }), e => !e.message.includes('SECRET_BAD_VALUE'));
  assert.throws(() => slackControlSettings({ ...env, SLACK_APPROVER_USER_ID: 'everyone' }), /멤버 ID/);
  assert.throws(() => slackControlSettings({ ...env, SLACK_CHANNEL_ID: 'https://slack.com/' }), /채널 ID/);
  assert.equal(slackControlSettings(env).userId, 'UTEST');
});

test('본인·워크스페이스·채널·스레드가 모두 일치하는 새 답장만 처리한다', async t => {
  const { store } = await pending(t);
  const wrongMessages = [message('승인 M', { user: 'UOTHER' }), message('승인 M', { channel: 'COTHER' }),
    message('승인 M', { thread_ts: '1700000000.999999' }), message('승인 M', { subtype: 'message_changed' }),
    message('승인 M', { edited: { ts: '1700000002.000001' } }),
    message('승인 M', { bot_id: 'B1' }), message('승인 M', { thread_ts: undefined })];
  for (const m of wrongMessages) assert.equal((await store.reply(envelope('', { message: m }), binding)).ignored, true);
  assert.equal((await store.reply(envelope('승인 M', { teamId: 'TOTHER' }), binding)).ignored, true);
  assert.equal((await store.list())[0].status, 'pending');
});

test('옵션 번호만 답하면 해당 조합으로 신청하고 중복된 사이즈만으로는 색상을 정하지 않는다', async t => {
  const choices = [choice('M', 1), { ...choice('M', 2), steps: ['네이비', 'M'] }];
  const { store } = await pending(t, { ...review, review: { choices } });
  assert.notEqual((await store.reply(envelope('M'), binding)).request.status, 'approved');
  const selected = await store.reply(envelope('2', { eventId: 'Ev2', message: message('2', { ts: '1700000002.000001' }) }), binding);
  assert.equal(selected.approved, true);
  assert.deepEqual(selected.request.selectedChoice.steps, ['네이비', 'M']);
});

function interaction(request, index = 1) {
  const action = { type: 'button', action_id: `musinsa_choose_${index + 1}`,
    value: buttonValue(request, request.choices[index]), action_ts: '1700000001.000001' };
  return { body: { type: 'block_actions', user: { id: binding.userId }, team: { id: binding.teamId },
    channel: { id: binding.channelId }, message: { ts: request.threadTs } }, action };
}

test('조합 버튼은 본인과 원본 알림·버전·SKU가 일치할 때만 한 번 승인한다', async t => {
  const { store } = await pending(t);
  const request = (await store.list())[0], { body, action } = interaction(request);
  for (const field of ['user', 'team', 'channel']) {
    assert.equal((await store.selectAction({ ...body, [field]: { id: 'OTHER' } }, action, binding)).ignored, true);
  }
  assert.equal((await store.selectAction({ ...body, message: { ts: '1700000000.999999' } }, action, binding)).ignored, true);
  for (const value of ['null', '[]', '{}', '{', action.value.replace(request.uiRevision, '00000000-0000-0000-0000-000000000000')]) {
    assert.equal((await store.selectAction(body, { ...action, value }, binding)).ignored, true);
  }
  assert.equal((await store.selectAction(body, { ...action, action_id: 'musinsa_choose_1' }, binding)).ignored, true);
  const approved = await store.selectAction(body, action, binding);
  assert.equal(approved.approved, true); assert.equal(approved.request.selectedChoice.optionNo, 2);
  assert.equal((await store.selectAction(body, action, binding)).ignored, true);
});

test('기존 알림 갱신은 과거 선택 댓글과 오래된 버튼을 승인으로 바꾸지 않는다', async t => {
  const { store } = await pending(t);
  const original = (await store.list())[0], oldClick = interaction(original);
  const refreshed = (await store.refresh(original.id, campaign, review, binding, { sinceTs: '1700000002.000001' })).request;
  assert.equal((await store.reply(envelope('L'), binding)).ignored, true);
  assert.equal((await store.selectAction(oldClick.body, oldClick.action, binding)).ignored, true);
  assert.equal((await store.list())[0].status, 'pending');
  const click = interaction(refreshed);
  assert.equal((await store.selectAction(click.body, click.action, binding)).approved, true);
});

test('만료된 버튼은 신청하지 않으며 정상 버튼은 저장 전에 즉시 ACK한다', async t => {
  let clock = 10000;
  const expired = await pending(t, review, { now: () => clock });
  const request = (await expired.store.list())[0], click = interaction(request);
  clock = request.expiresAt + 1;
  assert.equal((await expired.store.selectAction(click.body, click.action, binding)).ignored, true);
  const fixture = fakeAppFactory(), dir = await temporary(t);
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); t.after(() => controller.stop()); controller.beginCycle();
  await controller.check(campaign, review);
  const current = (await controller.requests.list())[0], currentClick = interaction(current);
  let acked = false;
  const select = controller.requests.selectAction.bind(controller.requests);
  controller.requests.selectAction = (...args) => { assert.equal(acked, true); return select(...args); };
  await fixture.events.action({ ack: async () => { acked = true; }, ...currentClick });
  assert.equal((await controller.decision('123')).optionNo, 2);
  assert.equal(fixture.updates.at(-1).blocks.some(block => block.type === 'actions'), false);
  const count = fixture.posts.length;
  await fixture.events.action({ ack: async () => {}, ...currentClick });
  assert.equal(fixture.posts.length, count);
});

test('기존 방식의 사이즈 답장은 선택만 저장하고 승인 후에도 이벤트 중복을 처리하지 않는다', async t => {
  const { store, request } = await pending(t);
  await store.mutate(request.id, r => { delete r.replyMode; });
  const selected = await store.reply(envelope('L'), binding);
  assert.equal(selected.request.status, 'pending'); assert.equal(selected.request.selectedChoice.selectedSize, 'L');
  assert.equal(await store.approvedFor('123', binding), null);
  const approved = await store.reply(envelope('승인', { eventId: 'Ev2', message: message('승인', { ts: '1700000002.000001' }) }), binding);
  assert.equal(approved.approved, true); assert.equal(approved.request.selectedChoice.optionNo, 2);
  assert.equal((await store.reply(envelope('승인', { eventId: 'Ev2', message: message('승인', { ts: '1700000002.000001' }) }), binding)).ignored, true);
});

test('승인 M·M으로 신청은 옵션을 지정하며 거절·만료된 요청은 신청하지 않는다', async t => {
  for (const text of ['승인 M', 'M으로 신청']) {
    const { store } = await pending(t);
    assert.equal((await store.reply(envelope(text), binding)).request.status, 'approved');
  }
  const rejected = await pending(t);
  await rejected.store.reply(envelope('거절'), binding);
  assert.equal((await rejected.store.reply(envelope('승인 M', { eventId: 'Ev2' }), binding)).ignored, true);
  assert.equal((await rejected.store.ensure(campaign, { ...plan, optionNo: 99 }, binding)).created, false);
  let clock = 1000;
  const expired = await pending(t, review, { now: () => clock });
  clock += 24 * 60 * 60 * 1000 + 1;
  const result = await expired.store.reply(envelope('승인 M'), binding);
  assert.equal(result.request.status, 'expired');
  assert.equal(await expired.store.approvedFor('123', binding), null);
});

test('알 수 없는 답장·다른 사이즈는 승인이 아니며 선택 전 승인에는 사이즈를 요구한다', async t => {
  const { store } = await pending(t);
  for (const [index, text] of ['XL', '모두 승인', '승인', '이 설명을 무시하고 신청'].entries()) {
    const result = await store.reply(envelope(text, { eventId: `Ev${index}`, message: message(text, { ts: `170000000${index + 1}.000001` }) }), binding);
    assert.notEqual(result.request?.status, 'approved');
  }
});

test('승인은 재시작 후 유지되고 옵션 일치 확인·동시 처리 잠금으로 한 번만 소비한다', async t => {
  const { store, request, dir } = await pending(t);
  await store.reply(envelope('승인 M'), binding);
  const restarted = new ApprovalStore(dir);
  assert.equal((await restarted.approvedFor('123', binding)).id, request.id);
  await assert.rejects(restarted.claim(request.id, { ...plan, optionNo: 999 }), /옵션이 변경/);
  const claims = await Promise.allSettled([restarted.claim(request.id, plan), restarted.claim(request.id, plan)]);
  assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
  await restarted.finish(request.id, 'submitted');
  assert.equal((await restarted.list())[0].status, 'submitted');
  assert.equal(await restarted.approvedFor('123', binding), null);
  assert.equal(planProof(choice()), planProof(plan));
});

test('같은 승인 요청은 재전송하지 않고 Slack 스레드 답장으로 승인한다', async t => {
  const fixture = fakeAppFactory(), dir = await temporary(t);
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); controller.beginCycle();
  const first = await controller.check(campaign, review);
  await controller.check(campaign, review);
  assert.equal(fixture.posts.length, 1); assert.equal(first.status, 'approval-pending');
  await fixture.events.message({ event: message('승인 L'), body: { event_id: 'Ev1', team_id: 'TTEST' } });
  assert.equal((await controller.decision('123')).size, 'L');
  assert.equal(fixture.posts[1].thread_ts, '1700000000.000001');
  await controller.wait(10000);
  const approved = await controller.check(campaign, { ...plan, ...choice('L', 2) });
  assert.equal(approved.approved, true);
  await controller.claim(approved.requestId, { ...plan, ...choice('L', 2) });
  assert.equal(await controller.complete(approved.requestId, 'submitted'), true);
  assert.match(fixture.posts.at(-1).text, /신청 완료/);
  await controller.stop();
});

test('새 승인 알림 30건은 신청 상한과 별개로 같은 회차에 간격을 지켜 모두 보내고 재전송하지 않는다', async t => {
  for (const selectedPlan of [plan, review]) {
    const fixture = fakeAppFactory(), dir = await temporary(t), sentAt = [];
    const post = fixture.app.client.chat.postMessage;
    fixture.app.client.chat.postMessage = async payload => {
      sentAt.push(fixture.now()); return post(payload);
    };
    const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
    await controller.start(); t.after(() => controller.stop()); controller.beginCycle();
    const store = await new StateStore(dir).load();
    const campaigns = Array.from({ length: 30 }, (_, index) => ({ ...campaign,
      id: String(200 + index), url: `https://www.musinsa.com/preuser/events/${200 + index}` }));
    let submissions = 0;
    const client = { async scan() { return { complete: true, campaigns }; }, async plan() { return selectedPlan; },
      async prepare() { throw new Error('승인 전에 신청서를 준비하면 안 됩니다.'); }, async submit() { submissions++; } };
    const options = { client, store, config: { maxApplicationsPerRun: 1, actionDelayMs: 1 },
      submit: true, approvalGate: controller };
    const report = await runCycle(options);
    assert.equal(report.results.length, 30);
    assert.equal(fixture.posts.length, 30, '30건 모두 다음 정기 시각을 기다리지 않고 알린다');
    assert.deepEqual(fixture.posts.map(payload => payload.blocks[0].text.text),
      campaigns.map(c => `━━ 체험단 #${c.id} ━━`));
    assert.ok(sentAt.slice(1).every((at, index) => at - sentAt[index] >= 1100), '각 메시지의 전송 간격을 지킨다');
    assert.equal(submissions, 0);
    assert.ok((await controller.requests.list()).every(request => request.status === 'pending'));
    controller.beginCycle();
    await runCycle(options);
    assert.equal(fixture.posts.length, 30, '같은 승인 대기 공고를 다음 회차에 다시 보내지 않는다');
  }
});

test('승인 대기 알림은 24시간이 지나도 모집 마감까지 유지하고 기존 만료 기록도 재발송 없이 복구한다', async t => {
  for (const legacyStatus of [null, 'pending', 'expired']) {
    const fixture = fakeAppFactory(), dir = await temporary(t);
    await fixture.wait(Date.parse('2026-11-08T08:00:00+09:00') - fixture.now());
    const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
    await controller.start();
    const open = { ...campaign, endDate: '2026-11-11' };
    await controller.check(open, plan);
    const original = (await controller.requests.list())[0];
    assert.equal(original.expiresAt, Date.parse('2026-11-11T23:59:59+09:00'));
    if (legacyStatus) await controller.requests.mutate(original.id, r => {
      r.expiresAt = r.createdAt + 24 * 60 * 60 * 1000; r.status = legacyStatus;
    });
    await controller.stop();
    await fixture.wait(25 * 60 * 60 * 1000);
    const restarted = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
    await restarted.start(); t.after(() => restarted.stop()); restarted.beginCycle();
    const result = await restarted.check(open, plan);
    assert.equal(result.requestId, original.id);
    assert.equal(result.status, 'approval-pending');
    assert.equal(fixture.posts.length, 1, '이미 받은 알림을 다음 날 다시 보내지 않는다');
    const current = (await restarted.requests.list())[0];
    assert.equal(current.threadTs, original.threadTs);
    assert.equal(current.uiRevision, original.uiRevision);
    const click = interaction(current, 0);
    assert.equal((await restarted.requests.selectAction(click.body, click.action, binding)).approved, true,
      '원래 알림 버튼은 계속 승인할 수 있다');
  }
});

test('재시작하면 누락된 스레드 답장을 페이지 끝까지 읽어 복구하고 다른 사용자·수정·중복 답장은 승인하지 않는다', async t => {
  const { dir, store, request } = await pending(t);
  await store.mutate(request.id, r => { delete r.replyMode; });
  const fixture = fakeAppFactory(), calls = [];
  const parent = { type: 'message', ts: '1700000000.000001', reply_count: 4 };
  fixture.app.client.conversations = {
    async history(args) {
      calls.push(['history', args]);
      return args.cursor ? { ok: true, messages: [parent] }
        : { ok: true, messages: [], response_metadata: { next_cursor: 'history-next' } };
    },
    async replies(args) {
      calls.push(['replies', args]);
      return args.cursor ? { ok: true, messages: [
        message('승인', { ts: '1700000004.000001' }),
        message('L', { ts: '1700000003.000001' }),
        message('승인 M', { ts: '1700000002.000001', edited: { ts: '1700000005.000001' } }),
      ] } : { ok: true, messages: [parent, message('승인 M', { user: 'UOTHER' })],
        response_metadata: { next_cursor: 'replies-next' } };
    },
  };
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); t.after(() => controller.stop());
  assert.equal((await controller.decision('123')).size, 'L');
  assert.equal(fixture.posts.length, 2);
  assert.match(fixture.posts.at(-1).text, /신청 접수/);
  assert.deepEqual(calls.map(([method, args]) => [method, args.cursor]), [
    ['history', undefined], ['history', 'history-next'], ['replies', undefined], ['replies', 'replies-next'],
  ]);
  assert.equal(calls[0][1].oldest, parent.ts);
  assert.equal(await controller.recoverReplies(), 0);
  await fixture.events.message({ event: message('승인', { ts: '1700000004.000001' }), body: { event_id: 'EvDeliveredLater', team_id: 'TTEST' } });
  assert.equal(fixture.posts.length, 2, '기록에서 복구한 댓글이 실시간 이벤트로 도착해도 다시 처리하지 않는다');
});

test('이전 답장 복구가 실패해도 새 승인 답장은 계속 수신한다', async t => {
  const { dir } = await pending(t), fixture = fakeAppFactory(), logs = [];
  fixture.app.client.conversations = { async history() { return { ok: false, error: 'missing_scope' }; } };
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: text => logs.push(text) });
  await controller.start(); t.after(() => controller.stop());
  assert.match(logs[0], /복구하지 못/);
  assert.equal(await controller.decision('123'), null);
  await fixture.events.message({ event: message('승인 M'), body: { event_id: 'EvNew', team_id: 'TTEST' } });
  assert.equal((await controller.decision('123')).size, 'M');
});

test('사이즈 없는 상품도 옵션 번호로 승인하고 실제 선택 옵션을 그대로 검증한다', async t => {
  const fixture = fakeAppFactory(), dir = await temporary(t);
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); t.after(() => controller.stop()); controller.beginCycle();
  const choices = [
    { ...choice('옵션1', 1), selectionKind: 'option', steps: ['화이트'] },
    { ...choice('옵션2', 2), selectionKind: 'option', steps: ['블랙'] },
  ];
  await controller.check(campaign, { status: 'needs-size-review', selectionKind: 'option',
    review: { choices, measurements: [] } });
  const buttons = fixture.posts[0].blocks.filter(b => b.type === 'actions').flatMap(b => b.elements);
  assert.deepEqual(buttons.map(b => b.text.text), ['1. 화이트', '2. 블랙', '거절']);
  assert.doesNotMatch(JSON.stringify(fixture.posts[0]), /승인 옵션1|사이즈 확인/);
  await fixture.events.message({ event: message('옵션2'), body: { event_id: 'EvSelect', team_id: 'TTEST' } });
  assert.equal((await controller.decision('123')).size, '옵션2');
  const selected = { status: 'planned', ...choices[1] };
  const gate = await controller.check(campaign, selected);
  assert.equal(gate.approved, true);
  await controller.claim(gate.requestId, selected);
  assert.equal(await controller.complete(gate.requestId, 'submitted'), true);
  assert.match(fixture.posts.at(-1).text, /블랙 신청 완료/);
});

test('옵션이 없는 상품은 승인·거절 버튼만 보내고, 거절하면 만료 후에도 다시 알리지 않는다', async t => {
  const fixture = fakeAppFactory(), dir = await temporary(t);
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); t.after(() => controller.stop()); controller.beginCycle();
  const only = { productUniqueId: '100', productName: '향수', optionNo: 7, selectedSize: 'NONE', selectionKind: 'option', steps: ['NONE'] };
  const other = { ...campaign, id: '124', url: 'https://www.musinsa.com/preuser/events/124' };
  await controller.check(campaign, { status: 'planned', ...only, choices: [only] });
  await controller.check(other, { status: 'planned', ...only, choices: [only] });
  assert.match(fixture.posts[0].blocks[1].text.text, /\n옵션 없음 · 승인하면 신청$/);
  const buttons = post => post.blocks.filter(b => b.type === 'actions').flatMap(b => b.elements);
  assert.deepEqual(buttons(fixture.posts[0]).map(b => b.text.text), ['승인', '거절']);
  const requests = await controller.requests.list();
  const click = async (id, button, ts) => fixture.events.action({ ack: async () => {}, action: { ...button, action_ts: ts },
    body: { type: 'block_actions', user: { id: 'UTEST' }, team: { id: 'TTEST' }, channel: { id: 'CTEST' },
      message: { ts: requests.find(r => r.campaign.id === id).threadTs } } });
  // 다른 알림의 거절 버튼으로는 이 요청을 거절하지 않는다
  await click('124', buttons(fixture.posts[0])[1], '1700000002.000001');
  assert.equal((await controller.requests.list()).find(r => r.campaign.id === '124').status, 'pending');
  await click('123', buttons(fixture.posts[0])[1], '1700000002.000002');
  assert.equal((await controller.requests.list()).find(r => r.campaign.id === '123').status, 'rejected');
  assert.match(fixture.posts.at(-1).text, /거절했습니다/);
  assert.equal(fixture.updates.at(-1).blocks.some(b => b.type === 'actions'), false);
  assert.match(fixture.updates.at(-1).blocks[1].text.text, /거절함/);
  await click('124', buttons(fixture.posts[1])[0], '1700000002.000003');
  assert.equal((await controller.decision('124')).optionNo, 7);
  const posted = fixture.posts.length;
  await fixture.wait(25 * 60 * 60 * 1000);
  assert.equal((await controller.check(campaign, { status: 'planned', ...only, choices: [only] })).status, 'approval-rejected');
  assert.equal(fixture.posts.length, posted);
});

test('승인한 옵션이 바뀌면 새 승인을 요구하고 불확실한 Slack 전송을 반복하지 않는다', async t => {
  const dir = await temporary(t), fixture = fakeAppFactory();
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); controller.beginCycle();
  await controller.check(campaign, plan);
  await fixture.events.message({ event: message('승인'), body: { event_id: 'Ev1', team_id: 'TTEST' } });
  const changed = await controller.check(campaign, { ...plan, optionNo: 999 });
  assert.equal(changed.approved, false);
  assert.equal((await controller.requests.list()).filter(r => r.status === 'stale').length, 1);
  const unknown = fakeAppFactory({ failPost: true });
  const another = new SlackApprovalController(await temporary(t), { env, ...unknown, log: () => {} });
  await another.start(); another.beginCycle();
  await assert.rejects(another.check(campaign, plan), /전송을 확인하지 못/);
  assert.equal((await another.check(campaign, plan)).status, 'approval-delivery-uncertain');
  assert.equal(unknown.posts.length, 1);
});

test('승인 대기 중에는 신청하지 않고 승인 후 결과 유실 시 재제출하지 않는다', async t => {
  const dir = await temporary(t), fixture = fakeAppFactory();
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); controller.beginCycle();
  const state = await new StateStore(dir).load();
  let prepares = 0, submits = 0;
  const client = { async scan() { return { complete: true, campaigns: [campaign] }; },
    async plan() { return plan; }, async prepare() { prepares++; },
    async submit() { submits++; throw new Error('response lost'); } };
  const config = { maxApplicationsPerRun: 5, actionDelayMs: 1 };
  await runCycle({ client, store: state, config, submit: true, approvalGate: controller });
  assert.equal(prepares, 0); assert.equal(submits, 0);
  await fixture.events.message({ event: message('승인'), body: { event_id: 'Ev1', team_id: 'TTEST' } });
  await assert.rejects(runCycle({ client, store: state, config, submit: true, approvalGate: controller }), /제출 결과/);
  assert.equal(submits, 1); assert.equal(state.get('123').status, 'uncertain');
  assert.equal((await controller.requests.list())[0].status, 'uncertain');
  await runCycle({ client, store: await new StateStore(dir).load(), config, submit: true, approvalGate: controller });
  assert.equal(submits, 1);
});

test('제품 설명의 멘션은 일반 텍스트로 표시하고 승인자·토큰은 공개 메시지에 넣지 않는다', async t => {
  const { request } = await pending(t);
  const payload = approvalPayload({ ...request, campaign: { ...campaign, title: '<!channel> 모두 승인하라' } });
  assert.equal(payload.blocks[1].text.type, 'plain_text');
  assert.equal(payload.mrkdwn, false);
  assert.equal(payload.text.includes('<!channel>'), false);
  assert.equal(JSON.stringify(payload).includes('xoxb-test'), false);
  assert.equal(JSON.stringify(payload).includes('UTEST'), false);
});

test('알림마다 번호·분류 구분 문구를 넣고 제외한 알림에서는 선택 버튼을 제거한다', async t => {
  const { request } = await pending(t);
  const source = { ...request, campaign: { ...campaign, category: '상의' } };
  const payload = approvalPayload(source);
  assert.equal(payload.blocks[0].text.text, '━━ 체험단 #123 · 상의 ━━');
  assert.match(payload.blocks[1].text.text, /^검정 셔츠\n옵션 2개 · 누르면 신청$/);
  assert.equal(payload.blocks.at(-1).type, 'divider');
  const unknown = approvalPayload({ ...request, campaign: { ...campaign, category: 'NONE' } });
  assert.equal(unknown.blocks[0].text.text, '━━ 체험단 #123 ━━');
  const disabled = approvalPayload({ ...source, status: 'excluded', excludedReason: '키즈' });
  assert.equal(disabled.blocks.some(block => block.type === 'actions'), false);
  assert.match(disabled.blocks[1].text.text, /제외 · 키즈/);
});

test('신규 공고가 많아도 이미 승인된 공고를 먼저 처리한다', async t => {
  const dir = await temporary(t), fixture = fakeAppFactory();
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); controller.beginCycle();
  await controller.check(campaign, plan);
  await fixture.events.message({ event: message('승인'), body: { event_id: 'Ev1', team_id: 'TTEST' } });
  controller.beginCycle();
  const store = await new StateStore(dir).load(), checked = [];
  const client = { async scan() { return { complete: true, campaigns: [{ ...campaign, id: '999' }, campaign] }; },
    async plan(c) { checked.push(c.id); return plan; }, async prepare() {}, async submit() { return {}; } };
  await runCycle({ client, store, config: { maxApplicationsPerRun: 1, actionDelayMs: 1 }, submit: true, approvalGate: controller });
  assert.deepEqual(checked, ['123', '999']); assert.equal(store.get('123').status, 'submitted');
  assert.equal(store.get('999').status, 'approval-pending');
});

test('실제 신청 상한에 도달해도 새 알림은 모두 보내고 남은 승인은 다음 묶음에서 처리한다', async t => {
  const dir = await temporary(t), fixture = fakeAppFactory();
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); t.after(() => controller.stop());
  const campaigns = Array.from({ length: 9 }, (_, index) => ({ ...campaign, id: String(300 + index) }));
  for (const c of campaigns.slice(0, 2)) {
    await controller.check(c, plan);
    const request = (await controller.requests.list()).find(r => r.campaign.id === c.id);
    const click = interaction(request, 0);
    await controller.requests.selectAction(click.body, click.action, binding);
  }
  const store = await new StateStore(dir).load(), submitted = [];
  const client = { async scan() { return { complete: true, campaigns }; }, async plan(c) { return { ...plan, campaignId: c.id }; },
    async prepare() {}, async submit(p) { submitted.push(p.campaignId); return {}; } };
  const options = { client, store, config: { maxApplicationsPerRun: 1, actionDelayMs: 1 },
    submit: true, approvalGate: controller };
  controller.beginCycle();
  await runCycle(options);
  assert.equal(submitted.length, 1);
  assert.equal(Object.values(store.data.campaigns).filter(r => r.status === 'approval-queued').length, 1);
  assert.equal(fixture.posts.filter(post => !post.thread_ts).length, 9, '남은 신규 공고 7건도 전부 알린다');
  controller.beginCycle();
  await runCycle({ ...options, approvedOnly: true });
  assert.deepEqual(new Set(submitted), new Set(['300', '301']));
  assert.equal(fixture.posts.filter(post => !post.thread_ts).length, 9, '승인 처리 중 새 알림을 보내지 않는다');
});

test('정기 알림 시각 밖에서는 승인한 건만 처리하고 새 공고·변경 옵션 알림은 보내지 않는다', async t => {
  for (const changed of [false, true]) {
    const dir = await temporary(t), fixture = fakeAppFactory();
    const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
    await controller.start(); t.after(() => controller.stop()); controller.beginCycle();
    await controller.check(campaign, plan);
    await fixture.events.message({ event: message('옵션1'), body: { event_id: 'Ev1', team_id: 'TTEST' } });
    const store = await new StateStore(dir).load(), checked = [];
    let submissions = 0;
    const client = { async scan() { return { complete: true, campaigns: [{ ...campaign, id: '999' }, campaign] }; },
      async plan(c) { checked.push(c.id); return changed ? { ...plan, optionNo: 999 } : plan; },
      async prepare() {}, async submit() { submissions++; return {}; } };
    await runCycle({ client, store, config: { maxApplicationsPerRun: 5, actionDelayMs: 1 }, submit: true,
      approvalGate: controller, approvedOnly: true });
    assert.deepEqual(checked, ['123']);
    assert.equal(submissions, changed ? 0 : 1);
    assert.equal(fixture.posts.filter(post => !post.thread_ts).length, 1, '새 승인 알림을 게시하지 않는다');
    assert.equal((await controller.requests.list()).length, 1);
  }
});

test('로그인 문제도 같은 스레드에 알리고 미제출 승인은 문제 해결 후 한 번 처리한다', async t => {
  const dir = await temporary(t), fixture = fakeAppFactory();
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); controller.beginCycle();
  await controller.check(campaign, plan);
  await fixture.events.message({ event: message('승인'), body: { event_id: 'Ev1', team_id: 'TTEST' } });
  let loggedIn = false, submissions = 0;
  const store = await new StateStore(dir).load();
  const client = { async scan() { return { complete: true, campaigns: [campaign] }; }, async plan() { return plan; },
    async prepare() { if (!loggedIn) throw new BotError('login-required', '로그인이 필요합니다.', true); },
    async submit() { submissions++; return {}; } };
  const config = { maxApplicationsPerRun: 1, actionDelayMs: 1 };
  await assert.rejects(runCycle({ client, store, config, submit: true, approvalGate: controller }), /로그인/);
  assert.equal(submissions, 0); assert.match(fixture.posts.at(-1).text, /로그인이 필요/);
  assert.equal((await controller.requests.list())[0].status, 'approved');
  loggedIn = true;
  await runCycle({ client, store, config, submit: true, approvalGate: controller });
  assert.equal(submissions, 1); assert.equal(store.get('123').status, 'submitted');
});

test('봇 오류는 같은 내용을 6시간에 한 번만 채널에 알리고 정상 회차 뒤 재개를 한 번 알린다', async t => {
  const fixture = fakeAppFactory(), dir = await temporary(t);
  const controller = new SlackApprovalController(dir, { env, ...fixture, log: () => {} });
  await controller.start(); t.after(() => controller.stop());
  assert.equal(await controller.resolved(), false);
  assert.equal(await controller.alert('로그인이 필요합니다. <!channel>'), true);
  assert.equal(await controller.alert('로그인이 필요합니다. <!channel>'), false);
  assert.equal(fixture.posts.length, 1);
  assert.equal(fixture.posts[0].channel, 'CTEST');
  assert.equal(fixture.posts[0].thread_ts, undefined);
  assert.match(fixture.posts[0].text, /^⚠️ 체험단 봇 오류\n로그인이 필요합니다\. &lt;!channel&gt;$/);
  assert.equal(await controller.resolved(), true);
  assert.equal(await controller.resolved(), false);
  assert.match(fixture.posts.at(-1).text, /정상 동작을 재개/);
  assert.equal(await controller.alert('로그인이 필요합니다. <!channel>'), true, '재개 후 같은 오류가 다시 나면 알린다');
});

test('추천 사이즈 버튼만 초록색 ★로 표시하고, 추천 표시만 달라진 공고는 다시 알리지 않는다', async t => {
  const dir = await temporary(t), store = new ApprovalStore(dir);
  const recommended = { ...review, review: { ...review.review, recommendation: { productUniqueId: '100', sizes: ['M'] } } };
  const { request } = await store.ensure(campaign, recommended, binding);
  assert.deepEqual(request.recommended, [planProof(choice())]);
  assert.deepEqual(request.recommendedSizes, ['M']);
  const payload = approvalPayload({ ...request, status: 'pending' });
  const buttons = payload.blocks.flatMap(block => block.elements ?? []);
  assert.deepEqual(buttons.map(b => [b.text.text, b.style]), [['★ 1. 검정 / M', 'primary'], ['2. 검정 / L', undefined], ['거절', 'danger']]);
  assert.match(buttons[0].accessibility_label, /^추천 /);
  assert.match(payload.blocks[1].text.text, /^검정 셔츠\n옵션 2개 · 누르면 신청 · ★ 추천 M$/);
  await store.posted(request.id, 'CTEST', '1700000000.000001');
  assert.equal((await store.ensure(campaign, review, binding)).created, false, '추천 표시는 알림 지문에 넣지 않는다');
  // 추천 정보가 없는 예전 승인 기록은 기존과 같이 표시한다.
  const legacy = approvalPayload({ ...request, status: 'pending', recommended: undefined, recommendedSizes: undefined });
  assert.equal(legacy.blocks.flatMap(block => block.elements ?? []).filter(b => b.style === 'primary').length, 0);
});

test('봇이 고른 사이즈는 같은 상품의 같은 사이즈 색상 전부를 추천으로 표시하고 옵션 하나면 표시하지 않는다', () => {
  const other = { ...choice('L', 3), productUniqueId: '200', steps: ['흰색', 'L'] };
  const planned = { status: 'planned', ...choice('L', 2), choices: [choice('M', 1), choice('L', 2), { ...choice('L', 4), steps: ['흰색', 'L'] }, other] };
  const result = recommendationFor(planned, approvalChoices(planned));
  assert.deepEqual(result.proofs, [planProof(choice('L', 2)), planProof({ ...choice('L', 4), steps: ['흰색', 'L'] })]);
  assert.deepEqual(result.sizes, ['L']);
  assert.deepEqual(recommendationFor(plan, approvalChoices(plan)), { proofs: [], sizes: [] });
  assert.deepEqual(recommendationFor(review, approvalChoices(review)), { proofs: [], sizes: [] }, '추천 근거가 없으면 표시하지 않는다');
});
