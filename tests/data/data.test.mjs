/**
 * 「今天吃什么」v2 内容数据测试（node:test + assert，零第三方依赖）。
 *
 * 运行：
 *   $node --test "tests/data/*.test.mjs"
 *
 * 覆盖 docs/design-v2.md §4/§5/§6 的契约：数量、字段完整、阶段覆盖与区分度、
 * 菜谱与可自制菜的双向引用、营养误差、步骤/用量合法性、城市大区与默认城市。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DISHES } from '../../data/dishes.js';
import { RECIPES } from '../../data/recipes.js';
import { LEGACY_400_DISH_IDS } from '../../data/legacy-400-ids.js';
import { LEGACY_500_DISH_IDS } from '../../data/legacy-500-ids.js';
import { CITIES, DEFAULT_CITY, REGIONS, findCity } from '../../data/cities.js';
import {
  CATEGORIES,
  CUISINES,
  DIFFICULTIES,
  INGREDIENT_GROUPS,
  LEGACY_DISH_IDS,
  LEGACY_RECIPE_IDS,
  MEAL_TAGS,
  PHASES,
  PREVIOUS_148_DISH_IDS,
  PREVIOUS_200_DISH_IDS,
  PREVIOUS_260_DISH_IDS,
  COUNTRIES,
  FOREIGN_COUNTRIES,
  PROVINCES,
  SPICY_LEVELS,
  validateData,
} from '../../scripts/validate-data.mjs';

/** 阶段中文名，便于断言报错。 */
const PHASE_LABELS = { fitness: '健身', healthy: '健康', relax: '放松', indulgence: '放纵' };

/** 取某道菜的辣度标签。 */
function spicyOf(dish) {
  return dish.tags.find((tag) => SPICY_LEVELS.includes(tag));
}

test('校验脚本：全量数据零错误，摘要数量正确', () => {
  const result = validateData();
  assert.deepEqual(result.errors, [], `数据校验存在错误：\n${result.errors.slice(0, 20).join('\n')}`);
  assert.equal(result.ok, true);
  assert.equal(result.summary.dishes, 1000, '菜品应为 1000 道');
  assert.equal(result.summary.cookable, 1000, '可自制菜应为 1000 道（覆盖全部菜品）');
  assert.equal(result.summary.recipes, 1000, '菜谱应为 1000 道（覆盖全部菜品）');
  assert.ok(result.summary.coveredProvinces >= 30, `省级行政区覆盖应 ≥30，当前 ${result.summary.coveredProvinces}`);
  assert.ok(result.summary.cities >= 60, `城市应 ≥60，当前 ${result.summary.cities}`);
  assert.ok(result.summary.yunnanSichuanFitnessRecipes >= 30, '云南/川味健身改良菜谱应 ≥30 道');
});

test('菜品：字段完整、id 唯一且为 kebab-case', () => {
  const ids = new Set();
  for (const dish of DISHES) {
    for (const key of ['id', 'name', 'emoji', 'category', 'cuisine', 'tags', 'price', 'description', 'phases', 'nutrition', 'sour', 'origins', 'ingredients', 'cookable']) {
      assert.ok(dish[key] !== undefined, `${dish.id} 缺少字段 ${key}`);
    }
    assert.match(dish.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${dish.id} 不是 kebab-case id`);
    assert.ok(!ids.has(dish.id), `重复 id：${dish.id}`);
    ids.add(dish.id);
    assert.ok(CATEGORIES.includes(dish.category), `${dish.id} 分类非法`);
    assert.ok(CUISINES.includes(dish.cuisine), `${dish.id} 菜系非法`);
    assert.ok(dish.tags.length >= 2 && new Set(dish.tags).size === dish.tags.length, `${dish.id} tags 异常`);
  }
  assert.equal(DISHES.length, 1000, `菜品应为 1000，当前 ${DISHES.length}`);
});

test('菜品：规范化菜名无完全同名（去重后）', () => {
  const normalize = (name) => String(name).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const seen = new Map();
  const duplicates = [];
  for (const dish of DISHES) {
    const key = normalize(dish.name);
    if (seen.has(key)) duplicates.push(`${dish.name}（${seen.get(key)} / ${dish.id}）`);
    else seen.set(key, dish.id);
  }
  assert.deepEqual(duplicates, [], `存在完全同名菜品：\n${duplicates.join('\n')}`);
});

test('菜品：原有 98 道 id 全部保留，基础字段未被改写', () => {
  const byId = new Map(DISHES.map((dish) => [dish.id, dish]));
  const missing = LEGACY_DISH_IDS.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `丢失原有菜品：${missing.join(',')}`);
  const samples = [
    ['yangzhou-fried-rice', '扬州炒饭', '🍚', 22],
    ['tomato-egg', '番茄炒蛋', '🍅', 18],
    ['suancai-fish', '酸菜鱼', '🐟', 48],
    ['sichuan-hotpot', '四川麻辣火锅', '🌶️', 68],
  ];
  for (const [id, name, emoji, price] of samples) {
    assert.ok(byId.has(id), `缺少原有菜品 ${id}`);
    const dish = byId.get(id);
    assert.equal(dish.name, name, `${id} 名称被改写`);
    assert.equal(dish.emoji, emoji, `${id} emoji 被改写`);
    assert.equal(dish.price, price, `${id} 价格被改写`);
  }
});

test('菜品：上一版 148 道全部保留（扩充只做加法）', () => {
  assert.equal(PREVIOUS_148_DISH_IDS.length, 148, `148 基线应有 148 个 id，当前 ${PREVIOUS_148_DISH_IDS.length}`);
  const byId = new Map(DISHES.map((dish) => [dish.id, dish]));
  const missing = PREVIOUS_148_DISH_IDS.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `丢失上一版菜品：${missing.join(',')}`);
  // 上一版 148 道都仍可自制且有对应菜谱
  const recipeIds = new Set(RECIPES.map((recipe) => recipe.id));
  for (const id of PREVIOUS_148_DISH_IDS) {
    assert.equal(byId.get(id).cookable, true, `${id} 不再可自制`);
    assert.ok(recipeIds.has(id), `${id} 的原菜谱丢失`);
  }
  // 抽检上一版新增代表菜内容未变
  assert.equal(byId.get('lemon-chicken-breast').name, '柠檬手撕鸡胸');
  assert.equal(byId.get('sichuan-hotpot').price, 68);
  assert.equal(byId.get('cold-eat-rabbit').origins.includes('雅安'), true);
});

test('菜品：上一版 200 道全部保留（扩充只做加法）', () => {
  assert.equal(PREVIOUS_200_DISH_IDS.length, 200, `200 基线应有 200 个 id，当前 ${PREVIOUS_200_DISH_IDS.length}`);
  // 148 基线必须是 200 基线的子集（基线递进不倒退）
  const baseline200 = new Set(PREVIOUS_200_DISH_IDS);
  assert.deepEqual(PREVIOUS_148_DISH_IDS.filter((id) => !baseline200.has(id)), [], '148 基线不是 200 基线的子集');
  const byId = new Map(DISHES.map((dish) => [dish.id, dish]));
  const missing = PREVIOUS_200_DISH_IDS.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `丢失上一版菜品：${missing.join(',')}`);
  const recipeIds = new Set(RECIPES.map((recipe) => recipe.id));
  for (const id of PREVIOUS_200_DISH_IDS) {
    assert.equal(byId.get(id).cookable, true, `${id} 不再可自制`);
    assert.ok(recipeIds.has(id), `${id} 的原菜谱丢失`);
  }
  // 抽检上一版代表菜内容未变
  assert.equal(byId.get('air-fryer-salmon').category, '轻食');
  assert.equal(byId.get('sichuan-dry-pot').cuisine, '川菜');
  assert.equal(byId.get('yunnan-cold-chicken-mixian').price, 24);
});

test('菜品：上一版 260 道全部保留（扩充只做加法）', () => {
  assert.equal(PREVIOUS_260_DISH_IDS.length, 260, `260 基线应有 260 个 id，当前 ${PREVIOUS_260_DISH_IDS.length}`);
  const baseline260 = new Set(PREVIOUS_260_DISH_IDS);
  assert.deepEqual(PREVIOUS_200_DISH_IDS.filter((id) => !baseline260.has(id)), [], '200 基线不是 260 基线的子集');
  const byId = new Map(DISHES.map((dish) => [dish.id, dish]));
  const missing = PREVIOUS_260_DISH_IDS.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `丢失上一版菜品：${missing.join(',')}`);
  const recipeIds = new Set(RECIPES.map((recipe) => recipe.id));
  for (const id of PREVIOUS_260_DISH_IDS) {
    assert.equal(byId.get(id).cookable, true, `${id} 不再可自制`);
    assert.ok(recipeIds.has(id), `${id} 的原菜谱丢失`);
  }
  // 抽检上一版代表菜内容未变
  assert.equal(byId.get('maoxuewang').province, '四川');
  assert.equal(byId.get('oyakodon').country, '日本');
  assert.equal(byId.get('taiwan-beef-noodle').name, '台湾牛肉面');
});

test('菜品：上一版 400 道全部保留（扩充只做加法）', () => {
  assert.equal(LEGACY_400_DISH_IDS.length, 400, `400 基线应有 400 个 id，当前 ${LEGACY_400_DISH_IDS.length}`);
  const baseline400 = new Set(LEGACY_400_DISH_IDS);
  assert.deepEqual(PREVIOUS_260_DISH_IDS.filter((id) => !baseline400.has(id)), [], '260 基线不是 400 基线的子集');
  const byId = new Map(DISHES.map((dish) => [dish.id, dish]));
  const missing = LEGACY_400_DISH_IDS.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `丢失上一版菜品：${missing.join(',')}`);
  const recipeIds = new Set(RECIPES.map((recipe) => recipe.id));
  for (const id of LEGACY_400_DISH_IDS) {
    assert.equal(byId.get(id).cookable, true, `${id} 不再可自制`);
    assert.ok(recipeIds.has(id), `${id} 的原菜谱丢失`);
  }
  // 抽检上一版代表菜内容未变
  assert.equal(byId.get('lemon-chicken-breast').name, '柠檬手撕鸡胸');
  assert.equal(byId.get('guangxi-lemon-duck').province, '广西');
  assert.equal(byId.get('hainan-coconut-chicken').country, '中国');
});

test('菜品：上一版 500 道全部保留（扩充只做加法）', () => {
  assert.equal(LEGACY_500_DISH_IDS.length, 500, `500 基线应有 500 个 id，当前 ${LEGACY_500_DISH_IDS.length}`);
  const baseline500 = new Set(LEGACY_500_DISH_IDS);
  assert.deepEqual(LEGACY_400_DISH_IDS.filter((id) => !baseline500.has(id)), [], '400 基线不是 500 基线的子集');
  const byId = new Map(DISHES.map((dish) => [dish.id, dish]));
  const missing = LEGACY_500_DISH_IDS.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `丢失上一版菜品：${missing.join(',')}`);
  const recipeIds = new Set(RECIPES.map((recipe) => recipe.id));
  for (const id of LEGACY_500_DISH_IDS) {
    assert.equal(byId.get(id).cookable, true, `${id} 不再可自制`);
    assert.ok(recipeIds.has(id), `${id} 的原菜谱丢失`);
  }
});

test('菜品：country/province 字段完整合法，省级覆盖 ≥30', () => {
  const provinceCount = {};
  const countryCount = {};
  for (const dish of DISHES) {
    assert.ok(COUNTRIES.includes(dish.country), `${dish.id} country 非法：${dish.country}`);
    countryCount[dish.country] = (countryCount[dish.country] || 0) + 1;
    if (dish.country === '中国') {
      assert.ok(PROVINCES.includes(dish.province), `${dish.id} 中国菜 province 非法：${dish.province}`);
      provinceCount[dish.province] = (provinceCount[dish.province] || 0) + 1;
    } else {
      assert.equal(dish.province, null, `${dish.id} 国外菜 province 应为 null`);
    }
  }
  const covered = Object.values(provinceCount).filter((count) => count >= 2).length;
  assert.ok(covered >= 30, `省级行政区覆盖应 ≥30，当前 ${covered}`);
  assert.ok(Object.keys(countryCount).length >= 13, `国家数应 ≥13，当前 ${Object.keys(countryCount).length}`);
  for (const country of FOREIGN_COUNTRIES) {
    assert.ok((countryCount[country] || 0) >= 2, `${country} 菜应 ≥2 道，当前 ${countryCount[country] || 0}`);
  }
  // 数据现状：34 个省级行政区全部覆盖
  assert.equal(Object.keys(provinceCount).length, PROVINCES.length, '应覆盖全部省级行政区');
  // 抽检 taxonomy 映射
  assert.equal(DISHES.find((dish) => dish.id === 'yangzhou-fried-rice').province, '江苏');
  assert.equal(DISHES.find((dish) => dish.id === 'lamb-paomo').province, '陕西');
  assert.equal(DISHES.find((dish) => dish.id === 'pad-thai').country, '泰国');
  assert.equal(DISHES.find((dish) => dish.id === 'pad-thai').province, null);
});

test('菜品：描述 20-40 字、价格 10-80、tags 辣度与荤素标记唯一', () => {
  for (const dish of DISHES) {
    const length = [...dish.description].length;
    assert.ok(length >= 20 && length <= 40, `${dish.id} 描述长度 ${length} 不在 20-40`);
    assert.ok(Number.isFinite(dish.price) && dish.price >= 10 && dish.price <= 80, `${dish.id} 价格 ${dish.price} 越界`);
    assert.equal(dish.tags.filter((tag) => SPICY_LEVELS.includes(tag)).length, 1, `${dish.id} 辣度标签应唯一`);
    assert.equal(dish.tags.filter((tag) => MEAL_TAGS.includes(tag)).length, 1, `${dish.id} 荤素标签应唯一`);
    const need = { 面食: 'noodle', 米饭: 'rice', 汤羹: 'soup', 轻食: 'light' }[dish.category];
    if (need) assert.ok(dish.tags.includes(need), `${dish.id} 缺少结构 tag ${need}`);
  }
});

test('菜品：phases 四维均为 1-5，且每个阶段 ≥25 道达到 3 分以上', () => {
  for (const dish of DISHES) {
    for (const kind of PHASES) {
      assert.ok(Number.isInteger(dish.phases[kind]) && dish.phases[kind] >= 1 && dish.phases[kind] <= 5, `${dish.id}.phases.${kind} 越界`);
    }
  }
  for (const kind of PHASES) {
    const count = DISHES.filter((dish) => dish.phases[kind] >= 3).length;
    assert.ok(count >= 25, `${PHASE_LABELS[kind]} 阶段覆盖只有 ${count} 道，应 ≥25`);
  }
});

test('菜品：阶段区分度明显（健身 vs 放纵不两头讨好）', () => {
  const fitnessDishes = DISHES.filter((dish) => dish.phases.fitness >= 4);
  const indulgenceDishes = DISHES.filter((dish) => dish.phases.indulgence === 5);
  assert.ok(fitnessDishes.length >= 20, `fitness≥4 的菜应 ≥20，当前 ${fitnessDishes.length}`);
  assert.ok(indulgenceDishes.length >= 10, `indulgence=5 的菜应 ≥10，当前 ${indulgenceDishes.length}`);
  for (const dish of fitnessDishes) {
    assert.ok(dish.phases.indulgence <= 2, `${dish.id} 是健身菜，但 indulgence=${dish.phases.indulgence}`);
  }
  for (const dish of indulgenceDishes) {
    assert.ok(dish.phases.fitness <= 2, `${dish.id} 是放纵菜，但 fitness=${dish.phases.fitness}`);
  }
  // 烧烤/火锅/油炸类应明确偏放纵
  for (const id of ['sichuan-hotpot', 'lamb-skewers', 'fried-chicken', 'braised-pork', 'sweet-sour-ribs']) {
    const dish = DISHES.find((item) => item.id === id);
    assert.equal(dish.phases.indulgence, 5, `${id} 放纵度应为 5`);
    assert.ok(dish.phases.fitness <= 2, `${id} 健身度应 ≤2`);
  }
  // 轻食/健身餐应明确偏健身
  for (const id of ['lemon-chicken-breast', 'pan-seared-chicken', 'salmon-quinoa-bowl', 'pepper-chicken-breast']) {
    const dish = DISHES.find((item) => item.id === id);
    assert.ok(dish.phases.fitness >= 4, `${id} 健身度应 ≥4`);
    assert.ok(dish.phases.indulgence <= 2, `${id} 放纵度应 ≤2`);
  }
});

test('菜品：nutrition 五项合理，健身高蛋白菜蛋白 25-45g', () => {
  for (const dish of DISHES) {
    const { kcal, protein, fat, carbs, veg } = dish.nutrition;
    for (const [key, value] of Object.entries({ kcal, protein, fat, carbs, veg })) {
      assert.ok(Number.isFinite(value) && value >= 0, `${dish.id}.nutrition.${key} 非法：${value}`);
    }
    assert.ok(kcal >= 60 && kcal <= 950, `${dish.id} 热量 ${kcal} 不合理`);
    assert.ok(protein >= 1 && protein <= 55, `${dish.id} 蛋白 ${protein} 不合理`);
    assert.ok(fat <= 90 && carbs <= 115, `${dish.id} 脂肪/碳水不合理`);
    assert.ok(veg <= 5, `${dish.id} 蔬菜份数 ${veg} 不合理`);
    const kcalFromMacros = 4 * protein + 4 * carbs + 9 * fat;
    assert.ok(Math.abs(kcalFromMacros - kcal) <= kcal * 0.35, `${dish.id} 宏量营养折算偏差过大`);
  }
  const highProteinFitness = DISHES.filter(
    (dish) => dish.phases.fitness >= 4 && dish.tags.some((tag) => tag === 'meat' || tag === 'seafood') && dish.nutrition.protein >= 25,
  );
  assert.ok(highProteinFitness.length >= 12, `健身高蛋白菜应 ≥12 道，当前 ${highProteinFitness.length}`);
  for (const dish of highProteinFitness) {
    assert.ok(dish.nutrition.protein >= 25 && dish.nutrition.protein <= 45, `${dish.id} 蛋白 ${dish.nutrition.protein}g 不在 25-45`);
    assert.ok(dish.nutrition.kcal >= 200 && dish.nutrition.kcal <= 560, `${dish.id} 热量 ${dish.nutrition.kcal} 不在 200-560`);
    assert.ok(dish.nutrition.fat <= 26, `${dish.id} 脂肪 ${dish.nutrition.fat}g 超过 26g`);
  }
});

test('菜品：云南/川味与果酸/发酵酸/醋酸偏好信号充足', () => {
  const yunnan = DISHES.filter((dish) => dish.origins.includes('云南'));
  assert.ok(yunnan.length >= 20, `云南归属菜应 ≥20，当前 ${yunnan.length}`);
  const fruitSour = DISHES.filter((dish) => dish.sour.fruit >= 3);
  const fermentedSour = DISHES.filter((dish) => dish.sour.fermented >= 3);
  const vinegarSour = DISHES.filter((dish) => dish.sour.vinegar >= 3);
  assert.ok(fruitSour.length >= 6, `果酸菜应 ≥6，当前 ${fruitSour.length}`);
  assert.ok(fermentedSour.length >= 5, `发酵酸菜应 ≥5，当前 ${fermentedSour.length}`);
  assert.ok(vinegarSour.length >= 4, `醋酸菜应 ≥4，当前 ${vinegarSour.length}`);
  // 用户画像重点菜品必须在库
  const required = ['lemon-chicken-breast', 'yunnan-papaya-chicken', 'lemongrass-grilled-chicken', 'sour-spicy-konjac', 'zhaotong-skewers', 'cold-eat-rabbit', 'sichuan-catfish-claypot'];
  const ids = new Set(DISHES.map((dish) => dish.id));
  for (const id of required) assert.ok(ids.has(id), `缺少重点菜品 ${id}`);
  // 云南重点菜应带明确果酸或发酵酸信号
  for (const id of ['lemon-chicken-breast', 'yunnan-papaya-chicken', 'tamarind-roast-chicken']) {
    const dish = DISHES.find((item) => item.id === id);
    assert.ok(dish.sour.fruit >= 4 || dish.sour.fermented >= 3, `${id} 缺少酸味信号`);
  }
});

test('菜品：1000 道全部 cookable 且 recipeId 一一对应', () => {
  const cookable = DISHES.filter((dish) => dish.cookable === true);
  assert.equal(cookable.length, 1000, `可自制菜应为 1000 道，当前 ${cookable.length}`);
  assert.equal(cookable.length, DISHES.length, '所有菜品都应可自制');
  assert.ok(DISHES.every((dish) => typeof dish.recipeId === 'string' && dish.recipeId.length > 0), '每道菜都必须有 recipeId');
  assert.ok(DISHES.every((dish) => dish.recipeId === dish.id), 'recipeId 应等于对应菜品 id（菜谱 id 沿用 dish id）');
  const recipeIds = new Set(RECIPES.map((recipe) => recipe.id));
  for (const dish of DISHES) assert.ok(recipeIds.has(dish.recipeId), `${dish.id} 的 recipeId 没有对应菜谱`);
});

test('菜谱：1000 道、字段完整、步骤 3-6 步、用量带数字单位与合法分组', () => {
  assert.equal(RECIPES.length, 1000, `菜谱应为 1000 道，当前 ${RECIPES.length}`);
  const ids = new Set();
  for (const recipe of RECIPES) {
    assert.ok(!ids.has(recipe.id), `菜谱 id 重复：${recipe.id}`);
    ids.add(recipe.id);
    assert.ok(DIFFICULTIES.includes(recipe.difficulty), `${recipe.id} difficulty 非法`);
    assert.ok(Number.isInteger(recipe.servings) && recipe.servings >= 1 && recipe.servings <= 4, `${recipe.id} servings 非法`);
    assert.ok(Number.isInteger(recipe.prepMin) && recipe.prepMin >= 0 && recipe.prepMin <= 180, `${recipe.id} prepMin 非法`);
    assert.ok(Number.isInteger(recipe.cookMin) && recipe.cookMin >= 0 && recipe.cookMin <= 180, `${recipe.id} cookMin 非法`);
    assert.ok(recipe.prepMin + recipe.cookMin <= 180, `${recipe.id} 总耗时过长`);
    assert.ok(Array.isArray(recipe.steps) && recipe.steps.length >= 3 && recipe.steps.length <= 6, `${recipe.id} 步骤数 ${recipe.steps.length} 不在 3-6`);
    for (const step of recipe.steps) assert.ok(typeof step === 'string' && [...step].length >= 8, `${recipe.id} 步骤过短`);
    assert.ok(Array.isArray(recipe.tips) && recipe.tips.length >= 1 && recipe.tips.length <= 2, `${recipe.id} tips 应为 1-2 条`);
    assert.ok(recipe.ingredients.length >= 3 && recipe.ingredients.length <= 12, `${recipe.id} 食材数量异常`);
    const names = new Set();
    for (const item of recipe.ingredients) {
      assert.ok(typeof item.name === 'string' && item.name.length > 0, `${recipe.id} 食材名为空`);
      assert.ok(!names.has(item.name), `${recipe.id} 食材重复：${item.name}`);
      names.add(item.name);
      assert.ok(Number.isFinite(item.amount) && item.amount > 0, `${recipe.id}.${item.name} 用量非数字：${item.amount}`);
      assert.ok(typeof item.unit === 'string' && item.unit.length > 0, `${recipe.id}.${item.name} 缺少单位`);
      assert.ok(INGREDIENT_GROUPS.includes(item.group), `${recipe.id}.${item.name} 分组非法：${item.group}`);
    }
  }
});

test('菜谱：与菜品双向引用，营养误差 ≤30%', () => {
  const dishById = new Map(DISHES.map((dish) => [dish.id, dish]));
  const recipeById = new Map(RECIPES.map((recipe) => [recipe.id, recipe]));
  for (const recipe of RECIPES) {
    const dish = dishById.get(recipe.dishId);
    assert.ok(dish, `${recipe.id} 的 dishId 不存在`);
    assert.equal(dish.cookable, true, `${recipe.id} 对应菜品不是可自制菜`);
    assert.equal(dish.recipeId, recipe.id, `${recipe.id} 与菜品 recipeId 不互相指向`);
    assert.equal(recipe.name, dish.name, `${recipe.id} 名称与菜品不一致`);
    const kcalError = Math.abs(recipe.kcal - dish.nutrition.kcal) / Math.max(1, dish.nutrition.kcal);
    const proteinError = Math.abs(recipe.protein - dish.nutrition.protein) / Math.max(1, dish.nutrition.protein);
    assert.ok(kcalError <= 0.3, `${recipe.id} kcal 误差 ${(kcalError * 100).toFixed(1)}% > 30%`);
    assert.ok(proteinError <= 0.3, `${recipe.id} protein 误差 ${(proteinError * 100).toFixed(1)}% > 30%`);
  }
  for (const dish of DISHES.filter((item) => item.cookable)) {
    assert.ok(recipeById.has(dish.recipeId), `${dish.id} 缺少菜谱`);
  }
});

test('菜谱：≥30 道云南/川味健身改良版，且覆盖多种菜系', () => {
  const dishById = new Map(DISHES.map((dish) => [dish.id, dish]));
  const yunnanSichuanFitness = RECIPES.filter((recipe) => {
    const dish = dishById.get(recipe.dishId);
    return ['云南菜', '西南', '川菜'].includes(dish.cuisine) && dish.phases.fitness >= 3;
  });
  assert.ok(yunnanSichuanFitness.length >= 30, `云南/川味健身改良菜谱应 ≥30，当前 ${yunnanSichuanFitness.length}`);
  const cuisines = new Set(RECIPES.map((recipe) => dishById.get(recipe.dishId).cuisine));
  assert.ok(cuisines.size >= 6, `菜谱菜系应 ≥6 种，当前 ${cuisines.size}`);
  // 重点健身改良菜谱必须在列
  for (const id of ['lemon-chicken-breast', 'steam-pot-chicken', 'hula-chicken-breast', 'sour-spicy-chicken-buckwheat']) {
    assert.ok(yunnanSichuanFitness.some((recipe) => recipe.id === id), `缺少重点健身改良菜谱 ${id}`);
  }
});

test('菜系：云南菜独立成系（≥30 道且全部省份=云南，西南不再含云南）', () => {
  assert.equal(CUISINES.length, 11, `菜系应为 11 类，当前 ${CUISINES.length}`);
  assert.ok(CUISINES.includes('云南菜'), 'CUISINES 应包含云南菜');
  const yunnanCuisine = DISHES.filter((dish) => dish.cuisine === '云南菜');
  assert.ok(yunnanCuisine.length >= 30, `云南菜应 ≥30 道，当前 ${yunnanCuisine.length}`);
  assert.equal(yunnanCuisine.length, DISHES.filter((dish) => dish.province === '云南').length, '云南菜数量应与省份=云南的菜一致');
  for (const dish of yunnanCuisine) {
    assert.equal(dish.province, '云南', `${dish.id} 是云南菜但 province=${dish.province}`);
    assert.ok(dish.origins.includes('云南'), `${dish.id} 云南菜 origins 应含云南`);
  }
  const southwest = DISHES.filter((dish) => dish.cuisine === '西南');
  assert.ok(southwest.length >= 3, `西南菜应 ≥3 道，当前 ${southwest.length}`);
  for (const dish of southwest) {
    assert.notEqual(dish.province, '云南', `${dish.id} 仍是西南菜但省份为云南（应改云南菜）`);
  }
  // 云南菜菜谱同样独立、数量与 dish 一致
  const dishById = new Map(DISHES.map((dish) => [dish.id, dish]));
  const yunnanRecipes = RECIPES.filter((recipe) => dishById.get(recipe.dishId).cuisine === '云南菜');
  assert.equal(yunnanRecipes.length, yunnanCuisine.length, '云南菜菜谱数应与菜品数一致');
});

test('菜谱：原有 60 道菜谱全部保留，内容未降级', () => {
  const recipeById = new Map(RECIPES.map((recipe) => [recipe.id, recipe]));
  const missing = LEGACY_RECIPE_IDS.filter((id) => !recipeById.has(id));
  assert.deepEqual(missing, [], `丢失原有菜谱：${missing.join(',')}`);
  assert.equal(LEGACY_RECIPE_IDS.length, 60, '原有菜谱基线应为 60 道');
  const dishById = new Map(DISHES.map((dish) => [dish.id, dish]));
  for (const id of LEGACY_RECIPE_IDS) {
    const recipe = recipeById.get(id);
    assert.equal(recipe.name, dishById.get(recipe.dishId).name, `${id} 名称与菜品不一致`);
    assert.ok(recipe.ingredients.length >= 3, `${id} 原有菜谱食材被删减`);
    assert.ok(recipe.steps.length >= 3, `${id} 原有菜谱步骤被删减`);
    assert.ok(recipe.tips.length >= 1, `${id} 原有菜谱 tips 被删减`);
  }
  // 抽检原菜谱主体内容仍在
  const tomatoEgg = recipeById.get('tomato-egg');
  assert.ok(tomatoEgg.steps.some((step) => step.includes('番茄')), '番茄炒蛋步骤内容缺失');
  const lemonChicken = recipeById.get('lemon-chicken-breast');
  assert.ok(lemonChicken.ingredients.some((item) => item.name === '鸡胸肉'), '柠檬手撕鸡胸食材缺失');
  assert.equal(lemonChicken.kcal, dishById.get('lemon-chicken-breast').nutrition.kcal, '原菜谱热量被改写');
});

test('菜谱：覆盖全部 8 个菜品分类，含家庭简化版火锅/烧烤', () => {
  const dishById = new Map(DISHES.map((dish) => [dish.id, dish]));
  const byCategory = {};
  for (const recipe of RECIPES) {
    const dish = dishById.get(recipe.dishId);
    byCategory[dish.category] = (byCategory[dish.category] || 0) + 1;
  }
  const expected = Object.fromEntries(
    [...new Set(DISHES.map((dish) => dish.category))].sort().map((category) => [
      category,
      DISHES.filter((dish) => dish.category === category).length,
    ]),
  );
  for (const category of ['米饭', '面食', '汤羹', '小吃', '家常菜', '火锅烧烤', '轻食', '早餐']) {
    assert.ok(expected[category] > 0, `菜品缺少分类：${category}`);
  }
  assert.deepEqual(byCategory, expected, '菜谱分类覆盖应与菜品分类分布一致');
  // 火锅/烧烤类必须是家庭简化版做法（面向家庭设备与现成底料）
  for (const recipe of RECIPES.filter((item) => dishById.get(item.dishId).category === '火锅烧烤')) {
    assert.ok(recipe.steps.length >= 3, `${recipe.id} 家庭简化版步骤不足`);
  }
});

test('城市：≥60 个、字段完整、大区合法且七区俱全', () => {
  assert.ok(CITIES.length >= 60, `城市应 ≥60，当前 ${CITIES.length}`);
  assert.equal(REGIONS.length, 7);
  const names = new Set();
  const regionCount = Object.fromEntries(REGIONS.map((region) => [region, 0]));
  for (const city of CITIES) {
    for (const key of ['name', 'province', 'region', 'district', 'lat', 'lng', 'adcode', 'tier', 'cuisines', 'specialties']) {
      assert.ok(city[key] !== undefined, `${city.name} 缺少字段 ${key}`);
    }
    assert.ok(!names.has(city.name), `城市重复：${city.name}`);
    names.add(city.name);
    assert.ok(REGIONS.includes(city.region), `${city.name} region 非法：${city.region}`);
    regionCount[city.region] += 1;
    assert.match(city.adcode, /^\d{6}$/, `${city.name} adcode 非法：${city.adcode}`);
    assert.ok(Number.isFinite(city.lat) && city.lat > 3 && city.lat < 54, `${city.name} lat 异常`);
    assert.ok(Number.isFinite(city.lng) && city.lng > 73 && city.lng < 136, `${city.name} lng 异常`);
    assert.ok(Array.isArray(city.cuisines) && city.cuisines.length >= 1, `${city.name} cuisines 为空`);
    assert.ok(Array.isArray(city.specialties) && city.specialties.length >= 1, `${city.name} specialties 为空`);
  }
  for (const [region, count] of Object.entries(regionCount)) {
    assert.ok(count >= 2, `大区 ${region} 只有 ${count} 个城市`);
  }
});

test('城市：默认城市合法，findCity 行为正确', () => {
  assert.ok(CITIES.includes(DEFAULT_CITY));
  assert.ok(DEFAULT_CITY.province && DEFAULT_CITY.region && DEFAULT_CITY.district);
  assert.equal(findCity('北京'), DEFAULT_CITY);
  assert.equal(findCity('北京市'), DEFAULT_CITY);
  assert.equal(findCity(DEFAULT_CITY.district), DEFAULT_CITY);
  assert.equal(findCity('成都').name, '成都');
  assert.equal(findCity('成都').province, '四川');
  assert.equal(findCity('不存在城市'), null);
  assert.equal(findCity(''), null);
  assert.equal(findCity(undefined), null);
  assert.equal(findCity(null), null);
});

test('校验脚本：能发现被篡改的数据（自检有效性）', () => {
  const broken = DISHES.slice(0, 10).map((dish, index) => (index === 0 ? { ...dish, phases: { fitness: 9, healthy: 3, relax: 3, indulgence: 3 } } : dish));
  const result = validateData({ dishes: broken });
  assert.equal(result.ok, false, '被篡改的数据应校验失败');
  assert.ok(result.errors.length > 0, '应给出错误明细');

  const brokenRecipes = RECIPES.map((recipe, index) => (index === 0 ? { ...recipe, dishId: 'not-exist-dish' } : recipe));
  const recipeResult = validateData({ recipes: brokenRecipes });
  assert.equal(recipeResult.ok, false, '菜谱引用错误应校验失败');
});

test('校验脚本 CLI：数据全绿时退出码 0 并打印摘要', () => {
  const script = fileURLToPath(new URL('../../scripts/validate-data.mjs', import.meta.url));
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  const output = execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.match(output, /全部校验通过/);
  assert.match(output, /菜品 1000 道/);
  assert.match(output, /菜谱 1000 道/);
  assert.match(output, /城市 81 个/);
});

test('校验脚本 CLI：数据被破坏时退出码 1', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-menu-validate-'));
  try {
    fs.cpSync(path.join(root, 'scripts'), path.join(temp, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'data'), path.join(temp, 'data'), { recursive: true });
    // 篡改一条菜品的价格（9 元不在 10-80 内），校验脚本应失败
    const dishesPath = path.join(temp, 'data', 'dishes.js');
    const source = fs.readFileSync(dishesPath, 'utf8');
    assert.ok(source.includes('price: 22,'), '测试前置：应能定位到目标价格');
    fs.writeFileSync(dishesPath, source.replace('price: 22,', 'price: 9,'), 'utf8');
    const result = spawnSync(process.execPath, [path.join(temp, 'scripts', 'validate-data.mjs')], { cwd: temp, encoding: 'utf8' });
    assert.equal(result.status, 1, `校验失败时退出码应为 1，实际 ${result.status}`);
    assert.match(String(result.stderr), /校验失败/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

