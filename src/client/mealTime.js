/**
 * 「今天吃什么」client 半 —— 饭点窗口（薄适配层）。
 *
 * 饭点状态机直接复用 host/client 共用的 `src/core/mealTime.js`，避免两边窗口边界不一致；
 * 这里只保留 client 侧的 UI 逻辑：
 * - settings 归一化（默认饭点 / 提醒开关 / 计划餐次）；
 * - 展示文案（「下一餐：晚餐 17:30」「午饭时间到」）；
 * - 「当前推荐用哪一餐」的映射。
 */

import { DEFAULT_MEAL_TIMES, MEAL_LABELS, mealTimeState } from '../../src/core/mealTime.js'
import { MEALS, shanghaiParts } from './format.js'

export { DEFAULT_MEAL_TIMES, MEAL_LABELS, mealTimeState }

/** 默认计划餐次（与 §2 默认 state 一致）。 */
export const DEFAULT_PLANNED_MEALS = Object.freeze(['lunch', 'dinner'])

/** 默认提醒设置。 */
export const DEFAULT_NOTIFY = Object.freeze({ inApp: true, system: true, snoozeMin: 30 })

/** 计划内（可排计划）的餐次。 */
const PLANNED_MEAL_KEYS = Object.freeze(['breakfast', 'lunch', 'dinner'])

/**
 * 归一化一组时间对。
 *
 * @param {unknown} pair 形如 `['07:00','09:00']`
 * @param {readonly string[]} fallbackPair 兜底
 * @returns {[string, string]} 归一化后的时间对
 */
function normalizePair(pair, fallbackPair) {
  const source = Array.isArray(pair) ? pair : fallbackPair
  const fallbackStart = parseClockSafe(fallbackPair[0], 7 * 60)
  const fallbackEnd = parseClockSafe(fallbackPair[1], fallbackStart + 60)
  const start = parseClockSafe(source[0], fallbackStart)
  const end = parseClockSafe(source[1], fallbackEnd)
  return [formatClockSafe(start), formatClockSafe(end >= start ? end : start + 60)]
}

/**
 * `HH:MM` → 分钟；非法返回兜底。
 *
 * @param {unknown} text 文本
 * @param {number} fallback 兜底
 * @returns {number} 分钟
 */
function parseClockSafe(text, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (match === null) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return fallback
  return hour * 60 + minute
}

/**
 * 分钟 → `HH:MM`。
 *
 * @param {number} minutes 分钟
 * @returns {string} 文本
 */
function formatClockSafe(minutes) {
  const safe = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

/**
 * 归一化饭点设置（额外保留 night 跨零点窗口，交给 core 处理）。
 *
 * @param {object | null | undefined} input settings.mealTimes
 * @returns {object} 饭点
 */
export function normalizeMealTimes(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const result = {
    breakfast: normalizePair(source.breakfast, DEFAULT_MEAL_TIMES.breakfast),
    lunch: normalizePair(source.lunch, DEFAULT_MEAL_TIMES.lunch),
    dinner: normalizePair(source.dinner, DEFAULT_MEAL_TIMES.dinner),
  }
  if (Array.isArray(source.night) && source.night.length >= 2) {
    result.night = normalizePair(source.night, ['22:00', '23:30'])
  }
  return result
}

/**
 * 归一化提醒设置。
 *
 * @param {object | null | undefined} input settings.notify
 * @returns {{ inApp: boolean, system: boolean, snoozeMin: number }} 提醒设置
 */
export function normalizeNotify(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const snooze = typeof source.snoozeMin === 'number' && Number.isFinite(source.snoozeMin)
    ? Math.min(180, Math.max(5, Math.round(source.snoozeMin)))
    : DEFAULT_NOTIFY.snoozeMin
  return {
    inApp: source.inApp !== false,
    system: source.system !== false,
    snoozeMin: snooze,
  }
}

/**
 * 归一化完整 settings（client 侧兜底用，字段与 §2 对齐）。
 *
 * @param {object | null | undefined} input settings
 * @returns {object} settings
 */
export function normalizeSettings(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const planned = Array.isArray(source.plannedMeals)
    ? source.plannedMeals.filter((meal) => MEALS.includes(meal))
    : [...DEFAULT_PLANNED_MEALS]
  return {
    ...source,
    mealTimes: normalizeMealTimes(source.mealTimes),
    plannedMeals: planned.length > 0 ? planned : [...DEFAULT_PLANNED_MEALS],
    notify: normalizeNotify(source.notify),
    amapKey: '',
  }
}

/**
 * 取某天的用餐记录。
 *
 * @param {Array<object>} meals 全部记录
 * @param {string} dateKey 日期键
 * @returns {Array<object>} 当天记录
 */
export function mealsOnDate(meals, dateKey) {
  if (!Array.isArray(meals)) return []
  return meals.filter((meal) => meal !== null && typeof meal === 'object' && meal.date === dateKey)
}

/**
 * 判断某天某餐是否已记录。
 *
 * @param {Array<object>} meals 记录
 * @param {string} dateKey 日期键
 * @param {string} meal 餐次
 * @returns {boolean} 是否已记录
 */
export function isMealRecorded(meals, dateKey, meal) {
  return mealsOnDate(meals, dateKey).some((item) => item.meal === meal)
}

/**
 * 「下一餐 / 饭点」展示文案（适配 core.mealTimeState 的返回形状）。
 *
 * @param {ReturnType<typeof mealTimeState> | null | undefined} state 饭点状态
 * @returns {string} 文案
 */
export function nextMealText(state) {
  if (state === null || state === undefined) return ''
  if (state.phase === 'in') return `${MEAL_LABELS[state.meal] ?? '饭点'}时间到`
  const label = state.nextMeal !== null && state.nextMeal !== undefined ? MEAL_LABELS[state.nextMeal] ?? '下一餐' : ''
  const time = typeof state.nextAtMs === 'number' ? shanghaiParts(state.nextAtMs).timeText : ''
  if (label === '') return '今天的饭点结束啦'
  if (state.phase === 'closed') return `今天的饭点过了，明天${label}${time === '' ? '' : ` ${time}`}见`
  return `下一餐：${label}${time === '' ? '' : ` ${time}`}`
}

/**
 * 饭点窗口展示文案（形如 `11:30–13:00`）。
 *
 * @param {ReturnType<typeof mealTimeState> | null | undefined} state 饭点状态
 * @returns {string} 文案
 */
export function mealWindowText(state) {
  if (state === null || state === undefined) return ''
  if (state.window !== null && state.window !== undefined && typeof state.window === 'object') {
    return `${state.window.start ?? ''}–${state.window.end ?? ''}`
  }
  if (typeof state.nextAtMs === 'number') return shanghaiParts(state.nextAtMs).timeText
  return ''
}

/**
 * 当前推荐应该用哪个餐次（in → 当前餐；其余 → 下一餐；夜宵映射到晚餐）。
 *
 * @param {ReturnType<typeof mealTimeState> | null | undefined} state 饭点状态
 * @returns {string} 餐次
 */
export function recommendationMeal(state) {
  if (state === null || state === undefined) return 'lunch'
  if (state.phase === 'in' && MEALS.includes(state.meal)) return state.meal
  const next = state.meal ?? state.nextMeal
  if (next === 'night') return 'dinner'
  if (MEALS.includes(next)) return next
  return 'lunch'
}

/**
 * 可排计划的餐次（设置里只让编辑早/午/晚）。
 *
 * @returns {readonly string[]} 餐次
 */
export function plannedMealKeys() {
  return PLANNED_MEAL_KEYS
}
