import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function slackWebhook(value) {
  if (!value?.trim()) throw new Error('슬랙 알림에는 .env의 SLACK_WEBHOOK_URL 설정이 필요합니다.');
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash
      || !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error();
    return url.href;
  } catch { throw new Error('SLACK_WEBHOOK_URL에 Slack Incoming Webhook의 HTTPS 주소를 설정하세요.'); }
}

const clip = (text, length) => String(text ?? '').slice(0, length);
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function campaignLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'www.musinsa.com' && !url.username && !url.password
      && !url.port && !url.search && !url.hash && /^\/preuser\/(events\/\d+|main)$/.test(url.pathname)) return url.href;
  } catch {}
  return 'https://www.musinsa.com/preuser/main';
}

export function slackPayload(result) {
  const sizes = result.review.availableSizes.map(x => clip(x, 60)).join(', ');
  const measurements = result.review.measurements.slice(0, 12)
    .map(m => `${clip(m.size, 60)}: 총장 ${m.length}cm / 가슴단면 ${m.chest}cm`).join(' · ');
  const url = campaignLink(result.url);
  const body = [clip(result.title, 350),
    `선택 가능: ${clip(sizes, 450) || '옵션명 확인 필요'}`, measurements].filter(Boolean).join('\n');
  return {
    text: escape(clip(`무신사 사이즈 확인 필요: ${result.title}\n${result.reason}\n${url}`, 1500)),
    mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '무신사 · 사이즈 확인 필요' } },
      { type: 'section', text: { type: 'plain_text', text: clip(body, 2900) } },
      { type: 'section', text: { type: 'mrkdwn', text: `<${url}|무신사 공고 열기>`, verbatim: true } },
      { type: 'section', text: { type: 'plain_text', text: `사이즈 선택: npm run choose -- ${result.id} 사이즈` } },
    ],
  };
}

// URL 원문이나 네트워크 예외를 로그·처리 기록에 남기지 않습니다.
export function createSlackSender({ env = process.env, request = globalThis.fetch,
  now = Date.now, wait = delay } = {}) {
  let readyAt = 0, attempts = 0;
  return async (result, sentChannels, slackCooldowns = {}) => {
    let url;
    try { url = slackWebhook(env.SLACK_WEBHOOK_URL); }
    catch (error) { return { errors: [error.message] }; }
    const key = `slack:${createHash('sha256').update(url).digest('hex').slice(0, 20)}`;
    if (sentChannels.has(key)) return {};
    if (attempts >= 3) return { deferred: true };
    const previousRetry = result.notice?.slackRetry;
    const blockedUntil = Math.max(previousRetry?.target === key && Number.isFinite(previousRetry.at) ? previousRetry.at : 0,
      slackCooldowns[key] ?? 0);
    if (blockedUntil > now()) {
      return { deferred: true, slackRetry: { target: key, at: blockedUntil } };
    }
    const pause = readyAt - now();
    // 429의 긴 대기는 다음 회차로 넘기고, 정상 전송 사이의 짧은 간격만 기다립니다.
    if (pause > 1100) return { deferred: true, slackRetry: { target: key, at: readyAt } };
    if (pause > 0) await wait(pause);
    attempts++;
    readyAt = now() + 1100;
    try {
      const response = await request(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(slackPayload(result)), redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        readyAt = now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
        return { errors: ['슬랙 전송 한도에 도달했습니다. Retry-After 이후 다시 시도합니다.'],
          slackRetry: { target: key, at: readyAt } };
      }
      if (response.status !== 200 || (await response.text()).trim() !== 'ok') {
        return { errors: [`슬랙 알림 전송에 실패했습니다 (HTTP ${response.status}). 웹훅과 채널 설정을 확인하세요.`] };
      }
      sentChannels.add(key);
      return { slackRetry: null };
    } catch { return { errors: ['슬랙 알림 전송을 확인하지 못했습니다. 다음 회차에 다시 시도합니다.'] }; }
  };
}
