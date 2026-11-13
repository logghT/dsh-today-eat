/**
 * 「今天吃什么」v2 host 半 —— 长期状态 `state.json`。
 *
 * 文件位置：`<DSH_HOME>/storages/dsh-today-eat/state.json`
 * - `DSH_HOME` 取 `process.env.DSH_HOME`，缺省 `~/.dsh`；
 * - 原子写：先写 `state.json.tmp` 再 rename；
 * - 每次写 `rev` +1，写接口用期望 rev 做乐观并发（冲突 409）；
 * - 读取失败 / JSON 损坏：回退默认状态，并把坏文件备份为 `state.json.bad-<ts>`；
 * - `getState()` 把 `settings.amapKey` 抹成空串（调用方用 `hasAmapKey` 判断）。
 *
 * 本文件零外部依赖：只用 node: 内置模块与相对 import。
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { normalizeUserRecipes } from '../src/core/user-recipes.js'
import {
  PHASE_SUBGOALS,
  PHASES,
  SUBGOALS,
  canonicalPhaseKind,
  normalizePhase as normalizeCorePhase,
  phaseTargets,
} from '../src/core/phase.js'

export { PHASE_SUBGOALS, PHASES, SUBGOALS }

/** 当前状态文件版本。 */
export const STATE_VERSION = 3

/** storages 下的插件目录名。 */
export const STORAGE_DIR = 'dsh-today-eat'

/** 状态文件名。 */
export const STATE_FILE = 'state.json'

/** `/api/state` 的 patch 只允许这五个顶层字段。 */
export const PATCH_ROOTS = Object.freeze(['profile', 'phase', 'settings', 'ui', 'userRecipes'])

/** 阶段类型与子目标由 core/phase.js 统一维护。 */

/** 餐次。 */
export const MEALS = Object.freeze(['breakfast', 'lunch', 'dinner', 'night'])

/** 用餐方式。 */
export const MODES = Object.freeze(['home', 'out'])

/** 大区枚举（只用于文档/校验，不做硬过滤）。 */
export const REGIONS = Object.freeze(['西南', '华东', '华北', '华南', '华中', '西北', '东北'])

/** 菜系枚举（用于「换一个风格」；与 src/core/recommend.js CUISINES / 菜谱库保持一致）。 */
export const REROLL_CUISINES = Object.freeze(['云南菜', '川菜', '粤菜', '湘菜', '江浙', '北方', '西北', '西南', '日韩', '西式', '快餐'])

const ID_PREFIX = 'm-'

/**
 * 六维味道维度（taste-v1 §1 唯一真源；与 src/core/taste.js 的 TASTE_DIMENSIONS 对齐）。
 * 说明：core 由 feed-core 并行重写，lib 不能静态依赖其导出，故在此保留一份常量，
 * 工具只依赖这里的 `normalizeTasteProfile`；core 就绪后由 core 的统计函数产出数值。
 */
export const TASTE_DIMENSIONS = Object.freeze(['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami'])

/** 六维味道中文标签。 */
export const TASTE_LABELS = Object.freeze({
  sour: '酸',
  sweet: '甜',
  bitter: '苦',
  spicy: '辣',
  salty: '咸',
  umami: '鲜',
})

/** 六维味道默认偏好（taste-v1 §6）。 */
export const TASTE_DEFAULTS = Object.freeze({ sour: 3, sweet: 2, bitter: 1, spicy: 3, salty: 2, umami: 3 })

/**
 * 是否普通对象（数组 / null 不算）。
 *
 * @param {unknown} value 候选值
 * @returns {boolean} 是普通对象返回 true
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * JSON 深拷贝（状态只包含可 JSON 化的值）。
 *
 * @template T
 * @param {T} value 原值
 * @returns {T} 副本
 */
export function deepClone(value) {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

/**
 * 深合并：普通对象递归合并，数组与标量直接替换。
 *
 * @param {object} base 原对象
 * @param {object} patch 补丁对象
 * @returns {object} 新对象（不修改入参）
 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return isPlainObject(base) ? { ...base } : {}
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else if (isPlainObject(value)) out[key] = deepMerge({}, value)
    else out[key] = value
  }
  return out
}

/**
 * 把味道偏好值 clamp 到 0–5，保留 1 位小数；非法值返回 fallback。
 *
 * @param {unknown} value 候选值
 * @param {number} fallback 缺省值
 * @returns {number} 归一化值
 */
function clampTaste(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.round(Math.min(5, Math.max(0, number)) * 10) / 10
}

/**
 * 归一化味道偏好为六维（taste-v1 §1/§6）。
 *
 * 迁移规则（读取旧 state.json 时）：
 * `sour = max(旧 sour ?? 0, 旧 sourFruit ?? 0, 旧 sourFermented ?? 0, 旧 sourVinegar ?? 0) || 3`，
 * 其余维度用旧值与默认值；**旧字段保留不删**（新字段为准）。
 *
 * @param {unknown} input 原始味道偏好（可能含旧字段）
 * @returns {object} 六维味道偏好（含 oiliness/adventurous 与保留的旧字段）
 */
export function normalizeTasteProfile(input = {}) {
  const source = isPlainObject(input) ? input : {}
  const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
  const legacySour = Math.max(
    numberOr(source.sourFruit, 0),
    numberOr(source.sourFermented, 0),
    numberOr(source.sourVinegar, 0),
  )
  const hasExplicitNew = TASTE_DIMENSIONS.some(
    (key) => source[key] !== undefined && source[key] !== null && source[key] !== '',
  )
  const taste = {}
  for (const key of TASTE_DIMENSIONS) {
    if (key === 'sour') {
      if (hasExplicitNew && source.sour !== undefined && source.sour !== null && source.sour !== '') {
        taste.sour = clampTaste(source.sour, TASTE_DEFAULTS.sour)
      } else if (legacySour > 0) {
        taste.sour = clampTaste(legacySour, TASTE_DEFAULTS.sour)
      } else {
        taste.sour = TASTE_DEFAULTS.sour
      }
    } else {
      taste[key] = clampTaste(source[key], TASTE_DEFAULTS[key])
    }
  }
  // 旧字段保留（不删）；sourFruit/sourFermented/sourVinegar 等原样留存，新六维为准
  for (const [key, value] of Object.entries(source)) {
    if (TASTE_DIMENSIONS.includes(key) || key === 'oiliness' || key === 'adventurous') continue
    taste[key] = deepClone(value)
  }
  // 非味道偏好：油腻接受度 / 尝鲜意愿（保留为整数 0-5）
  const clampScore = (value, fallback) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(5, Math.max(0, Math.round(number)))
  }
  taste.oiliness = clampScore(source.oiliness, 2)
  taste.adventurous = clampScore(source.adventurous, 4)
  return taste
}

/**
 * 上海时区（UTC+8）日期字符串 `YYYY-MM-DD`。
 *
 * @param {Date | number | string} [value] 时间，缺省当前
 * @returns {string} 日期字符串
 */
export function shanghaiDate(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  const ms = Number.isNaN(date.getTime()) ? Date.now() : date.getTime()
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 由时间戳推断餐次（上海时区）。
 *
 * @param {number} ts 时间戳（毫秒）
 * @returns {'breakfast' | 'lunch' | 'dinner' | 'night'} 餐次
 */
export function mealFromTimestamp(ts = Date.now()) {
  const hour = new Date(ts + 8 * 60 * 60 * 1000).getUTCHours()
  if (hour >= 5 && hour < 10) return 'breakfast'
  if (hour >= 10 && hour < 15) return 'lunch'
  if (hour >= 15 && hour < 21) return 'dinner'
  return 'night'
}

/**
 * 合法日期字符串（`YYYY-MM-DD`）。
 *
 * @param {unknown} value 候选
 * @returns {boolean} 合法返回 true
 */
function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/**
 * rev 归一化：正整数，缺省 1。
 *
 * @param {unknown} value 候选
 * @returns {number} 合法 rev
 */
function toRev(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 ? number : 1
}

/**
 * 数字或 null（用于热量等可缺省字段）。
 *
 * @param {unknown} value 候选
 * @param {{ min?: number }} [options] 约束
 * @returns {number | null} 数字或 null
 */
function numberOrNull(value, options = {}) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const min = options.min === undefined ? -Infinity : options.min
  if (number < min) return null
  return number
}

/**
 * 字符串或默认值。
 *
 * @param {unknown} value 候选
 * @param {string} [fallback] 默认
 * @returns {string} 字符串
 */
function stringOr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/**
 * 当前默认阶段目标（design-v2 §7 营养目标）。
 *
 * @param {string} kind 阶段类型
 * @param {string} subgoal 子目标
 * @returns {{ kcalMin: number, kcalMax: number, proteinG: number, freeMealsPerWeek: number }} 目标
 */
export function defaultTargetsFor(kind, subgoal) {
  return phaseTargets({ kind, subgoal }, { weight: 75 })
}

/**
 * 默认档案（design-v2 §2 示例值）。
 *
 * @returns {object} 档案
 */
function defaultProfile() {
  return {
    identity: {
      hometown: '',
      city: '',
      district: '',
      region: '',
      lat: null,
      lng: null,
      adcode: '',
    },
    taste: {
      sour: 3,
      sweet: 3,
      bitter: 3,
      spicy: 3,
      salty: 3,
      umami: 3,
      oiliness: 3,
      adventurous: 3,
    },
    dietary: { vegetarian: false, allergies: [], avoidTags: [] },
    budget: { perMeal: [20, 60], weekly: 420 },
    cook: { skill: 'basic', equipment: ['炒锅', '电饭煲'], weekdayCookMin: 20 },
  }
}

/**
 * 默认设置。
 *
 * @returns {object} 设置
 */
function defaultSettings() {
  return {
    mealTimes: {
      breakfast: ['07:00', '09:00'],
      lunch: ['11:30', '13:00'],
      dinner: ['17:30', '19:30'],
    },
    plannedMeals: ['lunch', 'dinner'],
    notify: { inApp: true, system: true, snoozeMin: 30 },
    amapKey: '',
  }
}

/**
 * 默认 UI 状态。
 *
 * @returns {object} UI 状态
 */
function defaultUi() {
  return {
    collapsed: false,
    panelTab: 'today',
    displayMode: 'float',
    floatCollapsed: false,
    floatPos: null,
    rerollCuisines: [],
  }
}

/**
 * 默认计划占位（还没有生成周计划）。
 *
 * @returns {object} 计划
 */
function defaultPlan() {
  return { start: null, seed: 0, generatedAt: 0, locked: {}, picks: [] }
}

/**
 * 新建默认状态。
 *
 * @param {number} [now] 当前时间戳
 * @returns {object} 状态
 */
export function createDefaultState(now = Date.now()) {
  return {
    version: STATE_VERSION,
    rev: 1,
    profile: defaultProfile(),
    phase: {
      kind: 'performance',
      subgoal: 'fat_loss',
      start: shanghaiDate(now),
      weeks: 8,
      targets: defaultTargetsFor('performance', 'fat_loss'),
    },
    meals: [],
    plan: defaultPlan(),
    settings: defaultSettings(),
    ui: defaultUi(),
    userRecipes: {},
  }
}

/**
 * 归一化档案。
 *
 * @param {unknown} input 原始档案
 * @returns {object} 档案
 */
export function normalizeProfile(input) {
  const source = isPlainObject(input) ? input : {}
  const base = defaultProfile()
  const identity = deepMerge(base.identity, isPlainObject(source.identity) ? source.identity : {})
  const dietary = deepMerge(base.dietary, isPlainObject(source.dietary) ? source.dietary : {})
  const budget = deepMerge(base.budget, isPlainObject(source.budget) ? source.budget : {})
  const cook = deepMerge(base.cook, isPlainObject(source.cook) ? source.cook : {})

  // 味道偏好：六维归一化 + 旧字段迁移（taste-v1 §6）
  const tasteOut = normalizeTasteProfile(isPlainObject(source.taste) ? source.taste : {})

  const perMeal = Array.isArray(budget.perMeal) ? budget.perMeal : base.budget.perMeal
  const min = numberOrNull(perMeal[0], { min: 0 })
  const max = numberOrNull(perMeal[1], { min: 0 })
  const perMealOut = [min ?? base.budget.perMeal[0], max ?? base.budget.perMeal[1]]

  const identityOut = {
    hometown: stringOr(identity.hometown, ''),
    city: stringOr(identity.city, ''),
    district: stringOr(identity.district, ''),
    region: stringOr(identity.region, ''),
    lat: numberOrNull(identity.lat),
    lng: numberOrNull(identity.lng),
    adcode: stringOr(identity.adcode, ''),
  }
  const dietaryOut = {
    vegetarian: dietary.vegetarian === true,
    allergies: Array.isArray(dietary.allergies)
      ? dietary.allergies.filter((item) => typeof item === 'string' && item !== '')
      : [],
    avoidTags: Array.isArray(dietary.avoidTags)
      ? dietary.avoidTags.filter((item) => typeof item === 'string' && item !== '')
      : [],
  }
  const cookOut = {
    skill: stringOr(cook.skill, base.cook.skill),
    equipment: Array.isArray(cook.equipment)
      ? cook.equipment.filter((item) => typeof item === 'string' && item !== '')
      : base.cook.equipment,
    weekdayCookMin: numberOrNull(cook.weekdayCookMin, { min: 0 }) ?? base.cook.weekdayCookMin,
  }
  const budgetOut = {
    perMeal: perMealOut,
    weekly: numberOrNull(budget.weekly, { min: 0 }) ?? base.budget.weekly,
  }
  return { identity: identityOut, taste: tasteOut, dietary: dietaryOut, budget: budgetOut, cook: cookOut }
}

/**
 * 归一化阶段。
 *
 * @param {unknown} input 原始阶段
 * @param {object} [fallback] 缺省阶段
 * @returns {object} 阶段
 */
export function normalizePhaseState(input, fallback = {}) {
  const source = isPlainObject(input) ? input : {}
  const base = isPlainObject(fallback) ? fallback : {}
  const start = isDateString(source.start)
    ? source.start
    : isDateString(base.start) ? base.start : shanghaiDate()
  const weeksRaw = Number(source.weeks)
  const weeks = Number.isInteger(weeksRaw) && weeksRaw >= 1 && weeksRaw <= 52
    ? weeksRaw
    : Number.isInteger(Number(base.weeks)) ? Number(base.weeks) : 8
  const targetInput = isPlainObject(source.targets)
    ? source.targets
    : isPlainObject(base.targets) ? base.targets : {}
  const normalized = normalizeCorePhase({
    kind: canonicalPhaseKind(source.kind ?? source.phaseKind)
      ? source.kind ?? source.phaseKind
      : base.kind ?? 'performance',
    subgoal: source.subgoal ?? source.phaseSubgoal ?? base.subgoal,
    start,
    weeks,
    targets: targetInput,
  })
  const targets = phaseTargets(
    { kind: normalized.kind, subgoal: normalized.subgoal, targets: targetInput },
    { weight: 75 },
  )
  return { kind: normalized.kind, subgoal: normalized.subgoal, start, weeks, targets }
}

/**
 * 归一化设置（不含 amapKey 的默认，amapKey 由调用方决定）。
 *
 * @param {unknown} input 原始设置
 * @param {object} [fallback] 缺省设置
 * @returns {object} 设置
 */
export function normalizeSettings(input, fallback = defaultSettings()) {
  const source = isPlainObject(input) ? input : {}
  const base = isPlainObject(fallback) ? fallback : defaultSettings()
  const rawTimes = isPlainObject(source.mealTimes) ? source.mealTimes : {}
  const mealTimes = {}
  for (const meal of ['breakfast', 'lunch', 'dinner']) {
    const fallbackTimes = Array.isArray(base.mealTimes?.[meal]) ? base.mealTimes[meal] : defaultSettings().mealTimes[meal]
    const times = Array.isArray(rawTimes[meal]) ? rawTimes[meal] : fallbackTimes
    mealTimes[meal] = times
      .filter((item) => typeof item === 'string' && /^\d{2}:\d{2}$/.test(item))
      .slice(0, 2)
    if (mealTimes[meal].length === 0) mealTimes[meal] = fallbackTimes
  }
  const planned = Array.isArray(source.plannedMeals)
    ? source.plannedMeals.filter((meal) => MEALS.includes(meal))
    : Array.isArray(base.plannedMeals) ? base.plannedMeals.filter((meal) => MEALS.includes(meal)) : ['lunch', 'dinner']
  const rawNotify = isPlainObject(source.notify) ? source.notify : {}
  const baseNotify = isPlainObject(base.notify) ? base.notify : defaultSettings().notify
  const snooze = Number(rawNotify.snoozeMin)
  return {
    mealTimes,
    plannedMeals: planned.length > 0 ? planned : ['lunch', 'dinner'],
    notify: {
      inApp: rawNotify.inApp === undefined ? baseNotify.inApp === true : rawNotify.inApp === true,
      system: rawNotify.system === undefined ? baseNotify.system === true : rawNotify.system === true,
      snoozeMin: Number.isInteger(snooze) && snooze > 0 ? snooze : baseNotify.snoozeMin,
    },
    amapKey: typeof source.amapKey === 'string' ? source.amapKey.trim() : '',
  }
}

/**
 * 归一化「换一个风格」菜系：只保留支持的菜系、去重、按枚举顺序。
 *
 * @param {unknown} input 原始值
 * @returns {string[]} 菜系列表
 */
export function normalizeRerollCuisines(input) {
  if (!Array.isArray(input)) return []
  const wanted = new Set(input.filter((item) => typeof item === 'string' && item !== ''))
  return REROLL_CUISINES.filter((cuisine) => wanted.has(cuisine))
}

/**
 * 归一化 UI 状态。
 *
 * @param {unknown} input 原始 UI
 * @returns {object} UI 状态
 */
export function normalizeUi(input) {
  const source = isPlainObject(input) ? input : {}
  const base = defaultUi()
  const displayMode = ['float', 'dock', 'panel'].includes(source.displayMode) ? source.displayMode : base.displayMode
  let floatPos = null
  if (isPlainObject(source.floatPos)) {
    const x = Number(source.floatPos.x)
    const y = Number(source.floatPos.y)
    if (Number.isFinite(x) && Number.isFinite(y)) floatPos = { x: Math.round(x), y: Math.round(y) }
  }
  return {
    collapsed: source.collapsed === undefined ? base.collapsed : source.collapsed === true,
    panelTab: stringOr(source.panelTab, base.panelTab) || base.panelTab,
    displayMode,
    floatCollapsed: source.floatCollapsed === true,
    floatPos,
    rerollCuisines: normalizeRerollCuisines(source.rerollCuisines),
  }
}

/**
 * 归一化一条用餐记录。
 *
 * @param {unknown} input 原始记录
 * @param {{ now?: number }} [options] 注入的当前时间
 * @returns {object} 用餐记录
 */
export function normalizeMeal(input, options = {}) {
  const source = isPlainObject(input) ? input : {}
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const ts = Number.isFinite(Number(source.ts)) && Number(source.ts) > 0 ? Number(source.ts) : now
  const meal = MEALS.includes(source.meal) ? source.meal : mealFromTimestamp(ts)
  const ratingRaw = Number(source.rating)
  const rating = ratingRaw === 1 || ratingRaw === -1 ? ratingRaw : 0
  const id = typeof source.id === 'string' && source.id.trim() !== '' ? source.id.trim() : `${ID_PREFIX}${randomUUID()}`
  return {
    id,
    ts,
    date: isDateString(source.date) ? source.date : shanghaiDate(ts),
    meal,
    mode: MODES.includes(source.mode) ? source.mode : null,
    dishId: stringOr(source.dishId, ''),
    dishName: stringOr(source.dishName, ''),
    place: typeof source.place === 'string' && source.place !== '' ? source.place : null,
    rating,
    note: stringOr(source.note, ''),
    kcal: numberOrNull(source.kcal, { min: 0 }),
    proteinG: numberOrNull(source.proteinG, { min: 0 }),
  }
}

/**
 * 归一化周计划。
 *
 * @param {unknown} input 原始计划
 * @returns {object} 计划
 */
export function normalizePlan(input) {
  if (!isPlainObject(input)) return defaultPlan()
  const picks = Array.isArray(input.picks)
    ? input.picks
      .filter(isPlainObject)
      .map((pick) => ({
        date: isDateString(pick.date) ? pick.date : '',
        meal: MEALS.includes(pick.meal) ? pick.meal : 'lunch',
        dishId: stringOr(pick.dishId, ''),
        mode: MODES.includes(pick.mode) ? pick.mode : 'home',
      }))
      .filter((pick) => pick.date !== '')
      .slice(0, 100)
    : []
  return {
    start: isDateString(input.start) ? input.start : null,
    seed: Number.isInteger(Number(input.seed)) ? Number(input.seed) : 0,
    generatedAt: Number.isFinite(Number(input.generatedAt)) ? Number(input.generatedAt) : 0,
    locked: isPlainObject(input.locked) ? deepClone(input.locked) : {},
    picks,
  }
}

/**
 * 对完整状态做一次结构归一化（用于读取磁盘 / 迁移旧版本）。
 *
 * @param {unknown} raw 原始状态
 * @param {{ now?: number }} [options] 注入的当前时间
 * @returns {object} 归一化状态
 */
export function normalizeState(raw, options = {}) {
  const source = isPlainObject(raw) ? raw : {}
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const base = createDefaultState(now)
  const phase = normalizePhaseState(source.phase, base.phase)
  const settings = normalizeSettings(
    isPlainObject(source.settings) ? { ...source.settings, amapKey: typeof source.settings.amapKey === 'string' ? source.settings.amapKey : '' } : {},
    base.settings,
  )
  const meals = Array.isArray(source.meals)
    ? source.meals.filter(isPlainObject).map((meal) => normalizeMeal(meal, { now })).slice(0, 5000)
    : []
  return {
    version: STATE_VERSION,
    rev: toRev(source.rev),
    profile: normalizeProfile(source.profile),
    phase,
    meals,
    plan: normalizePlan(source.plan),
    settings,
    ui: normalizeUi(source.ui),
    userRecipes: normalizeUserRecipes(source.userRecipes),
  }
}

/**
 * 客户端可见状态：`settings.amapKey` 抹空，其余深拷贝。
 *
 * @param {object} state 完整状态
 * @returns {object} 掩码后的状态
 */
export function maskState(state) {
  const masked = deepClone(state)
  if (isPlainObject(masked.settings)) masked.settings.amapKey = ''
  return masked
}

/**
 * 解析状态文件绝对路径。
 *
 * @param {{ statePath?: string, dshHome?: string, env?: object }} [options] 注入项
 * @returns {string} 绝对路径
 */
export function resolveStatePath(options = {}) {
  if (typeof options.statePath === 'string' && options.statePath !== '') {
    return isAbsolute(options.statePath) ? options.statePath : resolve(options.statePath)
  }
  const env = isPlainObject(options.env) ? options.env : process.env
  const homeRaw = typeof options.dshHome === 'string' && options.dshHome !== ''
    ? options.dshHome
    : typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
      ? env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(resolve(homeRaw), 'storages', STORAGE_DIR, STATE_FILE)
}

/**
 * 创建状态仓库。所有写操作串行（同步 fs），读路径带内存缓存。
 *
 * @param {{ statePath?: string, dshHome?: string, env?: object, now?: () => number }} [options] 注入项
 * @returns {object} store
 */
export function createStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const statePath = resolveStatePath(options)
  const dir = dirname(statePath)
  let cached = null
  let loaded = false

  /**
   * 读取并解析磁盘状态；损坏时备份并回退默认值。
   *
   * @returns {object} 状态
   */
  function readFromDisk() {
    let text
    try {
      text = readFileSync(statePath, 'utf8')
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) backupCorruptFile()
      return createDefaultState(now())
    }
    try {
      return normalizeState(JSON.parse(text), { now: now() })
    } catch {
      backupCorruptFile()
      return createDefaultState(now())
    }
  }

  /**
   * 把损坏的 state.json 备份成 `state.json.bad-<ts>`。
   *
   * @returns {string | null} 备份路径
   */
  function backupCorruptFile() {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    let badPath = `${statePath}.bad-${stamp}`
    try {
      renameSync(statePath, badPath)
      return badPath
    } catch {
      try {
        copyFileSync(statePath, badPath)
        return badPath
      } catch {
        return null
      }
    }
  }

  /**
   * 惰性加载状态。
   *
   * @returns {object} 缓存状态
   */
  function load() {
    if (!loaded) {
      loaded = true
      cached = readFromDisk()
    }
    return cached
  }

  /**
   * 原子写：tmp + rename。
   *
   * @param {object} next 待写状态
   * @returns {void}
   */
  function writeState(next) {
    mkdirSync(dir, { recursive: true })
    const tmpPath = `${statePath}.tmp`
    try {
      writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, statePath)
    } catch (error) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // 忽略清理失败
      }
      throw error
    }
  }

  /**
   * 提交草稿：rev+1、写盘、更新缓存。
   *
   * @param {object} draft 状态草稿（会被写入）
   * @returns {object} 已写状态
   */
  function commit(draft) {
    const current = load()
    draft.version = STATE_VERSION
    draft.rev = toRev(current.rev) + 1
    writeState(draft)
    cached = draft
    loaded = true
    return draft
  }

  /**
   * 校验一次写操作的 rev 前置条件。
   *
   * @param {unknown} expectedRev 期望 rev
   * @returns {{ ok: true } | { ok: false, code: string, state?: object, rev?: number, message?: string }} 校验结果
   */
  function checkRev(expectedRev) {
    if (!Number.isInteger(expectedRev)) return { ok: false, code: 'rev-required', message: '缺少整数 rev' }
    const current = load()
    if (toRev(current.rev) !== expectedRev) {
      return { ok: false, code: 'rev-mismatch', state: maskState(current), rev: toRev(current.rev) }
    }
    return { ok: true }
  }

  const store = {
    /** 状态文件绝对路径。 */
    statePath,
    /** 状态目录绝对路径。 */
    dir,

    /**
     * 客户端可见状态（amapKey 已抹空）。
     *
     * @returns {object} 掩码状态
     */
    getState() {
      return maskState(load())
    },

    /**
     * 完整状态（含 amapKey，仅供 host 内部使用）。
     *
     * @returns {object} 完整状态副本
     */
    getFullState() {
      return deepClone(load())
    },

    /**
     * 当前 rev。
     *
     * @returns {number} rev
     */
    getRev() {
      return toRev(load().rev)
    },

    /**
     * 是否已配置高德 Key。
     *
     * @returns {boolean} 已配置返回 true
     */
    hasAmapKey() {
      return typeof load().settings.amapKey === 'string' && load().settings.amapKey.trim() !== ''
    },

    /**
     * 取真实高德 Key（host 内部调用 Amap 用，绝不返回给客户端）。
     *
     * @returns {string} Key
     */
    getAmapKey() {
      const key = load().settings.amapKey
      return typeof key === 'string' ? key.trim() : ''
    },

    /**
     * 深合并 patch（仅 profile/phase/settings/ui），rev 冲突返回 rev-mismatch。
     *
     * @param {number} expectedRev 期望 rev
     * @param {unknown} patchInput 补丁
     * @returns {object} 结果
     */
    patch(expectedRev, patchInput) {
      const checked = checkRev(expectedRev)
      if (!checked.ok) return checked
      if (!isPlainObject(patchInput)) return { ok: false, code: 'invalid-patch', message: 'patch 必须是对象' }
      const roots = Object.keys(patchInput)
      const forbidden = roots.filter((key) => !PATCH_ROOTS.includes(key))
      if (forbidden.length > 0) {
        return {
          ok: false,
          code: 'patch-not-allowed',
          message: `patch 只允许 ${PATCH_ROOTS.join('/')}`,
          keys: forbidden,
        }
      }
      const current = load()
      const draft = deepClone(current)
      for (const root of roots) {
        const raw = patchInput[root]
        if (!isPlainObject(raw)) return { ok: false, code: 'invalid-patch', message: `${root} 必须是对象` }
        const value = deepClone(raw)
        if (root === 'settings') delete value.amapKey
        const merged = deepMerge(draft[root], value)
        if (root === 'profile') draft.profile = normalizeProfile(merged)
        else if (root === 'phase') {
          const kindChanged = typeof value.kind === 'string' && value.kind !== current.phase.kind
          const subgoalChanged = value.subgoal !== undefined && value.subgoal !== current.phase.subgoal
          if ((kindChanged || subgoalChanged) && value.targets === undefined) {
            merged.targets = defaultTargetsFor(
              canonicalPhaseKind(merged.kind) ?? current.phase.kind,
              merged.subgoal,
            )
          }
          draft.phase = normalizePhaseState(merged, draft.phase)
        } else if (root === 'settings') {
          draft.settings = normalizeSettings(merged, draft.settings)
          draft.settings.amapKey = current.settings.amapKey
        } else if (root === 'ui') draft.ui = normalizeUi(merged)
        else if (root === 'userRecipes') draft.userRecipes = normalizeUserRecipes(merged)
      }
      const saved = commit(draft)
      return { ok: true, state: maskState(saved), hasAmapKey: store.hasAmapKey(), rev: saved.rev }
    },

    /**
     * 新增/更新一条用餐记录：id 命中或同 date+meal 的旧记录被替换。
     *
     * @param {number} expectedRev 期望 rev
     * @param {unknown} mealInput 记录
     * @returns {object} 结果
     */
    upsertMeal(expectedRev, mealInput) {
      const checked = checkRev(expectedRev)
      if (!checked.ok) return checked
      if (!isPlainObject(mealInput)) return { ok: false, code: 'invalid-meal', message: 'meal 必须是对象' }
      const draft = deepClone(load())
      const meal = normalizeMeal(mealInput, { now: now() })
      draft.meals = draft.meals
        .filter((item) => item.id !== meal.id && !(item.date === meal.date && item.meal === meal.meal))
        .concat(meal)
        .sort((a, b) => a.ts - b.ts)
      const saved = commit(draft)
      return { ok: true, state: maskState(saved), rev: saved.rev, meal }
    },

    /**
     * 删除一条用餐记录。
     *
     * @param {string} id 记录 id
     * @param {number} [expectedRev] 期望 rev（可选；提供则校验）
     * @returns {object} 结果
     */
    deleteMeal(id, expectedRev) {
      if (expectedRev !== undefined) {
        const checked = checkRev(expectedRev)
        if (!checked.ok) return checked
      }
      if (typeof id !== 'string' || id.trim() === '') {
        return { ok: false, code: 'meal-id-required', message: '缺少 id 参数' }
      }
      const draft = deepClone(load())
      const index = draft.meals.findIndex((item) => item.id === id)
      if (index === -1) return { ok: false, code: 'meal-not-found', message: `记录不存在：${id}` }
      draft.meals.splice(index, 1)
      const saved = commit(draft)
      return { ok: true, state: maskState(saved), rev: saved.rev }
    },

    /**
     * 写入周计划。
     *
     * @param {number} expectedRev 期望 rev
     * @param {unknown} plan 计划
     * @returns {object} 结果
     */
    setPlan(expectedRev, plan) {
      const checked = checkRev(expectedRev)
      if (!checked.ok) return checked
      if (!isPlainObject(plan)) return { ok: false, code: 'invalid-plan', message: 'plan 必须是对象' }
      const draft = deepClone(load())
      draft.plan = normalizePlan(plan)
      const saved = commit(draft)
      return { ok: true, state: maskState(saved), rev: saved.rev }
    },

    /**
     * 保存/清除高德 Key（空串清除）。
     *
     * @param {unknown} key Key
     * @param {number} [expectedRev] 期望 rev（可选）
     * @returns {object} 结果
     */
    setAmapKey(key, expectedRev) {
      if (expectedRev !== undefined) {
        const checked = checkRev(expectedRev)
        if (!checked.ok) return checked
      }
      if (typeof key !== 'string') return { ok: false, code: 'invalid-key', message: 'key 必须是字符串' }
      const trimmed = key.trim()
      if (trimmed.length > 200) return { ok: false, code: 'invalid-key', message: 'key 过长' }
      const draft = deepClone(load())
      draft.settings.amapKey = trimmed
      const saved = commit(draft)
      return { ok: true, hasAmapKey: trimmed !== '', rev: saved.rev }
    },

    /**
     * host 工具内部写计划（无 rev 前置，工具自己读-改-写）。
     *
     * @param {unknown} plan 计划
     * @returns {{ plan: object, rev: number }} 写入后的计划与 rev
     */
    setPlanInternal(plan) {
      const draft = deepClone(load())
      draft.plan = normalizePlan(plan)
      const saved = commit(draft)
      return { plan: deepClone(saved.plan), rev: saved.rev }
    },

    /**
     * host 工具内部写用餐记录（无 rev 前置）。
     *
     * @param {unknown} mealInput 记录
     * @returns {{ meal: object, state: object, rev: number }} 结果
     */
    upsertMealInternal(mealInput) {
      const draft = deepClone(load())
      const meal = normalizeMeal(mealInput, { now: now() })
      draft.meals = draft.meals
        .filter((item) => item.id !== meal.id && !(item.date === meal.date && item.meal === meal.meal))
        .concat(meal)
        .sort((a, b) => a.ts - b.ts)
      const saved = commit(draft)
      return { meal, state: deepClone(saved), rev: saved.rev }
    },

    /**
     * 当前完整状态下最近的用餐历史（供推荐内核排除）。
     *
     * @param {{ days?: number }} [options] 窗口
     * @returns {Array<{ dishId: string, date: string, meal: string }>} 历史
     */
    recentHistory(options = {}) {
      const days = Number.isInteger(options.days) ? options.days : 7
      const today = shanghaiDate(now())
      return load().meals
        .filter((meal) => meal.dishId !== '' && meal.date !== '')
        .filter((meal) => {
          const diff = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${meal.date}T00:00:00Z`)) / 86400000
          return diff >= 0 && diff < days
        })
        .map((meal) => ({ dishId: meal.dishId, date: meal.date, meal: meal.meal }))
    },
  }

  return store
}
