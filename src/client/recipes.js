/**
 * 「今天吃什么」client 半 —— 菜谱数据适配层。
 *
 * 菜谱由成员 menu-data 维护在 data/recipes.js（v2 契约 §5）。
 * 这里做一层防御式归一化：数据缺失 / 字段异常时返回空列表，面板展示「菜谱数据未就绪」而不是崩溃。
 *
 * 注意：构建脚本对 data/recipes.js 做了「缺失时提供空模块」的兜底，
 * 这样 v2 数据还没落地时 client 仍可独立构建与烟测；数据落地后重新构建即可自动带上真实菜谱。
 */

import * as recipeModule from '../../data/recipes.js'

/**
 * 归一化单条菜谱（保持原字段，尽量不丢信息）。
 *
 * @param {unknown} recipe 原始菜谱
 * @returns {object | null} 菜谱
 */
function normalizeRecipe(recipe) {
  if (recipe === null || typeof recipe !== 'object') return null
  if (typeof recipe.id !== 'string' || recipe.id === '') return null
  const ingredients = Array.isArray(recipe.ingredients)
    ? recipe.ingredients
        .filter((item) => item !== null && typeof item === 'object' && typeof item.name === 'string')
        .map((item) => ({
          name: item.name,
          amount: item.amount,
          unit: item.unit ?? '',
          group: typeof item.group === 'string' && item.group !== '' ? item.group : '其他',
        }))
    : []
  const steps = Array.isArray(recipe.steps) ? recipe.steps.filter((step) => typeof step === 'string' && step !== '') : []
  const tips = Array.isArray(recipe.tips) ? recipe.tips.filter((tip) => typeof tip === 'string' && tip !== '') : []
  return { ...recipe, ingredients, steps, tips }
}

/** 原始菜谱列表（data/recipes.js 导出 RECIPES；缺失时为空数组）。 */
const rawRecipes = Array.isArray(recipeModule.RECIPES) ? recipeModule.RECIPES : []

/** 归一化后的菜谱（去重：同 id 保留第一条）。 */
export const RECIPES = (() => {
  const seen = new Set()
  const list = []
  for (const recipe of rawRecipes) {
    const normalized = normalizeRecipe(recipe)
    if (normalized === null || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    list.push(normalized)
  }
  return Object.freeze(list)
})()

/** recipeId -> 菜谱。 */
const RECIPE_MAP = new Map(RECIPES.map((recipe) => [recipe.id, recipe]))

/** dishId -> 菜谱（同一道菜可能对应一份菜谱）。 */
const DISH_MAP = new Map()
for (const recipe of RECIPES) {
  if (typeof recipe.dishId === 'string' && !DISH_MAP.has(recipe.dishId)) DISH_MAP.set(recipe.dishId, recipe)
}

/**
 * 菜谱数据是否已就绪。
 *
 * @returns {boolean} 是否有菜谱
 */
export function hasRecipes() {
  return RECIPES.length > 0
}

/**
 * 按菜谱 id 取菜谱。
 *
 * @param {string} recipeId 菜谱 id
 * @returns {object | null} 菜谱
 */
export function recipeById(recipeId) {
  return RECIPE_MAP.get(recipeId) ?? null
}

/**
 * 按菜品 id 取菜谱。
 *
 * @param {string} dishId 菜品 id
 * @returns {object | null} 菜谱
 */
export function recipeForDish(dishId) {
  if (typeof dishId !== 'string' || dishId === '') return null
  return DISH_MAP.get(dishId) ?? RECIPE_MAP.get(dishId) ?? null
}
