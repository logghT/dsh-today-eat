/**
 * 「换一个风格」：按菜谱大类（云南菜 / 川菜 / …，可多选）限制「换一个」的抽菜范围。
 *
 * - 选择结果持久化到 `ui.rerollCuisines`（host 文件 + 本机 localStorage 兜底）；
 * - 弹层用 portal 挂到 document.body，避免被浮窗的 overflow / 拖动层裁剪；
 * - 空选 = 全部菜系；清空后恢复全部。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { REROLL_CUISINES } from './display.js'
import { Btn, Chip } from './ui.jsx'

/** 弹层宽度（px），与 CSS 保持一致。 */
const POPOVER_WIDTH = 300

/** 弹层高度兜底（用于决定向上还是向下展开）。 */
const POPOVER_HEIGHT = 280

/**
 * 计算弹层位置（fixed 坐标）：优先在按钮下方，下方空间不够则向上。
 *
 * @param {{ left: number, right: number, top: number, bottom: number } | null} rect 按钮位置
 * @param {{ width: number, height: number }} viewport 视口
 * @returns {{ left: number, top: number }} 位置
 */
export function popoverPosition(rect, viewport) {
  const viewWidth = Number(viewport === null || viewport === undefined ? NaN : viewport.width)
  const viewHeight = Number(viewport === null || viewport === undefined ? NaN : viewport.height)
  const width = Number.isFinite(viewWidth) && viewWidth > 0 ? viewWidth : 1280
  const height = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : 800
  const boxWidth = Math.min(POPOVER_WIDTH, Math.max(220, width - 16))
  const rectLeft = rect === null || rect === undefined ? 16 : Number(rect.left) || 0
  const rectRight = rect === null || rect === undefined ? rectLeft : Number(rect.right) || rectLeft
  const rectTop = rect === null || rect === undefined ? 16 : Number(rect.top) || 0
  const rectBottom = rect === null || rect === undefined ? rectTop : Number(rect.bottom) || rectTop
  const left = Math.max(8, Math.min(Math.min(rectLeft, rectRight - boxWidth), width - boxWidth - 8))
  let top = rectBottom + 6
  if (top + POPOVER_HEIGHT > height - 8) top = Math.max(8, rectTop - POPOVER_HEIGHT - 6)
  return { left: Math.round(left), top: Math.round(top) }
}

/**
 * 换一个风格：按钮 + 多选菜系弹层。
 *
 * @param {{
 *   cuisines: string[],
 *   onChange: (next: string[]) => void,
 *   onReroll: () => void,
 *   compact?: boolean,
 *   disabled?: boolean,
 *   showSummary?: boolean,
 * }} props 属性
 * @returns {object} React 元素
 */
export function StyleReroll({ cuisines, onChange, onReroll, compact = false, disabled = false, showSummary = true }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 8, top: 8 })
  const anchorRef = useRef(null)
  const popRef = useRef(null)
  const selected = Array.isArray(cuisines) ? cuisines : []

  useEffect(() => {
    if (!open) return undefined
    const close = () => setOpen(false)
    const anchor = anchorRef.current
    const rect = anchor !== null && anchor !== undefined && typeof anchor.getBoundingClientRect === 'function'
      ? anchor.getBoundingClientRect()
      : null
    setPos(popoverPosition(rect, { width: window.innerWidth, height: window.innerHeight }))

    const onPointerDown = (event) => {
      const target = event.target
      if (popRef.current !== null && popRef.current !== undefined && popRef.current.contains(target)) return
      if (anchor !== null && anchor !== undefined && anchor.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    let timer = null
    timer = setTimeout(() => document.addEventListener('pointerdown', onPointerDown, true), 0)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  const toggle = (cuisine) => {
    if (selected.includes(cuisine)) onChange(selected.filter((item) => item !== cuisine))
    else onChange([...selected, cuisine])
  }

  const apply = () => {
    onReroll()
    setOpen(false)
  }

  const label = compact ? '🎨 换风格' : '🎨 换一个风格'
  const countText = selected.length === 0 ? '' : ` · ${selected.length}`

  return (
    <span className="tde-style-reroll" ref={anchorRef}>
      <Btn
        size={compact ? 'sm' : 'md'}
        className={selected.length > 0 ? 'tde-style-trigger tde-style-trigger-on' : 'tde-style-trigger'}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled === true}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={selected.length === 0 ? '选择要换的菜系风格（可多选）' : `只在 ${selected.join('、')} 里换`}
      >
        {label}{countText}
      </Btn>
      {showSummary && selected.length > 0 ? (
        <span className="tde-style-active" title={selected.join('、')}>
          风格：{selected.join('、')}
          <button type="button" className="tde-style-active-clear" onClick={() => onChange([])} title="清除风格限制">×</button>
        </span>
      ) : null}
      {open && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={popRef}
            className="tde-style-pop"
            role="dialog"
            aria-label="选择换菜风格"
            style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH }}
          >
            <div className="tde-style-pop-head">
              <strong>换一个风格推荐</strong>
              <span>选菜系，可多选</span>
            </div>
            <div className="tde-style-chips">
              {REROLL_CUISINES.map((cuisine) => (
                <Chip key={cuisine} active={selected.includes(cuisine)} onClick={() => toggle(cuisine)}>
                  {cuisine}
                </Chip>
              ))}
            </div>
            <div className="tde-style-pop-foot">
              <span className="tde-style-hint">{selected.length === 0 ? '未选 = 全部菜系' : `已选 ${selected.length} 个菜系`}</span>
              <div className="tde-style-pop-actions">
                <Btn size="sm" variant="ghost" onClick={() => onChange([])} disabled={selected.length === 0}>清空</Btn>
                <Btn size="sm" variant="primary" onClick={apply}>按风格换一个</Btn>
              </div>
            </div>
          </div>,
          document.body,
        )
        : null}
    </span>
  )
}

export default StyleReroll
