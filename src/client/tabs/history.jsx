/**
 * 面板 · 记录。
 *
 * 统计卡（连续记录 / 7 天不重样率 / 蛋白达标率 / 自由餐次数）+ 最近 28 天方块图 +
 * 记录列表（评分 / 删除）+ 导出 JSON。
 */

import { MEAL_LABELS, addDaysKey, todayKey, weekdayOfKey } from '../format.js'
import { CATALOG, dayTotals, dishById } from '../recommend.js'
import { buildTasteProfile } from '../taste.js'
import { Btn, Empty, Section, Stat, Tag } from '../ui.jsx'

/** 评分选项。 */
const RATINGS = Object.freeze([
  { value: 1, label: '👍 喜欢' },
  { value: 0, label: '😐 一般' },
  { value: -1, label: '👎 不喜欢' },
])

/**
 * 导出 JSON（不支持下载的环境给出提示）。
 *
 * @param {object} store store
 * @param {string} today 今天的日期键
 * @returns {void}
 */
function exportJson(store, today) {
  const text = store.exportJson()
  try {
    if (typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') {
      throw new Error('no-download')
    }
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `dsh-today-eat-${today}.json`
    if (document.body !== undefined && document.body !== null && typeof document.body.appendChild === 'function') document.body.appendChild(link)
    if (typeof link.click === 'function') link.click()
    if (typeof link.remove === 'function') link.remove()
    if (typeof setTimeout === 'function') setTimeout(() => URL.revokeObjectURL(url), 1000)
    store.toast('已导出记录 JSON')
  } catch {
    store.toast('当前环境不支持直接下载，可让管家在对话里导出')
  }
}

/**
 * 面板 · 记录 tab。
 *
 * @param {{ store: object, snapshot: object }} props 属性
 * @returns {object} React 元素
 */
export default function HistoryTab({ store, snapshot }) {
  const { state, stats } = snapshot
  const today = todayKey()
  const targets = state.phase.targets
  const meals = [...(Array.isArray(state.meals) ? state.meals : [])].sort((left, right) => {
    const byDate = String(right.date ?? '').localeCompare(String(left.date ?? ''))
    if (byDate !== 0) return byDate
    return (right.ts ?? 0) - (left.ts ?? 0)
  })
  const mealsByDate = new Map()
  for (const meal of meals) {
    if (!mealsByDate.has(meal.date)) mealsByDate.set(meal.date, [])
    mealsByDate.get(meal.date).push(meal)
  }

  // 最近 28 天方块图
  const gridDays = Array.from({ length: 28 }, (_, index) => addDaysKey(today, index - 27))
  // 最近 7 天达标率
  let loggedDays = 0
  let proteinHit = 0
  let kcalHit = 0
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDaysKey(today, -offset)
    const dayMeals = mealsByDate.get(date)
    if (dayMeals === undefined || dayMeals.length === 0) continue
    loggedDays += 1
    const totals = dayTotals(dayMeals, date)
    if (totals.proteinG >= targets.proteinG * 0.9) proteinHit += 1
    if (targets.kcalMin !== null && targets.kcalMax !== null && totals.kcal >= targets.kcalMin && totals.kcal <= targets.kcalMax) kcalHit += 1
  }
  const proteinRate = loggedDays === 0 ? 0 : Math.round((proteinHit / loggedDays) * 100)
  const kcalRate = loggedDays === 0 ? 0 : Math.round((kcalHit / loggedDays) * 100)
  const repeatRate = stats !== null && stats !== undefined && typeof stats.repeatRate === 'number' ? stats.repeatRate : 0
  const uniqueRate = Math.round((1 - Math.max(0, Math.min(1, repeatRate))) * 100)
  const streak = stats !== null && stats !== undefined ? stats.streak ?? 0 : 0
  const freeMeals = stats !== null && stats !== undefined ? stats.freeMealsUsed ?? 0 : 0
  const loggedTotal = stats !== null && stats !== undefined ? stats.loggedDays ?? mealsByDate.size : mealsByDate.size
  // 六维口味画像：有记录按记录统计，无记录回退到档案偏好（契约 taste-v1 §3/§5）
  const tasteProfile = buildTasteProfile(state.meals, CATALOG, state.profile)

  return (
    <div className="tde-tab tde-tab-history">
      <Section
        title="饮食统计"
        hint="记录越久越准"
        extra={<Btn size="sm" onClick={() => exportJson(store, today)}>导出 JSON</Btn>}
      >
        <div className="tde-stat-grid">
          <Stat label="连续记录" value={streak} unit=" 天" hint="从今天往回数" />
          <Stat label="不重样率" value={uniqueRate} unit="%" hint="近 7 天" />
          <Stat label="蛋白达标率" value={proteinRate} unit="%" hint="近 7 天" />
          <Stat label="自由餐" value={freeMeals} unit=" 次" hint="近 7 天外食" />
          <Stat label="累计记录" value={loggedTotal} unit=" 天" hint={`共 ${meals.length} 餐`} />
          <Stat label="热量达标率" value={kcalRate} unit="%" hint="近 7 天" />
        </div>
      </Section>

      <Section
        title="口味画像"
        hint={tasteProfile.mode === 'stats' ? `基于 ${tasteProfile.samples} 餐记录` : '还没有记录，先显示你的偏好设置'}
        extra={tasteProfile.mode === 'preference' ? <Tag tone="muted">偏好设置</Tag> : <Tag tone="brand">统计</Tag>}
      >
        <div className="tde-taste-summary" title="口味偏好摘要">「{tasteProfile.summary}」</div>
        <div className="tde-taste-bars" role="img" aria-label={`口味画像：${tasteProfile.summary}`}>
          {tasteProfile.dimensions.map((dimension) => (
            <div key={dimension.id} className="tde-taste-row">
              <span className="tde-taste-label">{dimension.label}</span>
              <span className="tde-taste-track">
                <span className="tde-taste-fill" style={{ width: `${Math.max(0, Math.min(100, (dimension.value / 5) * 100))}%` }} />
              </span>
              <span className="tde-taste-value">{dimension.value.toFixed(1)}</span>
            </div>
          ))}
        </div>
        {tasteProfile.mode === 'preference' ? (
          <p className="tde-tip-line">记录一餐后，这里会变成你的真实口味统计；当前数值来自「设置 → 档案」的味道偏好。</p>
        ) : (
          <p className="tde-tip-line">统计口径：喜欢 +1.5 权重 / 不喜欢 +0.5 / 一般 +1；数值越高表示你越常吃、越对味。</p>
        )}
      </Section>

      <Section title="最近 28 天" hint="颜色越深，当天记录越多">
        <div className="tde-heat-legend">
          <span>少</span>
          {[0, 1, 2, 3].map((level) => <span key={level} className={`tde-heat-cell tde-heat-${level}`} />)}
          <span>多</span>
        </div>
        <div className="tde-heatmap" role="img" aria-label="最近 28 天记录方块图">
          {gridDays.map((date) => {
            const dayMeals = mealsByDate.get(date) ?? []
            const level = Math.min(3, dayMeals.length)
            const dishNames = dayMeals.map((meal) => {
              const dish = dishById(meal.dishId)
              return dish === null ? meal.dishName ?? meal.dishId : dish.name
            })
            const title = `${date} ${weekdayOfKey(date)} · ${dayMeals.length} 餐${dishNames.length > 0 ? ` · ${dishNames.join('、')}` : ''}`
            return (
              <span
                key={date}
                className={`tde-heat-cell tde-heat-${level}${date === today ? ' tde-heat-today' : ''}`}
                title={title}
                aria-label={title}
              />
            )
          })}
        </div>
      </Section>

      <Section title="记录列表" hint={`${meals.length} 餐`}>
        {meals.length === 0 ? (
          <Empty emoji="📔" title="还没有记录" hint="在横条或「今天」面板点「我吃了」，就会记到这里。" />
        ) : (
          <ul className="tde-list">
            {meals.slice(0, 40).map((meal) => {
              const dish = dishById(meal.dishId)
              const name = dish !== null ? dish.name : meal.dishName ?? meal.dishId ?? '未命名'
              return (
                <li key={meal.id ?? `${meal.date}-${meal.meal}`} className="tde-list-row tde-history-row">
                  <div className="tde-history-main">
                    <div className="tde-history-title">
                      <strong>{name}</strong>
                      <Tag tone="muted">{MEAL_LABELS[meal.meal] ?? meal.meal}</Tag>
                      <span className="tde-history-date">{meal.date}</span>
                      {meal.mode === 'home' ? <Tag tone="success">自制</Tag> : <Tag tone="muted">外食</Tag>}
                    </div>
                    <div className="tde-history-meta">
                      {typeof meal.kcal === 'number' ? <span>🔥 {meal.kcal} kcal</span> : null}
                      {typeof meal.proteinG === 'number' ? <span>🥩 蛋白 {meal.proteinG}g</span> : null}
                      {typeof meal.note === 'string' && meal.note !== '' ? <span>{meal.note}</span> : null}
                    </div>
                  </div>
                  <div className="tde-history-actions">
                    {RATINGS.map((rating) => (
                      <button
                        key={rating.value}
                        type="button"
                        className={meal.rating === rating.value ? 'tde-rate tde-rate-on' : 'tde-rate'}
                        title={`标记为${rating.label}`}
                        aria-pressed={meal.rating === rating.value}
                        onClick={() => store.updateMeal(meal, { rating: rating.value })}
                      >
                        {rating.label}
                      </button>
                    ))}
                    <Btn size="sm" variant="ghost" onClick={() => store.deleteMeal(meal.id)}>删除</Btn>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}
