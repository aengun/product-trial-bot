export function normalize(value) {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ko-KR');
}

export const CATEGORY_NAMES = { ALL: '전체', BEAUTY: '뷰티', SHOE: '신발', TOP: '상의', OUTER: '아우터',
  PANTS: '바지', DRESS_AND_SKIRT: '원피스/스커트', BAG: '가방', FASHION_ACCESSORY: '패션 소품',
  UNDERWEAR: '속옷/홈웨어', SPORTS: '스포츠/레저', DIGITAL_LIFE: '디지털/라이프', KIDS: '키즈' };

export function excludedCosmetic(text, category, config) {
  if (!config.excludeFemaleCosmetics || !['BEAUTY', '뷰티'].includes(category)) return false;
  const value = normalize(text);
  if (/남성|남자|맨즈|포맨|\bfor men\b|\bmens?\b|\bhomme\b/.test(value)) return false;
  return /틴트|립스틱|립글로스|립글로우|립라이너|블러셔|블러쉬|아이섀도|아이쉐도|아이라이너|마스카라|아이브로우|파운데이션|컨실러|하이라이터|셰이딩|쉐딩|메이크업|색조|뷰러|쿠션/.test(value)
    || (/립밤/.test(value) && /볼륨톡스|플럼핑|틴티드|컬러|색상|colors?/.test(value));
}

export function campaignExclusionReason(campaign, config) {
  const category = CATEGORY_NAMES[campaign.category] ?? campaign.category;
  if (config.excludeCategories?.includes(category)) return `${category} 제외`;
  const text = normalize(`${campaign.brand ?? ''} ${campaign.title ?? ''}`);
  if (config.excludeKeywords?.some(keyword => text.includes(normalize(keyword)))) return '제외 키워드';
  if (excludedCosmetic(text, category, config)) return '여성 색조 화장품 제외';
  return null;
}

export function matchCampaign(campaign, config) {
  if (config.campaignIds.length && !config.campaignIds.includes(String(campaign.id))) return false;
  if (config.brands.length && !config.brands.some(x => normalize(x) === normalize(campaign.brand))) return false;
  const text = normalize(`${campaign.brand} ${campaign.title}`);
  if (campaignExclusionReason(campaign, config)) return false;
  return !config.includeKeywords.length || config.includeKeywords.some(x => text.includes(normalize(x)));
}

