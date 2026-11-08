import { normalize, excludedCosmetic } from './filters.js';

const sizeText = value => normalize(value).replace(/\s*mm$/, '');

export function rankTopSizes(table, profile, availableSizes) {
  if (!table || !Array.isArray(table.rows)) return [];
  const chestIndex = table.headers.findIndex(x => /가슴단면|chest/i.test(x));
  const lengthIndex = table.headers.findIndex(x => /^(총장|length)$/i.test(x));
  if (chestIndex < 0 || lengthIndex < 0) return [];
  const fit = profile.topFit;
  return table.rows.flatMap(row => {
    if (!profile.topSizes.some(x => sizeText(x) === sizeText(row.size))
      || !availableSizes.some(x => sizeText(x) === sizeText(row.size))) return [];
    const chest = row.values[chestIndex], length = row.values[lengthIndex];
    if (!Number.isFinite(chest) || !Number.isFinite(length)
      || chest < fit.chestMin || chest > fit.chestMax
      || length < fit.lengthMin || length > fit.lengthMax) return [];
    return [{ size: row.size, chest, length,
      score: Math.abs(chest - fit.targetChest) + Math.abs(length - fit.targetLength) }];
  }).sort((a, b) => a.score - b.score || profile.topSizes.indexOf(a.size) - profile.topSizes.indexOf(b.size));
}

function excludedText(value, config = {}) {
  const text = normalize(value);
  return config.excludeKeywords?.some(keyword => text.includes(normalize(keyword)))
    || (config.gender === 'M' && /[([]\s*여\s*[)\]]/.test(text));
}

function availableOption(item, config = {}) {
  return item.activated !== false && !item.isDeleted && !item.outOfStock
    && !item.optionValues?.some(value => excludedText(value.name, config)
      || (config.gender === 'M' && /성별|gender|sex/i.test(value.optionName ?? '') && /^(f|여)$/i.test(value.name.trim())));
}

export function representativeProduct(event, config) {
  const products = event.products?.filter(product => !excludedText(product.name, config)
    && !excludedCosmetic(product.name, event.eventCategory, config)) ?? [];
  let allowed = products.filter(product => product.isOnSale !== false);
  // 일반 판매 상태와 체험단 모집 상태는 다를 수 있습니다. 모집 중이며 재고 옵션이 있는 상품은 확인합니다.
  if (!allowed.length && event.state === 'OPEN') {
    allowed = products.filter(product => product.optionItems?.some(item => availableOption(item, config)));
  }
  return allowed?.find(product => product.isRepresentative) ?? allowed?.[0];
}

/** 실제로 재고가 있는 SKU마다 한 선택지. 색상과 사이즈가 같은 다른 상품도 합치지 않습니다. */
export function eventOptionChoices(event, config) {
  const generic = !['TOP', 'OUTER', 'PANTS', 'SHOE'].includes(event.eventCategory);
  const items = (event.products ?? []).filter(product => !excludedText(product.name, config)
    && !excludedCosmetic(product.name, event.eventCategory, config))
    .flatMap(product => (product.optionItems ?? []).filter(item => availableOption(item, config))
      .map(item => ({ product, item })));
  return items.map(({ product, item }, index) => ({
    productUniqueId: String(product.uniqueId), optionNo: item.no, productName: product.name,
    selectedSize: item.optionValues?.find(value => /사이즈|size/i.test(value.optionName ?? ''))?.name
      ?? item.optionValues?.map(value => value.name).join(' / ') ?? '',
    choiceKey: `옵션${index + 1}`, ...(generic ? { selectionKind: 'option' } : {}),
    steps: [...(event.products.length > 1 ? [product.name] : []), ...(item.optionValues ?? []).map(value => value.name)],
  }));
}

export function planOptions(event, product, config, table = null, decision = null) {
  const choices = eventOptionChoices(event, config);
  if (!product) return { status: 'skipped', reason: '신청 가능한 상품이 없습니다.', choices };
  const stocked = product.optionItems?.filter(item => availableOption(item, config)) ?? [];
  if (!stocked.length) return { status: 'skipped', reason: '재고가 있는 옵션을 확인할 수 없습니다.', choices };
  const manual = config.campaignOptions[String(event.eventId)];
  let candidates = stocked, sizing = '';
  const generic = !['TOP', 'OUTER', 'PANTS', 'SHOE'].includes(event.eventCategory);
  const getSize = item => item.optionValues?.find(v => /사이즈|size/i.test(v.optionName ?? ''))?.name;
  const choice = item => choices.find(candidate => candidate.productUniqueId === String(product.uniqueId) && candidate.optionNo === item.no);
  const selectionKey = item => generic ? choice(item).choiceKey : getSize(item);
  const availableSizes = [...new Set(stocked.map(selectionKey).filter(Boolean))];
  const title = normalize(event.name);
  const score = item => item.optionValues.reduce((sum, v) => sum + (title.includes(normalize(v.name)) ? 1 : 0), 0);
  const review = (reason, measurements = []) => ({
    status: 'needs-size-review', reason, ...(generic ? { selectionKind: 'option' } : {}),
    review: { productUniqueId: String(product.uniqueId), productName: product.name,
      productUrl: `https://www.musinsa.com/products/${product.uniqueId}`,
      availableSizes, measurements,
      choices },
  });
  if (decision) {
    if (decision.productUniqueId !== String(product.uniqueId)) return review('상품 구성이 변경되어 이전 사이즈 선택을 적용하지 않았습니다.');
    candidates = decision.optionNo !== undefined
      ? stocked.filter(item => item.no === decision.optionNo)
      : stocked.filter(item => sizeText(selectionKey(item) ?? '') === sizeText(decision.size)
        || sizeText(choice(item).choiceKey) === sizeText(decision.size));
    if (!candidates.length) return review(`직접 선택한 ${decision.size} ${generic ? '옵션' : '사이즈'}의 재고가 변경됐습니다.`);
    sizing = `사용자 확인 ${generic ? '옵션' : '사이즈'}: ${decision.size}`;
  } else if (manual?.length) {
    candidates = stocked.filter(item => item.optionValues?.every(v => manual.some(x => normalize(x) === normalize(v.name))));
    sizing = '체험단별 직접 지정 옵션';
  } else if (generic && (config.profile || !config.preferredOptions.length)) {
    if (stocked.length > 1) return review('신청할 옵션을 선택해 주세요.');
    sizing = '단일 신청 옵션';
  } else if (config.profile) {
    if (!availableSizes.length) return review('상품 옵션에서 사이즈 항목을 정확히 확인할 수 없습니다.');
    let wanted;
    if (['TOP', 'OUTER'].includes(event.eventCategory)) {
      const ranked = rankTopSizes(table, config.profile, availableSizes);
      if (!ranked.length) return review('허용 사이즈의 총장·가슴단면 실측을 확인할 수 없거나 설정 범위를 벗어납니다.');
      const measurements = ranked.map(({ size, chest, length }) => ({ size, chest, length }));
      const distinct = ranked.filter((r, i) => ranked.findIndex(x => sizeText(x.size) === sizeText(r.size)) === i);
      const scoreGap = config.sizeReview?.scoreGap ?? 2;
      if (distinct.length > 1 && distinct[1].score - distinct[0].score <= scoreGap) {
        return review(`${distinct[0].size}와 ${distinct[1].size}의 실측 적합도 차이가 작아 직접 확인이 필요합니다.`, measurements);
      }
      const fit = config.profile.topFit, boundary = config.sizeReview?.boundaryCm ?? 1;
      if (ranked[0].chest - fit.chestMin <= boundary || fit.chestMax - ranked[0].chest <= boundary
        || ranked[0].length - fit.lengthMin <= boundary || fit.lengthMax - ranked[0].length <= boundary) {
        return review(`${ranked[0].size}의 실측이 허용 범위 경계에 가까워 직접 확인이 필요합니다.`, measurements);
      }
      wanted = ranked[0].size;
      sizing = `${wanted}: 총장 ${ranked[0].length}cm, 가슴단면 ${ranked[0].chest}cm (설정 목표치와 비교)`;
    } else if (event.eventCategory === 'PANTS') {
      wanted = config.profile.bottomSizes.find(x => availableSizes.some(v => sizeText(x) === sizeText(v)));
      if (!wanted && availableSizes.some(v => !/^\d+$/.test(sizeText(v)))) return review(`하의 옵션 표기를 ${config.profile.bottomSizes.join('/')}과 정확히 대응할 수 없습니다.`);
      sizing = `허용 하의 사이즈 ${wanted ?? '없음'}`;
    } else if (event.eventCategory === 'SHOE') {
      wanted = config.profile.shoeSize;
      if (!availableSizes.some(v => sizeText(v) === sizeText(wanted))
        && availableSizes.some(v => !/^\d{3}$/.test(sizeText(v)) || Number(sizeText(v)) < 200 || Number(sizeText(v)) > 350)) {
        return review(`신발 옵션 표기를 ${wanted}mm와 정확히 대응할 수 없습니다.`);
      }
      sizing = `신발 ${wanted}mm`;
    } else return { status: 'skipped', reason: '프로필에 지정되지 않은 상품 종류입니다.' };
    candidates = stocked.filter(item => sizeText(getSize(item) ?? '') === sizeText(wanted ?? '') && wanted);
  } else {
    candidates = stocked.filter(item => item.optionValues?.every(v => config.preferredOptions.some(x => normalize(x) === normalize(v.name))));
    sizing = '직접 지정 옵션';
  }
  if (!candidates.length) return { status: 'skipped', reason: '허용한 사이즈·옵션의 재고가 없습니다.', choices };
  // 공고 제목의 색상과 일치하는 조합을 우선하고, 그 외에는 원래 노출 순서를 유지합니다.
  candidates.sort((a, b) => score(b) - score(a));
  const item = candidates[0];
  return {
    status: 'planned', ...choice(item), choices,
    reason: sizing,
  };
}

/**
 * 상품 페이지의 실측표가 쓰는 goods-detail actual-size API 응답(data)을
 * extractSizeTable과 같은 { headers, rows } 형태로 바꿉니다. 0은 미측정이라 null로 둡니다.
 */
export function sizeTableFromApi(data) {
  const sizes = Array.isArray(data?.sizes) ? [...data.sizes].sort((a, b) => a.sequence - b.sequence) : [];
  if (!sizes.length || sizes.some(s => typeof s?.name !== 'string' || !Array.isArray(s.items))) return null;
  const headers = [...sizes[0].items].sort((a, b) => a.sequence - b.sequence).map(i => String(i.name).trim());
  if (!headers.some(x => /가슴단면/.test(x)) || !headers.includes('총장')) return null;
  return { headers, rows: sizes.map(s => {
    const values = new Map(s.items.map(i => [String(i.name).trim(), i.value]));
    return { size: s.name.trim(), values: headers.map(h => {
      const v = values.get(h);
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    }) };
  }) };
}

// 브라우저 DOM에서 실행됩니다. 사용자 입력이나 상품 설명의 코드는 실행하지 않습니다.
export function extractSizeTable() {
  const number = value => /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  const clean = value => value.replace(/^\d+\s*/, '').trim();
  for (const table of document.querySelectorAll('table')) {
    const headers = Array.from(table.querySelectorAll('thead th')).map(e => clean(e.textContent));
    if (!headers.some(x => /가슴단면/.test(x)) || !headers.includes('총장')) continue;
    const wrapper = table.closest('[class*="ActualSizeTable__ActiaulSizeWrap"]');
    if (wrapper) {
      const labels = Array.from(wrapper.querySelectorAll(':scope > ul > li')).map(e => e.textContent.trim());
      if (labels[0] !== 'cm') continue;
      const rows = Array.from(table.querySelectorAll('tbody tr')).filter(r => !r.querySelector('[colspan]'));
      const sizes = labels.slice(2);
      if (sizes.length !== rows.length) continue;
      return { headers, rows: rows.map((r, i) => ({ size: sizes[i], values: Array.from(r.querySelectorAll('td')).map(e => number(e.textContent)) })) };
    }
    // 일반적인 '사이즈 | 총장 | 가슴단면' 표도 지원합니다.
    if (/사이즈|size/i.test(headers[0] ?? '')) {
      return { headers: headers.slice(1), rows: Array.from(table.querySelectorAll('tbody tr')).map(r => {
        const cells = Array.from(r.querySelectorAll('th,td'));
        return { size: cells[0]?.textContent.trim(), values: cells.slice(1).map(e => number(e.textContent)) };
      }) };
    }
  }
  return null;
}
