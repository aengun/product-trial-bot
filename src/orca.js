// Orca 내장 브라우저 탭을 `orca` CLI로 다룹니다. Chrome이나 별도 브라우저를 띄우지 않습니다.
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class OrcaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const DIALOG_CODES = new Set(['browser_dialog_opened', 'browser_dialog_open']);

export function runOrca(args, { signal, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.env.ORCA_BIN || 'orca', [...args, '--json'], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, signal }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') return reject(new OrcaError('orca-missing', 'orca 명령을 찾지 못했습니다. Orca 앱 안의 터미널에서 실행하세요.'));
      if (error?.name === 'AbortError') return reject(error);
      let parsed;
      try { parsed = JSON.parse(stdout); } catch {
        const reason = error?.killed ? '시간 초과' : (stderr || error?.message || '응답 없음').trim().split('\n')[0];
        return reject(new OrcaError('orca-failed', `orca ${args[0]} 실패: ${reason}`));
      }
      if (!parsed.ok) return reject(new OrcaError(parsed.error?.code ?? 'orca-failed', `orca ${args[0]} 실패: ${parsed.error?.message ?? '알 수 없는 오류'}`));
      resolve(parsed.result);
    });
  });
}

/** browserPageId 하나에 고정한 Orca 탭. 페이지 안에서 도는 함수는 바깥 변수를 참조하면 안 됩니다. */
export class OrcaTab {
  constructor(pageId, { run = runOrca, signal, pollMs = 250 } = {}) {
    this.pageId = pageId; this.run = run; this.signal = signal; this.pollMs = pollMs;
  }
  async call(command, args = []) {
    try { return await this.run([...command, '--page', this.pageId, ...args], { signal: this.signal }); }
    catch (error) {
      if (!DIALOG_CODES.has(error.code)) throw error;
      // alert/confirm을 자동으로 승인하지 않습니다. 원문에는 개인정보가 포함될 수 있어 기록하지 않습니다.
      await this.run(['dialog', 'dismiss', '--page', this.pageId], { signal: this.signal }).catch(() => {});
      throw new OrcaError('dialog', '사이트 알림창이 열려 닫고 중단했습니다. Orca 탭에서 확인하세요.');
    }
  }
  /** 이동 후 문서가 열릴 때까지 기다리고 HTTP 상태(알 수 없으면 0)를 돌려줍니다. */
  async goto(url, { timeoutMs = 15000 } = {}) {
    await this.call(['goto'], ['--url', url]);
    // `orca wait --load`는 이미 지난 이벤트를 기다리다 시간 초과될 때가 있어 문서 상태를 직접 확인합니다.
    await this.waitFor(() => document.readyState !== 'loading', null, { timeoutMs }).catch(error => {
      if (error.code === 'dialog' || error.name === 'AbortError') throw error;
    });
    return await this.evaluate(() => performance.getEntriesByType('navigation')[0]?.responseStatus ?? 0);
  }
  async url() { return await this.evaluate(() => location.href); }
  async evaluate(fn, arg = null) {
    const expression = `(async () => JSON.stringify((await (${fn.toString()})(${JSON.stringify(arg)})) ?? null))()`;
    const { result } = await this.call(['eval'], ['--expression', expression]);
    return JSON.parse(result);
  }
  /** fn(arg)가 참이 될 때까지 반복 확인합니다. 페이지 이동 중의 일시적인 실패는 다시 시도합니다. */
  async waitFor(fn, arg = null, { timeoutMs = 15000, message = '페이지 상태를 기다리다 시간 초과되었습니다.' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.signal?.throwIfAborted();
      let value;
      try { value = await this.evaluate(fn, arg); }
      catch (error) { if (error.code === 'dialog' || error.name === 'AbortError') throw error; }
      if (value) return value;
      if (Date.now() >= deadline) throw new OrcaError('timeout', message);
      await delay(this.pollMs, undefined, { signal: this.signal });
    }
  }
  /**
   * 실제 마우스 클릭과 같은 이벤트를 보냅니다. 탭이 화면에 없을 때 Orca가 사용자 입력을 보호하려고
   * 클릭을 보내지 않으면("input was not sent") 다시 시도하고, 그래도 안 되면 봇 탭을 앞으로 띄웁니다.
   * 보내지 않았다고 확인된 경우에만 재시도하므로 두 번 눌리지 않습니다.
   */
  async click(selector) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.call(['click'], ['--element', selector]); }
      catch (error) {
        if (!/input was not sent/i.test(error.message) || attempt >= 2) throw error;
        if (attempt === 1) await this.show().catch(() => {});
        await delay(this.pollMs * 2, undefined, { signal: this.signal });
      }
    }
  }
  async show() { await this.run(['tab', 'switch', '--page', this.pageId], { signal: this.signal }); }
  async close() { await this.run(['tab', 'close', '--page', this.pageId], { signal: this.signal }); }
}

/**
 * 봇 전용 탭을 찾고 없으면 새로 엽니다. 로그인은 Orca 브라우저 프로필에 남아
 * 같은 프로필의 다른 탭과 공유됩니다. 사용자가 보고 있는 다른 탭은 움직이지 않습니다.
 */
export async function openBotTab(directory, startUrl, { run = runOrca, signal } = {}) {
  const file = join(directory, 'orca-tab.json');
  const saved = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  const { tabs } = await run(['tab', 'list'], { signal });
  if (saved?.browserPageId && tabs.some(t => t.browserPageId === saved.browserPageId)) {
    return new OrcaTab(saved.browserPageId, { run, signal });
  }
  const created = await run(['tab', 'create', '--url', startUrl], { signal });
  if (!created?.browserPageId) throw new OrcaError('orca-failed', 'Orca 탭을 열지 못했습니다.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ browserPageId: created.browserPageId }) + '\n', { mode: 0o600 });
  return new OrcaTab(created.browserPageId, { run, signal });
}
