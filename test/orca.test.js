import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrcaTab, OrcaError, openBotTab } from '../src/orca.js';

function fakeOrca(handlers) {
  const calls = [];
  const run = async args => {
    calls.push(args);
    const handler = handlers[args[0] === 'tab' || args[0] === 'dialog' ? `${args[0]} ${args[1]}` : args[0]];
    if (!handler) throw new Error(`unexpected orca ${args.join(' ')}`);
    return handler(args);
  };
  return { run, calls };
}

test('eval은 페이지 함수와 인자를 넘기고 JSON 결과를 되돌린다', async () => {
  const { run, calls } = fakeOrca({ eval: args => {
    const expression = args[args.indexOf('--expression') + 1];
    assert.match(expression, /\{"path":"\/x"\}/);
    return { result: '{"ok":true}' };
  } });
  const tab = new OrcaTab('P1', { run });
  assert.deepEqual(await tab.evaluate(({ path }) => ({ ok: path === '/x' }), { path: '/x' }), { ok: true });
  assert.deepEqual(calls[0].slice(0, 3), ['eval', '--page', 'P1']);
});

test('사이트 알림창은 자동 승인하지 않고 닫은 뒤 dialog 오류로 알린다', async () => {
  const { run, calls } = fakeOrca({
    click: () => { throw new OrcaError('browser_dialog_opened', 'The page opened a JavaScript alert: "개인 정보"'); },
    'dialog dismiss': () => ({ accepted: false }),
  });
  const tab = new OrcaTab('P1', { run });
  await assert.rejects(tab.click('#apply'), error => error.code === 'dialog' && !error.message.includes('개인 정보'));
  assert.deepEqual(calls.at(-1), ['dialog', 'dismiss', '--page', 'P1']);
  assert.ok(!calls.some(c => c[0] === 'dialog' && c[1] === 'accept'));
});

test('Orca가 입력을 보내지 않은 클릭만 다시 시도하고, 두 번째 실패 후에는 탭을 앞으로 띄운다', async () => {
  let clicks = 0;
  const notSent = new OrcaError('browser_error', "orca click 실패: CDP error (Input.dispatchMouseEvent): Orca could not protect the user's keyboard focus for this page, so the input was not sent. Retry, or show the page first.");
  const { run, calls } = fakeOrca({
    click: () => { if (++clicks <= 2) throw notSent; return { clicked: '#x' }; },
    'tab switch': () => ({}),
  });
  await new OrcaTab('P1', { run, pollMs: 1 }).click('#x');
  assert.equal(clicks, 3);
  assert.deepEqual(calls.map(c => c[0] === 'tab' ? `tab ${c[1]}` : c[0]), ['click', 'click', 'tab switch', 'click']);
  let blocked = 0;
  const guard = fakeOrca({ click: () => { blocked++; throw notSent; }, 'tab switch': () => ({}) });
  await assert.rejects(new OrcaTab('P1', { run: guard.run, pollMs: 1 }).click('#x'), /input was not sent/);
  assert.equal(blocked, 6, '보내지 않은 클릭은 6번까지 시도한 뒤 오류로 넘긴다');
  let other = 0;
  const failing = fakeOrca({ click: () => { other++; throw new OrcaError('browser_stale_ref', 'stale'); } });
  await assert.rejects(new OrcaTab('P1', { run: failing.run, pollMs: 1 }).click('#x'), /stale/);
  assert.equal(other, 1, '입력이 갔을 수 있는 오류는 다시 누르지 않는다');
});

test('waitFor는 일시적인 실패를 다시 시도하고 기한이 지나면 timeout으로 끝난다', async () => {
  let n = 0;
  const { run } = fakeOrca({ eval: () => {
    n++;
    if (n === 1) throw new OrcaError('browser_eval_error', 'Execution context was destroyed');
    return { result: n >= 3 ? 'true' : 'false' };
  } });
  const tab = new OrcaTab('P1', { run, pollMs: 1 });
  assert.equal(await tab.waitFor(() => true), true);
  assert.equal(n, 3);
  const never = new OrcaTab('P1', { run: fakeOrca({ eval: () => ({ result: 'null' }) }).run, pollMs: 1 });
  await assert.rejects(never.waitFor(() => false, null, { timeoutMs: 20 }), error => error.code === 'timeout');
});

test('봇 전용 탭은 저장한 탭이 남아 있으면 다시 쓰고, 없으면 새로 열어 기억한다', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'musinsa-orca-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let tabs = [];
  const { run, calls } = fakeOrca({
    'tab list': () => ({ tabs }),
    'tab create': args => { assert.equal(args[args.indexOf('--url') + 1], 'https://www.musinsa.com/preuser/main'); return { browserPageId: 'NEW1' }; },
  });
  const first = await openBotTab(dir, 'https://www.musinsa.com/preuser/main', { run });
  assert.equal(first.pageId, 'NEW1');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'orca-tab.json'), 'utf8')), { browserPageId: 'NEW1' });
  tabs = [{ browserPageId: 'OTHER', url: 'https://www.musinsa.com/' }, { browserPageId: 'NEW1', url: 'https://www.musinsa.com/preuser/main' }];
  const again = await openBotTab(dir, 'https://www.musinsa.com/preuser/main', { run });
  assert.equal(again.pageId, 'NEW1');
  assert.equal(calls.filter(c => c[1] === 'create').length, 1);
  tabs = [{ browserPageId: 'OTHER', url: 'https://www.musinsa.com/' }];
  await openBotTab(dir, 'https://www.musinsa.com/preuser/main', { run });
  assert.equal(calls.filter(c => c[1] === 'create').length, 2, '사용자의 다른 무신사 탭은 가져다 쓰지 않는다');
});

test('봇은 Orca 내장 브라우저만 쓰고 Playwright·Chrome을 띄우지 않는다', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!('playwright' in (pkg.dependencies ?? {})) && !('playwright' in (pkg.devDependencies ?? {})));
  const dir = new URL('../src/', import.meta.url);
  const files = (await readdir(dir, { recursive: true })).filter(file => file.endsWith('.js'));
  assert.ok(files.some(file => file.startsWith('sites')), '플랫폼별 사이트 코드도 검사한다');
  for (const file of files) {
    const source = await readFile(new URL(file, dir), 'utf8');
    assert.doesNotMatch(source, /from ['"]playwright|puppeteer|launchPersistentContext|remote-debugging|channel:\s*['"]chrome/, file);
  }
});
