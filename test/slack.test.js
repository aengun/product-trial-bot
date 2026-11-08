import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig } from '../src/config.js';
import { createSizeNotifier } from '../src/notifications.js';
import { slackWebhook, slackPayload } from '../src/slack.js';
import { StateStore } from '../src/store.js';
import { runCycle } from '../src/runner.js';

// 테스트 전용 값이며, 실제 Slack으로 전송하지 않습니다.
const hook = 'https://hooks.slack.com/services/T_TEST/B_TEST/TEST_ONLY_SECRET';
const config = validateConfig({ notifications: { desktop: false, terminal: false, slack: true }, actionDelayMs: 500 });
const campaign = { id: '123', title: '블랙 셔츠', url: 'https://www.musinsa.com/preuser/events/123' };
const entry = { ...campaign, status: 'needs-size-review', reason: 'M/L 실측이 비슷해 확인이 필요합니다.',
  review: { productUniqueId: '100', productName: '블랙 셔츠', availableSizes: ['M', 'L'],
    measurements: [{ size: 'M', chest: 54, length: 67 }, { size: 'L', chest: 56, length: 69 }] } };

function setup(request) {
  let clock = 10000;
  return { env: { SLACK_WEBHOOK_URL: hook }, request, write: () => {},
    now: () => clock, wait: async ms => { clock += ms; }, advance: ms => { clock += ms; } };
}

test('Slack HTTPS 웹훅만 허용하고 잘못된 주소를 오류에 노출하지 않는다', () => {
  assert.equal(slackWebhook(hook), hook);
  assert.equal(slackWebhook(hook.replace('hooks.slack.com', 'hooks.slack-gov.com')).includes('slack-gov'), true);
  for (const url of ['http://127.0.0.1/secret', hook.replace('slack.com', 'slack.com.evil.example'),
    hook + '?secret=keep-private', hook.replace('https://', 'https://user:password@')]) {
    assert.throws(() => slackWebhook(url), error => !error.message.includes(url) && !error.message.includes('password'));
  }
  assert.throws(() => slackWebhook(''), /SLACK_WEBHOOK_URL/);
});

test('상품명은 전체 멘션으로 해석되지 않고 연결 주소·개인정보를 메시지에 넣지 않는다', () => {
  const payload = slackPayload({ ...entry, title: '<!channel> @here *외부 상품*',
    password: 'NEVER_SEND_PASSWORD', webhook: hook, address: 'NEVER_SEND_ADDRESS' });
  assert.equal(payload.mrkdwn, false);
  assert.equal(payload.parse, 'none');
  assert.equal(payload.text.includes('<!channel>'), false);
  assert.equal(payload.blocks[1].text.type, 'plain_text');
  assert.equal(payload.blocks[1].text.text.includes('<!channel>'), true);
  const body = JSON.stringify(payload);
  assert.equal(body.includes('TEST_ONLY_SECRET'), false);
  assert.equal(body.includes('NEVER_SEND_'), false);
  assert.equal(body.includes('가슴단면 54cm'), true);
  assert.equal(body.includes(campaign.url), true);
});

test('웹훅 미설정 시 전송하지 않으며 실패한 네트워크 예외에 비밀 주소를 노출하지 않는다', async () => {
  let calls = 0;
  const request = async () => { calls++; throw new Error(`request failed: ${hook}`); };
  const missing = await createSizeNotifier(config, { env: {}, request })(entry);
  assert.equal(calls, 0); assert.match(missing.errors[0], /SLACK_WEBHOOK_URL/);
  const failure = await createSizeNotifier(config, setup(request))(entry);
  assert.equal(calls, 1); assert.deepEqual(failure.channels, []);
  assert.equal(JSON.stringify(failure).includes('TEST_ONLY_SECRET'), false);
});

test('HTTP 200/ok 성공 확인·요청 간격·대상별 중복 방지를 적용한다', async () => {
  const calls = [];
  const dependencies = setup(async (url, options) => { calls.push({ url, options }); return new Response('ok'); });
  const notify = createSizeNotifier(config, dependencies);
  const first = await notify(entry);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.match(first.channels[0], /^slack:[a-f0-9]{20}$/);
  assert.equal(JSON.stringify(first).includes('TEST_ONLY_SECRET'), false);
  await createSizeNotifier(config, dependencies)(entry, first.channels);
  assert.equal(calls.length, 1);
  await notify({ ...entry, id: '124' });
  assert.equal(dependencies.now(), 11100);
  const changedTarget = { ...dependencies, env: { SLACK_WEBHOOK_URL: hook.replace('B_TEST', 'B_ANOTHER') } };
  const secondTarget = await createSizeNotifier(config, changedTarget)(entry, first.channels);
  assert.equal(calls.length, 3);
  assert.equal(secondTarget.channels.length, 2);
});

test('HTTP 오류와 200의 실패 응답은 전송 성공으로 처리하지 않는다', async () => {
  for (const [status, text] of [[403, 'invalid_token'], [200, 'invalid_payload'], [500, 'failure']]) {
    const result = await createSizeNotifier(config, setup(async () => new Response(text, { status })))(entry);
    assert.deepEqual(result.channels, []);
    assert.match(result.errors[0], /전송에 실패/);
  }
});

test('Retry-After는 재시작 후에도 지키고 과도한 알림은 다음 회차로 넘긴다', async () => {
  let calls = 0;
  const dependencies = setup(async () => { calls++; return new Response('rate_limited', { status: 429, headers: { 'retry-after': '120' } }); });
  const limited = await createSizeNotifier(config, dependencies)(entry);
  assert.equal(limited.slackRetry.at, 130000);
  const blocked = await createSizeNotifier(config, dependencies)({ ...entry, notice: limited });
  assert.equal(blocked.deferred, true); assert.equal(calls, 1);
  dependencies.advance(120000);
  await createSizeNotifier(config, dependencies)({ ...entry, notice: limited });
  assert.equal(calls, 2);
  const success = setup(async () => new Response('ok'));
  const notify = createSizeNotifier(config, success);
  for (let i = 0; i < 3; i++) await notify({ ...entry, id: String(i) });
  assert.equal((await notify({ ...entry, id: '4' })).deferred, true);
});

test('로컬 HTTP 서버로 실제 POST 계약을 검증하고 Slack에는 전송하지 않는다', async t => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(body) });
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dependencies = setup(async (url, options) => {
    assert.equal(url, hook);
    return fetch(`http://127.0.0.1:${server.address().port}/webhook`, options);
  });
  const delivered = await createSizeNotifier(config, dependencies)(entry);
  assert.equal(delivered.errors.length, 0);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].type, 'application/json');
  assert.equal(received[0].body.blocks[0].text.text, '무신사 · 사이즈 확인 필요');
});

test('봇을 재시작해도 Slack에 성공한 동일 확인 요청은 다시 보내지 않는다', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'musinsa-slack-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const dependencies = setup(async () => { calls++; return new Response('ok'); });
  const client = { async scan() { return { campaigns: [campaign], complete: true }; }, async plan() { return entry; } };
  const store = await new StateStore(dir).load();
  await runCycle({ client, store, config, notify: createSizeNotifier(config, dependencies) });
  await runCycle({ client, store: await new StateStore(dir).load(), config, notify: createSizeNotifier(config, dependencies) });
  assert.equal(calls, 1);
});

test('전송 제한 시간은 재시작 후 새 공고에도 적용한다', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'musinsa-slack-cooldown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0, scanned = [campaign];
  const dependencies = setup(async () => {
    calls++;
    return new Response('limited', { status: 429, headers: { 'retry-after': '120' } });
  });
  const client = {
    async scan() { return { campaigns: scanned, complete: true }; },
    async plan(c) { return { ...entry, id: c.id, title: c.title }; },
  };
  await runCycle({ client, store: await new StateStore(dir).load(), config, notify: createSizeNotifier(config, dependencies) });
  scanned = [{ ...campaign, id: '999', title: '새로 발견한 상품' }];
  const store = await new StateStore(dir).load();
  await runCycle({ client, store, config, notify: createSizeNotifier(config, dependencies) });
  assert.equal(calls, 1);
  assert.equal(store.get('999').notice.slackRetry.at, 130000);
});
