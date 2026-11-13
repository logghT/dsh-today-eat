/**
 * 「今天吃什么」client 半 —— 日期 / 文案 / 常量工具。
 *
 * 纯函数，不依赖 DOM。日期统一按 Asia/Shanghai 换算（中国无夏令时，固定 +8），
 * 与 host 半的 mealTime/dateKey 口径保持一致。
 */

import {
  PHASE_META as CORE_PHASE_META,
  PHASE_SUBGOALS as CORE_PHASE_SUBGOALS,
  PHASES as CORE_PHASES,
  SUBGOALS as CORE_SUBGOALS,
  SUBGOAL_META,
  canonicalPhaseKind,
} from '../../src/core/phase.js'
import { TASTE_DIMENSIONS, TASTE_HINTS, TASTE_LABELS } from './taste.js'

/** 六维味道：维度顺序 / 中文标签 / 设置页 hint（真源在 src/core/taste.js，client 只做展示）。 */
export { TASTE_DIMENSIONS, TASTE_HINTS, TASTE_LABELS }

/** 上海时区固定偏移（毫秒）。 */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** 四个餐次（与 src/core 一致）。 */
export const MEALS = Object.freeze(['breakfast', 'lunch', 'dinner', 'night'])

/** 排计划用的餐次（夜宵不进计划）。 */
export const PLANNED_MEALS = Object.freeze(['breakfast', 'lunch', 'dinner'])

/** 餐次中文名。 */
export const MEAL_LABELS = Object.freeze({
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  night: '夜宵',
})

/** 饭点提醒文案。 */
export const MEAL_REMINDER_LABELS = Object.freeze({
  breakfast: '早饭时间到',
  lunch: '午饭时间到',
  dinner: '晚饭时间到',
  night: '夜宵时间到',
})

/** 阶段元信息：直接复用 core 的 PHASE_META（label/desc/emoji），避免两边文案漂移。 */
export const PHASE_META = CORE_PHASE_META

/** 九个阶段（core 导出）。 */
export const PHASES = CORE_PHASES

/** 全部子目标（扁平，带中文标签）。 */
export const SUBGOALS = Object.freeze(CORE_SUBGOALS.map((id) => ({ id, label: SUBGOAL_META[id]?.label ?? id })))

/** 某阶段的子目标（带中文标签）。 */
export function subgoalsFor(kind) {
  const canonical = canonicalPhaseKind(kind) ?? 'performance'
  return Object.freeze((CORE_PHASE_SUBGOALS[canonical] ?? []).map((id) => ({ id, label: SUBGOAL_META[id]?.label ?? id })))
}

/** 大区枚举。 */
export const REGIONS = Object.freeze(['西南', '华东', '华北', '华南', '华中', '西北', '东北'])

/** 星期中文名（索引与 Date#getDay 一致）。 */
export const WEEKDAYS = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六'])

/** 面板五个 tab。 */
export const PANEL_TABS = Object.freeze([
  { id: 'today', label: '今天', emoji: '🍜' },
  { id: 'week', label: '本周', emoji: '🗓️' },
  { id: 'recipes', label: '菜谱', emoji: '📖' },
  { id: 'history', label: '记录', emoji: '📔' },
  { id: 'settings', label: '设置', emoji: '⚙️' },
])

/**
 * 两位补零。
 *
 * @param {number} value 数字
 * @returns {string} 两位字符串
 */
export function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 取上海时区下的日期 / 时间部件。
 *
 * @param {Date | number | string} [input=new Date()] 时间
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, weekday: number, dateKey: string, label: string, timeText: string }} 部件
 */
export function shanghaiParts(input = new Date()) {
  const time = input instanceof Date ? input.getTime() : new Date(input).getTime()
  const shifted = new Date((Number.isFinite(time) ? time : Date.now()) + SHANGHAI_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  const hour = shifted.getUTCHours()
  const minute = shifted.getUTCMinutes()
  const weekday = shifted.getUTCDay()
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
    label: `${month}月${day}日 ${WEEKDAYS[weekday] ?? ''}`,
    timeText: `${pad2(hour)}:${pad2(minute)}`,
  }
}

/**
 * 今天的日期键（上海时区）。
 *
 * @returns {string} 日期键
 */
export function todayKey() {
  return shanghaiParts(new Date()).dateKey
}

/**
 * 把日期 / 时间戳 / 日期键统一成 `YYYY-MM-DD`（上海时区）。
 *
 * @param {Date | number | string} [value=new Date()] 时间
 * @returns {string} 日期键
 */
export function dateKeyOf(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return shanghaiParts(value).dateKey
}

/**
 * 解析日期键为上海时间 00:00 的时间戳。
 *
 * @param {string} key 日期键
 * @returns {number} 时间戳
 */
export function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key))
  if (match === null) return Date.now()
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - SHANGHAI_OFFSET_MS
}

/**
 * 日期键加减天数。
 *
 * @param {string} key 日期键
 * @param {number} delta 天数（可为负）
 * @returns {string} 新日期键
 */
export function addDaysKey(key, delta) {
  return dateKeyOf(parseDateKey(key) + delta * 24 * 60 * 60 * 1000)
}

/**
 * 取日期键的星期中文名。
 *
 * @param {string} key 日期键
 * @returns {string} 星期
 */
export function weekdayOfKey(key) {
  return WEEKDAYS[new Date(parseDateKey(key) + SHANGHAI_OFFSET_MS).getUTCDay()] ?? ''
}

/**
 * 日期短标签 `11/9`。
 *
 * @param {string} key 日期键
 * @returns {string} 短标签
 */
export function shortDateLabel(key) {
  const [, , month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key)) ?? []
  return month === undefined ? String(key) : `${Number(month)}/${Number(day)}`
}

/**
 * 相对今天的日期标签：今天 / 明天 / 昨天 / 空串。
 *
 * @param {string} key 日期键
 * @param {string} [today] 今天的日期键
 * @returns {string} 标签
 */
export function relativeDayLabel(key, today = dateKeyOf(new Date())) {
  if (key === today) return '今天'
  if (key === addDaysKey(today, 1)) return '明天'
  if (key === addDaysKey(today, -1)) return '昨天'
  return ''
}

/**
 * 取餐次中文名。
 *
 * @param {string} meal 餐次
 * @returns {string} 中文名
 */
export function mealLabel(meal) {
  return MEAL_LABELS[meal] ?? '今天'
}

/**
 * 取阶段元信息（未知类型时给出稳妥兜底）。
 *
 * @param {string} kind 阶段类型
 * @returns {{ label: string, full: string, emoji: string, desc: string }} 元信息
 */
export function phaseMeta(kind) {
  const canonical = canonicalPhaseKind(kind)
  const meta = canonical ? PHASE_META[canonical] : undefined
  if (meta === undefined) return { label: kind || '日常', full: kind || '日常', emoji: '🍽️', desc: '按口味推荐' }
  return { label: meta.label, full: meta.label, emoji: meta.emoji, desc: meta.desc }
}

/**
 * 限制数值范围。
 *
 * @param {number} value 数值
 * @param {number} min 下限
 * @param {number} max 上限
 * @param {number} fallback 兜底值
 * @returns {number} 结果
 */
export function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * 生成稳定的记录 id。
 *
 * @param {string} [prefix='m'] 前缀
 * @returns {string} id
 */
export function makeId(prefix = 'm') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 数字展示（去掉无意义的小数尾巴）。
 *
 * @param {number | null | undefined} value 数值
 * @param {string} [fallback='—'] 兜底
 * @returns {string} 文本
 */
export function formatNumber(value, fallback = '—') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * 分钟数格式化成 `HH:MM`。
 *
 * @param {number} minutes 当天分钟数
 * @returns {string} 时间
 */
export function formatMinutes(minutes) {
  const safe = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${pad2(Math.floor(safe / 60))}:${pad2(safe % 60)}`
}

/**
 * `HH:MM` 转当天分钟数；非法返回兜底。
 *
 * @param {string} text 时间文本
 * @param {number} fallback 兜底分钟数
 * @returns {number} 分钟数
 */
export function parseMinutes(text, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (match === null) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return fallback
  return hour * 60 + minute
}
