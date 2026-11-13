/**
 * 面板 · 本周。
 *
 * 7 天午 / 晚餐列表 + 重新规划 + 按天锁定 + 周摘要。
 * 计划由 client 侧调用共享推荐内核生成（host 没有单独的「生成计划」接口，POST /plan 写入即可）；
 * 离线时也能生成，只是暂存浏览器。
 */

import { MEAL_LABELS, addDaysKey, shortDateLabel, todayKey, weekdayOfKey, relativeDayLabel } from '../format.js'
import { dishById, planSummary, weekStartKey } from '../recommend.js'
import { Btn, Empty, Section, Stat, Tag } from '../ui.jsx'

/**
 * 面板 · 本周 tab。
 *
 * @param {{ store: object, snapshot: object }} props 属性
 * @returns {object} React 元素
 */
export default function WeekTab({ store, snapshot }) {
  const { state, saving } = snapshot
  const plan = state.plan
  const today = todayKey()
  const start = typeof plan.start === 'string' ? plan.start : weekStartKey(today)
  const settingsMeals = Array.isArray(state.settings.plannedMeals) && state.settings.plannedMeals.length > 0
    ? state.settings.plannedMeals
    : ['lunch', 'dinner']
  const plannedMeals = settingsMeals.filter((meal) => meal !== 'night')
  const days = Array.from({ length: 7 }, (_, index) => addDaysKey(start, index))
  const picks = Array.isArray(plan.picks) ? plan.picks : []
  const pickMap = new Map()
  for (const pick of picks) pickMap.set(`${pick.date}|${pick.meal}`, pick)
  const summary = planSummary(plan)
  const hasPlan = picks.length > 0
  const locked = plan.locked !== null && typeof plan.locked === 'object' ? plan.locked : {}
  const generatedAt = typeof plan.generatedAt === 'number' && plan.generatedAt > 0
    ? new Date(plan.generatedAt)
    : null

  /**
   * 判断某天是否已锁定（支持 `{date: dishId}` 与 `{date:meal: dishId}` 两种形态）。
   *
   * @param {string} date 日期键
   * @returns {boolean} 是否锁定
   */
  const isDayLocked = (date) =>
    plannedMeals.some((meal) => typeof locked[`${date}:${meal}`] === 'string')
    || typeof locked[date] === 'string'

  /**
   * 锁定 / 解锁某一天（锁定后重新规划会保留这天的安排）。
   *
   * @param {string} date 日期键
   * @returns {void}
   */
  const toggleLock = (date) => {
    const nextLocked = { ...locked }
    const lockedNow = isDayLocked(date)
    for (const key of Object.keys(nextLocked)) {
      if (key === date || key.startsWith(`${date}:`)) delete nextLocked[key]
    }
    if (!lockedNow) {
      // 以当前安排写入 dishId，供 core.planWeek 的 locked 语义原样保留
      let count = 0
      for (const meal of plannedMeals) {
        const pick = pickMap.get(`${date}|${meal}`)
        if (pick !== undefined && typeof pick.dishId === 'string' && pick.dishId !== '') {
          nextLocked[`${date}:${meal}`] = pick.dishId
          count += 1
        }
      }
      if (count === 0) {
        store.toast('这天的安排还没生成，先点「生成一周计划」')
        return
      }
    }
    store.savePlan({ ...plan, locked: nextLocked })
  }

  return (
    <div className="tde-tab tde-tab-week">
      <div className="tde-week-head">
        <div>
          <h3 className="tde-week-title">本周计划</h3>
          <span className="tde-week-range">
            {shortDateLabel(start)} – {shortDateLabel(addDaysKey(start, 6))} · {plannedMeals.map((meal) => MEAL_LABELS[meal]).join(' / ')}
          </span>
        </div>
        <div className="tde-week-actions">
          <Btn
            variant="primary"
            size="sm"
            disabled={saving === true}
            onClick={() => store.regeneratePlan()}
          >
            {saving === true ? '生成中…' : hasPlan ? '重新规划' : '生成一周计划'}
          </Btn>
        </div>
      </div>

      {hasPlan ? (
        <div className="tde-stat-grid tde-stat-grid-week">
          <Stat label="均热量" value={summary.avgKcal} unit=" kcal" hint="每餐平均" />
          <Stat label="均蛋白" value={summary.avgProtein} unit="g" hint="每餐平均" />
          <Stat label="不重复菜" value={summary.uniqueDishes} unit=" 道" hint="本周" />
          <Stat label="菜系" value={summary.cuisines} unit=" 种" hint="多样性" />
          <Stat label="预估花费" value={summary.estimatedCost} unit=" 元" hint="按人均价" />
          <Stat label="外食" value={summary.freeMeals} unit=" 次" hint="外食安排" />
        </div>
      ) : null}

      {hasPlan === false ? (
        <Empty
          emoji="🗓️"
          title="还没有本周计划"
          hint="一键生成 7 天午 / 晚餐安排，尽量不重样；生成后可以按天锁定。"
          action={<Btn variant="primary" size="sm" disabled={saving === true} onClick={() => store.regeneratePlan()}>生成一周计划</Btn>}
        />
      ) : (
        <Section title="七天安排" hint="点「锁定」保留某天，重新规划时不动它">
          <div className="tde-week-list">
            {days.map((date) => {
              const isToday = date === today
              return (
                <div key={date} className={isToday ? 'tde-week-row tde-week-row-today' : 'tde-week-row'}>
                  <div className="tde-week-date">
                    <strong>{shortDateLabel(date)}</strong>
                    <span>{weekdayOfKey(date)}</span>
                    {relativeDayLabel(date, today) !== '' ? <Tag tone={isToday ? 'brand' : 'muted'}>{relativeDayLabel(date, today)}</Tag> : null}
                  </div>
                  <div className="tde-week-meals">
                    {plannedMeals.map((meal) => {
                      const pick = pickMap.get(`${date}|${meal}`)
                      const dish = pick === undefined ? null : dishById(pick.dishId)
                      return (
                        <div key={meal} className="tde-week-cell">
                          <span className="tde-week-meal-label">{MEAL_LABELS[meal] ?? meal}</span>
                          {dish === null ? (
                            <span className="tde-week-cell-empty">未安排</span>
                          ) : (
                            <span className="tde-week-cell-dish">
                              <strong>{dish.emoji ?? '🍽️'} {dish.name}</strong>
                              <Tag tone={pick.mode === 'home' ? 'success' : 'muted'}>{pick.mode === 'home' ? '自制' : '外食'}</Tag>
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    className={isDayLocked(date) ? 'tde-lock tde-lock-on' : 'tde-lock'}
                    title={isDayLocked(date) ? '已锁定：重新规划时保留这天' : '锁定这天的安排'}
                    onClick={() => toggleLock(date)}
                  >
                    {isDayLocked(date) ? '🔒 已锁定' : '🔓 锁定'}
                  </button>
                </div>
              )
            })}
          </div>
          {generatedAt !== null ? (
            <p className="tde-tip-line">
              上次生成：{`${generatedAt.getMonth() + 1}月${generatedAt.getDate()}日 ${String(generatedAt.getHours()).padStart(2, '0')}:${String(generatedAt.getMinutes()).padStart(2, '0')}`}
            </p>
          ) : null}
        </Section>
      )}
    </div>
  )
}
