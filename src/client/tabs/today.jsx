/**
 * 面板 · 今天。
 *
 * 内容：餐次横幅 → 推荐大卡（营养 vs 目标进度条）→ 备选 → 附近（按需加载高德）→
 * 自制（菜谱步骤 + 采买清单）。任何接口不可用时都有明确的空态 / 错误态 / 本地模式提示。
 */

import { useEffect } from 'react'
import { referenceLinksOf } from '../../core/reference.js'
import { MEAL_LABELS, dateKeyOf, phaseMeta, todayKey } from '../format.js'
import { mealWindowText, nextMealText } from '../mealTime.js'
import { CATALOG, dayTotals, dishById, nutritionOf, spicyLabelOf } from '../recommend.js'
import { hasRecipes, recipeForDish } from '../recipes.js'
import { StyleReroll } from '../style-reroll.jsx'
import { Btn, Chip, Empty, Loading, Progress, Section, Stat, Tag } from '../ui.jsx'

/**
 * 热量目标展示文案（relax / indulgence 阶段 core 不设硬上限）。
 *
 * @param {{ kcalMin: number | null, kcalMax: number | null, proteinG: number }} targets 目标
 * @returns {string} 文案
 */
function kcalTargetText(targets) {
  if (targets.kcalMin === null || targets.kcalMax === null) return '热量不设硬上限'
  return `${targets.kcalMin}–${targets.kcalMax} kcal`
}

/**
 * 距离展示。
 *
 * @param {unknown} distance 距离（米）
 * @returns {string} 文本
 */
function formatDistance(distance) {
  if (typeof distance !== 'number' || !Number.isFinite(distance)) return ''
  if (distance < 1000) return `${Math.round(distance)}m`
  return `${(distance / 1000).toFixed(1)}km`
}

/**
 * 把 host 返回的 suggestions（字符串 / 对象混合）归一成 [{ title, text }]。
 *
 * @param {unknown} suggestions suggestions
 * @returns {Array<{ title: string, text: string }>} 归一化结果
 */
function normalizeSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return []
  const result = []
  for (const item of suggestions) {
    if (typeof item === 'string') {
      if (item !== '') result.push({ title: '', text: item })
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const title = typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : ''
    const text = typeof item.text === 'string' ? item.text : typeof item.suggestion === 'string' ? item.suggestion : ''
    if (text === '' && title === '') continue
    result.push({ title, text: text === '' ? title : text })
  }
  return result
}

/**
 * 从推荐 / 备选 / 今日计划里挑一道可自制的菜。
 *
 * @param {object} state state
 * @param {object | null} recommendation 推荐
 * @returns {object | null} 可自制菜品
 */
function pickCookDish(state, recommendation) {
  const candidates = []
  if (recommendation !== null && recommendation.dish !== null) candidates.push(recommendation.dish)
  if (recommendation !== null && Array.isArray(recommendation.alternatives)) candidates.push(...recommendation.alternatives)
  const today = todayKey()
  const picks = state.plan !== null && state.plan !== undefined && Array.isArray(state.plan.picks) ? state.plan.picks : []
  for (const pick of picks) {
    if (pick.date !== today) continue
    const dish = dishById(pick.dishId)
    if (dish !== null) candidates.push(dish)
  }
  for (const dish of CATALOG) {
    if (dish.cookable === true || recipeForDish(dish.recipeId ?? dish.id) !== null) {
      candidates.push(dish)
      break
    }
  }
  for (const dish of candidates) {
    if (dish === null || dish === undefined) continue
    if (dish.cookable === true || recipeForDish(dish.recipeId ?? dish.id) !== null) return dish
  }
  return null
}

/**
 * 菜谱食材按 group 分组。
 *
 * @param {Array<object>} ingredients 食材
 * @returns {Array<{ group: string, items: Array<object> }>} 分组
 */
function groupIngredients(ingredients) {
  const groups = new Map()
  for (const item of Array.isArray(ingredients) ? ingredients : []) {
    const group = typeof item.group === 'string' && item.group !== '' ? item.group : '其他'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(item)
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
}

/**
 * 面板 · 今天 tab。
 *
 * @param {{ store: object, snapshot: object }} props 属性
 * @returns {object} React 元素
 */
export default function TodayTab({ store, snapshot }) {
  const { state, recommendation, mealTime, offline, nearby, shopping, panelFocus } = snapshot

  useEffect(() => {
    if (panelFocus === 'nearby') {
      store.loadNearby()
      store.clearPanelFocus()
    } else if (panelFocus === 'cook') {
      if (hasRecipes() && shopping.status === 'idle') store.loadShopping(3)
      store.clearPanelFocus()
    }
  }, [panelFocus, store, shopping.status])

  const dateKey = dateKeyOf(new Date())
  const dish = recommendation === null || recommendation === undefined ? null : recommendation.dish
  const nutrition = recommendation === null || recommendation === undefined ? nutritionOf(dish) : recommendation.nutrition
  const targets = state.phase.targets
  const totals = dayTotals(state.meals, dateKey)
  const phase = phaseMeta(state.phase.kind)
  const mealKey = recommendation === null || recommendation === undefined ? mealTime.meal : recommendation.meal
  const mealText = MEAL_LABELS[mealKey] ?? '今天'
  const eaten = state.meals.some((meal) => meal.date === dateKey && meal.meal === mealKey)
  const cookDish = pickCookDish(state, recommendation)
  const recipeId = cookDish === null ? '' : cookDish.recipeId ?? cookDish.id
  const recipe = recipeForDish(recipeId)
  const suggestions = normalizeSuggestions(nearby.suggestions)
  const nearbyError = nearby.status === 'error'
  const noKey = nearby.status === 'no-key'

  /**
   * 保存设置里改「高德 Key」。
   *
   * @returns {void}
   */
  const goSettings = () => store.setPanelTab('settings')

  return (
    <div className="tde-tab tde-tab-today">
      {/* 餐次横幅 */}
      <div className="tde-meal-banner">
        <div className="tde-meal-banner-main">
          <span className="tde-meal-banner-emoji" aria-hidden="true">{phase.emoji}</span>
          <div>
            <div className="tde-meal-banner-title">
              {mealText}
              <span className="tde-meal-banner-window">
                {mealTime.phase === 'in' ? `${mealWindowText(mealTime)} · 正在饭点` : nextMealText(mealTime)}
              </span>
              {eaten ? <Tag tone="success">这餐已记录</Tag> : <Tag tone="warn">还没记录</Tag>}
            </div>
            <div className="tde-meal-banner-sub">{phase.full} · 目标 {kcalTargetText(targets)} / 蛋白 {targets.proteinG}g</div>
          </div>
        </div>
        <div className="tde-meal-banner-actions">
          {dish !== null ? (
            <Btn variant="primary" size="sm" disabled={snapshot.saving === true} onClick={() => store.logMeal({ dish, meal: mealKey })}>
              我吃了
            </Btn>
          ) : null}
          <Btn size="sm" onClick={() => store.reroll()}>换一道</Btn>
          <StyleReroll
            cuisines={Array.isArray(state.ui.rerollCuisines) ? state.ui.rerollCuisines : []}
            onChange={(next) => { void store.setRerollCuisines(next) }}
            onReroll={() => store.reroll()}
            disabled={snapshot.saving === true}
          />
        </div>
      </div>

      {/* 推荐大卡 */}
      {dish === null ? (
        <Empty emoji="🍜" title="暂时没有推荐" hint="去设置里放宽口味限制，或稍后重试" action={<Btn size="sm" onClick={() => store.refresh()}>重试</Btn>} />
      ) : (
        <article className="tde-hero">
          <div className="tde-hero-main">
            <span className="tde-hero-emoji" aria-hidden="true">{dish.emoji ?? '🍽️'}</span>
            <div className="tde-hero-body">
              <div className="tde-hero-title-row">
                <strong className="tde-hero-dish">{dish.name}</strong>
                {typeof dish.cuisine === 'string' && dish.cuisine !== '' ? <span className="tde-meta">{dish.cuisine}</span> : null}
                {spicyLabelOf(dish) !== '' ? <span className="tde-meta">{spicyLabelOf(dish)}</span> : null}
                {typeof dish.price === 'number' ? <span className="tde-meta">人均 ¥{dish.price}</span> : null}
              </div>
              <p className="tde-hero-reason">{recommendation.reason !== '' ? recommendation.reason : dish.description}</p>
              <div className="tde-hero-nutrition">
                <span>🔥 {nutrition.kcal}{nutrition.estimated ? '（估）' : ''} kcal</span>
                <span>🥩 蛋白 {nutrition.proteinG}g</span>
                <span>🥬 蔬菜 {nutrition.veg} 份</span>
              </div>
            </div>
          </div>
          <div className="tde-hero-progress">
            <Progress
              label="今日热量"
              value={totals.kcal}
              max={targets.kcalMax ?? Math.max(totals.kcal, 2600)}
              unit=" kcal"
              band={targets.kcalMin !== null && targets.kcalMax !== null ? [targets.kcalMin, targets.kcalMax] : null}
              hint={`${kcalTargetText(targets)} · 已记录 ${totals.count} 餐`}
            />
            <Progress
              label="今日蛋白"
              value={totals.proteinG}
              max={targets.proteinG}
              unit="g"
              hint={`目标 ${targets.proteinG}g`}
            />
          </div>
          {recommendation.alternatives.length > 0 ? (
            <div className="tde-hero-alts">
              <span className="tde-muted-label">备选</span>
              {recommendation.alternatives.map((alternative) => (
                <Chip key={alternative.id} active={false} onClick={() => store.setManualDish(alternative.id)}>
                  {alternative.emoji ?? '🍽️'} {alternative.name}
                </Chip>
              ))}
            </div>
          ) : null}
        </article>
      )}

      {/* 今日营养概览 */}
      <Section title="今日营养" hint={`已记录 ${totals.count} 餐`}>
        <div className="tde-stat-grid">
          <Stat label="热量" value={totals.kcal} unit=" kcal" hint={kcalTargetText(targets)} />
          <Stat label="蛋白质" value={totals.proteinG} unit="g" hint={`目标 ${targets.proteinG}g`} />
          <Stat label="蔬菜" value={totals.veg} unit=" 份" hint="建议每天 2–3 份" />
          <Stat label="记录" value={totals.count} unit=" 餐" hint={offline ? '本地模式' : '今日'} />
        </div>
      </Section>

      {/* 附近 */}
      <Section
        id="today-nearby"
        title="附近吃"
        hint="按当前饭点搜周边餐厅"
        extra={
          <Btn size="sm" onClick={() => store.loadNearby()} disabled={nearby.status === 'loading'}>
            {nearby.status === 'loading' ? '搜索中…' : nearby.status === 'idle' ? '搜附近' : '刷新'}
          </Btn>
        }
      >
        {nearby.weather !== null && nearby.weather !== undefined && typeof nearby.weather === 'object' ? (
          <div className="tde-weather">
            {typeof nearby.weather.text === 'string' ? <span>{nearby.weather.text}</span> : null}
            {typeof nearby.weather.temperature === 'string' || typeof nearby.weather.temperature === 'number' ? (
              <span>{nearby.weather.temperature}°C</span>
            ) : null}
            {typeof nearby.weather.wind === 'string' ? <span>{nearby.weather.wind}</span> : null}
          </div>
        ) : null}

        {nearby.status === 'idle' ? (
          <Empty emoji="📍" title="还没搜附近" hint="点「搜附近」按你的饭点和预算找周边餐厅（需要配置高德 Key）" />
        ) : null}
        {nearby.status === 'loading' ? <Loading text="正在搜周边餐厅…" /> : null}
        {nearbyError ? (
          <div className="tde-error-box">
            <p>{nearby.error ?? '附近餐厅加载失败'}</p>
            <Btn size="sm" onClick={() => store.loadNearby()}>重试</Btn>
          </div>
        ) : null}
        {noKey ? (
          <div className="tde-tip-box">
            <p>还没有配置高德 Key：先给个关键词去地图 App 里搜，也可以去设置里填 Key 后一键搜周边。</p>
            {nearby.fallbackQueries.length > 0 ? (
              <div className="tde-chip-row">
                {nearby.fallbackQueries.map((query) => (
                  <span key={query} className="tde-tag tde-tag-muted">{query}</span>
                ))}
              </div>
            ) : null}
            <Btn size="sm" variant="primary" onClick={goSettings}>去设置 Key</Btn>
          </div>
        ) : null}
        {nearby.status === 'ready' ? (
          <ul className="tde-list">
            {nearby.items.length === 0 ? <li className="tde-list-empty">附近暂时没搜到符合预算的店，试试放宽半径或关键词。</li> : null}
            {nearby.items.map((item, index) => (
              <li key={`${item.name ?? 'shop'}-${index}`} className="tde-list-row tde-place">
                <div className="tde-place-main">
                  <strong className="tde-place-name">{item.name ?? '未命名餐厅'}</strong>
                  {typeof item.distance === 'number' ? <span className="tde-place-distance">{formatDistance(item.distance)}</span> : null}
                  {typeof item.rating === 'number' && item.rating > 0 ? <span className="tde-place-rating">★ {item.rating}</span> : null}
                  {typeof item.cost === 'number' && item.cost > 0 ? <span className="tde-place-cost">人均 ¥{item.cost}</span> : null}
                </div>
                {typeof item.address === 'string' && item.address !== '' ? <p className="tde-place-address">{item.address}</p> : null}
                {item.suggestion !== undefined && item.suggestion !== null && item.suggestion !== '' ? (
                  <p className={`tde-place-suggestion ${item.orderKind === 'chain' ? 'is-chain' : 'is-unknown'}`}>
                    点单建议：{typeof item.suggestion === 'string' ? item.suggestion : item.suggestion.text ?? ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {suggestions.length > 0 ? (
          <div className="tde-suggestions">
            <span className="tde-muted-label">点单建议</span>
            {suggestions.map((item, index) => (
              <p key={index} className="tde-suggestion">
                {item.title !== '' ? <strong>{item.title}：</strong> : null}
                {item.text}
              </p>
            ))}
          </div>
        ) : null}
      </Section>

      {/* 自己做 */}
      <Section id="today-cook" title="自己做" hint="菜谱 + 采买清单">
        {hasRecipes() === false ? (
          <Empty emoji="📖" title="菜谱数据未就绪" hint="数据文件 data/recipes.js 会在 v2 集成时带上；目前仍可看推荐与记录。" />
        ) : cookDish === null ? (
          <Empty emoji="🍳" title="暂无自制推荐" hint="换一道可自制的菜，或者去本周计划里生成带做饭的计划。" />
        ) : (
          <div className="tde-recipe">
            <div className="tde-recipe-head">
              <span className="tde-recipe-emoji" aria-hidden="true">{cookDish.emoji ?? '🍳'}</span>
              <div className="tde-recipe-title-box">
                <strong className="tde-recipe-title">{recipe !== null && typeof recipe.name === 'string' ? recipe.name : cookDish.name}</strong>
                <span className="tde-recipe-meta">
                  {recipe !== null ? `备料 ${recipe.prepMin ?? '—'} 分钟 · 烹饪 ${recipe.cookMin ?? '—'} 分钟 · 难度 ${recipe.difficulty ?? '—'}` : '菜谱数据待补'}
                  {recipe !== null && typeof recipe.kcal === 'number' ? ` · ${recipe.kcal} kcal` : ''}
                </span>
              </div>
              <Btn size="sm" onClick={() => store.loadShopping(3)} disabled={shopping.status === 'loading'}>
                {shopping.status === 'loading' ? '汇总中…' : '采买清单'}
              </Btn>
            </div>

            {recipe !== null && (Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0) ? (
              <div className="tde-recipe-ingredients">
                {groupIngredients(recipe.ingredients).map((group) => (
                  <div key={group.group} className="tde-ingredient-group">
                    <span className="tde-ingredient-group-title">{group.group}</span>
                    <div className="tde-ingredient-items">
                      {group.items.map((item, index) => (
                        <span key={`${item.name}-${index}`} className="tde-ingredient">
                          {item.name}
                          {item.amount !== undefined && item.amount !== null && item.amount !== '' ? ` ${item.amount}${item.unit ?? ''}` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="tde-tip-line">
                {cookDish.ingredients !== undefined && Array.isArray(cookDish.ingredients) && cookDish.ingredients.length > 0
                  ? `主要食材：${cookDish.ingredients.join('、')}`
                  : '这道菜的详细用量还没收录。'}
              </p>
            )}

            {recipe !== null && Array.isArray(recipe.steps) && recipe.steps.length > 0 ? (
              <ol className="tde-recipe-steps">
                {recipe.steps.map((step, index) => (
                  <li key={index} className="tde-recipe-step">
                    <span className="tde-step-index">{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            ) : null}

            {recipe !== null && Array.isArray(recipe.tips) && recipe.tips.length > 0 ? (
              <ul className="tde-recipe-tips">
                {recipe.tips.map((tip, index) => <li key={index}>{tip}</li>)}
              </ul>
            ) : null}

            {referenceLinksOf(recipe !== null && typeof recipe.name === 'string' ? recipe.name : cookDish.name).length > 0 ? (
              <div className="tde-recipe-refs">
                <span className="tde-recipe-refs-label">做法参考（外部）</span>
                {referenceLinksOf(recipe !== null && typeof recipe.name === 'string' ? recipe.name : cookDish.name).map((link) => (
                  <a
                    key={link.id}
                    className="tde-ref-link"
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`${link.hint}：在${link.label}搜索「${recipe !== null && typeof recipe.name === 'string' ? recipe.name : cookDish.name}」`}
                  >
                    {link.label} ↗
                  </a>
                ))}
                <span className="tde-recipe-refs-hint">不同人做法不同，可多对比几家</span>
              </div>
            ) : null}

            {shopping.status === 'loading' ? <Loading text="正在按计划汇总采买清单…" /> : null}
            {shopping.status === 'error' ? (
              <div className="tde-error-box">
                <p>{shopping.error ?? '采买清单加载失败'}</p>
                <Btn size="sm" onClick={() => store.loadShopping(3)}>重试</Btn>
              </div>
            ) : null}
            {shopping.status === 'ready' ? (
              <div className="tde-shopping">
                <div className="tde-shopping-head">
                  <span>
                    采买清单{shopping.window !== null && typeof shopping.window === 'object' ? `（${shopping.window.from ?? ''} ~ ${shopping.window.to ?? ''}）` : ''}
                  </span>
                  <span className="tde-shopping-cost">预估 ¥{shopping.estimatedCost}</span>
                </div>
                {shopping.groups.length === 0 ? <p className="tde-tip-line">窗口内没有可汇总的菜谱。</p> : null}
                {shopping.groups.map((group) => (
                  <div key={group.group} className="tde-shopping-group">
                    <span className="tde-shopping-group-title">{group.group}</span>
                    <div className="tde-shopping-items">
                      {(Array.isArray(group.items) ? group.items : []).map((item, index) => (
                        <span key={`${item.name}-${index}`} className="tde-shopping-item">
                          {item.name}
                          {item.amount !== undefined ? ` ${item.amount}${item.unit ?? ''}` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {shopping.missingRecipes.length > 0 ? (
                  <p className="tde-tip-line">有 {shopping.missingRecipes.length} 道菜暂缺菜谱，未计入清单。</p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  )
}
