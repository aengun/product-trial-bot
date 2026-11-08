import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { initConfig, loadConfig, CONSENTS } from './config.js';
import { StateStore, acquireLock } from './store.js';
import { MusinsaClient, BotError, ORIGIN } from './browser.js';
import { openBotTab, OrcaError } from './orca.js';
import { runCycle } from './runner.js';
import { createSizeNotifier } from './notifications.js';
import { SlackApprovalController } from './slack-control.js';
import { ApprovalStore } from './approvals.js';
import { watchSchedule } from './schedule.js';

const help = `무신사 체험단 자동 신청 봇

  npm run init                  개인 설정 파일 생성 (기존 파일 보존)
  npm run login                 Orca 내장 브라우저 탭에서 직접 로그인
  npm run scan                  모집 공고 수집
  npm start                     사이즈·옵션 미리보기 (제출 없음)
  npm start -- --submit         실제 신청 (필수 동의 설정 필요)
  npm start -- --submit --watch  설정 주기로 반복 신청
  npm run status                로컬 신청 기록 확인
  npm run reviews               사이즈 확인 대기 목록 (실행 중에도 가능)
  npm run choose -- ID M        해당 체험단을 M으로 선택 (다음 실행에 반영)
  npm run notify:test           설정한 맥·터미널·슬랙 채널로 테스트 알림
  npm run slack:start           슬랙 스레드 승인 후 신청, 결과 회신 (반복 실행)
  npm run approvals             슬랙 승인 요청 상태 확인
  node src/cli.js consents       필수 동의 ID와 설명
  node src/cli.js resolve ID --applied  사이트에서 신청 완료 확인 후 기록 확정
  node src/cli.js resolve ID --retry    미신청 확인 후 재시도 허용

공통 옵션: --config 경로 (기본 config.json), --data-dir 경로 (기본 .bot)
특정 공고만: npm run slack:start -- --campaign-id 49540
`;

function log(result) {
  console.log(`[${result.status}] ${result.id} ${result.title ?? ''}`);
  if (result.steps) console.log(`  옵션: ${result.steps.join(' / ')}`);
  if (result.reason) console.log(`  ${result.reason}`);
  for (const message of result.notice?.errors ?? []) console.log(`  알림: ${message}`);
}

async function main() {
  try { loadEnvFile(resolve('.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('로컬 .env 설정 파일을 읽을 수 없습니다.'); }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string', default: 'config.json' },
    'data-dir': { type: 'string', default: '.bot' },
    submit: { type: 'boolean', default: false }, watch: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' }, applied: { type: 'boolean' }, retry: { type: 'boolean' },
    'slack-approval': { type: 'boolean', default: false }, 'campaign-id': { type: 'string' },
  } });
  const [command = 'help', id, size] = positionals;
  if (values.help || command === 'help') { console.log(help); return; }
  if (!['init', 'login', 'scan', 'run', 'status', 'resolve', 'consents', 'reviews', 'choose', 'notify-test', 'approvals'].includes(command)) throw new Error('알 수 없는 명령입니다. --help를 확인하세요.');
  if (values.submit && command !== 'run') throw new Error('--submit은 run 명령에서만 사용할 수 있습니다.');
  if (values.watch && command !== 'run') throw new Error('--watch는 run 명령에서만 사용할 수 있습니다.');
  if (values['slack-approval'] && (command !== 'run' || !values.submit || !values.watch)) throw new Error('슬랙 승인 모드는 npm run slack:start로 실행하세요.');
  if (values['campaign-id'] && (command !== 'run' || !/^\d+$/.test(values['campaign-id']))) throw new Error('--campaign-id는 run 명령에서 체험단 번호로 지정하세요.');
  if (positionals.length > (command === 'choose' ? 3 : command === 'resolve' ? 2 : 1)) throw new Error('예상하지 못한 인자입니다.');
  if (command !== 'resolve' && (values.applied || values.retry)) throw new Error('--applied/--retry는 resolve 명령에서만 사용할 수 있습니다.');
  if (command === 'consents') {
    for (const [key, label] of Object.entries(CONSENTS)) console.log(`${key}: ${label}`);
    console.log('실제 신청서에서 자세한 약관을 확인한 후, 수락한 항목 ID를 config.json의 acceptedConsentIds에 넣으세요.');
    return;
  }
  const configPath = resolve(values.config);
  if (command === 'init') {
    try { await initConfig(configPath); } catch (e) {
      if (e.code === 'EEXIST') throw new Error('설정 파일이 이미 있습니다. 기존 설정을 보존했습니다.');
      throw e;
    }
    console.log(`${configPath} 생성 완료. 172cm·65kg / 상의 M·L / 하의 29·30 / 신발 260 설정입니다.`);
    return;
  }
  const directory = resolve(values['data-dir']);
  if (command === 'approvals') {
    const requests = await new ApprovalStore(directory).list();
    if (!requests.length) console.log('슬랙 승인 요청이 없습니다.');
    requests.sort((a, b) => b.createdAt - a.createdAt).forEach(r => console.log(
      `[${r.status}] ${r.campaign.id} ${r.campaign.title}\n  선택: ${r.selectedChoice?.steps.join(' / ') ?? '미선택'}\n  ${r.campaign.url}`));
    return;
  }
  if (command === 'notify-test') {
    const config = await loadConfig(configPath);
    const result = await createSizeNotifier(config)({ id: '0', title: '[테스트] 무신사 사이즈 확인 알림',
      reason: '알림 기능 테스트입니다. 실제 공고나 신청 대기 건이 아닙니다.', url: 'https://www.musinsa.com/preuser/main',
      review: { productUniqueId: '0', availableSizes: ['M', 'L'], measurements: [] } });
    if (result.errors.length) throw new Error(result.errors.join(' '));
    console.log(`알림 요청 완료: ${[...new Set(result.channels.map(c => c.split(':')[0]))].join(', ') || '모든 알림 채널이 꺼져 있습니다.'}`);
    return;
  }
  // 이 두 명령은 state.json을 수정하지 않아 반복 실행 봇과 함께 사용할 수 있습니다.
  if (command === 'reviews' || command === 'choose') {
    const store = await new StateStore(directory).load();
    if (command === 'choose') {
      if (!/^\d+$/.test(id ?? '') || !size?.trim()) throw new Error('npm run choose -- 체험단번호 사이즈 형식으로 입력하세요.');
      const decision = await store.chooseSize(id, size);
      console.log(`${id}: ${decision.size} 선택 완료. 다음 실행에서 재고를 다시 확인해 적용합니다.`);
      return;
    }
    const pending = Object.values(store.data.campaigns).filter(r => r.status === 'needs-size-review');
    if (!pending.length) console.log('사이즈 확인 대기 중인 공고가 없습니다.');
    for (const entry of pending) {
      log(entry);
      console.log(`  선택 가능: ${entry.review.availableSizes.join(', ') || '옵션명 확인 필요'}`);
      for (const row of entry.review.measurements) console.log(`  ${row.size}: 총장 ${row.length}cm / 가슴단면 ${row.chest}cm`);
      console.log(`  ${entry.url}\n  상품 실측: ${entry.review.productUrl}`);
      const decision = await store.getSizeDecision(entry.id);
      console.log(decision ? `  선택됨: ${decision.size} (다음 실행에 반영)` : `  선택: npm run choose -- ${entry.id} 사이즈`);
    }
    return;
  }
  const release = await acquireLock(directory);
  let approvalController;
  const abort = new AbortController();
  // 진행 중인 orca 명령도 중단합니다. 제출 중이었다면 pending 기록이 재시도를 막습니다.
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const store = await new StateStore(directory).load();
    if (command === 'status') {
      const records = Object.values(store.data.campaigns);
      if (!records.length) console.log('아직 신청 기록이 없습니다.');
      records.forEach(log); return;
    }
    if (command === 'resolve') {
      if (!/^\d+$/.test(id ?? '') || Boolean(values.applied) === Boolean(values.retry)) throw new Error('resolve ID --applied 또는 resolve ID --retry를 사용하세요.');
      const entry = store.get(id);
      const approvalStore = new ApprovalStore(directory);
      const pendingApprovals = (await approvalStore.list()).filter(r => r.campaign.id === id && ['processing', 'uncertain'].includes(r.status));
      if (!entry || (!['uncertain', 'submitting'].includes(entry.status) && !pendingApprovals.length)) throw new Error('결과 미확정 상태인 체험단만 처리할 수 있습니다.');
      await store.set(id, { ...entry, status: values.applied ? 'submitted' : 'retry-allowed',
        reason: '사용자가 무신사 신청 내역을 확인한 후 기록 처리', resolvedAt: new Date().toISOString() });
      for (const request of pendingApprovals) await approvalStore.mark(request.id, values.applied ? 'submitted' : 'stale');
      console.log(`${id}: ${values.applied ? '신청 완료로 확정' : '재시도 허용'}`); return;
    }
    const config = await loadConfig(configPath);
    if (values['slack-approval']) {
      approvalController = new SlackApprovalController(directory);
      await approvalController.start();
      console.log('슬랙 옵션 선택을 수신합니다. 조합 버튼을 누르거나 옵션 번호만 답장하면 신청합니다.');
    }
    // Orca 내장 브라우저의 봇 전용 탭을 사용합니다. 로그인은 Orca 브라우저에 남습니다.
    const tab = await openBotTab(directory, `${ORIGIN}/preuser/main`, { signal: abort.signal });
    const client = new MusinsaClient(tab, config);
    await client.start();
    if (values['campaign-id']) {
      const targetId = values['campaign-id'];
      const scan = client.scan.bind(client);
      client.scan = async signal => {
        const result = await scan(signal);
        return { ...result, campaigns: result.campaigns.filter(campaign => campaign.id === targetId) };
      };
    }
    if (command === 'login') {
      await tab.show().catch(() => {});
      if (await client.isLoggedIn()) { console.log('이미 로그인되어 있습니다. Orca 브라우저의 로그인을 그대로 사용합니다.'); return; }
      await client.click({ role: 'link', name: '로그인 페이지로 이동' }, '로그인 링크')
        .catch(() => console.log('로그인 링크를 찾지 못했습니다. Orca 탭의 로그인 버튼을 직접 눌러 주세요.'));
      console.log('Orca 무신사 탭에서 직접 로그인하세요. 기본 배송지 및 체험단 참여 수신 동의도 확인하세요.');
      console.log('비밀번호는 코드·설정에 저장하지 않습니다. 로그인 세션은 Orca 브라우저에 보관합니다.');
      const rl = createInterface({ input: stdin, output: stdout });
      try { await rl.question('로그인을 마쳤으면 Enter: ', { signal: abort.signal }); }
      finally { rl.close(); }
      await client.goto('/preuser/main');
      const loggedIn = await client.isLoggedIn();
      if (!loggedIn) throw new BotError('login-required', '로그인 완료를 확인하지 못했습니다. npm run login으로 다시 로그인하세요.', true);
      console.log('로그인 확인 완료. 다음 실행에서도 같은 Orca 탭과 로그인을 사용합니다.'); return;
    }
    if (command === 'scan') {
      const result = await client.scan(abort.signal);
      await writeFile(resolve(directory, 'campaigns.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      result.campaigns.forEach(c => console.log(`${c.id} [${c.category}] ${c.title}\n  ${c.url}`));
      console.log(`${result.campaigns.length}개 공고 저장${result.complete ? '' : ' (maxPages 제한으로 일부만 수집)'}: .bot/campaigns.json`);
      return;
    }
    console.log(approvalController ? '슬랙에서 승인한 공고만 신청합니다.' : values.submit ? '실제 신청 모드입니다.' : '미리보기 모드입니다. 실제 신청은 하지 않습니다.');
    const executeCycle = async (approvedOnly = false) => {
      approvalController?.beginCycle();
      const report = await runCycle({ client, store, config, submit: values.submit, signal: abort.signal, log,
        notify: approvedOnly ? undefined : createSizeNotifier(approvalController ? { ...config, notifications: { ...config.notifications, slack: false } } : config),
        approvalGate: approvalController, approvedOnly });
      console.log(`확인 ${report.scanned}개 · 예정 ${report.results.filter(r => r.status === 'planned').length}개 · 신청 완료 ${report.results.filter(r => r.status === 'submitted').length}개`);
      if (!report.complete) console.log('maxPages 제한으로 일부 공고만 수집했습니다.');
      await approvalController?.resolved().catch(() => {});
      return report;
    };
    // 항상 켜두는 슬랙 승인 모드: 오류를 슬랙으로 알리고 종료하지 않습니다.
    const reportError = async error => {
      let text = error instanceof BotError ? error.message : `작업 중 오류가 발생했습니다: ${error.message}`;
      if (error instanceof OrcaError && error.code === 'browser_tab_not_found') {
        try {
          client.tab = await openBotTab(directory, `${ORIGIN}/preuser/main`, { signal: abort.signal });
          text = '봇이 쓰던 Orca 탭이 닫혀 새 탭을 열었습니다.';
        } catch { text = '봇이 쓰던 Orca 탭이 닫혔고 새 탭도 열지 못했습니다. Orca 앱을 확인하세요.'; }
      } else if (error instanceof OrcaError && error.code === 'browser_host_unavailable') {
        text = 'Orca 앱이 꺼져 있거나 연결되지 않았습니다. Orca를 켜 두세요.';
      }
      console.log(`오류: ${text}`);
      await approvalController?.alert(`${text}\n봇은 켜진 상태로 다음 확인·승인 때 다시 시도합니다.`)
        .catch(() => console.log('슬랙으로 오류 알림을 보내지 못했습니다.'));
    };
    if (values.watch && config.schedule) {
      const hours = [];
      for (let hour = config.schedule.startHour; hour <= config.schedule.endHour; hour += config.schedule.intervalHours) hours.push(`${String(hour).padStart(2, '0')}:00`);
      console.log(`매일 ${hours.join(', ')}에 공고를 확인합니다 (한국 시간).`);
      await watchSchedule({ schedule: config.schedule, signal: abort.signal, log: console.log,
        runScheduled: () => executeCycle(),
        runApproved: async () => {
          if (!approvalController || !(await approvalController.approvedCampaignIds()).some(id => !store.blocks(id))) return false;
          const report = await executeCycle(true);
          return report.results.some(result => result.status === 'submitted');
        },
        wait: (ms, signal) => approvalController ? approvalController.wait(ms, signal) : delay(ms, undefined, { signal }),
        ...(approvalController ? { onError: reportError } : {}),
      });
      return;
    }
    do {
      await executeCycle();
      if (!values.watch) break;
      console.log(`${config.intervalSeconds}초 뒤 다시 확인합니다. 종료: Ctrl+C`);
      if (approvalController) await approvalController.wait(config.intervalSeconds * 1000, abort.signal);
      else await delay(config.intervalSeconds * 1000, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (abort.signal.aborted) { console.log('봇을 종료했습니다. 제출 중이던 신청은 기록을 확인하세요.'); return; }
    await approvalController?.alert(`봇이 종료됐습니다: ${error.message}\n다시 켜야 알림·신청이 동작합니다.`).catch(() => {});
    if (error instanceof OrcaError) {
      if (error.code === 'browser_tab_not_found') throw new Error('봇이 쓰던 Orca 탭이 닫혔습니다. 다시 실행하면 새 탭을 엽니다. 신청 기록을 확인하세요.');
      if (error.code === 'browser_host_unavailable') throw new Error('Orca 앱이 꺼져 있거나 연결되지 않았습니다. Orca를 켠 뒤 다시 실행하세요.');
      throw new Error(`Orca 브라우저 작업이 중단되거나 시간 초과되었습니다 (${error.message}). .bot/last-run.json과 신청 기록을 확인하세요.`);
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (approvalController) await approvalController.stop().catch(() => {});
    await release();
  }
}

main().catch(error => {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
});
