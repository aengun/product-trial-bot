import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { campaignLink } from './slack.js';

const safeUrl = (value, test, fallback) => {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && test(url)) return url.href;
  } catch {}
  return fallback;
};

/**
 * 플랫폼마다 봇을 따로 실행합니다. 상태 폴더·Slack 앱·Orca 탭이 모두 분리되어
 * 실행 중인 다른 플랫폼 봇에 영향을 주지 않습니다.
 */
export const PLATFORMS = Object.freeze({
  musinsa: Object.freeze({
    id: 'musinsa', name: '무신사', dataDir: '.bot', envFile: '.env',
    startUrl: 'https://www.musinsa.com/preuser/main', idPattern: /^\d+$/,
    link: campaignLink,
  }),
  '29cm': Object.freeze({
    id: '29cm', name: '29CM', dataDir: '.bot/29cm', envFile: '.env.29cm',
    startUrl: 'https://www.29cm.co.kr/preuser', idPattern: /^PE_[A-Za-z0-9]{8,64}$/,
    link: value => safeUrl(value, url => url.hostname === 'www.29cm.co.kr' && !url.search
      && /^\/preuser(\/event\/PE_[A-Za-z0-9]{8,64})?$/.test(url.pathname), 'https://www.29cm.co.kr/preuser'),
  }),
  '4910': Object.freeze({
    id: '4910', name: '4910', dataDir: '.bot/4910', envFile: '.env.4910',
    startUrl: 'https://4910.kr/preuser', idPattern: /^\d+$/,
    link: value => safeUrl(value, url => url.hostname === '4910.kr'
      && (/^\/preuser$/.test(url.pathname) && !url.search
        || /^\/preuser\/goods\/\d+$/.test(url.pathname) && /^\?preuser_goods_sno=\d+$/.test(url.search)), 'https://4910.kr/preuser'),
  }),
});

export function platformFor(id = 'musinsa') {
  const platform = PLATFORMS[String(id).toLowerCase()];
  if (!platform) throw new Error(`알 수 없는 플랫폼입니다: ${id}. musinsa, 29cm, 4910 중 하나를 쓰세요.`);
  return platform;
}

/**
 * 무신사 외 플랫폼은 전용 .env 파일의 Slack 앱 토큰·채널만 씁니다. 같은 앱 토큰을 두 봇이 쓰면
 * Socket Mode 버튼 이벤트가 한쪽 봇에만 전달되므로, 무신사 봇과 같은 토큰·채널은 거부합니다.
 * 승인자 멤버 ID만 무신사 .env 값을 이어 쓸 수 있습니다. 오류에 토큰 원문을 넣지 않습니다.
 */
export function platformEnv(platform, { base = process.env, read = path => readFileSync(path, 'utf8'), cwd = process.cwd() } = {}) {
  if (platform.id === 'musinsa') return base;
  let own;
  try { own = parseEnv(read(resolve(cwd, platform.envFile))); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${platform.envFile} 파일이 없습니다. ${platform.name} 전용 Slack 앱의 토큰과 채널 ID를 넣어 주세요.`);
    throw new Error(`${platform.envFile} 파일을 읽을 수 없습니다.`);
  }
  const env = { SLACK_APPROVER_USER_ID: base.SLACK_APPROVER_USER_ID, ...own };
  for (const [key, label] of [['SLACK_BOT_TOKEN', '봇 토큰(xoxb-)'], ['SLACK_APP_TOKEN', '앱 토큰(xapp-)'], ['SLACK_CHANNEL_ID', '채널 ID']]) {
    if (!env[key]?.trim()) throw new Error(`${platform.envFile}에 ${key}를 넣어 주세요.`);
    if (base[key]?.trim() && env[key].trim() === base[key].trim()) {
      throw new Error(`${platform.envFile}의 ${label}이(가) 무신사 봇(.env)과 같습니다. ${platform.name} 전용 Slack 앱·채널 값을 넣어 주세요.`);
    }
  }
  return env;
}

/** 무신사 체험단 번호 전용 설정은 다른 플랫폼 공고를 거르지 않도록 비웁니다. */
export function platformConfig(platform, config) {
  return platform.id === 'musinsa' ? config : { ...config, campaignIds: [], campaignOptions: {} };
}

/** 사이트의 ISO 마감 시각을 한국 날짜(YYYY-MM-DD)로 바꿉니다. 승인 요청은 이 날 23:59:59(KST)까지 유지됩니다. */
export function seoulDate(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
