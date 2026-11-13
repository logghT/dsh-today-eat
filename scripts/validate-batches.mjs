#!/usr/bin/env node
/**
 * 批量菜谱数据校验（给并行扩充用）。
 *
 * 用法：
 *   node scripts/validate-batches.mjs data/expanded/a-dishes.js data/expanded/a-recipes.js
 *
 * 只校验这一批的菜品/菜谱结构、跨引用与基础营养；不校验全局数量。
 * 全部通过时 exit 0；否则打印问题并 exit 1。
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const CATEGORIES = ['米饭', '面食', '汤羹', '小吃', '家常菜', '火锅烧烤', '轻食', '早餐'];
const CUISINES = ['云南菜', '川菜', '粤菜', '湘菜', '江浙', '北方', '西北', '西南', '日韩', '西式', '快餐'];
const PROVINCES = ['云南', '四川', '重庆', '贵州', '广西', '广东', '湖南', '湖北', '河南', '河北', '山东', '山西', '陕西', '甘肃', '青海', '宁夏', '新疆', '西藏', '内蒙古', '辽宁', '吉林', '黑龙江', '北京', '天津', '上海', '江苏', '浙江', '安徽', '福建', '江西', '海南', '台湾', '香港', '澳门'];
const COUNTRIES = ['中国', '日本', '韩国', '美国', '意大利', '法国', '泰国', '越南', '印度', '墨西哥', '西班牙', '英国', '土耳其', '挪威', '希腊', '比利时'];
const INGREDIENT_GROUPS = ['蔬菜', '肉蛋', '水产', '豆制品', '主食', '调料', '水果'];
const DIFFICULTIES = ['易', '中', '难'];
const TAGS = ['mild', 'medium', 'hot', 'meat', 'veg', 'seafood', 'soup', 'noodle', 'rice', 'light'];
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CJK_RE = /[\u4e00-\u9fa5]/;

const charLen = (value) => [...String(value)].length;
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const near = (a, b, ratio) => Math.abs(a - b) <= Math.max(1, Math.abs(b)) * ratio + 0.001;

function checkDish(dish, where, fail) {
  if (!dish || typeof dish !== 'object') return fail(where, '不是对象');
  if (typeof dish.id !== 'string' || !KEBAB_RE.test(dish.id)) fail(where, `id 不是 kebab-case: ${dish.id}`);
  if (typeof dish.name !== 'string' || charLen(dish.name) < 2 || charLen(dish.name) > 12) fail(where, 'name 缺失或长度异常');
  if (typeof dish.emoji !== 'string' || charLen(dish.emoji) < 1 || charLen(dish.emoji) > 3) fail(where, 'emoji 缺失或异常');
  if (!CATEGORIES.includes(dish.category)) fail(where, `category 非法: ${dish.category}`);
  if (!CUISINES.includes(dish.cuisine)) fail(where, `cuisine 非法: ${dish.cuisine}`);
  if (!Array.isArray(dish.tags) || dish.tags.length < 2) fail(where, 'tags 缺失');
  else {
    if (new Set(dish.tags).size !== dish.tags.length) fail(where, 'tags 重复');
    if (!dish.tags.every((tag) => TAGS.includes(tag))) fail(where, `tags 含未知值: ${dish.tags.join(',')}`);
    const spicy = dish.tags.filter((tag) => ['mild', 'medium', 'hot'].includes(tag));
    const meal = dish.tags.filter((tag) => ['meat', 'veg', 'seafood'].includes(tag));
    if (spicy.length !== 1) fail(where, 'tags 必须且只能有一个辣度');
    if (meal.length !== 1) fail(where, 'tags 必须且只能有一个荤素标记');
    const need = { 面食: 'noodle', 米饭: 'rice', 汤羹: 'soup', 轻食: 'light' }[dish.category];
    if (need && !dish.tags.includes(need)) fail(where, `${dish.category} 缺少 tag ${need}`);
  }
  if (!isNum(dish.price) || dish.price < 10 || dish.price > 80) fail(where, `price 不在 10-80: ${dish.price}`);
  if (typeof dish.description !== 'string' || !CJK_RE.test(dish.description) || /[\r\n]/.test(dish.description)) fail(where, 'description 缺失或非中文');
  else if (charLen(dish.description) < 20 || charLen(dish.description) > 40) fail(where, `description 长度 ${charLen(dish.description)} 不在 20-40`);
  if (!dish.phases || typeof dish.phases !== 'object') fail(where, 'phases 缺失');
  else {
    for (const kind of ['fitness', 'healthy', 'relax', 'indulgence']) if (!isInt(dish.phases[kind], 1, 5)) fail(where, `phases.${kind} 不在 1-5`);
    const vals = Object.values(dish.phases);
    if (Math.max(...vals) < 3) fail(where, 'phases 全部低于 3');
    if (new Set(vals).size === 1) fail(where, 'phases 四维完全相同');
    if (dish.phases.fitness >= 4 && dish.phases.indulgence >= 3) fail(where, 'fitness>=4 与 indulgence>=3 矛盾');
  }
  if (!dish.nutrition || typeof dish.nutrition !== 'object') fail(where, 'nutrition 缺失');
  else {
    const n = dish.nutrition;
    if (!isNum(n.kcal) || n.kcal < 60 || n.kcal > 950) fail(where, `kcal 不合理: ${n.kcal}`);
    if (!isNum(n.protein) || n.protein < 1 || n.protein > 55) fail(where, `protein 不合理: ${n.protein}`);
    if (!isNum(n.fat) || n.fat < 1 || n.fat > 90) fail(where, `fat 不合理: ${n.fat}`);
    if (!isNum(n.carbs) || n.carbs < 1 || n.carbs > 115) fail(where, `carbs 不合理: ${n.carbs}`);
    if (!isInt(n.veg, 0, 5)) fail(where, `veg 不在 0-5: ${n.veg}`);
    if (isNum(n.kcal) && isNum(n.protein) && isNum(n.fat) && isNum(n.carbs)) {
      const macro = 4 * n.protein + 4 * n.carbs + 9 * n.fat;
      if (Math.abs(macro - n.kcal) > n.kcal * 0.35) fail(where, `宏量 ${macro} 与 kcal ${n.kcal} 偏差过大`);
      if (dish.phases && dish.phases.fitness >= 4 && n.protein >= 25) {
        if (n.protein > 45) fail(where, '健身高蛋白菜蛋白 >45g');
        if (n.kcal < 200 || n.kcal > 560) fail(where, '健身高蛋白菜热量不在 200-560');
        if (n.fat > 26) fail(where, '健身高蛋白菜脂肪 >26g');
      }
    }
  }
  if (!dish.sour || typeof dish.sour !== 'object') fail(where, 'sour 缺失');
  else for (const key of ['fruit', 'fermented', 'vinegar']) if (!isInt(dish.sour[key], 0, 5)) fail(where, `sour.${key} 不在 0-5`);
  if (!Array.isArray(dish.origins) || dish.origins.length > 3) fail(where, 'origins 应 ≤3 项');
  else if (!dish.origins.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 8 && !/[|/]/.test(x))) fail(where, 'origins 含非法值');
  else if (new Set(dish.origins).size !== dish.origins.length) fail(where, 'origins 重复');
  if (!COUNTRIES.includes(dish.country)) fail(where, `country 非法: ${dish.country}`);
  if (dish.country === '中国') {
    if (!PROVINCES.includes(dish.province)) fail(where, `中国菜 province 非法: ${dish.province}`);
  } else if (dish.province !== null) fail(where, `国外菜 province 应为 null: ${dish.province}`);
  if (!Array.isArray(dish.ingredients) || dish.ingredients.length < 2 || dish.ingredients.length > 8) fail(where, 'ingredients 应 2-8 项');
  else {
    if (new Set(dish.ingredients).size !== dish.ingredients.length) fail(where, 'ingredients 重复');
    if (!dish.ingredients.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 10)) fail(where, 'ingredients 含非法值');
  }
  if (dish.cookable !== true) fail(where, 'cookable 应为 true');
  if (dish.recipeId !== dish.id) fail(where, `recipeId 应等于 id: ${dish.recipeId}`);
}

function checkRecipe(recipe, dish, where, fail) {
  if (!recipe || typeof recipe !== 'object') return fail(where, '不是对象');
  if (typeof recipe.id !== 'string' || !KEBAB_RE.test(recipe.id)) fail(where, `id 不是 kebab-case: ${recipe.id}`);
  if (recipe.dishId !== recipe.id) fail(where, `dishId 应等于 id: ${recipe.dishId}`);
  if (recipe.name !== dish.name) fail(where, `name 与菜品不一致: ${recipe.name} != ${dish.name}`);
  if (!near(recipe.kcal, dish.nutrition.kcal, 0.3)) fail(where, `kcal ${recipe.kcal} 与菜品 ${dish.nutrition.kcal} 误差 >30%`);
  if (!near(recipe.protein, dish.nutrition.protein, 0.3)) fail(where, `protein ${recipe.protein} 与菜品 ${dish.nutrition.protein} 误差 >30%`);
  if (!isInt(recipe.servings, 1, 4)) fail(where, `servings 不在 1-4: ${recipe.servings}`);
  if (!isInt(recipe.prepMin, 0, 180)) fail(where, `prepMin 不在 0-180: ${recipe.prepMin}`);
  if (!isInt(recipe.cookMin, 0, 180)) fail(where, `cookMin 不在 0-180: ${recipe.cookMin}`);
  if (recipe.prepMin + recipe.cookMin > 180) fail(where, '总耗时 >180');
  if (!DIFFICULTIES.includes(recipe.difficulty)) fail(where, `difficulty 非法: ${recipe.difficulty}`);
  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length < 3 || recipe.ingredients.length > 12) fail(where, 'ingredients 应 3-12 项');
  else {
    const names = new Set();
    for (const item of recipe.ingredients) {
      if (!item || typeof item !== 'object') { fail(where, 'ingredients 含非对象'); continue; }
      if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 12) fail(where, `ingredients.name 非法: ${item.name}`);
      if (names.has(item.name)) fail(where, `ingredients 重复: ${item.name}`);
      names.add(item.name);
      if (!isNum(item.amount) || item.amount <= 0 || item.amount > 5000) fail(where, `ingredients.${item.name} 用量非数字: ${item.amount}`);
      if (typeof item.unit !== 'string' || item.unit.length === 0 || item.unit.length > 4) fail(where, `ingredients.${item.name} 单位缺失`);
      if (!INGREDIENT_GROUPS.includes(item.group)) fail(where, `ingredients.${item.name} 分组非法: ${item.group}`);
    }
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length < 3 || recipe.steps.length > 6) fail(where, `steps 应 3-6 步: ${Array.isArray(recipe.steps) ? recipe.steps.length : '缺失'}`);
  else for (const step of recipe.steps) if (typeof step !== 'string' || charLen(step) < 8) fail(where, `步骤过短: ${step}`);
  if (!Array.isArray(recipe.tips) || recipe.tips.length < 1 || recipe.tips.length > 2) fail(where, 'tips 应 1-2 条');
  else for (const tip of recipe.tips) if (typeof tip !== 'string' || charLen(tip) < 4) fail(where, `tips 过短: ${tip}`);
}

async function main() {
  const [dishPath, recipePath] = process.argv.slice(2);
  if (!dishPath || !recipePath) {
    console.error('用法: node scripts/validate-batches.mjs <dishes.js> <recipes.js>');
    process.exitCode = 2;
    return;
  }
  const dishesMod = await import(pathToFileURL(resolve(dishPath)).href);
  const recipesMod = await import(pathToFileURL(resolve(recipePath)).href);
  const dishes = Object.values(dishesMod).find((value) => Array.isArray(value));
  const recipes = Object.values(recipesMod).find((value) => Array.isArray(value));
  const errors = [];
  const fail = (where, message) => errors.push(`${where}：${message}`);

  if (!Array.isArray(dishes)) return console.error('❌ 菜品文件没有导出数组'), (process.exitCode = 1);
  if (!Array.isArray(recipes)) return console.error('❌ 菜谱文件没有导出数组'), (process.exitCode = 1);

  const dishIds = new Set();
  const dishNames = new Set();
  const dishById = new Map();
  for (const dish of dishes) {
    const where = `菜品 ${dish && dish.id ? dish.id : '(缺 id)'}`;
    checkDish(dish, where, fail);
    if (dish && dish.id) {
      if (dishIds.has(dish.id)) fail(where, 'id 重复');
      dishIds.add(dish.id);
      dishById.set(dish.id, dish);
    }
    if (dish && dish.name) {
      if (dishNames.has(dish.name)) fail(where, `菜名重复: ${dish.name}`);
      dishNames.add(dish.name);
    }
  }

  const recipeIds = new Set();
  for (const recipe of recipes) {
    const where = `菜谱 ${recipe && recipe.id ? recipe.id : '(缺 id)'}`;
    if (recipe && recipe.id && recipeIds.has(recipe.id)) fail(where, 'id 重复');
    if (recipe && recipe.id) recipeIds.add(recipe.id);
    const dish = recipe && dishById.get(recipe.dishId);
    if (!dish) fail(where, `dishId 不存在于本批菜品: ${recipe && recipe.dishId}`);
    else checkRecipe(recipe, dish, where, fail);
  }

  if (dishes.length !== recipes.length) fail('数量', `菜品 ${dishes.length} 与菜谱 ${recipes.length} 不相等`);

  if (errors.length > 0) {
    console.error(`❌ 本批校验失败，共 ${errors.length} 处：`);
    for (const error of errors.slice(0, 120)) console.error(`  - ${error}`);
    if (errors.length > 120) console.error(`  …其余 ${errors.length - 120} 处省略`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ 本批通过：菜品 ${dishes.length} / 菜谱 ${recipes.length}（id 唯一、字段/营养/步骤/用量/分组全部合法）`);
}

main().catch((error) => {
  console.error('❌ 校验脚本异常:', error);
  process.exitCode = 1;
});
