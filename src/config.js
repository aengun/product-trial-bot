import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONSENTS = Object.freeze({
  privacy_collection: '[필수] 개인정보 수집 및 이용 동의',
  privacy_third_party: '[필수] 개인정보 제 3자 제공 동의',
  penalty_policy: '[필수] 이벤트 당첨자의 패널티 정책 동의',
  auto_payment: "[필수] 이벤트 당첨 시 '0원 자동 결제' 동의",
});

export const SELECTORS = Object.freeze({
  grid: '[data-id="experience-card-grid"]',
  card: '[data-id="experience-card"]',
  empty: '[data-id="experience-empty-state"]',
  tabs: '[data-id="main-tabs"]',
  filter: '[data-id="main-filter"]',
  apply: '[data-rosetta-id="4038"]',
  optionBox: '[class*="sc-5cef0ce0-1"]',
  optionList: '[class*="sc-5cef0ce0-2"]',
});

const defaults = {
  gender: 'A', categories: ['전체'], excludeCategories: [], excludeFemaleCosmetics: false, includeKeywords: [], excludeKeywords: [],
  profile: null,
  brands: [], campaignIds: [], preferredOptions: [], campaignOptions: {},
  acceptedConsentIds: [], maxApplicationsPerRun: 5, maxPages: 20,
  intervalSeconds: 600, actionDelayMs: 1500, timeoutMs: 15000,
  schedule: null,
  selectors: {},
  sizeReview: { scoreGap: 2, boundaryCm: 1 },
  notifications: { desktop: true, terminal: true, slack: false },
};
const categories = ['전체', '뷰티', '신발', '상의', '아우터', '바지', '원피스/스커트',
  '가방', '패션 소품', '속옷/홈웨어', '스포츠/레저', '디지털/라이프', '키즈'];

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('설정은 JSON 객체여야 합니다.');
  for (const key of Object.keys(input)) {
    if (key === 'browserChannel') throw new Error('browserChannel 설정은 더 이상 쓰지 않습니다. 봇은 Orca 내장 브라우저만 사용하니 config.json에서 지우세요.');
    if (!(key in defaults)) throw new Error(`알 수 없는 설정: ${key}`);
  }
  const c = { ...defaults, ...input };
  if (typeof c.excludeFemaleCosmetics !== 'boolean') throw new Error('excludeFemaleCosmetics는 true 또는 false여야 합니다.');
  if (c.schedule !== null) {
    const schedule = c.schedule;
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)
      || Object.keys(schedule).some(key => !['timeZone', 'startHour', 'endHour', 'intervalHours'].includes(key))
      || schedule.timeZone !== 'Asia/Seoul'
      || !Number.isInteger(schedule.startHour) || schedule.startHour < 0 || schedule.startHour > 23
      || !Number.isInteger(schedule.endHour) || schedule.endHour < schedule.startHour || schedule.endHour > 23
      || !Number.isInteger(schedule.intervalHours) || schedule.intervalHours < 1 || schedule.intervalHours > 24) {
      throw new Error('schedule은 한국 시간의 시작·종료 시각(0~23)과 간격(1~24시간)을 지정해야 합니다.');
    }
  }
  for (const key of ['sizeReview', 'notifications']) {
    if (!c[key] || typeof c[key] !== 'object' || Array.isArray(c[key])) throw new Error(`${key}는 객체여야 합니다.`);
    for (const option of Object.keys(c[key])) {
      if (!Object.hasOwn(defaults[key], option)) throw new Error(`알 수 없는 설정: ${key}.${option}`);
    }
    c[key] = { ...defaults[key], ...c[key] };
  }
  for (const value of Object.values(c.sizeReview)) {
    if (!Number.isFinite(value) || value < 0) throw new Error('sizeReview 값은 0 이상의 숫자여야 합니다.');
  }
  if (Object.values(c.notifications).some(value => typeof value !== 'boolean')) throw new Error('notifications 값은 true 또는 false여야 합니다.');
  for (const key of ['categories', 'excludeCategories', 'includeKeywords', 'excludeKeywords', 'brands',
    'preferredOptions', 'acceptedConsentIds']) {
    if (!Array.isArray(c[key]) || c[key].some(x => typeof x !== 'string' || !x.trim())) {
      throw new Error(`${key}: 빈 문자열이 없는 문자열 배열이어야 합니다.`);
    }
  }
  if (!['A', 'M', 'F'].includes(c.gender)) throw new Error('gender는 A, M, F 중 하나여야 합니다.');
  if (!c.categories.length || c.categories.some(x => !categories.includes(x))) throw new Error('categories의 카테고리 이름을 확인하세요.');
  if (c.categories.includes('전체') && c.categories.length !== 1) throw new Error('전체 카테고리는 다른 카테고리와 함께 지정할 수 없습니다.');
  if (c.excludeCategories.some(value => value === '전체' || !categories.includes(value))) throw new Error('excludeCategories의 카테고리 이름을 확인하세요.');
  if (!Array.isArray(c.campaignIds) || c.campaignIds.some(x => !/^\d+$/.test(String(x)))) throw new Error('campaignIds는 체험단 번호 배열이어야 합니다.');
  for (const key of ['campaignOptions', 'selectors']) {
    if (!c[key] || typeof c[key] !== 'object' || Array.isArray(c[key])) throw new Error(`${key}는 객체여야 합니다.`);
  }
  for (const [id, options] of Object.entries(c.campaignOptions)) {
    if (!/^\d+$/.test(id) || !Array.isArray(options) || options.some(x => typeof x !== 'string' || !x.trim())) {
      throw new Error('campaignOptions는 체험단 번호별 옵션 문자열 배열이어야 합니다.');
    }
  }
  for (const [key, value] of Object.entries(c.selectors)) {
    if (!(key in SELECTORS) || typeof value !== 'string' || !value.trim()) throw new Error(`올바르지 않은 selector: ${key}`);
  }
  for (const id of c.acceptedConsentIds) {
    if (!(id in CONSENTS)) throw new Error(`알 수 없는 필수 동의 ID: ${id}`);
  }
  if (c.profile !== null) {
    const p = c.profile;
    if (!p || typeof p !== 'object' || !Number.isFinite(p.heightCm) || !Number.isFinite(p.weightKg)
      || p.heightCm < 100 || p.heightCm > 250 || p.weightKg < 20 || p.weightKg > 250) throw new Error('profile의 키·몸무게를 확인하세요.');
    for (const key of ['topSizes', 'bottomSizes']) {
      if (!Array.isArray(p[key]) || !p[key].length || p[key].some(x => typeof x !== 'string' || !x.trim())) throw new Error(`profile.${key}를 확인하세요.`);
    }
    if (typeof p.shoeSize !== 'string' || !/^\d{3}$/.test(p.shoeSize)) throw new Error('profile.shoeSize를 확인하세요.');
    for (const key of ['chestMin', 'chestMax', 'lengthMin', 'lengthMax', 'targetChest', 'targetLength']) {
      if (!Number.isFinite(p.topFit?.[key]) || p.topFit[key] <= 0) throw new Error(`profile.topFit.${key}를 확인하세요.`);
    }
    for (const dimension of ['chest', 'length']) {
      if (p.topFit[`${dimension}Min`] > p.topFit[`${dimension}Max`]) throw new Error('실측 최소값이 최대값보다 큽니다.');
    }
  }
  for (const [key, min] of Object.entries({ maxApplicationsPerRun: 1, maxPages: 1,
    intervalSeconds: 60, actionDelayMs: 500, timeoutMs: 1000 })) {
    if (!Number.isSafeInteger(c[key]) || c[key] < min) throw new Error(`${key}는 ${min} 이상의 정수여야 합니다.`);
  }
  return { ...c, campaignIds: c.campaignIds.map(String), selectors: { ...SELECTORS, ...c.selectors } };
}

export async function loadConfig(path) {
  try { return validateConfig(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('config.json이 없습니다. 먼저 npm run init을 실행하세요.');
    throw error;
  }
}

export async function initConfig(path) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const example = fileURLToPath(new URL('../config.example.json', import.meta.url));
  await copyFile(example, path, constants.COPYFILE_EXCL);
}
