/**
 * 「今天吃什么」client 半 —— 显示方式（浮窗 / 横条 / 仅面板）纯函数。
 *
 * 三个 UI 形态：
 * - `float`：右下角浮动窗口（默认），可拖动、可收起成小球，挂载在 `shell.overlay`；
 * - `dock`：输入框上方横条，挂载在 `conversation.input.dock`；
 * - `panel`：不渲染任何浮层，只保留右栏面板入口。
 *
 * 这里全部是无副作用纯函数，方便烟测直接断言（拖动 clamp / 默认位置 / 兜底默认值）。
 * 状态字段与 host `lib/state.js` 的 `normalizeUi` 保持一致：
 * `ui.displayMode` / `ui.floatCollapsed` / `ui.floatPos` / `ui.rerollCuisines`。
 */

import { CUISINES } from '../../src/core/recommend.js'

/** 可选的推荐风格（与菜谱库 / core 菜系枚举一致，云南菜单独一类）。 */
export const REROLL_CUISINES = Object.freeze([...CUISINES])

/** 三档显示方式（顺序即设置面板展示顺序）。 */
export const DISPLAY_MODES = Object.freeze(['float', 'dock', 'panel'])

/** 默认显示方式：右下角浮窗。 */
export const DEFAULT_DISPLAY_MODE = 'float'

/** 浮窗拖拽时与视口边缘保留的最小间距（px）。 */
export const FLOAT_MARGIN = 8

/** 浮窗默认贴右下角：距右 16px。 */
export const FLOAT_DEFAULT_RIGHT = 16

/** 浮窗默认距底 340px（位于右下角小鲸鱼上方，不遮输入框）。 */
export const FLOAT_DEFAULT_BOTTOM = 340

/** 浮窗未测量到真实尺寸时的兜底宽（px），与 float.css 的宽度一致。 */
export const FLOAT_DEFAULT_WIDTH = 320

/** 浮窗未测量到真实尺寸时的兜底高（px）。 */
export const FLOAT_DEFAULT_HEIGHT = 300

/** 拖动判定阈值（px）：小于该位移视为点击，不视为拖动。 */
export const FLOAT_DRAG_THRESHOLD = 4

/** 浮窗最大高度占视口比例（超出后卡片内部滚动）。 */
export const FLOAT_MAX_HEIGHT_RATIO = 0.6

/** 设置面板「显示方式」三选一的元信息。 */
export const DISPLAY_MODE_META = Object.freeze([
  {
    id: 'float',
    label: '浮窗',
    emoji: '🪟',
    desc: '右下角浮动窗口，可拖动、可收起成小球（默认）',
  },
  {
    id: 'dock',
    label: '横条',
    emoji: '💬',
    desc: '显示在输入框上方的常驻横条',
  },
  {
    id: 'panel',
    label: '仅面板',
    emoji: '📋',
    desc: '不显示浮层，只从右栏面板打开',
  },
])

/**
 * 归一化显示方式（非法值回退默认 `float`）。
 *
 * @param {unknown} value 原始值
 * @returns {'float' | 'dock' | 'panel'} 显示方式
 */
export function normalizeDisplayMode(value) {
  return DISPLAY_MODES.includes(value) ? value : DEFAULT_DISPLAY_MODE
}

/**
 * 归一化浮窗位置（`{x, y}` 视口像素；非法返回 null）。
 *
 * @param {unknown} value 原始值
 * @returns {{ x: number, y: number } | null} 位置
 */
export function normalizeFloatPos(value) {
  if (value === null || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * 归一化「换一个风格」选中的菜系：只保留已支持的菜系、去重、按枚举顺序排列。
 *
 * @param {unknown} value 原始值（可能是旧缓存 / host 脏数据）
 * @returns {string[]} 菜系列表
 */
export function normalizeRerollCuisines(value) {
  if (!Array.isArray(value)) return []
  const wanted = new Set(value.filter((item) => typeof item === 'string' && item !== ''))
  return REROLL_CUISINES.filter((cuisine) => wanted.has(cuisine))
}

/**
 * 按「换一个风格」选中的菜系过滤菜品目录（未选 = 不过滤）。
 *
 * @param {Array<object>} catalog 菜品目录
 * @param {unknown} cuisines 菜系列表
 * @returns {Array<object>} 过滤后的目录
 */
export function filterCatalogByCuisines(catalog, cuisines) {
  const list = Array.isArray(catalog) ? catalog : []
  const selected = normalizeRerollCuisines(cuisines)
  if (selected.length === 0) return list
  const wanted = new Set(selected)
  return list.filter((dish) => dish !== null && typeof dish === 'object' && wanted.has(dish.cuisine))
}

/**
 * 归一化 `state.ui`（host 缺新字段 / 离线旧缓存时的兜底）。
 *
 * @param {unknown} input 原始 ui
 * @returns {{ collapsed: boolean, panelTab: string, displayMode: string, floatCollapsed: boolean, floatPos: { x: number, y: number } | null, rerollCuisines: string[] }} ui
 */
export function normalizeUiState(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  return {
    collapsed: source.collapsed === true,
    panelTab: typeof source.panelTab === 'string' && source.panelTab !== '' ? source.panelTab : 'today',
    displayMode: normalizeDisplayMode(source.displayMode),
    floatCollapsed: source.floatCollapsed === true,
    floatPos: normalizeFloatPos(source.floatPos),
    rerollCuisines: normalizeRerollCuisines(source.rerollCuisines),
  }
}

/**
 * 从 state 取显示方式（缺字段时回退 `float`）。
 *
 * @param {unknown} state state
 * @returns {'float' | 'dock' | 'panel'} 显示方式
 */
export function displayModeOf(state) {
  const ui = state !== null && typeof state === 'object' && state.ui !== null && typeof state.ui === 'object' ? state.ui : null
  return normalizeDisplayMode(ui === null ? undefined : ui.displayMode)
}

/**
 * 从 state 取浮窗收起态（缺字段 false）。
 *
 * @param {unknown} state state
 * @returns {boolean} 是否收起
 */
export function floatCollapsedOf(state) {
  const ui = state !== null && typeof state === 'object' && state.ui !== null && typeof state.ui === 'object' ? state.ui : null
  return ui !== null && ui.floatCollapsed === true
}

/**
 * 从 state 取浮窗位置（缺字段 / 非法值为 null，表示用默认右下角）。
 *
 * @param {unknown} state state
 * @returns {{ x: number, y: number } | null} 位置
 */
export function floatPosOf(state) {
  const ui = state !== null && typeof state === 'object' && state.ui !== null && typeof state.ui === 'object' ? state.ui : null
  return normalizeFloatPos(ui === null ? undefined : ui.floatPos)
}

/**
 * 当前视口尺寸（非浏览器环境给安全兜底）。
 *
 * @param {object | null} [target] 可选 window 对象（测试注入）
 * @returns {{ width: number, height: number }} 视口尺寸
 */
export function viewportSize(target = null) {
  const source = target !== null && typeof target === 'object' ? target : typeof window === 'undefined' ? null : window
  const width = source === null ? NaN : Number(source.innerWidth)
  const height = source === null ? NaN : Number(source.innerHeight)
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1280,
    height: Number.isFinite(height) && height > 0 ? height : 800,
  }
}

/**
 * 把浮窗位置限制在视口内（拖动 / resize 后用）。
 *
 * 规则：距视口四边至少 `margin`；视口比浮窗还小时贴住左上 margin（不让坐标变负）。
 *
 * @param {{ x: number, y: number } | null | undefined} pos 目标位置
 * @param {{ width?: number, height?: number }} [viewport] 视口尺寸
 * @param {{ width?: number, height?: number }} [size] 浮窗尺寸
 * @param {number} [margin] 边距
 * @returns {{ x: number, y: number } | null} clamp 后位置（pos 非法时 null）
 */
export function clampFloatPos(pos, viewport = {}, size = {}, margin = FLOAT_MARGIN) {
  const point = normalizeFloatPos(pos)
  if (point === null) return null
  const width = Number(viewport === null || viewport === undefined ? NaN : viewport.width)
  const height = Number(viewport === null || viewport === undefined ? NaN : viewport.height)
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return point
  const boxWidth = Number(size === null || size === undefined ? NaN : size.width)
  const boxHeight = Number(size === null || size === undefined ? NaN : size.height)
  const safeWidth = Number.isFinite(boxWidth) && boxWidth > 0 ? boxWidth : FLOAT_DEFAULT_WIDTH
  const safeHeight = Number.isFinite(boxHeight) && boxHeight > 0 ? boxHeight : FLOAT_DEFAULT_HEIGHT
  const rawMargin = Number(margin)
  const safeMargin = Number.isFinite(rawMargin) && rawMargin >= 0 ? rawMargin : FLOAT_MARGIN
  const minX = safeMargin
  const minY = safeMargin
  const maxX = Math.max(minX, width - safeWidth - safeMargin)
  const maxY = Math.max(minY, height - safeHeight - safeMargin)
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, point.x))),
    y: Math.round(Math.min(maxY, Math.max(minY, point.y))),
  }
}

/**
 * 拖动位移 → 新位置（clamp 后）。
 *
 * @param {{ x: number, y: number } | null} start 拖动起点（元素左上角）
 * @param {{ x: number, y: number }} delta 位移
 * @param {{ width?: number, height?: number }} [viewport] 视口尺寸
 * @param {{ width?: number, height?: number }} [size] 浮窗尺寸
 * @param {number} [margin] 边距
 * @returns {{ x: number, y: number } | null} 新位置
 */
export function moveFloatPos(start, delta, viewport = {}, size = {}, margin = FLOAT_MARGIN) {
  const base = normalizeFloatPos(start)
  if (base === null) return null
  const dx = Number(delta === null || delta === undefined ? NaN : delta.x)
  const dy = Number(delta === null || delta === undefined ? NaN : delta.y)
  const nextX = Number.isFinite(dx) ? base.x + dx : base.x
  const nextY = Number.isFinite(dy) ? base.y + dy : base.y
  return clampFloatPos({ x: nextX, y: nextY }, viewport, size, margin)
}

/**
 * 判断指针位移是否超过拖动阈值（小于阈值视为误触点击）。
 *
 * @param {{ x: number, y: number } | null} start 起点
 * @param {{ x: number, y: number } | null} current 当前点
 * @param {number} [threshold] 阈值（px）
 * @returns {boolean} 是否算拖动
 */
export function isDragThresholdExceeded(start, current, threshold = FLOAT_DRAG_THRESHOLD) {
  const from = normalizeFloatPos(start)
  const to = normalizeFloatPos(current)
  if (from === null || to === null) return false
  const rawThreshold = Number(threshold)
  const limit = Number.isFinite(rawThreshold) && rawThreshold >= 0 ? rawThreshold : FLOAT_DRAG_THRESHOLD
  return Math.hypot(to.x - from.x, to.y - from.y) >= limit
}

/**
 * 浮窗定位 style（视口坐标；`floatPos` 为空时回退 CSS 的 right/bottom 默认位）。
 *
 * @param {{ x: number, y: number } | null | undefined} pos 位置
 * @returns {object} React style
 */
export function floatPositionStyle(pos) {
  const point = normalizeFloatPos(pos)
  if (point === null) return { right: FLOAT_DEFAULT_RIGHT, bottom: FLOAT_DEFAULT_BOTTOM }
  return { left: point.x, top: point.y }
}
