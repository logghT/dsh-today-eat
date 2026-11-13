/**
 * 「今天吃什么」右栏面板（React）。
 *
 * 注册方式见 src/client/index.js：sidebarRightTabs.register 声明 tab 类型 +
 * keyed slot sidebar.right.pane.tab / .title 注册正文与标题。
 * 内部五个 tab：今天 / 本周 / 菜谱 / 记录 / 设置，全部真实读写 store。
 */

import { phaseMeta, PANEL_TABS } from './format.js'
import { ensureStyles } from './styles.js'
import { useAppStore } from './use-store.js'
import HistoryTab from './tabs/history.jsx'
import RecipesTab from './tabs/recipes.jsx'
import SettingsTab from './tabs/settings.jsx'
import TodayTab from './tabs/today.jsx'
import WeekTab from './tabs/week.jsx'

/**
 * 面板正文。
 *
 * @returns {object} React 元素
 */
export function TodayEatPanel() {
  ensureStyles()
  const { store, snapshot } = useAppStore()
  const { panelTab, offline, status, errorMessage, toast } = snapshot
  const phase = phaseMeta(snapshot.state.phase.kind)
  const activeTab = PANEL_TABS.some((tab) => tab.id === panelTab) ? panelTab : 'today'

  return (
    <div className="tde-panel" data-today-eat-panel="">
      <header className="tde-panel-head">
        <div className="tde-panel-title-row">
          <span className="tde-panel-title">🍜 今天吃什么</span>
          <span className="tde-panel-phase" title={phase.desc}>{phase.emoji} {phase.full}</span>
          {offline ? <span className="tde-badge-offline" title="host 服务未连接，正在使用浏览器缓存">本地模式</span> : null}
          {status === 'error' ? <span className="tde-badge-error" title={errorMessage ?? ''}>同步异常</span> : null}
        </div>
        <nav className="tde-tabbar" role="tablist" aria-label="今天吃什么面板">
          {PANEL_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? 'tde-tab-button tde-tab-button-on' : 'tde-tab-button'}
              onClick={() => store.setPanelTab(tab.id)}
            >
              <span className="tde-tab-emoji" aria-hidden="true">{tab.emoji}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </header>

      <div className="tde-panel-body" role="tabpanel">
        {activeTab === 'today' ? <TodayTab store={store} snapshot={snapshot} /> : null}
        {activeTab === 'week' ? <WeekTab store={store} snapshot={snapshot} /> : null}
        {activeTab === 'recipes' ? <RecipesTab store={store} snapshot={snapshot} /> : null}
        {activeTab === 'history' ? <HistoryTab store={store} snapshot={snapshot} /> : null}
        {activeTab === 'settings' ? <SettingsTab store={store} snapshot={snapshot} /> : null}
      </div>

      {toast !== null && toast !== undefined ? (
        <div className={`tde-toast tde-toast-${toast.kind ?? 'info'}`} role="status">{toast.text}</div>
      ) : null}
    </div>
  )
}

/**
 * 右栏 tab 标题（实时 chip）。
 *
 * @returns {object} React 元素
 */
export function TodayEatPanelTitle() {
  ensureStyles()
  const { snapshot } = useAppStore()
  const dish = snapshot.recommendation === null || snapshot.recommendation === undefined ? null : snapshot.recommendation.dish
  return <span className="tde-panel-tab-title">今天吃什么{dish === null ? '' : ` · ${dish.name}`}</span>
}

export default TodayEatPanel
