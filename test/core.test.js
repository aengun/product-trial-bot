import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateConfig } from '../src/config.js';
import { matchCampaign, campaignExclusionReason } from '../src/filters.js';
import { planOptions, rankTopSizes, sizeTableFromApi, representativeProduct, eventOptionChoices } from '../src/sizing.js';
import { validChoice } from '../src/approvals.js';
import { StateStore, acquireLock } from '../src/store.js';
import { runCycle } from '../src/runner.js';
import { MusinsaClient } from '../src/browser.js';

const profile = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8')).profile;
const config = validateConfig({ profile, actionDelayMs: 500 });
const item = (no, size, extra = {}) => ({ no, activated: true, outOfStock: false,
  optionValues: [{ name: '블랙', optionName: '컬러' }, { name: size, optionName: '사이즈' }], ...extra });
const product = { uniqueId: '100', name: '상의', isRepresentative: true, optionItems: [item(1, 'M'), item(2, 'L')] };
const event = { eventId: 1, name: '블랙 상의', eventCategory: 'TOP', products: [product] };
const table = { headers: ['총장', '가슴단면'], rows: [
  { size: 'M', values: [66, 54] }, { size: 'L', values: [70, 59] },
] };

test('설정 오타·미등록 동의·잘못된 측정 범위를 거부한다', () => {
  assert.throws(() => validateConfig({ preferedOptions: [] }), /알 수 없는 설정/);
  assert.throws(() => validateConfig({ acceptedConsentIds: ['marketing'] }), /알 수 없는 필수 동의/);
  assert.throws(() => validateConfig({ profile: { ...profile, topFit: { ...profile.topFit, chestMin: 100 } } }), /최소값/);
  assert.throws(() => validateConfig({ maxApplicationsPerRun: 0 }), /정수/);
});

test('제외 키워드가 우선하고 브랜드는 정확히 일치해야 한다', () => {
  const c = validateConfig({ includeKeywords: ['셔츠'], excludeKeywords: ['키즈'], brands: ['브랜드'] });
  assert.equal(matchCampaign({ id: '1', brand: '브랜드', title: '셔츠' }, c), true);
  assert.equal(matchCampaign({ id: '1', brand: '브랜드', title: '키즈 셔츠' }, c), false);
  assert.equal(matchCampaign({ id: '1', brand: '브랜드 우먼', title: '셔츠' }, c), false);
});

test('남성·공용은 무신사의 M/P 성별로 수집하고 여성용 제목은 제외한다', async () => {
  const c = validateConfig({ ...JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8')), excludeCategories: [] });
  const client = new MusinsaClient({}, c);
  client.goto = async () => {};
  const queries = [];
  client.readApi = async path => {
    if (path.endsWith('/filters')) return { categories: c.categories.map((description, i) => ({ id: description === '전체' ? 'ALL' : String(i), description })) };
    const query = new URL(path, 'https://www.musinsa.com').searchParams;
    queries.push(query);
    return { content: [
      { id: 1, name: '공용 셔츠', brand: { name: '브랜드' }, state: 'OPEN' },
      { id: 2, name: '우먼스 셔츠', brand: { name: '브랜드' }, state: 'OPEN' },
      { id: 3, name: "Women's shirt", brand: { name: '브랜드' }, state: 'OPEN' },
      { id: 4, name: '여성 셔츠', brand: { name: '브랜드' }, state: 'OPEN' },
    ], hasNext: false };
  };
  const result = await client.scan();
  assert.deepEqual(result.campaigns.map(campaign => campaign.id), ['1']);
  assert.ok(queries.length > 0);
  for (const query of queries) assert.deepEqual(query.getAll('genders'), ['M', 'P']);
  for (const query of queries) assert.equal(query.has('category'), false);
});

test('공용 색조 화장품과 키즈는 제외하고 남성 화장품·일반 스킨케어·생활용품은 유지한다', () => {
  const c = validateConfig({ excludeCategories: ['키즈'], excludeFemaleCosmetics: true });
  for (const title of ['듀이 핏 틴트', '스틱 파운데이션', '3색 플럼핑 립밤', '아이섀도우 팔레트']) {
    assert.equal(matchCampaign({ title, category: '뷰티' }, c), false);
  }
  for (const title of ['남성용 파운데이션', '포맨 비비크림', '수분 세럼', '무색 보습 립밤', '바디 미스트']) {
    assert.equal(matchCampaign({ title, category: '뷰티' }, c), true);
  }
  assert.equal(matchCampaign({ title: '생활 방석 쿠션', category: '디지털/라이프' }, c), true);
  assert.equal(matchCampaign({ title: '크루 넥 긴소매 티셔츠', category: '키즈' }, c), false);
  assert.equal(campaignExclusionReason({ title: '크루 넥 긴소매 티셔츠', category: 'KIDS' }, c), '키즈 제외');
});

test('키즈 제외 단어가 브랜드명이나 성인 상품의 향 이름과 겹치지 않는다', async () => {
  const c = validateConfig(JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8')));
  assert.equal(matchCampaign({ title: '닥터유아유아 피디알엔 바운스 리턴 앰플', category: '뷰티' }, c), true);
  assert.equal(matchCampaign({ title: '베이비파우더 향 디퓨저', category: '디지털/라이프' }, c), true);
  assert.equal(matchCampaign({ title: '유아용 보습 크림', category: '뷰티' }, c), false);
});

test('전체 수집에서도 키즈 카테고리는 조회하지 않고 뷰티 공용 색조를 거른다', async () => {
  const c = validateConfig({ gender: 'M', categories: ['전체'], excludeCategories: ['키즈'], excludeFemaleCosmetics: true });
  const client = new MusinsaClient({}, c), queried = [];
  client.goto = async () => {};
  client.readApi = async path => {
    if (path.endsWith('/filters')) return { categories: [
      { id: 'ALL', description: '전체' }, { id: 'TOP', description: '상의' },
      { id: 'BEAUTY', description: '뷰티' }, { id: 'KIDS', description: '키즈' },
    ] };
    const category = new URL(path, 'https://www.musinsa.com').searchParams.get('category'); queried.push(category);
    return { content: (category === 'TOP' ? [{ id: 1, name: '남성 셔츠' }]
      : [{ id: 2, name: '틴트' }, { id: 3, name: '수분 세럼' }]).map(item => ({ ...item, state: 'OPEN' })), hasNext: false };
  };
  assert.deepEqual((await client.scan()).campaigns.map(c => c.id), ['1', '3']);
  assert.deepEqual(queried, ['TOP', 'BEAUTY']);
});

test('직접 상세 확인에도 키즈·색조 제외를 적용하고 뷰티 상품별 옵션도 필터링한다', async () => {
  const c = validateConfig({ excludeCategories: ['키즈'], excludeFemaleCosmetics: true });
  const client = new MusinsaClient({}, c);
  for (const [category, name] of [['KIDS', '크루 넥 티셔츠'], ['BEAUTY', '듀이 핏 틴트']]) {
    client.readApi = async () => ({ eventId: 1, state: 'OPEN', eventCategory: category, name, products: [product] });
    assert.equal((await client.plan({ id: '1' }, null, { allOptions: true })).status, 'skipped');
  }
  const serum = { ...product, name: '보습 세럼' }, makeup = { ...product, uniqueId: '101', name: '듀이 핏 틴트' };
  assert.deepEqual(eventOptionChoices({ ...event, eventCategory: 'BEAUTY', products: [makeup, serum] }, c).map(p => p.productUniqueId), ['100', '100']);
  assert.equal(representativeProduct({ ...event, eventCategory: 'BEAUTY', products: [makeup, serum] }, c).name, '보습 세럼');
});

test('생활용품·뷰티의 단일 옵션은 사이즈 없이도 승인 가능한 계획을 만든다', () => {
  const p = { ...product, optionItems: [{ no: 1, activated: true,
    optionValues: [{ name: '1개', optionName: '옵션' }] }] };
  const plan = planOptions({ ...event, eventCategory: 'BEAUTY', products: [p] }, p, config);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.selectionKind, 'option');
  assert.deepEqual(plan.steps, ['1개']);
  assert.equal(validChoice(plan), true);
});

test('일반 판매 중이 아니어도 모집 중이고 신청 재고가 있는 체험 상품은 확인한다', () => {
  const p = { ...product, isOnSale: false, optionItems: [{ no: 1, activated: true,
    optionValues: [{ name: '1개', optionName: '옵션' }] }] };
  const e = { ...event, state: 'OPEN', eventCategory: 'BEAUTY', products: [p] };
  assert.equal(representativeProduct(e, config), p);
  assert.equal(planOptions(e, representativeProduct(e, config), config).status, 'planned');
  assert.equal(representativeProduct({ ...e, state: 'CLOSED' }, config), undefined);
  assert.equal(representativeProduct({ ...e, products: [{ ...p, optionItems: [{ ...p.optionItems[0], outOfStock: true }] }] }, config), undefined);
});

test('여러 생활용품 옵션은 직접 선택 전까지 보류하고 선택한 SKU만 계획한다', () => {
  const p = { ...product, optionItems: ['화이트', '블랙'].map((name, i) => ({ no: i + 1,
    activated: true, optionValues: [{ name, optionName: '색상' }] })) };
  const e = { ...event, eventCategory: 'DIGITAL_LIFE', products: [p] };
  const review = planOptions(e, p, config);
  assert.equal(review.status, 'needs-size-review');
  assert.equal(review.selectionKind, 'option');
  assert.deepEqual(review.review.choices.map(c => c.choiceKey), ['옵션1', '옵션2']);
  const selected = planOptions(e, p, config, null, { productUniqueId: '100', size: '옵션2' });
  assert.equal(selected.optionNo, 2);
  assert.deepEqual(selected.steps, ['블랙']);
});

test('색상 4개와 사이즈 4개는 16개 실제 SKU로 유지하고 같은 사이즈의 색상을 합치지 않는다', () => {
  const p = { ...product, optionItems: ['헤더 그레이', '네이비', '챠콜', '블랙'].flatMap((color, i) =>
    ['SMALL', 'MEDIUM', 'LARGE', 'X-LARGE'].map((size, j) => ({ no: 100 + i * 4 + j,
      optionValues: [{ name: color, optionName: '컬러' }, { name: size, optionName: '사이즈' }] }))) };
  const e = { ...event, products: [p] }, choices = eventOptionChoices(e, config);
  assert.equal(choices.length, 16); assert.equal(new Set(choices.map(c => c.optionNo)).size, 16);
  assert.deepEqual(choices[10].steps, ['챠콜', 'LARGE']);
  const selected = planOptions(e, p, config, null, { productUniqueId: '100', optionNo: 110, size: 'LARGE' });
  assert.deepEqual(selected.steps, ['챠콜', 'LARGE']);
  assert.equal(selected.choices.length, 16);
  p.optionItems[5].outOfStock = true;
  assert.equal(eventOptionChoices(e, config).length, 15);
  const second = { ...p, uniqueId: '101', name: '다른 상품', optionItems: [p.optionItems[0]] };
  const all = eventOptionChoices({ ...e, products: [p, second] }, config);
  assert.equal(all.length, 16); assert.equal(all.at(-1).productUniqueId, '101');
});

test('공용 공고에도 여성용 상품·옵션은 신청 후보에서 제외한다', () => {
  const c = validateConfig({ profile, gender: 'M', excludeKeywords: ['여성', 'women'] });
  const p = { ...product, name: '커플 파자마', optionItems: [
    { no: 1, optionValues: [{ name: '미니 도트 (여)', optionName: '색상' }, { name: '095', optionName: '사이즈' }] },
    { no: 2, optionValues: [{ name: '미니 도트 (남)', optionName: '색상' }, { name: '100', optionName: '사이즈' }] },
  ] };
  const e = { ...event, eventCategory: 'UNDERWEAR', products: [p] };
  const plan = planOptions(e, p, c);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.optionNo, 2);
  assert.ok(plan.steps.includes('미니 도트 (남)'));
  const female = { ...p, uniqueId: '999', name: '여성용 파자마', isRepresentative: true };
  assert.equal(representativeProduct({ products: [female, { ...p, isRepresentative: false }] }, c).uniqueId, '100');
});

test('상의는 M/L 중 실측과 재고에 맞는 사이즈만 선택한다', () => {
  assert.equal(rankTopSizes(table, profile, ['M', 'L'])[0].size, 'M');
  assert.deepEqual(planOptions(event, product, config, table).steps, ['블랙', 'M']);
  const noM = { ...product, optionItems: [item(1, 'M', { outOfStock: true }), item(2, 'L')] };
  assert.deepEqual(planOptions({ ...event, products: [noM] }, noM, config, table).steps, ['블랙', 'L']);
  assert.equal(planOptions(event, product, config, null).status, 'needs-size-review');
  assert.equal(rankTopSizes({ ...table, rows: [{ size: 'M', values: [80, 70] }] }, profile, ['M']).length, 0);
});

test('품절·비활성 옵션과 신발 265는 선택하지 않는다', () => {
  const p = { ...product, optionItems: [item(1, '265'), item(2, '260mm', { activated: false }), item(3, '260')] };
  const e = { ...event, products: [p], eventCategory: 'SHOE' };
  assert.equal(planOptions(e, p, config).optionNo, 3);
  assert.equal(planOptions(e, { ...p, optionItems: [item(1, '265')] }, config).status, 'skipped');
  const pants = { ...p, optionItems: [item(4, '30')] };
  assert.equal(planOptions({ ...e, eventCategory: 'PANTS', products: [pants] }, pants, config).optionNo, 4);
});

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'musinsa-bot-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('저장 기록·중복 실행 방지 잠금은 재시작 후에도 유지된다', async t => {
  const dir = await temporary(t);
  const release = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), /다른 봇/);
  const store = await new StateStore(dir).load();
  await store.set('1', { status: 'submitting' });
  const reloaded = await new StateStore(dir).load();
  assert.equal(reloaded.blocks('1'), true);
  await release();
  const again = await acquireLock(dir); await again();
  await writeFile(join(dir, 'state.json'), '{broken');
  await assert.rejects(new StateStore(dir).load(), /신청 기록을 읽을 수 없어/);
});

function fakeClient() {
  const counts = { prepare: 0, submit: 0 };
  return { counts,
    async scan() { return { campaigns: [{ id: '1', title: '상의' }, { id: '2', title: '신발' }], complete: true }; },
    async plan(c) { return { status: 'planned', eventId: c.id, steps: ['M'] }; },
    async prepare() { counts.prepare++; },
    async submit() { counts.submit++; return { confirmedAt: new Date().toISOString() }; },
  };
}

test('미리보기는 신청 준비·제출을 호출하지 않고 실제 신청은 상한과 중복 방지를 지킨다', async t => {
  const store = await new StateStore(await temporary(t)).load();
  const client = fakeClient(), c = { ...config, maxApplicationsPerRun: 1 };
  await runCycle({ client, store, config: c });
  assert.deepEqual(client.counts, { prepare: 0, submit: 0 });
  await runCycle({ client, store, config: c, submit: true });
  assert.deepEqual(client.counts, { prepare: 1, submit: 1 });
  await runCycle({ client, store, config: c, submit: true });
  assert.deepEqual(client.counts, { prepare: 2, submit: 2 });
  await runCycle({ client, store, config: c, submit: true });
  assert.deepEqual(client.counts, { prepare: 2, submit: 2 });
});

test('제출 응답 유실은 uncertain으로 남아 재실행·재시작에도 재제출하지 않는다', async t => {
  const dir = await temporary(t), store = await new StateStore(dir).load();
  const client = fakeClient();
  client.scan = async () => ({ campaigns: [{ id: '1', title: '상의' }], complete: true });
  client.submit = async () => { client.counts.submit++; throw new Error('connection lost'); };
  await assert.rejects(runCycle({ client, store, config, submit: true }), /제출 결과를 확인하지 못/);
  assert.equal(store.get('1').status, 'uncertain');
  await runCycle({ client, store: await new StateStore(dir).load(), config, submit: true });
  assert.equal(client.counts.submit, 1);
});

test('실측 API 응답을 실측표 형태로 바꾸고 0(미측정)과 낯선 형식은 판단에 쓰지 않는다', () => {
  const item = (name, value, sequence) => ({ name, value, sequence, recommendSizeRange: 2 });
  const data = { typeName: '긴소매티셔츠', sizes: [
    { name: 'L', sequence: 1, items: [item('가슴단면', 60, 3), item('총장', 71, 1), item('어깨너비', 0, 2)] },
    { name: ' M ', sequence: 0, items: [item('총장', 67, 1), item('어깨너비', 45.5, 2), item('가슴단면', 54, 3)] },
  ] };
  assert.deepEqual(sizeTableFromApi(data), { headers: ['총장', '어깨너비', '가슴단면'], rows: [
    { size: 'M', values: [67, 45.5, 54] }, { size: 'L', values: [71, null, 60] }] });
  assert.equal(rankTopSizes(sizeTableFromApi(data), profile, ['M', 'L'])[0].size, 'M');
  assert.equal(sizeTableFromApi({ sizes: [] }), null);
  assert.equal(sizeTableFromApi({ sizes: [{ name: 'M', sequence: 0, items: [item('총장', 67, 1)] }] }), null, '가슴단면이 없으면 판단하지 않는다');
  assert.equal(sizeTableFromApi({ sizes: [{ name: 'M', items: 'x' }] }), null);
  assert.equal(sizeTableFromApi(null), null);
});
