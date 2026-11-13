/**
 * 「今天吃什么」v2 host 半 —— Cordis 插件入口。
 *
 * 职责：
 * 1. 注册 7 个工具（`ctx.tools.register`，raw definition）；
 * 2. 注册 8 条 HTTP API（`ctx.webServer.register`，同一 path 只注册一次）；
 * 3. 若 host 提供 `commands` 服务，注册 `/food` 命令；
 * 4. 所有注册都挂 `ctx.effect`，插件卸载 / 热重载时自动清理（可重复 apply）。
 *
 * 依赖注入：`apply(ctx, { store, amap, core, now, dshHome, statePath })` 可覆盖真实实现，
 * 测试与 smoke 用假 ctx + 临时目录即可完全离线。默认实现：
 * - `createStore()`：`<DSH_HOME>/storages/dsh-today-eat/state.json`
 * - `createAmap({ getKey: store.getAmapKey })`：高德（Node 全局 fetch）
 * - `createCoreFacade()`：动态加载 `src/core/*` + `data/*`，缺失时退化到 v1 内核 / 兜底实现。
 *
 * 本文件不 import 任何官方 dsh 包（link 安装解析不到，会直接加载失败）。
 */

import { createStore, defaultTargetsFor, isPlainObject, mealFromTimestamp, normalizePhaseState, shanghaiDate } from './state.js'
import { createAmap } from './amap.js'
import { createApiRoutes } from './api.js'
import { createCommandDefinition, createTools } from './tool.js'
import { DISHES } from '../data/dishes.js'
import * as legacyRecommend from '../src/core/recommend.js'

/** 插件名（与 package.json name 一致）。 */
export const PLUGIN_NAME = 'dsh-today-eat'

/**
 * 把注册返回的 disposer 挂到当前插件 fiber 上：插件卸载 / 热重载时自动反注册，
 * 避免重复注册报 "already registered"。ctx.effect 是 Cordis 的标准 API。
 *
 * @param {object} ctx Cordis 上下文
 * @param {() => unknown} register 执行注册并返回 disposer
 * @param {string} label effect 标签
 * @returns {unknown} 注册结果
 */
function ownRegistration(ctx, register, label) {
  const disposable = register()
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => disposable, label)
  return disposable
}

/**
 * 动态加载一个可选模块（不存在时返回 null，不阻断插件加载）。
 *
 * @param {string} specifier 相对 specifier
 * @returns {Promise<object | null>} 模块命名空间
 */
async function loadOptionalModule(specifier) {
  try {
    return await import(specifier)
  } catch {
    return null
  }
}

/**
 * 加法式日期（UTC 毫秒，避免时区偏移问题）。
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {number} offsetDays 天数
 * @returns {string} 新日期
 */
function addDays(date, offsetDays) {
  const base = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(base)) return shanghaiDate(Date.now() + offsetDays * 86400000)
  return new Date(base + offsetDays * 86400000).toISOString().slice(0, 10)
}

/**
 * 从档案推导 v1 `normalizePreferences` 能吃的偏好对象。
 *
 * @param {object} profile 档案
 * @returns {object} 偏好
 */
function legacyPreferences(profile) {
  const source = isPlainObject(profile) ? profile : {}
  const dietary = isPlainObject(source.dietary) ? source.dietary : {}
  const taste = isPlainObject(source.taste) ? source.taste : {}
  const budget = isPlainObject(source.budget) ? source.budget : {}
  const spicy = Number(taste.spicy) || 0
  const maxPrice = Array.isArray(budget.perMeal) && Number.isFinite(Number(budget.perMeal[1]))
    ? Number(budget.perMeal[1])
    : undefined
  const preferences = {
    vegetarian: dietary.vegetarian === true,
    maxSpicy: spicy >= 4 ? 'hot' : spicy >= 2 ? 'medium' : 'mild',
    avoidTags: Array.isArray(dietary.avoidTags) ? dietary.avoidTags : [],
  }
  if (maxPrice !== undefined) preferences.maxPrice = maxPrice
  return preferences
}

/**
 * 本地兜底推荐（新内核缺失时用 v1 `getDailyPick` / `reroll`）。
 *
 * @param {object} args 推荐参数
 * @returns {object} 推荐结果
 */
function legacyRecommendation(args) {
  const request = isPlainObject(args) ? args : {}
  const base = {
    date: request.date,
    meal: request.meal,
    preferences: legacyPreferences(request.profile),
    history: Array.isArray(request.history) ? request.history : [],
  }
  let result
  if (Array.isArray(request.excludeIds) && request.excludeIds.length > 0 && typeof legacyRecommend.reroll === 'function') {
    result = legacyRecommend.reroll({ ...base, previousIds: request.excludeIds })
  } else if (typeof legacyRecommend.getDailyPick === 'function') {
    result = legacyRecommend.getDailyPick(base)
  } else {
    result = {}
  }
  return {
    ...result,
    phaseKind: request.phaseKind,
    mode: request.mode,
    nutrition: result && result.dish && isPlainObject(result.dish.nutrition) ? result.dish.nutrition : undefined,
  }
}

/**
 * 本地兜底统计（新内核缺失时用）。
 *
 * @param {object} args `{ meals, phase, profile, today }`
 * @returns {object} 统计摘要
 */
function legacySummary(args) {
  const request = isPlainObject(args) ? args : {}
  const meals = Array.isArray(request.meals) ? request.meals.filter(isPlainObject) : []
  const phase = isPlainObject(request.phase) ? request.phase : {}
  const targets = isPlainObject(phase.targets) ? phase.targets : {}
  const dates = [...new Set(meals.map((meal) => meal.date).filter((date) => typeof date === 'string'))].sort()
  const dishIds = meals.map((meal) => meal.dishId).filter((id) => typeof id === 'string' && id !== '')
  const unique = new Set(dishIds)
  const totalKcal = meals.reduce((sum, meal) => sum + (Number(meal.kcal) || 0), 0)
  const totalProtein = meals.reduce((sum, meal) => sum + (Number(meal.proteinG) || 0), 0)
  const loggedDays = dates.length
  let streak = 0
  const today = typeof request.today === 'string' ? request.today : shanghaiDate()
  if (dates.length > 0) {
    const set = new Set(dates)
    let cursor = Date.parse(`${today}T00:00:00Z`)
    while (set.has(new Date(cursor).toISOString().slice(0, 10))) {
      streak += 1
      cursor -= 86400000
    }
  }
  const avgKcal = loggedDays > 0 ? Math.round(totalKcal / loggedDays) : 0
  const kcalMin = Number(targets.kcalMin) || 0
  const kcalMax = Number(targets.kcalMax) || 0
  return {
    streak,
    loggedDays,
    repeatRate: dishIds.length > 0 ? Math.max(0, 1 - unique.size / dishIds.length) : 0,
    avgKcal,
    avgProtein: loggedDays > 0 ? Math.round(totalProtein / loggedDays) : 0,
    adherence: kcalMin > 0 && kcalMax > 0 && avgKcal >= kcalMin && avgKcal <= kcalMax ? 1 : 0,
    freeMealsUsed: 0,
    topCuisines: [],
  }
}

/**
 * 在菜谱数组里找一道菜的菜谱。
 *
 * @param {Array} recipes 菜谱
 * @param {string} dishId 菜品 id
 * @returns {object | null} 菜谱
 */
function findRecipe(recipes, dishId) {
  if (!Array.isArray(recipes) || typeof dishId !== 'string' || dishId === '') return null
  const found = recipes.find((recipe) => isPlainObject(recipe) && (recipe.dishId === dishId || recipe.id === dishId))
  return isPlainObject(found) ? found : null
}

/**
 * 本地兜底采买清单：按 picks 对应菜谱的食材聚合。
 *
 * @param {object} args 参数
 * @param {Array} recipes 菜谱
 * @returns {object} 采买清单
 */
function legacyShopping(args, recipes) {
  const request = isPlainObject(args) ? args : {}
  const plan = isPlainObject(request.plan) ? request.plan : {}
  const picks = Array.isArray(plan.picks) ? plan.picks.filter(isPlainObject) : []
  const days = Number.isFinite(Number(request.days)) && Number(request.days) > 0 ? Number(request.days) : 3
  const start = typeof plan.start === 'string' && plan.start !== '' ? plan.start : shanghaiDate()
  const byGroup = new Map()
  const missing = []
  for (const pick of picks.slice(0, days * 3)) {
    const recipe = findRecipe(recipes, typeof pick.dishId === 'string' ? pick.dishId : '')
    if (recipe === null) {
      if (typeof pick.dishId === 'string' && pick.dishId !== '') missing.push(pick.dishId)
      continue
    }
    for (const ingredient of Array.isArray(recipe.ingredients) ? recipe.ingredients : []) {
      if (!isPlainObject(ingredient) || typeof ingredient.name !== 'string') continue
      const group = typeof ingredient.group === 'string' && ingredient.group !== '' ? ingredient.group : '其他'
      if (!byGroup.has(group)) byGroup.set(group, new Map())
      const unit = typeof ingredient.unit === 'string' ? ingredient.unit : '份'
      const key = `${ingredient.name}|${unit}`
      const amount = Number.isFinite(Number(ingredient.amount)) ? Number(ingredient.amount) : 1
      const entry = byGroup.get(group).get(key) || { name: ingredient.name, amount: 0, unit }
      entry.amount += amount
      byGroup.get(group).set(key, entry)
    }
  }
  return {
    window: { from: start, to: addDays(start, Math.max(0, days - 1)) },
    groups: [...byGroup.entries()].map(([group, items]) => ({ group, items: [...items.values()] })),
    estimatedCost: 0,
    missingRecipes: [...new Set(missing)],
  }
}

/**
 * 兜底 `mealTimeState`（新内核缺失时用）。
 *
 * @param {Date | number} nowValue 当前时间
 * @param {object} settings 设置
 * @param {Array} meals 今天的用餐记录
 * @returns {object} 餐点状态
 */
function legacyMealTimeState(nowValue, settings, meals) {
  const date = nowValue instanceof Date ? nowValue : new Date(nowValue === undefined ? Date.now() : nowValue)
  const ms = Number.isNaN(date.getTime()) ? Date.now() : date.getTime()
  const meal = mealFromTimestamp(ms)
  const hours = new Date(ms + 8 * 3600 * 1000).getUTCHours()
  const minutes = new Date(ms + 8 * 3600 * 1000).getUTCMinutes()
  const nowMin = hours * 60 + minutes
  const source = isPlainObject(settings) ? settings : {}
  const times = isPlainObject(source.mealTimes) ? source.mealTimes : {}
  const window = Array.isArray(times[meal]) ? times[meal] : []
  const parse = (text) => {
    const match = /^(\d{2}):(\d{2})$/.exec(typeof text === 'string' ? text : '')
    if (!match) return null
    return Number(match[1]) * 60 + Number(match[2])
  }
  const start = parse(window[0])
  const end = parse(window[1])
  const logged = (Array.isArray(meals) ? meals : []).some((item) => isPlainObject(item) && item.meal === meal)
  let phase = 'closed'
  if (start !== null && end !== null && nowMin >= start && nowMin <= end) phase = 'in'
  else if (start !== null && nowMin < start) phase = 'before'
  else phase = 'after'
  const planned = Array.isArray(source.plannedMeals) ? source.plannedMeals : ['lunch', 'dinner']
  return {
    meal,
    phase,
    nextMeal: planned.find((item) => item !== meal) || null,
    nextAt: null,
    shouldNotify: phase === 'in' && !logged,
  }
}

/**
 * 创建推荐内核门面：优先新内核（`src/core/phase|taste|scoring|recommend|shopping|mealTime`），
 * 缺失时回退到 v1 `src/core/recommend.js` 或本地兜底，保证升级期间工具不崩。
 *
 * @param {{ now?: () => number }} [options] 注入项
 * @returns {object} 内核门面
 */
export function createCoreFacade(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  let modulesPromise = null
  let recipesPromise = null

  /**
   * 惰性加载内核模块（缓存一次）。
   *
   * @returns {Promise<object>} `{ phase, taste, scoring, recommend, shopping, mealTime }`
   */
  function modules() {
    if (modulesPromise === null) {
      modulesPromise = (async () => {
        const [phase, taste, scoring, recommend, shopping, mealTime] = await Promise.all([
          loadOptionalModule('../src/core/phase.js'),
          loadOptionalModule('../src/core/taste.js'),
          loadOptionalModule('../src/core/scoring.js'),
          loadOptionalModule('../src/core/recommend.js'),
          loadOptionalModule('../src/core/shopping.js'),
          loadOptionalModule('../src/core/mealTime.js'),
        ])
        return { phase, taste, scoring, recommend, shopping, mealTime }
      })()
    }
    return modulesPromise
  }

  /**
   * 惰性加载菜谱数据（缺失时返回空数组）。
   *
   * @returns {Promise<Array>} 菜谱
   */
  function recipes() {
    if (recipesPromise === null) {
      recipesPromise = (async () => {
        const module = await loadOptionalModule('../data/recipes.js')
        if (module === null) return []
        if (Array.isArray(module.RECIPES)) return module.RECIPES
        if (Array.isArray(module.recipes)) return module.recipes
        if (Array.isArray(module.default)) return module.default
        return []
      })()
    }
    return recipesPromise
  }

  return {
    /** 菜品库（供工具补菜名/营养）。 */
    catalog: DISHES,

    /**
     * 按 id 找菜（同步，便于工具内部拼名称）。
     *
     * @param {string} dishId 菜品 id
     * @returns {object | null} 菜品
     */
    findDish(dishId) {
      if (typeof dishId !== 'string' || dishId === '') return null
      const found = DISHES.find((dish) => isPlainObject(dish) && dish.id === dishId)
      return isPlainObject(found) ? found : null
    },

    /**
     * 归一化阶段（新内核优先，其次 state 层实现）。
     *
     * @param {unknown} input 输入
     * @returns {Promise<object>} 阶段
     */
    async normalizePhase(input) {
      const mods = await modules()
      if (mods.phase && typeof mods.phase.normalizePhase === 'function') return mods.phase.normalizePhase(input)
      return normalizePhaseState(input)
    },

    /**
     * 阶段营养目标（支持 `(phase, profile)` 与 `({ phase, profile })` 两种调用）。
     *
     * @param {object} phaseOrArgs 阶段或 `{phase, profile}`
     * @param {object} [profileArg] 档案
     * @returns {Promise<object>} 目标
     */
    async phaseTargets(phaseOrArgs, profileArg) {
      const wrapped = isPlainObject(phaseOrArgs) && isPlainObject(phaseOrArgs.phase)
      const phase = wrapped ? phaseOrArgs.phase : phaseOrArgs
      const profile = profileArg !== undefined
        ? profileArg
        : wrapped && isPlainObject(phaseOrArgs.profile) ? phaseOrArgs.profile : undefined
      const mods = await modules()
      if (mods.phase && typeof mods.phase.phaseTargets === 'function') return mods.phase.phaseTargets(phase, profile)
      const source = isPlainObject(phase) ? phase : {}
      return defaultTargetsFor(source.kind, source.subgoal)
    },

    /**
     * 推荐一餐（新内核优先，其次 v1 内核）。
     *
     * @param {object} args 参数
     * @returns {Promise<object>} 推荐
     */
    async recommendMeal(args = {}) {
      const mods = await modules()
      const request = { ...(isPlainObject(args) ? args : {}), catalog: DISHES }
      if (mods.recommend && typeof mods.recommend.recommendMeal === 'function') return mods.recommend.recommendMeal(request)
      return legacyRecommendation(request)
    },

    /**
     * 生成周计划（新内核优先，缺失时逐餐推荐兜底）。
     *
     * @param {object} args 参数
     * @returns {Promise<object>} 周计划
     */
    async planWeek(args = {}) {
      const mods = await modules()
      const request = { ...(isPlainObject(args) ? args : {}), catalog: DISHES }
      if (mods.recommend && typeof mods.recommend.planWeek === 'function') return mods.recommend.planWeek(request)
      const start = typeof request.startDate === 'string' ? request.startDate : shanghaiDate(now())
      const dayCount = Number.isFinite(Number(request.days)) ? Math.max(1, Math.round(Number(request.days))) : 7
      const mealList = Array.isArray(request.meals) && request.meals.length > 0 ? request.meals : ['lunch', 'dinner']
      const history = Array.isArray(request.history) ? [...request.history] : []
      const days = []
      let kcal = 0
      let protein = 0
      let cost = 0
      let count = 0
      const usedDishes = new Set()
      const cuisines = new Set()
      for (let offset = 0; offset < dayCount; offset += 1) {
        const date = addDays(start, offset)
        const meals = []
        for (const meal of mealList) {
          const result = await this.recommendMeal({
            date,
            meal,
            profile: request.profile,
            phase: request.phase,
            phaseKind: request.phaseKind,
            history,
            mode: undefined,
          })
          const dish = isPlainObject(result) && isPlainObject(result.dish) ? result.dish : null
          meals.push({ meal, dish, mode: 'home' })
          if (dish !== null) {
            history.push({ dishId: dish.id, date, meal })
            usedDishes.add(dish.id)
            if (typeof dish.cuisine === 'string') cuisines.add(dish.cuisine)
            const nutrition = isPlainObject(dish.nutrition) ? dish.nutrition : {}
            kcal += Number(nutrition.kcal) || 0
            protein += Number(nutrition.protein) || 0
            cost += Number(dish.price) || 0
            count += 1
          }
        }
        days.push({ date, meals })
      }
      return {
        start,
        seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : 0,
        days,
        summary: {
          avgKcal: count > 0 ? Math.round(kcal / dayCount) : 0,
          avgProtein: count > 0 ? Math.round(protein / dayCount) : 0,
          uniqueDishes: usedDishes.size,
          cuisines: [...cuisines],
          estimatedCost: Math.round(cost),
          freeMeals: 0,
        },
      }
    },

    /**
     * 用餐统计（新内核优先，缺失时本地兜底）。
     *
     * @param {object} args 参数
     * @returns {Promise<object>} 统计
     */
    async summarizeMeals(args = {}) {
      const mods = await modules()
      const request = { ...(isPlainObject(args) ? args : {}), catalog: DISHES }
      if (mods.recommend && typeof mods.recommend.summarizeMeals === 'function') return mods.recommend.summarizeMeals(request)
      return legacySummary(request)
    },

    /**
     * 按计划生成采买清单（新内核优先，缺失时按菜谱聚合兜底）。
     *
     * @param {object} args 参数
     * @returns {Promise<object>} 采买清单
     */
    async buildShoppingList(args = {}) {
      const mods = await modules()
      const recipeList = await recipes()
      if (mods.shopping && typeof mods.shopping.buildShoppingList === 'function') {
        // catalog 必传：state.plan.picks 只有 dishId，内核靠菜品价格算 estimatedCost
        return mods.shopping.buildShoppingList({
          ...(isPlainObject(args) ? args : {}),
          recipes: recipeList,
          catalog: DISHES,
        })
      }
      return legacyShopping(args, recipeList)
    },

    /**
     * 按菜品 id 找菜谱。
     *
     * @param {string} dishId 菜品 id
     * @returns {Promise<object | null>} 菜谱
     */
    async recipeForDish(dishId) {
      const mods = await modules()
      const recipeList = await recipes()
      if (mods.shopping && typeof mods.shopping.recipeForDish === 'function') {
        return mods.shopping.recipeForDish(recipeList, dishId)
      }
      return findRecipe(recipeList, dishId)
    },

    /**
     * 餐点时间状态（新内核优先，缺失时本地兜底）。
     *
     * @param {Date | number} nowValue 当前时间
     * @param {object} settings 设置
     * @param {Array} meals 今天的用餐记录
     * @returns {Promise<object>} 餐点状态
     */
    async mealTimeState(nowValue, settings, meals) {
      const mods = await modules()
      if (mods.mealTime && typeof mods.mealTime.mealTimeState === 'function') {
        return mods.mealTime.mealTimeState(nowValue, settings, meals)
      }
      return legacyMealTimeState(nowValue, settings, meals)
    },
  }
}

/**
 * 组装默认真实依赖（store / amap / core）。
 *
 * @param {{
 *   store?: object, amap?: object, core?: object, now?: () => number,
 *   dshHome?: string, statePath?: string, fetchImpl?: typeof fetch,
 * }} [options] 注入项（测试可覆盖）
 * @returns {{ store: object, amap: object, core: object, now?: () => number }} 依赖
 */
export function createDefaultDependencies(options = {}) {
  const source = isPlainObject(options) ? options : {}
  const now = typeof source.now === 'function' ? source.now : undefined
  const storeOptions = {}
  if (typeof source.dshHome === 'string') storeOptions.dshHome = source.dshHome
  if (typeof source.statePath === 'string') storeOptions.statePath = source.statePath
  if (now !== undefined) storeOptions.now = now
  const store = source.store || createStore(storeOptions)
  const amap = source.amap || createAmap({
    getKey: () => store.getAmapKey(),
    ...(now === undefined ? {} : { now }),
    ...(typeof source.fetchImpl === 'function' ? { fetchImpl: source.fetchImpl } : {}),
  })
  const core = source.core || createCoreFacade({ ...(now === undefined ? {} : { now }) })
  return { store, amap, core, ...(now === undefined ? {} : { now }) }
}

/** 插件定义。 */
export default {
  name: PLUGIN_NAME,
  inject: ['tools', 'webServer'],
  apply(ctx, options = {}) {
    let deps
    try {
      deps = createDefaultDependencies(options && typeof options === 'object' ? options : {})
    } catch (error) {
      try {
        if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn(`[dsh-today-eat] 初始化失败：${error && error.message ? error.message : String(error)}`)
        }
      } catch {
        // 忽略日志失败
      }
      return
    }

    // 1) 注册 7 个工具（ctx.tools 由 inject 保证存在；缺失时静默跳过）。
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      for (const tool of createTools(deps)) {
        ownRegistration(ctx, () => ctx.tools.register(tool), `dsh-today-eat: ${tool.name} tool`)
      }
    }

    // 2) 注册 HTTP 路由：同一 path 只注册一次（handler 内部按 method 分发）。
    if (ctx && ctx.webServer && typeof ctx.webServer.register === 'function') {
      const registered = new Set()
      for (const route of createApiRoutes(deps)) {
        if (registered.has(route.path)) continue
        registered.add(route.path)
        ownRegistration(
          ctx,
          () => ctx.webServer.register({ kind: route.kind || 'exact', path: route.path, handler: route.handler }),
          `dsh-today-eat: ${route.path}`,
        )
      }
    }

    // 3) `/food` 命令：commands 服务可能未启用，用 ctx.inject 防御式注册。
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (scope) => {
        if (!scope || !scope.commands || typeof scope.commands.register !== 'function') return
        ownRegistration(
          scope,
          () => scope.commands.register(createCommandDefinition(deps)),
          'dsh-today-eat: /food command',
        )
      })
    }
  },
}
