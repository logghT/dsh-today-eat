/**
 * 「今天吃什么」兜底面板（React）。
 *
 * 右栏面板依赖宿主 sidebarRight + 前台会话；在「插件/设置」等没有会话的页面、
 * 或右栏服务不可用时，openPanel 会静默失败。这个组件挂在 shell.overlay 上，
 * 作为独立于宿主的全屏浮层：点插件面板按钮时若右栏面板未出现，就由它显示同一份面板。
 *
 * 触发 / 关闭都通过 store 快照字段 `fallbackPanelOpen`（不写 host，不持久化）。
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { TodayEatPanel } from './panel.jsx'
import { ensureStyles } from './styles.js'
import { useAppStore } from './use-store.js'

/**
 * 兜底面板根组件。
 *
 * @returns {object|null} React 元素
 */
export function TodayEatFallbackPanel() {
  ensureStyles()
  const { store, snapshot } = useAppStore()
  const open = snapshot.fallbackPanelOpen === true

  /**
   * Esc 关闭兜底面板。
   *
   * @param {KeyboardEvent} event 键盘事件
   * @returns {void}
   */
  useEffect(() => {
    if (!open) return undefined
    const handleKey = (event) => {
      if (event !== null && event !== undefined && event.key === 'Escape') store.set({ fallbackPanelOpen: false })
    }
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    window.addEventListener('keydown', handleKey)
    return () => {
      try {
        window.removeEventListener('keydown', handleKey)
      } catch {
        // 忽略
      }
    }
  }, [open, store])

  if (!open) return null

  const close = () => store.set({ fallbackPanelOpen: false })

  const node = (
    <div
      className="tde-fallback-backdrop"
      data-tde-fallback=""
      role="presentation"
      onMouseDown={(event) => {
        if (event !== null && event !== undefined && event.target === event.currentTarget) close()
      }}
    >
      <div className="tde-fallback-card" role="dialog" aria-modal="true" aria-label="今天吃什么面板">
        <button type="button" className="tde-fallback-close" aria-label="关闭面板" title="关闭（Esc）" onClick={close}>
          ×
        </button>
        <div className="tde-fallback-body">
          <TodayEatPanel />
        </div>
      </div>
    </div>
  )

  // 挂到 body 顶层：脱离宿主 overlay 层较低的堆叠上下文，避免被小鲸鱼等浮层盖住
  if (typeof document === 'undefined' || document.body === null || document.body === undefined) return node
  try {
    return createPortal(node, document.body)
  } catch {
    return node
  }
}

export default TodayEatFallbackPanel
