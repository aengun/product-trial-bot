import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createSlackSender } from './slack.js';

const executeFile = promisify(execFile);
// 상품명과 이유는 argv로 전달하고 AppleScript 코드에 삽입하지 않습니다.
const script = 'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run';

export function reviewFingerprint(result) {
  const review = result.review;
  const content = { id: result.id, title: result.title, reason: result.reason,
    product: review.productUniqueId, sizes: [...review.availableSizes].sort(),
    measurements: [...review.measurements].sort((a, b) => a.size.localeCompare(b.size)) };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export function reviewMessage(result) {
  const measurements = result.review.measurements.map(m => `${m.size}: 총장 ${m.length}cm / 가슴단면 ${m.chest}cm`);
  return [`${result.title} (#${result.id})`, result.reason,
    `선택 가능: ${result.review.availableSizes.join(', ') || '옵션명 확인 필요'}`,
    ...measurements, result.url, `대기 목록: npm run reviews`,
    `선택: npm run choose -- ${result.id} 사이즈`].join('\n');
}

export function createSizeNotifier(config, { platform = process.platform, execute = executeFile,
  write = text => process.stdout.write(text), env = process.env, request = globalThis.fetch,
  now = Date.now, wait } = {}) {
  let desktopCount = 0;
  const sendSlack = createSlackSender({ env, request, now, ...(wait ? { wait } : {}) });
  return async (result, sentChannels = [], { slackCooldowns = {} } = {}) => {
    const channels = new Set(sentChannels), errors = [];
    if (config.notifications.terminal && !channels.has('terminal')) {
      write(`${process.stdout.isTTY ? '\u0007' : ''}\n[사이즈 확인 알림]\n${reviewMessage(result)}\n\n`);
      channels.add('terminal');
    }
    let deferred = config.notifications.desktop && !channels.has('desktop') && desktopCount >= 3;
    if (config.notifications.desktop && !channels.has('desktop') && !deferred) {
      if (platform !== 'darwin') errors.push('맥 알림은 macOS에서 사용할 수 있습니다. 대기 목록은 npm run reviews로 확인하세요.');
      else {
        desktopCount++;
        try {
          const message = `${result.title.slice(0, 100)}\n${result.reason.slice(0, 100)}\n${result.url}\n확인: npm run reviews`;
          await execute('/usr/bin/osascript', ['-e', script, '무신사 · 사이즈 확인 필요', message], { timeout: 5000 });
          channels.add('desktop');
        } catch { errors.push('맥 알림 요청에 실패했습니다. 다음 주기에 다시 시도합니다. 대기 목록은 npm run reviews로 확인하세요.'); }
      }
    }
    let slackRetry;
    if (config.notifications.slack) {
      const slack = await sendSlack(result, channels, slackCooldowns);
      errors.push(...(slack.errors ?? []));
      deferred = deferred || Boolean(slack.deferred);
      slackRetry = slack.slackRetry;
    }
    return { channels: [...channels], errors, deferred, ...(slackRetry !== undefined ? { slackRetry } : {}) };
  };
}
