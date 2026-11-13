/**
 * tests/host 共用工具：临时状态目录、stub 依赖、raw JSON Schema 子集校验。
 *
 * 不属于 *.test.mjs，不会被 node --test 单独执行。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createStore } from '../../lib/state.js'

/** 固定注入时间：上海时间 2026-11-09 12:00（午餐）。 */
export const FIXED_TS = Date.parse('2026-11-09T12:00:00+08:00')

/** 固定 now 函数。 */
export const FIXED_NOW = () => FIXED_TS

const tempDirs = []

/**
 * 新建临时目录（进程退出前清理）。
 *
 * @returns {string} 目录
 */
export function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-today-eat-test-'))
  tempDirs.push(dir)
  return dir
}

/**
 * 新建一套独立 store（路径位于临时目录）。
 *
 * @param {string} [label] 用例标签
 * @returns {object} store
 */
export function makeStore(label = 'case') {
  const statePath = join(makeTempDir(), label, 'storages', 'dsh-today-eat', 'state.json')
  return createStore({ statePath, now: FIXED_NOW })
}

/**
 * 清理临时目录。
 *
 * @returns {void}
 */
export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 忽略
    }
  }
}

/**
 * 固定 stub 菜品库（不依赖 data/ 具体菜名）。
 *
 * @returns {Array} 菜品
 */
export function stubDishes() {
  return [
    { id: 'stub-sour-fish', name: '酸汤鱼片', emoji: '🐟', cuisine: '云南', price: 32, tags: ['medium', 'meat'], description: '酸香开胃', nutrition: { kcal: 380, protein: 32, fat: 10, carbs: 30, veg: 2 } },
    { id: 'stub-lemon-chicken', name: '柠檬鸡胸沙拉', emoji: '🥗', cuisine: '云南', price: 28, tags: ['mild', 'meat'], description: '果酸高蛋白', nutrition: { kcal: 420, protein: 38, fat: 12, carbs: 40, veg: 2 } },
    { id: 'stub-tomato-noodle', name: '番茄鸡蛋面', emoji: '🍜', cuisine: '北方', price: 18, tags: ['mild', 'veg'], description: '家常热汤面', nutrition: { kcal: 520, protein: 18, fat: 14, carbs: 80, veg: 1 } },
  ]
}

/**
 * stub 推荐内核。
 *
 * @returns {object} 内核
 */
export function createStubCore() {
  const dishes = stubDishes()
  const recipes = [{
    id: 'stub-lemon-chicken',
    dishId: 'stub-lemon-chicken',
    name: '柠檬鸡胸沙拉',
    servings: 1,
    prepMin: 8,
    cookMin: 10,
    difficulty: '易',
    ingredients: [
      { name: '鸡胸肉', amount: 150, unit: 'g', group: '肉蛋' },
      { name: '青柠', amount: 2, unit: '个', group: '蔬菜' },
    ],
    steps: ['鸡胸煮熟撕条', '挤青柠汁拌匀'],
    tips: ['青柠最后放'],
  }]
  const findDish = (dishId) => dishes.find((dish) => dish.id === dishId) || null
  return {
    catalog: dishes,
    findDish,
    async phaseTargets({ phase } = {}) {
      const kind = phase && phase.kind ? phase.kind : 'fitness'
      return kind === 'fitness'
        ? { kcalMin: 1600, kcalMax: 2000, proteinG: 120, freeMealsPerWeek: 1 }
        : { kcalMin: 1800, kcalMax: 2200, proteinG: 110, freeMealsPerWeek: 2 }
    },
    async recommendMeal(request = {}) {
      const exclude = Array.isArray(request.excludeIds) ? request.excludeIds : []
      const pool = dishes.filter((dish) => !exclude.includes(dish.id))
      const dish = pool[0] || dishes[0]
      return {
        date: request.date || '2026-11-09',
        meal: request.meal || 'lunch',
        phaseKind: request.phaseKind || 'fitness',
        mode: request.mode || 'any',
        reason: 'stub 推荐理由',
        dish,
        alternatives: dishes.filter((item) => item.id !== dish.id).slice(0, 2),
        nutrition: dish.nutrition,
        fallbackNote: null,
      }
    },
    async planWeek(request = {}) {
      const start = request.startDate || '2026-11-09'
      const dayCount = Number.isFinite(Number(request.days)) ? Number(request.days) : 7
      const mealList = Array.isArray(request.meals) && request.meals.length > 0 ? request.meals : ['lunch', 'dinner']
      const days = []
      for (let offset = 0; offset < dayCount; offset += 1) {
        const date = new Date(Date.parse(`${start}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
        days.push({ date, meals: mealList.map((meal, index) => ({ meal, dish: dishes[(offset + index) % dishes.length], mode: 'home' })) })
      }
      return {
        start,
        seed: 7,
        days,
        summary: { avgKcal: 1800, avgProtein: 110, uniqueDishes: 3, cuisines: ['云南', '北方'], estimatedCost: 320, freeMeals: 1 },
      }
    },
    async summarizeMeals(request = {}) {
      const meals = Array.isArray(request.meals) ? request.meals : []
      const dishIds = meals.map((meal) => meal.dishId).filter(Boolean)
      const unique = new Set(dishIds)
      return {
        streak: meals.length > 0 ? 3 : 0,
        loggedDays: new Set(meals.map((meal) => meal.date)).size,
        repeatRate: dishIds.length > 0 ? 1 - unique.size / dishIds.length : 0,
        avgKcal: meals.length > 0 ? 1800 : 0,
        avgProtein: meals.length > 0 ? 110 : 0,
        adherence: meals.length > 0 ? 0.8 : 0,
        freeMealsUsed: 1,
        topCuisines: [{ cuisine: '云南', count: 3 }],
      }
    },
    async summarizeTaste(request = {}) {
      const meals = Array.isArray(request.meals) ? request.meals : []
      const taste = request.profile && request.profile.taste ? request.profile.taste : {}
      const ids = ['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami']
      const labels = { sour: '酸', sweet: '甜', bitter: '苦', spicy: '辣', salty: '咸', umami: '鲜' }
      const defaults = { sour: 3, sweet: 2, bitter: 1, spicy: 3, salty: 2, umami: 3 }
      const liked = meals.filter((meal) => meal.rating === 1).length
      const disliked = meals.filter((meal) => meal.rating === -1).length
      const dimensions = ids.map((id, index) => {
        const base = Number.isFinite(Number(taste[id])) ? Number(taste[id]) : defaults[id]
        const raw = meals.length === 0 ? base : base + liked * 0.5 - disliked * 0.5 + index * 0.1
        return {
          id,
          label: labels[id],
          value: Math.round(Math.min(5, Math.max(0, raw)) * 10) / 10,
          liked,
          disliked,
        }
      })
      const high = dimensions.filter((dimension) => dimension.value >= 4)
      return {
        samples: meals.length,
        dimensions,
        topTastes: high.map((dimension) => dimension.id),
        summary: meals.length === 0
          ? `偏好设置：${dimensions.map((dimension) => `${dimension.label}${dimension.value}`).join(' ')}`
          : high.length > 0 ? `偏爱：${high.slice(0, 3).map((dimension) => dimension.label).join('、')}` : '口味均衡',
      }
    },
    async buildShoppingList() {
      return {
        window: { from: '2026-11-09', to: '2026-11-11' },
        groups: [{ group: '蔬菜', items: [{ name: '青柠', amount: 2, unit: '个' }] }],
        estimatedCost: 18,
        missingRecipes: [],
      }
    },
    async recipeForDish(dishId) {
      return recipes.find((recipe) => recipe.dishId === dishId || recipe.id === dishId) || null
    },
  }
}

/**
 * stub 高德（成功路径）。
 *
 * @returns {object} 高德客户端
 */
export function createStubAmap() {
  return {
    async searchNearby() {
      return {
        ok: true,
        items: [
          { name: '川味小馆', address: '锦江区某路', distance: 300, rating: 4.6, cost: 35, tel: '028', type: '餐饮服务', location: '103.03,29.98' },
          { name: '轻食厨房', address: '锦江区某街', distance: 520, rating: 4.2, cost: 28, tel: '', type: '餐饮服务', location: '103.04,29.99' },
        ],
        suggestions: ['川味小馆：主菜选蒸/煮/烤的鱼禽牛'],
        keywords: ['轻食'],
        radius: 1500,
      }
    },
    async weather() {
      return {
        ok: true,
        weather: { date: '2026-11-09', dayWeather: '多云', nightWeather: '阴', dayTemp: 20, nightTemp: 12, dayWind: '东北风', dayPower: '1-2' },
      }
    },
    buildFallbackQueries: () => ['四川成都 锦江区 轻食', '四川成都 锦江区 酸汤鱼'],
  }
}

/**
 * 构造 API 请求。
 *
 * @param {object} overrides 覆盖项
 * @returns {object} 请求
 */
export function makeRequest(overrides = {}) {
  return {
    method: 'GET',
    path: '/dsh-today-eat/api/state',
    headers: { host: '127.0.0.1:49396', origin: 'http://127.0.0.1:49396', 'content-type': 'application/json' },
    rawBody: '',
    ...overrides,
  }
}

// ── raw JSON Schema 子集校验 ─────────────────────────────

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'type']

/**
 * 递归断言 schema 属于 dsh-tools 支持的 raw JSON Schema 子集。
 *
 * @param {object} node schema 节点
 * @param {string} path 诊断路径
 * @returns {void}
 */
export function assertSupportedSchema(node, path) {
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${path} 必须是 schema 对象`)
  for (const key of Object.keys(node)) {
    assert.ok(CONSTRAINT_KEYS.has(key) || ANNOTATIONS.has(key), `${path}.${key} 不是受支持的关键字`)
  }
  if (Object.prototype.hasOwnProperty.call(node, 'description')) {
    assert.equal(typeof node.description, 'string', `${path}.description 必须是字符串`)
  }
  const hasOneOf = Object.prototype.hasOwnProperty.call(node, 'oneOf')
  if (hasOneOf) {
    assert.ok(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${path}.oneOf 至少 2 个分支`)
    for (const key of ONE_OF_SIBLINGS) {
      assert.ok(!Object.prototype.hasOwnProperty.call(node, key), `${path} 的 ${key} 不能与 oneOf 并列`)
    }
    node.oneOf.forEach((branch, index) => assertSupportedSchema(branch, `${path}.oneOf[${index}]`))
    return
  }
  assert.ok(Object.prototype.hasOwnProperty.call(node, 'type'), `${path} 必须声明 type 或 oneOf`)
  assert.ok(typeof node.type === 'string' && SCHEMA_TYPES.has(node.type), `${path}.type 不合法`)
  if (Object.prototype.hasOwnProperty.call(node, 'additionalProperties')) {
    assert.equal(typeof node.additionalProperties, 'boolean', `${path}.additionalProperties 必须是布尔`)
    assert.equal(node.type, 'object', `${path}.additionalProperties 只能用于 object`)
  }
  if (node.type === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, 'properties')) {
      assert.ok(node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties), `${path}.properties 必须是对象`)
      for (const [key, value] of Object.entries(node.properties)) assertSupportedSchema(value, `${path}.properties.${key}`)
    }
    if (Object.prototype.hasOwnProperty.call(node, 'required')) {
      assert.ok(Array.isArray(node.required), `${path}.required 必须是数组`)
      for (const key of node.required) {
        assert.ok(node.properties !== undefined && Object.prototype.hasOwnProperty.call(node.properties, key), `${path}.required 的 "${key}" 不在 properties 中`)
      }
    }
    return
  }
  if (node.type === 'array') {
    if (Object.prototype.hasOwnProperty.call(node, 'items')) assertSupportedSchema(node.items, `${path}.items`)
    return
  }
  if (Object.prototype.hasOwnProperty.call(node, 'enum')) {
    assert.ok(Array.isArray(node.enum) && node.enum.length > 0, `${path}.enum 必须是非空数组`)
    for (const value of node.enum) {
      assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value), `${path}.enum 只能包含标量`)
    }
  }
}

/**
 * 校验 JSON 值是否符合 schema 子集。
 *
 * @param {object} schema schema
 * @param {unknown} value 值
 * @param {string} path 诊断路径
 * @param {string[]} errors 错误收集
 * @returns {string[]} 错误
 */
export function validateValue(schema, value, path, errors = []) {
  if (Object.prototype.hasOwnProperty.call(schema, 'oneOf')) {
    const matches = schema.oneOf.filter((branch) => validateValue(branch, value, path, []).length === 0)
    if (matches.length !== 1) errors.push(`${path} 需要恰好匹配 1 个 oneOf 分支（实际 ${matches.length}）`)
    return errors
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
    errors.push(`${path} 必须等于 ${JSON.stringify(schema.const)}`)
    return errors
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
    errors.push(`${path} 不在 enum 内`)
    return errors
  }
  switch (schema.type) {
    case 'null':
      if (value !== null) errors.push(`${path} 必须是 null`)
      return errors
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} 必须是字符串`)
      return errors
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} 必须是布尔`)
      return errors
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path} 必须是数字`)
      else if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} 必须是整数`)
      return errors
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path} 必须是数组`)
        return errors
      }
      if (schema.items !== undefined) value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`, errors))
      return errors
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path} 必须是对象`)
        return errors
      }
      const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
      for (const key of Array.isArray(schema.required) ? schema.required : []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} 缺失`)
      }
      for (const [key, item] of Object.entries(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) validateValue(properties[key], item, `${path}.${key}`, errors)
        else if (schema.additionalProperties === false) errors.push(`${path}.${key} 不在 schema 内`)
      }
      return errors
    }
    default:
      errors.push(`${path} 未知类型 ${schema.type}`)
      return errors
  }
}

/**
 * 临时状态文件目录的父目录（用于断言备份文件）。
 *
 * @param {string} statePath 状态文件路径
 * @returns {string} 目录
 */
export function stateFileDir(statePath) {
  return dirname(statePath)
}
