/**
 * src/core/user-recipes.js 单元测试：我的菜谱归一化 / 表单解析 / map 形态。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  USER_RECIPE_CATEGORIES,
  USER_RECIPE_CUISINES,
  guessIngredientGroup,
  makeUserRecipeId,
  normalizeUserRecipe,
  normalizeUserRecipes,
  parseIngredientLines,
  parseStepLines,
  parseTipLines,
  userRecipeList,
} from '../../src/core/user-recipes.js'

const NOW = 1790000000000

test('枚举与默认值：11 菜系 / 8 分类 / 默认家常菜与易', () => {
  assert.equal(USER_RECIPE_CUISINES.length, 11)
  assert.ok(USER_RECIPE_CUISINES.includes('云南菜'))
  assert.equal(USER_RECIPE_CATEGORIES.length, 8)
  const recipe = normalizeUserRecipe({ name: '青柠手撕鸡', cuisine: '云南菜' }, { now: NOW })
  assert.ok(recipe)
  assert.equal(recipe.category, '家常菜')
  assert.equal(recipe.difficulty, '易')
  assert.equal(recipe.country, '中国')
  assert.equal(recipe.servings, 2)
  assert.equal(recipe.createdAt, NOW)
  assert.equal(recipe.updatedAt, NOW)
})

test('normalizeUserRecipe：非法项返回 null（缺菜名 / 非法菜系 / 非对象）', () => {
  assert.equal(normalizeUserRecipe(null), null)
  assert.equal(normalizeUserRecipe('x'), null)
  assert.equal(normalizeUserRecipe({ cuisine: '川菜' }), null)
  assert.equal(normalizeUserRecipe({ name: '怪菜', cuisine: '不存在' }), null)
  assert.equal(normalizeUserRecipe({ name: '   ', cuisine: '川菜' }), null)
})

test('normalizeUserRecipe：字段 clamp、食材分组推断、非中国菜无省份', () => {
  const recipe = normalizeUserRecipe({
    name: '  ' + '鸡'.repeat(60) + '  ',
    cuisine: '日韩',
    category: '宵夜',
    country: '日本',
    province: '云南',
    servings: 99,
    prepMin: -5,
    cookMin: 9999,
    kcal: 99999,
    protein: -3,
    ingredients: [{ name: '鸡腿肉', amount: 200, unit: 'g' }, { name: '  ' }, { name: '酱油', amount: 'x' }],
    steps: [' 第一步 ', '', '第二步'],
    tips: [' 小贴士 '],
  }, { now: NOW })
  assert.equal(recipe.name.length, 40)
  assert.equal(recipe.category, '家常菜')
  assert.equal(recipe.province, null, '非中国菜不保留省份')
  assert.equal(recipe.servings, 20)
  assert.equal(recipe.prepMin, 0)
  assert.equal(recipe.cookMin, 600)
  assert.equal(recipe.kcal, 3000)
  assert.equal(recipe.protein, 0)
  assert.deepEqual(recipe.steps, ['第一步', '第二步'])
  assert.deepEqual(recipe.tips, ['小贴士'])
  assert.equal(recipe.ingredients.length, 2)
  assert.equal(recipe.ingredients[0].group, '肉蛋')
  assert.equal(recipe.ingredients[1].group, '调料')
})

test('normalizeUserRecipes：对象 map 丢弃 null/非法项，兼容数组形态', () => {
  const map = normalizeUserRecipes({
    'custom-a': { name: 'A', cuisine: '川菜' },
    'custom-b': null,
    'custom-c': { name: '', cuisine: '川菜' },
    'custom-d': { name: 'D', cuisine: '云南菜' },
  })
  assert.deepEqual(Object.keys(map), ['custom-a', 'custom-d'])
  assert.equal(map['custom-a'].id, 'custom-a', '键名兜底 id')
  assert.equal(map['custom-d'].name, 'D')

  const fromArray = normalizeUserRecipes([
    { id: 'custom-x', name: 'X', cuisine: '粤菜' },
    { id: 'custom-y', name: '', cuisine: '粤菜' },
  ])
  assert.deepEqual(Object.keys(fromArray), ['custom-x'])
})

test('userRecipeList：按创建时间倒序', () => {
  const map = normalizeUserRecipes({
    a: { name: 'A', cuisine: '川菜', createdAt: 1000, updatedAt: 1000 },
    b: { name: 'B', cuisine: '川菜', createdAt: 3000, updatedAt: 3000 },
    c: { name: 'C', cuisine: '川菜', createdAt: 2000, updatedAt: 2000 },
  })
  assert.deepEqual(userRecipeList(map).map((recipe) => recipe.name), ['B', 'C', 'A'])
})

test('表单解析：食材行「名称 数量单位」/ 步骤 / 小贴士', () => {
  const ingredients = parseIngredientLines('鸡胸肉 200g\n小米辣 2 个\n盐\n\n青柠 1.5 个')
  assert.equal(ingredients.length, 4)
  assert.deepEqual(ingredients[0], { name: '鸡胸肉', amount: 200, unit: 'g', group: '肉蛋' })
  assert.equal(ingredients[1].amount, 2)
  assert.equal(ingredients[1].unit, '个')
  assert.equal(ingredients[2].amount, null)
  assert.equal(ingredients[3].amount, 1.5)

  assert.deepEqual(parseStepLines(' 第一步 \n\n第二步'), ['第一步', '第二步'])
  assert.deepEqual(parseTipLines('小贴士一\n小贴士二'), ['小贴士一', '小贴士二'])
})

test('makeUserRecipeId / guessIngredientGroup', () => {
  const id = makeUserRecipeId(NOW)
  assert.match(id, /^custom-[a-z0-9]+-[a-z0-9]+$/)
  assert.equal(makeUserRecipeId(NOW).startsWith('custom-'), true)
  assert.equal(guessIngredientGroup('鸡胸肉'), '肉蛋')
  assert.equal(guessIngredientGroup('青柠'), '水果')
  assert.equal(guessIngredientGroup('豆腐'), '豆制品')
  assert.equal(guessIngredientGroup('米饭'), '主食')
  assert.equal(guessIngredientGroup('未知食材'), '其他')
})
