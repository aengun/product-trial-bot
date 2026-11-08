import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalize } from './filters.js';

export const BLOCKING_STATUSES = new Set(['submitted', 'already-applied', 'submitting', 'uncertain']);

export class StateStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'state.json');
    this.data = { version: 1, campaigns: {} };
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1 || !data.campaigns || typeof data.campaigns !== 'object' || Array.isArray(data.campaigns)) {
        throw new Error('지원하지 않는 신청 기록 형식입니다.');
      }
      for (const [id, entry] of Object.entries(data.campaigns)) {
        if (!/^\d+$/.test(id) || !entry || typeof entry.status !== 'string') throw new Error('신청 기록이 손상되었습니다.');
      }
      this.data = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`신청 기록을 읽을 수 없어 실행을 중단합니다: ${error.message}`);
    }
    return this;
  }
  get(id) { return this.data.campaigns[String(id)]; }
  blocks(id) { return BLOCKING_STATUSES.has(this.get(id)?.status); }
  async getSizeDecision(id) {
    if (!/^\d+$/.test(String(id))) throw new Error('올바르지 않은 체험단 번호입니다.');
    try {
      const decision = JSON.parse(await readFile(join(this.directory, 'size-decisions', `${id}.json`), 'utf8'));
      if (decision.campaignId !== String(id) || typeof decision.size !== 'string' || !decision.size.trim()
        || !/^\d+$/.test(decision.productUniqueId)) throw new Error('사이즈 선택 기록 형식을 확인하세요.');
      return decision;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async chooseSize(id, size) {
    const entry = this.get(id);
    if (entry?.status !== 'needs-size-review') throw new Error('사이즈 확인 대기 중인 체험단만 선택할 수 있습니다.');
    const matches = entry.review?.availableSizes?.filter(x => normalize(x) === normalize(size)) ?? [];
    if (matches.length !== 1) throw new Error(`사이즈를 정확히 입력하세요. 선택 가능: ${entry.review?.availableSizes?.join(', ') || '옵션명 확인 필요'}`);
    const directory = join(this.directory, 'size-decisions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.json`), temp = `${path}.${randomUUID()}.tmp`;
    const decision = { campaignId: String(id), productUniqueId: entry.review.productUniqueId,
      size: matches[0], chosenAt: new Date().toISOString() };
    await writeFile(temp, JSON.stringify(decision, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
    return decision;
  }
  async set(id, entry) {
    if (!/^\d+$/.test(String(id))) throw new Error('올바르지 않은 체험단 번호입니다.');
    const next = {
      ...this.data,
      campaigns: { ...this.data.campaigns, [String(id)]: { ...entry, updatedAt: new Date().toISOString() } },
    };
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(next, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, this.file);
    this.data = next;
  }
  async report(value) {
    await writeFile(join(this.directory, 'last-run.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }
}

export async function acquireLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'run.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('다른 봇이 실행 중이거나 이전 실행이 비정상 종료됐습니다. 프로세스 종료를 확인한 뒤 .bot/run.lock을 삭제하세요.');
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  catch (error) { await handle.close(); await unlink(path); throw error; }
  return async () => { await handle.close(); await unlink(path); };
}
