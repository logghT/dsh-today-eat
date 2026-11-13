/**
 * 「今天吃什么」v2 host 半 —— 7 个工具 + `/food` 命令（纯逻辑，deps 可注入）。
 *
 * 工具使用 dsh-tools 支持的 **raw JSON Schema 子集**：
 * type / properties / required / items / enum / const / oneOf / additionalProperties + description，
 * `type` 只能是单个字符串、`enum` 仅标量、`oneOf` 至少两个分支。
 * 每个工具必须返回 `output: { schema, render }`，execute 返回与 schema 匹配的结构化 JSON。
 *
 * 依赖注入：`createTools({ store, amap, core })`，测试可完全 stub；
 * 本文件不 import 任何官方 dsh 包（link 安装解析不到，会直接加载失败）。
 */

import {
  MEALS,
  PHASE_SUBGOALS,
  PHASES,
  SUBGOALS,
  TASTE_DEFAULTS,
  TASTE_DIMENSIONS,
  TASTE_LABELS,
  deepClone,
  defaultTargetsFor,
  isPlainObject,
  mealFromTimestamp,
  normalizeTasteProfile,
  shanghaiDate,
} from './state.js'
import { PHASE_META, SUBGOAL_META, canonicalPhaseKind } from '../src/core/phase.js'
import { buildFallbackQueries, phaseKeywords } from './amap.js'
import { referenceLinksOf } from '../src/core/reference.js'
import { DISHES } from '../data/dishes.js'

/** 7 个工具名（顺序固定）。 */
export const TOOL_NAMES = Object.freeze([
  'update_profile',
  'recommend_meal',
  'plan_week',
  'cook_plan',
  'find_nearby',
  'log_meal',
  'meal_stats',
])

/** 命令名（不带斜杠）。 */
export const COMMAND_NAME = 'food'

/** `/food` 返回文本上限（design-v2 §8：200 字内）。 */
const COMMAND_TEXT_LIMIT = 200

const MODES = ['home', 'out']
const REGIONS = ['西南', '华东', '华北', '华南', '华中', '西北', '东北']
const MEAL_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', night: '夜宵' }
const PHASE_LABELS = Object.fromEntries(PHASES.map((kind) => [kind, PHASE_META[kind].label]))
const PHASE_ENUM_HINT = PHASES.map((kind) => `${kind}（${PHASE_META[kind].label}）`).join(' / ')
const SUBGOAL_ENUM_HINT = SUBGOALS.map((subgoal) => `${subgoal}（${SUBGOAL_META[subgoal]?.label || subgoal}）`).join(' / ')

// ── 六维味道（taste-v1）──────────────────────────────────

/** core taste 模块惰性加载：feed-core 并行重写 src/core/taste.js，缺失/未就绪时用本地回退。 */
let tasteCorePromise = null

/**
 * 惰性加载 `src/core/taste.js`（六维 normalizeTaste / summarizeTaste / dishTasteOf）。
 *
 * @returns {Promise<object | null>} 模块命名空间或 null
 */
function loadTasteCore() {
  if (tasteCorePromise === null) {
    tasteCorePromise = (async () => {
      try {
        return await import('../src/core/taste.js')
      } catch {
        return null
      }
    })()
  }
  return tasteCorePromise
}

/**
 * 六维味道值格式：整数不带小数点，小数保留 1 位（如 4 / 3.2）。
 *
 * @param {unknown} value 值
 * @returns {string} 文本
 */
function formatTasteValue(value) {
  const number = Number(value)
  const normalized = Number.isFinite(number) ? Math.round(Math.min(5, Math.max(0, number)) * 10) / 10 : 0
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(1)
}

/**
 * 六维味道紧凑摘要（update_profile render）：`酸4 甜2 苦1 辣5 咸3 鲜4`。
 *
 * @param {unknown} input 原始味道偏好（可为旧字段）
 * @returns {string} 摘要
 */
export function formatTasteCompact(input) {
  const taste = normalizeTasteProfile(input)
  return TASTE_DIMENSIONS.map((id) => `${TASTE_LABELS[id]}${formatTasteValue(taste[id])}`).join(' ')
}

/**
 * 六维味道画像行（meal_stats render）：`酸 3.2 · 甜 2.1 · 苦 1.4 · 辣 4.1 · 咸 2.8 · 鲜 3.6`。
 *
 * @param {Array<{ id: string, label: string, value: number }>} dimensions 六维
 * @returns {string} 文本
 */
function formatTasteDimensions(dimensions) {
  return dimensions
    .map((dimension) => `${dimension.label} ${Number(dimension.value).toFixed(1)}`)
    .join(' · ')
}

/**
 * 档案里的六维偏好（已归一化）。
 *
 * @param {object} profile 档案
 * @returns {object} 六维偏好
 */
function preferenceTaste(profile) {
  return normalizeTasteProfile(asObject(asObject(profile).taste))
}

/**
 * 由六维值生成中文 summary（core 缺 summary 时兜底）。
 *
 * @param {Array<{ label: string, value: number }>} dimensions 六维
 * @returns {string} 摘要
 */
function buildTasteSummary(dimensions) {
  const high = dimensions.filter((dimension) => dimension.value >= 4).sort((left, right) => right.value - left.value)
  const top = (high.length > 0 ? high : [...dimensions].sort((left, right) => right.value - left.value))
    .filter((dimension) => dimension.value > 3)
    .slice(0, high.length > 0 ? 3 : 2)
  if (top.length === 0) return '口味均衡'
  return `偏爱：${top.map((dimension) => dimension.label).join('、')}`
}

/**
 * 无记录 / core 不可用时的六维回退：用档案偏好值，samples=0。
 *
 * @param {object} profile 档案
 * @param {number} [samples] 样本数
 * @returns {object} taste 输出
 */
function fallbackTaste(profile, samples = 0) {
  const preference = preferenceTaste(profile)
  const dimensions = TASTE_DIMENSIONS.map((id) => ({
    id,
    label: TASTE_LABELS[id],
    value: Math.round(preference[id] * 10) / 10,
    liked: 0,
    disliked: 0,
  }))
  return {
    samples,
    dimensions,
    summary: `偏好设置：${formatTasteCompact(preference)}`,
  }
}

/**
 * 把 core.summarizeTaste 结果投影成工具输出（六维齐全、值 1 位小数）。
 *
 * @param {unknown} source core 结果
 * @returns {object | null} taste 输出；结构不可识别时返回 null
 */
function projectTaste(source) {
  const value = asObject(source)
  const rawDimensions = Array.isArray(value.dimensions) ? value.dimensions.filter(isPlainObject) : []
  const byId = new Map()
  for (const dimension of rawDimensions) {
    if (typeof dimension.id === 'string') byId.set(dimension.id, dimension)
  }
  const samples = Number.isFinite(Number(value.samples)) ? Number(value.samples) : rawDimensions.length > 0 ? 1 : 0
  if (rawDimensions.length === 0 && typeof value.sour !== 'number' && typeof value.spicy !== 'number') {
    return null
  }
  const dimensions = TASTE_DIMENSIONS.map((id) => {
    const raw = byId.get(id) || {}
    const numeric = Number(raw.value !== undefined ? raw.value : value[id])
    return {
      id,
      label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : TASTE_LABELS[id],
      value: Number.isFinite(numeric) ? Math.round(Math.min(5, Math.max(0, numeric)) * 10) / 10 : TASTE_DEFAULTS[id],
      liked: Number.isFinite(Number(raw.liked)) ? Number(raw.liked) : 0,
      disliked: Number.isFinite(Number(raw.disliked)) ? Number(raw.disliked) : 0,
    }
  })
  const summary = typeof value.summary === 'string' && value.summary.trim() !== ''
    ? value.summary.trim()
    : buildTasteSummary(dimensions)
  return { samples, dimensions, summary }
}

/**
 * 统计口味画像：优先注入的 core.summarizeTaste，其次直接加载 src/core/taste.js，
 * 最后回退到档案偏好（samples=0，用于「还没有记录」场景）。
 *
 * @param {object} core 推荐内核
 * @param {{ meals: Array, catalog: Array, profile: object }} request 参数
 * @returns {Promise<object>} taste 输出
 */
async function summarizeTasteFor(core, request) {
  const { meals, catalog, profile } = request
  if (core && typeof core.summarizeTaste === 'function') {
    const result = await callCore(core, 'summarizeTaste', { meals, catalog, profile })
    if (isPlainObject(result) && !result.__error) {
      const projected = projectTaste(result)
      if (projected !== null) return projected
    }
  }
  const tasteModule = await loadTasteCore()
  if (tasteModule && typeof tasteModule.summarizeTaste === 'function') {
    try {
      const projected = projectTaste(await tasteModule.summarizeTaste(meals, catalog, profile))
      if (projected !== null) return projected
    } catch {
      // 回退到偏好
    }
  }
  return fallbackTaste(profile, 0)
}

// ── 可复用输出 schema ─────────────────────────────────────

const NULLABLE_STRING = { oneOf: [{ type: 'null' }, { type: 'string' }], description: '可为 null 的字符串' }
const NULLABLE_NUMBER = { oneOf: [{ type: 'null' }, { type: 'number' }], description: '可为 null 的数字' }

const DISH_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '一道菜',
  properties: {
    id: { type: 'string', description: '稳定菜品 id' },
    name: { type: 'string', description: '菜名' },
    emoji: { type: 'string', description: '展示 emoji' },
    cuisine: { type: 'string', description: '菜系' },
    price: { type: 'number', description: '人均价格（元）' },
    description: { type: 'string', description: '一句话中文卖点' },
  },
  required: ['id', 'name', 'emoji', 'cuisine', 'price', 'description'],
})

const NUTRITION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '营养估算',
  properties: {
    kcal: { type: 'number', description: '热量（kcal）' },
    protein: { type: 'number', description: '蛋白质（g）' },
    fat: { type: 'number', description: '脂肪（g）' },
    carbs: { type: 'number', description: '碳水（g）' },
    veg: { type: 'number', description: '蔬菜份数' },
  },
  required: ['kcal', 'protein', 'fat', 'carbs', 'veg'],
})

const SUMMARY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '饮食统计摘要',
  properties: {
    streak: { type: 'number', description: '连续记录天数' },
    loggedDays: { type: 'number', description: '有记录的天数' },
    repeatRate: { type: 'number', description: '重复率 0-1' },
    avgKcal: { type: 'number', description: '已记录餐次平均热量（kcal）' },
    avgProtein: { type: 'number', description: '已记录餐次平均蛋白质（g）' },
    adherence: { type: 'number', description: '营养依从度 0-1' },
    freeMealsUsed: { type: 'number', description: '已用自由餐次数' },
    topCuisines: {
      type: 'array',
      description: '常吃菜系（含出现次数）',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cuisine: { type: 'string', description: '菜系' },
          count: { type: 'number', description: '出现次数' },
        },
        required: ['cuisine', 'count'],
      },
    },
  },
  required: ['streak', 'loggedDays', 'repeatRate', 'avgKcal', 'avgProtein', 'adherence', 'freeMealsUsed', 'topCuisines'],
})

const MEAL_RECORD_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '一条用餐记录',
  properties: {
    id: { type: 'string', description: '记录 id' },
    date: { type: 'string', description: '日期 YYYY-MM-DD' },
    meal: { type: 'string', enum: [...MEALS], description: '餐次' },
    mode: { oneOf: [{ type: 'null' }, { type: 'string', enum: [...MODES] }], description: '自制/外食' },
    dishId: { type: 'string', description: '菜品 id' },
    dishName: { type: 'string', description: '菜名' },
    rating: { type: 'number', description: '评分：1 喜欢 / -1 不喜欢 / 0 中性' },
    note: { type: 'string', description: '备注' },
    kcal: NULLABLE_NUMBER,
    proteinG: NULLABLE_NUMBER,
  },
  required: ['id', 'date', 'meal', 'mode', 'dishId', 'dishName', 'rating', 'note', 'kcal', 'proteinG'],
})

const NEARBY_ITEM_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '周边餐厅',
  properties: {
    name: { type: 'string', description: '店名' },
    address: { type: 'string', description: '地址' },
    distance: { type: 'number', description: '距离（米）' },
    rating: NULLABLE_NUMBER,
    cost: NULLABLE_NUMBER,
    type: { type: 'string', description: '高德类型' },
    suggestion: { type: 'string', description: '点单建议：连锁品牌按公开菜单，查不到菜单的小店建议自行点单' },
  },
  required: ['name', 'address', 'distance', 'rating', 'cost', 'type', 'suggestion'],
})

const WEATHER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '今天的天气',
  properties: {
    date: { type: 'string', description: '日期' },
    dayWeather: { type: 'string', description: '白天天气' },
    nightWeather: { type: 'string', description: '夜间天气' },
    dayTemp: NULLABLE_NUMBER,
    nightTemp: NULLABLE_NUMBER,
    dayWind: { type: 'string', description: '风向' },
    dayPower: { type: 'string', description: '风力' },
  },
  required: ['date', 'dayWeather', 'nightWeather', 'dayTemp', 'nightTemp', 'dayWind', 'dayPower'],
})

// ── 通用小工具 ───────────────────────────────────────────

/**
 * 注入的当前时间戳。
 *
 * @param {object} deps 依赖
 * @returns {number} 时间戳
 */
function nowOf(deps) {
  if (deps && typeof deps.now === 'function') {
    const value = Number(deps.now())
    if (Number.isFinite(value)) return value
  }
  return Date.now()
}

/**
 * 把任意值收窄成普通对象。
 *
 * @param {unknown} value 候选
 * @returns {object} 对象
 */
function asObject(value) {
  return isPlainObject(value) ? value : {}
}

/**
 * 数组参数过滤成非空字符串列表。
 *
 * @param {unknown} value 候选
 * @returns {string[]} 字符串数组
 */
function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/**
 * 数字参数（有限数字才采用）。
 *
 * @param {unknown} value 候选
 * @returns {number | undefined} 数字
 */
function numberArg(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * 把数字夹到区间。
 *
 * @param {number} value 值
 * @param {number} min 最小
 * @param {number} max 最大
 * @returns {number} 结果
 */
function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 项目菜品为输出结构（缺字段补默认值；无 id 返回 null）。
 *
 * @param {unknown} dish 菜品
 * @returns {object | null} 输出菜品
 */
export function projectDish(dish) {
  if (!isPlainObject(dish)) return null
  const id = typeof dish.id === 'string' ? dish.id : ''
  if (id === '') return null
  return {
    id,
    name: typeof dish.name === 'string' && dish.name !== '' ? dish.name : id,
    emoji: typeof dish.emoji === 'string' && dish.emoji !== '' ? dish.emoji : '🍽️',
    cuisine: typeof dish.cuisine === 'string' ? dish.cuisine : '',
    price: Number.isFinite(Number(dish.price)) ? Number(dish.price) : 0,
    description: typeof dish.description === 'string' ? dish.description : '',
  }
}

/**
 * 项目营养估算（兼容 `proteinG` / `protein` 两种字段名）。
 *
 * @param {unknown} source 营养来源（dish.nutrition 或 result.nutrition）
 * @returns {object} 输出营养
 */
export function projectNutrition(source) {
  const value = asObject(source)
  const numberOrZero = (input) => (Number.isFinite(Number(input)) ? Number(input) : 0)
  return {
    kcal: numberOrZero(value.kcal),
    protein: numberOrZero(value.protein !== undefined ? value.protein : value.proteinG),
    fat: numberOrZero(value.fat),
    carbs: numberOrZero(value.carbs),
    veg: numberOrZero(value.veg),
  }
}

/**
 * 项目统计摘要。
 *
 * @param {unknown} source 统计来源
 * @returns {object} 输出摘要
 */
export function projectSummary(source) {
  const value = asObject(source)
  const numberOrZero = (input) => (Number.isFinite(Number(input)) ? Number(input) : 0)
  const rawCuisines = Array.isArray(value.topCuisines) ? value.topCuisines : []
  const topCuisines = rawCuisines
    .map((item) => {
      if (typeof item === 'string') return { cuisine: item, count: 0 }
      if (!isPlainObject(item)) return null
      const cuisine = typeof item.cuisine === 'string' ? item.cuisine : ''
      if (cuisine === '') return null
      return { cuisine, count: numberOrZero(item.count) }
    })
    .filter((item) => item !== null)
    .slice(0, 5)
  return {
    streak: numberOrZero(value.streak),
    loggedDays: numberOrZero(value.loggedDays),
    repeatRate: numberOrZero(value.repeatRate),
    avgKcal: numberOrZero(value.avgKcal),
    avgProtein: numberOrZero(value.avgProtein),
    adherence: numberOrZero(value.adherence),
    freeMealsUsed: numberOrZero(value.freeMealsUsed),
    topCuisines,
  }
}

/**
 * 把 topCuisines 渲染成「川菜×3、云南菜×2」。
 *
 * @param {Array<{ cuisine: string, count: number }>} topCuisines 菜系统计
 * @returns {string} 中文摘要（空数组返回空串）
 */
function formatTopCuisines(topCuisines) {
  if (!Array.isArray(topCuisines) || topCuisines.length === 0) return ''
  return topCuisines
    .map((item) => `${item.cuisine}×${item.count}`)
    .join('、')
}

/**
 * 项目周计划里的单餐。
 *
 * @param {object} meal 计划单餐
 * @returns {object} 输出单餐
 */
function projectPlanMeal(meal) {
  const source = asObject(meal)
  const dish = asObject(source.dish)
  return {
    meal: MEALS.includes(source.meal) ? source.meal : 'lunch',
    dishId: typeof dish.id === 'string' ? dish.id : typeof source.dishId === 'string' ? source.dishId : '',
    dishName: typeof dish.name === 'string' && dish.name !== ''
      ? dish.name
      : typeof source.dishName === 'string' ? source.dishName : '',
    mode: typeof source.mode === 'string' ? source.mode : 'home',
  }
}

/**
 * 找菜：优先 core.findDish，其次 core.catalog，退化为空。
 *
 * @param {object} core 推荐内核
 * @param {string} dishId 菜品 id
 * @returns {object | null} 菜品
 */
function findDish(core, dishId) {
  if (typeof dishId !== 'string' || dishId === '') return null
  try {
    if (core && typeof core.findDish === 'function') {
      const found = core.findDish(dishId)
      if (isPlainObject(found)) return found
    }
    const catalog = core && Array.isArray(core.catalog) ? core.catalog : []
    const found = catalog.find((dish) => isPlainObject(dish) && dish.id === dishId)
    return isPlainObject(found) ? found : null
  } catch {
    return null
  }
}

/**
 * 从完整状态生成近 7 天历史（供推荐排除）。
 *
 * @param {object} store 状态仓库
 * @param {number} ts 当前时间戳
 * @returns {Array<{ dishId: string, date: string, meal: string }>} 历史
 */
function recentHistory(store, ts) {
  try {
    if (store && typeof store.recentHistory === 'function') {
      const history = store.recentHistory({ now: ts, days: 7 })
      if (Array.isArray(history)) return history
    }
  } catch {
    // 退化到本地计算
  }
  const state = store && typeof store.getFullState === 'function' ? store.getFullState() : {}
  const today = shanghaiDate(ts)
  const todayMs = Date.parse(`${today}T00:00:00Z`)
  return (Array.isArray(state.meals) ? state.meals : [])
    .filter((meal) => typeof meal.dishId === 'string' && meal.dishId !== '' && typeof meal.date === 'string')
    .filter((meal) => {
      const diff = (todayMs - Date.parse(`${meal.date}T00:00:00Z`)) / 86400000
      return diff >= 0 && diff < 7
    })
    .map((meal) => ({ dishId: meal.dishId, date: meal.date, meal: meal.meal }))
}

/**
 * 读完整状态（store 未注入时给默认骨架，保证工具不崩）。
 *
 * @param {object} store 状态仓库
 * @returns {object} 完整状态
 */
function fullState(store) {
  if (store && typeof store.getFullState === 'function') return store.getFullState()
  return { profile: {}, phase: {}, meals: [], plan: null, settings: {} }
}

/**
 * 调 core 方法（缺失时返回 undefined），统一 await 同步/异步实现。
 *
 * @param {object} core 推荐内核
 * @param {string} name 方法名
 * @param {object} args 参数
 * @returns {Promise<unknown>} 结果
 */
async function callCore(core, name, args) {
  if (!core || typeof core[name] !== 'function') return undefined
  try {
    return await core[name](args)
  } catch (error) {
    return { __error: error && typeof error.message === 'string' ? error.message : String(error) }
  }
}

/**
 * 用最新 rev 重试一次 patch（工具内部写档案）。
 *
 * @param {object} store 状态仓库
 * @param {(state: object) => object} buildPatch 生成 patch
 * @returns {Promise<object>} patch 成功结果
 */
async function applyPatch(store, buildPatch) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = fullState(store)
    const patch = buildPatch(state)
    if (patch === null || Object.keys(patch).length === 0) return { ok: true, state, unchanged: true }
    const result = store.patch(state.rev, patch)
    if (result && result.ok === true) return result
    lastError = result
  }
  throw new Error(lastError && lastError.message ? lastError.message : '更新档案失败，请重试')
}

/**
 * 生成工具定义。
 *
 * @param {object} definition 定义
 * @returns {object} 工具定义
 */
function defineTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: definition.schema,
      render: definition.render,
    },
    execute: definition.execute,
  }
}

// ── 工具 1：update_profile ───────────────────────────────

const UPDATE_PROFILE_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    hometown: { type: 'string', description: '家乡（如 云南）' },
    city: { type: 'string', description: '常驻城市（如 成都）' },
    district: { type: 'string', description: '区县（如 锦江区）' },
    region: { type: 'string', enum: REGIONS, description: '大区' },
    sour: { type: 'number', description: '酸味偏好 0-5（柠檬/醋/酸汤）' },
    sweet: { type: 'number', description: '甜味偏好 0-5（糖/蜜/甜口）' },
    bitter: { type: 'number', description: '苦味偏好 0-5（苦瓜/苦荞/茶）' },
    spicy: { type: 'number', description: '辣味偏好 0-5（辣椒/花椒）' },
    salty: { type: 'number', description: '咸味偏好 0-5（腌制/卤味）' },
    umami: { type: 'number', description: '鲜味偏好 0-5（菌菇/海鲜/高汤）' },
    sourFruit: { type: 'number', description: '【兼容旧参数】果酸偏好 0-5，映射到 sour=max(...)' },
    sourFermented: { type: 'number', description: '【兼容旧参数】发酵酸偏好 0-5，映射到 sour=max(...)' },
    sourVinegar: { type: 'number', description: '【兼容旧参数】醋酸偏好 0-5，映射到 sour=max(...)' },
    oiliness: { type: 'number', description: '油腻接受度 0-5（非味道维度）' },
    adventurous: { type: 'number', description: '尝鲜意愿 0-5（非味道维度）' },
    vegetarian: { type: 'boolean', description: '是否素食' },
    allergies: { type: 'array', items: { type: 'string' }, description: '过敏原列表' },
    avoidTags: { type: 'array', items: { type: 'string' }, description: '忌口标签（如 香菜）' },
    budgetPerMealMin: { type: 'number', description: '单餐预算下限（元）' },
    budgetPerMealMax: { type: 'number', description: '单餐预算上限（元）' },
    weeklyBudget: { type: 'number', description: '每周餐饮预算（元）' },
    phaseKind: { type: 'string', enum: [...PHASES], description: `阶段：${PHASE_ENUM_HINT}` },
    phaseSubgoal: { type: 'string', enum: [...SUBGOALS], description: `阶段子目标：${SUBGOAL_ENUM_HINT}` },
    phaseWeeks: { type: 'number', description: '阶段持续周数' },
  },
})

const UPDATE_PROFILE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: '更新结果中文摘要' },
    fields: { type: 'array', items: { type: 'string' }, description: '已更新字段名' },
  },
  required: ['summary', 'fields'],
})

function createUpdateProfile(deps) {
  const { store, core } = deps
  return defineTool({
    name: 'update_profile',
    description: '更新饮食档案：家乡/城市/区县/大区、酸甜苦辣咸鲜六维口味、素食与忌口、预算、阶段类型与周数。所有参数可选，只传要改的字段。',
    parameters: UPDATE_PROFILE_PARAMETERS,
    schema: UPDATE_PROFILE_SCHEMA,
    async execute(args = {}) {
      const source = asObject(args)
      const state = fullState(store)
      const profile = deepClone(asObject(state.profile))
      const phase = deepClone(asObject(state.phase))
      const fields = []
      const identity = asObject(profile.identity)
      for (const key of ['hometown', 'city', 'district', 'region']) {
        if (typeof source[key] === 'string' && source[key].trim() !== '') {
          identity[key] = source[key].trim()
          fields.push(key)
        }
      }
      profile.identity = identity
      const taste = asObject(profile.taste)
      // 六维味道：sour 兼容旧参数（sourFruit/sourFermented/sourVinegar），取候选最大值
      const sourCandidates = [
        numberArg(source.sour),
        numberArg(source.sourFruit),
        numberArg(source.sourFermented),
        numberArg(source.sourVinegar),
      ].filter((value) => value !== undefined)
      if (sourCandidates.length > 0) {
        taste.sour = clampNumber(Math.round(Math.max(...sourCandidates) * 10) / 10, 0, 5)
        fields.push('sour')
      }
      for (const key of ['sweet', 'bitter', 'spicy', 'salty', 'umami']) {
        const value = numberArg(source[key])
        if (value !== undefined) {
          taste[key] = clampNumber(Math.round(value * 10) / 10, 0, 5)
          fields.push(key)
        }
      }
      // 非味道维度：油腻接受度 / 尝鲜意愿
      for (const key of ['oiliness', 'adventurous']) {
        const value = numberArg(source[key])
        if (value !== undefined) {
          taste[key] = clampNumber(Math.round(value), 0, 5)
          fields.push(key)
        }
      }
      profile.taste = taste
      const dietary = asObject(profile.dietary)
      if (typeof source.vegetarian === 'boolean') {
        dietary.vegetarian = source.vegetarian
        fields.push('vegetarian')
      }
      if (Array.isArray(source.allergies)) {
        dietary.allergies = stringList(source.allergies)
        fields.push('allergies')
      }
      if (Array.isArray(source.avoidTags)) {
        dietary.avoidTags = stringList(source.avoidTags)
        fields.push('avoidTags')
      }
      profile.dietary = dietary
      const budget = asObject(profile.budget)
      const perMeal = Array.isArray(budget.perMeal) ? [...budget.perMeal] : [15, 45]
      const budgetMin = numberArg(source.budgetPerMealMin)
      const budgetMax = numberArg(source.budgetPerMealMax)
      if (budgetMin !== undefined) {
        perMeal[0] = clampNumber(budgetMin, 0, 9999)
        fields.push('budgetPerMealMin')
      }
      if (budgetMax !== undefined) {
        perMeal[1] = clampNumber(budgetMax, 0, 9999)
        fields.push('budgetPerMealMax')
      }
      if (budgetMin !== undefined || budgetMax !== undefined) budget.perMeal = perMeal
      const weekly = numberArg(source.weeklyBudget)
      if (weekly !== undefined) {
        budget.weekly = clampNumber(weekly, 0, 99999)
        fields.push('weeklyBudget')
      }
      profile.budget = budget
      let phaseChanged = false
      const nextKind = canonicalPhaseKind(source.phaseKind)
      if (nextKind) {
        phase.kind = nextKind
        if (!PHASE_SUBGOALS[nextKind]?.includes(phase.subgoal)) phase.subgoal = PHASE_SUBGOALS[nextKind]?.[0] || null
        phaseChanged = true
        fields.push('phaseKind')
      }
      if (SUBGOALS.includes(source.phaseSubgoal) && PHASE_SUBGOALS[phase.kind]?.includes(source.phaseSubgoal)) {
        phase.subgoal = source.phaseSubgoal
        phaseChanged = true
        fields.push('phaseSubgoal')
      }
      const weeks = numberArg(source.phaseWeeks)
      if (weeks !== undefined) {
        phase.weeks = clampNumber(Math.round(weeks), 1, 52)
        phaseChanged = true
        fields.push('phaseWeeks')
      }
      if (phaseChanged) {
        const targets = await callCore(core, 'phaseTargets', { phase, profile })
        if (isPlainObject(targets) && !targets.__error) phase.targets = targets
        else phase.targets = defaultTargetsFor(phase.kind, phase.subgoal)
      }
      const patch = {}
      patch.profile = { identity, taste, dietary, budget }
      if (phaseChanged) patch.phase = phase
      await applyPatch(store, () => patch)
      const latestTaste = asObject(fullState(store).profile.taste)
      const tasteLine = `味道偏好：${formatTasteCompact(latestTaste)}`
      const summary = fields.length === 0
        ? `没有可更新的字段：可传 sour/sweet/bitter/spicy/salty/umami 等参数。\n${tasteLine}`
        : `已更新档案：${fields.join('、')}。当前阶段：${PHASE_LABELS[phase.kind] || phase.kind}${phase.subgoal ? `（${SUBGOAL_META[phase.subgoal]?.label || phase.subgoal}）` : ''}。\n${tasteLine}`
      return { summary, fields: fields.length === 0 ? [] : fields }
    },
    render(_args, value) {
      return [{ type: 'text', text: value.summary }]
    },
  })
}

// ── 工具 2：recommend_meal ───────────────────────────────

const RECOMMEND_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    meal: { type: 'string', enum: [...MEALS], description: '餐次；省略时按当前时间推断' },
    mode: { type: 'string', enum: ['home', 'out', 'any'], description: '自制/外食；any 不限' },
    phaseKind: { type: 'string', enum: [...PHASES], description: '指定阶段；省略用当前档案阶段' },
    excludeIds: { type: 'array', items: { type: 'string' }, description: '不要再推荐的菜品 id' },
    context: {
      type: 'object',
      additionalProperties: false,
      description: '可选上下文',
      properties: {
        weather: { type: 'string', description: '天气（如 小雨转阴）' },
        mood: { type: 'string', description: '心情/状态（如 想吃得清淡）' },
      },
    },
  },
})

/** 推荐结果输出 schema。 */
const RECOMMEND_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    date: { type: 'string', description: '推荐日期' },
    meal: { type: 'string', enum: [...MEALS], description: '餐次' },
    phaseKind: { type: 'string', description: '阶段类型' },
    mode: { type: 'string', description: '推荐方式' },
    reason: { type: 'string', description: '中文推荐理由' },
    dish: { oneOf: [DISH_SCHEMA, { type: 'null' }], description: '主推荐，无解为 null' },
    alternatives: { type: 'array', items: DISH_SCHEMA, description: '2-3 道备选' },
    nutrition: NUTRITION_SCHEMA,
    fallbackNote: NULLABLE_STRING,
  },
  required: ['date', 'meal', 'phaseKind', 'mode', 'reason', 'dish', 'alternatives', 'nutrition', 'fallbackNote'],
})

/**
 * 把 core.recommendMeal / getDailyPick 的结果投影成工具输出。
 *
 * @param {unknown} result core 结果
 * @param {{ date: string, meal: string, phaseKind: string, mode: string }} fallback 兜底值
 * @returns {object} 输出
 */
function projectRecommendation(result, fallback) {
  const source = asObject(result)
  const dish = projectDish(source.dish)
  const alternatives = Array.isArray(source.alternatives)
    ? source.alternatives.map(projectDish).filter((item) => item !== null).slice(0, 3)
    : []
  return {
    date: typeof source.date === 'string' && source.date !== '' ? source.date : fallback.date,
    meal: MEALS.includes(source.meal) ? source.meal : fallback.meal,
    phaseKind: typeof source.phaseKind === 'string' && source.phaseKind !== '' ? source.phaseKind : fallback.phaseKind,
    mode: typeof source.mode === 'string' && source.mode !== '' ? source.mode : fallback.mode,
    reason: typeof source.reason === 'string' ? source.reason : '',
    dish,
    alternatives,
    nutrition: projectNutrition(source.nutrition !== undefined ? source.nutrition : source.dish),
    fallbackNote: typeof source.fallbackNote === 'string' && source.fallbackNote !== '' ? source.fallbackNote : null,
  }
}

/**
 * 调推荐内核；新 API 缺失时回退到 v1 `getDailyPick`。
 *
 * @param {object} core 内核
 * @param {object} request 推荐请求
 * @returns {Promise<object>} 结果
 */
async function recommendFromCore(core, request) {
  if (core && typeof core.recommendMeal === 'function') {
    const result = await callCore(core, 'recommendMeal', request)
    if (isPlainObject(result) && !result.__error) return result
  }
  if (core && typeof core.getDailyPick === 'function') {
    const preferences = {}
    const dietary = asObject(asObject(request.profile).dietary)
    if (dietary.vegetarian === true) preferences.vegetarian = true
    const result = await callCore(core, 'getDailyPick', {
      date: request.date,
      meal: request.meal,
      preferences,
      history: request.history,
    })
    if (isPlainObject(result) && !result.__error) return result
  }
  return {}
}

function createRecommendMeal(deps) {
  const { store, core } = deps
  return defineTool({
    name: 'recommend_meal',
    description: '推荐今天吃什么：综合档案、饮食阶段（训练补给/少糖日常/清淡少盐/养胃/高纤维/多吃素/特殊时期/养身体/吃的高兴）、近 7 天记录与口味偏好，给出一道主推 + 2-3 道备选和营养估算。',
    parameters: RECOMMEND_PARAMETERS,
    schema: RECOMMEND_SCHEMA,
    async execute(args = {}) {
      const source = asObject(args)
      const ts = nowOf(deps)
      const state = fullState(store)
      const meal = MEALS.includes(source.meal) ? source.meal : mealFromTimestamp(ts)
      const phase = asObject(state.phase)
      const phaseKind = canonicalPhaseKind(source.phaseKind) ?? canonicalPhaseKind(phase.kind) ?? 'performance'
      const mode = source.mode === 'home' || source.mode === 'out' ? source.mode : undefined
      const date = shanghaiDate(ts)
      const excludeIds = stringList(source.excludeIds)
      const request = {
        date,
        meal,
        profile: asObject(state.profile),
        phase,
        phaseKind,
        history: recentHistory(store, ts),
        excludeIds,
        mode,
        context: asObject(source.context),
      }
      const result = await recommendFromCore(core, request)
      return projectRecommendation(result, { date, meal, phaseKind, mode: mode || 'any' })
    },
    render(_args, value) {
      const dish = value.dish
      if (dish === null) {
        return [{ type: 'text', text: `🍜 当前没有可推荐的菜${value.reason ? `：${value.reason}` : '，试试在设置里放宽忌口或预算。'}` }]
      }
      const nutrition = value.nutrition
      const lines = [
        `🍜 今天${MEAL_LABELS[value.meal] || '这一餐'}推荐：${dish.name}（${dish.cuisine || '家常'}，¥${dish.price}）`,
        `热量 ${nutrition.kcal} kcal · 蛋白 ${nutrition.protein} g`,
      ]
      if (value.reason !== '') lines.push(`理由：${value.reason}`)
      if (value.alternatives.length > 0) {
        lines.push(`备选：${value.alternatives.map((item) => item.name).join(' / ')}`)
      }
      if (value.fallbackNote) lines.push(`（${value.fallbackNote}）`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  })
}

// ── 工具 3：plan_week ────────────────────────────────────

const PLAN_WEEK_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    days: { type: 'number', description: '计划天数 1-14，默认 7' },
    meals: { type: 'array', items: { type: 'string', enum: [...MEALS] }, description: '要规划的餐次，默认午餐+晚餐' },
    phaseKind: { type: 'string', enum: [...PHASES], description: '按指定阶段规划' },
    regenerate: { type: 'boolean', description: 'true 时忽略已有计划重新生成' },
  },
})

const PLAN_WEEK_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { type: 'string', description: '开始日期' },
    seed: { type: 'number', description: '随机种子（同种子结果稳定）' },
    phaseKind: { type: 'string', description: '阶段类型' },
    days: {
      type: 'array',
      description: '每天的计划',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', description: '日期' },
          meals: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                meal: { type: 'string', enum: [...MEALS], description: '餐次' },
                dishId: { type: 'string', description: '菜品 id' },
                dishName: { type: 'string', description: '菜名' },
                mode: { type: 'string', description: '自制/外食' },
              },
              required: ['meal', 'dishId', 'dishName', 'mode'],
            },
          },
        },
        required: ['date', 'meals'],
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        avgKcal: { type: 'number', description: '每餐平均热量' },
        avgProtein: { type: 'number', description: '每餐平均蛋白' },
        uniqueDishes: { type: 'number', description: '不重复菜数' },
        cuisines: { type: 'array', items: { type: 'string' }, description: '涉及菜系' },
        estimatedCost: { type: 'number', description: '预估花费（元）' },
        freeMeals: { type: 'number', description: '自由餐次数' },
      },
      required: ['avgKcal', 'avgProtein', 'uniqueDishes', 'cuisines', 'estimatedCost', 'freeMeals'],
    },
  },
  required: ['start', 'seed', 'phaseKind', 'days', 'summary'],
})

/**
 * 由计划 picks 生成输出 days（旧计划复用 / 兜底）。
 *
 * @param {Array} picks 计划 picks
 * @param {object} core 内核
 * @returns {Array} days
 */
function daysFromPicks(picks, core) {
  const byDate = new Map()
  for (const pick of Array.isArray(picks) ? picks : []) {
    if (!isPlainObject(pick) || typeof pick.date !== 'string') continue
    if (!byDate.has(pick.date)) byDate.set(pick.date, [])
    const dish = findDish(core, pick.dishId)
    byDate.get(pick.date).push({
      meal: MEALS.includes(pick.meal) ? pick.meal : 'lunch',
      dishId: typeof pick.dishId === 'string' ? pick.dishId : '',
      dishName: isPlainObject(dish) && typeof dish.name === 'string' ? dish.name : typeof pick.dishId === 'string' ? pick.dishId : '',
      mode: typeof pick.mode === 'string' ? pick.mode : 'home',
    })
  }
  return [...byDate.entries()].map(([date, meals]) => ({ date, meals }))
}

/**
 * 从 days 计算计划摘要（复用旧计划时用）。
 *
 * @param {Array} days 输出 days
 * @param {object} core 内核
 * @returns {object} 摘要
 */
function summarizeDays(days, core) {
  let kcal = 0
  let protein = 0
  let cost = 0
  let count = 0
  const dishes = new Set()
  const cuisines = new Set()
  for (const day of days) {
    for (const meal of day.meals) {
      count += 1
      if (meal.dishId !== '') dishes.add(meal.dishId)
      const dish = findDish(core, meal.dishId)
      if (isPlainObject(dish)) {
        const nutrition = asObject(dish.nutrition)
        kcal += Number.isFinite(Number(nutrition.kcal)) ? Number(nutrition.kcal) : 0
        protein += Number.isFinite(Number(nutrition.protein)) ? Number(nutrition.protein) : 0
        cost += Number.isFinite(Number(dish.price)) ? Number(dish.price) : 0
        if (typeof dish.cuisine === 'string' && dish.cuisine !== '') cuisines.add(dish.cuisine)
      }
    }
  }
  const dayCount = Math.max(1, days.length)
  return {
    avgKcal: count > 0 ? Math.round(kcal / dayCount) : 0,
    avgProtein: count > 0 ? Math.round(protein / dayCount) : 0,
    uniqueDishes: dishes.size,
    cuisines: [...cuisines].slice(0, 8),
    estimatedCost: Math.round(cost),
    freeMeals: 0,
  }
}

function createPlanWeek(deps) {
  const { store, core } = deps
  return defineTool({
    name: 'plan_week',
    description: '生成本周饮食计划：默认未来 7 天午餐+晚餐，避开近 7 天吃过的菜、兼顾阶段营养与菜系多样性；已生成过则复用（regenerate=true 重新规划）。',
    parameters: PLAN_WEEK_PARAMETERS,
    schema: PLAN_WEEK_SCHEMA,
    async execute(args = {}) {
      const source = asObject(args)
      const ts = nowOf(deps)
      const state = fullState(store)
      const phase = asObject(state.phase)
      const today = shanghaiDate(ts)
      const daysRequested = numberArg(source.days) === undefined ? 7 : clampNumber(Math.round(numberArg(source.days)), 1, 14)
      const mealsRequested = Array.isArray(source.meals) && source.meals.length > 0
        ? [...new Set(source.meals.filter((meal) => MEALS.includes(meal)))]
        : ['lunch', 'dinner']
      const phaseKind = canonicalPhaseKind(source.phaseKind) ?? canonicalPhaseKind(phase.kind) ?? 'performance'
      const existing = asObject(state.plan)
      const existingPicks = Array.isArray(existing.picks) ? existing.picks : []
      if (source.regenerate !== true && existingPicks.length > 0) {
        const days = daysFromPicks(existingPicks, core)
        return {
          start: typeof existing.start === 'string' && existing.start !== '' ? existing.start : today,
          seed: Number.isFinite(Number(existing.seed)) ? Number(existing.seed) : 0,
          phaseKind,
          days,
          summary: summarizeDays(days, core),
        }
      }
      const request = {
        startDate: today,
        days: daysRequested,
        meals: mealsRequested,
        profile: asObject(state.profile),
        phase,
        phaseKind,
        history: recentHistory(store, ts),
        seed: Math.floor(ts / 86400000) % 100000,
        locked: asObject(existing.locked),
      }
      let result = await callCore(core, 'planWeek', request)
      if (!isPlainObject(result) || result.__error) result = {}
      let days = Array.isArray(result.days)
        ? result.days.map((day) => ({
          date: typeof day.date === 'string' ? day.date : today,
          meals: (Array.isArray(day.meals) ? day.meals : []).map(projectPlanMeal),
        }))
        : []
      let summary = isPlainObject(result.summary) ? result.summary : null
      if (days.length === 0) {
        // 内核不可用时的兜底：每天都用推荐结果拼一份简单计划（不中断工具）
        days = []
        for (let offset = 0; offset < daysRequested; offset += 1) {
          const date = shanghaiDate(ts + offset * 86400000)
          const meals = []
          for (const meal of mealsRequested) {
            const recommended = await recommendFromCore(core, {
              date,
              meal,
              profile: request.profile,
              phase,
              phaseKind,
              history: request.history,
              mode: undefined,
            })
            const dish = projectDish(recommended.dish)
            meals.push({
              meal,
              dishId: dish ? dish.id : '',
              dishName: dish ? dish.name : '',
              mode: 'home',
            })
            if (dish) request.history = request.history.concat({ dishId: dish.id, date, meal })
          }
          days.push({ date, meals })
        }
      }
      const summaryOut = summary === null ? summarizeDays(days, core) : {
        avgKcal: Number.isFinite(Number(summary.avgKcal)) ? Number(summary.avgKcal) : 0,
        avgProtein: Number.isFinite(Number(summary.avgProtein)) ? Number(summary.avgProtein) : 0,
        uniqueDishes: Number.isFinite(Number(summary.uniqueDishes)) ? Number(summary.uniqueDishes) : 0,
        cuisines: Array.isArray(summary.cuisines) ? summary.cuisines.filter((item) => typeof item === 'string') : [],
        estimatedCost: Number.isFinite(Number(summary.estimatedCost)) ? Number(summary.estimatedCost) : 0,
        freeMeals: Number.isFinite(Number(summary.freeMeals)) ? Number(summary.freeMeals) : 0,
      }
      const picks = []
      for (const day of days) {
        for (const meal of day.meals) {
          picks.push({ date: day.date, meal: meal.meal, dishId: meal.dishId, mode: meal.mode })
        }
      }
      const start = typeof result.start === 'string' && result.start !== '' ? result.start : today
      const seed = Number.isFinite(Number(result.seed)) ? Number(result.seed) : request.seed
      if (store && typeof store.setPlanInternal === 'function') {
        store.setPlanInternal({ start, seed, generatedAt: ts, locked: asObject(existing.locked), picks })
      }
      return { start, seed, phaseKind, days, summary: summaryOut }
    },
    render(_args, value) {
      const lines = [`📅 周计划（${value.start} 起，${value.days.length} 天）`]
      for (const day of value.days.slice(0, 14)) {
        const parts = day.meals.map((meal) => `${MEAL_LABELS[meal.meal] || ''} ${meal.dishName || meal.dishId || '待定'}`)
        lines.push(`${day.date.slice(5)} ${parts.join('；')}`)
      }
      const summary = value.summary
      lines.push(`每餐均 ${summary.avgKcal} kcal · 蛋白 ${summary.avgProtein} g · 不重复 ${summary.uniqueDishes} 道 · 预估 ¥${summary.estimatedCost}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  })
}

// ── 工具 4：cook_plan ────────────────────────────────────

const COOK_PLAN_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    dishId: { type: 'string', description: '要做菜的 id；省略则按当前餐次推荐一道可自制的菜' },
  },
})

const COOK_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    dishId: { type: 'string', description: '菜品 id' },
    dishName: { type: 'string', description: '菜名' },
    servings: { type: 'number', description: '几人份' },
    prepMin: { type: 'number', description: '备料分钟' },
    cookMin: { type: 'number', description: '烹饪分钟' },
    difficulty: { type: 'string', description: '难度' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '食材' },
          amount: { type: 'number', description: '数量' },
          unit: { type: 'string', description: '单位' },
          group: { type: 'string', description: '采买分区' },
        },
        required: ['name', 'amount', 'unit', 'group'],
      },
      description: '食材用量',
    },
    steps: { type: 'array', items: { type: 'string' }, description: '步骤' },
    tips: { type: 'array', items: { type: 'string' }, description: '小贴士' },
    shopping: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              group: { type: 'string', description: '分区' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', description: '食材' },
                    amount: { type: 'number', description: '数量' },
                    unit: { type: 'string', description: '单位' },
                  },
                  required: ['name', 'amount', 'unit'],
                },
              },
            },
            required: ['group', 'items'],
          },
        },
        estimatedCost: { type: 'number', description: '预估花费（元）' },
      },
      required: ['groups', 'estimatedCost'],
    },
    note: { type: 'string', description: '补充说明' },
  },
  required: ['dishId', 'dishName', 'servings', 'prepMin', 'cookMin', 'difficulty', 'ingredients', 'steps', 'tips', 'shopping', 'note'],
})

/**
 * 项目菜谱。
 *
 * @param {unknown} recipe 菜谱
 * @returns {object} 输出菜谱
 */
function projectRecipe(recipe) {
  const source = asObject(recipe)
  const ingredients = (Array.isArray(source.ingredients) ? source.ingredients : [])
    .filter((item) => isPlainObject(item) && typeof item.name === 'string' && item.name !== '')
    .map((item) => ({
      name: item.name,
      amount: Number.isFinite(Number(item.amount)) ? Number(item.amount) : 0,
      unit: typeof item.unit === 'string' && item.unit !== '' ? item.unit : '份',
      group: typeof item.group === 'string' && item.group !== '' ? item.group : '其他',
    }))
  return {
    dishId: typeof source.dishId === 'string' ? source.dishId : '',
    dishName: typeof source.name === 'string' ? source.name : '',
    servings: Number.isFinite(Number(source.servings)) ? Number(source.servings) : 1,
    prepMin: Number.isFinite(Number(source.prepMin)) ? Number(source.prepMin) : 0,
    cookMin: Number.isFinite(Number(source.cookMin)) ? Number(source.cookMin) : 0,
    difficulty: typeof source.difficulty === 'string' ? source.difficulty : '',
    ingredients,
    steps: (Array.isArray(source.steps) ? source.steps : []).filter((step) => typeof step === 'string' && step !== ''),
    tips: (Array.isArray(source.tips) ? source.tips : []).filter((tip) => typeof tip === 'string' && tip !== ''),
  }
}

/**
 * 项目采买清单。
 *
 * @param {unknown} shopping core.buildShoppingList 结果
 * @returns {object} 输出采买
 */
function projectShopping(shopping) {
  const source = asObject(shopping)
  const groups = (Array.isArray(source.groups) ? source.groups : [])
    .filter((group) => isPlainObject(group))
    .map((group) => ({
      group: typeof group.group === 'string' ? group.group : '其他',
      items: (Array.isArray(group.items) ? group.items : [])
        .filter((item) => isPlainObject(item) && typeof item.name === 'string')
        .map((item) => ({
          name: item.name,
          amount: Number.isFinite(Number(item.amount)) ? Number(item.amount) : 0,
          unit: typeof item.unit === 'string' && item.unit !== '' ? item.unit : '份',
        })),
    }))
    .filter((group) => group.items.length > 0)
  return {
    groups,
    estimatedCost: Number.isFinite(Number(source.estimatedCost)) ? Number(source.estimatedCost) : 0,
  }
}

function createCookPlan(deps) {
  const { store, core } = deps
  return defineTool({
    name: 'cook_plan',
    description: '自制菜方案：给出菜谱步骤、食材用量和菜市场采买清单（按分区/估算花费）。不传 dishId 时按当前餐次推荐一道可自制菜。',
    parameters: COOK_PLAN_PARAMETERS,
    schema: COOK_PLAN_SCHEMA,
    async execute(args = {}) {
      const source = asObject(args)
      const ts = nowOf(deps)
      const state = fullState(store)
      const profile = asObject(state.profile)
      const phase = asObject(state.phase)
      const phaseKind = canonicalPhaseKind(phase.kind) ?? 'performance'
      const meal = mealFromTimestamp(ts)
      let dishId = typeof source.dishId === 'string' ? source.dishId.trim() : ''
      let dishName = ''
      if (dishId !== '') {
        const known = findDish(core, dishId)
        if (isPlainObject(known) && typeof known.name === 'string') dishName = known.name
      } else {
        const recommended = await recommendFromCore(core, {
          date: shanghaiDate(ts),
          meal,
          profile,
          phase,
          phaseKind,
          history: recentHistory(store, ts),
          mode: 'home',
        })
        const dish = projectDish(recommended.dish)
        if (dish !== null) {
          dishId = dish.id
          dishName = dish.name
        }
      }
      if (dishId === '') {
        return {
          dishId: '',
          dishName: '',
          servings: 1,
          prepMin: 0,
          cookMin: 0,
          difficulty: '',
          ingredients: [],
          steps: [],
          tips: [],
          shopping: { groups: [], estimatedCost: 0 },
          note: '当前没有可推荐的自制菜，请先在设置里放宽忌口或预算，或直接指定 dishId。',
        }
      }
      let recipe = await callCore(core, 'recipeForDish', dishId)
      if (!isPlainObject(recipe) || recipe.__error) recipe = null
      const projected = projectRecipe(recipe || {})
      if (dishName === '' && projected.dishName !== '') dishName = projected.dishName
      let shopping = { groups: [], estimatedCost: 0 }
      if (isPlainObject(recipe)) {
        const rawShopping = await callCore(core, 'buildShoppingList', {
          plan: { picks: [{ date: shanghaiDate(ts), meal, dishId, mode: 'home' }] },
          days: 1,
          servings: 1,
          profile,
          phase,
          // catalog 用于从 dishId 补价格（estimatedCost）；recipes 用于聚合食材用量
          catalog: DISHES,
          recipes: [recipe],
        })
        shopping = projectShopping(rawShopping)
        if (shopping.groups.length === 0 && projected.ingredients.length > 0) {
          const groups = new Map()
          for (const ingredient of projected.ingredients) {
            if (!groups.has(ingredient.group)) groups.set(ingredient.group, [])
            groups.get(ingredient.group).push({ name: ingredient.name, amount: ingredient.amount, unit: ingredient.unit })
          }
          shopping = {
            groups: [...groups.entries()].map(([group, items]) => ({ group, items })),
            estimatedCost: 0,
          }
        }
      }
      const note = isPlainObject(recipe)
        ? ''
        : '没有找到这道菜的菜谱（recipeId 可能缺失），可以先做别的自制菜。'
      return {
        dishId,
        dishName: dishName !== '' ? dishName : dishId,
        servings: projected.servings,
        prepMin: projected.prepMin,
        cookMin: projected.cookMin,
        difficulty: projected.difficulty,
        ingredients: projected.ingredients,
        steps: projected.steps,
        tips: projected.tips,
        shopping,
        note,
      }
    },
    render(_args, value) {
      const lines = [`🍳 自制：${value.dishName || value.dishId}`]
      if (value.steps.length > 0) {
        lines.push(`备料 ${value.prepMin} 分钟 + 烹饪 ${value.cookMin} 分钟${value.difficulty ? `（${value.difficulty}）` : ''}`)
        value.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`))
      } else if (value.note !== '') {
        lines.push(value.note)
      }
      if (value.tips.length > 0) lines.push(`小贴士：${value.tips.join('；')}`)
      const refs = referenceLinksOf(value.dishName || value.dishId)
      if (refs.length > 0) lines.push(`参考做法（外部搜索）：${refs.map((link) => `${link.label} ${link.url}`).join(' · ')}`)
      if (value.shopping.groups.length > 0) {
        const shoppingText = value.shopping.groups
          .map((group) => `${group.group}：${group.items.map((item) => `${item.name}${item.amount}${item.unit}`).join('、')}`)
          .join('；')
        lines.push(`🛒 采买：${shoppingText}`)
        if (value.shopping.estimatedCost > 0) lines.push(`预估花费约 ¥${value.shopping.estimatedCost}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  })
}

// ── 工具 5：find_nearby ─────────────────────────────────

const FIND_NEARBY_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    meal: { type: 'string', enum: [...MEALS], description: '餐次；省略按当前时间' },
    radius: { type: 'number', description: '搜索半径（米），默认 1500' },
    keywords: { type: 'array', items: { type: 'string' }, description: '关键词（省略时按阶段生成）' },
  },
})

const FIND_NEARBY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: '是否成功拿到结果' },
    code: NULLABLE_STRING,
    message: { type: 'string', description: '提示信息' },
    items: { type: 'array', items: NEARBY_ITEM_SCHEMA, description: '附近餐厅' },
    suggestions: { type: 'array', items: { type: 'string' }, description: '点单建议' },
    weather: { oneOf: [WEATHER_SCHEMA, { type: 'null' }], description: '天气' },
    fallbackQueries: { type: 'array', items: { type: 'string' }, description: '无 Key 时的兜底搜索词' },
  },
  required: ['ok', 'code', 'message', 'items', 'suggestions', 'weather', 'fallbackQueries'],
})

/**
 * 把 amap POI 项目成输出结构。
 *
 * @param {unknown} items POI 列表
 * @returns {Array} 输出列表
 */
function projectNearbyItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => isPlainObject(item) && typeof item.name === 'string')
    .slice(0, 10)
    .map((item) => ({
      name: item.name,
      address: typeof item.address === 'string' ? item.address : '',
      distance: Number.isFinite(Number(item.distance)) ? Number(item.distance) : 0,
      rating: Number.isFinite(Number(item.rating)) ? Number(item.rating) : null,
      cost: Number.isFinite(Number(item.cost)) ? Number(item.cost) : null,
      type: typeof item.type === 'string' ? item.type : '',
      suggestion: typeof item.suggestion === 'string' ? item.suggestion : '',
    }))
}

/**
 * 项目天气。
 *
 * @param {unknown} weather 天气
 * @returns {object | null} 输出天气
 */
function projectWeather(weather) {
  if (!isPlainObject(weather)) return null
  return {
    date: typeof weather.date === 'string' ? weather.date : '',
    dayWeather: typeof weather.dayWeather === 'string' ? weather.dayWeather : '',
    nightWeather: typeof weather.nightWeather === 'string' ? weather.nightWeather : '',
    dayTemp: Number.isFinite(Number(weather.dayTemp)) ? Number(weather.dayTemp) : null,
    nightTemp: Number.isFinite(Number(weather.nightTemp)) ? Number(weather.nightTemp) : null,
    dayWind: typeof weather.dayWind === 'string' ? weather.dayWind : '',
    dayPower: typeof weather.dayPower === 'string' ? weather.dayPower : '',
  }
}

function createFindNearby(deps) {
  const { store, amap } = deps
  return defineTool({
    name: 'find_nearby',
    description: '找附近餐厅并给点单建议（高德周边搜索 + 今天天气）。没配高德 Key 时返回可复制的兜底搜索词，不报错。',
    parameters: FIND_NEARBY_PARAMETERS,
    schema: FIND_NEARBY_SCHEMA,
    async execute(args = {}) {
      const source = asObject(args)
      const ts = nowOf(deps)
      const state = fullState(store)
      const profile = asObject(state.profile)
      const phase = asObject(state.phase)
      const identity = asObject(profile.identity)
      const phaseKind = canonicalPhaseKind(phase.kind) ?? 'performance'
      const meal = MEALS.includes(source.meal) ? source.meal : mealFromTimestamp(ts)
      const radiusRaw = numberArg(source.radius)
      const radius = radiusRaw === undefined ? 1500 : clampNumber(Math.round(radiusRaw), 100, 5000)
      const keywords = Array.isArray(source.keywords) && source.keywords.length > 0
        ? stringList(source.keywords).slice(0, 5)
        : undefined
      const queries = buildFallbackQueries({ profile, phaseKind, keywords: keywords || phaseKeywords(phaseKind), meal })
      const key = store && typeof store.getAmapKey === 'function' ? store.getAmapKey() : ''
      if (key === '') {
        return {
          ok: false,
          code: 'amap-key-missing',
          message: '还没有配置高德 Key：让用户在「今天吃什么 → 设置」里填写，或先用兜底搜索词。',
          items: [],
          suggestions: [],
          weather: null,
          fallbackQueries: queries,
        }
      }
      const lng = Number(identity.lng)
      const lat = Number(identity.lat)
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return {
          ok: false,
          code: 'location-missing',
          message: '档案里缺少经纬度，请先设置城市。',
          items: [],
          suggestions: [],
          weather: null,
          fallbackQueries: queries,
        }
      }
      let search
      try {
        if (!amap || typeof amap.searchNearby !== 'function') throw new Error('amap-unavailable')
        const budget = asObject(profile.budget)
        const maxCost = Array.isArray(budget.perMeal) && Number.isFinite(Number(budget.perMeal[1]))
          ? Number(budget.perMeal[1])
          : undefined
        search = await amap.searchNearby({ key, lng, lat, keywords: keywords || phaseKeywords(phaseKind), radius, maxCost, phase: phaseKind, profile })
      } catch (error) {
        return {
          ok: false,
          code: 'amap-request-failed',
          message: '高德请求失败，请稍后重试。',
          items: [],
          suggestions: [],
          weather: null,
          fallbackQueries: queries,
        }
      }
      if (!search || search.ok !== true) {
        return {
          ok: false,
          code: search && typeof search.code === 'string' ? search.code : 'amap-request-failed',
          message: search && typeof search.message === 'string' ? search.message : '高德请求失败。',
          items: [],
          suggestions: [],
          weather: null,
          fallbackQueries: Array.isArray(search && search.fallbackQueries) ? search.fallbackQueries : queries,
        }
      }
      let weatherValue = null
      try {
        if (amap && typeof amap.weather === 'function') {
          const weatherResult = await amap.weather({ key, adcode: identity.adcode })
          if (weatherResult && weatherResult.ok === true) weatherValue = projectWeather(weatherResult.weather)
        }
      } catch {
        weatherValue = null
      }
      return {
        ok: true,
        code: null,
        message: '',
        items: projectNearbyItems(search.items),
        suggestions: Array.isArray(search.suggestions) ? search.suggestions.filter((item) => typeof item === 'string') : [],
        weather: weatherValue,
        fallbackQueries: [],
      }
    },
    render(_args, value) {
      if (value.ok !== true) {
        const lines = [`📍 ${value.message}`]
        if (value.fallbackQueries.length > 0) lines.push(`可以这样搜：${value.fallbackQueries.join(' / ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      }
      const lines = []
      if (value.weather !== null) {
        lines.push(`🌤 今天 ${value.weather.dayWeather}，${value.weather.nightTemp}~${value.weather.dayTemp}℃`)
      }
      lines.push(`📍 附近推荐 ${value.items.length} 家：`)
      for (const item of value.items) {
        const rating = item.rating === null ? '' : `${item.rating}分 `
        const cost = item.cost === null ? '' : ` ¥${item.cost}`
        lines.push(`· ${item.name} ${rating}${item.distance}m${cost}`)
        if (typeof item.suggestion === 'string' && item.suggestion !== '') lines.push(`  点单：${item.suggestion}`)
      }
      if (value.suggestions.length > 0) lines.push(`说明：${value.suggestions[0]}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  })
}

// ── 工具 6：log_meal ────────────────────────────────────

const LOG_MEAL_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    dishId: { type: 'string', description: '菜品 id（可省略）' },
    dishName: { type: 'string', description: '菜名（可省略）' },
    meal: { type: 'string', enum: [...MEALS], description: '餐次；省略按当前时间' },
    mode: { type: 'string', enum: [...MODES], description: 'home 自制 / out 外食' },
    rating: { type: 'number', enum: [-1, 0, 1], description: '1 喜欢 / -1 不喜欢 / 0 中性' },
    note: { type: 'string', description: '备注' },
  },
})

const LOG_MEAL_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    logged: { type: 'boolean', description: '是否记录成功' },
    meal: MEAL_RECORD_SCHEMA,
    summary: SUMMARY_SCHEMA,
  },
  required: ['logged', 'meal', 'summary'],
})

/**
 * 项目用餐记录。
 *
 * @param {unknown} meal 记录
 * @returns {object} 输出记录
 */
function projectMealRecord(meal) {
  const source = asObject(meal)
  return {
    id: typeof source.id === 'string' ? source.id : '',
    date: typeof source.date === 'string' ? source.date : '',
    meal: MEALS.includes(source.meal) ? source.meal : 'lunch',
    mode: MODES.includes(source.mode) ? source.mode : null,
    dishId: typeof source.dishId === 'string' ? source.dishId : '',
    dishName: typeof source.dishName === 'string' ? source.dishName : '',
    rating: Number.isFinite(Number(source.rating)) ? Number(source.rating) : 0,
    note: typeof source.note === 'string' ? source.note : '',
    kcal: Number.isFinite(Number(source.kcal)) ? Number(source.kcal) : null,
    proteinG: Number.isFinite(Number(source.proteinG)) ? Number(source.proteinG) : null,
  }
}

/**
 * 调 core.summarizeMeals；内核缺失时用本地兜底统计。
 *
 * @param {object} core 内核
 * @param {{ meals: Array, phase: object, profile: object, today: string }} request 参数
 * @returns {Promise<object>} 输出摘要
 */
async function summarizeWithCore(core, request) {
  const result = await callCore(core, 'summarizeMeals', request)
  if (isPlainObject(result) && !result.__error) return projectSummary(result)
  return localSummary(request.meals, request.phase, request.today)
}

/**
 * 本地兜底统计（core 缺 summarizeMeals 时使用）。
 *
 * @param {Array} meals 记录
 * @param {object} phase 阶段
 * @param {string} today 今天
 * @returns {object} 输出摘要
 */
function localSummary(meals, phase, today) {
  const list = Array.isArray(meals) ? meals.filter(isPlainObject) : []
  const dates = [...new Set(list.map((meal) => meal.date).filter((date) => typeof date === 'string'))].sort()
  const dishIds = list.map((meal) => meal.dishId).filter((id) => typeof id === 'string' && id !== '')
  const unique = new Set(dishIds)
  const totalKcal = list.reduce((sum, meal) => sum + (Number(meal.kcal) || 0), 0)
  const totalProtein = list.reduce((sum, meal) => sum + (Number(meal.proteinG) || 0), 0)
  const loggedDays = dates.length
  let streak = 0
  if (dates.length > 0) {
    const todayMs = Date.parse(`${today}T00:00:00Z`)
    let cursor = todayMs
    const set = new Set(dates)
    while (set.has(new Date(cursor).toISOString().slice(0, 10))) {
      streak += 1
      cursor -= 86400000
    }
  }
  const targets = asObject(asObject(phase).targets)
  const kcalMin = Number(targets.kcalMin) || 0
  const kcalMax = Number(targets.kcalMax) || 0
  const avgKcal = loggedDays > 0 ? Math.round(totalKcal / loggedDays) : 0
  const adherence = kcalMin > 0 && kcalMax > 0 && avgKcal >= kcalMin && avgKcal <= kcalMax ? 1 : 0
  return {
    streak,
    loggedDays,
    repeatRate: dishIds.length > 0 ? Math.max(0, 1 - unique.size / dishIds.length) : 0,
    avgKcal,
    avgProtein: loggedDays > 0 ? Math.round(totalProtein / loggedDays) : 0,
    adherence,
    freeMealsUsed: 0,
    topCuisines: [],
  }
}

function createLogMeal(deps) {
  const { store, core } = deps
  return defineTool({
    name: 'log_meal',
    description: '记录一餐（自制或外食，可评分+备注），写入长期状态并返回最新统计摘要。用户说「我吃了/刚吃完」时调用。',
    parameters: LOG_MEAL_PARAMETERS,
    schema: LOG_MEAL_SCHEMA,
    async execute(args = {}) {
      const source = asObject(args)
      const ts = nowOf(deps)
      const state = fullState(store)
      const meal = MEALS.includes(source.meal) ? source.meal : mealFromTimestamp(ts)
      let dishId = typeof source.dishId === 'string' ? source.dishId.trim() : ''
      let dishName = typeof source.dishName === 'string' ? source.dishName.trim() : ''
      const known = findDish(core, dishId)
      const nutrition = asObject(known && known.nutrition)
      if (dishName === '' && isPlainObject(known) && typeof known.name === 'string') dishName = known.name
      const kcal = Number.isFinite(Number(nutrition.kcal)) ? Number(nutrition.kcal) : null
      const proteinG = Number.isFinite(Number(nutrition.protein)) ? Number(nutrition.protein) : null
      const ratingRaw = numberArg(source.rating)
      const rating = ratingRaw === 1 || ratingRaw === -1 ? ratingRaw : 0
      const input = {
        ts,
        date: shanghaiDate(ts),
        meal,
        mode: MODES.includes(source.mode) ? source.mode : null,
        dishId,
        dishName: dishName !== '' ? dishName : dishId,
        rating,
        note: typeof source.note === 'string' ? source.note : '',
        kcal,
        proteinG,
      }
      let saved = null
      if (store && typeof store.upsertMealInternal === 'function') saved = store.upsertMealInternal(input)
      const mealRecord = projectMealRecord(saved && saved.meal ? saved.meal : input)
      const updated = saved && saved.state ? saved.state : fullState(store)
      const summary = await summarizeWithCore(core, {
        meals: Array.isArray(updated.meals) ? updated.meals : [],
        phase: asObject(updated.phase),
        profile: asObject(updated.profile),
        today: shanghaiDate(ts),
      })
      return { logged: saved !== null, meal: mealRecord, summary }
    },
    render(_args, value) {
      const meal = value.meal
      const summary = value.summary
      const mode = meal.mode === 'home' ? '自制' : meal.mode === 'out' ? '外食' : ''
      return [{
        type: 'text',
        text: `✅ 已记录${MEAL_LABELS[meal.meal] || ''}：${meal.dishName || '一餐'}${mode ? `（${mode}）` : ''}\n`
          + `连续记录 ${summary.streak} 天 · 7 天不重样率 ${Math.round((1 - summary.repeatRate) * 100)}% · 已记录餐次均 ${summary.avgKcal} kcal / 蛋白 ${summary.avgProtein} g`,
      }]
    },
  })
}

// ── 工具 7：meal_stats ──────────────────────────────────

const MEAL_STATS_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    days: { type: 'number', description: '统计窗口天数 1-90，默认 7' },
  },
})

const TASTE_DIMENSION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '单个味道维度',
  properties: {
    id: { type: 'string', enum: [...TASTE_DIMENSIONS], description: '维度 id' },
    label: { type: 'string', description: '中文标签（酸/甜/苦/辣/咸/鲜）' },
    value: { type: 'number', description: '画像值 0-5（1 位小数）' },
    liked: { type: 'number', description: '该维度上「喜欢」的次数' },
    disliked: { type: 'number', description: '该维度上「不喜欢」的次数' },
  },
  required: ['id', 'label', 'value', 'liked', 'disliked'],
})

const TASTE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description: '六维口味画像',
  properties: {
    dimensions: { type: 'array', items: TASTE_DIMENSION_SCHEMA, description: '酸/甜/苦/辣/咸/鲜 六维' },
    samples: { type: 'number', description: '参与统计的用餐记录数（0 = 尚未记录，回退偏好）' },
    summary: { type: 'string', description: '中文摘要（如 偏爱：酸、辣、鲜）' },
  },
  required: ['dimensions', 'samples', 'summary'],
})

const MEAL_STATS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    days: { type: 'number', description: '统计窗口天数' },
    summary: SUMMARY_SCHEMA,
    taste: TASTE_SCHEMA,
  },
  required: ['days', 'summary', 'taste'],
})

function createMealStats(deps) {
  const { store, core } = deps
  return defineTool({
    name: 'meal_stats',
    description: '饮食统计：连续记录天数、7 天不重样率、营养依从、自由餐次数与口味画像。用户问「最近吃得怎么样/统计一下」时调用。',
    parameters: MEAL_STATS_PARAMETERS,
    schema: MEAL_STATS_SCHEMA,
    async execute(args = {}) {
      const source = asObject(args)
      const ts = nowOf(deps)
      const state = fullState(store)
      const today = shanghaiDate(ts)
      const daysRaw = numberArg(source.days)
      const days = daysRaw === undefined ? 7 : clampNumber(Math.round(daysRaw), 1, 90)
      const todayMs = Date.parse(`${today}T00:00:00Z`)
      const meals = (Array.isArray(state.meals) ? state.meals : []).filter((meal) => {
        if (!isPlainObject(meal) || typeof meal.date !== 'string') return false
        const diff = (todayMs - Date.parse(`${meal.date}T00:00:00Z`)) / 86400000
        return diff >= 0 && diff < days
      })
      const summary = await summarizeWithCore(core, {
        meals,
        phase: asObject(state.phase),
        profile: asObject(state.profile),
        today,
        days,
      })
      const profile = asObject(state.profile)
      const catalog = core && Array.isArray(core.catalog) && core.catalog.length > 0 ? core.catalog : DISHES
      const taste = await summarizeTasteFor(core, { meals, catalog, profile })
      return { days, summary, taste }
    },
    render(_args, value) {
      const summary = value.summary
      const taste = value.taste
      const cuisines = formatTopCuisines(summary.topCuisines)
      const tasteLine = `口味画像：${formatTasteDimensions(taste.dimensions)}`
      const tasteHint = taste.samples === 0
        ? '（还没有记录，先显示你的偏好设置）'
        : taste.summary !== '' ? taste.summary : ''
      return [{
        type: 'text',
        text: `📊 最近 ${value.days} 天：记录 ${summary.loggedDays} 天 · 连续 ${summary.streak} 天 · 重复率 ${Math.round(summary.repeatRate * 100)}% · 已记录餐次均 ${summary.avgKcal} kcal / 蛋白 ${summary.avgProtein} g\n`
          + tasteLine
          + (tasteHint !== '' ? `\n${tasteHint}` : '')
          + (cuisines !== '' ? `\n常吃菜系：${cuisines}` : ''),
      }]
    },
  })
}

// ── /food 命令与对外工厂 ─────────────────────────────────

/**
 * 今天日期（注入时间）。
 *
 * @param {object} deps 依赖
 * @returns {string} 日期
 */
function todayOf(deps) {
  return shanghaiDate(nowOf(deps))
}

/**
 * 截断命令文本到 200 字内。
 *
 * @param {string} text 文本
 * @returns {string} 截断结果
 */
export function truncateCommandText(text) {
  const source = typeof text === 'string' ? text : ''
  const singleLine = source.replace(/\s*\n+\s*/g, ' · ').trim()
  if (singleLine.length <= COMMAND_TEXT_LIMIT) return singleLine
  return `${singleLine.slice(0, COMMAND_TEXT_LIMIT - 1)}…`
}

/**
 * `/food` 命令的纯逻辑：返回纯文本（≤200 字）。
 *
 * @param {string} rawInput 斜杠命令后的原始文本
 * @param {object} deps 依赖
 * @returns {Promise<string>} 文本
 */
export async function runFoodCommand(rawInput, deps) {
  const tools = createTools(deps)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const input = typeof rawInput === 'string' ? rawInput.trim() : ''
  const invoke = async (name, args) => {
    const tool = byName.get(name)
    const value = await tool.execute(args, {})
    return { value, text: tool.output.render(args, value).map((block) => block.text || '').join('\n') }
  }
  try {
    if (/(附近|周边|外食|外面吃)/.test(input)) {
      const { value, text } = await invoke('find_nearby', {})
      if (value.ok === true) {
        const names = value.items.slice(0, 3).map((item) => item.name).join('、')
        const weather = value.weather ? `今天${value.weather.dayWeather}，` : ''
        return truncateCommandText(`📍 ${weather}附近推荐：${names || '暂无高分餐厅'}${value.suggestions[0] ? ` · ${value.suggestions[0]}` : ''}`)
      }
      return truncateCommandText(`📍 ${value.message} ${value.fallbackQueries.slice(0, 2).join(' / ')}`)
    }
    if (/(周计划|本周|一周|计划)/.test(input)) {
      const { value } = await invoke('plan_week', {})
      const first = value.days[0]
      const dishes = first ? first.meals.map((meal) => `${MEAL_LABELS[meal.meal] || ''}${meal.dishName}`).join('、') : '暂无'
      return truncateCommandText(`📅 本周计划已就绪（${value.start} 起）：${dishes} · 每餐均 ${value.summary.avgKcal} kcal，预估 ¥${value.summary.estimatedCost}`)
    }
    if (/(自己做|自制|菜谱|下厨|自己煮)/.test(input)) {
      const { value } = await invoke('cook_plan', {})
      if (value.steps.length === 0) return truncateCommandText(`🍳 ${value.note || '暂时没有可做的菜'}`)
      const shoppingCount = value.shopping.groups.reduce((sum, group) => sum + group.items.length, 0)
      return truncateCommandText(`🍳 今天自己做 ${value.dishName}：${value.prepMin + value.cookMin} 分钟 · ${value.steps.length} 步 · 采买 ${shoppingCount} 样${value.shopping.estimatedCost > 0 ? `（约 ¥${value.shopping.estimatedCost}）` : ''}`)
    }
    if (/(统计|记录|数据|怎么样)/.test(input)) {
      const { value } = await invoke('meal_stats', { days: 7 })
      return truncateCommandText(`📊 最近 ${value.days} 天：记录 ${value.summary.loggedDays} 天 · 连续 ${value.summary.streak} 天 · 重复率 ${Math.round(value.summary.repeatRate * 100)}% · 已记录餐次均 ${value.summary.avgKcal} kcal / 蛋白 ${value.summary.avgProtein} g`)
    }
    const { value } = await invoke('recommend_meal', {})
    if (value.dish === null) return truncateCommandText(`🍜 ${value.reason || '当前没有可推荐的菜，试试放宽忌口/预算。'}`)
    const alternatives = value.alternatives.slice(0, 2).map((dish) => dish.name).join(' / ')
    return truncateCommandText(`🍜 今天${MEAL_LABELS[value.meal] || ''}推荐：${value.dish.name}（${value.dish.cuisine}，¥${value.dish.price}）${alternatives ? `；备选 ${alternatives}` : ''}`)
  } catch (error) {
    return truncateCommandText(`饮食管家暂时不可用${error && error.message ? `：${error.message}` : ''}`)
  }
}

/**
 * 构造 `/food` 斜杠命令定义。
 *
 * @param {object} deps 依赖
 * @returns {object} 命令定义
 */
export function createCommandDefinition(deps) {
  return {
    name: COMMAND_NAME,
    description: '今天吃什么：今日推荐 / 附近餐厅 / 周计划 / 自己做 / 饮食统计',
    input: { hint: '[附近|周计划|自己做|统计] 均可省略' },
    handler: async (invocation) => {
      const rawInput = invocation && typeof invocation.rawInput === 'string' ? invocation.rawInput : ''
      const text = await runFoodCommand(rawInput, deps)
      return { kind: 'success', text }
    },
  }
}

/**
 * 创建 7 个工具定义（顺序与 TOOL_NAMES 一致）。
 *
 * @param {{ store: object, amap: object, core: object, now?: () => number }} deps 依赖
 * @returns {object[]} 工具定义
 */
export function createTools(deps = {}) {
  if (!deps || typeof deps !== 'object') throw new TypeError('createTools 需要注入 { store, amap, core }')
  if (!deps.store) throw new TypeError('createTools 需要注入 store')
  const normalized = {
    store: deps.store,
    amap: deps.amap || {},
    core: deps.core || {},
    now: deps.now,
  }
  return [
    createUpdateProfile(normalized),
    createRecommendMeal(normalized),
    createPlanWeek(normalized),
    createCookPlan(normalized),
    createFindNearby(normalized),
    createLogMeal(normalized),
    createMealStats(normalized),
  ]
}
