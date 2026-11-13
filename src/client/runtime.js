/**
 * 「今天吃什么」client 半 —— 运行时桥接。
 *
 * 插件 apply(ctx) 时把「打开右栏面板」能力写进 runtime，横条 / 面板按钮通过它导航。
 * 拿不到 sidebarRight（无前台会话、旧版本宿主）时静默失败，横条仍然可用。
 */

/** 运行时桥：由 index.js 的 apply 注入。 */
export const runtime = {
  /** @type {null | ((tab?: string, focus?: string | null) => void)} */
  openPanel: null,
  /** @type {null | ((tab?: string) => void)} 右栏不可用时的兜底面板 */
  openFallback: null,
  /** @type {object | null} */
  ctx: null,
}

/**
 * 判断右栏面板当前是否真的可见（用于决定是否启用兜底面板）。
 * 排除兜底面板自己渲染的 `.tde-panel`。
 *
 * @returns {boolean} 面板可见
 */
function panelIsVisible() {
  if (typeof document === 'undefined') return true
  const panels = [...document.querySelectorAll('.tde-panel')]
  for (const panel of panels) {
    if (typeof panel.closest === 'function' && panel.closest('[data-tde-fallback]') !== null) continue
    if (typeof panel.getBoundingClientRect === 'function') {
      const rect = panel.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return true
    }
  }
  return false
}

/**
 * 注册「打开面板」实现。
 *
 * @param {null | ((tab?: string, focus?: string | null) => void)} opener 打开函数
 * @returns {void}
 */
export function setPanelOpener(opener) {
  runtime.openPanel = typeof opener === 'function' ? opener : null
}

/**
 * 右栏收起时，点一下官方的「展开右侧边栏」按钮（存在时才点）。
 *
 * `sidebarRight.openTab()` 只负责切到我们的 tab；如果用户之前把右侧栏收起了，
 * 面板虽然选中却看不见。这里在打开后补两次点击（等 React 提交 DOM），保证面板真正显示。
 *
 * @returns {void}
 */
function ensureSidebarExpanded() {
  if (typeof document === 'undefined') return undefined
  const clickExpand = () => {
    try {
      const button = document.querySelector('[data-sidebar-right-expand]')
      if (button !== null && button !== undefined && typeof button.click === 'function') button.click()
    } catch {
      // 忽略：拿不到展开按钮时保持静默
    }
  }
  if (typeof setTimeout === 'function') {
    setTimeout(clickExpand, 80)
    setTimeout(clickExpand, 400)
    return undefined
  }
  clickExpand()
  return undefined
}

/**
 * 打开右栏面板（失败静默）。
 *
 * @param {string} [tab='today'] 面板 tab
 * @param {string | null} [focus=null] 需要滚动 / 自动加载的分区（nearby / cook）
 * @returns {void}
 */
export function openPanel(tab = 'today', focus = null) {
  let opened = false
  try {
    if (typeof runtime.openPanel === 'function') {
      runtime.openPanel(tab, focus)
      opened = true
    }
  } catch {
    // 拿不到右栏 / 无前台会话：静默，横条本身仍可用。
  }
  if (opened) ensureSidebarExpanded()
  // 右栏打开是异步的（还要等路由/会话切换）；轮询最多 ~1.5s 确认面板真的显示出来。
  // 始终看不到（无前台会话 / 在插件页等非会话页面 / 右栏服务不可用）就打开插件
  // 自带的兜底面板，保证点按钮一定有反馈；右栏正常时不会弹兜底。
  if (typeof setTimeout === 'function') {
    const startedAt = Date.now()
    const tick = () => {
      if (panelIsVisible()) return
      if (Date.now() - startedAt >= 1500) {
        try {
          if (typeof runtime.openFallback === 'function') runtime.openFallback(tab)
        } catch {
          // 兜底失败：保持静默
        }
        return
      }
      setTimeout(tick, 150)
    }
    setTimeout(tick, 150)
  }
}
