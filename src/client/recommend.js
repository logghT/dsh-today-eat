/**
 * 「今天吃什么」client 半 —— 推荐 / 周计划 / 统计适配层。
 *
 * 设计：
 * - 首选 src/core/recommend.js 的 v2 能力（recommendMeal / planWeek / summarizeMeals，host/client 共用）；
 * - 用「命名空间导入 + 运行时探测」拿新导出，这样 core 还在迭代时 client 也能独立构建；
 * - 旧导出（getDailyPick / reroll）是 §7 明确保留的稳定契约，作为二级兜底；
 * - 最后还有一层纯本地打分兜底，保证离线 / core 异常时横条与面板不空转。
 */

import * as core from '../../src/core/recommend.js'
import { normalizePhase, phaseTargets } from '../../src/core/phase.js'
import { DISHES } from '../../data/dishes.js'
import { normalizeUiState, filterCatalogByCuisines, normalizeRerollCuisines } from './display.js'
import { normalizeUserRecipes } from '../core/user-recipes.js'
import { mealTimeState, normalizeSettings, recommendationMeal as coreRecommendationMeal } from './mealTime.js'
import {
  TASTE_DIMENSIONS,
  TASTE_LABELS,
  dishTasteOf,
  normalizeTaste,
  tastePreferenceOf,
} from './taste.js'
import {
  MEAL_LABELS,
  addDaysKey,
  clampNumber,
  dateKeyOf,
  parseDateKey,
  phaseMeta,
  shanghaiParts,
  todayKey as currentDayKey,
} from './format.js'
import { readHistory, readPreferences, readStateCache, readUi } from './storage.js'

export { normalizePhase }

/* ────────────────────────────── 基础数据 ────────────────────────────── */

/** 菜品目录（构建期打包，离线也能用）。 */
export const CATALOG = Object.freeze(Array.isArray(DISHES) ? DISHES.filter((dish) => dish !== null && typeof dish === 'object' && typeof dish.id === 'string') : [])

/** dishId -> dish。 */
const DISH_MAP = new Map(CATALOG.map((dish) => [dish.id, dish]))

/** 旧数据无 nutrition 字段时按分类估算热量。 */
const CATEGORY_KCAL = Object.freeze({
  米饭: 620,
  面食: 540,
  汤羹: 320,
  小吃: 340,
  家常菜: 460,
  火锅烧烤: 720,
  轻食: 360,
  早餐: 380,
})

/** 辣度排序。 */
const SPICY_RANK = Object.freeze({ mild: 1, medium: 2, hot: 3 })

/** 辣度中文。 */
const SPICY_LABELS = Object.freeze({ mild: '微辣', medium: '中辣', hot: '重辣' })

/* ────────────────────────────── 默认 state ────────────────────────────── */

/**
 * 创建默认 state（与 §2 的 state.json 形状一致）。
 *
 * @returns {object} state
 */
export function createDefaultState() {
  const today = currentDayKey()
  const profile = {
    identity: { hometown: '', city: '', district: '', region: '', lat: null, lng: null, adcode: '' },
    taste: { sour: 3, sweet: 3, bitter: 3, spicy: 3, salty: 3, umami: 3, oiliness: 3, adventurous: 3 },
    dietary: { vegetarian: false, allergies: [], avoidTags: [] },
    budget: { perMeal: [20, 60], weekly: 420 },
    cook: { skill: 'basic', equipment: ['炒锅', '电饭煲'], weekdayCookMin: 20 },
  }
  const phase = normalizePhase({ kind: 'performance', subgoal: 'fat_loss', start: today, weeks: 8 })
  phase.targets = phaseTargets(phase, profile)
  return {
    version: 3,
    rev: 0,
    profile,
    phase,
    meals: [],
    plan: { start: today, seed: 7, generatedAt: 0, locked: {}, picks: [] },
    settings: normalizeSettings(null),
    ui: {
      collapsed: false,
      panelTab: 'today',
      displayMode: 'float',
      floatCollapsed: false,
      floatPos: null,
      rerollCuisines: [],
    },
    userRecipes: {},
  }
}

/**
 * 深合并「默认值 + 已有值」（仅普通对象递归）。
 *
 * @param {unknown} defaults 默认值
 * @param {unknown} value 已有值
 * @returns {unknown} 合并结果
 */
function mergeDefaults(defaults, value) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : defaults
  if (defaults !== null && typeof defaults === 'object') {
    const source = value !== null && typeof value === 'object' ? value : {}
    const result = {}
    for (const key of Object.keys(defaults)) result[key] = mergeDefaults(defaults[key], source[key])
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = source[key]
    }
    return result
  }
  return value === undefined || value === null ? defaults : value
}

/**
 * 取阶段营养目标（直接复用 core.phaseTargets，与 host 工具 / 面板展示同口径）。
 *
 * @param {unknown} phase 阶段
 * @param {object | null | undefined} profile 档案（可含体重）
 * @returns {{ kcalMin: number | null, kcalMax: number | null, proteinG: number, freeMealsPerWeek: number }} 目标
 */
export function targetsOf(phase, profile) {
  return phaseTargets(normalizePhase(phase), profile)
}

/**
 * 归一化 profile。
 *
 * @param {unknown} input profile
 * @returns {object} profile
 */
export function normalizeProfile(input) {
  const defaults = createDefaultState().profile
  const merged = mergeDefaults(defaults, input)
  const source = input !== null && typeof input === 'object' ? input : {}
  const tasteSource = source.taste !== null && typeof source.taste === 'object' ? source.taste : {}
  // 六维味道：旧档案用 core.normalizeTaste 兼容迁移；油腻接受度 / 尝鲜意愿保留
  merged.taste = {
    ...normalizeTaste(tasteSource),
    oiliness: clampNumber(tasteSource.oiliness ?? merged.taste.oiliness, 0, 5, 2),
    adventurous: clampNumber(tasteSource.adventurous ?? merged.taste.adventurous, 0, 5, 4),
  }
  return merged
}

/**
 * 归一化 state（host 返回 / 本地缓存 / 默认值合并）。
 *
 * @param {unknown} raw 原始 state
 * @returns {object} state
 */
export function normalizeState(raw) {
  const defaults = createDefaultState()
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const merged = mergeDefaults(defaults, source)
  merged.profile = normalizeProfile(source.profile)
  merged.phase = normalizePhase(source.phase)
  // 目标统一用 core.phaseTargets 重算，避免 host 旧数据里 targets 与阶段不一致
  merged.phase.targets = phaseTargets(merged.phase, merged.profile)
  merged.meals = Array.isArray(source.meals) ? source.meals.filter((meal) => meal !== null && typeof meal === 'object') : []
  merged.settings = normalizeSettings(source.settings)
  merged.plan = mergeDefaults(defaults.plan, source.plan)
  merged.plan.locked = merged.plan.locked !== null && typeof merged.plan.locked === 'object' ? merged.plan.locked : {}
  merged.plan.picks = Array.isArray(merged.plan.picks) ? merged.plan.picks.filter((pick) => pick !== null && typeof pick === 'object') : []
  // ui 三档显示方式 / 浮窗位置统一兜底（host 缺字段或旧缓存时回退 float / null）
  merged.ui = normalizeUiState(source.ui)
  merged.userRecipes = normalizeUserRecipes(source.userRecipes)
  return merged
}

/* ────────────────────────────── 菜品辅助 ────────────────────────────── */

/**
 * 按 id 取菜品。
 *
 * @param {string} id 菜品 id
 * @returns {object | null} 菜品
 */
export function dishById(id) {
  return typeof id === 'string' ? DISH_MAP.get(id) ?? null : null
}

/**
 * 取菜品营养（v2 数据优先，旧数据按分类/标签估算并标记 estimated）。
 *
 * @param {object | null} dish 菜品
 * @returns {{ kcal: number, proteinG: number, fat: number, carbs: number, veg: number, estimated: boolean }} 营养
 */
export function nutritionOf(dish) {
  if (dish === null || typeof dish !== 'object') {
    return { kcal: 0, proteinG: 0, fat: 0, carbs: 0, veg: 0, estimated: true }
  }
  const raw = dish.nutrition !== null && typeof dish.nutrition === 'object' ? dish.nutrition : null
  if (raw !== null && typeof raw.kcal === 'number' && Number.isFinite(raw.kcal)) {
    return {
      kcal: Math.round(raw.kcal),
      proteinG: Math.round(clampNumber(raw.protein, 0, 300, 0)),
      fat: Math.round(clampNumber(raw.fat, 0, 300, 0)),
      carbs: Math.round(clampNumber(raw.carbs, 0, 500, 0)),
      veg: Math.round(clampNumber(raw.veg, 0, 10, 0)),
      estimated: false,
    }
  }
  const tags = Array.isArray(dish.tags) ? dish.tags : []
  const kcal = CATEGORY_KCAL[dish.category] ?? 400
  const proteinG = tags.includes('meat') ? 25 : tags.includes('seafood') ? 22 : tags.includes('veg') ? 9 : 15
  return { kcal, proteinG, fat: 0, carbs: 0, veg: 0, estimated: true }
}

/**
 * 菜品辣度展示文案。
 *
 * @param {object | null} dish 菜品
 * @returns {string} 辣度
 */
export function spicyLabelOf(dish) {
  const tags = dish !== null && Array.isArray(dish.tags) ? dish.tags : []
  const found = tags.find((tag) => Object.prototype.hasOwnProperty.call(SPICY_LABELS, tag))
  return SPICY_LABELS[found] ?? ''
}

/**
 * 菜品辣度等级（无辣度标签按 mild）。
 *
 * @param {object | null} dish 菜品
 * @returns {number} 1-3
 */
function spicyRankOf(dish) {
  const tags = dish !== null && Array.isArray(dish.tags) ? dish.tags : []
  const found = tags.find((tag) => Object.prototype.hasOwnProperty.call(SPICY_RANK, tag))
  return SPICY_RANK[found] ?? 1
}

/**
 * 把 profile 映射成旧 core 的 preferences（兼容 v2 core 不用的字段也无害）。
 *
 * @param {object} profile 档案
 * @returns {object} preferences
 */
export function profileToPreferences(profile) {
  const normalized = normalizeProfile(profile)
  const taste = tastePreferenceOf(normalized)
  const spicy = clampNumber(taste.spicy, 1, 5, 3)
  const maxSpicy = spicy <= 2 ? 'mild' : spicy === 3 ? 'medium' : 'hot'
  const budget = Array.isArray(normalized.budget.perMeal) ? normalized.budget.perMeal : []
  const maxPrice = typeof budget[1] === 'number' ? budget[1] : null
  const avoidTags = [
    ...(Array.isArray(normalized.dietary.allergies) ? normalized.dietary.allergies : []),
    ...(Array.isArray(normalized.dietary.avoidTags) ? normalized.dietary.avoidTags : []),
  ].filter((tag) => typeof tag === 'string' && tag !== '')
  return {
    vegetarian: normalized.dietary.vegetarian === true,
    maxSpicy,
    maxPrice,
    categories: [],
    cuisines: [],
    avoidTags,
  }
}

/**
 * 历史记录（recent 7/14 天）转成 core 需要的 [{dishId,date,meal}]。
 *
 * @param {Array<object>} meals 用餐记录
 * @returns {Array<{ dishId: string, date: string, meal: string }>} 历史
 */
export function historyFromMeals(meals) {
  if (!Array.isArray(meals)) return []
  const today = currentDayKey()
  const cutoff = addDaysKey(today, -14)
  return meals
    .filter((meal) => meal !== null && typeof meal === 'object' && typeof meal.dishId === 'string' && typeof meal.date === 'string')
    .filter((meal) => meal.date >= cutoff)
    .map((meal) => ({ dishId: meal.dishId, date: meal.date, meal: meal.meal }))
}

/* ────────────────────────────── 选餐 ────────────────────────────── */

/**
 * 简单稳定哈希（本地兜底打分只用它做确定性抖动）。
 *
 * @param {string} text 文本
 * @returns {number} 无符号整数
 */
function hashText(text) {
  let hash = 5381
  const value = String(text)
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0
  }
  return hash
}

/**
 * 判断菜品是否满足档案硬约束（vegetarian / 忌口 / 辣度 / 预算）。
 *
 * @param {object} dish 菜品
 * @param {object} profile 档案
 * @returns {boolean} 是否通过
 */
function passesHardFilter(dish, profile) {
  if (dish === null || typeof dish !== 'object') return false
  const preferences = profileToPreferences(profile)
  const tags = Array.isArray(dish.tags) ? dish.tags : []
  const ingredients = Array.isArray(dish.ingredients) ? dish.ingredients : []
  if (preferences.vegetarian && (tags.includes('meat') || tags.includes('seafood'))) return false
  if (preferences.avoidTags.length > 0) {
    const haystack = [...ingredients, ...(Array.isArray(dish.name) ? [] : [String(dish.name ?? '')])].join(' ')
    for (const tag of preferences.avoidTags) {
      if (tag !== '' && haystack.includes(tag)) return false
    }
  }
  if (preferences.maxSpicy !== 'hot') {
    const limit = SPICY_RANK[preferences.maxSpicy] ?? 3
    if (spicyRankOf(dish) > limit) return false
  }
  if (typeof preferences.maxPrice === 'number' && typeof dish.price === 'number' && dish.price > preferences.maxPrice) return false
  return true
}

/**
 * 本地兜底打分（0-100）：阶段契合 + 口味 + 新鲜度。
 *
 * @param {object} dish 菜品
 * @param {{ profile: object, phase: object, recentIds: Set<string>, salt: string }} context 上下文
 * @returns {number} 分数
 */
function localScore(dish, context) {
  const { profile, phase, recentIds, salt } = context
  let score = 40
  const phases = dish.phases !== null && typeof dish.phases === 'object' ? dish.phases : null
  if (phases !== null && typeof phases[phase.kind] === 'number') score += (phases[phase.kind] - 3) * 6
  else score += 3
  // 六维味道相似度：偏好与菜品六维的加权点积（与 core.tasteMatch 同向）
  const tastePref = tastePreferenceOf(profile)
  const dishTaste = dishTasteOf(dish)
  let tasteScore = 0
  for (const dimension of TASTE_DIMENSIONS) {
    tasteScore += (tastePref[dimension] - 3) * (dishTaste[dimension] - 3)
  }
  score += Math.max(-8, Math.min(8, tasteScore / 3))
  score -= Math.abs(dishTaste.spicy - tastePref.spicy) * 1.5
  const origins = Array.isArray(dish.origins) ? dish.origins : []
  const region = profile.identity.region
  if (origins.length > 0) {
    if (origins.includes('云南') && profile.identity.hometown === '云南') score += 6
    if (origins.includes('四川') || origins.includes('川味')) score += 3
    if (region !== undefined && region !== '') score += 0.5
  }
  if (recentIds.has(dish.id)) score -= 30
  const nutrition = nutritionOf(dish)
  if (phase.kind !== 'treat') {
    if (nutrition.proteinG >= 25) score += 5
    if (nutrition.kcal > 700) score -= 6
  }
  const jitter = (hashText(`${salt}|${dish.id}`) % 1000) / 1000
  return score + jitter
}

/**
 * 纯本地挑菜（core 不可用时的最后兜底）。
 *
 * @param {{ state: object, parts: object, meal: string, excludeIds: string[], history: Array<object>, catalog?: Array<object> }} options 参数
 * @returns {{ dish: object | null, alternatives: object[], reason: string, fallbackNote: string | null }} 结果
 */
function localPick(options) {
  const { state, parts, meal, excludeIds, history } = options
  const catalog = Array.isArray(options.catalog) ? options.catalog : CATALOG
  const profile = normalizeProfile(state.profile)
  const phase = normalizePhase(state.phase)
  const recentIds = new Set(
    history
      .filter((entry) => entry.date >= addDaysKey(parts.dateKey, -7))
      .map((entry) => entry.dishId),
  )
  const excluded = new Set(excludeIds)
  const salt = `${parts.dateKey}|${meal}|${excludeIds.length}`
  const scored = catalog
    .filter((dish) => passesHardFilter(dish, profile))
    .filter((dish) => !excluded.has(dish.id))
    .map((dish) => ({ dish, score: localScore(dish, { profile, phase, recentIds, salt }) }))
    .sort((left, right) => right.score - left.score || left.dish.id.localeCompare(right.dish.id))
  if (scored.length === 0) {
    return { dish: null, alternatives: [], reason: '当前偏好下没有可推荐的菜，去设置里放宽一点口味限制吧', fallbackNote: '本地候选为空' }
  }
  const top = scored.slice(0, Math.min(6, scored.length))
  const winner = top[hashText(salt) % top.length]
  const alternatives = scored.filter((item) => item.dish.id !== winner.dish.id).slice(0, 3).map((item) => item.dish)
  const cuisine = typeof winner.dish.cuisine === 'string' ? winner.dish.cuisine : ''
  const spicy = spicyLabelOf(winner.dish)
  const winnerTaste = dishTasteOf(winner.dish)
  const tasteWords = TASTE_DIMENSIONS
    .filter((dimension) => dimension !== 'spicy' && winnerTaste[dimension] >= 4)
    .slice(0, 3)
    .map((dimension) => TASTE_LABELS[dimension] ?? '')
    .join('')
  const reason = `${MEAL_LABELS[meal] ?? '今天'} · ${cuisine}${tasteWords === '' ? '' : ` · ${tasteWords}口`}${spicy === '' ? '' : ` · ${spicy}`} · 人均 ¥${typeof winner.dish.price === 'number' ? winner.dish.price : '—'}`
  return { dish: winner.dish, alternatives, reason, fallbackNote: null }
}

/**
 * 当前推荐应该用哪个餐次（直接复用 client mealTime 适配层，与 core 窗口语义一致）。
 */
export const recommendationMeal = coreRecommendationMeal

/**
 * 计算当前推荐（dock / 面板今天共用）。
 *
 * @param {{ state?: object, now?: Date, excludeIds?: string[], manualDishId?: string | null, cuisines?: string[] }} [options={}] 参数
 * @returns {{
 *   dish: object | null,
 *   alternatives: object[],
 *   reason: string,
 *   nutrition: ReturnType<typeof nutritionOf>,
 *   meal: string,
 *   mealLabel: string,
 *   dateKey: string,
 *   phaseKind: string,
 *   fallbackNote: string | null,
 *   source: 'core' | 'fallback' | 'local',
 * }} 推荐
 */
export function selectRecommendation(options = {}) {
  const state = normalizeState(options.state ?? createDefaultState())
  const now = options.now instanceof Date ? options.now : new Date(options.now === undefined ? Date.now() : options.now)
  const excludeIds = Array.isArray(options.excludeIds) ? options.excludeIds.filter((id) => typeof id === 'string') : []
  const cuisines = normalizeRerollCuisines(options.cuisines)
  // 「换一个风格」：先按菜系缩小目录，推荐 / 备选 / 本地兜底都只看这部分菜。
  const catalog = filterCatalogByCuisines(CATALOG, cuisines)
  const parts = shanghaiParts(now)
  const mealState = mealTimeState(now, state.settings, state.meals)
  const meal = recommendationMeal(mealState)
  const profile = normalizeProfile(state.profile)
  const phase = normalizePhase(state.phase)
  const history = historyFromMeals(state.meals)
  const salt = `${parts.dateKey}|${meal}|${excludeIds.length}`

  let result = null
  let source = 'local'

  if (typeof core.recommendMeal === 'function') {
    try {
      result = core.recommendMeal({
        date: now,
        meal,
        profile,
        phase,
        history,
        catalog,
        excludeIds,
        seed: state.plan.seed,
        mode: options.mode,
        phaseKind: phase.kind,
        salt,
      })
      if (result !== null && result !== undefined && result.dish) source = 'core'
      else result = null
    } catch {
      result = null
    }
  }

  if (result === null) {
    try {
      const preferences = profileToPreferences(profile)
      const request = { date: now, meal, preferences, history, catalog }
      result = excludeIds.length > 0 ? core.reroll({ ...request, previousIds: excludeIds }) : core.getDailyPick(request)
      if (result !== null && result !== undefined && result.dish) source = 'fallback'
      else result = null
    } catch {
      result = null
    }
  }

  if (result === null) {
    result = localPick({ state, parts, meal, excludeIds, history, catalog })
    source = 'local'
  }

  let dish = result !== null && result.dish ? result.dish : null
  const alternatives = result !== null && Array.isArray(result.alternatives)
    ? result.alternatives.filter((item) => item !== null && typeof item === 'object' && item.id !== (dish === null ? null : dish.id)).slice(0, 3)
    : []
  if (options.manualDishId) {
    const manual = catalog.find((item) => item.id === options.manualDishId) ?? null
    if (manual !== null) dish = manual
  }
  const fallbackNote = result !== null && typeof result.fallbackNote === 'string' && result.fallbackNote !== '' ? result.fallbackNote : null
  return {
    dish,
    alternatives,
    reason: result !== null && typeof result.reason === 'string' && result.reason !== '' ? result.reason : '',
    nutrition: nutritionOf(dish),
    meal,
    mealLabel: MEAL_LABELS[meal] ?? '今天',
    dateKey: parts.dateKey,
    phaseKind: phase.kind,
    phaseEmoji: phaseMeta(phase.kind).emoji,
    fallbackNote,
    source,
  }
}

/* ────────────────────────────── 周计划 ────────────────────────────── */

/**
 * 取某个日期所在周的周一（日期键）。
 *
 * @param {string} [today] 日期键
 * @returns {string} 周一
 */
export function weekStartKey(today = currentDayKey()) {
  const weekday = new Date(parseDateKey(today) + 8 * 60 * 60 * 1000).getUTCDay()
  const offset = (weekday + 6) % 7
  return addDaysKey(today, -offset)
}

/**
 * 计划里的 picks → 按天分组。
 *
 * @param {object | null | undefined} plan 计划
 * @returns {Array<{ date: string, meals: Array<object> }>} 按天列表
 */
export function planDays(plan) {
  const picks = plan !== null && plan !== undefined && Array.isArray(plan.picks) ? plan.picks : []
  const groups = new Map()
  for (const pick of picks) {
    if (pick === null || typeof pick !== 'object' || typeof pick.date !== 'string') continue
    if (!groups.has(pick.date)) groups.set(pick.date, [])
    groups.get(pick.date).push(pick)
  }
  return [...groups.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([date, meals]) => ({
      date,
      meals: meals.sort((left, right) => String(left.meal).localeCompare(String(right.meal))),
    }))
}

/**
 * 从 core.planWeek 的 days 结构归一化成 plan。
 *
 * @param {object} result core 返回
 * @param {string} start 起始日期
 * @param {number} seed 种子
 * @param {object} locked 锁定表
 * @returns {object} plan
 */
function normalizePlanResult(result, start, seed, locked) {
  const picks = []
  if (Array.isArray(result.days)) {
    for (const day of result.days) {
      if (day === null || typeof day !== 'object' || typeof day.date !== 'string') continue
      for (const meal of Array.isArray(day.meals) ? day.meals : []) {
        if (meal === null || typeof meal !== 'object' || meal.dish === null || meal.dish === undefined) continue
        picks.push({
          date: day.date,
          meal: meal.meal,
          dishId: meal.dish.id,
          mode: meal.mode ?? (meal.dish.cookable === true ? 'home' : 'out'),
        })
      }
    }
  } else if (Array.isArray(result.picks)) {
    picks.push(...result.picks)
  }
  return {
    start: typeof result.start === 'string' ? result.start : start,
    seed: typeof result.seed === 'number' ? result.seed : seed,
    generatedAt: typeof result.generatedAt === 'number' ? result.generatedAt : Date.now(),
    locked: locked !== null && typeof locked === 'object' ? locked : {},
    picks,
  }
}

/**
 * 生成一周计划（优先 core.planWeek，兜底本地贪心）。
 *
 * @param {{ state?: object, startDate?: string, days?: number, meals?: string[], locked?: object, seed?: number, previous?: object | null }} [options={}] 参数
 * @returns {object} plan
 */
export function buildPlan(options = {}) {
  const state = normalizeState(options.state ?? createDefaultState())
  const startDate = typeof options.startDate === 'string' ? options.startDate : state.plan.start || weekStartKey()
  const days = Math.round(clampNumber(options.days, 1, 28, 7))
  const meals = Array.isArray(options.meals) && options.meals.length > 0 ? options.meals : state.settings.plannedMeals
  const seed = typeof options.seed === 'number' ? options.seed : state.plan.seed ?? 7
  const locked = options.locked !== null && typeof options.locked === 'object' ? options.locked : state.plan.locked ?? {}
  const previous = options.previous === undefined ? state.plan : options.previous

  if (typeof core.planWeek === 'function') {
    try {
      const result = core.planWeek({
        startDate,
        start: startDate,
        days,
        meals,
        profile: normalizeProfile(state.profile),
        phase: normalizePhase(state.phase),
        history: historyFromMeals(state.meals),
        catalog: CATALOG,
        seed,
        locked,
        previous,
      })
      if (result !== null && result !== undefined && (Array.isArray(result.days) || Array.isArray(result.picks))) {
        const plan = normalizePlanResult(result, startDate, seed, locked)
        if (plan.picks.length > 0) return plan
      }
    } catch {
      // 落到本地规划
    }
  }

  const profile = normalizeProfile(state.profile)
  const phase = normalizePhase(state.phase)
  const history = historyFromMeals(state.meals)
  const recentIds = new Set(history.filter((entry) => entry.date >= addDaysKey(currentDayKey(), -7)).map((entry) => entry.dishId))
  const previousPicks = new Map()
  if (previous !== null && previous !== undefined && Array.isArray(previous.picks)) {
    for (const pick of previous.picks) {
      if (pick !== null && typeof pick === 'object') previousPicks.set(`${pick.date}|${pick.meal}`, pick)
    }
  }
  const picks = []
  const used = new Set()
  for (let index = 0; index < days; index += 1) {
    const date = addDaysKey(startDate, index)
    for (const meal of meals) {
      // 锁定语义与 core.planWeek 对齐：{'日期:餐次': dishId} / {日期: dishId}（作用该日首餐）；
      // 同时兼容旧的布尔日期锁 {日期: true}（保留整天）。
      const perMealLock = typeof locked[`${date}:${meal}`] === 'string' ? locked[`${date}:${meal}`] : null
      const perDateLock = meal === meals[0] && typeof locked[date] === 'string' ? locked[date] : null
      const dayBooleanLock = locked[date] === true
      const lockedDishId = perMealLock ?? perDateLock ?? (dayBooleanLock ? previousPicks.get(`${date}|${meal}`)?.dishId : null)
      if (typeof lockedDishId === 'string' && lockedDishId !== '') {
        const dish = dishById(lockedDishId)
        if (dish !== null) {
          picks.push({ date, meal, dishId: dish.id, mode: previousPicks.get(`${date}|${meal}`)?.mode ?? (dish.cookable === true ? 'home' : 'out') })
          used.add(dish.id)
          continue
        }
      }
      let dish = null
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const candidate = localPick({
          state,
          parts: { dateKey: date },
          meal,
          excludeIds: [...used],
          history,
        })
        const first = candidate.dish
        if (first === null) break
        if (!used.has(first.id)) {
          dish = first
          break
        }
        // 备选里找一道还没用过的
        const spare = candidate.alternatives.find((item) => !used.has(item.id))
        if (spare !== undefined) {
          dish = spare
          break
        }
      }
      if (dish === null) {
        dish = CATALOG.find((item) => passesHardFilter(item, profile) && !used.has(item.id)) ?? CATALOG.find((item) => passesHardFilter(item, profile)) ?? CATALOG[0] ?? null
      }
      if (dish === null) continue
      picks.push({ date, meal, dishId: dish.id, mode: dish.cookable === true ? 'home' : 'out' })
      used.add(dish.id)
    }
  }
  return { start: startDate, seed, generatedAt: Date.now(), locked: locked !== null && typeof locked === 'object' ? locked : {}, picks }
}

/**
 * 周计划摘要。
 *
 * @param {object | null | undefined} plan 计划
 * @returns {{ avgKcal: number, avgProtein: number, uniqueDishes: number, cuisines: number, estimatedCost: number, freeMeals: number }} 摘要
 */
export function planSummary(plan) {
  const picks = plan !== null && plan !== undefined && Array.isArray(plan.picks) ? plan.picks : []
  let kcal = 0
  let protein = 0
  let cost = 0
  let counted = 0
  const dishIds = new Set()
  const cuisines = new Set()
  let freeMeals = 0
  for (const pick of picks) {
    const dish = dishById(pick.dishId)
    if (dish === null) continue
    const nutrition = nutritionOf(dish)
    kcal += nutrition.kcal
    protein += nutrition.proteinG
    if (typeof dish.price === 'number') cost += pick.mode === 'home' ? Math.round(dish.price * 0.6) : dish.price
    if (typeof dish.cuisine === 'string' && dish.cuisine !== '') cuisines.add(dish.cuisine)
    if (pick.mode === 'out') freeMeals += 1
    dishIds.add(dish.id)
    counted += 1
  }
  return {
    avgKcal: counted === 0 ? 0 : Math.round(kcal / counted),
    avgProtein: counted === 0 ? 0 : Math.round(protein / counted),
    uniqueDishes: dishIds.size,
    cuisines: cuisines.size,
    estimatedCost: Math.round(cost),
    freeMeals,
  }
}

/* ────────────────────────────── 统计 ────────────────────────────── */

/**
 * 本地统计（core.summarizeMeals 不可用时的兜底）。
 *
 * @param {{ state: object, today: string }} options 参数
 * @returns {object} 统计
 */
function localSummarize(options) {
  const state = normalizeState(options.state)
  const today = typeof options.today === 'string' ? options.today : currentDayKey()
  const meals = state.meals.filter((meal) => typeof meal.date === 'string')
  const byDate = new Map()
  for (const meal of meals) {
    if (!byDate.has(meal.date)) byDate.set(meal.date, [])
    byDate.get(meal.date).push(meal)
  }
  const weekCutoff = addDaysKey(today, -6)
  const weekMeals = meals.filter((meal) => meal.date >= weekCutoff && meal.date <= today)
  let kcal = 0
  let protein = 0
  let kcalDays = 0
  const dishIds = new Set()
  const cuisines = new Map()
  let freeMealsUsed = 0
  const perDayKcal = new Map()
  for (const meal of weekMeals) {
    const dish = dishById(meal.dishId)
    const storedKcal = typeof meal.kcal === 'number' && Number.isFinite(meal.kcal) ? meal.kcal : nutritionOf(dish).kcal
    const storedProtein = typeof meal.proteinG === 'number' && Number.isFinite(meal.proteinG) ? meal.proteinG : nutritionOf(dish).proteinG
    kcal += storedKcal
    protein += storedProtein
    perDayKcal.set(meal.date, (perDayKcal.get(meal.date) ?? 0) + storedKcal)
    if (typeof meal.dishId === 'string') dishIds.add(meal.dishId)
    const cuisine = dish !== null && typeof dish.cuisine === 'string' ? dish.cuisine : ''
    if (cuisine !== '') cuisines.set(cuisine, (cuisines.get(cuisine) ?? 0) + 1)
    if (meal.mode === 'out') freeMealsUsed += 1
    kcalDays += 1
  }
  const targets = phaseTargets(normalizePhase(state.phase), state.profile)
  let adherenceDays = 0
  for (const total of perDayKcal.values()) {
    if (total >= targets.kcalMin && total <= targets.kcalMax) adherenceDays += 1
  }
  // 连续记录天数：从今天（或昨天）往回数
  let streak = 0
  let cursor = today
  if (!byDate.has(cursor)) cursor = addDaysKey(today, -1)
  while (byDate.has(cursor)) {
    streak += 1
    cursor = addDaysKey(cursor, -1)
  }
  const weekLoggedDays = [...new Set(weekMeals.map((meal) => meal.date))].length
  const totalWeekMeals = weekMeals.length
  const repeatRate = totalWeekMeals === 0 ? 0 : Math.max(0, 1 - dishIds.size / totalWeekMeals)
  return {
    streak,
    loggedDays: byDate.size,
    weekLoggedDays,
    repeatRate,
    avgKcal: totalWeekMeals === 0 ? 0 : Math.round(kcal / totalWeekMeals),
    avgProtein: totalWeekMeals === 0 ? 0 : Math.round(protein / totalWeekMeals),
    adherence: kcalDays === 0 ? 0 : Math.round((adherenceDays / perDayKcal.size) * 100) / 100,
    topCuisines: [...cuisines.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([cuisine, count]) => ({ cuisine, count })),
    freeMealsUsed,
  }
}

/**
 * 饮食统计（优先 core.summarizeMeals）。
 *
 * @param {{ state?: object, today?: string }} [options={}] 参数
 * @returns {object} 统计
 */
export function summarize(options = {}) {
  const state = normalizeState(options.state ?? createDefaultState())
  const today = typeof options.today === 'string' ? options.today : currentDayKey()
  if (typeof core.summarizeMeals === 'function') {
    try {
      const result = core.summarizeMeals({
        meals: state.meals,
        phase: normalizePhase(state.phase),
        profile: normalizeProfile(state.profile),
        today,
      })
      if (result !== null && typeof result === 'object') {
        return {
          ...localSummarize({ state, today }),
          ...result,
          topCuisines: Array.isArray(result.topCuisines) ? result.topCuisines : [],
        }
      }
    } catch {
      // 落到本地统计
    }
  }
  return localSummarize({ state, today })
}

/**
 * 今天的营养合计。
 *
 * @param {Array<object>} meals 记录
 * @param {string} dateKey 日期键
 * @returns {{ kcal: number, proteinG: number, veg: number, count: number, meals: Array<object> }} 合计
 */
export function dayTotals(meals, dateKey) {
  const items = Array.isArray(meals) ? meals.filter((meal) => meal !== null && typeof meal === 'object' && meal.date === dateKey) : []
  let kcal = 0
  let proteinG = 0
  let veg = 0
  for (const meal of items) {
    const dish = dishById(meal.dishId)
    const nutrition = nutritionOf(dish)
    kcal += typeof meal.kcal === 'number' && Number.isFinite(meal.kcal) ? meal.kcal : nutrition.kcal
    proteinG += typeof meal.proteinG === 'number' && Number.isFinite(meal.proteinG) ? meal.proteinG : nutrition.proteinG
    veg += nutrition.veg
  }
  return { kcal: Math.round(kcal), proteinG: Math.round(proteinG), veg, count: items.length, meals: items }
}

/**
 * 构造一条用餐记录（POST /api/meals 的 meal 字段）。
 *
 * @param {{ dish: object, dateKey: string, meal: string, mode?: string, rating?: number, note?: string, ts?: number }} options 参数
 * @returns {object} 记录
 */
export function buildMealRecord(options) {
  const dish = options.dish
  const nutrition = nutritionOf(dish)
  return {
    id: '',
    ts: typeof options.ts === 'number' ? options.ts : Date.now(),
    date: options.dateKey,
    meal: options.meal,
    mode: options.mode ?? (dish !== null && dish.cookable === true ? 'home' : 'out'),
    dishId: dish !== null && typeof dish.id === 'string' ? dish.id : '',
    dishName: dish !== null && typeof dish.name === 'string' ? dish.name : '未命名',
    place: null,
    rating: typeof options.rating === 'number' ? options.rating : 0,
    note: typeof options.note === 'string' ? options.note : '',
    kcal: nutrition.kcal,
    proteinG: nutrition.proteinG,
  }
}

/* ────────────────────────────── 离线 state ────────────────────────────── */

/**
 * 构造离线兜底 state：最近缓存优先，其次 v1 localStorage 旧键。
 *
 * @returns {{ state: object, hasAmapKey: boolean }} 本地视图
 */
export function loadOfflineState() {
  const cached = readStateCache()
  const legacyUi = readUi()
  const state = cached === null ? createDefaultState() : normalizeState(cached.state)
  if (state.meals.length === 0) {
    const legacyHistory = readHistory()
    if (legacyHistory.length > 0) {
      state.meals = legacyHistory.map((entry, index) => {
        const dish = dishById(entry.dishId)
        const nutrition = nutritionOf(dish)
        return {
          id: `local-${index}`,
          ts: parseDateKey(entry.date) + 12 * 60 * 60 * 1000,
          date: entry.date,
          meal: entry.meal,
          mode: dish !== null && dish.cookable === true ? 'home' : 'out',
          dishId: entry.dishId,
          dishName: dish !== null && typeof dish.name === 'string' ? dish.name : entry.dishId,
          place: null,
          rating: 0,
          note: '本地旧记录',
          kcal: nutrition.kcal,
          proteinG: nutrition.proteinG,
        }
      })
    }
  }
  if (cached === null) {
    // 没有缓存时把 v1 偏好合并进档案
    const preferences = readPreferences()
    const profile = normalizeProfile(state.profile)
    if (preferences.vegetarian === true) profile.dietary.vegetarian = true
    if (preferences.noSpicy === true) profile.taste.spicy = 1
    if (preferences.budget === true) profile.budget.perMeal = [10, 30]
    state.profile = profile
  }
  state.ui = {
    ...state.ui,
    collapsed: legacyUi.collapsed === true,
    panelTab: legacyUi.panelTab,
    displayMode: cached === null ? legacyUi.displayMode : state.ui.displayMode,
    floatCollapsed: cached === null ? legacyUi.floatCollapsed === true : state.ui.floatCollapsed === true,
    floatPos: cached === null ? legacyUi.floatPos : state.ui.floatPos,
  }
  return { state, hasAmapKey: cached === null ? false : cached.hasAmapKey }
}
