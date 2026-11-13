/**
 * 「今天吃什么」六维味道内核单元测试（契约：docs/taste-v1.md）。
 *
 * 覆盖：六维枚举、旧字段迁移 / clamp、dishTasteOf 派生规则、tasteMatch 方向、
 * summarizeTaste 权重与无记录回退、learnFromMeal 六维 EWMA、旧导出兼容、
 * 以及用真实 data/dishes.js 做范围 / 规则抽查（不依赖具体菜名）。
 *
 * 运行：& $node --test "tests/core/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DISHES } from '../../data/dishes.js';
import {
  TASTE_DEFAULTS,
  TASTE_DIMENSIONS,
  TASTE_LABELS,
  dishOilinessOf,
  dishSourOf,
  dishSpicyRank,
  dishTasteOf,
  learnFromMeal,
  normalizeTaste,
  summarizeTaste,
  tasteMatch,
  tastePreferenceOf,
  tasteProfileOf,
} from '../../src/core/taste.js';
import { dishScore } from '../../src/core/scoring.js';

/**
 * 构造一道字段完整的 fixture 菜（六维派生只看 name/description/ingredients/tags/cuisine/category/sour）。
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
    description: '内联 fixture 测试菜品',
    phases: { fitness: 3, healthy: 3, relax: 3, indulgence: 3 },
    nutrition: { kcal: 600, protein: 30, fat: 15, carbs: 60, veg: 1 },
    sour: { fruit: 0, fermented: 0, vinegar: 0 },
    origins: ['云南'],
    ingredients: ['鸡胸肉'],
    cookable: true,
    recipeId: id,
    regions: [],
    ...overrides,
  };
}

/** 酸辣鸡胸：酸 5 / 辣 5 / 鲜 3，用于 tasteMatch 与统计测试。 */
const SOUR_SPICY_DISH = makeDish('sour-spicy', {
  name: '酸辣鸡胸',
  tags: ['hot', 'meat', 'light'],
  ingredients: ['鸡胸肉'],
  sour: { fruit: 5, fermented: 2, vinegar: 1 },
});

/** 糖醋排骨：甜 5 / 酸 3 / 辣 2 / 鲜 3。 */
const SWEET_DISH = makeDish('sweet-dish', {
  name: '糖醋排骨',
  cuisine: '江浙',
  tags: ['mild', 'meat'],
  ingredients: ['猪排骨'],
});

/** 清淡时蔬：六维都很低。 */
const PLAIN_DISH = makeDish('plain-dish', {
  name: '清炒时蔬',
  tags: ['mild', 'veg'],
  ingredients: ['青菜', '胡萝卜'],
});

/* ========================= 枚举与 normalizeTaste ========================= */

test('taste-six：TASTE_DIMENSIONS / TASTE_LABELS 六维枚举', () => {
  assert.deepEqual([...TASTE_DIMENSIONS], ['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami']);
  assert.deepEqual({ ...TASTE_LABELS }, { sour: '酸', sweet: '甜', bitter: '苦', spicy: '辣', salty: '咸', umami: '鲜' });
  assert.deepEqual({ ...TASTE_DEFAULTS }, { sour: 3, sweet: 2, bitter: 1, spicy: 3, salty: 2, umami: 3 });
});

test('taste-six：normalizeTaste 默认值 / 旧字段迁移 / clamp / 保留 1 位小数', () => {
  const defaults = { sour: 3, sweet: 2, bitter: 1, spicy: 3, salty: 2, umami: 3 };
  assert.deepEqual(normalizeTaste(), defaults);
  assert.deepEqual(normalizeTaste(null), defaults);
  assert.deepEqual(normalizeTaste({}), defaults);

  // 旧字段迁移：sour 取 sourFruit / sourFermented / sourVinegar 最大值
  assert.deepEqual(
    normalizeTaste({ sourFruit: 5, sourFermented: 2, sourVinegar: 1, spicy: 4, sweet: 1 }),
    { sour: 5, sweet: 1, bitter: 1, spicy: 4, salty: 2, umami: 3 },
  );
  assert.equal(normalizeTaste({ sourFermented: 4 }).sour, 4);
  // 新字段为准：显式 sour=0 表示「不要酸」，不被旧字段覆盖
  assert.equal(normalizeTaste({ sour: 0, sourFruit: 5 }).sour, 0);
  assert.equal(normalizeTaste({ sour: 2, sourFruit: 5 }).sour, 2);

  // clamp 到 0–5，保留 1 位小数
  const clamped = normalizeTaste({ spicy: 9, sweet: -2, bitter: 3.26, salty: 4.44, umami: 100 });
  assert.deepEqual(clamped, { sour: 3, sweet: 0, bitter: 3.3, spicy: 5, salty: 4.4, umami: 5 });
  assert.equal(normalizeTaste({ sour: 3.14 }).sour, 3.1);
  // 非法字符回退默认值
  assert.equal(normalizeTaste({ spicy: '辣' }).spicy, 3);

  // 完整 profile 传入时取 profile.taste
  assert.deepEqual(normalizeTaste({ taste: { spicy: 5, sour: 4 } }), { sour: 4, sweet: 2, bitter: 1, spicy: 5, salty: 2, umami: 3 });
});

test('taste-six：tastePreferenceOf 兼容旧档案字段', () => {
  const profile = {
    taste: { spicy: 5, sourFruit: 5, sourFermented: 2, sourVinegar: 1, sweet: 2 },
  };
  assert.deepEqual(tastePreferenceOf(profile), { sour: 5, sweet: 2, bitter: 1, spicy: 5, salty: 2, umami: 3 });
  assert.deepEqual(tastePreferenceOf(null), { sour: 3, sweet: 2, bitter: 1, spicy: 3, salty: 2, umami: 3 });
});

/* ============================ dishTasteOf ============================ */

test('taste-six：dishTasteOf 典型菜派生（重辣 / 微辣 / 糖醋 / 苦瓜 / 咸腌 / 海鲜汤 / 清淡）', () => {
  // 重辣：hot -> 5，「爆辣」+1 仍封顶 5
  const heavySpicy = makeDish('heavy-spicy', { name: '爆辣辣子鸡', tags: ['hot', 'meat'], ingredients: ['鸡腿肉', '干辣椒'] });
  assert.equal(dishTasteOf(heavySpicy).spicy, 5);
  // 微辣 -> 2
  const mildSpicy = makeDish('mild-spicy', { name: '微辣豆腐', tags: ['mild', 'veg'], ingredients: ['豆腐'] });
  assert.equal(dishTasteOf(mildSpicy).spicy, 2);

  // 糖醋：强甜 4 + 江浙菜系 1 = 5；「醋」让酸至少 3
  const sweetSour = makeDish('sweet-sour', { name: '糖醋里脊', cuisine: '江浙', tags: ['mild', 'meat'], ingredients: ['猪里脊'] });
  const sweetSourTaste = dishTasteOf(sweetSour);
  assert.equal(sweetSourTaste.sweet, 5);
  assert.ok(sweetSourTaste.sour >= 3, `糖醋菜酸味应 >=3，实际 ${sweetSourTaste.sour}`);

  // 苦瓜 -> 5；含鸡蛋/鸡胸 -> 鲜 >=3
  const bitterDish = makeDish('bitter-dish', { name: '苦瓜炒蛋', tags: ['mild', 'veg'], ingredients: ['苦瓜', '鸡蛋'] });
  const bitterTaste = dishTasteOf(bitterDish);
  assert.equal(bitterTaste.bitter, 5);
  assert.ok(bitterTaste.umami >= 3, `苦瓜炒蛋鲜味应 >=3，实际 ${bitterTaste.umami}`);

  // 咸菜 / 腊肉 -> 咸 >=4
  const saltyDish = makeDish('salty-dish', { name: '咸菜炒腊肉', tags: ['medium', 'meat'], ingredients: ['咸菜', '腊肉', '辣椒'] });
  assert.ok(dishTasteOf(saltyDish).salty >= 4, `咸腌菜咸味应 >=4，实际 ${dishTasteOf(saltyDish).salty}`);

  // 海鲜汤：鲜味 >=4（海鲜/汤 tag + 多海鲜食材），汤羹咸味 +1
  const seafoodSoup = makeDish('seafood-soup', {
    name: '海鲜豆腐汤',
    category: '汤羹',
    cuisine: '粤菜',
    tags: ['mild', 'seafood', 'soup'],
    ingredients: ['虾', '鱼', '豆腐'],
  });
  const seafoodTaste = dishTasteOf(seafoodSoup);
  assert.ok(seafoodTaste.umami >= 4, `海鲜汤鲜味应 >=4，实际 ${seafoodTaste.umami}`);
  assert.ok(seafoodTaste.salty >= 3, `汤羹咸味应 >=3，实际 ${seafoodTaste.salty}`);

  // 清淡时蔬：全部低
  const plainTaste = dishTasteOf(PLAIN_DISH);
  assert.deepEqual(plainTaste, { sour: 1, sweet: 2, bitter: 1, spicy: 2, salty: 2, umami: 2 });

  // 所有取值均为 1-5 整数；同一输入确定性
  for (const dish of [heavySpicy, mildSpicy, sweetSour, bitterDish, saltyDish, seafoodSoup, PLAIN_DISH]) {
    const taste = dishTasteOf(dish);
    for (const dimension of TASTE_DIMENSIONS) {
      assert.ok(Number.isInteger(taste[dimension]), `${dish.id}.${dimension} 应为整数`);
      assert.ok(taste[dimension] >= 1 && taste[dimension] <= 5, `${dish.id}.${dimension} 应在 1-5`);
    }
    assert.deepEqual(dishTasteOf(dish), taste, '同一输入结果确定');
  }
  assert.deepEqual(dishTasteOf(null), { sour: 1, sweet: 2, bitter: 1, spicy: 1, salty: 2, umami: 2 });
});

test('taste-six：真实 data/dishes.js 抽查 20+ 道菜（范围与规则，不依赖菜名）', () => {
  assert.ok(DISHES.length >= 20, `真实菜品库过小：${DISHES.length}`);
  const sample = DISHES.slice(0, 20);
  for (const dish of sample) {
    const taste = dishTasteOf(dish);
    for (const dimension of TASTE_DIMENSIONS) {
      assert.ok(Number.isInteger(taste[dimension]), `${dish.id}.${dimension} 应为整数`);
      assert.ok(taste[dimension] >= 1 && taste[dimension] <= 5, `${dish.id}.${dimension} 应在 1-5`);
    }
    // 辣度规则：hot 菜辣度 >=4，mild 菜辣度 <=3（「爆辣」文案 +1 不越界）
    if (Array.isArray(dish.tags) && dish.tags.includes('hot')) assert.ok(taste.spicy >= 4, `${dish.id} hot 菜辣度应 >=4`);
    if (Array.isArray(dish.tags) && dish.tags.includes('mild')) assert.ok(taste.spicy <= 3, `${dish.id} mild 菜辣度应 <=3`);
    // 海鲜 / 汤类鲜味不应低
    if (Array.isArray(dish.tags) && dish.tags.includes('seafood')) assert.ok(taste.umami >= 3, `${dish.id} 海鲜菜鲜味应 >=3`);
  }
  // 全库范围检查
  for (const dish of DISHES) {
    const taste = dishTasteOf(dish);
    for (const dimension of TASTE_DIMENSIONS) {
      assert.ok(taste[dimension] >= 1 && taste[dimension] <= 5, `${dish.id}.${dimension} 越界`);
    }
  }
});

/* ============================= tasteMatch ============================= */

test('taste-six：tasteMatch 方向（酸辣偏好对酸辣菜 > 清淡菜）与取值范围', () => {
  const sourSpicyProfile = { taste: { sour: 5, sweet: 1, bitter: 1, spicy: 5, salty: 2, umami: 3 } };
  const plainProfile = { taste: { sour: 1, sweet: 2, bitter: 1, spicy: 1, salty: 2, umami: 2 } };

  const sourSpicyScore = tasteMatch(SOUR_SPICY_DISH, sourSpicyProfile);
  const plainScore = tasteMatch(SOUR_SPICY_DISH, plainProfile);
  assert.ok(sourSpicyScore > plainScore, `酸辣偏好应更喜欢酸辣菜：${sourSpicyScore} vs ${plainScore}`);
  assert.ok(sourSpicyScore > 0, '口味契合时 tasteMatch 应为正');
  assert.ok(plainScore < 0, '口味不合时应为负');

  // 反向：清淡偏好更喜欢清淡菜
  assert.ok(tasteMatch(PLAIN_DISH, plainProfile) > tasteMatch(PLAIN_DISH, sourSpicyProfile));

  for (const dish of [SOUR_SPICY_DISH, SWEET_DISH, PLAIN_DISH]) {
    for (const profile of [sourSpicyProfile, plainProfile, null]) {
      const score = tasteMatch(dish, profile);
      assert.ok(score >= -2 && score <= 2, `tasteMatch 应在 -2..+2，实际 ${score}`);
      assert.equal(tasteMatch(dish, profile), score, '同一输入结果确定');
    }
  }
  assert.equal(tasteMatch(null, sourSpicyProfile), 0);
});

/* ============================ summarizeTaste ============================ */

test('taste-six：summarizeTaste rating 权重、liked/disliked、summary 与 topTastes', () => {
  const catalog = [SOUR_SPICY_DISH, SWEET_DISH, PLAIN_DISH];
  // 权重：rating=1 -> 1.5，rating=0 -> 1，rating=-1 -> 0.5；未知 dishId 跳过
  const meals = [
    { dishId: 'sour-spicy', rating: 1 },
    { dishId: 'sour-spicy', rating: 0 },
    { dishId: 'sweet-dish', rating: -1 },
    { dishId: 'not-in-catalog', rating: 1 },
  ];
  const result = summarizeTaste(meals, catalog, { taste: { spicy: 3, sour: 3 } });
  assert.equal(result.samples, 3, '未找到的菜应跳过');
  assert.equal(result.dimensions.length, 6);

  const byId = Object.fromEntries(result.dimensions.map((item) => [item.id, item]));
  assert.equal(byId.sour.id, 'sour');
  assert.equal(byId.sour.label, '酸');
  // sour = (5×1.5 + 5×1 + 3×0.5) / 3 = 4.7
  assert.equal(byId.sour.value, 4.7);
  // sweet = (2×1.5 + 2×1 + 5×0.5) / 3 = 2.5
  assert.equal(byId.sweet.value, 2.5);
  // spicy = (5×1.5 + 5×1 + 2×0.5) / 3 = 4.5
  assert.equal(byId.spicy.value, 4.5);
  assert.equal(byId.bitter.value, 1);

  // liked/disliked 只统计该维度「明显」（>=4）的评分
  assert.equal(byId.sour.liked, 1, '喜欢酸辣菜时酸维度计 1 次喜欢');
  assert.equal(byId.spicy.liked, 1, '喜欢酸辣菜时辣维度计 1 次喜欢');
  assert.equal(byId.sweet.disliked, 1, '不喜欢糖醋菜时甜维度计 1 次不喜欢');
  assert.equal(byId.sour.disliked, 0);

  // 高值维度不足 3 个：取 value 最高的 2 个
  assert.deepEqual(result.topTastes, ['sour', 'spicy']);
  assert.match(result.summary, /^偏爱：酸、辣$/);

  // 对象形式调用与位置参数等价
  const objectForm = summarizeTaste({ meals, catalog, profile: { taste: { spicy: 3, sour: 3 } } });
  assert.deepEqual(objectForm, result);
});

test('taste-six：summarizeTaste 无记录回退偏好设置，全低时口味均衡', () => {
  const fallback = summarizeTaste([], [SOUR_SPICY_DISH], { taste: { spicy: 5, sour: 4 } });
  assert.equal(fallback.samples, 0);
  const expected = normalizeTaste({ spicy: 5, sour: 4 });
  for (const item of fallback.dimensions) assert.equal(item.value, expected[item.id], `${item.id} 应回退偏好`);
  assert.deepEqual(fallback.topTastes, ['spicy', 'sour']);
  assert.match(fallback.summary, /^偏好设置：偏爱：辣、酸$/);

  const balanced = summarizeTaste([], [], { taste: { sour: 2, sweet: 2, bitter: 2, spicy: 2, salty: 2, umami: 2 } });
  assert.equal(balanced.samples, 0);
  assert.deepEqual(balanced.topTastes, []);
  assert.equal(balanced.summary, '偏好设置：口味均衡');
  // 无 profile 时回退默认六维
  const noProfile = summarizeTaste([], []);
  assert.equal(noProfile.samples, 0);
  for (const item of noProfile.dimensions) assert.equal(item.value, TASTE_DEFAULTS[item.id]);
});

/* =========================== learnFromMeal =========================== */

test('taste-six：learnFromMeal 六维 EWMA（喜欢靠近 / 不喜欢反向 / 中性不变），不修改入参', () => {
  const profile = { taste: { sour: 1, sweet: 1, bitter: 1, spicy: 1, salty: 1, umami: 1 } };
  const before = JSON.parse(JSON.stringify(profile));

  const liked = learnFromMeal(profile, SOUR_SPICY_DISH, 1);
  assert.deepEqual(profile, before, '不应修改入参 profile');
  assert.notEqual(liked, profile);
  // sour / spicy 朝菜品（5）靠拢：1 + 0.3×(5-1) = 2.2
  assert.equal(liked.taste.sour, 2.2);
  assert.equal(liked.taste.spicy, 2.2);
  assert.equal(liked.taste.sweet, 1.3, '甜朝菜品值 2 靠拢');
  assert.equal(liked.taste.umami, 1.6, '鲜朝菜品值 3 靠拢');
  assert.ok(liked.taste.bitter >= 0 && liked.taste.bitter <= 5);
  assert.ok(tasteMatch(SOUR_SPICY_DISH, liked) > tasteMatch(SOUR_SPICY_DISH, profile), '喜欢后契合度应提升');

  const disliked = learnFromMeal(liked, SOUR_SPICY_DISH, -1);
  assert.ok(disliked.taste.spicy < liked.taste.spicy, '不喜欢应让辣度偏好下降');
  assert.ok(disliked.taste.spicy >= 0 && disliked.taste.spicy <= 5);
  assert.ok(tasteMatch(SOUR_SPICY_DISH, disliked) < tasteMatch(SOUR_SPICY_DISH, liked));

  const neutral = learnFromMeal(liked, SOUR_SPICY_DISH, 0);
  assert.deepEqual(neutral.taste, liked.taste, '中性评分六维不变');
  // 旧 learned 亲和度缓存保留（兼容旧数据）：0.3 × 0.7 = 0.21
  assert.ok(Math.abs(neutral.learned.dishes['sour-spicy'] - 0.21) < 1e-9);

  // 非法输入不崩
  assert.deepEqual(learnFromMeal(null, null, 1).learned, { dishes: {}, cuisines: {} });
  assert.deepEqual(learnFromMeal(undefined, SOUR_SPICY_DISH, 0).learned, { dishes: {}, cuisines: {} });
  const cloned = learnFromMeal(profile, { id: 'x' }, 1);
  for (const dimension of TASTE_DIMENSIONS) {
    assert.ok(cloned.taste[dimension] >= 0 && cloned.taste[dimension] <= 5);
  }
});

/* ============================ 旧导出兼容 ============================ */

test('taste-six：旧导出 dishSpicyRank / dishSourOf / dishOilinessOf / tasteProfileOf 保持可用', () => {
  // dishSpicyRank：hot=3 / medium=2 / mild=1，缺 tags 时 1-3
  assert.equal(dishSpicyRank(makeDish('r-hot', { tags: ['hot', 'meat'] })), 3);
  assert.equal(dishSpicyRank(makeDish('r-medium', { tags: ['medium', 'meat'] })), 2);
  assert.equal(dishSpicyRank(makeDish('r-mild', { tags: ['mild', 'meat'] })), 1);
  const unknownRank = dishSpicyRank(makeDish('r-unknown', { tags: [] }));
  assert.ok(unknownRank >= 1 && unknownRank <= 3);

  // dishSourOf：优先 dish.sour 三分量；缺省时用六维 sour 兜底
  assert.deepEqual(dishSourOf(makeDish('r-sour', { sour: { fruit: 4, fermented: 1, vinegar: 0 } })), { fruit: 4, fermented: 1, vinegar: 0 });
  assert.deepEqual(dishSourOf(PLAIN_DISH), { fruit: 1, fermented: 1, vinegar: 1 });
  const sourFromText = dishSourOf(makeDish('r-sour-text', { name: '酸菜鱼', ingredients: ['草鱼'] }));
  assert.equal(sourFromText.fruit, 3);
  assert.equal(sourFromText.fruit, sourFromText.fermented);

  // dishOilinessOf：脂肪克数 / light / 火锅烧烤
  assert.equal(dishOilinessOf(makeDish('r-fat', { nutrition: { kcal: 600, protein: 20, fat: 16, carbs: 60, veg: 1 } })), 2);
  assert.equal(dishOilinessOf(makeDish('r-light', { tags: ['mild', 'veg', 'light'], nutrition: undefined })), 1);
  assert.equal(dishOilinessOf(makeDish('r-hotpot', { category: '火锅烧烤', tags: ['hot', 'meat'], nutrition: undefined })), 4);

  // tasteProfileOf：六维 + oiliness / adventurous
  const profileTaste = tasteProfileOf({ taste: { sourFruit: 4, spicy: 5, oiliness: 2, adventurous: 4 } });
  assert.deepEqual(profileTaste, {
    sour: 4, sweet: 2, bitter: 1, spicy: 5, salty: 2, umami: 3, oiliness: 2, adventurous: 4,
  });
  assert.deepEqual(tasteProfileOf(null), {
    sour: 3, sweet: 2, bitter: 1, spicy: 3, salty: 2, umami: 3, oiliness: 3, adventurous: 3,
  });

  // 与新 tasteMatch 协同：scoring 仍能正常打分（0-100），且偏好影响分数
  const context = { profile: { taste: { spicy: 5, sour: 5 } }, phase: { kind: 'fitness' }, history: [], date: '2026-11-09', meal: 'lunch' };
  const score = dishScore(SOUR_SPICY_DISH, context);
  assert.ok(Number.isFinite(score) && score > 0 && score <= 100, `dishScore 应输出 0-100，实际 ${score}`);
  const otherProfile = { ...context, profile: { taste: { spicy: 1, sour: 1 } } };
  assert.ok(dishScore(SOUR_SPICY_DISH, context) > dishScore(SOUR_SPICY_DISH, otherProfile), '口味匹配应影响推荐分');
});
