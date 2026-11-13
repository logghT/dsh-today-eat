#!/usr/bin/env node
/**
 * 「今天吃什么」v2 host 半离线烟测（不需要 DSH 运行时、不访问网络）。
 *
 * 覆盖：
 * 1. 关键文件存在、host 半零外部 import（`@deepseek-ai` 静态扫描）；
 * 2. lib/state.js：roundtrip / rev / patch 白名单 / meals upsert+delete / plan / amapKey 掩码 / 损坏备份 / 原子写；
 * 3. lib/amap.js：无 Key 结构化返回、POI 过滤、天气解析、10 分钟缓存、8s 超时（注入短超时）；
 * 4. lib/api.js：8 条方法级路由、同源/回环/JSON 校验、rev 409、nearby 无 Key、shopping；
 * 5. lib/tool.js：7 个工具定义（raw JSON Schema 子集）与 execute/render 全覆盖；
 * 6. lib/index.js：假 ctx 注册 7 工具 + 6 条路径（8 方法）+ /food 命令、effect dispose 后热重载可重复 apply。
 *
 * 用法：node scripts/smoke-host.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXED_TS = Date.parse('2026-11-09T12:00:00+08:00')
const FIXED_NOW = () => FIXED_TS

/** 测试结果收集。 */
const results = []
let failures = 0
const tempDirs = []

/**
 * 执行一个断言用例。
 *
 * @param {string} name 用例名
 * @param {() => void | Promise<void>} run 用例体
 * @returns {Promise<void>}
 */
async function test(name, run) {
  try {
    await run()
    results.push(`  ✔ ${name}`)
  } catch (error) {
    failures += 1
    results.push(`  ✖ ${name}`)
    results.push(`      ${error && error.message ? error.message.split('\n')[0] : String(error)}`)
  }
}

/**
 * 读取包内文件。
 *
 * @param {string} relativePath 相对包根路径
 * @returns {string} 文件内容
 */
function readText(relativePath) {
  return readFileSync(resolve(packageRoot, relativePath), 'utf8')
}

/**
 * 动态 import 包内文件。
 *
 * @param {string} relativePath 相对包根路径
 * @returns {Promise<object>} 模块命名空间
 */
function importLocal(relativePath) {
  return import(pathToFileURL(resolve(packageRoot, relativePath)).href)
}

/**
 * 新建临时目录（注册到清理列表）。
 *
 * @returns {string} 目录
 */
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-today-eat-smoke-'))
  tempDirs.push(dir)
  return dir
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
function assertSupportedSchema(node, path) {
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
    assert.ok(!Object.prototype.hasOwnProperty.call(node, 'const'), `${path} 不能同时有 enum 与 const`)
  }
  if (Object.prototype.hasOwnProperty.call(node, 'const')) {
    assert.ok(typeof node.const === 'string' || typeof node.const === 'number' || typeof node.const === 'boolean', `${path}.const 只能是标量`)
  }
}

/**
 * 校验 JSON 值是否符合 schema 子集（与 dsh-tools 的 validateJsonSchemaValue 语义一致）。
 *
 * @param {object} schema schema
 * @param {unknown} value 值
 * @param {string} path 诊断路径
 * @param {string[]} errors 错误收集
 * @returns {string[]} 错误
 */
function validateValue(schema, value, path, errors = []) {
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
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path} 必须是${schema.type === 'integer' ? '整数' : '数字'}`)
      else if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} 必须是整数`)
      return errors
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path} 必须是数组`)
        return errors
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`, errors))
      }
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

// ── 测试用 stub 依赖 ─────────────────────────────────────

/**
 * 固定菜品库（不依赖 data/ 的具体菜名，避免与 menu-data 冲突）。
 *
 * @returns {Array} 菜品
 */
function stubDishes() {
  return [
    { id: 'stub-sour-fish', name: '酸汤鱼片', emoji: '🐟', cuisine: '云南', price: 32, tags: ['medium', 'meat'], description: '酸香开胃', nutrition: { kcal: 380, protein: 32, fat: 10, carbs: 30, veg: 2 } },
    { id: 'stub-lemon-chicken', name: '柠檬鸡胸沙拉', emoji: '🥗', cuisine: '云南', price: 28, tags: ['mild', 'meat'], description: '果酸高蛋白', nutrition: { kcal: 420, protein: 38, fat: 12, carbs: 40, veg: 2 } },
    { id: 'stub-tomato-noodle', name: '番茄鸡蛋面', emoji: '🍜', cuisine: '北方', price: 18, tags: ['mild', 'veg'], description: '家常热汤面', nutrition: { kcal: 520, protein: 18, fat: 14, carbs: 80, veg: 1 } },
  ]
}

/**
 * stub 推荐内核（覆盖 7 个工具需要的全部方法）。
 *
 * @returns {object} 内核
 */
function createStubCore() {
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
        days.push({
          date,
          meals: mealList.map((meal, index) => ({ meal, dish: dishes[(offset + index) % dishes.length], mode: 'home' })),
        })
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
        return { id, label: labels[id], value: Math.round(Math.min(5, Math.max(0, raw)) * 10) / 10, liked, disliked }
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
function createStubAmap() {
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
 * 创建带临时状态文件的状态仓库。
 *
 * @param {string} [label] 用例标签
 * @returns {object} store
 */
function makeStatePath(label = 'case') {
  return join(makeTempDir(), label, 'storages', 'dsh-today-eat', 'state.json')
}

/**
 * 构造 API 调用参数。
 *
 * @param {object} overrides 覆盖项
 * @returns {object} 请求
 */
function apiRequest(overrides = {}) {
  return {
    method: 'GET',
    path: '/dsh-today-eat/api/state',
    headers: { host: '127.0.0.1:49396', origin: 'http://127.0.0.1:49396', 'content-type': 'application/json' },
    rawBody: '',
    ...overrides,
  }
}

// ── 开始：文件与静态扫描 ─────────────────────────────────

const HOST_FILES = ['lib/index.js', 'lib/state.js', 'lib/api.js', 'lib/amap.js', 'lib/tool.js']

await test('关键文件都存在', () => {
  for (const file of [...HOST_FILES, 'scripts/smoke-host.mjs', 'package.json', 'cordis.patch.yml']) {
    assert.ok(existsSync(resolve(packageRoot, file)), `缺少文件：${file}`)
  }
})

await test('host 半零外部 import（无 @deepseek-ai、只允许相对/node: 内置）', () => {
  for (const file of HOST_FILES) {
    const source = readText(file)
    assert.doesNotMatch(source, /@deepseek-ai/, `${file} 出现了 @deepseek-ai`)
    const specifiers = []
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1])
    for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1])
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('.') || specifier.startsWith('node:'),
        `${file} 存在非相对 import：${specifier}`,
      )
    }
  }
})

// ── 动态加载模块 ─────────────────────────────────────────

const stateModule = await importLocal('lib/state.js')
const amapModule = await importLocal('lib/amap.js')
const apiModule = await importLocal('lib/api.js')
const toolModule = await importLocal('lib/tool.js')
const pluginModule = await importLocal('lib/index.js')
const plugin = pluginModule.default

// ── 1. 状态仓库 ─────────────────────────────────────────

await test('state：默认状态与文件路径（<DSH_HOME>/storages/dsh-today-eat/state.json）', () => {
  const store = stateModule.createStore({ dshHome: join(makeTempDir(), 'home'), now: FIXED_NOW })
  const state = store.getState()
  assert.equal(state.version, 3)
  assert.equal(state.rev, 1)
  assert.match(store.statePath, /storages[\\/]dsh-today-eat[\\/]state\.json$/)
  assert.equal(state.settings.amapKey, '')
  assert.equal(store.hasAmapKey(), false)
  assert.equal(state.profile.identity.city, '')
  assert.deepEqual(state.phase.kind, 'performance')
  assert.deepEqual(
    stateModule.TASTE_DIMENSIONS.map((id) => state.profile.taste[id]),
    [3, 3, 3, 3, 3, 3],
    '默认六维味道偏好（中性 3）',
  )
})

await test('state：旧味道字段迁移为六维（sour=max，旧字段保留）', () => {
  const statePath = makeStatePath('taste-migrate')
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify({
    version: 3,
    rev: 3,
    profile: { taste: { spicy: 4, sourFruit: 5, sourFermented: 2, sourVinegar: 1, sweet: 2, oiliness: 2, adventurous: 4 } },
  }), 'utf8')
  const store = stateModule.createStore({ statePath, now: FIXED_NOW })
  const taste = store.getState().profile.taste
  assert.equal(taste.sour, 5, 'sour = max(旧酸字段)')
  assert.equal(taste.spicy, 4)
  assert.equal(taste.bitter, 1)
  assert.equal(taste.umami, 3)
  assert.equal(taste.sourFruit, 5, '旧字段保留')
  assert.deepEqual(stateModule.TASTE_DIMENSIONS.filter((id) => !(id in taste)), [])
})

await test('state：rev 自增 / patch 深合并 / 409 语义 / patch 白名单', () => {
  const store = stateModule.createStore({ statePath: makeStatePath('rev'), now: FIXED_NOW })
  const rev1 = store.getState().rev
  const patched = store.patch(rev1, {
    profile: { taste: { sour: 5, umami: 4 }, budget: { perMeal: [20, 50] } },
    ui: { collapsed: true },
    settings: { plannedMeals: ['lunch'] },
  })
  assert.equal(patched.ok, true)
  assert.equal(patched.rev, rev1 + 1)
  assert.equal(patched.state.profile.taste.sour, 5)
  assert.equal(patched.state.profile.taste.umami, 4)
  assert.equal(patched.state.profile.taste.spicy, 3, '未 patch 维度保持默认')
  assert.equal(patched.state.profile.identity.city, '')
  assert.deepEqual(patched.state.profile.budget.perMeal, [20, 50])
  assert.equal(patched.state.ui.collapsed, true)
  const stale = store.patch(rev1, { ui: { collapsed: false } })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'rev-mismatch')
  assert.equal(stale.state.rev, rev1 + 1)
  const forbidden = store.patch(store.getRev(), { meals: [] })
  assert.equal(forbidden.ok, false)
  assert.equal(forbidden.code, 'patch-not-allowed')
  const notObject = store.patch(store.getRev(), { ui: 'x' })
  assert.equal(notObject.ok, false)
  assert.equal(notObject.code, 'invalid-patch')
})

await test('state：原子写（不残留 .tmp、磁盘 rev 与内存一致）', () => {
  const store = stateModule.createStore({ statePath: makeStatePath('atomic'), now: FIXED_NOW })
  store.patch(store.getRev(), { ui: { panelTab: 'week' } })
  const dir = dirname(store.statePath)
  assert.ok(existsSync(store.statePath), '状态文件应存在')
  assert.ok(!readdirSync(dir).includes('state.json.tmp'), '不得残留 state.json.tmp')
  const onDisk = JSON.parse(readFileSync(store.statePath, 'utf8'))
  assert.equal(onDisk.rev, store.getRev())
  assert.equal(onDisk.ui.panelTab, 'week')
})

await test('state：meals upsert（同 date+meal 替换）/ delete', () => {
  const store = stateModule.createStore({ statePath: makeStatePath('meals'), now: FIXED_NOW })
  const first = store.upsertMeal(store.getRev(), { meal: 'lunch', dishId: 'stub-sour-fish', dishName: '酸汤鱼片', rating: 1, kcal: 380, proteinG: 32 })
  assert.equal(first.ok, true)
  assert.equal(first.state.meals.length, 1)
  const second = store.upsertMeal(store.getRev(), { meal: 'lunch', dishName: '换一道', rating: -1 })
  assert.equal(second.state.meals.length, 1, '同 date+meal 应替换旧记录')
  assert.equal(second.state.meals[0].dishName, '换一道')
  const id = second.state.meals[0].id
  const deleted = store.deleteMeal(id)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.state.meals.length, 0)
  const missing = store.deleteMeal(id)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'meal-not-found')
})

await test('state：plan 写入 / amapKey 掩码（getState 抹空、hasAmapKey 正确）', () => {
  const store = stateModule.createStore({ statePath: makeStatePath('plan'), now: FIXED_NOW })
  const plan = { start: '2026-11-09', seed: 7, generatedAt: FIXED_TS, locked: {}, picks: [{ date: '2026-11-09', meal: 'lunch', dishId: 'stub-sour-fish', mode: 'home' }] }
  const saved = store.setPlan(store.getRev(), plan)
  assert.equal(saved.ok, true)
  assert.equal(saved.state.plan.picks.length, 1)
  const key = store.setAmapKey('test-amap-key')
  assert.equal(key.ok, true)
  assert.equal(key.hasAmapKey, true)
  assert.equal(store.getState().settings.amapKey, '', 'getState 必须抹掉 amapKey')
  assert.equal(store.getAmapKey(), 'test-amap-key')
  assert.equal(store.hasAmapKey(), true)
  store.setAmapKey('')
  assert.equal(store.hasAmapKey(), false)
})

await test('state：损坏文件备份为 state.json.bad-<ts> 并回退默认状态', () => {
  const statePath = makeStatePath('corrupt')
  const store = stateModule.createStore({ statePath, now: FIXED_NOW })
  store.patch(store.getRev(), { ui: { collapsed: true } })
  writeFileSync(statePath, '{ this is not json', 'utf8')
  const recovered = stateModule.createStore({ statePath, now: FIXED_NOW })
  const state = recovered.getState()
  assert.equal(state.rev, 1)
  assert.equal(state.ui.collapsed, false)
  const backups = readdirSync(dirname(statePath)).filter((name) => name.startsWith('state.json.bad-'))
  assert.ok(backups.length >= 1, '应备份损坏文件')
})

// ── 2. 高德封装 ─────────────────────────────────────────

await test('amap：无 Key 返回 amap-key-missing + fallbackQueries（不发请求）', async () => {
  let fetched = 0
  const amap = amapModule.createAmap({ fetchImpl: async () => { fetched += 1; throw new Error('不应该被调用') }, now: FIXED_NOW })
  const nearby = await amap.searchNearby({ lng: 103.03, lat: 29.98 })
  assert.equal(nearby.ok, false)
  assert.equal(nearby.code, 'amap-key-missing')
  assert.ok(Array.isArray(nearby.fallbackQueries) && nearby.fallbackQueries.length > 0)
  const weather = await amap.weather({ adcode: '511802' })
  assert.equal(weather.ok, false)
  assert.equal(weather.code, 'amap-key-missing')
  assert.equal(fetched, 0)
})

await test('amap：POI 过滤（距离/评分/预算）、天气解析、10 分钟缓存', async () => {
  const calls = []
  const payload = {
    status: '1',
    pois: [
      { name: '好店', address: 'a', distance: '300', biz_ext: { rating: '4.6', cost: '30' }, type: '餐饮', location: '103,29' },
      { name: '低分', address: 'b', distance: '400', biz_ext: { rating: '3.5', cost: '20' }, type: '餐饮', location: '103,29' },
      { name: '太远', address: 'c', distance: '3000', biz_ext: { rating: '4.8', cost: '20' }, type: '餐饮', location: '103,29' },
      { name: '太贵', address: 'd', distance: '200', biz_ext: { rating: '4.4', cost: '90' }, type: '餐饮', location: '103,29' },
      { name: '未知评分', address: 'e', distance: '500', biz_ext: {}, type: '餐饮', location: '103,29' },
    ],
  }
  const weatherPayload = {
    status: '1',
    forecasts: [{ city: '成都市', casts: [{ date: '2026-11-09', dayweather: '多云', nightweather: '阴', daytemp: '20', nighttemp: '12', daywind: '东北风', daypower: '1-2' }] }],
  }
  const amap = amapModule.createAmap({
    now: FIXED_NOW,
    fetchImpl: async (url) => {
      calls.push(url)
      const payloadForUrl = url.includes('/weather/')
        ? weatherPayload
        : url.includes('/geocode/') ? { status: '1', geocodes: [{ city: '成都市', province: '四川省', district: '锦江区', adcode: '511802', location: '104.0668,30.5728', level: '城市' }] }
          : payload
      return { ok: true, status: 200, json: async () => payloadForUrl }
    },
  })
  const nearby = await amap.searchNearby({ key: 'x', lng: 103.03, lat: 29.98, radius: 1500, maxCost: 45, phase: 'fitness' })
  assert.equal(nearby.ok, true)
  const names = nearby.items.map((item) => item.name)
  assert.ok(names.includes('好店'), '应保留高分近店')
  assert.ok(!names.includes('低分'), '应过滤 rating<4.0')
  assert.ok(!names.includes('太远'), '应过滤超出半径')
  assert.ok(!names.includes('太贵'), '应过滤超预算')
  assert.ok(names.includes('未知评分'), '未知评分保留（不误杀）')
  assert.equal(nearby.items[0].rating, 4.6)
  assert.ok(nearby.items.every((item) => typeof item.suggestion === 'string' && item.suggestion !== ''), '每家店都应有点单建议')
  assert.match(nearby.items[0].suggestion, /查不到公开菜单/, '查不到菜单的小店应让顾客自行点单')
  assert.equal(nearby.suggestions.length, 1)
  assert.match(nearby.suggestions[0], /连锁品牌/)
  const weather = await amap.weather({ key: 'x', adcode: '511802' })
  assert.equal(weather.ok, true)
  assert.equal(weather.weather.dayWeather, '多云')
  assert.equal(weather.weather.nightTemp, 12)
  const geocode = await amap.geocodeCity('成都', { key: 'x' })
  assert.equal(geocode.ok, true)
  assert.equal(geocode.adcode, '511802')
  const before = calls.length
  await amap.searchNearby({ key: 'x', lng: 103.03, lat: 29.98, radius: 1500, maxCost: 45, phase: 'fitness' })
  assert.equal(calls.length, before, '10 分钟内应命中缓存')
  amap.clearCache()
  await amap.searchNearby({ key: 'x', lng: 103.03, lat: 29.98, radius: 1500, maxCost: 45, phase: 'fitness' })
  assert.equal(calls.length, before + 1, '清缓存后应重新请求')
})

await test('amap：8s 超时（注入短超时）返回 amap-timeout 而不是抛错', async () => {
  const hangingFetch = (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
  const amap = amapModule.createAmap({ fetchImpl: hangingFetch, timeoutMs: 20, now: FIXED_NOW })
  const result = await amap.searchNearby({ key: 'x', lng: 103.03, lat: 29.98 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'amap-timeout')
  assert.ok(!result.message.includes('x'), 'message 不得泄漏 Key')
})

await test('amap：关键词按 phase 生成 / suggestOrder 中文建议', () => {
  assert.deepEqual(amapModule.phaseKeywords('fitness').slice(0, 2), ['轻食', '沙拉'])
  assert.ok(amapModule.phaseKeywords('indulgence').includes('火锅'))
  const suggestions = amapModule.suggestOrder({ name: '小馆' }, 'fitness', { taste: { sourFruit: 5 } })
  assert.ok(suggestions.length >= 1 && suggestions.length <= 2)
  assert.match(suggestions[0], /小馆：/)
  assert.match(suggestions.join(''), /蒸|煮|烤/)
})

// ── 3. HTTP API ─────────────────────────────────────────

const apiDeps = {
  store: stateModule.createStore({ statePath: makeStatePath('api'), now: FIXED_NOW }),
  amap: createStubAmap(),
  core: createStubCore(),
  now: FIXED_NOW,
}

/**
 * 调一次 API。
 *
 * @param {object} overrides 覆盖项
 * @returns {Promise<{status:number, body:object}>} 响应
 */
async function callApi(overrides = {}) {
  const result = await apiModule.handleApiRequest(apiDeps, apiRequest(overrides))
  return { status: result.status, body: result.body, headers: result.headers }
}

await test('api：8 条方法级路由 / 6 个注册路径', () => {
  const routes = apiModule.createApiRoutes(apiDeps)
  assert.equal(routes.length, 8, '应有 8 条方法级路由')
  assert.equal(new Set(routes.map((route) => route.path)).size, 6, '去重后 6 个 path')
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`), [
    'GET /dsh-today-eat/api/state',
    'POST /dsh-today-eat/api/state',
    'POST /dsh-today-eat/api/meals',
    'DELETE /dsh-today-eat/api/meals',
    'POST /dsh-today-eat/api/plan',
    'POST /dsh-today-eat/api/amap-key',
    'GET /dsh-today-eat/api/nearby',
    'GET /dsh-today-eat/api/shopping',
  ])
  for (const route of routes) assert.equal(typeof route.handler, 'function')
})

await test('api：GET state → 掩码 + hasAmapKey；POST patch → rev 冲突 409', async () => {
  const got = await callApi({ method: 'GET' })
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.state.settings.amapKey, '')
  assert.equal(got.body.hasAmapKey, false)
  const rev = got.body.state.rev
  const patched = await callApi({ method: 'POST', rawBody: JSON.stringify({ rev, patch: { ui: { collapsed: true } } }) })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.rev, rev + 1)
  const conflict = await callApi({ method: 'POST', rawBody: JSON.stringify({ rev, patch: { ui: { collapsed: false } } }) })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, 'rev-mismatch')
  assert.equal(conflict.body.state.settings.amapKey, '')
  const forbidden = await callApi({ method: 'POST', rawBody: JSON.stringify({ rev: apiDeps.store.getRev(), patch: { meals: [] } }) })
  assert.equal(forbidden.status, 400)
  assert.equal(forbidden.body.code, 'patch-not-allowed')
})

await test('api：meals 新增/删除、plan 写入、amap-key 保存', async () => {
  const state = (await callApi({ method: 'GET' })).body.state
  const added = await callApi({
    method: 'POST',
    path: '/dsh-today-eat/api/meals',
    rawBody: JSON.stringify({ rev: state.rev, meal: { meal: 'lunch', dishId: 'stub-sour-fish', dishName: '酸汤鱼片', rating: 1, kcal: 380 } }),
  })
  assert.equal(added.status, 200)
  assert.equal(added.body.state.meals.length, 1)
  const listed = (await callApi({ method: 'GET' })).body.state
  const deleted = await callApi({
    method: 'DELETE',
    path: `/dsh-today-eat/api/meals?id=${encodeURIComponent(listed.meals[0].id)}`,
    rawBody: '',
    headers: { host: '127.0.0.1:49396', origin: 'http://127.0.0.1:49396' },
  })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.state.meals.length, 0)
  const planned = await callApi({
    method: 'POST',
    path: '/dsh-today-eat/api/plan',
    rawBody: JSON.stringify({ rev: (await callApi({ method: 'GET' })).body.state.rev, plan: { start: '2026-11-09', seed: 1, picks: [] } }),
  })
  assert.equal(planned.status, 200)
  const keySaved = await callApi({ method: 'POST', path: '/dsh-today-eat/api/amap-key', rawBody: JSON.stringify({ key: 'k-123' }) })
  assert.equal(keySaved.status, 200)
  assert.equal(keySaved.body.hasAmapKey, true)
  const stateAfter = (await callApi({ method: 'GET' })).body
  assert.equal(stateAfter.hasAmapKey, true)
  assert.equal(stateAfter.state.settings.amapKey, '')
  await callApi({ method: 'POST', path: '/dsh-today-eat/api/amap-key', rawBody: JSON.stringify({ key: '' }) })
})

await test('api：nearby 无 Key → amap-key-missing + fallbackQueries（HTTP 200）', async () => {
  const noKeyDeps = {
    store: stateModule.createStore({ statePath: makeStatePath('nearby'), now: FIXED_NOW }),
    amap: createStubAmap(),
    core: createStubCore(),
    now: FIXED_NOW,
  }
  const result = await apiModule.handleApiRequest(noKeyDeps, apiRequest({ method: 'GET', path: '/dsh-today-eat/api/nearby?meal=lunch&radius=1500' }))
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'amap-key-missing')
  assert.ok(Array.isArray(result.body.fallbackQueries) && result.body.fallbackQueries.length > 0)
})

await test('api：nearby 有 Key → items + suggestions + weather', async () => {
  const withKeyDeps = {
    store: stateModule.createStore({ statePath: makeStatePath('nearby-ok'), now: FIXED_NOW }),
    amap: createStubAmap(),
    core: createStubCore(),
    now: FIXED_NOW,
  }
  withKeyDeps.store.setAmapKey('k-123')
  const result = await apiModule.handleApiRequest(withKeyDeps, apiRequest({ method: 'GET', path: '/dsh-today-eat/api/nearby?meal=lunch' }))
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.items.length, 2)
  assert.equal(result.body.suggestions.length, 1)
  assert.equal(result.body.weather.dayWeather, '多云')
})

await test('api：shopping → window/groups/estimatedCost/missingRecipes', async () => {
  const result = await callApi({ method: 'GET', path: '/dsh-today-eat/api/shopping?days=3' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.ok(result.body.window && result.body.window.from)
  assert.equal(result.body.groups[0].group, '蔬菜')
  assert.equal(result.body.estimatedCost, 18)
  assert.deepEqual(result.body.missingRecipes, [])
})

await test('api：鉴权（跨源 403 / 非回环写 403 / 非 JSON 415 / 缺 Host 403 / 405 / 404）', async () => {
  const crossOrigin = await callApi({ method: 'POST', headers: { host: '127.0.0.1:1', origin: 'http://evil.example', 'content-type': 'application/json' }, rawBody: '{}' })
  assert.equal(crossOrigin.status, 403)
  assert.equal(crossOrigin.body.code, 'cross-origin')
  const nonLoopback = await callApi({ method: 'POST', headers: { host: '192.168.1.5:1234', 'content-type': 'application/json' }, rawBody: '{}' })
  assert.equal(nonLoopback.status, 403)
  assert.equal(nonLoopback.body.code, 'non-loopback')
  const nonJson = await callApi({ method: 'POST', headers: { host: '127.0.0.1:1', 'content-type': 'text/plain' }, rawBody: '{}' })
  assert.equal(nonJson.status, 415)
  assert.equal(nonJson.body.code, 'unsupported-media-type')
  const missingHost = await callApi({ method: 'GET', headers: { origin: 'http://127.0.0.1:1' } })
  assert.equal(missingHost.status, 403)
  assert.equal(missingHost.body.code, 'missing-host')
  const badOrigin = await callApi({ method: 'GET', headers: { host: '127.0.0.1:1', origin: 'not-a-url' } })
  assert.equal(badOrigin.status, 403)
  assert.equal(badOrigin.body.code, 'invalid-origin')
  const crossSite = await callApi({ method: 'GET', headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.body.code, 'cross-site')
  const curlGet = await callApi({ method: 'GET', headers: { host: '127.0.0.1:1' } })
  assert.equal(curlGet.status, 200, '无 Origin 的 curl GET 允许')
  const methodNotAllowed = await callApi({ method: 'PUT', rawBody: JSON.stringify({}) })
  assert.equal(methodNotAllowed.status, 405)
  assert.equal(methodNotAllowed.body.code, 'method-not-allowed')
  const notFound = await callApi({ method: 'GET', path: '/dsh-today-eat/api/nope' })
  assert.equal(notFound.status, 404)
  const badJson = await callApi({ method: 'POST', rawBody: '{oops' })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.code, 'invalid-json')
})

await test('api：Node handler 适配（假 req/res，GET /state）', async () => {
  const routes = apiModule.createApiRoutes(apiDeps)
  const stateRoute = routes.find((route) => route.method === 'GET' && route.path === '/dsh-today-eat/api/state')
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); return this },
    setHeader(name, value) { this.headers[name] = value },
    end(chunk) { if (chunk !== undefined) this.body += chunk },
  }
  await stateRoute.handler({
    method: 'GET',
    url: '/dsh-today-eat/api/state',
    headers: { host: '127.0.0.1:49396', origin: 'http://127.0.0.1:49396' },
  }, res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.state.settings.amapKey, '')
  assert.match(String(res.headers['content-type']), /application\/json/)
})

// ── 4. 7 个工具 ─────────────────────────────────────────

await test('tool：7 个工具定义结构 + raw JSON Schema 子集校验', () => {
  const tools = toolModule.createTools({ store: apiDeps.store, amap: createStubAmap(), core: createStubCore(), now: FIXED_NOW })
  assert.equal(tools.length, 7)
  assert.deepEqual(tools.map((tool) => tool.name), [...toolModule.TOOL_NAMES])
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10, `${tool.name} description 过短`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.schema.type, 'object', `${tool.name} output 根必须是 object`)
    assertSupportedSchema(tool.parameters, `${tool.name}.parameters`)
    assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.required, undefined, `${tool.name} 参数应全部可选`)
  }
})

/** 7 个工具的调用参数（全部走 stub deps）。 */
const TOOL_CASES = [
  { name: 'update_profile', args: { city: '四川成都', sour: 4, sweet: 2, bitter: 1, spicy: 5, salty: 3, umami: 4, phaseKind: 'healthy', budgetPerMealMax: 50 } },
  { name: 'recommend_meal', args: { meal: 'lunch' } },
  { name: 'plan_week', args: { regenerate: true } },
  { name: 'cook_plan', args: {} },
  { name: 'find_nearby', args: {} },
  { name: 'log_meal', args: { dishId: 'stub-lemon-chicken', dishName: '柠檬鸡胸沙拉', meal: 'lunch', mode: 'home', rating: 1 } },
  { name: 'meal_stats', args: { days: 7 } },
]

await test('tool：7 个 execute 均返回符合 output.schema 的值 + 中文 render', async () => {
  const store = stateModule.createStore({ statePath: makeStatePath('tools'), now: FIXED_NOW })
  const deps = { store, amap: createStubAmap(), core: createStubCore(), now: FIXED_NOW }
  const tools = toolModule.createTools(deps)
  for (const testCase of TOOL_CASES) {
    const tool = tools.find((item) => item.name === testCase.name)
    const value = await tool.execute(testCase.args)
    const errors = validateValue(tool.output.schema, value, testCase.name)
    assert.deepEqual(errors, [], `${testCase.name} 输出不符合 schema：${errors.join('; ')}`)
    const blocks = tool.output.render(testCase.args, value)
    assert.ok(Array.isArray(blocks) && blocks.length >= 1, `${testCase.name} render 应返回 ContentBlock[]`)
    for (const block of blocks) {
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
      assert.ok(block.text.length > 0)
    }
  }
})

await test('tool：update_profile 真正写入状态；recommend_meal 排除 excludeIds', async () => {
  const store = stateModule.createStore({ statePath: makeStatePath('tool-write'), now: FIXED_NOW })
  const deps = { store, amap: createStubAmap(), core: createStubCore(), now: FIXED_NOW }
  const tools = toolModule.createTools(deps)
  const update = tools.find((tool) => tool.name === 'update_profile')
  const updated = await update.execute({ city: '云南昆明', district: '五华区', sour: 4, spicy: 5, umami: 4, phaseKind: 'relax' })
  const state = store.getState()
  assert.equal(state.profile.identity.city, '云南昆明')
  assert.equal(state.profile.identity.district, '五华区')
  assert.equal(state.profile.taste.sour, 4)
  assert.equal(state.profile.taste.spicy, 5)
  assert.equal(state.profile.taste.umami, 4)
  assert.equal(state.profile.taste.bitter, 3, '未传维度保持默认')
  assert.ok(updated.summary.includes('味道偏好：酸4 甜3 苦3 辣5 咸3 鲜4'), updated.summary)
  assert.equal(state.phase.kind, 'treat')
  assert.equal(state.phase.subgoal, 'treat')
  const recommend = tools.find((tool) => tool.name === 'recommend_meal')
  const value = await recommend.execute({ meal: 'dinner', excludeIds: ['stub-sour-fish', 'stub-lemon-chicken'] })
  assert.notEqual(value.dish, null)
  assert.equal(value.dish.id, 'stub-tomato-noodle')
})

await test('tool：六维味道（旧酸参数兼容 + meal_stats taste 输出/画像 render）', async () => {
  const store = stateModule.createStore({ statePath: makeStatePath('tool-taste'), now: FIXED_NOW })
  const deps = { store, amap: createStubAmap(), core: createStubCore(), now: FIXED_NOW }
  const tools = toolModule.createTools(deps)
  const update = tools.find((tool) => tool.name === 'update_profile')
  const legacy = await update.execute({ sourFruit: 2, sourFermented: 5, sourVinegar: 3 })
  assert.equal(store.getState().profile.taste.sour, 5, '旧酸参数取 max')
  assert.ok(legacy.summary.includes('味道偏好：酸5 甜3 苦3 辣3 咸3 鲜3'), legacy.summary)
  assert.ok(legacy.fields.includes('sour'))
  const stats = tools.find((tool) => tool.name === 'meal_stats')
  const empty = await stats.execute({})
  assert.equal(empty.taste.samples, 0)
  assert.equal(empty.taste.dimensions.length, 6)
  assert.deepEqual(empty.taste.dimensions.map((dimension) => dimension.label), ['酸', '甜', '苦', '辣', '咸', '鲜'])
  const emptyText = stats.output.render({}, empty)[0].text
  assert.match(emptyText, /口味画像：酸 \d\.\d · 甜 \d\.\d · 苦 \d\.\d · 辣 \d\.\d · 咸 \d\.\d · 鲜 \d\.\d/)
  assert.match(emptyText, /还没有记录，先显示你的偏好设置/)
  store.upsertMealInternal({ dishId: 'stub-sour-fish', meal: 'lunch', rating: 1 })
  const withMeal = await stats.execute({ days: 7 })
  assert.ok(withMeal.taste.samples >= 1)
  const errors = validateValue(stats.output.schema, withMeal, 'meal_stats')
  assert.deepEqual(errors, [])
})

await test('tool：plan_week 写入状态、cook_plan 返回菜谱+采买、log_meal 写入记录', async () => {
  const store = stateModule.createStore({ statePath: makeStatePath('tool-plan'), now: FIXED_NOW })
  const deps = { store, amap: createStubAmap(), core: createStubCore(), now: FIXED_NOW }
  const tools = toolModule.createTools(deps)
  const plan = await tools.find((tool) => tool.name === 'plan_week').execute({ regenerate: true })
  assert.equal(plan.days.length, 7)
  assert.equal(store.getFullState().plan.picks.length, 14)
  const cook = await tools.find((tool) => tool.name === 'cook_plan').execute({ dishId: 'stub-lemon-chicken' })
  assert.equal(cook.dishName, '柠檬鸡胸沙拉')
  assert.ok(cook.steps.length >= 1)
  assert.ok(cook.ingredients.length >= 2)
  assert.ok(cook.shopping.groups.length >= 1)
  const cookTool = tools.find((tool) => tool.name === 'cook_plan')
  const cookText = cookTool.output.render({}, cook).map((item) => item.text).join('\n')
  assert.ok(cookText.includes('下厨房'), 'cook_plan render 应带下厨房参考链接')
  assert.ok(cookText.includes('xiachufang.com'), '参考链接应含下厨房搜索 URL')
  const logged = await tools.find((tool) => tool.name === 'log_meal').execute({ dishName: '番茄鸡蛋面', meal: 'dinner', mode: 'out', rating: 1 })
  assert.equal(logged.logged, true)
  assert.equal(store.getFullState().meals.length, 1)
  assert.equal(logged.summary.loggedDays, 1)
})

await test('tool：find_nearby 无 Key 返回 fallbackQueries；有 Key 返回 items/weather', async () => {
  const store = stateModule.createStore({ statePath: makeStatePath('tool-nearby'), now: FIXED_NOW })
  const tools = toolModule.createTools({ store, amap: createStubAmap(), core: createStubCore(), now: FIXED_NOW })
  const tool = tools.find((item) => item.name === 'find_nearby')
  const noKey = await tool.execute({})
  assert.equal(noKey.ok, false)
  assert.equal(noKey.code, 'amap-key-missing')
  assert.ok(noKey.fallbackQueries.length > 0)
  store.setAmapKey('k-123')
  const withKey = await tool.execute({ radius: 800 })
  assert.equal(withKey.ok, true)
  assert.equal(withKey.items.length, 2)
  assert.equal(withKey.weather.dayWeather, '多云')
})

// ── 5. /food 命令 ───────────────────────────────────────

await test('/food：5 个子命令均返回 {kind:"success", text} 且 ≤200 字', async () => {
  const store = stateModule.createStore({ statePath: makeStatePath('command'), now: FIXED_NOW })
  const command = toolModule.createCommandDefinition({ store, amap: createStubAmap(), core: createStubCore(), now: FIXED_NOW })
  assert.equal(command.name, 'food')
  assert.equal(typeof command.description, 'string')
  assert.equal(typeof command.input.hint, 'string')
  for (const rawInput of ['', '附近', '周计划', '自己做', '统计']) {
    const result = await command.handler({ rawInput, agent: null, attachments: [], signal: new AbortController().signal })
    assert.equal(result.kind, 'success', `/${rawInput} 应成功`)
    assert.equal(typeof result.text, 'string')
    assert.ok(result.text.length > 0 && result.text.length <= 200, `/${rawInput} 文本长度 ${result.text.length}`)
  }
  const noKeyNearby = await command.handler({ rawInput: '附近' })
  assert.match(noKeyNearby.text, /高德|Key|配置/)
})

// ── 6. 插件入口 / 热重载 ─────────────────────────────────

/**
 * 构造假 Cordis ctx（tools/webServer/effect/inject）。
 *
 * @returns {{ ctx: object, state: object }} 假 ctx 与观测状态
 */
function createFakeCtx() {
  const observed = { tools: [], routes: new Map(), commands: [], effects: [] }
  const ctx = {
    tools: {
      register(definition) {
        if (observed.tools.some((tool) => tool.name === definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        observed.tools.push(definition)
        return () => {
          observed.tools = observed.tools.filter((tool) => tool !== definition)
        }
      },
    },
    webServer: {
      register(route) {
        if (observed.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        observed.routes.set(route.path, route)
        return () => {
          observed.routes.delete(route.path)
        }
      },
    },
    effect(callback, label) {
      const dispose = callback()
      observed.effects.push({ label, dispose })
      return dispose
    },
    inject(deps, callback) {
      if (!Array.isArray(deps) || !deps.includes('commands')) return
      callback({
        commands: {
          register(definition) {
            observed.commands.push(definition)
            return () => {
              observed.commands = observed.commands.filter((item) => item !== definition)
            }
          },
        },
        effect: ctx.effect,
      })
    },
    logger: { warn() {} },
  }
  return { ctx, observed }
}

/**
 * 释放全部 effect（模拟插件 fiber 拆卸）。
 *
 * @param {object} observed 观测状态
 * @returns {void}
 */
function disposeAll(observed) {
  for (const effect of [...observed.effects].reverse()) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
  observed.effects = []
}

await test('plugin：形状正确（name / inject: tools+webServer / apply）', () => {
  assert.equal(plugin.name, 'dsh-today-eat')
  assert.deepEqual(plugin.inject, ['tools', 'webServer'])
  assert.equal(typeof plugin.apply, 'function')
})

await test('plugin：apply 注册 7 工具 + 6 路径（8 方法）+ /food 命令', () => {
  const { ctx, observed } = createFakeCtx()
  plugin.apply(ctx, { store: stateModule.createStore({ statePath: makeStatePath('plugin'), now: FIXED_NOW }), amap: createStubAmap(), core: createStubCore(), now: FIXED_NOW })
  assert.equal(observed.tools.length, 7)
  assert.deepEqual(observed.tools.map((tool) => tool.name), [...toolModule.TOOL_NAMES])
  assert.equal(observed.routes.size, 6)
  assert.ok(observed.routes.has('/dsh-today-eat/api/state'))
  assert.ok(observed.routes.has('/dsh-today-eat/api/nearby'))
  assert.equal(observed.commands.length, 1)
  assert.equal(observed.commands[0].name, 'food')
  assert.equal(observed.effects.length, 7 + 6 + 1)
})

await test('plugin：热重载（dispose 全部 effect 后再次 apply）不重复注册、不抛错', async () => {
  const { ctx, observed } = createFakeCtx()
  const deps = { store: stateModule.createStore({ statePath: makeStatePath('hmr'), now: FIXED_NOW }), amap: createStubAmap(), core: createStubCore(), now: FIXED_NOW }
  plugin.apply(ctx, deps)
  disposeAll(observed)
  assert.equal(observed.tools.length, 0)
  assert.equal(observed.routes.size, 0)
  assert.equal(observed.commands.length, 0)
  plugin.apply(ctx, deps)
  assert.equal(observed.tools.length, 7)
  assert.equal(observed.routes.size, 6)
  assert.equal(observed.commands.length, 1)
  const command = observed.commands[0]
  const result = await command.handler({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.length > 0 && result.text.length <= 200)
})

// ── 清理与汇总 ───────────────────────────────────────────

for (const dir of tempDirs) {
  try {
    const { rmSync } = await import('node:fs')
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
}

results.forEach((line) => console.log(line))
console.log('')
const passed = results.filter((line) => line.trim().startsWith('✔')).length
if (failures === 0) {
  console.log(`✔ smoke-host 全部通过（${passed} 项）`)
} else {
  console.error(`✖ smoke-host 有 ${failures} 项失败`)
  process.exitCode = 1
}
