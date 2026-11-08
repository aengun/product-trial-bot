import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, CONSENTS } from '../src/config.js';
import { MusinsaClient } from '../src/browser.js';
import { OrcaTab, runOrca } from '../src/orca.js';
import { StateStore } from '../src/store.js';
import { runCycle } from '../src/runner.js';
import { SlackApprovalController } from '../src/slack-control.js';

// Orca 내장 브라우저에 시험용 탭을 열어 로컬 시험 서버로 검증합니다. 무신사에는 접속하지 않습니다.
// 실행: npm run test:orca (Orca 앱이 켜져 있어야 합니다)
const enabled = process.env.ORCA_BROWSER_TEST === '1';
const skip = enabled ? false : 'Orca 내장 브라우저 시험은 npm run test:orca로 실행합니다.';
let server, tab, origin, submissions = 0;
// 사이즈: [총장, 가슴단면]. 실측 API와 상품 페이지 표를 같은 값으로 만듭니다.
const tables = { clear: { M: [67, 54], L: [71, 60] }, close: { M: [67, 54], L: [69, 56] } };
const tableHtml = t => '<table><thead><tr><th>사이즈</th><th>총장</th><th>가슴단면</th></tr></thead><tbody>'
  + Object.entries(t).map(([size, [length, chest]]) => `<tr><td>${size}</td><td>${length}</td><td>${chest}</td></tr>`).join('') + '</tbody></table>';
const tableApi = t => ({ typeName: '셔츠', sizes: Object.entries(t).map(([name, [length, chest]], sequence) => ({ name, sequence,
  items: [{ name: '총장', value: length, sequence: 1 }, { name: '어깨너비', value: 0, sequence: 2 }, { name: '가슴단면', value: chest, sequence: 3 }] })) });
let table = tables.clear, alertOnApply = false, sizeApiDown = false, sizeApiCalls = 0, productPageViews = 0;
const profile = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8')).profile;
const product = { uniqueId: '100', name: '블랙 셔츠', isRepresentative: true,
  optionItems: ['블랙', '화이트'].flatMap((color, colorIndex) => ['M', 'L'].map((size, i) => ({ no: 77 + colorIndex * 2 + i, activated: true, outOfStock: false,
    optionValues: [{ name: color, optionName: '컬러' }, { name: size, optionName: '사이즈' }] }))) };
const detail = { eventId: 1, name: '블랙 셔츠 체험단', eventCategory: 'TOP', state: 'OPEN', isRegistration: false, products: [product] };
const html = body => `<!doctype html><html lang="ko"><meta charset="utf-8"><body>${body}</body></html>`;
const eventPage = html(`<button data-rosetta-id="4038" onclick="show()">신청하기</button><div id="options"></div>
<script>
const choices = {};
function show() {
 document.querySelector('#options').innerHTML = ['컬러', '사이즈'].map((s,i) => '<div class="sc-5cef0ce0-1" onclick="expand(this,'+i+')">'+s+'</div>').join('') + '<button disabled id="next" onclick="next()">선택 완료</button>';
}
function expand(box, i) {
 document.querySelectorAll('ul').forEach(e => e.remove());
 const ul=document.createElement('ul'); ul.className='sc-5cef0ce0-2';
 (i===0?['블랙','화이트']:['M','L']).forEach(value => {
  const li=document.createElement('li'); li.textContent=value;
  li.onclick=()=>{choices[i]=value; box.textContent=value; ul.remove(); document.querySelector('#next').disabled=Object.keys(choices).length!==2;};
  ul.append(li);
 }); box.after(ul);
}
function next() {
 localStorage.setItem('PREUSER-EVENT-OPTION-DATA', JSON.stringify({productUniqueId:'100',productOptionNo:77+(choices[0]==='화이트'?2:0)+(choices[1]==='M'?0:1)}));
 location.href='/preuser/apply/1';
}
</script>`);
// 실제 신청서처럼 동의 항목은 <button role="checkbox" aria-checked> 형태입니다.
const consentBox = (id, text) => `<div><button type="button" role="checkbox" aria-checked="false" data-state="unchecked" id="${id}" style="width:16px;height:16px"></button><label for="${id}">${text}</label></div>`;
const applyPage = html(consentBox('all', '전체 동의하기') + Object.entries(CONSENTS).map(([id, text]) => consentBox(id, text)).join('')
  + `<button id="send" disabled>신청 완료</button><div id="result"></div>
<script>
const boxes = [...document.querySelectorAll('[role="checkbox"]')];
const set = (e, on) => { e.setAttribute('aria-checked', String(on)); e.dataset.state = on ? 'checked' : 'unchecked'; };
boxes.forEach(e => e.onclick = () => {
 set(e, e.getAttribute('aria-checked') !== 'true');
 if (e.id === 'all') boxes.forEach(b => set(b, e.getAttribute('aria-checked') === 'true'));
 document.querySelector('#send').disabled = boxes.some(b => b.id !== 'all' && b.getAttribute('aria-checked') !== 'true');
});
document.querySelector('#send').onclick=async()=>{await fetch('/registration',{method:'POST'}); document.querySelector('#result').textContent='신청이 완료되었습니다.';};
</script>`);

before(async () => {
  if (!enabled) return;
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data })); };
    if (url.pathname === '/api/member/v1/login-status') return json({ loggedIn: true });
    if (url.pathname === '/preuser/api/v1/event/filters') return json({ categories: [{ id: 'TOP', description: '상의' }] });
    if (url.pathname === '/preuser/api/v1/event/events') return json({ content: [{ id: 1, name: detail.name, brand: { name: '테스트' }, state: 'OPEN' }], hasNext: false });
    if (url.pathname === '/preuser/api/v1/event/events/1') return json(detail);
    if (url.pathname === '/registration') { submissions++; return json({ ok: true }); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/preuser/events/1') return res.end(alertOnApply ? eventPage.replace('onclick="show()"', 'onclick="alert(\'등급 조건을 확인하세요\')"') : eventPage);
    if (url.pathname === '/preuser/apply/1') return res.end(applyPage);
    if (url.pathname === '/api2/goods/100/actual-size') {
      sizeApiCalls++;
      if (sizeApiDown) { res.statusCode = 503; return res.end('{}'); }
      return json(tableApi(table));
    }
    if (url.pathname === '/products/100') { productPageViews++; return res.end(html(tableHtml(table))); }
    return res.end(html('체험단 둘러보기'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const created = await runOrca(['tab', 'create', '--url', `${origin}/preuser/main`]);
  tab = new OrcaTab(created.browserPageId);
});
after(async () => {
  if (!enabled) return;
  await tab?.close().catch(() => {});
  await new Promise(resolve => server?.close(resolve));
});

async function setup(t, consents = true, sizeTable = tables.clear) {
  submissions = 0; table = sizeTable; sizeApiDown = false; sizeApiCalls = 0; productPageViews = 0;
  await tab.goto(`${origin}/preuser/main`);
  await tab.evaluate(() => localStorage.clear());
  const dir = await mkdtemp(join(tmpdir(), 'musinsa-browser-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = validateConfig({ profile, categories: ['상의'], maxApplicationsPerRun: 1, timeoutMs: 2000,
    acceptedConsentIds: consents ? Object.keys(CONSENTS) : [] });
  const client = new MusinsaClient(tab, config, { origin });
  await client.start();
  return { client, config, store: await new StateStore(dir).load() };
}

test('Orca 탭에서 수집→실측 비교→옵션→신청서→제출 확인, 이후 중복 방지', { skip }, async t => {
  const setupResult = await setup(t);
  const preview = await runCycle(setupResult);
  assert.deepEqual(preview.results[0].steps, ['블랙', 'M']);
  assert.equal(submissions, 0);
  assert.equal(sizeApiCalls, 1); assert.equal(productPageViews, 0, '실측은 API로 읽고 상품 페이지는 열지 않는다');
  const result = await runCycle({ ...setupResult, submit: true });
  assert.equal(result.results[0].status, 'submitted');
  assert.equal(submissions, 1);
  await runCycle({ ...setupResult, submit: true });
  assert.equal(submissions, 1);
});

test('필수 동의를 설정하지 않으면 Orca 탭에서도 제출되지 않는다', { skip }, async t => {
  const s = await setup(t, false);
  await assert.rejects(runCycle({ ...s, submit: true }), /acceptedConsentIds/);
  assert.equal(submissions, 0);
  assert.equal(s.store.get('1').status, 'consent-required');
});

test('사이트가 선택한 SKU가 계획과 다르면 제출하지 않는다', { skip }, async t => {
  const s = await setup(t);
  const plan = await s.client.plan({ id: '1' });
  await assert.rejects(s.client.prepare({ ...plan, optionNo: 999 }), /계획과 일치하지/);
  assert.equal(submissions, 0);
});

test('Orca 탭에서도 애매한 M/L은 보류하고 사용자 선택 후에만 진행한다', { skip }, async t => {
  const s = await setup(t, true, tables.close);
  const pending = await runCycle({ ...s, submit: true });
  assert.equal(pending.results[0].status, 'needs-size-review');
  assert.equal(submissions, 0);
  await s.store.chooseSize('1', 'L');
  const result = await runCycle({ ...s, submit: true });
  assert.equal(result.results[0].status, 'submitted');
  assert.deepEqual(result.results[0].steps, ['블랙', 'L']);
  assert.equal(submissions, 1);
});

for (const selection of [
  { name: '슬랙 스레드의 옵션 번호만 답한 후 Orca 신청과 결과 회신까지 한 번만 처리한다', category: 'TOP', reply: '2', expected: ['블랙', 'L'] },
  { name: '조합 버튼으로 고른 색상·사이즈로 Orca 신청과 결과 회신까지 한 번만 처리한다', category: 'DIGITAL_LIFE', button: 2, expected: ['화이트', 'M'] },
]) test(selection.name, { skip }, async t => {
  const originalCategory = detail.eventCategory;
  detail.eventCategory = selection.category;
  t.after(() => { detail.eventCategory = originalCategory; });
  const s = await setup(t, true, tables.close);
  const events = {}, posts = [];
  let clock = 10000;
  const app = {
    client: { auth: { async test() { return { ok: true, team_id: 'TTEST' }; } },
      chat: { async postMessage(p) { posts.push(p); return { ok: true, channel: 'CTEST', ts: `1700000000.${String(posts.length).padStart(6, '0')}` }; }, async update() { return { ok: true }; } } },
    event(name, handler) { events[name] = handler; }, action(pattern, handler) { events.action = handler; }, error() {}, async start() {}, async stop() {},
  };
  const controller = new SlackApprovalController(s.store.directory, {
    env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test', SLACK_APPROVER_USER_ID: 'UTEST', SLACK_CHANNEL_ID: 'CTEST' },
    appFactory: () => app, now: () => clock, wait: async ms => { clock += ms; }, log: () => {},
  });
  await controller.start(); controller.beginCycle(); t.after(() => controller.stop());
  const pending = await runCycle({ ...s, submit: true, approvalGate: controller });
  assert.equal(pending.results[0].status, 'approval-pending'); assert.equal(submissions, 0);
  const reply = { type: 'message', user: 'UTEST', channel: 'CTEST', ts: '1700000001.000001', thread_ts: '1700000000.000001', text: selection.reply };
  await events.message({ event: { ...reply, user: 'UOTHER' }, body: { event_id: 'EvOther', team_id: 'TTEST' } });
  assert.equal(await controller.decision('1'), null);
  let click;
  if (selection.button !== undefined) {
    const buttons = posts[0].blocks.filter(b => b.type === 'actions').flatMap(b => b.elements);
    assert.equal(buttons.length, 4);
    click = { body: { type: 'block_actions', user: { id: 'UTEST' }, team: { id: 'TTEST' }, channel: { id: 'CTEST' }, message: { ts: reply.thread_ts } },
      action: { ...buttons[selection.button], action_ts: reply.ts } };
    let acked = false;
    await events.action({ ...click, ack: async () => { acked = true; } }); assert.equal(acked, true);
  } else await events.message({ event: reply, body: { event_id: 'EvApproved', team_id: 'TTEST' } });
  const result = await runCycle({ ...s, submit: true, approvalGate: controller });
  assert.equal(result.results[0].status, 'submitted');
  assert.deepEqual(result.results[0].steps, selection.expected); assert.equal(submissions, 1);
  assert.match(posts.at(-1).text, /신청 완료/); assert.equal(posts.at(-1).thread_ts, reply.thread_ts);
  if (click) await events.action({ ...click, ack: async () => {} });
  else await events.message({ event: reply, body: { event_id: 'EvApproved', team_id: 'TTEST' } });
  await runCycle({ ...s, submit: true, approvalGate: controller }); assert.equal(submissions, 1);
});

test('신청 버튼이 사이트 알림창을 띄우면 닫고 그 공고만 중단한다', { skip }, async t => {
  const s = await setup(t);
  alertOnApply = true; t.after(() => { alertOnApply = false; });
  const plan = await s.client.plan({ id: '1' });
  await assert.rejects(s.client.prepare(plan), error => error.code === 'dialog' && !error.fatal);
  assert.equal(submissions, 0);
  assert.match(await tab.url(), /\/preuser\/events\/1$/);
});

test('실측 API를 읽지 못하면 상품 페이지 실측표로 대신 판단한다', { skip }, async t => {
  const s = await setup(t);
  sizeApiDown = true;
  const preview = await runCycle(s);
  assert.equal(preview.results[0].status, 'planned');
  assert.deepEqual(preview.results[0].steps, ['블랙', 'M']);
  assert.equal(productPageViews, 1);
  assert.equal(submissions, 0);
});
