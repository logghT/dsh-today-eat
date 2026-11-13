/**
 * 「今天吃什么」推荐内核 —— 新饮食阶段的动态适配规则。
 *
 * 1000 道菜仍带旧四维 phases（fitness/healthy/relax/indulgence）；
 * 这里按营养、食材、标签与分类，给九个新阶段计算 1–5 的适配分，
 * 并提供少量加减分和「纯素/蛋奶素」硬过滤。
 *
 * 纯 JS、零依赖，host 与 client 共用。
 */
import { canonicalPhaseKind } from './phase.js';

/** 取数字，非法回退 0。 */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * 菜品营养：优先 data 里的 nutrition 对象，兼容旧的顶层字段。
 *
 * @param {object} dish 菜品
 * @returns {object} 营养对象
 */
function nutritionOf(dish) {
  return dish && typeof dish.nutrition === 'object' && dish.nutrition !== null ? dish.nutrition : (dish || {});
}

/**
 * 读取营养数值（nutrition.protein 优先，回退 dish.protein）。
 *
 * @param {object} dish 菜品
 * @param {string} key 字段
 * @returns {number} 数值
 */
function metricOf(dish, key) {
  const nutrition = nutritionOf(dish);
  const value = nutrition[key] !== undefined ? nutrition[key] : dish && dish[key];
  return num(value);
}

/** 菜品标签数组（小写）。 */
function tagList(dish) {
  const raw = dish && dish.tags;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,，、|]+/) : [];
  return list.map((tag) => String(tag).toLowerCase());
}

/** 食材名数组（小写）。 */
function ingredientsOf(dish) {
  const list = dish && Array.isArray(dish.ingredients) ? dish.ingredients : [];
  return list.map((item) => String(item && item.name ? item.name : item).toLowerCase());
}

/** 文本里是否出现任一关键词。 */
function includesAny(values, keywords) {
  const text = Array.isArray(values) ? values.join(' ') : String(values || '');
  return keywords.some((keyword) => text.includes(keyword));
}

/** 是否含某类标签。 */
function hasTag(dish, keyword) {
  return tagList(dish).some((tag) => tag.includes(keyword));
}

/** 辣度 0–3（mild→1 / medium→2 / hot→3）。 */
function spicyRank(dish) {
  const tags = tagList(dish);
  if (tags.some((tag) => tag.includes('特辣') || tag.includes('爆辣'))) return 3;
  if (tags.some((tag) => tag.includes('中辣') || tag.includes('香辣') || tag.includes('麻辣'))) return 2;
  if (tags.some((tag) => tag.includes('微辣') || tag.includes('小辣'))) return 1;
  return 0;
}

/** 是否油炸 / 重油做法。 */
function isFried(dish) {
  return (
    ingredientsOf(dish).some((name) => includesAny(name, ['炸', '酥', '油条', '薯条', '天妇罗', '油饼'])) ||
    hasTag(dish, '油炸') ||
    metricOf(dish, 'fat') >= 30
  );
}

/** 是否腌制 / 加工肉 / 重酱。 */
function isProcessed(dish) {
  const text = [...ingredientsOf(dish), ...tagList(dish)].join(' ');
  return includesAny(text, ['腌', '腊', '酱肉', '火腿', '香肠', '培根', '榨菜', '泡菜', '咸菜', '腐乳', '咸鱼', '午餐肉']);
}

/** 是否明显甜口 / 含糖。 */
function isSweet(dish) {
  const text = [...ingredientsOf(dish), ...tagList(dish)].join(' ');
  return includesAny(text, ['糖', '蜂蜜', '可乐', '蛋糕', '甜', '炼乳', '冰糖', '蜜']);
}

/** 是否全谷 / 杂粮 / 豆类。 */
function isWholeGrain(dish) {
  const text = [...ingredientsOf(dish), ...tagList(dish)].join(' ');
  return includesAny(text, ['糙米', '燕麦', '全麦', '荞麦', '藜麦', '玉米', '红薯', '紫薯', '豆类', '黑米', '小米', '鹰嘴豆']);
}

/** 是否软烂 / 汤粥类。 */
function isSoft(dish) {
  return (
    ['汤羹', '早餐'].includes(String(dish.category || '')) ||
    includesAny([dish.name || '', ...ingredientsOf(dish)], ['粥', '汤', '羹', '蒸蛋', '豆腐', '土豆泥', '面'])
  );
}

/** 是否生食 / 凉菜。 */
function isRaw(dish) {
  const text = [...ingredientsOf(dish), ...tagList(dish)].join(' ');
  return includesAny(text, ['生', '刺身', '凉拌', '沙拉', '凉菜']);
}

/** 是否含酒精。 */
function hasAlcohol(dish) {
  const text = [...ingredientsOf(dish), ...tagList(dish)].join(' ');
  return includesAny(text, ['酒', '料酒', '米酒', '黄酒', '啤酒', '白酒']);
}

/** 是否高汞鱼 / 生食海鲜。 */
function hasHighMercury(dish) {
  const text = [...ingredientsOf(dish), ...tagList(dish)].join(' ');
  return includesAny(text, ['金枪鱼', '旗鱼', '鲨鱼', '剑鱼', '生鱼片', '刺身']);
}

/** 是否含肉 / 海鲜 / 蛋 / 奶。 */
function animalProfile(dish) {
  const text = [...ingredientsOf(dish), ...tagList(dish)].join(' ');
  // 「鸡蛋/鸭蛋/蛋糕」里的「鸡/鸭」不算肉；先去掉蛋类词再判断肉。
  const meatText = text.replace(/鸡蛋|鸭蛋|鹅蛋|鹌鹑蛋|蛋/g, '');
  const meat = includesAny(meatText, ['猪', '牛', '羊', '鸡', '鸭', '鹅', '肉', '排骨', '火腿', '培根', '香肠', '肉丸']);
  const seafood = includesAny(text, ['鱼', '虾', '蟹', '贝', '蛤', '鱿', '墨鱼', '海参', '鲍', '海鲜']);
  const egg = includesAny(text, ['蛋']);
  const dairy = includesAny(text, ['牛奶', '酸奶', '奶酪', '芝士', '黄油', '淡奶油', '奶']);
  return { meat, seafood, egg, dairy, any: meat || seafood || egg || dairy };
}

/** 旧四维适配分（缺失视为 3）。 */
function legacyFit(dish, key) {
  const value = dish && dish.phases ? Number(dish.phases[key]) : NaN;
  return Number.isFinite(value) ? Math.min(5, Math.max(1, value)) : 3;
}

/** 限幅到 1–5 的整数。 */
function clampFit(value) {
  return Math.max(1, Math.min(5, Math.round(value)));
}

/** 蔬菜份数。 */
function vegOf(dish) {
  return num(dish.nutrition && dish.nutrition.veg !== undefined ? dish.nutrition.veg : dish.veg);
}

/**
 * 计算菜品对某新阶段的适配分（1–5）。
 *
 * @param {object} dish 菜品
 * @param {string} kind 阶段（可旧名）
 * @param {string | null} [subgoal] 子目标
 * @returns {number} 1–5
 */
export function phaseFitFor(dish, kind, subgoal) {
  const canonical = canonicalPhaseKind(kind) ?? 'performance';
  const sub = String(subgoal || '');
  let score = 3;
  const spicy = spicyRank(dish);
  const protein = metricOf(dish, 'protein');
  const fat = metricOf(dish, 'fat');
  const carbs = metricOf(dish, 'carbs');
  const kcal = metricOf(dish, 'kcal');
  const veg = vegOf(dish);
  const fried = isFried(dish);
  const processed = isProcessed(dish);
  const sweet = isSweet(dish);
  const animal = animalProfile(dish);

  if (canonical === 'performance') {
    score = legacyFit(dish, 'fitness');
    if (protein >= 30) score += 1;
    if (fat >= 30) score -= 1;
    if (sub === 'muscle_gain' && protein >= 25) score += 1;
    if (sub === 'fat_loss' && kcal > 900) score -= 1;
  } else if (canonical === 'low_sugar') {
    score = legacyFit(dish, 'healthy') - 0.5;
    if (carbs <= 45) score += 1;
    if (carbs >= 70) score -= 1;
    if (sweet) score -= 2;
    if (protein >= 20) score += 1;
    if (veg >= 2) score += 1;
    if (['米饭', '面食'].includes(String(dish.category))) score -= 0.5;
    if (sub === 'low_gi' && isWholeGrain(dish)) score += 1;
  } else if (canonical === 'low_sodium') {
    score = legacyFit(dish, 'healthy');
    if (processed) score -= 2;
    if (spicy >= 2) score -= 1;
    if (['火锅烧烤'].includes(String(dish.category))) score -= 2;
    if (fat >= 25) score -= 1;
    if (veg >= 2) score += 1;
    if (metricOf(dish, 'kcal') > 0 && metricOf(dish, 'kcal') <= 400) score += 0.5;
    if (sub === 'heart' && fat <= 12) score += 1;
  } else if (canonical === 'gentle') {
    score = legacyFit(dish, 'healthy') - 0.5;
    if (spicy >= 3) score -= 2;
    else if (spicy >= 2) score -= 1;
    if (fried) score -= 2;
    if (isRaw(dish)) score -= 2;
    if (fat >= 25) score -= 1;
    if (isSoft(dish)) score += 1;
    if (['汤羹', '早餐'].includes(String(dish.category))) score += 1;
    if (sub === 'easy_digest' && isSoft(dish)) score += 1;
    if (metricOf(dish, 'protein') >= 25) score += 0.5;
  } else if (canonical === 'high_fiber') {
    score = legacyFit(dish, 'healthy') - 0.5;
    if (veg >= 3) score += 2;
    else if (veg >= 2) score += 1;
    else if (veg <= 1) score -= 1;
    if (isWholeGrain(dish)) score += 1;
    if (animal.any && veg === 0) score -= 1;
    if (sub === 'gut' && (isWholeGrain(dish) || veg >= 2)) score += 1;
  } else if (canonical === 'plant_based') {
    score = legacyFit(dish, 'healthy');
    if (animal.any) score -= 2;
    if (animal.meat || animal.seafood) score -= 2;
    if (animal.egg || animal.dairy) score -= 0.5;
    if (veg >= 2) score += 1;
    if (isWholeGrain(dish)) score += 1;
    if (sub === 'vegan' && animal.any) score = 1;
    if (sub === 'lacto_ovo' && (animal.meat || animal.seafood)) score = 1;
  } else if (canonical === 'special') {
    score = legacyFit(dish, 'healthy');
    if (sub === 'prenatal') {
      if (hasAlcohol(dish) || hasHighMercury(dish) || isRaw(dish)) score -= 3;
      if (protein >= 25) score += 1;
      if (veg >= 2) score += 1;
      if (isSoft(dish)) score += 0.5;
    } else if (sub === 'senior') {
      if (isSoft(dish)) score += 1;
      if (protein >= 25) score += 1;
      if (spicy >= 2 || fried) score -= 1;
      if (processed) score -= 1;
    } else if (sub === 'teen') {
      if (protein >= 25) score += 1;
      if (kcal >= 500) score += 1;
      if (veg >= 2) score += 0.5;
    }
  } else if (canonical === 'recovery') {
    score = legacyFit(dish, 'healthy') - 0.5;
    if (protein >= 25) score += 2;
    else if (protein >= 15) score += 1;
    if (isSoft(dish)) score += 1;
    if (fried || spicy >= 2) score -= 2;
    if (fat >= 25) score -= 1;
    if (['汤羹', '家常菜'].includes(String(dish.category))) score += 0.5;
    if (sub === 'post_surgery' && isSoft(dish)) score += 1;
  } else if (canonical === 'treat') {
    score = Math.max(legacyFit(dish, 'indulgence'), legacyFit(dish, 'relax'));
    if (kcal >= 600) score += 1;
    if (fried || sweet) score += 1;
    if (spicy >= 2) score += 0.5;
    if (veg >= 3 && kcal < 400) score -= 1;
    if (sub === 'celebrate' && kcal >= 500) score += 1;
  }

  return clampFit(score);
}

/**
 * 阶段相关的额外加减分（叠加在适配分之外，限幅 ±10）。
 *
 * @param {object} dish 菜品
 * @param {string} kind 阶段
 * @param {string | null} [subgoal] 子目标
 * @returns {number} -10–10
 */
export function phaseScoreAdjustment(dish, kind, subgoal) {
  const canonical = canonicalPhaseKind(kind) ?? 'performance';
  const sub = String(subgoal || '');
  let score = 0;
  const protein = metricOf(dish, 'protein');
  const carbs = metricOf(dish, 'carbs');
  const fat = metricOf(dish, 'fat');
  const veg = vegOf(dish);
  const animal = animalProfile(dish);

  if (canonical === 'low_sugar') {
    if (carbs >= 70) score -= 5;
    if (isSweet(dish)) score -= 6;
    if (protein >= 20) score += 3;
    if (sub === 'low_gi' && isWholeGrain(dish)) score += 3;
  } else if (canonical === 'low_sodium') {
    if (isProcessed(dish)) score -= 6;
    if (spicyRank(dish) >= 2) score -= 3;
    if (fat <= 12) score += 2;
    if (veg >= 2) score += 3;
  } else if (canonical === 'gentle') {
    if (spicyRank(dish) >= 3) score -= 8;
    else if (spicyRank(dish) >= 2) score -= 4;
    if (isFried(dish)) score -= 6;
    if (isSoft(dish)) score += 4;
    if (isRaw(dish)) score -= 5;
  } else if (canonical === 'high_fiber') {
    if (veg >= 3) score += 5;
    else if (veg <= 1) score -= 4;
    if (isWholeGrain(dish)) score += 3;
  } else if (canonical === 'plant_based') {
    if (animal.any) score -= 8;
    if (animal.meat || animal.seafood) score -= 4;
    if (veg >= 2) score += 4;
    if (isWholeGrain(dish)) score += 2;
  } else if (canonical === 'special') {
    if (sub === 'prenatal') {
      if (hasAlcohol(dish) || hasHighMercury(dish) || isRaw(dish)) score -= 10;
      if (protein >= 25) score += 2;
    } else if (sub === 'senior') {
      if (isSoft(dish)) score += 3;
      if (processed || isFried(dish)) score -= 3;
    } else if (sub === 'teen') {
      if (protein >= 25) score += 2;
      if (veg >= 2) score += 2;
    }
  } else if (canonical === 'recovery') {
    if (protein >= 25) score += 4;
    if (isSoft(dish)) score += 3;
    if (isFried(dish) || spicyRank(dish) >= 2) score -= 6;
    if (fat >= 25) score -= 3;
  } else if (canonical === 'treat') {
    if (metricOf(dish, 'kcal') >= 600) score += 3;
    if (isFried(dish) || isSweet(dish)) score += 2;
  }

  return Math.max(-10, Math.min(10, score));
}

/**
 * 阶段硬过滤：纯素 / 蛋奶素会直接排除动物性菜品；其他阶段不硬过滤。
 *
 * @param {object} dish 菜品
 * @param {string} kind 阶段
 * @param {string | null} [subgoal] 子目标
 * @returns {boolean} 是否可进入候选
 */
export function phaseHardEligible(dish, kind, subgoal) {
  const canonical = canonicalPhaseKind(kind);
  if (canonical !== 'plant_based') return true;
  const animal = animalProfile(dish);
  const sub = String(subgoal || '');
  if (sub === 'vegan') return !animal.any;
  if (sub === 'lacto_ovo') return !animal.meat && !animal.seafood;
  return true;
}
