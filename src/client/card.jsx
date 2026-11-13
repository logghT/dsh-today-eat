/**
 * 「今天吃什么」输入框横条组件（React）。
 *
 * 挂载点：conversation.input.dock（list slot，session scope），渲染在输入框上方整行。
 * 交互：
 * - 默认展开；「收起」后只剩一行「🍜 今天吃：<菜名>」，点一下即可展开（状态持久化）。
 * - 「换一个」立即重抽，且避开当前菜与本轮已看过的菜 + 近 7 天历史。
 * - 「我吃了」把 { dishId, date, meal } 写入 localStorage 历史，并立即换一道（7 天内不再推荐）。
 * - 三个偏好 chip（素食 / 不吃辣 / 预算≤30）点击即生效并持久化，立刻重算推荐。
 * - 备选 2-3 道，点击直接切换为主推荐。
 *
 * 推荐内核来自 src/core（纯函数，host/client 共用），菜品数据来自 data/dishes.js。
 */

import { useCallback, useMemo, useState } from 'react'
import { DISHES } from '../../data/dishes.js'
import { getDailyPick, inferMeal, pruneHistory, recordPick, reroll } from '../../src/core/recommend.js'
import { ensureStyles } from './styles.js'
import { readHistory, readPreferences, readUi, writeHistory, writePreferences, writeUi } from './storage.js'

/** 餐次中文标签。 */
const MEAL_LABELS = Object.freeze({
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  night: '夜宵',
})

/** 辣度中文标签。 */
const SPICY_LABELS = Object.freeze({ mild: '微辣', medium: '中辣', hot: '重辣' })

/** 星期中文标签（索引与 Date#getDay 一致）。 */
const WEEKDAY_LABELS = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六'])

/** 上海时区固定偏移（中国无夏令时）。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** 偏好 chip 定义：key 对应 localStorage 偏好字段。 */
const PREFERENCE_CHIPS = Object.freeze([
  { key: 'vegetarian', label: '素食', hint: '只推荐素食（不含肉与海鲜）' },
  { key: 'noSpicy', label: '不吃辣', hint: '辣度不超过微辣' },
  { key: 'budget', label: '预算≤30', hint: '人均不超过 30 元' },
])

/**
 * 把 UI 偏好映射成 src/core 的 preferences。
 *
 * @param {{ vegetarian: boolean, noSpicy: boolean, budget: boolean }} preferences UI 偏好
 * @returns {object} core 偏好
 */
function toCorePreferences(preferences) {
  return {
    vegetarian: preferences.vegetarian === true,
    maxSpicy: preferences.noSpicy === true ? 'mild' : 'hot',
    maxPrice: preferences.budget === true ? 30 : null,
  }
}

/**
 * 数字补零。
 *
 * @param {number} value 数字
 * @returns {string} 两位字符串
 */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * 取「今天」的上海日期键与展示文案。
 *
 * @param {Date} date 当前时间
 * @returns {{ dateKey: string, label: string }} 日期信息
 */
function shanghaiDateParts(date) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  const weekday = WEEKDAY_LABELS[shifted.getUTCDay()] ?? ''
  return {
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
    label: `${month}月${day}日 ${weekday}`,
  }
}

/**
 * 取菜品辣度中文标签。
 *
 * @param {object | null} dish 菜品
 * @returns {string} 辣度
 */
function spicyLabel(dish) {
  const tags = dish !== null && Array.isArray(dish.tags) ? dish.tags : []
  const found = tags.find((tag) => Object.prototype.hasOwnProperty.call(SPICY_LABELS, tag))
  return SPICY_LABELS[found] ?? ''
}

/**
 * 一个偏好 chip。
 *
 * @param {{ active: boolean, label: string, hint: string, onToggle: () => void }} props 属性
 * @returns {object} React 元素
 */
function PreferenceChip({ active, label, hint, onToggle }) {
  return (
    <button
      type="button"
      className={active === true ? 'tde-chip tde-chip-on' : 'tde-chip'}
      aria-pressed={active === true}
      title={hint}
      onClick={onToggle}
    >
      {label}
    </button>
  )
}

/**
 * 「今天吃什么」横条（默认导出为槽位组件）。
 *
 * @returns {object} React 元素
 */
export function TodayEatCard() {
  ensureStyles()

  const [preferences, setPreferences] = useState(readPreferences)
  const [history, setHistory] = useState(() => pruneHistory(readHistory(), { today: new Date() }))
  const [view, setView] = useState(readUi)
  const [excludeIds, setExcludeIds] = useState([])
  const [manualId, setManualId] = useState(null)

  // 挂载时固定「今天」，避免每次渲染漂移；跨天重开页面即自然刷新。
  const now = useMemo(() => new Date(), [])
  const meal = useMemo(() => inferMeal(now), [now])
  const dateParts = useMemo(() => shanghaiDateParts(now), [now])

  const result = useMemo(() => {
    const options = {
      date: now,
      meal,
      preferences: toCorePreferences(preferences),
      history,
    }
    // 有本轮排除列表时走 reroll（保证不与当前/已看过的菜重复，也不与历史重复）。
    if (excludeIds.length > 0) return reroll({ ...options, previousIds: excludeIds })
    return getDailyPick(options)
  }, [now, meal, preferences, history, excludeIds])

  const activeDish = useMemo(() => {
    if (manualId === null) return result.dish
    const picked = DISHES.find((dish) => dish.id === manualId)
    return picked === undefined ? result.dish : picked
  }, [manualId, result])

  const alternatives = useMemo(() => {
    const activeId = activeDish === null ? null : activeDish.id
    return result.alternatives.filter((dish) => dish !== null && dish.id !== activeId).slice(0, 3)
  }, [activeDish, result])

  /** 把一道菜加入本轮排除列表（幂等）。 */
  const addExcluded = useCallback((dish) => {
    if (dish === null) return
    setExcludeIds((previous) => (previous.includes(dish.id) ? previous : [...previous, dish.id]))
  }, [])

  const handleReroll = useCallback(() => {
    addExcluded(activeDish)
    setManualId(null)
  }, [activeDish, addExcluded])

  const handleEat = useCallback(() => {
    if (activeDish === null) return
    const eatenAt = new Date()
    const nextHistory = pruneHistory(
      recordPick(history, { dishId: activeDish.id, date: eatenAt, meal: inferMeal(eatenAt) }),
      { today: eatenAt },
    )
    writeHistory(nextHistory)
    setHistory(nextHistory)
    addExcluded(activeDish)
    setManualId(null)
  }, [activeDish, history, addExcluded])

  const togglePreference = useCallback((key) => {
    const next = { ...preferences, [key]: preferences[key] !== true }
    writePreferences(next)
    setPreferences(next)
    setExcludeIds([])
    setManualId(null)
  }, [preferences])

  const toggleCollapsed = useCallback(() => {
    const next = { ...view, collapsed: view.collapsed !== true }
    writeUi(next)
    setView(next)
  }, [view])

  const resetPreferences = useCallback(() => {
    const next = { vegetarian: false, noSpicy: false, budget: false }
    writePreferences(next)
    setPreferences(next)
    setExcludeIds([])
    setManualId(null)
  }, [])

  const hasActivePreference = preferences.vegetarian === true
    || preferences.noSpicy === true
    || preferences.budget === true

  // ── 收起态：只留一行，可点击展开 ────────────────────────
  if (view.collapsed === true) {
    return (
      <div className="tde-dock" data-today-eat="">
        <button
          type="button"
          className="tde-collapsed"
          onClick={toggleCollapsed}
          title="展开「今天吃什么」"
        >
          <span className="tde-collapsed-emoji" aria-hidden="true">🍜</span>
          <span className="tde-collapsed-text">今天吃：</span>
          <strong className="tde-collapsed-dish">{activeDish === null ? '暂无推荐' : activeDish.name}</strong>
          <span className="tde-collapsed-hint">点击展开</span>
        </button>
      </div>
    )
  }

  // ── 展开态：整行卡片 ───────────────────────────────────
  return (
    <div className="tde-dock" data-today-eat="">
      <section className="tde-card" aria-label="今天吃什么">
        <header className="tde-head">
          <span className="tde-title">🍜 今天吃什么</span>
          <span className="tde-sub">{MEAL_LABELS[meal] ?? '今天'} · {dateParts.label}</span>
          <div className="tde-actions">
            <button
              type="button"
              className="tde-btn tde-btn-primary"
              onClick={handleReroll}
              disabled={activeDish === null}
              title="换一道，不与当前菜和近 7 天历史重复"
            >
              换一个
            </button>
            <button
              type="button"
              className="tde-btn"
              onClick={handleEat}
              disabled={activeDish === null}
              title="记入用餐历史，接下来 7 天不再推荐这道菜"
            >
              我吃了
            </button>
            <button type="button" className="tde-btn tde-btn-ghost" onClick={toggleCollapsed}>
              收起
            </button>
          </div>
        </header>

        {activeDish === null ? (
          <div className="tde-empty">
            😅 当前偏好下没有可推荐的菜。
            {hasActivePreference ? (
              <button type="button" className="tde-btn tde-empty-btn" onClick={resetPreferences}>
                重置偏好
              </button>
            ) : null}
          </div>
        ) : (
          <div className="tde-main">
            <span className="tde-emoji" aria-hidden="true">{activeDish.emoji || '🍽️'}</span>
            <div className="tde-body">
              <div className="tde-dish-row">
                <strong className="tde-dish">{activeDish.name}</strong>
                <span className="tde-meta">{activeDish.cuisine}</span>
                <span className="tde-dot">·</span>
                <span className="tde-meta">人均 ¥{activeDish.price}</span>
                {spicyLabel(activeDish) !== '' ? (
                  <span className="tde-dot">·</span>
                ) : null}
                {spicyLabel(activeDish) !== '' ? (
                  <span className="tde-meta">{spicyLabel(activeDish)}</span>
                ) : null}
              </div>
              {typeof activeDish.description === 'string' && activeDish.description !== '' ? (
                <p className="tde-desc">{activeDish.description}</p>
              ) : null}
            </div>
          </div>
        )}

        <footer className="tde-foot">
          <div className="tde-chips" role="group" aria-label="推荐偏好">
            {PREFERENCE_CHIPS.map((chip) => (
              <PreferenceChip
                key={chip.key}
                active={preferences[chip.key] === true}
                label={chip.label}
                hint={chip.hint}
                onToggle={() => togglePreference(chip.key)}
              />
            ))}
          </div>
          {alternatives.length > 0 ? (
            <div className="tde-alts" role="group" aria-label="备选推荐">
              <span className="tde-alts-label">备选</span>
              {alternatives.map((dish) => (
                <button
                  key={dish.id}
                  type="button"
                  className="tde-alt"
                  title={`切换到 ${dish.name}`}
                  onClick={() => setManualId(dish.id)}
                >
                  {dish.emoji || '🍽️'} {dish.name}
                </button>
              ))}
            </div>
          ) : null}
        </footer>

        {typeof result.fallbackNote === 'string' && result.fallbackNote !== '' ? (
          <p className="tde-note">{result.fallbackNote}</p>
        ) : null}
      </section>
    </div>
  )
}

export default TodayEatCard
