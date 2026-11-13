/**
 * 「今天吃什么」推荐内核 —— 采买清单。
 *
 * 纯 JS（ESM）、零依赖，host 与 client 两端共用。
 *
 * 输入周计划（planWeek 输出或 state.plan.picks）与菜谱库，按「日期窗口 + 份数」
 * 展开用量，再聚合同名同单位食材（g/kg/斤/两、ml/L 可换算；个/根/把/瓣/勺 等
 * 计数单位各自成行），最后按食材分区（group）排序输出。
 */
import { dayIndex, shiftDateKey, toDateKey, tryToDateKey } from './time.js';

/** 默认采买窗口天数。 */
const DEFAULT_DAYS = 3;

/** 默认份数。 */
const DEFAULT_SERVINGS = 1;

/** 食材分区展示顺序（未列出的分区排在末尾，按名称升序）。 */
const GROUP_ORDER = Object.freeze([
  '蔬菜', '肉蛋', '水产', '豆制品', '主食', '米面', '调料', '水果', '乳品', '干货', '其他',
]);

/** 质量单位换算到克的系数。 */
const MASS_UNITS = Object.freeze({ g: 1, 克: 1, kg: 1000, 千克: 1000, 公斤: 1000, 斤: 500, 两: 50 });

/** 体积单位换算到毫升的系数。 */
const VOLUME_UNITS = Object.freeze({ ml: 1, 毫升: 1, L: 1000, l: 1000, 升: 1000 });

/**
 * 按 id 查找菜谱：支持数组、Map、以及以 dishId 为键的普通对象。
 *
 * @param {Array | Map | object | null | undefined} recipes 菜谱库
 * @param {string} dishId 菜品 id（或 recipeId）
 * @returns {object | null} 菜谱；找不到返回 null
 */
export function recipeForDish(recipes, dishId) {
  if (!dishId || (typeof dishId !== 'string' && typeof dishId !== 'number')) return null;
  const id = String(dishId);
  if (!recipes) return null;
  if (recipes instanceof Map) return recipes.get(id) ?? null;
  if (Array.isArray(recipes)) {
    for (const recipe of recipes) {
      if (!recipe || typeof recipe !== 'object') continue;
      if (recipe.dishId === id || recipe.id === id) return recipe;
    }
    return null;
  }
  if (typeof recipes === 'object') {
    const direct = recipes[id];
    return direct && typeof direct === 'object' ? direct : null;
  }
  return null;
}

/**
 * 解析单位类别与换算信息。
 *
 * @param {unknown} unit 原始单位
 * @returns {{ kind: 'mass'|'volume'|'count', base: number, unit: string, canonical: string }} 单位信息
 */
function unitInfo(unit) {
  const text = typeof unit === 'string' ? unit.trim() : '';
  if (Number.isFinite(MASS_UNITS[text])) {
    return { kind: 'mass', base: MASS_UNITS[text], unit: text, canonical: 'g' };
  }
  if (Number.isFinite(VOLUME_UNITS[text])) {
    return { kind: 'volume', base: VOLUME_UNITS[text], unit: text, canonical: 'ml' };
  }
  const fallback = text === '' ? '份' : text;
  return { kind: 'count', base: 1, unit: fallback, canonical: fallback };
}

/**
 * 取数字（有限），非法返回 null。
 *
 * @param {unknown} value 原始值
 * @returns {number | null} 数值或 null
 */
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 把数量取整（>0 时至少 1，避免「0.4 斤」显示成 0）。
 *
 * @param {number} amount 数量
 * @returns {number} 取整后的数量
 */
function roundAmount(amount) {
  const rounded = Math.round(amount);
  return rounded === 0 && amount > 0 ? 1 : rounded;
}

/**
 * 菜品分区排序值。
 *
 * @param {string} group 分区名
 * @returns {number} 排序值
 */
function groupRank(group) {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

/**
 * 稳定字符串比较（避免依赖 locale / ICU 差异）。
 *
 * @param {string} left 左值
 * @param {string} right 右值
 * @returns {number} 比较结果
 */
function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 从计划里展开「日期 + 菜品」条目。
 *
 * 兼容两种形状：
 * - planWeek 输出：`{ start, days:[{date, meals:[{meal, dish, dishId, mode}]}] }`
 * - state.plan：`{ start, picks:[{date, meal, dishId, mode}] }`
 *
 * @param {object} plan 计划
 * @returns {Array<{date: string, meal: string, dish: object|null, dishId: string, price: number|null}>} 条目
 */
function collectPlanEntries(plan) {
  const entries = [];
  if (!plan || typeof plan !== 'object') return entries;
  const pushEntry = (date, meal, dish, dishId) => {
    const id = typeof dishId === 'string' && dishId !== ''
      ? dishId
      : typeof dish === 'object' && dish && typeof dish.id === 'string'
        ? dish.id
        : '';
    if (!id) return;
    const dateKey = tryToDateKey(date);
    entries.push({
      date: dateKey,
      meal: typeof meal === 'string' ? meal : '',
      dish: dish && typeof dish === 'object' ? dish : null,
      dishId: id,
      price: dish && typeof dish === 'object' ? numberOrNull(dish.price) : null,
    });
  };
  if (Array.isArray(plan.days)) {
    for (const day of plan.days) {
      if (!day || typeof day !== 'object' || !Array.isArray(day.meals)) continue;
      for (const item of day.meals) {
        if (!item || typeof item !== 'object') continue;
        pushEntry(item.date === undefined ? day.date : item.date, item.meal, item.dish, item.dishId);
      }
    }
  } else if (Array.isArray(plan.picks)) {
    for (const pick of plan.picks) {
      if (!pick || typeof pick !== 'object') continue;
      pushEntry(pick.date, pick.meal, pick.dish, pick.dishId);
    }
  }
  return entries;
}

/**
 * 聚合同名同单位食材：同名且可换算的合并，不可换算的单位分别列出。
 *
 * @param {Array<{date: string, meal: string, dishId: string, dish: object|null, price: number|null}>} entries 窗口内计划条目
 * @param {Array | Map | object | null | undefined} recipes 菜谱库
 * @param {number} servings 份数（相对菜谱基准 servings 的倍数）
 * @returns {{ buckets: Map<string, object>, missing: Set<string> }} 聚合桶与缺菜谱的菜品 id
 */
function aggregateIngredients(entries, recipes, servings) {
  const buckets = new Map();
  const missing = new Set();

  for (const entry of entries) {
    const recipeId = entry.dish && typeof entry.dish === 'object' && typeof entry.dish.recipeId === 'string'
      ? entry.dish.recipeId
      : entry.dishId;
    const recipe = recipeForDish(recipes, recipeId);
    if (!recipe || !Array.isArray(recipe.ingredients)) {
      missing.add(entry.dishId);
      continue;
    }
    const recipeServings = numberOrNull(recipe.servings);
    const factor = servings / (recipeServings !== null && recipeServings > 0 ? recipeServings : 1);
    for (const ingredient of recipe.ingredients) {
      if (!ingredient || typeof ingredient !== 'object') continue;
      const name = typeof ingredient.name === 'string' ? ingredient.name.trim() : '';
      if (!name) continue;
      const amount = numberOrNull(ingredient.amount);
      if (amount === null || amount <= 0) continue;
      const info = unitInfo(ingredient.unit);
      const group = typeof ingredient.group === 'string' && ingredient.group.trim() !== ''
        ? ingredient.group.trim()
        : '其他';
      const key = info.kind === 'count'
        ? `${name}\u0000count\u0000${info.unit}`
        : `${name}\u0000${info.kind}`;
      const quantity = amount * factor;
      const bucket = buckets.get(key) || {
        name,
        kind: info.kind,
        group,
        canonical: info.canonical,
        totalBase: 0,
        originals: new Map(),
      };
      bucket.totalBase += quantity * info.base;
      bucket.originals.set(info.unit, (bucket.originals.get(info.unit) ?? 0) + quantity);
      buckets.set(key, bucket);
    }
  }
  return { buckets, missing };
}

/**
 * 把聚合桶转成输出条目（数量取整、单位保留）。
 *
 * @param {Map<string, object>} buckets 聚合桶
 * @returns {Array<{group: string, name: string, amount: number, unit: string}>} 扁平条目
 */
function bucketsToItems(buckets) {
  const items = [];
  for (const bucket of buckets.values()) {
    let unit;
    let amount;
    if (bucket.kind === 'count') {
      unit = bucket.canonical;
      amount = bucket.originals.get(unit) ?? bucket.totalBase;
    } else if (bucket.originals.size === 1) {
      // 全程使用同一单位时保留原单位（g 还是 g、kg 还是 kg）
      const [originalUnit, originalAmount] = [...bucket.originals.entries()][0];
      unit = originalUnit;
      amount = originalAmount;
    } else {
      // 混合单位：统一换算到基准单位后输出
      unit = bucket.canonical;
      amount = bucket.totalBase;
    }
    items.push({
      group: bucket.group,
      name: bucket.name,
      amount: roundAmount(amount),
      unit,
    });
  }
  return items;
}

/**
 * 构建采买清单。
 *
 * @param {object} [options] 参数
 * @param {object} [options.plan] 周计划（planWeek 输出或 state.plan）
 * @param {Array | Map | object} [options.recipes] 菜谱库
 * @param {number} [options.days=3] 采买窗口天数
 * @param {number} [options.servings=1] 份数（相对菜谱基准 servings 的倍数）
 * @param {object} [options.profile] 用户档案（保留参数，当前不影响聚合）
 * @param {Array | Map | object} [options.catalog] 可选菜品库：plan 只有 dishId 时用于补 dish 对象与价格
 * @returns {{ window: {from: string, to: string}, groups: Array<{group: string, items: Array<{name: string, amount: number, unit: string}>}>, estimatedCost: number, missingRecipes: string[] }} 采买清单
 */
export function buildShoppingList(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const plan = source.plan && typeof source.plan === 'object' ? source.plan : {};

  const daysRaw = numberOrNull(source.days);
  const days = daysRaw !== null && daysRaw >= 1 ? Math.min(30, Math.round(daysRaw)) : DEFAULT_DAYS;
  const servingsRaw = numberOrNull(source.servings);
  const servings = servingsRaw !== null && servingsRaw > 0 ? Math.min(20, servingsRaw) : DEFAULT_SERVINGS;

  const entries = collectPlanEntries(plan).filter((entry) => entry.date !== null);

  // 可选 catalog：state.plan.picks 只有 dishId 时，用菜品库补 dish 对象与价格
  if (source.catalog !== undefined && source.catalog !== null) {
    const lookup = (id) => {
      const catalog = source.catalog;
      if (catalog instanceof Map) return catalog.get(id) ?? null;
      if (Array.isArray(catalog)) {
        const found = catalog.find((dish) => dish && typeof dish === 'object' && dish.id === id);
        return found ?? null;
      }
      if (typeof catalog === 'object') {
        const found = catalog[id];
        return found && typeof found === 'object' ? found : null;
      }
      return null;
    };
    for (const entry of entries) {
      if (entry.dish !== null && entry.price !== null) continue;
      const dish = lookup(entry.dishId);
      if (!dish) continue;
      if (entry.dish === null) entry.dish = dish;
      if (entry.price === null) entry.price = numberOrNull(dish.price);
    }
  }
  const entryDates = entries.map((entry) => entry.date).sort(compareText);
  let from;
  try {
    from = toDateKey(plan.start === undefined ? (entryDates[0] ?? new Date()) : plan.start);
  } catch {
    from = toDateKey(new Date());
  }
  const to = shiftDateKey(from, days - 1);
  const fromIndex = dayIndex(from);
  const toIndex = dayIndex(to);
  const windowEntries = entries.filter((entry) => {
    const index = dayIndex(entry.date);
    return index !== null && fromIndex !== null && toIndex !== null && index >= fromIndex && index <= toIndex;
  });

  const { buckets, missing } = aggregateIngredients(windowEntries, source.recipes, servings);
  const items = bucketsToItems(buckets);

  const groupsMap = new Map();
  for (const item of items) {
    if (!groupsMap.has(item.group)) groupsMap.set(item.group, []);
    groupsMap.get(item.group).push({ name: item.name, amount: item.amount, unit: item.unit });
  }
  const groups = [...groupsMap.entries()]
    .sort((left, right) => {
      const rankDiff = groupRank(left[0]) - groupRank(right[0]);
      return rankDiff !== 0 ? rankDiff : compareText(left[0], right[0]);
    })
    .map(([group, groupItems]) => ({
      group,
      items: groupItems.sort((left, right) => compareText(left.name, right.name)),
    }));

  let cost = 0;
  for (const entry of windowEntries) {
    if (entry.price !== null) cost += entry.price;
  }

  return {
    window: { from, to },
    groups,
    estimatedCost: Math.round(cost * 100) / 100,
    missingRecipes: [...missing].sort(compareText),
  };
}
