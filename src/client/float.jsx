/**
 * 「今天吃什么」右下角浮窗（React）。
 *
 * 挂载点：`shell.overlay`（list / root scope，全框架浮层，默认 click-through）。
 * 所以根节点必须自己 `pointerEvents: 'auto'`，否则按钮点不到；同时 fixed 定位，
 * 只有内容大小，不会盖住输入框或右下角小鲸鱼（默认 right:16 / bottom:340）。
 *
 * 行为：
 * - 默认浮窗形态，`state.ui.displayMode !== 'float'` 时返回 null（不占位、不抢交互）；
 * - 展开态复用 RecommendCard（variant='float'），紧凑卡片、最大高 60vh 内部滚动；
 * - 收起态变成一颗 🍜 小胶囊，点击展开；提醒态脉冲动画（prefers-reduced-motion 时关闭）；
 * - 头部按住拖动，移动超过阈值才算拖动（避免误触按钮），clamp 在视口内；
 * - 拖动结束 / 窗口 resize 后 debounce 写回 `ui.floatPos`；写回失败只保留本地位置，不抛错。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  FLOAT_DEFAULT_BOTTOM,
  FLOAT_DEFAULT_HEIGHT,
  FLOAT_DEFAULT_RIGHT,
  FLOAT_DEFAULT_WIDTH,
  clampFloatPos,
  displayModeOf,
  floatCollapsedOf,
  floatPosOf,
  floatPositionStyle,
  isDragThresholdExceeded,
  viewportSize,
} from './display.js'
import { MEAL_REMINDER_LABELS } from './format.js'
import { RecommendCard, useRecommendCard } from './recommend-card.jsx'
import { openPanel } from './runtime.js'
import { ensureStyles } from './styles.js'
import { useAppStore } from './use-store.js'

/** 拖动结束写回 host 的 debounce（毫秒）。 */
const FLOAT_POS_WRITE_DELAY_MS = 400

/**
 * 把浮窗挂到 document.body 顶层（脱离宿主 overlay 层 20 的堆叠上下文），
 * 这样不会被右下角小鲸鱼（z-index 9999）等别的插件浮层盖住而点不到。
 *
 * @param {object} node React 元素
 * @returns {object} portal 或原节点（无 DOM 时）
 */
function mountToBody(node) {
  if (typeof document === 'undefined' || document.body === null || document.body === undefined) return node
  try {
    return createPortal(node, document.body)
  } catch {
    return node
  }
}

/**
 * 量取浮窗尺寸（拿不到 DOM 时给兜底尺寸）。
 *
 * @param {object | null} element 根元素
 * @returns {{ width: number, height: number }} 尺寸
 */
function measureRoot(element) {
  const rect = element !== null && element !== undefined && typeof element.getBoundingClientRect === 'function'
    ? element.getBoundingClientRect()
    : null
  const width = rect === null ? NaN : Number(rect.width)
  const height = rect === null ? NaN : Number(rect.height)
  return {
    width: Number.isFinite(width) && width > 0 ? width : FLOAT_DEFAULT_WIDTH,
    height: Number.isFinite(height) && height > 0 ? height : FLOAT_DEFAULT_HEIGHT,
  }
}

/**
 * 浮窗收起态：一颗小胶囊，单击展开、双击打开面板。
 *
 * @param {{ data: object, onExpand: Function, onOpenPanel: Function, shouldSuppressClick?: Function }} props 属性
 * @returns {object} React 元素
 */
function FloatCapsule({ data, onExpand, onOpenPanel, shouldSuppressClick }) {
  const { dish, reminder, nextText } = data
  const pulsing = reminder.active === true
  const suppressed = () => typeof shouldSuppressClick === 'function' && shouldSuppressClick() === true
  return (
    <div className={pulsing ? 'tde-float-capsule tde-float-pulse' : 'tde-float-capsule'} role="group" aria-label="今天吃什么（收起）">
      <button
        type="button"
        className="tde-float-capsule-main"
        title={pulsing ? '到饭点啦：单击展开卡片，右侧按钮打开面板' : '单击展开卡片，右侧按钮打开面板'}
        onClick={() => {
          if (suppressed()) return
          onExpand()
        }}
      >
        <span className="tde-float-capsule-emoji" aria-hidden="true">🍜</span>
        <span className="tde-float-capsule-dish">{dish === null ? '今天吃什么' : dish.name}</span>
        {pulsing ? (
          <span className="tde-float-capsule-bell">🔔 {MEAL_REMINDER_LABELS[reminder.meal] ?? '到饭点啦'}</span>
        ) : (
          <span className="tde-float-capsule-time">{nextText === '' ? '点开看推荐' : nextText}</span>
        )}
      </button>
      <button
        type="button"
        className="tde-float-capsule-panel"
        title="打开今天吃什么面板"
        aria-label="打开今天吃什么面板"
        onClick={(event) => {
          if (suppressed()) return
          if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
          if (typeof onOpenPanel === 'function') onOpenPanel()
        }}
      >
        <span aria-hidden="true">▤</span>
        <span className="tde-float-capsule-panel-text">面板</span>
      </button>
    </div>
  )
}

/**
 * 浮窗根组件。
 *
 * @returns {object|null} React 元素
 */
export function TodayEatFloat() {
  ensureStyles()
  const { store, snapshot } = useAppStore()
  const data = useRecommendCard()
  const storedPos = floatPosOf(snapshot.state)
  const collapsed = floatCollapsedOf(snapshot.state)
  const [dragPos, setDragPos] = useState(null)
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef(null)
  const dragRef = useRef(null)
  const suppressClickRef = useRef(false)
  const latestPosRef = useRef(storedPos)
  latestPosRef.current = dragPos ?? storedPos
  const storedPosKey = storedPos === null ? '' : `${storedPos.x},${storedPos.y}`

  /**
   * 窗口很矮时，默认右下角位置可能顶出视口：只在视口高度确实不够时做视觉 clamp（不写 host）。
   *
   * @returns {void}
   */
  const clampDefaultIntoView = () => {
    const viewport = viewportSize()
    if (viewport.height >= FLOAT_DEFAULT_BOTTOM + FLOAT_DEFAULT_HEIGHT) return
    const size = measureRoot(rootRef.current)
    const defaultX = viewport.width - size.width - FLOAT_DEFAULT_RIGHT
    const defaultY = viewport.height - FLOAT_DEFAULT_BOTTOM - size.height
    const clamped = clampFloatPos({ x: defaultX, y: defaultY }, viewport, size)
    if (clamped === null) return
    setDragPos(clamped)
  }

  // 窗口很矮（< 默认 bottom + 高度）时才在挂载后兜底 clamp；正常窗口用 CSS 的 right/bottom，
  // 避免首屏布局未稳定时量到错误尺寸而把默认位置钉在屏幕中间。
  useEffect(() => {
    if (latestPosRef.current !== null) return
    const defer = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 16)
    const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout
    const frame = defer(() => clampDefaultIntoView())
    return () => {
      try {
        cancel(frame)
      } catch {
        // 忽略
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部改了位置（设置里重置 / host 同步 / resize 重新 clamp）时，丢掉本地拖动覆盖值
  useEffect(() => {
    if (dragRef.current !== null) return
    setDragPos(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedPosKey])

  // 恢复出的保存位置可能在当前屏幕/窗口之外（换显示器、缩小窗口）：
  // 首次挂载 / 位置变化后做一次本地 clamp（只影响本窗口显示，不写回 host，
  // 避免多窗口/不同分辨率互相覆盖用户保存的位置）；用户真正拖动时才会更新保存位置。
  useEffect(() => {
    if (storedPos === null) return
    const clamped = clampFloatPos(storedPos, viewportSize(), measureRoot(rootRef.current))
    if (clamped === null) return
    if (clamped.x === storedPos.x && clamped.y === storedPos.y) return
    setDragPos(clamped)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedPosKey])

  // 视口变化时重新 clamp，避免窗口缩小后浮窗跑到屏幕外
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const handleResize = () => {
      const current = latestPosRef.current
      if (current === null) return
      const clamped = clampFloatPos(current, viewportSize(), measureRoot(rootRef.current))
      if (clamped === null) return
      if (clamped.x === current.x && clamped.y === current.y) return
      // 只做本窗口视觉 clamp，不写回 host：多窗口/换显示器时不让一个窗口覆盖另一个窗口的位置
      setDragPos(clamped)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      try {
        window.removeEventListener('resize', handleResize)
      } catch {
        // 忽略
      }
    }
  }, [store])

  // 非浮窗形态：完全不渲染（不占位、不拦截点击）
  if (displayModeOf(snapshot.state) !== 'float') return null

  const currentPos = dragPos ?? storedPos
  const style = {
    ...floatPositionStyle(currentPos),
    pointerEvents: 'auto',
  }

  /** 当前拖动期间挂到 window 上的监听器（pointerup 时移除）。 */
  const dragListenersRef = useRef(null)

  /**
   * 移除拖动期间的 window 监听器。
   *
   * @returns {void}
   */
  const detachDragListeners = () => {
    const listeners = dragListenersRef.current
    if (listeners === null || listeners === undefined) return
    dragListenersRef.current = null
    if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return
    try {
      window.removeEventListener('pointermove', listeners.move)
      window.removeEventListener('pointerup', listeners.up)
      window.removeEventListener('pointercancel', listeners.up)
    } catch {
      // 忽略
    }
  }

  // 卸载时清掉监听器，避免旧 fiber 的拖动残留
  useEffect(() => () => detachDragListeners(), [])

  /**
   * 判断事件目标是否是可点击控件（按钮/链接/输入框等）。
   *
   * @param {object | null} target 事件目标
   * @returns {boolean} 是否交互控件
   */
  const isInteractiveTarget = (target) => target !== null && target !== undefined && typeof target.closest === 'function'
    ? target.closest('button, a, input, textarea, select, [contenteditable="true"], [data-no-drag]') !== null
    : false

  /**
   * 指针按下：记录起点，挂 window 级 move/up 监听（不用 pointer capture，
   * 否则子按钮的 click 会被重定向到根节点，导致「点了没反应」）。
   *
   * 移动超过阈值才真正拖动；未移动时按钮点击正常。拖动结束后抑制随后的 click。
   *
   * @param {object} event React PointerEvent
   * @param {{ allowInteractive?: boolean }} [options={}] 选项
   * @returns {void}
   */
  const handlePointerDown = (event, options = {}) => {
    if (event === null || typeof event !== 'object') return
    if (typeof event.button === 'number' && event.button !== 0) return
    if (options.allowInteractive !== true && isInteractiveTarget(event.target)) return
    detachDragListeners()
    const element = rootRef.current
    const rect = element !== null && element !== undefined && typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : null
    const fallback = viewportSize()
    const startPos = rect === null
      ? {
          x: latestPosRef.current === null ? fallback.width - FLOAT_DEFAULT_WIDTH - 16 : latestPosRef.current.x,
          y: latestPosRef.current === null ? fallback.height - 340 - FLOAT_DEFAULT_HEIGHT : latestPosRef.current.y,
        }
      : { x: Number(rect.left) || 0, y: Number(rect.top) || 0 }
    dragRef.current = {
      startX: Number.isFinite(Number(event.clientX)) ? Number(event.clientX) : 0,
      startY: Number.isFinite(Number(event.clientY)) ? Number(event.clientY) : 0,
      startPos,
      size: measureRoot(element),
      moved: false,
    }
    suppressClickRef.current = false
    const onMove = (nativeEvent) => {
      const drag = dragRef.current
      if (drag === null) return
      const x = Number(nativeEvent === null || nativeEvent === undefined ? NaN : nativeEvent.clientX)
      const y = Number(nativeEvent === null || nativeEvent === undefined ? NaN : nativeEvent.clientY)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      // 小位移视为误触：不动、不阻止点击
      if (drag.moved !== true && !isDragThresholdExceeded({ x: drag.startX, y: drag.startY }, { x, y })) return
      drag.moved = true
      setDragging(true)
      const next = clampFloatPos(
        { x: drag.startPos.x + (x - drag.startX), y: drag.startPos.y + (y - drag.startY) },
        viewportSize(),
        drag.size,
      )
      if (next === null) return
      latestPosRef.current = next
      setDragPos(next)
      try {
        if (typeof nativeEvent.preventDefault === 'function') nativeEvent.preventDefault()
      } catch {
        // 忽略
      }
    }
    const onUp = () => {
      detachDragListeners()
      const drag = dragRef.current
      dragRef.current = null
      setDragging(false)
      if (drag === null || drag.moved !== true) return
      // 本次是拖动而非点击：抑制紧随其后的 click；350ms 后自动解除，避免吞掉下一次点击
      suppressClickRef.current = true
      if (typeof setTimeout === 'function') {
        setTimeout(() => {
          suppressClickRef.current = false
        }, 350)
      }
      const pos = latestPosRef.current
      if (pos === null) return
      try {
        void store.setFloatPos(pos, { immediate: true }).catch(() => false)
      } catch {
        // 写回失败：保留本地位置，不抛错
      }
    }
    dragListenersRef.current = { move: onMove, up: onUp }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pointermove', onMove, { passive: false })
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    }
  }

  /**
   * 拖动后紧随的 click 是否应被吞掉（并复位标记）。
   *
   * @returns {boolean} 是否抑制本次点击
   */
  const shouldSuppressClick = () => {
    if (suppressClickRef.current !== true) return false
    suppressClickRef.current = false
    return true
  }

  const dragHandlers = {
    onPointerDown: handlePointerDown,
  }

  /** 收起态胶囊：允许从按钮上开始拖动（未移动时 click 仍触发按钮本身）。 */
  const capsuleDragHandlers = {
    onPointerDown: (event) => handlePointerDown(event, { allowInteractive: true }),
  }

  /**
   * 浮窗双击：打开右栏面板；按钮等交互元素上的双击保持原行为。
   *
   * @param {object} event React MouseEvent
   * @returns {void}
   */
  const handleCardDoubleClick = (event) => {
    const target = event === null || event === undefined ? null : event.target
    const closest = target !== null && target !== undefined && typeof target.closest === 'function'
      ? target.closest('button, a, input, textarea, select, [contenteditable="true"], [data-no-drag]')
      : null
    if (closest !== null) return
    openPanel('today')
  }

  if (collapsed) {
    return mountToBody(
      <div
        className={dragging ? 'tde-float tde-float-collapsed tde-float-dragging' : 'tde-float tde-float-collapsed'}
        data-today-eat-float=""
        data-float-collapsed="true"
        ref={rootRef}
        style={style}
        title="按住拖动位置，点击展开"
        {...capsuleDragHandlers}
      >
        <FloatCapsule
          data={data}
          onExpand={() => {
            store.setFloatCollapsed(false)
          }}
          onOpenPanel={() => openPanel('today')}
          shouldSuppressClick={shouldSuppressClick}
        />
      </div>,
    )
  }

  return mountToBody(
    <div
      className={dragging ? 'tde-float tde-float-dragging' : 'tde-float'}
      data-today-eat-float=""
      ref={rootRef}
      style={style}
      title="按住空白处拖动 · 双击打开面板"
      onDoubleClick={handleCardDoubleClick}
      {...dragHandlers}
    >
      <RecommendCard
        variant="float"
        onDock={() => store.setDisplayMode('dock')}
        onCollapse={() => store.setFloatCollapsed(true)}
      />
    </div>,
  )
}

export default TodayEatFloat
