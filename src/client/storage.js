/**
 * 「今天吃什么」client 半 —— localStorage 读写。
 *
 * 所有读写都包 try/catch：隐私模式 / 存储被禁用 / 配额写满时静默降级，
 * 绝不因为存储异常弄崩横条或面板。
 *
 * v2 的长期状态在 host 文件（state.json）；localStorage 负责三件事：
 * 1) 离线兜底（缓存最近一次 state + v1 旧键）；
 * 2) 提醒去重（按 日期+餐次 记录已提醒 / 稍后提醒时间）；
 * 3) 面板 UI 状态与迁移标记。
 */

/** v1 偏好键（保留：迁移与离线兜底用）。 */
const PREF_KEY = 'dsh-today-eat:prefs:v1'

/** v1 用餐历史键（保留：迁移来源 / 离线记录）。 */
const HISTORY_KEY = 'dsh-today-eat:history:v1'

/** v1 UI 状态键（收起状态、面板 tab）。 */
const UI_KEY = 'dsh-today-eat:ui:v1'

/** 最近一次成功拉取的 state 缓存（离线时展示）。 */
const STATE_CACHE_KEY = 'dsh-today-eat:state-cache:v2'

/** 提醒去重：{ '2026-11-09': { lunch: 1762... } }。 */
const REMINDED_KEY = 'dsh-today-eat:reminded:v2'

/** 稍后提醒：{ '2026-11-09': { lunch: 1762... } }（到期时间戳）。 */
const SNOOZE_KEY = 'dsh-today-eat:snooze:v2'

/** v1 历史是否已迁移到 v2 state.meals。 */
const MIGRATED_KEY = 'dsh-today-eat:migrated:v2'

/** 历史最多保留的条数。 */
const MAX_HISTORY_ENTRIES = 500

/** 默认 UI 状态（v1 键也承载新的显示方式字段，方便离线时保留用户选择）。 */
const DEFAULT_UI = Object.freeze({
  collapsed: false,
  panelTab: 'today',
  displayMode: 'float',
  floatCollapsed: false,
  floatPos: null,
})

/** 合法显示方式。 */
const DISPLAY_MODES = Object.freeze(['float', 'dock', 'panel'])

/**
 * 取 localStorage；不可用时返回 null。
 *
 * @returns {Storage | null} 存储对象
 */
function getStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * 安全读取一个 JSON 值。
 *
 * @param {string} key 存储键
 * @param {unknown} fallback 回退值
 * @returns {unknown} 值
 */
function readJson(key, fallback) {
  const storage = getStorage()
  if (storage === null) return fallback
  try {
    const raw = storage.getItem(key)
    if (typeof raw !== 'string' || raw === '') return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * 安全写入一个 JSON 值。
 *
 * @param {string} key 存储键
 * @param {unknown} value 值
 * @returns {void}
 */
function writeJson(key, value) {
  const storage = getStorage()
  if (storage === null) return
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // 写满 / 被禁用：忽略，内存态仍然可用。
  }
}

/**
 * 读取 v1 偏好。
 *
 * @returns {{ vegetarian: boolean, noSpicy: boolean, budget: boolean }} 偏好
 */
export function readPreferences() {
  const stored = readJson(PREF_KEY, {})
  const source = stored !== null && typeof stored === 'object' ? stored : {}
  return {
    vegetarian: source.vegetarian === true,
    noSpicy: source.noSpicy === true,
    budget: source.budget === true,
  }
}

/**
 * 写入 v1 偏好（离线模式下的偏好仍写旧键，方便下次回退展示）。
 *
 * @param {{ vegetarian?: boolean, noSpicy?: boolean, budget?: boolean }} preferences 偏好
 * @returns {void}
 */
export function writePreferences(preferences) {
  writeJson(PREF_KEY, {
    vegetarian: preferences.vegetarian === true,
    noSpicy: preferences.noSpicy === true,
    budget: preferences.budget === true,
  })
}

/**
 * 读取 v1 用餐历史（只保留结构合法条目）。
 *
 * @returns {Array<{ dishId: string, date: string, meal: string }>} 历史
 */
export function readHistory() {
  const stored = readJson(HISTORY_KEY, [])
  if (!Array.isArray(stored)) return []
  const entries = []
  for (const item of stored) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.dishId !== 'string' || item.dishId === '') continue
    if (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) continue
    const meal = ['breakfast', 'lunch', 'dinner', 'night'].includes(item.meal) ? item.meal : 'lunch'
    entries.push({ dishId: item.dishId, date: item.date, meal })
    if (entries.length >= MAX_HISTORY_ENTRIES) break
  }
  return entries
}

/**
 * 写入 v1 用餐历史。
 *
 * @param {Array<{ dishId: string, date: string, meal: string }>} history 历史
 * @returns {void}
 */
export function writeHistory(history) {
  const entries = Array.isArray(history) ? history.slice(-MAX_HISTORY_ENTRIES) : []
  writeJson(HISTORY_KEY, entries)
}

/**
 * 追加一条 v1 历史（离线记录用）。
 *
 * @param {{ dishId: string, date: string, meal: string }} entry 记录
 * @returns {void}
 */
export function appendHistory(entry) {
  if (entry === null || typeof entry !== 'object') return
  const history = readHistory()
  // 与 host 的 meals upsert 语义一致：同 date+meal 覆盖旧记录
  const next = history.filter((item) => !(item.date === entry.date && item.meal === entry.meal))
  next.push({ dishId: String(entry.dishId ?? ''), date: String(entry.date ?? ''), meal: String(entry.meal ?? 'lunch') })
  writeHistory(next)
}

/**
 * 读取 v1 UI 状态（兼容 collapsed / panelTab / displayMode / floatCollapsed / floatPos）。
 *
 * @returns {{ collapsed: boolean, panelTab: string, displayMode: string, floatCollapsed: boolean, floatPos: { x: number, y: number } | null }} UI 状态
 */
export function readUi() {
  const stored = readJson(UI_KEY, DEFAULT_UI)
  const source = stored !== null && typeof stored === 'object' ? stored : {}
  const panelTab = ['today', 'week', 'history', 'settings'].includes(source.panelTab) ? source.panelTab : 'today'
  const displayMode = DISPLAY_MODES.includes(source.displayMode) ? source.displayMode : 'float'
  const floatPos = source.floatPos !== null && typeof source.floatPos === 'object' &&
    Number.isFinite(Number(source.floatPos.x)) && Number.isFinite(Number(source.floatPos.y))
    ? { x: Math.round(Number(source.floatPos.x)), y: Math.round(Number(source.floatPos.y)) }
    : null
  return {
    collapsed: source.collapsed === true,
    panelTab,
    displayMode,
    floatCollapsed: source.floatCollapsed === true,
    floatPos,
  }
}

/**
 * 写入 v1 UI 状态（保留旧字段，附加显示方式）。
 *
 * @param {{ collapsed?: boolean, panelTab?: string, displayMode?: string, floatCollapsed?: boolean, floatPos?: { x: number, y: number } | null }} ui UI 状态
 * @returns {void}
 */
export function writeUi(ui) {
  const next = ui !== null && typeof ui === 'object' ? ui : {}
  const floatPos = next.floatPos !== null && typeof next.floatPos === 'object' &&
    Number.isFinite(Number(next.floatPos.x)) && Number.isFinite(Number(next.floatPos.y))
    ? { x: Math.round(Number(next.floatPos.x)), y: Math.round(Number(next.floatPos.y)) }
    : null
  writeJson(UI_KEY, {
    collapsed: next.collapsed === true,
    panelTab: ['today', 'week', 'history', 'settings'].includes(next.panelTab) ? next.panelTab : 'today',
    displayMode: DISPLAY_MODES.includes(next.displayMode) ? next.displayMode : 'float',
    floatCollapsed: next.floatCollapsed === true,
    floatPos,
  })
}

/**
 * 读取最近一次成功的 state 缓存。
 *
 * @returns {{ state: object, hasAmapKey: boolean, savedAt: number } | null} 缓存
 */
export function readStateCache() {
  const stored = readJson(STATE_CACHE_KEY, null)
  if (stored === null || typeof stored !== 'object' || stored.state === null || typeof stored.state !== 'object') return null
  return {
    state: stored.state,
    hasAmapKey: stored.hasAmapKey === true,
    savedAt: typeof stored.savedAt === 'number' ? stored.savedAt : 0,
  }
}

/**
 * 写入 state 缓存。
 *
 * @param {{ state: object, hasAmapKey?: boolean }} payload 缓存内容
 * @returns {void}
 */
export function writeStateCache(payload) {
  if (payload === null || typeof payload !== 'object' || payload.state === null || typeof payload.state !== 'object') return
  writeJson(STATE_CACHE_KEY, {
    state: payload.state,
    hasAmapKey: payload.hasAmapKey === true,
    savedAt: Date.now(),
  })
}

/**
 * 读取提醒去重表（只保留最近 4 天）。
 *
 * @returns {Record<string, Record<string, number>>} 去重表
 */
export function readReminderMarks() {
  const stored = readJson(REMINDED_KEY, {})
  if (stored === null || typeof stored !== 'object') return {}
  const result = {}
  const cutoff = Date.now() - 4 * 24 * 60 * 60 * 1000
  for (const [dateKey, meals] of Object.entries(stored)) {
    if (meals === null || typeof meals !== 'object') continue
    const kept = {}
    for (const [meal, ts] of Object.entries(meals)) {
      if (typeof ts === 'number' && ts >= cutoff) kept[meal] = ts
    }
    if (Object.keys(kept).length > 0) result[dateKey] = kept
  }
  return result
}

/**
 * 写入提醒去重表。
 *
 * @param {Record<string, Record<string, number>>} marks 去重表
 * @returns {void}
 */
export function writeReminderMarks(marks) {
  writeJson(REMINDED_KEY, marks !== null && typeof marks === 'object' ? marks : {})
}

/**
 * 标记某天某餐已提醒。
 *
 * @param {string} dateKey 日期键
 * @param {string} meal 餐次
 * @returns {void}
 */
export function markReminded(dateKey, meal) {
  const marks = readReminderMarks()
  if (marks[dateKey] === undefined) marks[dateKey] = {}
  marks[dateKey][meal] = Date.now()
  writeReminderMarks(marks)
}

/**
 * 读取稍后提醒表。
 *
 * @returns {Record<string, Record<string, number>>} 稍后提醒表
 */
export function readSnoozes() {
  const stored = readJson(SNOOZE_KEY, {})
  if (stored === null || typeof stored !== 'object') return {}
  const result = {}
  const now = Date.now()
  for (const [dateKey, meals] of Object.entries(stored)) {
    if (meals === null || typeof meals !== 'object') continue
    const kept = {}
    for (const [meal, until] of Object.entries(meals)) {
      if (typeof until === 'number' && until > now) kept[meal] = until
    }
    if (Object.keys(kept).length > 0) result[dateKey] = kept
  }
  return result
}

/**
 * 写入某天某餐的稍后提醒截止时间。
 *
 * @param {string} dateKey 日期键
 * @param {string} meal 餐次
 * @param {number} until 截止时间戳
 * @returns {void}
 */
export function snoozeMeal(dateKey, meal, until) {
  const snoozes = readSnoozes()
  if (snoozes[dateKey] === undefined) snoozes[dateKey] = {}
  snoozes[dateKey][meal] = until
  writeJson(SNOOZE_KEY, snoozes)
}

/**
 * 读取 v1 历史迁移标记。
 *
 * @returns {boolean} 是否已迁移
 */
export function readMigrated() {
  const stored = readJson(MIGRATED_KEY, false)
  return stored === true
}

/**
 * 写入 v1 历史迁移标记。
 *
 * @returns {void}
 */
export function writeMigrated() {
  writeJson(MIGRATED_KEY, true)
}

/** 供测试与调试使用的存储键。 */
export const STORAGE_KEYS = Object.freeze({
  preferences: PREF_KEY,
  history: HISTORY_KEY,
  ui: UI_KEY,
  stateCache: STATE_CACHE_KEY,
  reminded: REMINDED_KEY,
  snooze: SNOOZE_KEY,
  migrated: MIGRATED_KEY,
})
