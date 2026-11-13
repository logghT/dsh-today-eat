/**
 * 「今天吃什么」client 半 —— 横条 / 浮窗共享的推荐卡片。
 *
 * 数据与交互逻辑只有这一份：读取 store 快照、推荐 / 营养 / 饭点提醒 / 备选 / 记录，
 * 用 `variant` 决定展示布局：
 * - `dock`：输入框上方整行横条（含旧的收起一行态）；
 * - `float`：右下角紧凑浮窗（头部由 FloatWindow 传入拖动 handler）。
 *
 * 不在组件里复制推荐算法：全部来自 `snapshot.recommendation` 与 store 方法。
 */

import { MEAL_REMINDER_LABELS, MEAL_LABELS, dateKeyOf, phaseMeta, shanghaiParts } from './format.js'
import { nextMealText } from './mealTime.js'
import { nutritionOf, spicyLabelOf } from './recommend.js'
import { openPanel } from './runtime.js'
import { StyleReroll } from './style-reroll.jsx'
import { useAppStore } from './use-store.js'
import { Btn, Chip } from './ui.jsx'

/**
 * 取卡片所需的全量派生数据（横条 / 浮窗 / 收起小球共用）。
 *
 * @returns {object} 派生数据与 store
 */
export function useRecommendCard() {
  const { store, snapshot } = useAppStore()
  const { state, status, offline, recommendation, mealTime, reminder, toast, saving } = snapshot
  const dish = recommendation === null || recommendation === undefined ? null : recommendation.dish ?? null
  const phase = phaseMeta(state.phase.kind)
  const today = shanghaiParts(new Date()).label
  const nutrition = recommendation === null || recommendation === undefined ? null : recommendation.nutrition ?? nutritionOf(dish)
  const spicy = dish === null ? '' : spicyLabelOf(dish)
  const mealLabelText = recommendation === null || recommendation === undefined
    ? MEAL_LABELS[mealTime === null || mealTime === undefined ? 'lunch' : mealTime.meal] ?? '今天'
    : MEAL_LABELS[recommendation.meal] ?? '今天'
  const targets = state.phase.targets
  const kcalTarget = targets.kcalMin === null || targets.kcalMax === null
    ? '热量不设上限'
    : `${targets.kcalMin}–${targets.kcalMax} kcal`
  const mealKey = recommendation === null || recommendation === undefined ? 'lunch' : recommendation.meal
  const dateKey = recommendation === null || recommendation === undefined
    ? dateKeyOf(new Date())
    : recommendation.dateKey ?? dateKeyOf(new Date())
  const alreadyEaten = dish !== null && state.meals.some((meal) => meal.date === dateKey && meal.meal === mealKey)
  const reason = recommendation === null || recommendation === undefined
    ? ''
    : recommendation.reason !== ''
      ? recommendation.reason
      : typeof dish.description === 'string'
        ? dish.description
        : '按你的口味和阶段挑的'
  const alternatives = recommendation === null || recommendation === undefined || !Array.isArray(recommendation.alternatives)
    ? []
    : recommendation.alternatives
  return {
    store,
    snapshot,
    state,
    status,
    offline,
    recommendation,
    dish,
    phase,
    today,
    nutrition,
    spicy,
    mealLabelText,
    targets,
    kcalTarget,
    mealKey,
    dateKey,
    alreadyEaten,
    reason,
    alternatives,
    nextText: nextMealText(mealTime),
    collapsed: state.ui.collapsed === true,
    floatCollapsed: state.ui.floatCollapsed === true,
    rerollCuisines: Array.isArray(state.ui.rerollCuisines) ? state.ui.rerollCuisines : [],
    reminder,
    toast,
    saving,
  }
}

/**
 * 横条收起态：一行小条，点击展开。
 *
 * @param {{ data: object }} props 属性
 * @returns {object} React 元素
 */
function DockCollapsed({ data }) {
  const { store, dish, phase, reminder, offline } = data
  return (
    <div className="tde-dock" data-today-eat="">
      <button
        type="button"
        className="tde-collapsed"
        onClick={() => store.toggleCollapsed()}
        title="展开「今天吃什么」"
      >
        <span className="tde-collapsed-emoji" aria-hidden="true">🍜</span>
        <span className="tde-phase-mini" title={phase.desc}>{phase.emoji} {phase.label}</span>
        <span className="tde-collapsed-text">今天吃：</span>
        <strong className="tde-collapsed-dish">{dish === null ? '正在挑菜…' : dish.name}</strong>
        {reminder.active ? (
          <span className="tde-collapsed-bell">🔔 {MEAL_REMINDER_LABELS[reminder.meal] ?? '到饭点啦'}</span>
        ) : null}
        {offline ? <span className="tde-badge-offline">本地模式</span> : null}
        <span className="tde-collapsed-hint">点击展开</span>
      </button>
    </div>
  )
}

/**
 * 横条 / 浮窗共用的空态（暂无可推荐菜品）。
 *
 * @param {{ data: object, variant: 'dock' | 'float' }} props 属性
 * @returns {object} React 元素
 */
function EmptyCard({ data, variant }) {
  const { store, phase, status, offline } = data
  const rootClass = variant === 'float' ? 'tde-card tde-float-card tde-card-empty' : 'tde-card tde-card-empty'
  const content = (
    <section className={rootClass} aria-label="今天吃什么">
      <div className="tde-head">
        <span className="tde-phase">{phase.emoji} {phase.full}</span>
        <span className="tde-title">今天吃什么</span>
        {offline ? <span className="tde-badge-offline">本地模式</span> : null}
      </div>
      <p className="tde-empty-line">
        {status === 'loading' ? '管家正在翻菜谱…' : '暂时没有合适的菜，去面板里放宽一下口味限制吧'}
      </p>
      <div className="tde-actions-row">
        <Btn variant="primary" size="sm" onClick={() => openPanel('settings')}>打开设置</Btn>
        <Btn size="sm" variant="ghost" onClick={() => store.refresh()}>重试</Btn>
      </div>
    </section>
  )
  if (variant === 'float') return content
  return (
    <div className="tde-dock" data-today-eat="">
      {content}
    </div>
  )
}

/**
 * 饭点提醒条（横条 / 浮窗共用）。
 *
 * @param {{ data: object, compact?: boolean }} props 属性
 * @returns {object|null} React 元素
 */
function ReminderBar({ data, compact = false }) {
  const { store, dish, reminder, mealKey } = data
  if (reminder.active !== true) return null
  return (
    <div className="tde-reminder" role="alert">
      <span className="tde-reminder-text">
        🔔 {MEAL_REMINDER_LABELS[reminder.meal] ?? '到饭点啦'}，这餐还没记录哦
      </span>
      <div className="tde-reminder-actions">
        <Btn size="sm" variant="primary" onClick={() => store.logMeal({ dish, meal: mealKey })}>好，我吃了</Btn>
        <Btn size="sm" onClick={() => store.snoozeReminder()}>{compact ? '稍后' : '30 分钟后再喊'}</Btn>
        <Btn size="sm" variant="ghost" onClick={() => store.dismissReminder()}>知道了</Btn>
      </div>
    </div>
  )
}

/**
 * 主推荐信息（emoji / 菜名 / 营养 / 理由）。
 *
 * @param {{ data: object, compact?: boolean }} props 属性
 * @returns {object} React 元素
 */
function DishMain({ data, compact = false }) {
  const { dish, nutrition, spicy, targets, kcalTarget, alreadyEaten, reason } = data
  return (
    <div className={compact ? 'tde-main tde-float-main' : 'tde-main'}>
      <span className="tde-emoji" aria-hidden="true">{dish.emoji ?? '🍽️'}</span>
      <div className="tde-body">
        <div className="tde-dish-row">
          <strong className="tde-dish">{dish.name}</strong>
          {typeof dish.cuisine === 'string' && dish.cuisine !== '' ? <span className="tde-meta">{dish.cuisine}</span> : null}
          {spicy !== '' ? <span className="tde-meta">{spicy}</span> : null}
          {typeof dish.price === 'number' ? <span className="tde-meta">人均 ¥{dish.price}</span> : null}
          {alreadyEaten ? <span className="tde-tag tde-tag-success">已记录</span> : null}
        </div>
        <div className="tde-nutrition">
          <span className="tde-nutrition-item">🔥 {nutrition.kcal}{nutrition.estimated ? '（估）' : ''} kcal</span>
          <span className="tde-nutrition-item">🥩 蛋白 {nutrition.proteinG}g</span>
          <span className="tde-nutrition-item tde-nutrition-target">{kcalTarget} / 蛋白 {targets.proteinG}g</span>
        </div>
        <p className={compact ? 'tde-desc tde-desc-clamp' : 'tde-desc'} title={reason}>{reason}</p>
      </div>
    </div>
  )
}

/**
 * 备选 chips（点击直接切换）。
 *
 * @param {{ data: object }} props 属性
 * @returns {object|null} React 元素
 */
function Alternatives({ data }) {
  const { store, alternatives } = data
  if (alternatives.length === 0) return null
  return (
    <div className="tde-alts" role="group" aria-label="备选推荐">
      <span className="tde-alts-label">备选</span>
      {alternatives.map((alternative) => (
        <Chip
          key={alternative.id}
          className="tde-alt"
          title={`换成 ${alternative.name}`}
          onClick={() => store.setManualDish(alternative.id)}
        >
          {alternative.emoji ?? '🍽️'} {alternative.name}
        </Chip>
      ))}
    </div>
  )
}

/**
 * 角落提示文本（离线 / fallback / toast）。
 *
 * @param {{ data: object, compact?: boolean }} props 属性
 * @returns {object} React 元素
 */
function CardNotes({ data, compact = false }) {
  const { offline, recommendation, toast } = data
  const fallbackNote = recommendation === null || recommendation === undefined ? '' : recommendation.fallbackNote
  return (
    <>
      {compact ? null : offline ? (
        <p className="tde-note">本地模式：host 服务未连接，推荐用内置菜谱，记录先存浏览器。</p>
      ) : null}
      {fallbackNote !== null && fallbackNote !== undefined && fallbackNote !== '' ? (
        <p className="tde-note">{fallbackNote}</p>
      ) : null}
      {toast !== null && toast !== undefined ? (
        <p className={`tde-note tde-note-${toast.kind ?? 'info'}`}>{toast.text}</p>
      ) : null}
      {compact && offline ? (
        <p className="tde-note">本地模式：host 未连接，记录先存浏览器。</p>
      ) : null}
    </>
  )
}

/**
 * 横条（dock）布局。
 *
 * @param {{ data: object, onFloat: Function }} props 属性
 * @returns {object} React 元素
 */
function DockCard({ data, onFloat }) {
  const { store, phase, today, mealLabelText, offline, saving, nextText } = data
  return (
    <div className="tde-dock" data-today-eat="">
      <section className="tde-card" aria-label="今天吃什么">
        <header className="tde-head">
          <span className="tde-phase" title={phase.desc}>{phase.emoji} {phase.full}</span>
          <span className="tde-title">今天吃什么</span>
          <span className="tde-sub">{mealLabelText} · {today}</span>
          {offline ? <span className="tde-badge-offline" title="host 服务未连接，正在使用浏览器缓存">本地模式</span> : null}
          <div className="tde-actions">
            <Btn variant="primary" size="sm" onClick={() => openPanel('today')}>打开面板</Btn>
            <Btn variant="ghost" size="sm" onClick={onFloat}>浮窗</Btn>
            <Btn variant="ghost" size="sm" onClick={() => store.toggleCollapsed()}>收起</Btn>
          </div>
        </header>

        <ReminderBar data={data} />

        <DishMain data={data} />

        <footer className="tde-foot">
          <div className="tde-actions-row">
            <Btn variant="primary" onClick={() => store.logMeal({ dish: data.dish, meal: data.mealKey })} disabled={saving === true}>我吃了</Btn>
            <Btn onClick={() => store.reroll()}>换一个</Btn>
            <StyleReroll
              cuisines={data.rerollCuisines}
              onChange={(next) => { void store.setRerollCuisines(next) }}
              onReroll={() => store.reroll()}
              disabled={saving === true}
            />
            <Btn onClick={() => openPanel('today', 'nearby')}>附近吃</Btn>
            <Btn onClick={() => openPanel('today', 'cook')}>自己做</Btn>
            <span className="tde-hint">{nextText}</span>
          </div>
          <Alternatives data={data} />
          <CardNotes data={data} />
        </footer>
      </section>
    </div>
  )
}

/**
 * 浮窗（float）紧凑布局：头部拖动 handler 由 FloatWindow 注入。
 *
 * @param {{ data: object, dragHandlers?: object, onDock: Function, onCollapse: Function }} props 属性
 * @returns {object} React 元素
 */
function FloatCard({ data, dragHandlers, onDock, onCollapse }) {
  const { store, phase, today, mealLabelText, offline, saving, nextText } = data
  return (
    <section className="tde-card tde-float-card" aria-label="今天吃什么（浮窗）">
      <header className="tde-head tde-float-head" title="按住空白处拖动 · 双击打开面板" {...dragHandlers}>
        <span className="tde-float-grip" aria-hidden="true">⠿</span>
        <span className="tde-phase" title={phase.desc}>{phase.emoji} {phase.full}</span>
        <span className="tde-sub">{mealLabelText} · {today}</span>
        {offline ? <span className="tde-badge-offline" title="host 服务未连接，正在使用浏览器缓存">本地模式</span> : null}
      </header>

      <ReminderBar data={data} compact />

      <DishMain data={data} compact />

      <Alternatives data={data} />

      <footer className="tde-foot">
        <div className="tde-actions-row">
          <Btn variant="primary" size="sm" onClick={() => store.logMeal({ dish: data.dish, meal: data.mealKey })} disabled={saving === true}>我吃了</Btn>
          <Btn size="sm" onClick={() => store.reroll()}>换一个</Btn>
          <StyleReroll
            compact
            showSummary={false}
            cuisines={data.rerollCuisines}
            onChange={(next) => { void store.setRerollCuisines(next) }}
            onReroll={() => store.reroll()}
            disabled={saving === true}
          />
          <Btn size="sm" onClick={() => openPanel('today', 'nearby')}>附近吃</Btn>
          <Btn size="sm" onClick={() => openPanel('today', 'cook')}>自己做</Btn>
        </div>
        <div className="tde-actions-row tde-float-secondary">
          <Btn size="sm" variant="ghost" onClick={onDock}>停靠横条</Btn>
          <Btn size="sm" variant="ghost" onClick={() => openPanel('today')}>打开面板</Btn>
          <Btn size="sm" variant="ghost" onClick={onCollapse}>收起</Btn>
        </div>
        <span className="tde-hint">{nextText}</span>
        <CardNotes data={data} compact />
      </footer>
    </section>
  )
}

/**
 * 推荐卡片：`variant='dock' | 'float'`。
 *
 * @param {{ variant?: 'dock' | 'float', dragHandlers?: object, onFloat?: Function, onDock?: Function, onCollapse?: Function }} props 属性
 * @returns {object|null} React 元素
 */
export function RecommendCard({ variant = 'dock', dragHandlers, onFloat, onDock, onCollapse }) {
  const data = useRecommendCard()
  const { store, dish } = data

  if (variant === 'dock' && data.collapsed) return <DockCollapsed data={data} />

  if (dish === null) return <EmptyCard data={data} variant={variant} />

  if (variant === 'float') {
    return (
      <FloatCard
        data={data}
        dragHandlers={dragHandlers}
        onDock={onDock ?? (() => store.setDisplayMode('dock'))}
        onCollapse={onCollapse ?? (() => store.setFloatCollapsed(true))}
      />
    )
  }

  return <DockCard data={data} onFloat={onFloat ?? (() => store.setDisplayMode('float'))} />
}

export default RecommendCard
