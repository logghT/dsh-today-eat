/**
 * 「今天吃什么」v2 推荐内核单元测试。
 *
 * 使用内联 fixture（4-8 道小菜品库），不依赖 data/ 的具体菜名与数量，
 * 保证在 data 扩充期间稳定。运行：
 *   $node='<USER_HOME>\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'
 *   & $node --test "tests/core/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FITNESS_SUBGOALS,
  PHASES,
  PHASE_META,
  PHASE_SUBGOALS,
  SUBGOALS,
  SUBGOAL_META,
  normalizePhase,
  phaseLabel,
  phaseTargets,
} from '../../src/core/phase.js';
import { learnFromMeal, tasteMatch } from '../../src/core/taste.js';
import { dishEligible, dishPhaseFit, dishScore } from '../../src/core/scoring.js';
import { planWeek, recommendMeal, summarizeMeals } from '../../src/core/recommend.js';
import { buildShoppingList, recipeForDish } from '../../src/core/shopping.js';
import { DEFAULT_MEAL_TIMES, mealTimeState } from '../../src/core/mealTime.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 构造一道字段完整的 fixture 菜。
 *
 * @param {string} id 菜品 id
 * @param {object} [overrides={}] 覆盖字段
 * @returns {object} 菜品
 */
function makeDish(id, overrides = {}) {
  return {
    id,
    name: `测试菜-${id}`,
    emoji: '🍲',
    category: '家常菜',
    cuisine: '川菜',
    tags: ['medium', 'meat', 'rice'],
    price: 30,
    description: '内联 fixture 测试菜品，用于推荐内核单元测试',
    phases: { fitness: 3, healthy: 3, relax: 3, indulgence: 3 },
    nutrition: { kcal: 600, protein: 30, fat: 15, carbs: 60, veg: 1 },
    sour: { fruit: 0, fermented: 0, vinegar: 0 },
    origins: ['云南'],
    ingredients: ['鸡胸肉', '青柠'],
    cookable: true,
    recipeId: id,
    regions: [],
    ...overrides,
  };
}

/** 小菜品库（8 道，覆盖不同阶段拟合 / 菜系 / 价格 / 营养）。 */
const CATALOG = [
  makeDish('dish-a', {
    cuisine: '川菜',
    tags: ['hot', 'meat', 'rice'],
    sour: { fruit: 4, fermented: 1, vinegar: 1 },
    nutrition: { kcal: 750, protein: 38, fat: 20, carbs: 80, veg: 1 },
    price: 28,
  }),
  makeDish('dish-b', {
    cuisine: '西南',
    origins: ['云南'],
    tags: ['medium', 'meat', 'noodle'],
    sour: { fruit: 5, fermented: 0, vinegar: 0 },
    nutrition: { kcal: 640, protein: 32, fat: 14, carbs: 70, veg: 2 },
    price: 32,
  }),
  makeDish('dish-c', {
    cuisine: '粤菜',
    tags: ['mild', 'veg', 'soup'],
    phases: { fitness: 4, healthy: 5, relax: 3, indulgence: 2 },
    nutrition: { kcal: 420, protein: 18, fat: 8, carbs: 50, veg: 3 },
    price: 22,
    ingredients: ['青菜', '豆腐'],
  }),
  makeDish('dish-d', {
    cuisine: '北方',
    tags: ['mild', 'meat', 'rice'],
    phases: { fitness: 5, healthy: 4, relax: 3, indulgence: 1 },
    nutrition: { kcal: 560, protein: 45, fat: 10, carbs: 60, veg: 1 },
    price: 26,
  }),
  makeDish('dish-e', {
    cuisine: '日韩',
    tags: ['mild', 'seafood', 'rice'],
    phases: { fitness: 2, healthy: 3, relax: 4, indulgence: 4 },
    nutrition: { kcal: 700, protein: 30, fat: 22, carbs: 80, veg: 1 },
    price: 45,
  }),
  makeDish('dish-f', {
    cuisine: '川菜',
    tags: ['hot', 'meat', 'soup'],
    sour: { fruit: 2, fermented: 3, vinegar: 2 },
    phases: { fitness: 3, healthy: 2, relax: 4, indulgence: 5 },
    nutrition: { kcal: 900, protein: 40, fat: 40, carbs: 60, veg: 2 },
    price: 55,
  }),
  makeDish('dish-g', {
    cuisine: '快餐',
    tags: ['medium', 'veg', 'noodle'],
    nutrition: { kcal: 520, protein: 15, fat: 12, carbs: 70, veg: 1 },
    price: 18,
    ingredients: ['面粉', '青菜'],
  }),
  makeDish('dish-h', {
    cuisine: '西北',
    tags: ['mild', 'meat', 'noodle'],
    phases: { fitness: 4, healthy: 4, relax: 2, indulgence: 2 },
    nutrition: { kcal: 600, protein: 35, fat: 12, carbs: 75, veg: 1 },
    price: 34,
  }),
];

/** 云南 + 嗜辣 + 嗜果酸的用户档案（对应真实目标用户画像）。 */
const YUNNAN_PROFILE = {
  identity: { hometown: '云南', city: '四川成都', district: '锦江区', region: '西南' },
  taste: { spicy: 5, sourFruit: 5, sourFermented: 2, sourVinegar: 1, sweet: 2, oiliness: 2, adventurous: 4 },
  dietary: { vegetarian: false, allergies: [], avoidTags: [] },
  budget: { perMeal: [15, 60], weekly: 350 },
};

/** 口味清淡 / 不吃辣 / 不爱酸的用户档案（对照组）。 */
const PLAIN_PROFILE = {
  identity: { hometown: '上海', region: '华东' },
  taste: { spicy: 1, sourFruit: 1, sourFermented: 1, sourVinegar: 1, oiliness: 4 },
  dietary: { vegetarian: false, allergies: [], avoidTags: [] },
  budget: { perMeal: [15, 80] },
};

/**
 * 日期键加减天数。
 *
 * @param {string} dateKey YYYY-MM-DD
 * @param {number} delta 天数
 * @returns {string} 新日期键
 */
function shiftKey(dateKey, delta) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + delta * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 取上海时区「今天」的日期键（与内核口径一致）。
 *
 * @returns {string} YYYY-MM-DD
 */
function shanghaiTodayKey() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 生成上海时区某天某时刻的 Date（基准 2026-11-09）。
 *
 * @param {number} hour 小时（0-23）
 * @param {number} [minute=0] 分钟
 * @param {number} [dayOffset=0] 日期偏移
 * @returns {Date} 时刻
 */
function shanghaiClock(hour, minute = 0, dayOffset = 0) {
  return new Date(Date.UTC(2026, 10, 9 + dayOffset, hour - 8, minute, 0));
}

/* ============================ phase ============================ */

test('phase：九阶段枚举 / 元信息 / 子目标', () => {
  assert.deepEqual([...PHASES], [
    'performance',
    'low_sugar',
    'low_sodium',
    'gentle',
    'high_fiber',
    'plant_based',
    'special',
    'recovery',
    'treat',
  ]);
  assert.deepEqual([...FITNESS_SUBGOALS], ['fat_loss', 'muscle_gain', 'maintain', 'weight_gain']);
  for (const kind of PHASES) {
    const meta = PHASE_META[kind];
    assert.ok(typeof meta?.label === 'string' && meta.label.length > 0);
    assert.ok(typeof meta?.desc === 'string' && meta.desc.length > 0);
    assert.ok(typeof meta?.emoji === 'string' && meta.emoji.length > 0);
    assert.ok(Array.isArray(PHASE_SUBGOALS[kind]) && PHASE_SUBGOALS[kind].length > 0);
  }
  for (const subgoal of SUBGOALS) assert.ok(SUBGOAL_META[subgoal]?.label, `缺少子目标文案：${subgoal}`);
});

test('phase：normalizePhase 默认性能阶段 / 旧名迁移 / 子目标回退', () => {
  const phase = normalizePhase();
  assert.equal(phase.kind, 'performance');
  assert.equal(phase.subgoal, 'fat_loss');
  assert.equal(phase.weeks, 8);
  assert.match(phase.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(phase.start, shanghaiTodayKey());
  assert.deepEqual(phase.targets, { kcalMin: 1600, kcalMax: 2000, proteinG: 120, freeMealsPerWeek: 1 });

  // 非法输入回退默认
  const invalid = normalizePhase({ kind: 'unknown', subgoal: 'nope', start: '不是日期', weeks: 0 });
  assert.equal(invalid.kind, 'performance');
  assert.equal(invalid.subgoal, 'fat_loss');
  assert.equal(invalid.start, shanghaiTodayKey());
  assert.equal(invalid.weeks, 1);

  // 旧四阶段 → 新阶段；子目标非法时回退到该阶段第一个
  assert.equal(normalizePhase({ kind: 'fitness' }).kind, 'performance');
  assert.equal(normalizePhase({ kind: 'healthy' }).kind, 'low_sodium');
  assert.equal(normalizePhase({ kind: 'healthy', subgoal: 'fat_loss' }).subgoal, 'low_salt');
  assert.equal(normalizePhase({ kind: 'relax' }).subgoal, 'treat');
  assert.equal(normalizePhase({ kind: 'indulgence' }).subgoal, 'celebrate');

  assert.equal(phaseLabel({ kind: 'fitness', subgoal: 'fat_loss' }), '训练补给 · 减脂');
  assert.equal(phaseLabel({ kind: 'relax' }), '吃的高兴 · 日常犒劳');
  assert.equal(phaseLabel({ kind: 'plant_based', subgoal: 'vegan' }), '多吃素 · 纯素');
});

test('phase：phaseTargets 覆盖九阶段与子目标，支持体重换算与自定义 targets', () => {
  assert.deepEqual(phaseTargets({ kind: 'performance', subgoal: 'fat_loss' }), {
    kcalMin: 1600, kcalMax: 2000, proteinG: 120, freeMealsPerWeek: 1,
  });
  assert.deepEqual(phaseTargets({ kind: 'performance', subgoal: 'muscle_gain' }), {
    kcalMin: 2600, kcalMax: 3000, proteinG: 150, freeMealsPerWeek: 1,
  });
  assert.deepEqual(phaseTargets({ kind: 'performance', subgoal: 'maintain' }), {
    kcalMin: 2000, kcalMax: 2400, proteinG: 120, freeMealsPerWeek: 2,
  });
  assert.deepEqual(phaseTargets({ kind: 'performance', subgoal: 'weight_gain' }), {
    kcalMin: 2800, kcalMax: 3200, proteinG: 135, freeMealsPerWeek: 1,
  });
  assert.deepEqual(phaseTargets({ kind: 'low_sodium', subgoal: 'low_salt' }), {
    kcalMin: 1800, kcalMax: 2200, proteinG: 90, freeMealsPerWeek: 2,
  });
  assert.deepEqual(phaseTargets({ kind: 'low_sugar', subgoal: 'steady' }), {
    kcalMin: 1700, kcalMax: 2100, proteinG: 90, freeMealsPerWeek: 2,
  });
  assert.deepEqual(phaseTargets({ kind: 'special', subgoal: 'prenatal' }), {
    kcalMin: 2000, kcalMax: 2400, proteinG: 105, freeMealsPerWeek: 1,
  });

  const relax = phaseTargets({ kind: 'relax' });
  assert.equal(relax.kcalMin, null, '吃的高兴不设热量下限');
  assert.equal(relax.kcalMax, null, '吃的高兴不设热量上限');
  assert.equal(relax.proteinG, 75);
  assert.deepEqual(phaseTargets({ kind: 'indulgence' }), {
    kcalMin: null, kcalMax: null, proteinG: 68, freeMealsPerWeek: 4,
  });

  // 按体重换算：60kg 减脂 1.6g/kg = 96g
  assert.equal(phaseTargets({ kind: 'performance', subgoal: 'fat_loss' }, { weight: 60 }).proteinG, 96);
  // 旧名别名自动迁移
  assert.equal(phaseTargets({ kind: 'fitness', subgoal: 'fat_loss' }).proteinG, 120);
  // 自定义 targets 覆盖基准值
  const custom = phaseTargets({ kind: 'performance', subgoal: 'fat_loss', targets: { kcalMin: 1700, kcalMax: 1900, proteinG: 130, freeMealsPerWeek: 2 } });
  assert.deepEqual(custom, { kcalMin: 1700, kcalMax: 1900, proteinG: 130, freeMealsPerWeek: 2 });
  // 上下限颠倒时自动交换
  assert.deepEqual(phaseTargets({ kind: 'performance', targets: { kcalMin: 2200, kcalMax: 1800 } }).kcalMin, 1800);
});

/* ============================ taste ============================ */

test('taste：果酸菜对云南果酸档案的匹配显著高于清淡档案', () => {
  const sourDish = makeDish('sour-yunnan', {
    cuisine: '西南',
    origins: ['云南'],
    tags: ['medium', 'meat', 'soup'],
    sour: { fruit: 5, fermented: 1, vinegar: 0 },
    nutrition: { kcal: 500, protein: 30, fat: 10, carbs: 50, veg: 2 },
  });
  const yunnan = tasteMatch(sourDish, YUNNAN_PROFILE);
  const plain = tasteMatch(sourDish, PLAIN_PROFILE);
  assert.ok(yunnan > plain, `云南档案 ${yunnan} 应高于清淡档案 ${plain}`);
  assert.ok(yunnan - plain >= 0.5, `果酸偏好差距应明显，实际差 ${(yunnan - plain).toFixed(2)}`);
  assert.ok(yunnan >= -2 && yunnan <= 2, 'tasteMatch 应落在 -2..+2');
  assert.equal(tasteMatch(sourDish, YUNNAN_PROFILE), yunnan, '同一输入结果确定');
  assert.equal(tasteMatch(null, YUNNAN_PROFILE), 0, '非法菜品返回 0');
});

test('taste：learnFromMeal 用 EWMA 更新学习亲和度且不修改入参', () => {
  const dish = makeDish('learn-dish', { cuisine: '川菜', sour: { fruit: 4, fermented: 1, vinegar: 0 } });
  const before = JSON.parse(JSON.stringify(YUNNAN_PROFILE));
  const plainBaseline = tasteMatch(dish, PLAIN_PROFILE);

  const liked = learnFromMeal(PLAIN_PROFILE, dish, 1);
  assert.deepEqual(YUNNAN_PROFILE, before, 'learnFromMeal 不应修改入参 profile');
  assert.ok(Math.abs(liked.learned.dishes['learn-dish'] - 0.3) < 1e-9, '首次喜欢应得到 0.3');
  assert.ok(Math.abs(liked.learned.cuisines['川菜'] - 0.3) < 1e-9, '菜系亲和度也应更新');
  assert.ok(tasteMatch(dish, liked) > plainBaseline, '喜欢后该菜契合度应提升');

  const disliked = learnFromMeal(liked, dish, -1);
  assert.ok(disliked.learned.dishes['learn-dish'] < liked.learned.dishes['learn-dish'], '不喜欢应降低亲和度');
  assert.ok(tasteMatch(dish, disliked) < tasteMatch(dish, liked));

  const neutral = learnFromMeal(liked, dish, 0);
  assert.ok(Math.abs(neutral.learned.dishes['learn-dish'] - 0.21) < 1e-9, '中性评分让 0.3 × 0.7 = 0.21');
  // 非法输入容错
  assert.deepEqual(learnFromMeal(null, null, 1).learned, { dishes: {}, cuisines: {} });
  assert.deepEqual(learnFromMeal(undefined, dish, 0).learned, { dishes: {}, cuisines: {} });
});

/* ============================ scoring ============================ */

test('scoring：硬过滤（素食 / 忌口 / 预算 / 城市可得性 / 辣度上限）', () => {
  const context = (profile, extra = {}) => ({
    profile, phase: { kind: 'fitness' }, history: [], date: '2026-11-09', meal: 'lunch', ...extra,
  });
  const vegetarian = { ...YUNNAN_PROFILE, dietary: { vegetarian: true, allergies: [], avoidTags: [] } };
  const meatDish = makeDish('meat-x', { tags: ['mild', 'meat', 'rice'] });
  const vegDish = makeDish('veg-x', { tags: ['mild', 'veg', 'rice'], ingredients: ['青菜'] });
  assert.equal(dishEligible(meatDish, context(vegetarian)), false);
  assert.equal(dishScore(meatDish, context(vegetarian)), 0, '素食档案下荤菜 0 分');
  assert.ok(dishScore(vegDish, context(vegetarian)) > 0, '素食菜应通过硬过滤');

  const allergy = { ...YUNNAN_PROFILE, dietary: { vegetarian: false, allergies: ['花生'], avoidTags: ['香菜'] } };
  assert.equal(dishScore(makeDish('peanut-x', { ingredients: ['鸡胸肉', '花生碎'] }), context(allergy)), 0);
  assert.equal(dishScore(makeDish('cilantro-x', { ingredients: ['牛肉', '香菜'] }), context(allergy)), 0);
  assert.ok(dishScore(makeDish('clean-x', { ingredients: ['牛肉', '青椒'] }), context(allergy)) > 0);

  const budget = { ...YUNNAN_PROFILE, budget: { perMeal: [15, 30] } };
  assert.equal(dishEligible(makeDish('pricey-x', { price: 48 }), context(budget)), false);
  assert.ok(dishScore(makeDish('cheap-x', { price: 20 }), context(budget)) > 0);

  const region = makeDish('region-x', { regions: ['华东'] });
  assert.equal(dishScore(region, context(YUNNAN_PROFILE)), 0, '外区限定菜应被过滤');
  assert.ok(dishScore(makeDish('region-y', { regions: ['西南'] }), context(YUNNAN_PROFILE)) > 0);
  assert.ok(dishScore(makeDish('region-z', { regions: [] }), context(YUNNAN_PROFILE)) > 0, '空 regions 视为全国可得');

  // 清淡档案（taste.spicy=1）= 微辣上限，重辣菜被过滤
  const hotDish = makeDish('hot-x', { tags: ['hot', 'meat', 'rice'] });
  assert.equal(dishEligible(hotDish, context(PLAIN_PROFILE)), false);
  assert.ok(dishScore(makeDish('mild-x', { tags: ['mild', 'meat', 'rice'] }), context(PLAIN_PROFILE)) > 0);
  // 辣度 4（默认云南档案）= 不限辣度，与 host legacy 映射保持一致
  const spicyFour = { ...YUNNAN_PROFILE, taste: { ...YUNNAN_PROFILE.taste, spicy: 4 } };
  assert.ok(dishScore(hotDish, context(spicyFour)) > 0, '辣度 4 应允许重辣');
  // 辣度 2 = 中辣上限，重辣仍被过滤
  const spicyTwo = { ...YUNNAN_PROFILE, taste: { ...YUNNAN_PROFILE.taste, spicy: 2 } };
  assert.equal(dishEligible(hotDish, context(spicyTwo)), false);
});

test('scoring：阶段拟合 + 营养目标让健身友好菜得分显著更高', () => {
  const fitnessContext = {
    profile: YUNNAN_PROFILE,
    phase: { kind: 'fitness', subgoal: 'fat_loss' },
    history: [],
    date: '2026-11-09',
    meal: 'lunch',
  };
  const fitHigh = makeDish('fit-high', {
    phases: { fitness: 5, healthy: 5, relax: 2, indulgence: 2 },
    nutrition: { kcal: 600, protein: 45, fat: 8, carbs: 50, veg: 2 },
  });
  const fitLow = makeDish('fit-low', {
    phases: { fitness: 1, healthy: 1, relax: 5, indulgence: 5 },
    nutrition: { kcal: 950, protein: 20, fat: 40, carbs: 80, veg: 0 },
  });
  const high = dishScore(fitHigh, fitnessContext);
  const low = dishScore(fitLow, fitnessContext);
  assert.ok(high > low + 10, `健身友好菜 ${high} 应显著高于放纵菜 ${low}`);
  assert.ok(high >= 1 && high <= 100 && low >= 1 && low <= 100, '得分应落在 1-100');
  // 阶段切换：放纵阶段下低拟合菜（relax/indulgence=5）分数应上升
  const indulgenceContext = { ...fitnessContext, phase: { kind: 'indulgence' } };
  assert.ok(dishScore(fitLow, indulgenceContext) > low, '放纵阶段下放纵菜得分应提高');
});

test('scoring：新鲜度让近 7 天吃过的菜降权，14 天窗口外不再降权', () => {
  const dish = CATALOG[0];
  const base = { profile: YUNNAN_PROFILE, phase: { kind: 'fitness' }, date: '2026-11-09', meal: 'lunch' };
  const fresh = dishScore(dish, { ...base, history: [] });
  const recent = dishScore(dish, { ...base, history: [{ dishId: dish.id, date: '2026-11-07', meal: 'lunch' }] });
  const old = dishScore(dish, { ...base, history: [{ dishId: dish.id, date: '2026-10-30', meal: 'lunch' }] });
  assert.ok(recent < fresh, '近 7 天吃过应扣分');
  assert.ok(old > recent, '14 天窗口外（仅轻微降权）应高于 7 天内');
  assert.ok(old <= fresh);
});

/* ========================== recommendMeal ========================== */

test('recommendMeal：结构 / reason 中文信息 / 确定性 / catalog 顺序无关', () => {
  const options = {
    date: '2026-11-09',
    meal: 'lunch',
    profile: YUNNAN_PROFILE,
    phase: { kind: 'fitness', subgoal: 'fat_loss' },
    catalog: CATALOG,
    seed: 7,
  };
  const first = recommendMeal(options);
  const second = recommendMeal(options);
  assert.deepEqual(first, second, '同一输入结果确定');

  assert.equal(first.date, '2026-11-09');
  assert.equal(first.meal, 'lunch');
  assert.equal(first.phaseKind, 'performance');
  assert.ok(first.dish && typeof first.dish.id === 'string');
  assert.equal(first.alternatives.length, 3, '应返回 3 道备选');
  const ids = [first.dish.id, ...first.alternatives.map((dish) => dish.id)];
  assert.equal(new Set(ids).size, 4, '主选与备选不重复');
  assert.ok(first.nutrition && Number.isFinite(first.nutrition.kcal) && Number.isFinite(first.nutrition.protein));

  for (const word of ['训练补给', '辣', '人均', '近 7 天']) {
    assert.ok(first.reason.includes(word), `reason 应包含「${word}」：${first.reason}`);
  }
  assert.ok(/(酸|甜|苦|咸|鲜|口味)/.test(first.reason), `reason 应含六维味道信息：${first.reason}`);
  assert.match(first.reason, /^周(一|二|三|四|五|六|日)(早餐|午餐|晚餐|夜宵) · /);

  // 与 catalog 数组顺序无关
  const reversed = [...CATALOG].reverse();
  assert.equal(recommendMeal({ ...options, catalog: reversed }).dish.id, first.dish.id);

  // 显式 phaseKind 覆盖 phase.kind，旧名迁移到 canonical
  assert.equal(recommendMeal({ ...options, phaseKind: 'indulgence' }).phaseKind, 'treat');
});

test('recommendMeal：excludeIds 生效、素食硬过滤端到端、无解时给出说明', () => {
  const options = { date: '2026-11-10', meal: 'dinner', profile: YUNNAN_PROFILE, phase: { kind: 'fitness' }, catalog: CATALOG };
  const base = recommendMeal(options);
  const excludedIds = [base.dish.id, ...base.alternatives.map((dish) => dish.id)];
  const next = recommendMeal({ ...options, excludeIds: excludedIds });
  assert.ok(next.dish, '仍有候选时应返回主选');
  assert.ok(!excludedIds.includes(next.dish.id), '不应返回 excludeIds 里的菜');
  assert.ok(next.alternatives.every((dish) => !excludedIds.includes(dish.id)), '备选也应排除 excludeIds');

  const vegetarian = { ...YUNNAN_PROFILE, dietary: { vegetarian: true, allergies: [], avoidTags: [] } };
  const vegResult = recommendMeal({ date: '2026-11-10', meal: 'lunch', profile: vegetarian, catalog: CATALOG, phase: { kind: 'healthy' } });
  for (const dish of [vegResult.dish, ...vegResult.alternatives]) {
    assert.ok(!dish.tags.includes('meat') && !dish.tags.includes('seafood'), `素食结果不应含荤菜：${dish.id}`);
  }

  const impossible = recommendMeal({
    date: '2026-11-10',
    meal: 'lunch',
    profile: { ...YUNNAN_PROFILE, budget: { perMeal: [15, 5] } },
    catalog: CATALOG,
    phase: { kind: 'fitness' },
  });
  assert.equal(impossible.dish, null);
  assert.deepEqual(impossible.alternatives, []);
  assert.equal(impossible.nutrition, null);
  assert.ok(typeof impossible.fallbackNote === 'string' && impossible.fallbackNote.length > 0);
});

/* ============================ planWeek ============================ */

test('planWeek：确定性、7 天同一 dishId 不重复、summary 结构完整', () => {
  const options = {
    startDate: '2026-11-09',
    days: 7,
    meals: ['lunch'],
    profile: YUNNAN_PROFILE,
    phase: { kind: 'fitness', subgoal: 'fat_loss' },
    catalog: CATALOG,
    seed: 7,
  };
  const plan = planWeek(options);
  assert.equal(plan.start, '2026-11-09');
  assert.equal(plan.seed, 7);
  assert.equal(plan.days.length, 7);
  assert.deepEqual(plan.days.map((day) => day.date), [
    '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15',
  ]);

  const dishIds = plan.days.flatMap((day) => day.meals.map((item) => item.dishId));
  assert.equal(dishIds.length, 7);
  assert.equal(new Set(dishIds).size, 7, '7 个槽位应使用 7 道不同的菜');
  for (const day of plan.days) {
    for (const item of day.meals) {
      assert.ok(item.dish && item.dish.id === item.dishId, '应返回完整 dish 对象');
      assert.ok(['home', 'out'].includes(item.mode), 'mode 应为 home/out');
    }
  }
  assert.deepEqual(planWeek(options), plan, '同 (seed,start,phase,profile) 结果确定');
  assert.deepEqual(planWeek({ ...options, catalog: [...CATALOG].reverse() }), plan, '与 catalog 顺序无关');

  const summary = plan.summary;
  assert.ok(Number.isFinite(summary.avgKcal), 'avgKcal 应为数字');
  assert.ok(Number.isFinite(summary.avgProtein), 'avgProtein 应为数字');
  assert.equal(summary.uniqueDishes, 7);
  assert.ok(Array.isArray(summary.cuisines) && summary.cuisines.length > 0);
  assert.equal(new Set(summary.cuisines).size, summary.cuisines.length);
  assert.ok(Number.isFinite(summary.estimatedCost) && summary.estimatedCost > 0);
  assert.ok(Number.isInteger(summary.freeMeals));
  assert.ok(summary.freeMeals <= phaseTargets({ kind: 'fitness', subgoal: 'fat_loss' }).freeMealsPerWeek);
});

test('planWeek：锁定单日 / 单餐，且不破坏 7 天不重复', () => {
  const baseOptions = {
    startDate: '2026-11-09',
    days: 7,
    meals: ['lunch'],
    profile: YUNNAN_PROFILE,
    phase: { kind: 'fitness', subgoal: 'fat_loss' },
    catalog: CATALOG,
    seed: 11,
  };
  const plan = planWeek({ ...baseOptions, locked: { '2026-11-11:lunch': 'dish-e', '2026-11-13': 'dish-h' } });
  const byDate = new Map(plan.days.map((day) => [day.date, day]));
  assert.equal(byDate.get('2026-11-11').meals[0].dishId, 'dish-e', '「日期:餐次」锁应生效');
  assert.equal(byDate.get('2026-11-13').meals[0].dishId, 'dish-h', '日期级锁应作用于当日第一餐');
  const dishIds = plan.days.flatMap((day) => day.meals.map((item) => item.dishId));
  assert.equal(new Set(dishIds).size, dishIds.length, '锁定后仍应 7 天不重复');
  // 不存在的锁定菜应被忽略且不崩溃
  const ignored = planWeek({ ...baseOptions, locked: { '2026-11-11': 'not-exist-dish' } });
  assert.equal(ignored.days.length, 7);
});

test('planWeek：近 7 天历史中的菜不会出现在窗口内的前几天', () => {
  const plan = planWeek({
    startDate: '2026-11-09',
    days: 7,
    meals: ['lunch'],
    profile: YUNNAN_PROFILE,
    phase: { kind: 'fitness' },
    catalog: CATALOG,
    seed: 3,
    history: [{ dishId: 'dish-a', date: '2026-11-08', meal: 'lunch' }],
  });
  // 2026-11-09 ~ 2026-11-14 与 11-08 相差 1-6 天，应排除 dish-a
  for (const day of plan.days.slice(0, 6)) {
    assert.notEqual(day.meals[0].dishId, 'dish-a', `${day.date} 不应重复近 7 天吃过的菜`);
  }
});

test('planWeek：遵守阶段硬约束与自由餐额度', () => {
  // 6 道阶段拟合达标 + 2 道放纵菜；7 个槽位必然要用到 1 道放纵菜（自由餐额度 1）
  const mixedCatalog = [
    ...Array.from({ length: 6 }, (_, index) => makeDish(`strict-${index + 1}`, { cuisine: index % 2 === 0 ? '川菜' : '粤菜' })),
    makeDish('free-1', {
      phases: { fitness: 1, healthy: 1, relax: 5, indulgence: 5 },
      tags: ['油炸', 'meat', 'rice'],
      nutrition: { kcal: 900, protein: 10, fat: 45, carbs: 80, veg: 0 },
    }),
    makeDish('free-2', {
      phases: { fitness: 1, healthy: 1, relax: 5, indulgence: 5 },
      tags: ['油炸', 'meat', 'rice'],
      nutrition: { kcal: 950, protein: 8, fat: 50, carbs: 85, veg: 0 },
    }),
  ];
  const plan = planWeek({
    startDate: '2026-11-09',
    days: 7,
    meals: ['lunch'],
    profile: YUNNAN_PROFILE,
    phase: { kind: 'fitness', subgoal: 'fat_loss' },
    catalog: mixedCatalog,
    seed: 7,
  });
  const fits = plan.days.flatMap((day) => day.meals.map((item) => dishPhaseFit(item.dish, 'fitness')));
  assert.equal(fits.length, 7);
  assert.equal(fits.filter((fit) => fit < 2).length, 1, '7 个槽位只允许 1 顿自由餐');
  assert.ok(plan.summary.freeMeals <= 1, `自由餐次数不应超过额度，实际 ${plan.summary.freeMeals}`);
});

/* ========================== summarizeMeals ========================== */

test('summarizeMeals：streak / repeatRate / 均营养 / adherence / 自由餐 / 菜系画像', () => {
  const today = shanghaiTodayKey();
  const meals = [
    { date: shiftKey(today, -2), meal: 'lunch', dishId: 'dish-d', kcal: 560, proteinG: 45, rating: 1 },
    { date: shiftKey(today, -2), meal: 'dinner', dishId: 'dish-c', kcal: 420, proteinG: 18 },
    { date: shiftKey(today, -1), meal: 'lunch', dishId: 'dish-b', kcal: 640, proteinG: 32 },
    { date: shiftKey(today, -1), meal: 'dinner', dishId: 'dish-a', kcal: 750, proteinG: 38 },
    { date: today, meal: 'lunch', dishId: 'dish-f', kcal: 900, proteinG: 40 },
    { date: today, meal: 'dinner', dishId: 'dish-e', kcal: 700, proteinG: 30 },
    // 同一 (date, meal) 的后写记录覆盖前一条（并标记为自由餐）
    { date: today, meal: 'dinner', dishId: 'dish-h', kcal: 600, proteinG: 35, free: true },
  ];
  const stats = summarizeMeals({
    meals,
    phase: { kind: 'fitness', subgoal: 'fat_loss', start: shiftKey(today, -2) },
    profile: YUNNAN_PROFILE,
    today,
    catalog: CATALOG,
  });
  assert.equal(stats.streak, 3, '今天起往前连续 3 天有记录');
  assert.equal(stats.loggedDays, 3);
  assert.equal(stats.totalMeals, 6, '同餐次记录应被覆盖');
  assert.equal(stats.repeatRate, 0, '6 个槽位使用 6 道不同菜，重复率 0');
  assert.equal(stats.avgKcal, 645);
  assert.equal(stats.avgProtein, 35);
  assert.equal(stats.adherence, 1, '窗口 3 天 × 午餐晚餐 = 6 条记录，全部记录 → 依从度 1');
  assert.equal(stats.freeMealsUsed, 1, '标记 free 的记录计入自由餐');
  assert.deepEqual(stats.window, { from: shiftKey(today, -2), to: today });
  assert.ok(Array.isArray(stats.topCuisines) && stats.topCuisines.length > 0);
  const cuisineNames = stats.topCuisines.map((item) => item.cuisine);
  assert.ok(cuisineNames.includes('北方') && cuisineNames.includes('川菜'), `topCuisines 应含已映射菜系：${cuisineNames.join(',')}`);
  assert.ok(!cuisineNames.includes('日韩'), 'dish-e 已被 dish-h 覆盖，不应出现日韩');

  // 今天没记录时，streak 从昨天往前算
  const noToday = summarizeMeals({ meals: meals.slice(0, 4), phase: { kind: 'fitness', start: shiftKey(today, -2) }, today, catalog: CATALOG });
  assert.equal(noToday.streak, 2);
  assert.equal(noToday.loggedDays, 2);
  assert.equal(noToday.adherence, 0.667, '4 条主餐记录 / 6 条应记录');
});

test('summarizeMeals：空记录返回安全默认值', () => {
  const today = shanghaiTodayKey();
  const stats = summarizeMeals({ meals: [], phase: { kind: 'healthy', start: today }, today });
  assert.equal(stats.streak, 0);
  assert.equal(stats.loggedDays, 0);
  assert.equal(stats.repeatRate, 0);
  assert.equal(stats.avgKcal, null);
  assert.equal(stats.avgProtein, null);
  assert.equal(stats.adherence, 0);
  assert.deepEqual(stats.topCuisines, []);
  assert.equal(stats.freeMealsUsed, 0);
  assert.equal(stats.totalMeals, 0);
});

/* ============================ shopping ============================ */

/** 采买测试用菜谱（覆盖 g/kg 混合、计数单位、多份数）。 */
const RECIPES = [
  {
    id: 'r-a',
    dishId: 'dish-a',
    name: '测试菜 A',
    servings: 1,
    ingredients: [
      { name: '鸡胸肉', amount: 150, unit: 'g', group: '肉蛋' },
      { name: '青柠', amount: 2, unit: '个', group: '水果' },
      { name: '小米辣', amount: 3, unit: '根', group: '蔬菜' },
      { name: '盐', amount: 2, unit: 'g', group: '调料' },
    ],
  },
  {
    id: 'r-b',
    dishId: 'dish-b',
    name: '测试菜 B',
    servings: 1,
    ingredients: [
      { name: '鸡胸肉', amount: 0.2, unit: 'kg', group: '肉蛋' },
      { name: '青柠', amount: 1, unit: '个', group: '水果' },
      { name: '香菜', amount: 1, unit: '把', group: '蔬菜' },
      { name: '盐', amount: 1, unit: 'g', group: '调料' },
    ],
  },
  {
    id: 'r-c',
    dishId: 'dish-c',
    name: '测试菜 C',
    servings: 2,
    ingredients: [{ name: '青菜', amount: 300, unit: 'g', group: '蔬菜' }],
  },
];

/** 采买测试用计划（4 天，最后一天缺菜谱）。 */
const PLAN = {
  start: '2026-11-09',
  days: [
    { date: '2026-11-09', meals: [{ meal: 'lunch', dish: { id: 'dish-a', recipeId: 'r-a', price: 28 } }] },
    { date: '2026-11-10', meals: [{ meal: 'lunch', dish: { id: 'dish-b', recipeId: 'r-b', price: 32 } }] },
    {
      date: '2026-11-11',
      meals: [
        { meal: 'lunch', dish: { id: 'dish-c', recipeId: 'r-c', price: 22 } },
        { meal: 'dinner', dish: { id: 'dish-missing', price: 26 } },
      ],
    },
    { date: '2026-11-12', meals: [{ meal: 'lunch', dish: { id: 'dish-a', recipeId: 'r-a', price: 28 } }] },
  ],
};

/**
 * 在采买结果里查某食材条目。
 *
 * @param {object} list buildShoppingList 结果
 * @param {string} name 食材名
 * @returns {Array<{name: string, amount: number, unit: string}>} 条目
 */
function findItems(list, name) {
  return list.groups.flatMap((group) => group.items).filter((item) => item.name === name);
}

test('shopping：聚合同名同单位食材、g/kg 换算、计数单位保留、按 group 排序', () => {
  const list = buildShoppingList({ plan: PLAN, recipes: RECIPES, days: 3, servings: 1 });
  assert.deepEqual(list.window, { from: '2026-11-09', to: '2026-11-11' }, 'days=3 应取前 3 天');
  assert.deepEqual(list.groups.map((group) => group.group), ['蔬菜', '肉蛋', '调料', '水果'], '分区按既定顺序排序');
  assert.deepEqual(list.missingRecipes, ['dish-missing']);

  const chicken = findItems(list, '鸡胸肉');
  assert.equal(chicken.length, 1, 'g 与 kg 应换算合并为一条');
  assert.deepEqual(chicken[0], { name: '鸡胸肉', amount: 350, unit: 'g' });

  const lime = findItems(list, '青柠');
  assert.deepEqual(lime[0], { name: '青柠', amount: 3, unit: '个' }, '同名同计数单位求和并保留单位');
  const salt = findItems(list, '盐');
  assert.deepEqual(salt[0], { name: '盐', amount: 3, unit: 'g' }, '单一单位保留原单位');
  const chili = findItems(list, '小米辣');
  assert.deepEqual(chili[0], { name: '小米辣', amount: 3, unit: '根' });
  const cilantro = findItems(list, '香菜');
  assert.deepEqual(cilantro[0], { name: '香菜', amount: 1, unit: '把' });
  const greens = findItems(list, '青菜');
  assert.deepEqual(greens[0], { name: '青菜', amount: 150, unit: 'g' }, 'recipe.servings=2 按份数折算');

  assert.equal(list.estimatedCost, 28 + 32 + 22 + 26, '花费为窗口内菜品价格之和');

  // state.plan.picks 只有 dishId 时，可传 catalog 补价格 / 菜谱定位
  const picksOnly = buildShoppingList({
    plan: { start: '2026-11-09', picks: [{ date: '2026-11-09', meal: 'lunch', dishId: 'dish-a', mode: 'home' }] },
    recipes: RECIPES,
    catalog: CATALOG,
    days: 1,
  });
  assert.equal(picksOnly.estimatedCost, 28, '传入 catalog 时应能按 dishId 取价格');
  assert.deepEqual(findItems(picksOnly, '鸡胸肉')[0], { name: '鸡胸肉', amount: 150, unit: 'g' });
});

test('shopping：servings 按倍数放大、days 窗口过滤、不同单位分别列、recipeForDish 兼容多种容器', () => {
  const list = buildShoppingList({ plan: PLAN, recipes: RECIPES, days: 2, servings: 2 });
  assert.deepEqual(list.window, { from: '2026-11-09', to: '2026-11-10' });
  assert.deepEqual(list.missingRecipes, [], '窗口外缺菜谱不计入');
  const chicken = findItems(list, '鸡胸肉');
  assert.deepEqual(chicken[0], { name: '鸡胸肉', amount: 700, unit: 'g' }, '150g×2 + 0.2kg×2 = 700g');
  const lime = findItems(list, '青柠');
  assert.deepEqual(lime[0], { name: '青柠', amount: 6, unit: '个' });

  // 同名但单位不可换算：分别列出
  const mixed = buildShoppingList({
    plan: { start: '2026-11-09', days: [{ date: '2026-11-09', meals: [{ meal: 'lunch', dish: { id: 'x', recipeId: 'r-x', price: 10 } }] }] },
    recipes: [{ id: 'r-x', dishId: 'x', servings: 1, ingredients: [
      { name: '小葱', amount: 2, unit: '根', group: '蔬菜' },
      { name: '小葱', amount: 1, unit: '把', group: '蔬菜' },
    ] }],
    days: 1,
  });
  const scallions = findItems(mixed, '小葱');
  assert.equal(scallions.length, 2, '根与把不可换算，应分别列出');
  assert.deepEqual(scallions.map((item) => item.unit).sort(), ['把', '根'].sort());

  // recipeForDish：数组 / Map / 普通对象
  assert.equal(recipeForDish(RECIPES, 'dish-a').id, 'r-a');
  assert.equal(recipeForDish(RECIPES, 'r-b').id, 'r-b');
  assert.equal(recipeForDish(new Map([['r-a', RECIPES[0]]]), 'r-a').id, 'r-a');
  assert.equal(recipeForDish({ 'r-a': RECIPES[0] }, 'r-a').id, 'r-a');
  assert.equal(recipeForDish(RECIPES, 'nope'), null);
  assert.equal(recipeForDish(null, 'r-a'), null);
});

/* ============================ mealTime ============================ */

test('mealTime：窗口内 / 边界 / before / after / closed', () => {
  const settings = { mealTimes: DEFAULT_MEAL_TIMES, plannedMeals: ['breakfast', 'lunch', 'dinner'], notify: { inApp: true } };

  const lunch = mealTimeState(shanghaiClock(12, 0), settings, []);
  assert.equal(lunch.phase, 'in');
  assert.equal(lunch.meal, 'lunch');
  assert.equal(lunch.shouldNotify, true);
  assert.equal(lunch.nextMeal, 'dinner');
  assert.equal(lunch.nextAt, '2026-11-09T17:30:00+08:00');
  assert.equal(lunch.logged, false);

  // 已记录该餐 -> 不再提醒
  const logged = mealTimeState(shanghaiClock(12, 0), settings, [{ date: '2026-11-09', meal: 'lunch' }]);
  assert.equal(logged.shouldNotify, false);
  assert.equal(logged.logged, true);

  // 窗口边界：11:30 在窗口内，13:00 已结束
  assert.equal(mealTimeState(shanghaiClock(11, 30), settings, []).phase, 'in');
  const afterLunch = mealTimeState(shanghaiClock(13, 0), settings, []);
  assert.equal(afterLunch.phase, 'after');
  assert.equal(afterLunch.meal, 'dinner');
  assert.equal(afterLunch.nextAt, '2026-11-09T17:30:00+08:00');

  // 早餐前
  const beforeBreakfast = mealTimeState(shanghaiClock(6, 0), settings, []);
  assert.equal(beforeBreakfast.phase, 'before');
  assert.equal(beforeBreakfast.meal, 'breakfast');
  assert.equal(beforeBreakfast.nextAt, '2026-11-09T07:00:00+08:00');

  // 当天餐次结束 -> closed，下一餐是明天早餐
  const closed = mealTimeState(shanghaiClock(23, 30), settings, []);
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.nextMeal, 'breakfast');
  assert.equal(closed.nextAt, '2026-11-10T07:00:00+08:00');
  assert.equal(closed.shouldNotify, false);

  // plannedMeals 只决定「计划哪些餐」，不影响饭点提醒（提醒由 mealTimes 窗口决定）
  const planned = { ...settings, plannedMeals: ['lunch', 'dinner'] };
  const morning = mealTimeState(shanghaiClock(8, 0), planned, []);
  assert.equal(morning.phase, 'in');
  assert.equal(morning.meal, 'breakfast');
  const breakfastIn = mealTimeState(shanghaiClock(7, 30), planned, []);
  assert.equal(breakfastIn.phase, 'in', '计划餐次不含早餐时，早餐窗口仍应提醒');
  assert.equal(breakfastIn.meal, 'breakfast');
  // remindMeals 可显式限制提醒哪些餐
  const mutedMeals = mealTimeState(shanghaiClock(7, 30), { ...settings, remindMeals: ['lunch', 'dinner'] }, []);
  assert.equal(mutedMeals.meal, 'lunch');
  assert.equal(mutedMeals.phase, 'before');
  // 关闭 inApp 通知
  const muted = mealTimeState(shanghaiClock(12, 0), { ...settings, notify: { inApp: false } }, []);
  assert.equal(muted.phase, 'in');
  assert.equal(muted.shouldNotify, false);
  // 无窗口配置
  assert.equal(mealTimeState(shanghaiClock(12, 0), { mealTimes: {} }, []).phase, 'closed');
});

test('mealTime：夜宵窗口跨零点（22:00-01:00）', () => {
  const settings = {
    mealTimes: { ...DEFAULT_MEAL_TIMES, night: ['22:00', '01:00'] },
    plannedMeals: ['breakfast', 'lunch', 'dinner', 'night'],
    notify: { inApp: true },
  };
  const lateNight = mealTimeState(shanghaiClock(23, 30), settings, []);
  assert.equal(lateNight.phase, 'in');
  assert.equal(lateNight.meal, 'night');
  assert.equal(lateNight.shouldNotify, true);
  assert.equal(lateNight.nextMeal, 'breakfast', '23:30 之后下一餐是明天早餐');
  assert.equal(lateNight.nextAt, '2026-11-10T07:00:00+08:00');

  const afterMidnight = mealTimeState(shanghaiClock(0, 30), settings, []);
  assert.equal(afterMidnight.phase, 'in', '00:30 仍应落在跨零点的夜宵窗口');
  assert.equal(afterMidnight.meal, 'night');
  assert.equal(afterMidnight.nextMeal, 'breakfast', '00:30 的下一餐是当天早餐');
  assert.equal(afterMidnight.nextAt, '2026-11-09T07:00:00+08:00');

  // 01:00 恰好是窗口右端点（开区间）：已结束
  const boundary = mealTimeState(shanghaiClock(1, 0), settings, []);
  assert.notEqual(boundary.phase, 'in');
  assert.equal(boundary.meal, 'breakfast', '01:00 已过夜宵，下一餐是早餐');
});
