/**
 * 「今天吃什么」输入框上方横条（React）。
 *
 * 挂载点：`conversation.input.dock`（list slot，session scope），渲染在输入框上方整行。
 *
 * v3 多形态：只有 `state.ui.displayMode === 'dock'` 时才渲染（否则返回 null，不占位）；
 * 推荐 / 记录 / 提醒逻辑统一在 `recommend-card.jsx`（variant='dock'），浮窗复用同一份。
 */

import { displayModeOf } from './display.js'
import { RecommendCard, useRecommendCard } from './recommend-card.jsx'
import { ensureStyles } from './styles.js'
import { useAppStore } from './use-store.js'

/**
 * 横条根组件。
 *
 * @returns {object|null} React 元素
 */
export function TodayEatDock() {
  ensureStyles()
  const { snapshot } = useAppStore()
  if (displayModeOf(snapshot.state) !== 'dock') return null
  return <RecommendCard variant="dock" />
}

export { useRecommendCard }
export default TodayEatDock
