import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateConfig, CONSENTS } from '../src/config.js';
import { PLATFORMS, platformFor, platformEnv, platformConfig, seoulDate } from '../src/platforms.js';
import { TwentyNineClient, optionChoices, categoryInfo, exclusionReason, profileSizes } from '../src/sites/29cm.js';
import { FourNineTenClient, MIN_ENTRIES } from '../src/sites/4910.js';
import { SlackApprovalController, approvalPayload } from '../src/slack-control.js';
import { ApprovalStore } from '../src/approvals.js';
import { StateStore } from '../src/store.js';
import { runCycle } from '../src/runner.js';

const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
const config = { ...validateConfig({ ...example, acceptedConsentIds: Object.keys(CONSENTS) }), actionDelayMs: 1, timeoutMs: 1000 };
const binding = { teamId: 'TTEST', channelId: 'CTEST', userId: 'UTEST' };
const env = { SLACK_BOT_TOKEN: 'xoxb-site', SLACK_APP_TOKEN: 'xapp-site', SLACK_CHANNEL_ID: 'CTEST', SLACK_APPROVER_USER_ID: 'UTEST' };
const KEY = 'PE_s0kGMxZ7RfaQFlEuhZdrFlJKgW8ELeXg', KEY2 = 'PE_NKijAH2HglbbiEN1hdnV94qTkMS27hbp';
const DAY = 24 * 60 * 60 * 1000;

const started = async client => { await client.start(); return client; };

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'site-bot-test-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

/** 사이트 탭 안에서 도는 함수를 그대로 실행합니다. document·location·fetch만 가짜 서버로 바꿉니다. */
function installPage(t, { cookie = '', route }) {
  const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const calls = [];
  globalThis.document = { cookie, querySelector: () => null, body: { innerText: '' } };
  globalThis.location = { href: 'about:blank' };
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method ?? 'GET', headers: { ...(options.headers ?? {}) },
      body: options.body === undefined ? undefined : JSON.parse(options.body) };
    calls.push(call);
    const [status, json] = await route(new URL(url), call);
    if (status === 0) throw new TypeError('Failed to fetch');
    return { status, ok: status >= 200 && status < 300, json: async () => json };
  };
  t.after(() => Object.assign(globalThis, saved));
  const tab = {
    async goto(url) { globalThis.location = { href: url }; return 200; },
    async evaluate(fn, arg) { return JSON.parse(JSON.stringify((await fn(arg)) ?? null)); },
    async url() { return globalThis.location.href; },
  };
  return { tab, calls };
}

function fakeApp() {
  const events = {}, posts = [], updates = [];
  let clock = Date.now();
  const app = { client: {
    auth: { async test() { return { ok: true, team_id: 'TTEST' }; } },
    chat: { async postMessage(payload) { posts.push(payload); return { ok: true, channel: 'CTEST', ts: `1700000000.${String(posts.length).padStart(6, '0')}` }; },
      async update(payload) { updates.push(payload); return { ok: true }; } },
  }, event(name, fn) { events[name] = fn; }, action(pattern, fn) { events.action = fn; }, error() {}, async start() {}, async stop() {} };
  return { appFactory: () => app, events, posts, updates, now: () => clock, wait: async ms => { clock += ms; } };
}
const click = (fixture, payload, index = 0) => {
  const button = payload.blocks.flatMap(block => block.elements ?? [])[index];
  return fixture.events.action({ ack: async () => {}, action: { ...button, type: 'button', action_ts: `1700000100.00000${index}` },
    body: { type: 'block_actions', user: { id: 'UTEST' }, team: { id: 'TTEST' }, channel: { id: 'CTEST' },
      message: { ts: '1700000000.000001' } } });
};

// ---------------------------------------------------------------- 공통

test('플랫폼별 Slack 설정은 전용 파일만 쓰고 무신사 봇과 같은 토큰·채널은 거부한다', () => {
  const base = { SLACK_BOT_TOKEN: 'xoxb-musinsa', SLACK_APP_TOKEN: 'xapp-musinsa', SLACK_CHANNEL_ID: 'CMUSINSA', SLACK_APPROVER_USER_ID: 'UTEST' };
  const file = text => ({ base, read: () => text });
  assert.equal(platformEnv(PLATFORMS.musinsa, { base }), base);
  assert.throws(() => platformEnv(PLATFORMS['29cm'], { base, read: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), /\.env\.29cm 파일이 없습니다/);
  const own = 'SLACK_BOT_TOKEN=xoxb-29cm\nSLACK_APP_TOKEN=xapp-29cm\nSLACK_CHANNEL_ID=C29CM\n';
  assert.deepEqual(platformEnv(PLATFORMS['29cm'], file(own)),
    { SLACK_APPROVER_USER_ID: 'UTEST', SLACK_BOT_TOKEN: 'xoxb-29cm', SLACK_APP_TOKEN: 'xapp-29cm', SLACK_CHANNEL_ID: 'C29CM' });
  // 같은 앱 토큰을 쓰면 버튼 이벤트가 한 봇에만 전달되므로 막고, 오류에 토큰 원문을 넣지 않는다.
  assert.throws(() => platformEnv(PLATFORMS['4910'], file(own.replace('xapp-29cm', 'xapp-musinsa'))),
    error => /앱 토큰/.test(error.message) && !error.message.includes('xapp-musinsa'));
  assert.throws(() => platformEnv(PLATFORMS['4910'], file(own.replace('C29CM', 'CMUSINSA'))), /채널 ID/);
  assert.throws(() => platformEnv(PLATFORMS['4910'], file('SLACK_BOT_TOKEN=xoxb-4910\n')), /SLACK_APP_TOKEN/);
  assert.throws(() => platformFor('coupang'), /알 수 없는 플랫폼/);
  assert.deepEqual(platformConfig(PLATFORMS['29cm'], { ...config, campaignIds: ['1'] }).campaignIds, []);
});

test('공고 링크는 각 플랫폼의 체험단 주소만 허용하고 마감일은 한국 날짜로 바꾼다', () => {
  assert.equal(PLATFORMS['29cm'].link(`https://www.29cm.co.kr/preuser/event/${KEY}`), `https://www.29cm.co.kr/preuser/event/${KEY}`);
  assert.equal(PLATFORMS['29cm'].link('https://evil.example/preuser'), 'https://www.29cm.co.kr/preuser');
  assert.equal(PLATFORMS['4910'].link('https://4910.kr/preuser/goods/123?preuser_goods_sno=9'), 'https://4910.kr/preuser/goods/123?preuser_goods_sno=9');
  assert.equal(PLATFORMS['4910'].link('https://4910.kr/preuser/goods/123?next=https://evil'), 'https://4910.kr/preuser');
  assert.equal(seoulDate('2026-11-12T14:59:59Z'), '2026-11-12');
  assert.equal(seoulDate('2026-11-12T15:00:00Z'), '2026-11-13');
});

test('신청 기록은 29CM 공고 키를 받지만 경로 문자가 든 번호는 거부한다', async t => {
  const store = await new StateStore(await temporary(t)).load();
  await store.set(KEY, { status: 'submitted' });
  assert.equal(store.blocks(KEY), true);
  await assert.rejects(store.set('../x', { status: 'submitted' }), /번호/);
  await assert.rejects(store.set('PE_../../x', { status: 'submitted' }), /번호/);
});

// ---------------------------------------------------------------- 29CM

const optionDetail = (key = KEY, extra = {}) => ({ preuserEventKey: key, itemId: 4244215, itemName: '슬라우치 비니 (2 color)',
  recruitStartAt: new Date(Date.now() - DAY).toISOString(), recruitEndAt: new Date(Date.now() + DAY).toISOString(),
  itemOptionType: 'OPTION', isUserApplied: false, optionItemLabelList: ['color', 'size'],
  itemOptionTreeNode: { childList: [
    { optionItemLabel: 'color', optionItemValue: 'grey', childList: [
      { optionItemLabel: 'size', optionItemValue: 'M', option: { optionId: 101, optionName: 'grey M' } },
      { optionItemLabel: 'size', optionItemValue: 'L', option: { optionId: 102, optionName: 'grey L' } }] },
    { optionItemLabel: 'color', optionItemValue: 'black', childList: [
      { optionItemLabel: 'size', optionItemValue: 'M', option: { optionId: 103, optionName: 'black M' } }] }] }, ...extra });

test('29CM 옵션 트리는 실제 optionId마다 선택지를 만들고 옵션 없는 상품은 기본 구성 하나로 둔다', () => {
  const choices = optionChoices(optionDetail());
  assert.deepEqual(choices.map(c => [c.optionNo, c.steps.join('/'), c.selectedSize, c.choiceKey]),
    [[101, 'grey/M', 'M', '옵션1'], [102, 'grey/L', 'L', '옵션2'], [103, 'black/M', 'M', '옵션3']]);
  const single = optionChoices({ ...optionDetail(), itemOptionType: 'NO_OPTION', itemOptionTreeNode: null });
  assert.deepEqual(single.map(c => [c.optionNo, c.steps, c.selectedSize]), [[4244215, ['NONE'], '기본 구성']]);
});

test('29CM 카테고리로 여성 전용·키즈는 거르고 남녀공용·생활·남성 화장품은 남긴다', () => {
  const women = [['여성의류', '니트웨어']], unisex = [['여성의류', '니트'], ['남성의류', '니트']];
  assert.equal(categoryInfo(women).womenOnly, true);
  assert.equal(categoryInfo(unisex).womenOnly, false);
  assert.equal(categoryInfo(unisex).label, '남성의류', '공용 상품은 남성 카테고리로 표시한다');
  const campaign = { brand: '브랜드', title: '브랜드 니트' };
  assert.equal(exclusionReason(campaign, women, config), '여성 상품 제외');
  assert.equal(exclusionReason(campaign, unisex, config), null);
  assert.equal(exclusionReason(campaign, [['키즈', '아우터']], config), '키즈 제외');
  assert.equal(exclusionReason({ brand: '브랜드', title: '브랜드 머그 세트' }, [['라이프', '키친']], config), null);
  assert.equal(exclusionReason({ brand: '브랜드', title: '브랜드 쿠션 팩트' }, [['뷰티', '메이크업']], config), '여성 색조 화장품 제외');
  assert.equal(exclusionReason({ brand: '브랜드', title: '브랜드 우먼 팬츠' }, [['라이프', '키친']], config), '제외 키워드');
  assert.equal(exclusionReason(campaign, null, config), null, '카테고리를 못 읽으면 키워드 필터만 적용한다');
});

function cmRoute({ pages = [], details = {}, categories = {}, addresses = [], loggedIn = true, apply } = {}) {
  return async (url, call) => {
    const ok = data => [200, { meta: { result: 'SUCCESS', errorCode: null, message: null }, data }];
    if (url.hostname === 'preuser-api.29cm.co.kr') {
      if (url.pathname === '/api/v4/preuser/events') {
        const page = Number(url.searchParams.get('page'));
        return ok({ list: pages[page - 1] ?? [], pagination: { page, size: 50, hasNext: page < pages.length } });
      }
      if (url.pathname === '/api/v4/preuser/events/my-applications/count') {
        return loggedIn ? ok({ totalCount: 0, appliedCount: 0, winnerCount: 0, closedCount: 0 })
          : [401, { meta: { result: 'FAIL', errorCode: 'UNAUTHORIZED', message: '인증에 실패했습니다.' }, data: null }];
      }
      const applyMatch = /^\/api\/v4\/preuser\/events\/(PE_\w+)\/apply$/.exec(url.pathname);
      if (applyMatch && call.method === 'POST') return apply(applyMatch[1], call);
      const detail = details[decodeURIComponent(url.pathname.split('/').at(-1))];
      return detail ? ok(typeof detail === 'function' ? detail() : detail) : [404, { meta: { result: 'FAIL' } }];
    }
    if (url.hostname === 'bff-api.29cm.co.kr') {
      const itemId = url.pathname.split('/').at(-1);
      return [200, { data: { itemNo: Number(itemId), frontCategoryInfo: (categories[itemId] ?? [['남성의류', '니트']])
        .map(([category1Name, category2Name]) => ({ category1Name, category2Name })) } }];
    }
    if (url.hostname === 'user-api.29cm.co.kr') return loggedIn ? ok(typeof addresses === 'function' ? addresses() : addresses) : [401, { meta: { result: 'FAIL' } }];
    throw new Error(`unexpected ${url}`);
  };
}
const listItem = (key, name, endOffset, extra = {}) => ({ preuserEventKey: key, applicantCount: 10, totalWinnerLimit: 5,
  recruitEndAt: new Date(Date.now() + endOffset).toISOString(), itemId: 4244215, itemName: name,
  frontBrandId: 1, frontBrandNameEng: 'BRAND', frontBrandNameKor: '브랜드', ...extra });
const address = (extra = {}) => ({ id: 77, userId: 5, addressName: '집', receiverName: '홍길동', receiverPhone: '010-0000-0000',
  receiverAdditionalPhone: null, receiverZipcode: '04790', receiverAddress1: '서울 성동구 아차산로13길 11', receiverAddress2: '1층',
  etcMessage: '부재시 문앞에 놓아주세요.', isPrimary: true, isDeleted: false, ...extra });

test('29CM 목록은 모집 중인 공고만 모으고 마감된 페이지에서 멈추며 제외 키워드를 적용한다', async t => {
  const { tab, calls } = installPage(t, { route: cmRoute({ pages: [
    [listItem(KEY, '슬라우치 비니', DAY), listItem('PE_womenaaaaaaa', '우먼 데님 팬츠', DAY), listItem('PE_closedaaaaaa', '지난 공고', -DAY)],
    [listItem('PE_closedbbbbbb', '지난 공고', -2 * DAY)],
    [listItem('PE_neverreadaaa', '읽지 않는 페이지', -3 * DAY)]] }) });
  const result = await new TwentyNineClient(tab, config).scan();
  assert.deepEqual(result.campaigns.map(c => [c.id, c.title, c.url]), [[KEY, '브랜드 슬라우치 비니', `https://www.29cm.co.kr/preuser/event/${KEY}`]]);
  assert.equal(result.complete, true);
  assert.equal(calls.filter(call => call.url.includes('/preuser/events?')).length, 2, '모두 마감된 페이지 뒤는 읽지 않는다');
  assert.match(result.campaigns[0].endDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('29CM 계획: 옵션 선택 전에는 승인 요청, 고른 optionId만 신청 계획, 이미 신청·여성 전용은 건너뛴다', async t => {
  const details = { [KEY]: optionDetail(), [KEY2]: optionDetail(KEY2, { isUserApplied: true }), PE_womenaaaaaaa: optionDetail('PE_womenaaaaaaa', { itemId: 9 }) };
  const { tab } = installPage(t, { route: cmRoute({ details, categories: { 9: [['여성의류', '스커트']] } }) });
  const client = await started(new TwentyNineClient(tab, config));
  const campaign = { id: KEY, brand: '브랜드', title: '브랜드 슬라우치 비니', url: `https://www.29cm.co.kr/preuser/event/${KEY}` };
  const review = await client.plan(campaign);
  assert.equal(review.status, 'needs-size-review');
  assert.equal(review.review.choices.length, 3);
  assert.equal(review.category, '남성의류');
  assert.deepEqual(review.review.recommendation, { productUniqueId: '4244215', sizes: ['M', 'L'] }, '프로필 사이즈를 추천으로 표시한다');
  const planned = await client.plan(campaign, { productUniqueId: '4244215', optionNo: 102 });
  assert.deepEqual([planned.status, planned.optionNo, planned.steps], ['planned', 102, ['grey', 'L']]);
  assert.equal((await client.plan(campaign, { productUniqueId: '4244215', optionNo: 999 })).status, 'needs-size-review', '사라진 옵션은 다시 묻는다');
  assert.equal((await client.plan({ ...campaign, id: KEY2 })).status, 'already-applied');
  assert.deepEqual(await client.plan({ ...campaign, id: 'PE_womenaaaaaaa' }), { status: 'skipped', reason: '여성 상품 제외', category: '여성의류' });
});

test('29CM 신청은 기본 배송지와 선택 optionId로 앱과 같은 요청을 보내고 주소·토큰은 결과에 남기지 않는다', async t => {
  let applied = false;
  const cookie = 'x-device-id=device-1; access_token=SECRET_ACCESS_TOKEN; other=1';
  const { tab, calls } = installPage(t, { cookie, route: cmRoute({
    details: { [KEY]: () => optionDetail(KEY, { isUserApplied: applied }) },
    addresses: [address({ id: 1, isPrimary: false, receiverName: '다른 사람' }), address()],
    apply: async () => { applied = true; return [200, { meta: { result: 'SUCCESS' }, data: { preuserEventApplicantKey: 'PA_1' } }]; } }) });
  const client = await started(new TwentyNineClient(tab, config));
  const plan = await client.plan({ id: KEY, brand: '브랜드', title: '비니' }, { productUniqueId: '4244215', optionNo: 101 });
  await client.prepare(plan);
  const receipt = await client.submit(plan);
  const post = calls.find(call => call.method === 'POST');
  assert.equal(post.url, `https://preuser-api.29cm.co.kr/api/v4/preuser/events/${KEY}/apply`);
  assert.deepEqual(post.body, { itemId: 4244215, optionId: 101, addressName: '집', receiverName: '홍길동',
    receiverZipcode: '04790', receiverPhone: '010-0000-0000', receiverAdditionalPhone: null,
    receiverAddress: '서울 성동구 아차산로13길 11', receiverDetailAddress: '1층', etcMessage: '부재시 문앞에 놓아주세요.',
    isNewDeliveryAddress: false });
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.equal(post.headers.Authorization, 'Bearer SECRET_ACCESS_TOKEN');
  assert.deepEqual(Object.keys(receipt), ['confirmedAt']);
  assert.doesNotMatch(JSON.stringify(receipt), /홍길동|010|아차산|SECRET/);
  // 같은 준비로 두 번 제출하지 않는다.
  await assert.rejects(client.submit(plan), /신청 준비/);
});

test('29CM 옵션 없는 상품은 optionId 없이 신청하고, 기본 배송지가 없으면 요청 전에 멈춘다', async t => {
  const noOption = optionDetail(KEY, { itemOptionType: 'NO_OPTION', itemOptionTreeNode: null });
  let addresses = [address({ isPrimary: false })];
  const { tab, calls } = installPage(t, { route: cmRoute({ details: { [KEY]: noOption }, addresses: () => addresses,
    apply: async () => [200, { meta: { result: 'SUCCESS' }, data: { preuserEventApplicantKey: 'PA_2' } }] }) });
  const client = await started(new TwentyNineClient(tab, config));
  const plan = await client.plan({ id: KEY, brand: '', title: '비니' }, { productUniqueId: '4244215', optionNo: 4244215 });
  await assert.rejects(client.prepare(plan), error => error.code === 'address-required' && error.fatal);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  addresses = [address()];
  await client.prepare(plan); await client.submit(plan);
  assert.equal('optionId' in calls.find(call => call.method === 'POST').body, false);
});

test('29CM 로그인·필수 동의가 없으면 신청 요청을 보내지 않는다', async t => {
  const { tab, calls } = installPage(t, { route: cmRoute({ details: { [KEY]: optionDetail() }, loggedIn: false }) });
  const client = await started(new TwentyNineClient(tab, config, { settleMs: 1 }));
  const plan = await client.plan({ id: KEY, brand: '', title: '비니' }, { productUniqueId: '4244215', optionNo: 101 });
  await assert.rejects(client.prepare(plan), error => error.code === 'login-required' && error.fatal);
  const { tab: tab2, calls: calls2 } = installPage(t, { route: cmRoute({ details: { [KEY]: optionDetail() }, addresses: [address()] }) });
  await assert.rejects(new TwentyNineClient(tab2, { ...config, acceptedConsentIds: [] }).prepare(plan), /acceptedConsentIds/);
  assert.equal([...calls, ...calls2].filter(call => call.method === 'POST').length, 0);
});

test('29CM가 신청을 거절하면 불확실로 막지 않고, 응답이 끊기면 결과 불확실로 남겨 재제출하지 않는다', async t => {
  let mode = 'reject';
  const { tab } = installPage(t, { route: cmRoute({ details: { [KEY]: optionDetail() }, addresses: [address()],
    apply: async () => mode === 'reject' ? [400, { meta: { result: 'FAIL', errorCode: 'X', message: '신청할 수 없는 이벤트입니다.' } }] : [0] }) });
  const client = await started(new TwentyNineClient(tab, config));
  const plan = await client.plan({ id: KEY, brand: '', title: '비니' }, { productUniqueId: '4244215', optionNo: 101 });
  await client.prepare(plan);
  await assert.rejects(client.submit(plan), error => error.notSubmitted === true && error.code === 'apply-rejected'
    && /신청할 수 없는 이벤트/.test(error.message));
  mode = 'network';
  await client.prepare(plan);
  await assert.rejects(client.submit(plan), error => error.code === 'uncertain' && !error.notSubmitted);
});

test('29CM 봇: 전용 채널에 29CM 승인 알림을 보내고 버튼 승인 후 신청, 거절된 신청은 다시 알릴 수 있게 닫는다', async t => {
  const dir = await temporary(t), fixture = fakeApp();
  let reject = false;
  const { tab } = installPage(t, { route: cmRoute({
    pages: [[listItem(KEY, '슬라우치 비니', DAY)]], details: { [KEY]: optionDetail() }, addresses: [address()],
    apply: async () => reject ? [400, { meta: { result: 'FAIL', message: '이미 마감되었습니다.' } }]
      : [200, { meta: { result: 'SUCCESS' }, data: { preuserEventApplicantKey: 'PA_3' } }] }) });
  const controller = new SlackApprovalController(dir, { env, ...fixture, platform: PLATFORMS['29cm'], log: () => {} });
  await controller.start(); controller.beginCycle();
  const client = new TwentyNineClient(tab, config);
  const store = await new StateStore(dir).load();
  await runCycle({ client, store, config, submit: true, approvalGate: controller });
  const payload = fixture.posts[0];
  assert.equal(payload.blocks[0].text.text, '━━ 29CM 체험단 · 남성의류 ━━');
  assert.match(payload.blocks.at(-2).text.text, new RegExp(`https://www\\.29cm\\.co\\.kr/preuser/event/${KEY}`));
  assert.equal(payload.blocks.filter(b => b.type === 'actions').flatMap(b => b.elements).length, 4, '옵션 3개 + 거절');
  assert.equal(store.get(KEY).status, 'approval-pending');
  reject = true;
  await click(fixture, payload, 1);
  await runCycle({ client, store, config, submit: true, approvalGate: controller, approvedOnly: true });
  assert.equal(store.get(KEY).status, 'apply-rejected');
  assert.equal(store.blocks(KEY), false);
  const [request] = await new ApprovalStore(dir).list();
  assert.equal(request.status, 'stale', '같은 공고는 다음 정기 알림에서 새로 확인한다');
  assert.match(fixture.posts.at(-1).text, /이미 마감되었습니다/);
});

// ---------------------------------------------------------------- 4910

const goodsItem = (sno, goodsSno, name, extra = {}) => ({ preuser_goods_sno: sno, capacity: 10, entered_count: 3,
  recruit_finished_at: new Date(Date.now() + DAY).toISOString(),
  goods: { sno: goodsSno, item: { sno: goodsSno }, render: { data: { name, market_name: '마켓', image: { url: 'x', ratio: 1 } } } }, ...extra });
const goodsDetail = (sno, goodsSno, extra = {}, participation = {}) => ({ preuser_goods_sno: sno, status: 2, capacity: 10,
  recruit_started_at: new Date(Date.now() - DAY).toISOString(), recruit_finished_at: new Date(Date.now() + DAY).toISOString(),
  goods: { sno: goodsSno, name: '와이드 슬랙스', market: { sno: 1, name: '마켓' } },
  participation_status: { is_enterable: true, is_entered: false, entered_count: 3, ...participation }, ...extra });

function ablyRoute({ pages = [], details = {}, entered = [], member = true, enter } = {}) {
  return async (url, call) => {
    assert.equal(url.hostname, 'api.a-bly.com');
    if (url.pathname === '/aglo/api/preuser-goods/') {
      const last = url.searchParams.get('last_sno'), index = last ? pages.findIndex(page => page.at(-1)?.preuser_goods_sno === Number(last)) + 1 : 0;
      const list = pages[index] ?? [];
      return [200, { total_count: 0, preuser_goods_list: list, last_sno: index < pages.length - 1 ? list.at(-1).preuser_goods_sno : null }];
    }
    if (url.pathname === '/aglo/api/preuser/participants/me/participations/') {
      if (!call.headers.Authorization) return [401, { message: '로그인이나 회원가입이 필요해요' }];
      return [200, { participation_list: entered.map((sno, i) => ({ sno: i + 1 })) }];
    }
    const enterMatch = /^\/aglo\/api\/preuser-goods\/(\d+)\/participants\/enter\/$/.exec(url.pathname);
    if (enterMatch && call.method === 'POST') return enter(Number(enterMatch[1]), call);
    const detail = details[url.pathname.split('/').at(-2)];
    return detail ? [200, typeof detail === 'function' ? detail() : detail] : [404, { detail: 'not found' }];
  };
}

test('4910 목록은 패션 스태프 상품을 last_sno로 이어 읽고 공고 주소를 만든다', async t => {
  const { tab } = installPage(t, { route: ablyRoute({ pages: [[goodsItem(11, 501, '와이드 슬랙스'), goodsItem(12, 502, '키즈 맨투맨')], [goodsItem(13, 503, '니트')]] }) });
  const result = await new FourNineTenClient(tab, config).scan();
  assert.deepEqual(result.campaigns.map(c => [c.id, c.title, c.url]), [
    ['11', '마켓 와이드 슬랙스', 'https://4910.kr/preuser/goods/501?preuser_goods_sno=11'],
    ['13', '마켓 니트', 'https://4910.kr/preuser/goods/503?preuser_goods_sno=13']]);
  assert.equal(result.complete, true);
});

test('4910 계획: 승인 버튼 하나로 묻고, 이미 신청·모집 종료·신청 불가 상품은 건너뛴다', async t => {
  const { tab } = installPage(t, { route: ablyRoute({ details: { 11: goodsDetail(11, 501), 12: goodsDetail(12, 502, {}, { is_entered: true }),
    13: goodsDetail(13, 503, { status: 3 }), 14: goodsDetail(14, 504, {}, { is_enterable: false }) } }) });
  const client = await started(new FourNineTenClient(tab, config));
  const campaign = { id: '11', brand: '마켓', title: '마켓 와이드 슬랙스', url: 'https://4910.kr/preuser/goods/501?preuser_goods_sno=11' };
  const review = await client.plan(campaign);
  assert.equal(review.status, 'needs-size-review');
  assert.deepEqual(review.review.choices.map(c => [c.productUniqueId, c.optionNo, c.steps]), [['501', 11, ['NONE']]]);
  assert.match(review.reason, new RegExp(`${MIN_ENTRIES}개 이상`));
  assert.equal((await client.plan(campaign, { productUniqueId: '501', optionNo: 11 })).status, 'planned');
  assert.equal((await client.plan({ ...campaign, id: '12' })).status, 'already-applied');
  assert.equal((await client.plan({ ...campaign, id: '13' })).status, 'skipped');
  assert.equal((await client.plan({ ...campaign, id: '14' })).status, 'skipped');
});

test('4910 신청은 로그인 토큰을 사이트와 같은 헤더로만 쓰고 신청 수와 최소 5개 조건을 알려 준다', async t => {
  let entered = false;
  const cookie = 'ably-anonymous-token=ANON; ably-jwt-token=SECRET_JWT; HTTP_X_DEVICE_ID=dev-9';
  const { tab, calls } = installPage(t, { cookie, route: ablyRoute({ details: { 11: () => goodsDetail(11, 501, {}, { is_entered: entered }) },
    entered: [1, 2, 3], enter: async () => { entered = true; return [201, {}]; } }) });
  const client = await started(new FourNineTenClient(tab, config));
  const plan = await client.plan({ id: '11', brand: '', title: '슬랙스' }, { productUniqueId: '501', optionNo: 11 });
  await client.prepare(plan);
  const receipt = await client.submit(plan);
  const post = calls.find(call => call.method === 'POST');
  assert.equal(post.url, 'https://api.a-bly.com/aglo/api/preuser-goods/11/participants/enter/');
  assert.deepEqual(post.headers, { 'X-Device-Type': 'PCWeb', 'X-App-Version': '0.1.0', 'X-App-Type': 'AGLO',
    Authorization: 'JWT SECRET_JWT', 'X-Device-Id': 'dev-9' });
  assert.equal(post.body, undefined);
  assert.equal(receipt.enteredCount, 3);
  assert.equal(receipt.note, '이번 모집 신청 3개 · 2개 더 신청해야 당첨 대상입니다.');
  assert.doesNotMatch(JSON.stringify(receipt), /SECRET/);
});

test('4910은 로그인하지 않았으면 신청하지 않고, 거절 응답은 미신청으로 구분한다', async t => {
  const { tab, calls } = installPage(t, { cookie: 'ably-anonymous-token=ANON', route: ablyRoute({ details: { 11: goodsDetail(11, 501) } }) });
  const client = await started(new FourNineTenClient(tab, config));
  const plan = await client.plan({ id: '11', brand: '', title: '슬랙스' }, { productUniqueId: '501', optionNo: 11 });
  await assert.rejects(client.prepare(plan), error => error.code === 'login-required' && error.fatal);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  const { tab: tab2 } = installPage(t, { cookie: 'ably-jwt-token=JWT', route: ablyRoute({ details: { 11: goodsDetail(11, 501) },
    enter: async () => [400, { message: '신청 가능 횟수를 초과했어요' }] }) });
  const client2 = new FourNineTenClient(tab2, config);
  await client2.prepare(plan);
  await assert.rejects(client2.submit(plan), error => error.notSubmitted === true && /신청 가능 횟수를 초과/.test(error.message));
});

test('4910 봇: 옵션 없음 승인 알림 → 승인 → 신청 완료 스레드에 신청 개수를 함께 남긴다', async t => {
  const dir = await temporary(t), fixture = fakeApp();
  let entered = false;
  const { tab } = installPage(t, { cookie: 'ably-jwt-token=JWT', route: ablyRoute({ pages: [[goodsItem(11, 501, '와이드 슬랙스')]],
    details: { 11: () => goodsDetail(11, 501, {}, { is_entered: entered }) }, entered: [1, 2, 3, 4, 5],
    enter: async () => { entered = true; return [200, {}]; } }) });
  const controller = new SlackApprovalController(dir, { env, ...fixture, platform: PLATFORMS['4910'], log: () => {} });
  await controller.start(); controller.beginCycle();
  const client = new FourNineTenClient(tab, config), store = await new StateStore(dir).load();
  await runCycle({ client, store, config, submit: true, approvalGate: controller });
  const payload = fixture.posts[0];
  assert.equal(payload.blocks[0].text.text, '━━ 4910 체험단 ━━');
  assert.match(payload.blocks[1].text.text, /옵션 없음 · 승인하면 신청/);
  await click(fixture, payload, 0);
  await runCycle({ client, store, config, submit: true, approvalGate: controller, approvedOnly: true });
  assert.equal(store.get('11').status, 'submitted');
  assert.match(fixture.posts.at(-1).text, /신청 완료를 확인했습니다\.\n이번 모집 신청 5개 \(5개 이상 충족\)/);
  assert.equal(store.get('11').note, undefined, '스레드 안내 문구는 기록에 넣지 않는다');
  // 같은 상품은 다시 신청하지 않는다.
  await runCycle({ client, store, config, submit: true, approvalGate: controller });
  assert.equal(fixture.posts.filter(p => p.blocks).length, 1);
});

test('무신사 승인 알림 형식은 그대로 유지한다', () => {
  const request = { id: '00000000-0000-0000-0000-000000000000', uiRevision: '00000000-0000-0000-0000-000000000001',
    status: 'pending', binding, campaign: { id: '49592', title: '고체가글 체험단 30명 모집', category: 'BEAUTY', url: 'https://www.musinsa.com/preuser/events/49592' },
    choices: [{ productUniqueId: '1', optionNo: 1, selectedSize: 'NONE', productName: '고체가글', steps: ['NONE'] }] };
  const payload = approvalPayload(request);
  assert.equal(payload.blocks[0].text.text, '━━ 체험단 #49592 · 뷰티 ━━');
  assert.equal(payload.text, '체험단 #49592 · 고체가글');
  assert.match(payload.blocks.at(-2).text.text, /musinsa\.com\/preuser\/events\/49592/);
});

test('29CM 추천 사이즈는 프로필의 상의·하의·신발 사이즈와 정확히 같은 옵션 값만 고른다', () => {
  const choice = (...steps) => ({ productUniqueId: '1', optionNo: 1, selectedSize: steps.at(-1), productName: '상품', steps });
  const choices = [choice('grey', 'S'), choice('grey', 'M'), choice('black', 'XL'), choice('28'), choice('29'), choice('260mm'), choice('M(95)'), choice('FREE')];
  assert.deepEqual(profileSizes(choices, config.profile), ['M', '29', '260mm']);
  assert.deepEqual(profileSizes(choices, undefined), []);
});
