/**
 * 「今天吃什么」推荐内核 —— 六维味道画像与匹配（契约：docs/taste-v1.md）。
 *
 * 纯 JS（ESM）、零依赖，host 与 client 两端共用。
 *
 * 味道统一为六维：**酸 sour / 甜 sweet / 苦 bitter / 辣 spicy / 咸 salty / 鲜 umami**，
 * 用户偏好取值 0–5（0 = 完全不要/无感，5 = 非常喜欢），菜品画像取值 1–5（1 = 极淡）。
 *
 * - {@link normalizeTaste}：把档案里的旧口味字段（sourFruit/sourFermented/sourVinegar 等）
 *   迁移成六维，可直接用于新旧 state.json。
 * - {@link dishTasteOf}：按确定性规则从 tags / sour / ingredients / 名称 / 描述 / 菜系 / 分类
 *   派生菜品六维画像，不改 data/dishes.js。
 * - {@link tasteMatch}：六维偏好与菜品画像的加权相似度，返回 -2 ～ +2。
 * - {@link summarizeTaste}：长期记录的六维口味画像统计（rating 加权；无记录回退偏好）。
 * - {@link learnFromMeal}：按「喜欢 / 不喜欢 / 中性」用 EWMA 更新 profile.taste（纯函数）。
 *
 * 旧导出 `dishSpicyRank / dishSourOf / dishOilinessOf / tasteProfileOf` 保留，
 * 基于新六维实现，避免 host/client 旧代码 import 报错。
 */

/** 六维味道枚举（顺序即统计页展示顺序）。 */
export const TASTE_DIMENSIONS = Object.freeze(['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami']);

/** 六维中文标签。 */
export const TASTE_LABELS = Object.freeze({
  sour: '酸',
  sweet: '甜',
  bitter: '苦',
  spicy: '辣',
  salty: '咸',
  umami: '鲜',
});

/**
 * 六维默认值（与契约 §1 的迁移默认值一致）。
 * 用户档案默认：酸 3 / 甜 2 / 苦 1 / 辣 3 / 咸 2 / 鲜 3。
 */
export const TASTE_DEFAULTS = Object.freeze({
  sour: 3,
  sweet: 2,
  bitter: 1,
  spicy: 3,
  salty: 2,
  umami: 3,
});

/** 辣度枚举（与 recommend.js 的 SPICY_LEVELS 保持一致；本地拷贝避免循环依赖）。 */
const SPICY_LEVELS = Object.freeze(['mild', 'medium', 'hot']);

/** 辣度 -> 1-3 序号（硬过滤用）。 */
const SPICY_RANK = Object.freeze({ mild: 1, medium: 2, hot: 3 });

/** 学习率（EWMA 平滑系数，六维与旧亲和度缓存共用）。 */
const LEARNING_RATE = 0.3;

/** 中性评分时旧亲和度缓存的衰减系数。 */
const NEUTRAL_DECAY = 0.7;

/** 统计时「明显」味道阈值：菜品维度 >= 该值才计入 liked / disliked。 */
const PROMINENT_TASTE = 4;

/** 统计时 rating 权重：喜欢 1.5 / 不喜欢 0.5 / 其余 1。 */
const RATING_WEIGHTS = Object.freeze({ liked: 1.5, disliked: 0.5, neutral: 1 });

/** 酸味关键词（命中至少 3）。 */
const SOUR_WORDS = /酸|醋|柠檬|青柠|酸汤|泡菜|酸菜|番茄|酸木瓜|酸角/;

/** 强酸味关键词（命中至少 4）。 */
const STRONG_SOUR_WORDS = /酸汤|酸木瓜|柠檬|青柠/;

/** 甜味关键词（命中 3）。 */
const SWEET_WORDS = /糖|蜜|甜|拔丝|糖醋|蜜汁|汤圆|糕点|糖水|菠萝饭/;

/** 强甜味关键词（命中 4）。 */
const STRONG_SWEET_WORDS = /糖醋|拔丝|蜜汁|糖水|蜜/;

/** 苦味关键词（命中 4）。 */
const BITTER_WORDS = /苦荞|苦菊|苦菜|芥菜/;

/** 强苦味关键词（命中 5）。 */
const STRONG_BITTER_WORDS = /苦瓜/;

/** 咸鲜类关键词（命中 4：腌制 / 卤味 / 芽菜 / 豆瓣）。 */
const STRONG_SALTY_WORDS = /咸菜|咸鱼|咸蛋|咸肉|腌|卤|盐水|芽菜|榨菜|泡菜|豆瓣|豆豉/;

/** 咸味关键词（命中 3）。 */
const SALTY_WORDS = /咸|酱|腊|火腿|培根|酱香|生抽|老抽|酱油|干煸|椒盐|孜然|酱爆|豉油/;

/** 鲜味食材关键词。 */
const UMAMI_INGREDIENTS = Object.freeze([
  '鱼', '虾', '蟹', '贝', '鸡', '牛', '猪', '菌', '菇', '豆腐',
  '酱油', '蚝油', '高汤', '海带', '紫菜',
  '肉末', '肉丝', '肉片', '排骨', '虾皮', '虾米', '干贝', '海米',
  '鸡蛋', '蛋', '芽菜', '豆瓣', '豆豉', '生抽', '老抽', '香菇', '蘑菇',
]);

/** 鲜味文案关键词（命中至少 3）。 */
const UMAMI_WORDS = /鲜|汤|炖|蒸|高汤|海鲜|火腿/;

/**
 * 把数字限制在区间内。
 *
 * @param {number} value 数值
 * @param {number} min 下界
 * @param {number} max 上界
 * @returns {number} 限制后的数值
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 取有限数字，非法返回 null。
 *
 * @param {unknown} value 原始值
 * @returns {number | null} 数值或 null
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 把 0–5 的偏好值 clamp 并保留 1 位小数。
 *
 * @param {number} value 数值
 * @returns {number} 0–5（1 位小数）
 */
function normalizeLevel(value) {
  return Math.round(clamp(value, 0, 5) * 10) / 10;
}

/**
 * 把菜品维度 clamp 并四舍五入到 1–5 整数。
 *
 * @param {number} value 数值
 * @returns {number} 1–5 整数
 */
function normalizeDishLevel(value) {
  return clamp(Math.round(value), 1, 5);
}

/**
 * 提取「口味来源对象」：既接受完整 profile（取 profile.taste），也接受 taste 本身。
 *
 * @param {object | null | undefined} input 输入
 * @returns {object} taste 形状的对象（可能为空对象）
 */
function tasteSourceOf(input) {
  if (!input || typeof input !== 'object') return {};
  if (input.taste && typeof input.taste === 'object') return input.taste;
  return input;
}

/**
 * 把档案里的口味字段迁移 / 归一化为六维 0–5（保留 1 位小数）。
 *
 * 迁移规则（契约 §1）：
 * - `sour`：旧字段 `sourFruit / sourFermented / sourVinegar` 取最大；全缺省时回退 3。
 *   （若已存在新 `sour` 字段则以新字段为准，保留显式 0 = 「不要酸」。）
 * - `spicy ?? 3`、`sweet ?? 2`、`bitter ?? 1`、`salty ?? 2`、`umami ?? 3`。
 * - 非法值 / 越界值 clamp 到 0–5。
 *
 * @param {object | null | undefined} input taste 对象或完整 profile
 * @returns {{ sour: number, sweet: number, bitter: number, spicy: number, salty: number, umami: number }} 六维偏好
 */
export function normalizeTaste(input) {
  const source = tasteSourceOf(input);
  const result = {};
  for (const dimension of TASTE_DIMENSIONS) {
    const direct = numberOrNull(source[dimension]);
    result[dimension] = direct === null ? TASTE_DEFAULTS[dimension] : normalizeLevel(direct);
  }
  // sour 的旧字段迁移：三个旧酸字段取最大，全缺省时用默认 3
  if (numberOrNull(source.sour) === null) {
    const legacySour = Math.max(
      numberOrNull(source.sourFruit) ?? 0,
      numberOrNull(source.sourFermented) ?? 0,
      numberOrNull(source.sourVinegar) ?? 0,
    );
    result.sour = legacySour > 0 ? normalizeLevel(legacySour) : TASTE_DEFAULTS.sour;
  }
  return result;
}

/**
 * 取用户六维口味偏好（0–5）。
 *
 * @param {object | null | undefined} profile 用户档案
 * @returns {{ sour: number, sweet: number, bitter: number, spicy: number, salty: number, umami: number }} 六维偏好
 */
export function tastePreferenceOf(profile) {
  return normalizeTaste(tasteSourceOf(profile));
}

/**
 * 拼出用于关键词匹配的菜品文本（名称 + 描述 + 食材）。
 *
 * @param {object | null | undefined} dish 菜品
 * @returns {string} 中文文本
 */
function dishTextOf(dish) {
  const parts = [];
  if (dish && typeof dish.name === 'string') parts.push(dish.name);
  if (dish && typeof dish.description === 'string') parts.push(dish.description);
  if (dish && Array.isArray(dish.ingredients)) {
    for (const ingredient of dish.ingredients) {
      if (typeof ingredient === 'string' && ingredient !== '') parts.push(ingredient);
    }
  }
  return parts.join(' ');
}

/**
 * 取菜品 tags（去重字符串数组）。
 *
 * @param {object | null | undefined} dish 菜品
 * @returns {string[]} tags
 */
function dishTagsOf(dish) {
  return dish && Array.isArray(dish.tags) ? dish.tags.filter((tag) => typeof tag === 'string') : [];
}

/**
 * 派生菜品六维味道画像（1–5 整数，确定性规则见契约 §2）。
 *
 * 规则摘要：辣来自 tags + 文案；酸来自 dish.sour 基线 + 酸味词；甜 / 苦 / 咸 / 鲜
 * 来自关键词、菜系、分类与食材，全部 clamp 到 1–5 并取整。
 *
 * @param {object | null | undefined} dish 菜品
 * @returns {{ sour: number, sweet: number, bitter: number, spicy: number, salty: number, umami: number }} 六维画像
 */
export function dishTasteOf(dish) {
  const source = dish && typeof dish === 'object' ? dish : {};
  const text = dishTextOf(source);
  const tags = dishTagsOf(source);

  // 辣：tags 决定基线，文案「爆辣/重辣/特辣」+1，「微辣」= 2
  let spicy = tags.includes('hot') ? 5 : tags.includes('medium') ? 3 : tags.includes('mild') ? 2 : 1;
  if (/爆辣|重辣|特辣|超辣/.test(text)) spicy = Math.min(5, spicy + 1);
  if (/微辣/.test(text)) spicy = 2;

  // 酸：dish.sour 三值最大值为基线；酸味词至少 3，强酸味词至少 4
  const sourRaw = source.sour && typeof source.sour === 'object'
    ? Math.max(
      numberOrNull(source.sour.fruit) ?? 0,
      numberOrNull(source.sour.fermented) ?? 0,
      numberOrNull(source.sour.vinegar) ?? 0,
    )
    : 0;
  let sour = clamp(Math.round(sourRaw), 0, 5);
  if (STRONG_SOUR_WORDS.test(text)) sour = Math.max(sour, 4);
  else if (SOUR_WORDS.test(text)) sour = Math.max(sour, 3);

  // 甜：甜味词 3–4，江浙 / 粤菜 +1，否则 2
  let sweet = 2;
  if (STRONG_SWEET_WORDS.test(text)) sweet = 4;
  else if (SWEET_WORDS.test(text)) sweet = 3;
  if (source.cuisine === '江浙' || source.cuisine === '粤菜') sweet += 1;

  // 苦：苦瓜 5，苦荞 / 苦菊 / 苦菜 / 芥菜 4，咖啡 / 茶 / 泛「苦」3，否则 1
  let bitter = 1;
  if (STRONG_BITTER_WORDS.test(text)) bitter = 5;
  else if (BITTER_WORDS.test(text)) bitter = 4;
  else if (/咖啡|茶/.test(text)) bitter = 3;
  else if (/苦/.test(text)) bitter = 3;

  // 咸：腌制 / 卤味 4，咸 / 酱 / 腊味 3，北方 / 西北 +1，汤羹 +1
  let salty = 2;
  if (STRONG_SALTY_WORDS.test(text)) salty = 4;
  else if (SALTY_WORDS.test(text)) salty = 3;
  if (source.cuisine === '北方' || source.cuisine === '西北') salty += 1;
  if (source.category === '汤羹') salty += 1;

  // 鲜：鲜味食材数量决定基础（1 个 3、2 个以上 4），seafood / soup +1，鲜/汤/炖/蒸类文案至少 3
  let umami = 2;
  const ingredients = Array.isArray(source.ingredients) ? source.ingredients : [];
  let umamiHits = 0;
  for (const ingredient of ingredients) {
    if (typeof ingredient !== 'string' || ingredient === '') continue;
    if (UMAMI_INGREDIENTS.some((keyword) => ingredient.includes(keyword))) umamiHits += 1;
  }
  if (umamiHits >= 2) umami = 4;
  else if (umamiHits === 1) umami = 3;
  if (tags.includes('seafood') || tags.includes('soup')) umami += 1;
  if (UMAMI_WORDS.test(text)) umami = Math.max(umami, 3);

  return {
    sour: normalizeDishLevel(sour),
    sweet: normalizeDishLevel(sweet),
    bitter: normalizeDishLevel(bitter),
    spicy: normalizeDishLevel(spicy),
    salty: normalizeDishLevel(salty),
    umami: normalizeDishLevel(umami),
  };
}

/**
 * 计算单道菜与用户六维口味的相似度（契约 §4）。
 *
 * 公式：`sum((pref[i] - 3) * (dish[i] - 3)) / 30`，clamp 到 -1..1 后放大到 -2..+2。
 * 两维都在 3 附近时贡献为 0；用户喜欢且菜品明显 / 用户不喜欢且菜品不明显的组合为正。
 *
 * @param {object | null | undefined} dish 菜品
 * @param {object | null | undefined} profile 用户档案
 * @returns {number} -2 ～ +2 的匹配度（保留 2 位小数）
 */
export function tasteMatch(dish, profile) {
  if (!dish || typeof dish !== 'object') return 0;
  const preference = tastePreferenceOf(profile);
  const dishTaste = dishTasteOf(dish);
  let total = 0;
  for (const dimension of TASTE_DIMENSIONS) {
    total += (preference[dimension] - 3) * (dishTaste[dimension] - 3);
  }
  const normalized = clamp(total / 30, -1, 1);
  return Math.round(normalized * 2 * 100) / 100;
}

/**
 * 取菜品的辣度序号（1-3，硬过滤用）；缺 tags 时按六维辛辣度回退中辣。
 *
 * @param {object} dish 菜品
 * @returns {number} 1-3
 */
export function dishSpicyRank(dish) {
  const tags = dishTagsOf(dish);
  const found = tags.find((tag) => SPICY_LEVELS.includes(tag));
  if (found) return SPICY_RANK[found];
  const spicy = dishTasteOf(dish).spicy;
  if (spicy >= 4) return 3;
  if (spicy >= 2) return 2;
  return 1;
}

/**
 * 取菜品的酸味分量（fruit/fermented/vinegar，0-5，供旧打分代码使用）。
 *
 * 优先使用 data 里的 `dish.sour` 三分量；缺省时用六维画像的 sour 兜底。
 *
 * @param {object} dish 菜品
 * @returns {{ fruit: number, fermented: number, vinegar: number }} 三个酸味分值（0-5）
 */
export function dishSourOf(dish) {
  const sour = dish && typeof dish === 'object' && dish.sour && typeof dish.sour === 'object' ? dish.sour : {};
  const fruit = clamp(numberOrNull(sour.fruit) ?? 0, 0, 5);
  const fermented = clamp(numberOrNull(sour.fermented) ?? 0, 0, 5);
  const vinegar = clamp(numberOrNull(sour.vinegar) ?? 0, 0, 5);
  if (fruit > 0 || fermented > 0 || vinegar > 0) return { fruit, fermented, vinegar };
  const fallback = dishTasteOf(dish).sour;
  return { fruit: fallback, fermented: fallback, vinegar: fallback };
}

/**
 * 估算菜品油腻度（0-5）：优先 dish.oiliness，其次脂肪克数，再其次 tag / 分类。
 *
 * 油腻度不是味道维度，仅参与推荐打分与旧接口兼容。
 *
 * @param {object} dish 菜品
 * @returns {number} 油腻度 0-5
 */
export function dishOilinessOf(dish) {
  if (dish && Number.isFinite(Number(dish.oiliness))) return clamp(Number(dish.oiliness), 0, 5);
  const fat = dish && dish.nutrition && Number(dish.nutrition.fat);
  if (Number.isFinite(fat)) return clamp(Math.round(fat / 8), 0, 5);
  const tags = dishTagsOf(dish);
  if (tags.includes('light')) return 1;
  if (dish && dish.category === '火锅烧烤') return 4;
  if (tags.includes('soup')) return 2;
  return 3;
}

/**
 * 旧口味档案读取接口（兼容 host/client 旧代码）。
 *
 * 返回六维偏好，并保留 `oiliness` / `adventurous` 两个非味道偏好。
 *
 * @param {object | null | undefined} profile 用户档案
 * @returns {{ sour: number, sweet: number, bitter: number, spicy: number, salty: number, umami: number, oiliness: number, adventurous: number }} 口味档案
 */
export function tasteProfileOf(profile) {
  const taste = tasteSourceOf(profile);
  const normalized = normalizeTaste(taste);
  return {
    ...normalized,
    oiliness: normalizeTasteLevelOr(taste.oiliness, 3),
    adventurous: normalizeTasteLevelOr(taste.adventurous, 3),
  };
}

/**
 * 读取 1–5 的非味道偏好（oiliness / adventurous），非法回退。
 *
 * @param {unknown} value 原始值
 * @param {number} fallback 回退值
 * @returns {number} 1–5（1 位小数）
 */
function normalizeTasteLevelOr(value, fallback) {
  const number = numberOrNull(value);
  return number === null ? fallback : Math.round(clamp(number, 1, 5) * 10) / 10;
}

/**
 * 口味统计的中文摘要（取 value≥4 的前 3 个；不足时取最高 2 个；全低时「口味均衡」）。
 *
 * @param {Array<{id: string, value: number}>} dimensions 六维
 * @param {'records'|'preference'} mode 数据来源
 * @returns {{ topTastes: string[], summary: string }} 摘要
 */
function summarizeDimensions(dimensions, mode) {
  const ranked = [...dimensions].sort((left, right) => (right.value !== left.value ? right.value - left.value : 0));
  const high = ranked.filter((item) => item.value >= 4);
  const prefix = mode === 'preference' ? '偏好设置：' : '';
  // 取 value≥4 的前 3 个；不足 3 个时取 value 最高的 2 个；全低时「口味均衡」
  let selected;
  if (high.length >= 3) selected = high.slice(0, 3);
  else if (ranked.length > 0 && ranked[0].value >= 3) selected = ranked.slice(0, 2);
  else selected = [];
  if (selected.length === 0) return { topTastes: [], summary: `${prefix}口味均衡` };
  return {
    topTastes: selected.map((item) => item.id),
    summary: `${prefix}偏爱：${selected.map((item) => TASTE_LABELS[item.id]).join('、')}`,
  };
}

/**
 * 把菜谱库整理成 id -> dish 的索引（数组 / Map / 普通对象都支持）。
 *
 * @param {Array | Map | object | null | undefined} catalog 菜谱库
 * @returns {Map<string, object> | null} 索引
 */
function catalogIndex(catalog) {
  if (!catalog) return null;
  if (catalog instanceof Map) return catalog;
  const index = new Map();
  if (Array.isArray(catalog)) {
    for (const dish of catalog) {
      if (dish && typeof dish === 'object' && typeof dish.id === 'string') index.set(dish.id, dish);
    }
    return index;
  }
  if (typeof catalog === 'object') {
    for (const [id, dish] of Object.entries(catalog)) {
      if (dish && typeof dish === 'object') index.set(typeof dish.id === 'string' ? dish.id : id, dish);
    }
    return index;
  }
  return null;
}

/**
 * 六维口味画像统计（从长期用餐记录）。
 *
 * 规则（契约 §3）：
 * - 每条 meals 按 dishId 从 catalog 找菜，找不到则跳过；
 * - 权重：rating=1 → 1.5、rating=-1 → 0.5、其余 → 1；
 * - 每维 value = Σ(菜品维度 × 权重) / Σ权重，保留 1 位小数；
 * - `liked` / `disliked`：该维度「明显」（菜品维度 ≥ 4）的喜欢 / 不喜欢次数；
 * - 无记录（samples = 0）时 value 回退到 normalizeTaste(profile.taste)，summary 用「偏好设置」。
 *
 * 兼容两种调用：`summarizeTaste(meals, catalog, profile)` 与
 * `summarizeTaste({ meals, catalog, profile })`。
 *
 * @param {Array<{dishId?: string, dish?: object, rating?: number}> | object} meals 用餐记录（或参数对象）
 * @param {Array | Map | object | null} [catalog] 菜谱库
 * @param {object | null} [profile] 用户档案
 * @returns {{ samples: number, dimensions: Array<{id: string, label: string, value: number, liked: number, disliked: number}>, topTastes: string[], summary: string }} 口味统计
 */
export function summarizeTaste(meals, catalog, profile) {
  let mealList = meals;
  let dishCatalog = catalog;
  let userProfile = profile;
  if (meals && !Array.isArray(meals) && typeof meals === 'object' && ('meals' in meals || 'catalog' in meals || 'profile' in meals)) {
    mealList = meals.meals;
    dishCatalog = meals.catalog;
    userProfile = meals.profile;
  }
  const records = Array.isArray(mealList) ? mealList : [];
  const index = catalogIndex(dishCatalog);
  const sums = {};
  const weights = {};
  const liked = {};
  const disliked = {};
  for (const dimension of TASTE_DIMENSIONS) {
    sums[dimension] = 0;
    weights[dimension] = 0;
    liked[dimension] = 0;
    disliked[dimension] = 0;
  }
  let samples = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const dishId = typeof record.dishId === 'string' && record.dishId !== ''
      ? record.dishId
      : record.dish && typeof record.dish.id === 'string' ? record.dish.id : '';
    let dish = dishId && index ? index.get(dishId) : null;
    if (!dish && record.dish && typeof record.dish === 'object') dish = record.dish;
    if (!dish) continue;
    const rating = numberOrNull(record.rating);
    const weight = rating === 1 ? RATING_WEIGHTS.liked : rating === -1 ? RATING_WEIGHTS.disliked : RATING_WEIGHTS.neutral;
    const dishTaste = dishTasteOf(dish);
    for (const dimension of TASTE_DIMENSIONS) {
      sums[dimension] += dishTaste[dimension] * weight;
      weights[dimension] += weight;
      if (dishTaste[dimension] >= PROMINENT_TASTE) {
        if (rating === 1) liked[dimension] += 1;
        else if (rating === -1) disliked[dimension] += 1;
      }
    }
    samples += 1;
  }

  const preference = tastePreferenceOf(userProfile);
  const dimensions = TASTE_DIMENSIONS.map((dimension) => ({
    id: dimension,
    label: TASTE_LABELS[dimension],
    value: samples === 0
      ? preference[dimension]
      : Math.round((sums[dimension] / weights[dimension]) * 10) / 10,
    liked: liked[dimension],
    disliked: disliked[dimension],
  }));
  const { topTastes, summary } = summarizeDimensions(dimensions, samples === 0 ? 'preference' : 'records');
  return { samples, dimensions, topTastes, summary };
}

/**
 * 深拷贝 profile 里会被修改的部分（保证不修改入参）。
 *
 * @param {object | null | undefined} profile 用户档案
 * @returns {object} 可安全修改的副本
 */
function cloneProfile(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const learned = source.learned && typeof source.learned === 'object' ? source.learned : {};
  const cloneGroup = (group) => {
    if (!group || typeof group !== 'object') return {};
    const copy = {};
    for (const [key, value] of Object.entries(group)) copy[key] = value;
    return copy;
  };
  return {
    ...source,
    taste: { ...tasteSourceOf(source) },
    learned: {
      ...learned,
      dishes: cloneGroup(learned.dishes),
      cuisines: cloneGroup(learned.cuisines),
    },
  };
}

/**
 * 从一次用餐评分学习六维口味（EWMA），返回更新后的 profile（不修改入参）。
 *
 * - rating > 0（喜欢）：口味朝菜品维度靠拢；
 * - rating < 0（不喜欢）：口味朝「反味道」（6 - 菜品维度）靠拢；
 * - rating = 0（中性）：六维不变，只衰减旧的 learned 亲和度缓存。
 *
 * 同时保留旧版 `learned.dishes / learned.cuisines` 亲和度缓存（向后兼容），
 * 但推荐打分已改为纯六维匹配，该缓存仅供旧数据读取。
 *
 * @param {object | null | undefined} profile 用户档案
 * @param {object | null | undefined} dish 菜品
 * @param {number} [rating=0] 评分：1 喜欢 / -1 不喜欢 / 0 中性
 * @returns {object} 新的 profile（taste 为六维 0–5）
 */
export function learnFromMeal(profile, dish, rating = 0) {
  const next = cloneProfile(profile);
  const numericRating = numberOrNull(rating);
  const target = numericRating === null ? 0 : numericRating > 0 ? 1 : numericRating < 0 ? -1 : 0;
  if (!dish || typeof dish !== 'object' || typeof dish.id !== 'string' || dish.id === '') return next;

  const preference = normalizeTaste(next.taste);
  if (target !== 0) {
    const dishTaste = dishTasteOf(dish);
    for (const dimension of TASTE_DIMENSIONS) {
      const desired = target > 0 ? dishTaste[dimension] : 6 - dishTaste[dimension];
      preference[dimension] = Math.round(clamp(preference[dimension] + LEARNING_RATE * (desired - preference[dimension]), 0, 5) * 10) / 10;
    }
  }
  // 迁移后保留旧字段（不删）：新六维覆盖，旧字段原样保留供旧代码读取
  next.taste = { ...next.taste, ...preference };

  // 旧版亲和度缓存（保留兼容；新 tasteMatch 不再依赖它）
  const updateAffinity = (previous, direction) => {
    const value = Number.isFinite(Number(previous)) ? clamp(Number(previous), -1, 1) : 0;
    if (direction === 0) return value * NEUTRAL_DECAY;
    return clamp(value + LEARNING_RATE * (direction - value), -1, 1);
  };
  const dishValue = updateAffinity(next.learned.dishes[dish.id], target);
  if (Math.abs(dishValue) < 0.05) delete next.learned.dishes[dish.id];
  else next.learned.dishes[dish.id] = Math.round(dishValue * 1000) / 1000;
  if (typeof dish.cuisine === 'string' && dish.cuisine !== '') {
    const cuisineValue = updateAffinity(next.learned.cuisines[dish.cuisine], target);
    if (Math.abs(cuisineValue) < 0.05) delete next.learned.cuisines[dish.cuisine];
    else next.learned.cuisines[dish.cuisine] = Math.round(cuisineValue * 1000) / 1000;
  }
  return next;
}
