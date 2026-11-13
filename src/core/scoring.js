/**
 * 「今天吃什么」推荐内核 —— 单道菜打分。
 *
 * 纯 JS（ESM）、零依赖，host 与 client 两端共用。
 *
 * 两层逻辑：
 * 1. 硬过滤（{@link dishEligible}）：素食、过敏原 / 忌口、辣度上限、预算、
 *    城市可得性（dish.regions）、自制模式可得性；不满足直接判 0 分。
 * 2. 软打分（0-100）：阶段契合度 + 营养目标（蛋白 / 热量带 / 脂肪 / 蔬菜）
 *    + 口味匹配 + 新鲜度（近 7 天强扣分、14 天降权）+ 价格 / 自制加成。
 */
import { canonicalPhaseKind, phaseTargets } from './phase.js';
import { phaseFitFor, phaseHardEligible, phaseScoreAdjustment } from './phase-rules.js';
import { dishSourOf, dishSpicyRank, tasteMatch, tasteProfileOf } from './taste.js';
import { dayIndex, tryToDateKey } from './time.js';

/** 辣度 -> 1-3 序号。 */
const SPICY_RANK = Object.freeze({ mild: 1, medium: 2, hot: 3 });

/** 阶段拟合最低阈值（低于该值的菜属于「自由菜」，由周计划的自由餐额度控制）。 */
export const PHASE_MIN_FIT = 2;

/** 近 7 天已吃过的菜扣分。 */
const RECENT_7D_PENALTY = 45;

/** 近 8-14 天已吃过的菜扣分。 */
const RECENT_14D_PENALTY = 15;

/**
 * 取有限数字，非法返回 null。
 *
 * @param {unknown} value 原始值
 * @returns {number | null} 有限数字或 null
 */
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

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
 * 提取菜品营养信息（缺字段为 null）。
 *
 * @param {object | null | undefined} dish 菜品
 * @returns {{ kcal: number | null, protein: number | null, fat: number | null, carbs: number | null, veg: number | null }} 营养
 */
export function dishNutritionOf(dish) {
  const nutrition = dish && typeof dish === 'object' && dish.nutrition && typeof dish.nutrition === 'object'
    ? dish.nutrition
    : {};
  return {
    kcal: numberOrNull(nutrition.kcal),
    protein: numberOrNull(nutrition.protein),
    fat: numberOrNull(nutrition.fat),
    carbs: numberOrNull(nutrition.carbs),
    veg: numberOrNull(nutrition.veg),
  };
}

/**
 * 取菜品的阶段拟合等级（1-5）。
 *
 * 旧四维阶段直接读 dish.phases；新阶段由 phase-rules 动态计算。
 *
 * @param {object | null | undefined} dish 菜品
 * @param {string} kind 阶段类型（可旧名）
 * @param {string | null} [subgoal] 子目标
 * @returns {number} 1-5
 */
export function dishPhaseFit(dish, kind, subgoal) {
  return phaseFitFor(dish, kind, subgoal);
}

/**
 * 解析用户辣度上限：优先显式 preferences / maxSpicy，其次从 taste.spicy 推导。
 *
 * @param {object | null | undefined} profile 用户档案
 * @returns {'mild'|'medium'|'hot'} 辣度上限
 */
function resolveMaxSpicy(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const explicit = source.preferences && typeof source.preferences === 'object'
    ? source.preferences.maxSpicy
    : undefined;
  if (['mild', 'medium', 'hot'].includes(explicit)) return explicit;
  if (['mild', 'medium', 'hot'].includes(source.maxSpicy)) return source.maxSpicy;
  const spice = tasteProfileOf(source).spicy;
  if (spice >= 4) return 'hot';
  if (spice >= 2) return 'medium';
  return 'mild';
}

/**
 * 解析人均预算上限（元）：budget.perMeal 数组第二个值优先，其次 maxPrice。
 *
 * @param {object | null | undefined} profile 用户档案
 * @returns {number | null} 预算上限或 null（不限）
 */
function resolveBudgetMax(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const perMeal = source.budget && Array.isArray(source.budget.perMeal) ? source.budget.perMeal : null;
  if (perMeal && perMeal.length >= 2) {
    const max = numberOrNull(perMeal[1]);
    if (max !== null && max > 0) return max;
  }
  const legacy = numberOrNull(source.maxPrice);
  return legacy !== null && legacy > 0 ? legacy : null;
}

/**
 * 归一化字符串数组（去空白、去重、小写可选项由调用方处理）。
 *
 * @param {unknown} input 原始数组
 * @returns {string[]} 字符串数组
 */
function stringList(input) {
  if (!Array.isArray(input)) return [];
  const values = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text) values.push(text);
  }
  return values;
}

/**
 * 判断菜品是否满足全部硬过滤条件。
 *
 * 硬过滤包括：素食（dietary.vegetarian / 旧 preferences.vegetarian）、
 * 过敏原与忌口（匹配 ingredients、tags）、辣度上限（taste.spicy 映射）、
 * 人均预算上限（budget.perMeal[1]）、城市可得性（dish.regions）、
 * 自制模式（mode='home' 时排除 cookable=false 的菜）。
 *
 * @param {object} dish 菜品
 * @param {object} [ctx] 打分上下文（同 {@link dishScore}）
 * @returns {boolean} 是否可进入候选池
 */
export function dishEligible(dish, ctx = {}) {
  if (!dish || typeof dish !== 'object' || typeof dish.id !== 'string' || !Array.isArray(dish.tags)) return false;
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const profile = context.profile && typeof context.profile === 'object' ? context.profile : {};
  const dietary = profile.dietary && typeof profile.dietary === 'object' ? profile.dietary : {};
  const tags = dish.tags;
  const ingredients = stringList(dish.ingredients);

  // 素食：排除含 meat / seafood 的菜（蛋奶素允许）
  const vegetarian = profile.vegetarian === true || dietary.vegetarian === true;
  if (vegetarian && (tags.includes('meat') || tags.includes('seafood'))) return false;

  // 过敏原 / 忌口：命中 ingredients 或 tags 即排除
  const denies = [...stringList(dietary.allergies), ...stringList(dietary.avoidTags), ...stringList(profile.avoidTags)];
  for (const deny of denies) {
    if (tags.includes(deny) || tags.includes(deny.toLowerCase())) return false;
    if (ingredients.some((item) => item.includes(deny) || deny.includes(item))) return false;
  }

  // 辣度上限
  const maxSpicy = resolveMaxSpicy(profile);
  if (SPICY_RANK[['mild', 'medium', 'hot'][dishSpicyRank(dish) - 1]] > SPICY_RANK[maxSpicy]) return false;

  // 人均预算上限
  const budgetMax = resolveBudgetMax(profile);
  const price = numberOrNull(dish.price);
  if (budgetMax !== null && price !== null && price > budgetMax) return false;

  // 城市可得性：dish.regions 非空时必须包含用户所在大区
  const regions = Array.isArray(dish.regions) ? dish.regions : Array.isArray(dish.availableRegions) ? dish.availableRegions : [];
  const region = profile.identity && typeof profile.identity === 'object' ? profile.identity.region : null;
  if (regions.length > 0 && typeof region === 'string' && region !== '' && !regions.includes(region)) return false;

  // 自制模式：明确标注不可自制的菜不进候选
  if (context.mode === 'home' && dish.cookable === false) return false;

  // 新阶段硬过滤（纯素 / 蛋奶素）
  const phase = context.phase && typeof context.phase === 'object' ? context.phase : {};
  const kind = canonicalPhaseKind(phase.kind) ?? canonicalPhaseKind(phase.phaseKind) ?? canonicalPhaseKind(context.phaseKind);
  if (kind && !phaseHardEligible(dish, kind, phase.subgoal)) return false;

  return true;
}

/**
 * 计算近 7 天 / 14 天历史扣分。
 *
 * @param {object} dish 菜品
 * @param {object} ctx 打分上下文
 * @param {string | null} dateKey 目标日期
 * @returns {number} 扣分（负数或 0）
 */
function freshnessPenalty(dish, ctx, dateKey) {
  if (!Array.isArray(ctx.history) || !dateKey) return 0;
  const target = dayIndex(dateKey);
  if (target === null) return 0;
  let penalty = 0;
  for (const entry of ctx.history) {
    if (!entry || typeof entry !== 'object') continue;
    const entryDishId = typeof entry.dishId === 'string' ? entry.dishId : entry.dish && entry.dish.id;
    if (entryDishId !== dish.id) continue;
    const entryKey = tryToDateKey(entry.date);
    if (!entryKey) continue;
    const index = dayIndex(entryKey);
    if (index === null) continue;
    const diff = target - index;
    if (diff >= 0 && diff <= 6) return -RECENT_7D_PENALTY;
    if (diff >= 7 && diff <= 13) penalty = Math.max(penalty, RECENT_14D_PENALTY);
  }
  return -penalty;
}

/**
 * 解析阶段类型（容错）。
 *
 * @param {object} ctx 打分上下文
 * @returns {string} 阶段类型
 */
function resolvePhaseKind(ctx) {
  const phase = ctx.phase && typeof ctx.phase === 'object' ? ctx.phase : {};
  return (
    canonicalPhaseKind(phase.kind) ??
    canonicalPhaseKind(phase.phaseKind) ??
    canonicalPhaseKind(ctx.phaseKind) ??
    'performance'
  );
}

/**
 * 计算单道菜得分（0-100）。
 *
 * 硬过滤不通过 -> 0；否则至少 1 分。评分构成：
 * - 基础 50 分；
 * - 阶段拟合（dish.phases[kind]，1-5 -> ±20）；
 * - 营养：蛋白相对目标、热量是否进目标带、脂肪 / 重油、蔬菜份数；
 * - 口味：tasteMatch × 12（-24 ～ +24）；
 * - 新鲜度：近 7 天 -45、近 8-14 天 -15；
 * - 价格接近预算下沿 +1 ～ +3、自制模式可做 +4、sourBias 果酸加成。
 *
 * @param {object} dish 菜品
 * @param {object} [ctx] 打分上下文
 * @param {object} [ctx.profile] 用户档案
 * @param {object} [ctx.phase] 阶段对象（kind/subgoal/targets）
 * @param {Array<{dishId?: string, date?: string}>} [ctx.history] 用餐历史
 * @param {Date | number | string} [ctx.date] 目标日期
 * @param {string} [ctx.meal] 餐次
 * @param {'home'|'out'} [ctx.mode] 模式
 * @param {number} [ctx.sourBias] 额外果酸偏好（-1 ～ +1）
 * @returns {number} 0-100 的整数分数
 */
export function dishScore(dish, ctx = {}) {
  if (!dishEligible(dish, ctx)) return 0;
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const profile = context.profile && typeof context.profile === 'object' ? context.profile : {};
  const kind = resolvePhaseKind(context);
  const phase = { kind, subgoal: context.phase && context.phase.subgoal, targets: context.phase && context.phase.targets };
  const targets = phaseTargets(phase, profile);
  const nutrition = dishNutritionOf(dish);
  const fit = dishPhaseFit(dish, kind, phase.subgoal);
  const isStrictPhase = kind !== 'treat';

  let score = 50;

  // 阶段拟合：1 -> -20，3 -> 0，5 -> +20
  score += ((fit - 3) / 2) * 20;
  score += phaseScoreAdjustment(dish, kind, phase.subgoal);

  // 营养：蛋白 / 热量 / 脂肪 / 蔬菜
  if (isStrictPhase && targets.proteinG > 0 && nutrition.protein !== null) {
    const perMealTarget = targets.proteinG / 3;
    const ratio = nutrition.protein / perMealTarget;
    const proteinFactor = kind === 'performance' ? 1 : kind === 'recovery' ? 0.9 : 0.75;
    score += clamp((ratio - 0.6) * 12, -8, 14) * proteinFactor;
  }
  if (targets.kcalMin !== null && targets.kcalMax !== null && nutrition.kcal !== null) {
    const perMealMin = targets.kcalMin / 3;
    const perMealMax = targets.kcalMax / 3;
    if (nutrition.kcal > perMealMax * 1.05) {
      score -= Math.min(16, (nutrition.kcal / perMealMax - 1) * 20);
    } else if (nutrition.kcal >= perMealMin * 0.75) {
      score += 6;
    } else if (nutrition.kcal < perMealMin * 0.5) {
      score -= 3;
    }
  }
  if (nutrition.fat !== null && isStrictPhase && nutrition.fat > 22) {
    const fatFactor = kind === 'performance' ? 1 : 0.85;
    score -= Math.min(10, (nutrition.fat - 22) * 0.5) * fatFactor;
  }
  if (isStrictPhase && dish.category === '火锅烧烤') score -= 6;
  if (Array.isArray(dish.tags) && dish.tags.includes('light')) score += 2;
  if (nutrition.veg !== null) {
    const vegWeight = kind === 'high_fiber' ? 3 : kind === 'low_sodium' ? 2.2 : kind === 'performance' ? 1.5 : 1.2;
    score += clamp(nutrition.veg, 0, 5) * vegWeight;
  }

  // 口味
  score += tasteMatch(dish, profile) * 12;

  // 额外果酸偏好（例如当天想吃酸的）
  const sourBias = numberOrNull(context.sourBias);
  if (sourBias !== null) {
    score += clamp(sourBias, -1, 1) * (dishSourOf(dish).fruit / 5) * 8;
  }

  // 价格：接近预算下沿更省
  const budgetMax = resolveBudgetMax(profile);
  const price = numberOrNull(dish.price);
  if (budgetMax !== null && price !== null) {
    if (price <= budgetMax * 0.6) score += 3;
    else if (price <= budgetMax) score += 1;
  }

  // 自制模式：可做的菜优先
  if (context.mode === 'home' && dish.cookable === true) score += 4;

  // 新鲜度
  const dateKey = tryToDateKey(context.date);
  score += freshnessPenalty(dish, context, dateKey);

  return Math.round(clamp(score, 1, 100));
}
