/**
 * 「今天吃什么」推荐内核。
 *
 * 纯 JS（ESM）、零依赖，host 与 client 两端共用；不依赖 DOM / Node 专有 API，
 * 日期以参数注入（Date、时间戳或 YYYY-MM-DD 字符串均可），便于测试与回放。
 *
 * 设计约定：
 * - 同一 (date, meal, preferences) 输入恒得同一结果（stableStringify + 种子 RNG）。
 * - preferences 为硬过滤；价格 / 辣度未设上限时只做软加权。
 * - 近 7 天 history 里的菜默认排除；新鲜候选不足 8 道时降权放宽，
 *   并通过返回值的 fallbackNote 说明放宽原因。
 */
import { DISHES } from '../../data/dishes.js';
import { createRng, hashString, pickWeighted, stableStringify } from './rng.js';
import { canonicalPhaseKind, normalizePhase, phaseLabel, phaseTargets } from './phase.js';
import { dishEligible, dishPhaseFit, dishScore } from './scoring.js';
import { TASTE_DIMENSIONS, TASTE_LABELS, dishTasteOf } from './taste.js';
import { shiftDateKey } from './time.js';

/** 四档餐次：早餐 / 午餐 / 晚餐 / 夜宵。 */
export const MEALS = Object.freeze(['breakfast', 'lunch', 'dinner', 'night']);

/** 菜品分类枚举（与 data/dishes.js 的 category 字段一致）。 */
export const CATEGORIES = Object.freeze(['米饭', '面食', '汤羹', '小吃', '家常菜', '火锅烧烤', '轻食', '早餐']);

/** 菜系枚举（与 data/dishes.js 的 cuisine 字段一致）。 */
export const CUISINES = Object.freeze(['云南菜', '川菜', '粤菜', '湘菜', '江浙', '北方', '西北', '西南', '日韩', '西式', '快餐']);

/** 辣度枚举，从低到高依次为微辣 / 中辣 / 重辣。 */
export const SPICY_LEVELS = Object.freeze(['mild', 'medium', 'hot']);

/** 近 7 天窗口：用于 history 排除与 pruneHistory 的默认天数。 */
const HISTORY_WINDOW_DAYS = 7;

/** 新鲜候选少于该数量时，放宽「近 7 天排除」并降权。 */
const MIN_FRESH_POOL = 8;

/** 放宽后「近期吃过」的菜权重系数。 */
const RECENT_WEIGHT = 0.12;

/** 一天毫秒数。 */
const DAY_IN_MS = 24 * 60 * 60 * 1000;

/** 上海时区固定偏移（中国无夏令时）。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 星期中文标签，索引与 Date#getDay 一致。 */
const WEEKDAY_LABELS = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);

/** 餐次中文标签。 */
const MEAL_LABELS = Object.freeze({ breakfast: '早餐', lunch: '午餐', dinner: '晚餐', night: '夜宵' });

/** 辣度权重序号，用于「辣度上限」硬过滤。 */
const SPICY_RANK = Object.freeze({ mild: 1, medium: 2, hot: 3 });

/** 辣度中文标签，用于 reason 文案。 */
const SPICY_LABELS = Object.freeze({ mild: '微辣', medium: '中辣', hot: '重辣' });

/** 未设辣度上限时的软加权系数：略偏爱微辣 / 中辣，重辣降权。 */
const SPICY_SOFT_WEIGHT = Object.freeze({ mild: 1.05, medium: 1.12, hot: 0.85 });

/** 偏好默认值。 */
const DEFAULT_PREFERENCES = Object.freeze({
  vegetarian: false,
  maxSpicy: 'hot',
  maxPrice: null,
  categories: Object.freeze([]),
  cuisines: Object.freeze([]),
  avoidTags: Object.freeze([]),
});

/**
 * 把日期输入统一成上海时区的 YYYY-MM-DD 字符串。
 *
 * 支持三种输入：Date（按绝对时刻换算到 UTC+8）、时间戳数字、
 * 字符串（`YYYY-MM-DD` 直接视为上海日期；其它字符串按 ISO 解析）。
 *
 * @param {Date | number | string} value 日期输入
 * @returns {string} 形如 2026-11-08 的日期键
 * @throws {TypeError} 输入无法解析为日期时抛出
 */
function toDateKey(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('date 不是合法日期');
    const shanghai = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
    return formatDateKey(shanghai.getUTCFullYear(), shanghai.getUTCMonth() + 1, shanghai.getUTCDate());
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('date 不是合法时间戳');
    return toDateKey(new Date(value));
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (dateOnly) {
      const key = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
      if (dayIndex(key) === null) throw new TypeError(`date 不是合法日期：${value}`);
      return key;
    }
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return toDateKey(parsed);
    throw new TypeError(`无法解析 date：${value}`);
  }
  throw new TypeError('date 需为 Date、时间戳或 YYYY-MM-DD 字符串');
}

/**
 * 尝试把日期输入转成日期键，失败时返回 null（用于过滤脏 history）。
 *
 * @param {unknown} value 日期输入
 * @returns {string | null} 日期键或 null
 */
function tryToDateKey(value) {
  try {
    return toDateKey(value);
  } catch {
    return null;
  }
}

/**
 * 格式化日期键。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} day 日
 * @returns {string} YYYY-MM-DD
 */
function formatDateKey(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 把日期键换算成 Unix 天序号；非法日期返回 null。
 *
 * @param {string} dateKey YYYY-MM-DD
 * @returns {number | null} 天序号
 */
function dayIndex(dateKey) {
  if (typeof dateKey !== 'string') return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const time = Date.UTC(year, month - 1, day);
  if (Number.isNaN(time)) return null;
  const check = new Date(time);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(time / DAY_IN_MS);
}

/**
 * 由日期键取星期索引（周日为 0）；非法日期回退为 0。
 *
 * @param {string} dateKey YYYY-MM-DD
 * @returns {number} 0-6
 */
function weekdayOf(dateKey) {
  const index = dayIndex(dateKey);
  if (index === null) return 0;
  return new Date(index * DAY_IN_MS).getUTCDay();
}

/**
 * 取某个日期输入对应的上海小时（仅日期字符串按中午 12 点估算）。
 *
 * @param {Date | number | string} value 日期输入
 * @returns {number} 0-23
 */
function shanghaiHour(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return 12;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return 12;
    return shanghaiHour(parsed);
  }
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'number') date = new Date(value);
  else date = new Date();
  if (Number.isNaN(date.getTime())) return 12;
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).getUTCHours();
}

/**
 * 按上海时间推断餐次（文档口径）：
 * - 05:00–09:59 早餐 breakfast
 * - 10:00–14:59 午餐 lunch
 * - 15:00–20:59 晚餐 dinner
 * - 21:00–04:59 夜宵 night
 *
 * @param {Date | number | string} [date=new Date()] 日期 / 时间戳 / 日期字符串
 * @returns {'breakfast' | 'lunch' | 'dinner' | 'night'} 餐次
 */
export function inferMeal(date = new Date()) {
  const hour = shanghaiHour(date);
  if (hour >= 5 && hour < 10) return 'breakfast';
  if (hour >= 10 && hour < 15) return 'lunch';
  if (hour >= 15 && hour < 21) return 'dinner';
  return 'night';
}

/**
 * 校验并归一化餐次，非法值回退为按日期推断。
 *
 * @param {unknown} meal 餐次输入
 * @param {Date | number | string} date 日期输入
 * @returns {'breakfast' | 'lunch' | 'dinner' | 'night'} 合法餐次
 */
function resolveMeal(meal, date) {
  if (typeof meal === 'string' && MEALS.includes(meal)) return meal;
  return inferMeal(date);
}

/**
 * 去重、去空白并排序字符串数组。
 *
 * @param {unknown} input 原始数组
 * @returns {string[]} 稳定顺序的字符串数组
 */
function normalizeStringList(input) {
  if (!Array.isArray(input)) return [];
  const values = new Set();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text) values.add(text);
  }
  return [...values].sort();
}

/**
 * 归一化推荐偏好，作为硬过滤条件使用。
 *
 * 规则：
 * - `vegetarian` 仅严格等于 true 时生效（排除含 meat / seafood 的菜）。
 * - `maxSpicy` 缺省 / 非法时视为 'hot'（不限辣度），此时辣度只参与软加权。
 * - `maxPrice` 缺省 / 非法 / 非正数时视为 null（不限价格），此时价格只参与软加权。
 * - `categories` / `cuisines` 只保留枚举内的值并排序去重；空数组表示不限。
 * - `avoidTags` 命中任意 tag 即排除（如 'seafood'、'noodle'、'hot'）。
 *
 * @param {object | null | undefined} [input] 用户偏好
 * @returns {{ vegetarian: boolean, maxSpicy: 'mild'|'medium'|'hot', maxPrice: number|null, categories: string[], cuisines: string[], avoidTags: string[] }} 归一化偏好
 */
export function normalizePreferences(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const spicy = typeof source.maxSpicy === 'string' ? source.maxSpicy : '';
  const maxSpicy = SPICY_LEVELS.includes(spicy) ? spicy : DEFAULT_PREFERENCES.maxSpicy;
  const priceRaw = Number(source.maxPrice);
  const maxPrice = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;
  const categories = normalizeStringList(source.categories).filter((value) => CATEGORIES.includes(value));
  const cuisines = normalizeStringList(source.cuisines).filter((value) => CUISINES.includes(value));
  // 先统一小写再去重，避免 'Seafood' 与 'seafood' 同时命中
  const rawAvoidTags = Array.isArray(source.avoidTags)
    ? source.avoidTags.map((value) => (typeof value === 'string' ? value.toLowerCase() : value))
    : [];
  const avoidTags = normalizeStringList(rawAvoidTags);
  return {
    vegetarian: source.vegetarian === true,
    maxSpicy,
    maxPrice,
    categories,
    cuisines,
    avoidTags,
  };
}

/**
 * 取一道菜的辣度标签；数据缺失时按重辣处理（保守）。
 *
 * @param {{ tags: string[] }} dish 菜品
 * @returns {'mild' | 'medium' | 'hot'} 辣度
 */
function spicyOf(dish) {
  const found = Array.isArray(dish.tags) ? dish.tags.find((tag) => SPICY_LEVELS.includes(tag)) : undefined;
  return found || 'hot';
}

/**
 * 判断菜品是否素食友好（不含 meat / seafood）。
 *
 * @param {{ tags: string[] }} dish 菜品
 * @returns {boolean} 素食友好返回 true
 */
function isVegetarian(dish) {
  const tags = Array.isArray(dish.tags) ? dish.tags : [];
  return !tags.includes('meat') && !tags.includes('seafood');
}

/**
 * 按硬过滤条件筛选候选菜品。
 *
 * @param {Array} catalog 菜品库
 * @param {ReturnType<typeof normalizePreferences>} preferences 归一化偏好
 * @returns {Array} 满足全部硬过滤条件的菜品
 */
function filterCatalog(catalog, preferences) {
  const avoid = new Set(preferences.avoidTags);
  const categories = new Set(preferences.categories);
  const cuisines = new Set(preferences.cuisines);
  return catalog.filter((dish) => {
    if (!dish || typeof dish.id !== 'string' || !Array.isArray(dish.tags)) return false;
    if (preferences.vegetarian && !isVegetarian(dish)) return false;
    if (SPICY_RANK[spicyOf(dish)] > SPICY_RANK[preferences.maxSpicy]) return false;
    if (preferences.maxPrice !== null && Number(dish.price) > preferences.maxPrice) return false;
    if (categories.size > 0 && !categories.has(dish.category)) return false;
    if (cuisines.size > 0 && !cuisines.has(dish.cuisine)) return false;
    if (avoid.size > 0 && dish.tags.some((tag) => avoid.has(tag))) return false;
    return true;
  });
}

/**
 * 收集目标日期近 7 天（含当天）history 中出现过的菜品 id。
 *
 * @param {Array<{ dishId: string, date: string, meal: string }>} history 用餐历史
 * @param {string} targetKey 目标日期键
 * @param {number} [days=HISTORY_WINDOW_DAYS] 窗口天数（含当天）
 * @returns {Set<string>} 近期吃过的菜品 id 集合
 */
function collectRecentIds(history, targetKey, days = HISTORY_WINDOW_DAYS) {
  const ids = new Set();
  if (!Array.isArray(history)) return ids;
  const targetIndex = dayIndex(targetKey);
  if (targetIndex === null) return ids;
  for (const entry of history) {
    if (!entry || typeof entry.dishId !== 'string' || !entry.dishId) continue;
    const entryKey = tryToDateKey(entry.date);
    if (!entryKey) continue;
    const entryIndex = dayIndex(entryKey);
    if (entryIndex === null) continue;
    const diff = targetIndex - entryIndex;
    if (diff >= 0 && diff <= days - 1) ids.add(entry.dishId);
  }
  return ids;
}

/**
 * 价格软加权：平价与小份略加分，贵价菜略降权（仅在未设价格上限时生效）。
 *
 * @param {number} price 人均价格
 * @returns {number} 权重系数
 */
function priceSoftWeight(price) {
  const value = Number(price);
  if (!Number.isFinite(value)) return 1;
  if (value <= 20) return 1.04;
  if (value <= 40) return 1.12;
  if (value <= 60) return 0.94;
  return 0.86;
}

/**
 * 构造单道菜的权重函数（软加权 + 近期吃过的降权）。
 *
 * @param {ReturnType<typeof normalizePreferences>} preferences 归一化偏好
 * @param {Set<string>} recentIds 需要降权的近期菜品 id 集合
 * @returns {(dish: any) => number} 权重函数
 */
function buildWeightGetter(preferences, recentIds) {
  const softSpicy = preferences.maxSpicy === 'hot';
  const softPrice = preferences.maxPrice === null;
  return (dish) => {
    let weight = 1;
    if (softSpicy) weight *= SPICY_SOFT_WEIGHT[spicyOf(dish)];
    if (softPrice) weight *= priceSoftWeight(dish.price);
    if (recentIds && recentIds.has(dish.id)) weight *= RECENT_WEIGHT;
    return weight;
  };
}

/**
 * 按 id 升序排序，保证结果与 catalog 传入顺序无关。
 *
 * @param {{ id: string }} left 左菜品
 * @param {{ id: string }} right 右菜品
 * @returns {number} 比较结果
 */
function compareById(left, right) {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/**
 * 按权重不放回地抽取若干项（用于备选菜）。
 *
 * @param {Array} items 候选条目
 * @param {(item: any) => number} weightOf 权重函数
 * @param {() => number} rng 随机数生成器
 * @param {number} count 需要抽取的数量
 * @returns {Array} 抽中的条目（不足时返回剩余全部）
 */
function pickWeightedMany(items, weightOf, rng, count) {
  const remaining = [...items];
  const picked = [];
  while (picked.length < count && remaining.length > 0) {
    const item = pickWeighted(remaining, weightOf, rng);
    if (item === undefined) break;
    picked.push(item);
    remaining.splice(remaining.indexOf(item), 1);
  }
  return picked;
}

/**
 * 生成中文推荐理由，例如「周三午餐 · 微辣 · 人均 ¥28 · 近 7 天没吃过」。
 *
 * @param {{ dateKey: string, mealKey: string, dish: object|null, recentIds: Set<string>, rerolled: boolean }} context 文案上下文
 * @returns {string} 中文理由
 */
function buildReason(context) {
  const { dateKey, mealKey, dish, recentIds, rerolled } = context;
  const segments = [`${WEEKDAY_LABELS[weekdayOf(dateKey)]}${MEAL_LABELS[mealKey]}`];
  if (!dish) {
    segments.push('暂无符合偏好的菜');
    return segments.join(' · ');
  }
  segments.push(SPICY_LABELS[spicyOf(dish)]);
  segments.push(`人均 ¥${dish.price}`);
  if (rerolled) segments.push('换一道');
  segments.push(recentIds.has(dish.id) ? '近期吃过，已降权推荐' : '近 7 天没吃过');
  return segments.join(' · ');
}

/**
 * 构造「没有候选」时的空结果。
 *
 * @param {string} dateKey 日期键
 * @param {string} mealKey 餐次
 * @param {string} fallbackNote 说明文案
 * @returns {{ dish: null, alternatives: [], reason: string, date: string, meal: string, fallbackNote: string }} 空推荐结果
 */
function emptyResult(dateKey, mealKey, fallbackNote) {
  return {
    dish: null,
    alternatives: [],
    reason: buildReason({ dateKey, mealKey, dish: null, recentIds: new Set(), rerolled: false }),
    date: dateKey,
    meal: mealKey,
    fallbackNote,
  };
}

/**
 * 今日推荐：按 (date, meal, preferences) 确定性抽取一道主菜 + 3 道备选。
 *
 * - 相同 (date, meal, preferences) 必得相同结果（与 catalog 数组顺序无关）。
 * - preferences 为硬过滤；未设价格 / 辣度上限时做软加权。
 * - 近 7 天 history 里的菜默认排除；新鲜候选不足 8 道时降权放宽并写 fallbackNote。
 *
 * @param {object} [options={}] 推荐参数
 * @param {Date | number | string} [options.date=new Date()] 日期
 * @param {'breakfast'|'lunch'|'dinner'|'night'} [options.meal] 餐次（缺省按 date 推断）
 * @param {object} [options.preferences] 用户偏好（见 {@link normalizePreferences}）
 * @param {Array<{ dishId: string, date: string, meal: string }>} [options.history=[]] 近 7 天用餐历史
 * @param {Array} [options.catalog=DISHES] 菜品库（测试或插件可注入自定义数据）
 * @returns {{ dish: object | null, alternatives: object[], reason: string, date: string, meal: string, fallbackNote: string | null }} 推荐结果
 */
export function getDailyPick(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const dateInput = source.date === undefined ? new Date() : source.date;
  const history = Array.isArray(source.history) ? source.history : [];
  const catalog = Array.isArray(source.catalog) && source.catalog.length > 0 ? source.catalog : DISHES;
  const dateKey = toDateKey(dateInput);
  const mealKey = resolveMeal(source.meal, dateInput);
  const preferences = normalizePreferences(source.preferences);
  const recentIds = collectRecentIds(history, dateKey);
  const seed = hashString(stableStringify({ salt: 'daily-pick', date: dateKey, meal: mealKey, preferences }));
  const rng = createRng(seed);

  const basePool = filterCatalog(catalog, preferences);
  if (basePool.length === 0) {
    return emptyResult(dateKey, mealKey, '当前偏好下没有可推荐的菜，试试放宽素食、辣度、价格、分类或菜系限制');
  }

  const freshPool = basePool.filter((dish) => !recentIds.has(dish.id));
  let pool;
  let weightedRecentIds = new Set();
  let fallbackNote = null;
  if (freshPool.length >= MIN_FRESH_POOL) {
    pool = freshPool;
  } else {
    pool = basePool;
    weightedRecentIds = recentIds;
    const recentCount = basePool.length - freshPool.length;
    fallbackNote = `符合条件且近 7 天没吃过的菜只有 ${freshPool.length} 道（少于 ${MIN_FRESH_POOL} 道），已放宽近 7 天排除：${recentCount} 道近期吃过的菜放回候选并降权`;
  }

  const sortedPool = pool.sort(compareById);
  const weightOf = buildWeightGetter(preferences, weightedRecentIds);
  const dish = pickWeighted(sortedPool, weightOf, rng);
  const remaining = sortedPool.filter((item) => item.id !== dish.id);
  const freshRemaining = remaining.filter((item) => !recentIds.has(item.id));
  const alternativePool = freshRemaining.length >= 3 ? freshRemaining : remaining;
  const alternatives = pickWeightedMany(alternativePool, weightOf, rng, Math.min(3, alternativePool.length));
  const reason = buildReason({ dateKey, mealKey, dish, recentIds, rerolled: false });
  return { dish, alternatives, reason, date: dateKey, meal: mealKey, fallbackNote };
}

/**
 * 换一道：在排除 previousIds 与近 7 天 history 的前提下重新抽取。
 *
 * 候选耗尽时的回退顺序：先放宽近 7 天排除（近期菜降权），
 * 再在极端情况下允许重复 previousIds，并通过 fallbackNote 说明。
 *
 * @param {object} [options={}] 换一道参数
 * @param {Date | number | string} [options.date=new Date()] 日期
 * @param {'breakfast'|'lunch'|'dinner'|'night'} [options.meal] 餐次（缺省按 date 推断）
 * @param {object} [options.preferences] 用户偏好
 * @param {Array<{ dishId: string, date: string, meal: string }>} [options.history=[]] 用餐历史
 * @param {string[]} [options.previousIds=[]] 已经看过 / 换掉的菜品 id（不可重复）
 * @param {Array} [options.catalog=DISHES] 菜品库
 * @returns {{ dish: object | null, alternatives: object[], reason: string, date: string, meal: string, fallbackNote: string | null }} 推荐结果
 */
export function reroll(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const dateInput = source.date === undefined ? new Date() : source.date;
  const history = Array.isArray(source.history) ? source.history : [];
  const catalog = Array.isArray(source.catalog) && source.catalog.length > 0 ? source.catalog : DISHES;
  const dateKey = toDateKey(dateInput);
  const mealKey = resolveMeal(source.meal, dateInput);
  const preferences = normalizePreferences(source.preferences);
  const previousIds = normalizeStringList(source.previousIds);
  const previousSet = new Set(previousIds);
  const recentIds = collectRecentIds(history, dateKey);
  const seed = hashString(stableStringify({
    salt: 'reroll',
    date: dateKey,
    meal: mealKey,
    preferences,
    previousIds,
  }));
  const rng = createRng(seed);

  const basePool = filterCatalog(catalog, preferences);
  if (basePool.length === 0) {
    return emptyResult(dateKey, mealKey, '当前偏好下没有可推荐的菜，试试放宽素食、辣度、价格、分类或菜系限制');
  }

  let candidates = basePool.filter((dish) => !previousSet.has(dish.id));
  let fallbackNote = null;
  if (candidates.length === 0) {
    candidates = basePool;
    fallbackNote = '符合条件的候选已耗尽，已允许重新出现刚才看过的菜';
  }

  const freshPool = candidates.filter((dish) => !recentIds.has(dish.id));
  let pool;
  let weightedRecentIds = new Set();
  if (freshPool.length >= MIN_FRESH_POOL) {
    pool = freshPool;
  } else {
    pool = candidates;
    weightedRecentIds = recentIds;
    const historyNote = `符合条件且近 7 天没吃过的菜只有 ${freshPool.length} 道（少于 ${MIN_FRESH_POOL} 道），已放宽近 7 天排除并降权`;
    fallbackNote = fallbackNote ? `${fallbackNote}；${historyNote}` : historyNote;
  }

  const sortedPool = pool.sort(compareById);
  const weightOf = buildWeightGetter(preferences, weightedRecentIds);
  const dish = pickWeighted(sortedPool, weightOf, rng);
  const remaining = sortedPool.filter((item) => item.id !== dish.id);
  const freshRemaining = remaining.filter((item) => !recentIds.has(item.id));
  const alternativePool = freshRemaining.length >= 3 ? freshRemaining : remaining;
  const alternatives = pickWeightedMany(alternativePool, weightOf, rng, Math.min(3, alternativePool.length));
  const reason = buildReason({ dateKey, mealKey, dish, recentIds, rerolled: true });
  return { dish, alternatives, reason, date: dateKey, meal: mealKey, fallbackNote };
}

/**
 * 记录一次推荐（纯函数）：把推荐结果追加进 history。
 *
 * @param {Array<{ dishId: string, date: string, meal: string }>} [history=[]] 原历史（不会被修改）
 * @param {{ dish?: { id: string }, dishId?: string, date?: Date|string|number, meal?: string }} pick 推荐结果或手写记录
 * @returns {Array<{ dishId: string, date: string, meal: string }>} 新的历史数组
 * @throws {TypeError} pick 缺少菜品 id 时抛出
 */
export function recordPick(history, pick) {
  const list = Array.isArray(history) ? history : [];
  if (!pick || typeof pick !== 'object') throw new TypeError('recordPick 需要一个推荐结果对象');
  const dishId = typeof pick.dishId === 'string' && pick.dishId
    ? pick.dishId
    : pick.dish && typeof pick.dish.id === 'string'
      ? pick.dish.id
      : '';
  if (!dishId) throw new TypeError('recordPick 无法确定菜品 id');
  const dateKey = pick.date === undefined ? toDateKey(new Date()) : toDateKey(pick.date);
  const mealKey = typeof pick.meal === 'string' && MEALS.includes(pick.meal) ? pick.meal : inferMeal(dateKey);
  return [...list, { dishId, date: dateKey, meal: mealKey }];
}

/**
 * 归一化窗口天数：只接受 >= 1 的整数，非法值回退为 7。
 *
 * @param {unknown} days 天数输入
 * @returns {number} 合法天数
 */
function normalizeDays(days) {
  const value = Math.floor(Number(days));
  return Number.isFinite(value) && value >= 1 ? value : HISTORY_WINDOW_DAYS;
}

/**
 * 修剪用餐历史（纯函数）：只保留最近 N 个自然日（含 today 当天）的记录。
 *
 * 边界：`days = 7` 时保留 today 及之前 6 天；更早、未来日期与非法日期都会被剔除。
 *
 * @param {Array<{ dishId: string, date: string, meal: string }>} [history=[]] 原历史（不会被修改）
 * @param {object} [options={}] 选项
 * @param {number} [options.days=7] 保留最近多少天
 * @param {Date | number | string} [options.today=new Date()] 参照的「今天」
 * @returns {Array<{ dishId: string, date: string, meal: string }>} 修剪后的历史（保留原对象引用）
 */
export function pruneHistory(history, options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const days = normalizeDays(source.days);
  const todayKey = toDateKey(source.today === undefined ? new Date() : source.today);
  const todayIndex = dayIndex(todayKey);
  if (todayIndex === null || !Array.isArray(history)) return [];
  return history.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const entryKey = tryToDateKey(entry.date);
    if (!entryKey) return false;
    const entryIndex = dayIndex(entryKey);
    if (entryIndex === null) return false;
    const diff = todayIndex - entryIndex;
    return diff >= 0 && diff <= days - 1;
  });
}

/* ================================================================== */
/* v2 推荐内核：recommendMeal / planWeek / summarizeMeals              */
/* 规格见 docs/design-v2.md §7；旧导出与旧行为保持不变。                */
/* ================================================================== */

/** 周计划局部搜索的随机 swap 次数（规格 §7：20 次）。 */
const PLAN_SWAP_ITERATIONS = 20;

/** recommendMeal 返回的备选数量。 */
const RECOMMEND_ALTERNATIVES = 3;

/** 新鲜候选少于此数量时放宽「近 7 天排除」。 */
const RECOMMEND_MIN_FRESH = RECOMMEND_ALTERNATIVES + 1;

/** 周计划天数范围。 */
const PLAN_MIN_DAYS = 1;
const PLAN_MAX_DAYS = 14;

/** 默认周计划种子。 */
const DEFAULT_PLAN_SEED = 7;

/** 低于该阶段拟合值的菜视为「自由餐」。 */
const FREE_MEAL_MAX_FIT = 2;

/**
 * 取有限数字，非法返回 null。
 *
 * @param {unknown} value 原始值
 * @returns {number | null} 数值或 null
 */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 四舍五入到指定小数位。
 *
 * @param {number} value 数值
 * @param {number} [digits=1] 小数位
 * @returns {number} 结果
 */
function roundTo(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 求平均（空数组返回 null）。
 *
 * @param {number[]} values 数值
 * @param {number} [digits=1] 小数位
 * @returns {number | null} 平均值
 */
function averageOf(values, digits = 1) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return roundTo(sum / values.length, digits);
}

/**
 * 归一化阶段输入（容错：phase / phaseKind 二选一都行）。
 *
 * @param {object | null | undefined} input 阶段对象
 * @param {string} [fallbackKind='fitness'] 回退阶段
 * @returns {ReturnType<typeof normalizePhase>} 归一化阶段
 */
function resolvePhaseObject(input, fallbackKind = 'performance') {
  const source = input && typeof input === 'object' ? input : {};
  const kind =
    canonicalPhaseKind(source.phaseKind) ??
    canonicalPhaseKind(source.kind) ??
    canonicalPhaseKind(fallbackKind) ??
    'performance';
  return normalizePhase({ ...source, kind });
}

/**
 * 归一化周计划天数。
 *
 * @param {unknown} days 天数输入
 * @returns {number} 1-14 的整数（缺省 7）
 */
function normalizePlanDays(days) {
  const value = Math.floor(Number(days));
  if (!Number.isFinite(value)) return 7;
  return Math.min(PLAN_MAX_DAYS, Math.max(PLAN_MIN_DAYS, value));
}

/**
 * 提取菜品营养信息；全部缺失时返回 null。
 *
 * @param {object | null | undefined} dish 菜品
 * @returns {{ kcal: number | null, protein: number | null, fat: number | null, carbs: number | null, veg: number | null } | null} 营养
 */
function nutritionOfDish(dish) {
  const nutrition = dish && typeof dish === 'object' && dish.nutrition && typeof dish.nutrition === 'object'
    ? dish.nutrition
    : {};
  const result = {
    kcal: finiteNumber(nutrition.kcal),
    protein: finiteNumber(nutrition.protein),
    fat: finiteNumber(nutrition.fat),
    carbs: finiteNumber(nutrition.carbs),
    veg: finiteNumber(nutrition.veg),
  };
  return Object.values(result).every((value) => value === null) ? null : result;
}

/**
 * 取菜品辣度中文标签（缺标签按中辣）。
 *
 * @param {object} dish 菜品
 * @returns {string} 中文辣度
 */
function dishSpicyLabel(dish) {
  const tags = dish && Array.isArray(dish.tags) ? dish.tags : [];
  const found = tags.find((tag) => SPICY_LEVELS.includes(tag));
  return SPICY_LABELS[found] ?? '中辣';
}

/**
 * 生成六维味道文案（取辣以外的明显维度，如「酸鲜」「咸鲜」「清甜」）。
 *
 * @param {object | null | undefined} dish 菜品
 * @returns {string} 味道描述
 */
function tasteTextOf(dish) {
  if (dish === null || dish === undefined || typeof dish !== 'object') return '口味清淡'
  const taste = dishTasteOf(dish)
  const picks = TASTE_DIMENSIONS
    .filter((dimension) => dimension !== 'spicy' && Number(taste[dimension]) >= 3)
    .sort((left, right) => Number(taste[right]) - Number(taste[left]))
    .slice(0, 2)
    .map((dimension) => TASTE_LABELS[dimension] ?? dimension)
  return picks.length > 0 ? picks.join('') : '口味清淡'
}

/**
 * 生成推荐理由（中文自然文案）：阶段 · 辣度 · 六维味道 · 人均 · 营养 · 新鲜度。
 *
 * @param {object} context 文案上下文
 * @returns {string} 中文理由
 */
function buildRecommendReason(context) {
  const { dateKey, mealKey, dish, phase, recentIds } = context;
  const segments = [`${WEEKDAY_LABELS[weekdayOf(dateKey)]}${MEAL_LABELS[mealKey]}`, phaseLabel(phase)];
  if (!dish) {
    segments.push('暂无符合偏好的菜');
    return segments.join(' · ');
  }
  segments.push(dishSpicyLabel(dish));
  segments.push(tasteTextOf(dish));
  const price = finiteNumber(dish.price);
  segments.push(price === null ? '人均未知' : `人均 ¥${price}`);
  const nutrition = nutritionOfDish(dish);
  if (nutrition) {
    if (nutrition.protein !== null && nutrition.protein >= 25) segments.push(`高蛋白 ${nutrition.protein}g`);
    if (nutrition.kcal !== null) segments.push(`约 ${nutrition.kcal} kcal`);
  }
  segments.push(recentIds.has(dish.id) ? '近期吃过，已降权推荐' : '近 7 天没吃过');
  return segments.join(' · ');
}

/**
 * 构造 v2 空推荐结果。
 *
 * @param {string} dateKey 日期键
 * @param {string} mealKey 餐次
 * @param {object} phase 阶段
 * @param {string} fallbackNote 说明
 * @returns {object} 空推荐结果
 */
function emptyRecommendResult(dateKey, mealKey, phase, fallbackNote) {
  return {
    dish: null,
    alternatives: [],
    reason: buildRecommendReason({ dateKey, mealKey, dish: null, phase, recentIds: new Set() }),
    nutrition: null,
    meal: mealKey,
    date: dateKey,
    phaseKind: phase.kind,
    fallbackNote,
  };
}

/**
 * 单餐推荐（v2）：阶段 + 口味 + 营养 + 新鲜度综合打分，确定性抽取主菜与 3 道备选。
 *
 * 与旧 {@link getDailyPick} 的区别：使用 dishScore 的打分 / 硬过滤（素食、忌口、预算、
 * 城市可得性），并返回营养信息与更自然的中文 reason；备选保证去重且排除主选。
 * 同一 (date, meal, profile, phase, history, seed) 输入恒得同一结果。
 *
 * @param {object} [options] 参数
 * @param {Date | number | string} [options.date=new Date()] 日期
 * @param {string} [options.meal] 餐次（缺省按 date 推断）
 * @param {object} [options.profile] 用户档案
 * @param {object} [options.phase] 阶段（缺省按 phaseKind / fitness）
 * @param {string} [options.phaseKind] 阶段类型（覆盖 phase.kind）
 * @param {Array} [options.history=[]] 用餐历史
 * @param {Array} [options.catalog=DISHES] 菜品库
 * @param {string[]} [options.excludeIds=[]] 已看过 / 换掉的菜品 id
 * @param {number} [options.seed] 随机种子（可选，缺省按内容派生）
 * @param {'home'|'out'} [options.mode] 模式
 * @param {number} [options.sourBias] 额外果酸偏好（-1 ～ +1）
 * @returns {{ dish: object | null, alternatives: object[], reason: string, nutrition: object | null, meal: string, date: string, phaseKind: string, fallbackNote: string | null }} 推荐结果
 */
export function recommendMeal(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const dateInput = source.date === undefined ? new Date() : source.date;
  const dateKey = toDateKey(dateInput);
  const mealKey = resolveMeal(source.meal, dateInput);
  const catalog = Array.isArray(source.catalog) && source.catalog.length > 0 ? source.catalog : DISHES;
  const profile = source.profile && typeof source.profile === 'object' ? source.profile : {};
  const phaseInput = source.phase && typeof source.phase === 'object' ? { ...source.phase } : {};
  if (canonicalPhaseKind(source.phaseKind)) phaseInput.phaseKind = source.phaseKind;
  const phase = resolvePhaseObject(phaseInput, canonicalPhaseKind(source.phaseKind) ?? 'performance');
  const phaseKind = phase.kind;
  const history = Array.isArray(source.history) ? source.history : [];
  const excludeIds = normalizeStringList(source.excludeIds);
  const excludeSet = new Set(excludeIds);
  const recentIds = collectRecentIds(history, dateKey);
  const mode = source.mode === 'home' || source.mode === 'out' ? source.mode : undefined;

  const context = {
    profile,
    phase: { ...phase, kind: phaseKind },
    history,
    date: dateKey,
    meal: mealKey,
    mode,
    sourBias: source.sourBias,
  };

  const scored = [];
  const seenIds = new Set();
  for (const dish of catalog) {
    if (!dish || typeof dish !== 'object' || typeof dish.id !== 'string') continue;
    if (excludeSet.has(dish.id) || seenIds.has(dish.id)) continue;
    if (!dishEligible(dish, context)) continue;
    seenIds.add(dish.id);
    scored.push({ dish, score: dishScore(dish, context) });
  }
  if (scored.length === 0) {
    return emptyRecommendResult(dateKey, mealKey, phase, '当前偏好下没有可推荐的菜，试试放宽素食、辣度、价格、菜系或城市限制');
  }

  const fresh = scored.filter((entry) => !recentIds.has(entry.dish.id));
  let pool = fresh;
  let fallbackNote = null;
  if (fresh.length < RECOMMEND_MIN_FRESH) {
    pool = scored;
    const historyNote = `符合条件且近 7 天没吃过的菜只有 ${fresh.length} 道，已放宽近 7 天排除并降权`;
    fallbackNote = historyNote;
  }

  const seedInput = finiteNumber(source.seed);
  const seed = hashString(stableStringify({
    salt: 'recommend-meal',
    date: dateKey,
    meal: mealKey,
    phaseKind,
    subgoal: phase.subgoal,
    seed: seedInput,
    excludeIds,
    recentIds: [...recentIds].sort(),
    profile,
  }));
  const rng = createRng(seed);

  const sortedPool = [...pool].sort((left, right) => compareById(left.dish, right.dish));
  const weightOf = (entry) => {
    const base = Math.pow(Math.max(1, entry.score), 2);
    return recentIds.has(entry.dish.id) ? base * 0.15 : base;
  };
  const main = pickWeighted(sortedPool, weightOf, rng);
  if (main === undefined) {
    return emptyRecommendResult(dateKey, mealKey, phase, '当前偏好下没有可推荐的菜，试试放宽素食、辣度、价格、菜系或城市限制');
  }
  const remaining = sortedPool.filter((entry) => entry.dish.id !== main.dish.id);
  const alternatives = pickWeightedMany(
    remaining,
    weightOf,
    rng,
    Math.min(RECOMMEND_ALTERNATIVES, remaining.length),
  ).map((entry) => entry.dish);

  return {
    dish: main.dish,
    alternatives,
    reason: buildRecommendReason({ dateKey, mealKey, dish: main.dish, phase, recentIds }),
    nutrition: nutritionOfDish(main.dish),
    meal: mealKey,
    date: dateKey,
    phaseKind,
    fallbackNote,
  };
}

/**
 * 解析 locked 值里的菜品 id（支持字符串或 {id}）。
 *
 * @param {unknown} value locked 值
 * @returns {string | null} 菜品 id
 */
function lockedDishId(value) {
  if (typeof value === 'string' && value !== '') return value;
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id !== '') return value.id;
  return null;
}

/**
 * 周计划：贪心选菜 + 20 次确定性随机 swap 局部搜索。
 *
 * 硬约束：
 * - 7 天窗口内同一 dishId 不重复（菜品库不足时逐步放宽并写 fallbackNote）；
 * - 阶段允许：优先选 dish.phases[kind] >= 2 的菜，同时遵守自由餐额度（freeMealsPerWeek）；
 * - 近 7 天已吃过的菜不进入候选（候选不足时放宽）；
 * - `locked` 支持 `{'日期:餐次': dishId}` 与 `{日期: dishId}`（日期锁作用于该日第一餐）。
 *
 * 结果对同 (seed, startDate, phase, profile) 确定性。
 *
 * @param {object} [options] 参数
 * @param {Date | number | string} [options.startDate=new Date()] 起始日期
 * @param {number} [options.days=7] 天数（1-14）
 * @param {string[]} [options.meals=['lunch','dinner']] 每天的餐次
 * @param {object} [options.profile] 用户档案
 * @param {object} [options.phase] 阶段
 * @param {string} [options.phaseKind] 阶段类型（覆盖 phase.kind）
 * @param {Array} [options.history=[]] 用餐历史
 * @param {Array} [options.catalog=DISHES] 菜品库
 * @param {number} [options.seed=7] 随机种子
 * @param {object} [options.locked={}] 锁定的菜（{'2026-11-11:lunch': 'dish-id'} 或 {'2026-11-11': 'dish-id'}）
 * @param {'home'|'out'} [options.mode] 覆盖每餐模式（缺省按菜品 cookable 推导）
 * @returns {{ start: string, seed: number, days: Array<{date: string, meals: Array<{meal: string, dish: object, dishId: string, mode: string}>}>, summary: {avgKcal: number|null, avgProtein: number|null, uniqueDishes: number, cuisines: string[], cuisineCounts: Record<string, number>, estimatedCost: number, freeMeals: number}, fallbackNote: string|null }} 周计划
 */
export function planWeek(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const startInput = source.startDate === undefined
    ? source.start === undefined ? new Date() : source.start
    : source.startDate;
  const startKey = toDateKey(startInput);
  const daysCount = normalizePlanDays(source.days);
  const requestedMeals = Array.isArray(source.meals) && source.meals.length > 0
    ? source.meals.filter((meal) => MEALS.includes(meal))
    : ['lunch', 'dinner'];
  const mealsList = [...new Set(requestedMeals.length > 0 ? requestedMeals : ['lunch', 'dinner'])]
    .sort((left, right) => MEALS.indexOf(left) - MEALS.indexOf(right));
  const catalog = Array.isArray(source.catalog) && source.catalog.length > 0 ? source.catalog : DISHES;
  const profile = source.profile && typeof source.profile === 'object' ? source.profile : {};
  const phaseInput = source.phase && typeof source.phase === 'object' ? { ...source.phase } : {};
  if (canonicalPhaseKind(source.phaseKind)) phaseInput.phaseKind = source.phaseKind;
  const phase = resolvePhaseObject(phaseInput, canonicalPhaseKind(source.phaseKind) ?? 'performance');
  const phaseKind = phase.kind;
  const history = Array.isArray(source.history) ? source.history : [];
  const locked = source.locked && typeof source.locked === 'object' ? source.locked : {};
  const modeOverride = source.mode === 'home' || source.mode === 'out' ? source.mode : undefined;
  const seedValueRaw = finiteNumber(source.seed);
  const seedValue = seedValueRaw === null ? DEFAULT_PLAN_SEED : Math.trunc(seedValueRaw);
  const targets = phaseTargets(phase, profile);
  const freeBudget = Math.max(0, Math.floor(targets.freeMealsPerWeek || 0));

  const seed = hashString(stableStringify({
    salt: 'plan-week',
    start: startKey,
    days: daysCount,
    meals: mealsList,
    seed: seedValue,
    phase: { kind: phaseKind, subgoal: phase.subgoal, targets },
    profile,
  }));
  const rng = createRng(seed);

  // 1. 槽位（日期 × 餐次）与锁定
  const slots = [];
  for (let index = 0; index < daysCount; index += 1) {
    const date = shiftDateKey(startKey, index);
    for (const meal of mealsList) slots.push({ date, meal, lockedDish: null });
  }
  const dishById = new Map();
  for (const dish of catalog) {
    if (!dish || typeof dish !== 'object' || typeof dish.id !== 'string') continue;
    dishById.set(dish.id, dish);
  }
  const notes = new Set();
  for (const slot of slots) {
    const perMealLock = lockedDishId(locked[`${slot.date}:${slot.meal}`]);
    const perDateLock = slot.meal === mealsList[0] ? lockedDishId(locked[slot.date]) : null;
    const wanted = perMealLock ?? perDateLock;
    if (!wanted) continue;
    const dish = dishById.get(wanted);
    if (dish) slot.lockedDish = dish;
    else notes.add(`锁定的菜 ${wanted} 不在菜品库中，已忽略`);
  }

  // 2. 候选池与打分缓存
  const baseContext = { profile, phase, history: [], mode: modeOverride };
  const eligible = [...dishById.values()].filter((dish) => dishEligible(dish, baseContext));
  if (eligible.length === 0) {
    return {
      start: startKey,
      seed: seedValue,
      days: slots.map((slot) => ({ date: slot.date, meals: [] })),
      summary: { avgKcal: null, avgProtein: null, uniqueDishes: 0, cuisines: [], cuisineCounts: {}, estimatedCost: 0, freeMeals: 0 },
      fallbackNote: '当前偏好下没有可用的菜，无法生成周计划',
    };
  }
  const strictEligible = eligible.filter((dish) => dishPhaseFit(dish, phaseKind, phase.subgoal) >= FREE_MEAL_MAX_FIT);
  const scoreCache = new Map();
  const slotScore = (dish, slot) => {
    const key = `${dish.id}\u0000${slot.date}\u0000${slot.meal}`;
    const cached = scoreCache.get(key);
    if (cached !== undefined) return cached;
    const mode = modeOverride ?? (dish.cookable === true ? 'home' : 'out');
    const score = dishScore(dish, { profile, phase, history, date: slot.date, meal: slot.meal, mode });
    scoreCache.set(key, score);
    return score;
  };
  const recentCache = new Map();
  const recentAt = (date) => {
    if (!recentCache.has(date)) recentCache.set(date, collectRecentIds(history, date));
    return recentCache.get(date);
  };

  // 3. 用 RNG 抽取「自由餐」槽位（额度来自 phaseTargets.freeMealsPerWeek）
  const freeSlots = new Set();
  if (freeBudget > 0 && slots.length > 0) {
    const indices = slots.map((_, index) => index);
    for (let index = indices.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(rng() * (index + 1));
      [indices[index], indices[swapIndex]] = [indices[swapIndex], indices[index]];
    }
    for (const index of indices.slice(0, Math.min(freeBudget, indices.length))) freeSlots.add(index);
  }

  // 4. 贪心：每槽按分数取前 3 加权抽取
  const assignments = [];
  const used = new Set();
  // 预先占用被锁定的菜，避免更早的槽位先选中它造成重复
  for (const slot of slots) {
    if (slot.lockedDish) used.add(slot.lockedDish.id);
  }
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (slot.lockedDish) {
      const fit = dishPhaseFit(slot.lockedDish, phaseKind, phase.subgoal);
      assignments.push({ dish: slot.lockedDish, locked: true, free: fit < FREE_MEAL_MAX_FIT });
      used.add(slot.lockedDish.id);
      continue;
    }
    const recent = recentAt(slot.date);
    const pickFrom = (pool) => pool.filter((dish) => !used.has(dish.id) && !recent.has(dish.id));
    let candidates = pickFrom(freeSlots.has(index) ? eligible : strictEligible);
    if (candidates.length === 0) {
      candidates = pickFrom(strictEligible);
    }
    if (candidates.length === 0) {
      candidates = pickFrom(eligible);
      if (candidates.length > 0) notes.add('阶段候选不足，已放宽阶段拟合要求');
    }
    if (candidates.length === 0) {
      candidates = eligible.filter((dish) => !used.has(dish.id));
      if (candidates.length > 0) notes.add('候选不足，已放宽近 7 天排除');
    }
    if (candidates.length === 0) {
      candidates = eligible;
      notes.add('菜品库不足以支撑 7 天不重样，已允许重复');
    }
    const ranked = candidates
      .map((dish) => ({ dish, score: slotScore(dish, slot) }))
      .sort((left, right) => (right.score !== left.score ? right.score - left.score : compareById(left.dish, right.dish)));
    const top = ranked.slice(0, Math.min(3, ranked.length));
    const chosen = pickWeighted(top, (entry) => Math.pow(Math.max(1, entry.score), 2), rng) ?? ranked[0];
    const fit = dishPhaseFit(chosen.dish, phaseKind, phase.subgoal);
    assignments.push({ dish: chosen.dish, locked: false, free: fit < FREE_MEAL_MAX_FIT });
    used.add(chosen.dish.id);
  }

  // 5. 20 次确定性随机 swap 局部搜索（保持多重集合不变，因此不会破坏不重复约束）
  for (let iteration = 0; iteration < PLAN_SWAP_ITERATIONS; iteration += 1) {
    const first = Math.floor(rng() * slots.length);
    const second = Math.floor(rng() * slots.length);
    if (first === second) continue;
    const left = assignments[first];
    const right = assignments[second];
    if (!left || !right || left.locked || right.locked || left.dish.id === right.dish.id) continue;
    const leftSlot = slots[first];
    const rightSlot = slots[second];
    if (recentAt(leftSlot.date).has(right.dish.id) || recentAt(rightSlot.date).has(left.dish.id)) continue;
    const before = slotScore(left.dish, leftSlot) + slotScore(right.dish, rightSlot);
    const after = slotScore(right.dish, leftSlot) + slotScore(left.dish, rightSlot);
    if (after <= before) continue;
    assignments[first] = { ...left, dish: right.dish };
    assignments[second] = { ...right, dish: left.dish };
  }

  // 6. 输出 days / summary
  const dayMap = new Map();
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const assignment = assignments[index];
    const mode = modeOverride ?? (assignment.dish.cookable === true ? 'home' : 'out');
    if (!dayMap.has(slot.date)) dayMap.set(slot.date, { date: slot.date, meals: [] });
    dayMap.get(slot.date).meals.push({
      meal: slot.meal,
      dish: assignment.dish,
      dishId: assignment.dish.id,
      mode,
    });
  }
  const days = [...dayMap.values()].sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));

  const picks = [];
  let estimatedCost = 0;
  for (const day of days) {
    for (const item of day.meals) {
      picks.push(item);
      const price = finiteNumber(item.dish.price);
      if (price !== null) estimatedCost += price;
    }
  }
  const kcalValues = [];
  const proteinValues = [];
  const cuisineCounts = {};
  for (const pick of picks) {
    const nutrition = nutritionOfDish(pick.dish);
    if (nutrition) {
      if (nutrition.kcal !== null) kcalValues.push(nutrition.kcal);
      if (nutrition.protein !== null) proteinValues.push(nutrition.protein);
    }
    const cuisine = typeof pick.dish.cuisine === 'string' && pick.dish.cuisine !== '' ? pick.dish.cuisine : '家常菜';
    cuisineCounts[cuisine] = (cuisineCounts[cuisine] ?? 0) + 1;
  }
  const cuisines = Object.keys(cuisineCounts).sort((left, right) => {
    const diff = cuisineCounts[right] - cuisineCounts[left];
    return diff !== 0 ? diff : left < right ? -1 : left > right ? 1 : 0;
  });
  const freeMeals = assignments.filter((assignment) => assignment.free).length;

  return {
    start: startKey,
    seed: seedValue,
    days,
    summary: {
      avgKcal: averageOf(kcalValues, 0),
      avgProtein: averageOf(proteinValues, 0),
      uniqueDishes: new Set(picks.map((pick) => pick.dish.id)).size,
      cuisines,
      cuisineCounts,
      estimatedCost: roundTo(estimatedCost, 0),
      freeMeals,
    },
    fallbackNote: notes.size > 0 ? [...notes].sort().join('；') : null,
  };
}

/**
 * 汇总用餐记录（纯函数）：连续记录、重复率、均热量 / 蛋白、依从度、自由餐与菜系画像。
 *
 * - `streak`：从今天（今天未记录则从昨天）往前连续有记录的天数；
 * - `repeatRate`：同一时段内重复菜的比例（1 - 不重复菜数 / 记录数）；
 * - `adherence`：（午餐 + 晚餐记录数）/（窗口内应记录数），窗口为最近 ≤7 天且不早于阶段开始日；
 * - `freeMealsUsed`：窗口内被判定为「自由餐」的记录数（菜品阶段拟合 < 2，或记录 marked free）；
 * - `topCuisines`：按菜谱库把 dishId 映射到菜系后的 Top 菜系。
 *
 * @param {object} [options] 参数
 * @param {Array<{date?: string, meal?: string, dishId?: string, dishName?: string, cuisine?: string, rating?: number, kcal?: number, proteinG?: number, free?: boolean}>} [options.meals=[]] 用餐记录
 * @param {object} [options.phase] 阶段
 * @param {object} [options.profile] 用户档案
 * @param {Date | number | string} [options.today=new Date()] 参照「今天」
 * @param {Array} [options.catalog=DISHES] 菜品库（用于 dishId -> 菜系 / 阶段拟合映射）
 * @returns {{ streak: number, loggedDays: number, repeatRate: number, avgKcal: number | null, avgProtein: number | null, adherence: number, topCuisines: Array<{cuisine: string, count: number}>, freeMealsUsed: number, totalMeals: number, window: {from: string, to: string} }} 统计
 */
export function summarizeMeals(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const meals = Array.isArray(source.meals) ? source.meals : [];
  const catalog = Array.isArray(source.catalog) && source.catalog.length > 0 ? source.catalog : DISHES;
  const phase = resolvePhaseObject(source.phase, 'performance');
  const today = toDateKey(source.today === undefined ? new Date() : source.today);
  const todayIndex = dayIndex(today);
  const dishById = new Map();
  for (const dish of catalog) {
    if (!dish || typeof dish !== 'object' || typeof dish.id !== 'string') continue;
    dishById.set(dish.id, dish);
  }

  // 归一化记录，同一 (date, meal) 只保留最后一条（写接口语义：同餐次覆盖）
  const bySlot = new Map();
  for (const meal of meals) {
    if (!meal || typeof meal !== 'object') continue;
    const dateKey = tryToDateKey(meal.date);
    if (!dateKey) continue;
    const mealKey = MEALS.includes(meal.meal) ? meal.meal : null;
    const dishId = typeof meal.dishId === 'string' && meal.dishId !== ''
      ? meal.dishId
      : meal.dish && typeof meal.dish.id === 'string'
        ? meal.dish.id
        : '';
    const dish = dishId ? dishById.get(dishId) ?? null : null;
    const kcal = finiteNumber(meal.kcal) ?? (dish ? finiteNumber(dish.nutrition && dish.nutrition.kcal) : null);
    const protein = finiteNumber(meal.proteinG) ?? (dish ? finiteNumber(dish.nutrition && dish.nutrition.protein) : null);
    const cuisine = typeof meal.cuisine === 'string' && meal.cuisine !== ''
      ? meal.cuisine
      : dish && typeof dish.cuisine === 'string'
        ? dish.cuisine
        : null;
    const entry = { date: dateKey, meal: mealKey, dishId, dish, cuisine, kcal, protein, free: meal.free === true };
    const slotKey = mealKey === null ? `${dateKey}|~${bySlot.size}` : `${dateKey}|${mealKey}`;
    bySlot.set(slotKey, entry);
  }
  const entries = [...bySlot.values()];

  // 连续记录天数
  const loggedDates = new Set(entries.map((entry) => entry.date));
  let streak = 0;
  if (todayIndex !== null && loggedDates.size > 0) {
    let cursor = today;
    if (!loggedDates.has(today)) {
      cursor = shiftDateKey(today, -1);
      if (!loggedDates.has(cursor)) cursor = null;
    }
    while (cursor !== null && loggedDates.has(cursor)) {
      streak += 1;
      cursor = shiftDateKey(cursor, -1);
    }
  }

  // 重复率
  const dishIds = entries.map((entry) => entry.dishId).filter((id) => id !== '');
  const uniqueDishCount = new Set(dishIds).size;
  const repeatRate = entries.length > 0 ? roundTo(1 - uniqueDishCount / entries.length, 3) : 0;

  // 平均营养
  const kcalValues = entries.map((entry) => entry.kcal).filter((value) => value !== null);
  const proteinValues = entries.map((entry) => entry.protein).filter((value) => value !== null);

  // 依从度窗口：最近 ≤7 天，且不早于阶段开始日
  let windowDays = 7;
  if (todayIndex !== null && typeof phase.start === 'string' && dayIndex(phase.start) !== null) {
    const since = todayIndex - dayIndex(phase.start) + 1;
    if (since >= 1) windowDays = Math.min(7, since);
  }
  const windowFrom = shiftDateKey(today, -(windowDays - 1));
  const fromIndex = dayIndex(windowFrom);
  const toIndex = todayIndex;
  const inWindow = (date) => {
    const index = dayIndex(date);
    return index !== null && fromIndex !== null && toIndex !== null && index >= fromIndex && index <= toIndex;
  };
  const mainMeals = entries.filter((entry) => (entry.meal === 'lunch' || entry.meal === 'dinner') && inWindow(entry.date));
  const expected = windowDays * 2;
  const adherence = expected > 0 ? roundTo(Math.min(1, mainMeals.length / expected), 3) : 0;

  // 自由餐
  let freeMealsUsed = 0;
  for (const entry of entries) {
    if (entry.date < windowFrom) continue;
    const fit = entry.dish ? dishPhaseFit(entry.dish, phase.kind, phase.subgoal) : 3;
    if (entry.free || fit < FREE_MEAL_MAX_FIT) freeMealsUsed += 1;
  }

  // 菜系画像
  const cuisineCounts = new Map();
  for (const entry of entries) {
    if (!entry.cuisine) continue;
    cuisineCounts.set(entry.cuisine, (cuisineCounts.get(entry.cuisine) ?? 0) + 1);
  }
  const topCuisines = [...cuisineCounts.entries()]
    .map(([cuisine, count]) => ({ cuisine, count }))
    .sort((left, right) => (right.count !== left.count ? right.count - left.count : left.cuisine < right.cuisine ? -1 : 1))
    .slice(0, 5);

  return {
    streak,
    loggedDays: loggedDates.size,
    repeatRate,
    avgKcal: averageOf(kcalValues, 0),
    avgProtein: averageOf(proteinValues, 0),
    adherence,
    topCuisines,
    freeMealsUsed,
    totalMeals: entries.length,
    window: { from: windowFrom, to: today },
  };
}
