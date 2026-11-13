/**
 * 面板 · 菜谱库（第 5 个 tab）。
 *
 * 契约：docs/recipe-taxonomy.md §2 + docs/recipe-library.md §2。能力：
 * - 「菜谱库 · N 道」动态标题 + 菜名/食材/菜系/国家/省份搜索；
 * - 场景筛选（全部 / 快手 ≤20 分钟 / 高蛋白 ≥25g / 汤羹 / 素菜）；
 * - 国家筛选行（全部国家 + 数据中出现的国家，带数量）；
 * - 菜系筛选行（全部菜系 + 10 菜系，带数量）；
 * - 省份筛选下拉（全部省份 + 中国省级行政区，带数量；国外菜不参与省份筛选）；
 * - 分组切换：按国家 / 按菜系 / 按省份，列表按分组显示标题 + 数量；
 * - 卡片显示国家/省份/菜系标签，点击展开用量、步骤、tips、4 条外部参考；
 * - 搜索 + 场景 + 国家 + 菜系 + 省份 任意组合，动态「共 N 道 · 当前显示 M 道」。
 */

import { useMemo, useState } from 'react'
import {
  CHINA_COUNTRY,
  CHINA_PROVINCES,
  RECIPE_COUNT,
  RECIPE_CUISINES,
  RECIPE_FILTERS,
  buildRecipeLibraryView,
  buildUserRecipeEntries,
  groupRecipeIngredients,
  mergeRecipeEntries,
  referenceLinksOf,
} from '../recipe-library.js'
import { Btn, Chip, Empty, Tag } from '../ui.jsx'
import RecipeForm from '../recipe-form.jsx'

/** 分组切换选项。 */
const GROUP_OPTIONS = Object.freeze([
  { id: 'country', label: '按国家' },
  { id: 'cuisine', label: '按菜系' },
  { id: 'province', label: '按省份' },
])

/**
 * 外部参考链接（与「今天」面板的 .tde-recipe-refs 同款样式）。
 *
 * @param {{ name: string }} props 属性
 * @returns {object | null} React 元素
 */
function RecipeReferences({ name }) {
  const links = referenceLinksOf(name)
  if (links.length === 0) return null
  return (
    <div className="tde-recipe-refs">
      <span className="tde-recipe-refs-label">做法参考（外部）</span>
      {links.map((link) => (
        <a
          key={link.id}
          className="tde-ref-link"
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${link.hint}：在${link.label}搜索「${name}」`}
        >
          {link.label} ↗
        </a>
      ))}
      <span className="tde-recipe-refs-hint">不同人做法不同，可多对比几家</span>
    </div>
  )
}

/**
 * 菜谱卡片（收起展示摘要，展开展示用量 / 步骤 / tips / 外部参考）。
 *
 * @param {{ entry: object }} props 属性
 * @returns {object} React 元素
 */
function RecipeCard({ entry, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  const groups = useMemo(() => groupRecipeIngredients(entry), [entry])
  return (
    <li className={expanded ? 'tde-list-row tde-recipe-card tde-recipe-card-open' : 'tde-list-row tde-recipe-card'}>
      <button
        type="button"
        className="tde-recipe-card-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => previous !== true)}
      >
        <span className="tde-recipe-card-title">
          <strong className="tde-recipe-card-name">{entry.name}</strong>
          {entry.custom === true ? <Tag tone="brand">我的</Tag> : null}
          <Tag tone="muted">{entry.country}</Tag>
          {entry.province !== null ? <Tag tone="muted">{entry.province}</Tag> : null}
          <Tag tone="muted">{entry.cuisineLabel}</Tag>
          <Tag tone="muted">{entry.difficulty}</Tag>
          <Tag tone="muted">{entry.minutes} 分钟</Tag>
          <span className="tde-recipe-card-arrow" aria-hidden="true">{expanded ? '收起 ▲' : '展开 ▼'}</span>
        </span>
        <span className="tde-recipe-card-nutrition">
          🔥 {entry.kcal} kcal · 🥩 蛋白 {entry.protein}g
        </span>
        <span className="tde-recipe-card-ingredients">
          {entry.primaryIngredients.length > 0 ? `主料：${entry.primaryIngredients.join('、')}` : '主料：—'}
        </span>
      </button>

      {entry.custom === true && typeof onDelete === 'function' ? (
        <div className="tde-recipe-mine-bar">
          <span>这是你添加的菜谱，只保存在本机</span>
          <Btn size="sm" variant="ghost" onClick={() => onDelete(entry)}>删除</Btn>
        </div>
      ) : null}

      {expanded ? (
        <div className="tde-recipe-detail">
          <p className="tde-recipe-detail-meta">
            备料 {entry.prepMin} 分钟 · 烹饪 {entry.cookMin} 分钟 · 难度 {entry.difficulty} · {entry.servings} 人份
          </p>
          {groups.length > 0 ? (
            <div className="tde-recipe-ingredients">
              {groups.map((group) => (
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
          ) : null}
          {entry.steps.length > 0 ? (
            <ol className="tde-recipe-steps">
              {entry.steps.map((step, index) => (
                <li key={index} className="tde-recipe-step">
                  <span className="tde-step-index">{index + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="tde-tip-line">这道菜的步骤还没收录。</p>
          )}
          {entry.tips.length > 0 ? (
            <ul className="tde-recipe-tips">
              {entry.tips.map((tip, index) => <li key={index}>{tip}</li>)}
            </ul>
          ) : null}
          <RecipeReferences name={entry.name} />
        </div>
      ) : null}
    </li>
  )
}

/**
 * 面板 · 菜谱库 tab。
 *
 * @returns {object} React 元素
 */
export default function RecipesTab({ store, snapshot }) {
  const [query, setQuery] = useState('')
  const [scene, setScene] = useState('all')
  const [country, setCountry] = useState('all')
  const [cuisine, setCuisine] = useState('all')
  const [province, setProvince] = useState('all')
  const [groupBy, setGroupBy] = useState('country')
  const [formOpen, setFormOpen] = useState(false)
  const userRecipes = snapshot !== null && snapshot !== undefined && snapshot.state !== null && typeof snapshot.state === 'object'
    ? snapshot.state.userRecipes
    : null
  const entries = useMemo(() => mergeRecipeEntries(userRecipes), [userRecipes])
  const customEntries = useMemo(() => buildUserRecipeEntries(userRecipes), [userRecipes])
  const customCount = customEntries.length
  const totalCount = RECIPE_COUNT + customCount
  const view = useMemo(
    () => buildRecipeLibraryView(entries, { query, scene, country, cuisine, province, groupBy }),
    [entries, query, scene, country, cuisine, province, groupBy],
  )
  const sceneLabel = RECIPE_FILTERS.find((item) => item.id === scene)?.label ?? '全部'
  const provinceOptions = view.provinceList.filter((item) => CHINA_PROVINCES.includes(item))
  const chineseCount = provinceOptions.reduce((sum, item) => sum + (view.counts.province[item] ?? 0), 0)
  const provinceDisabled = country !== 'all' && country !== CHINA_COUNTRY

  /**
   * 清空搜索 / 场景 / 三维筛选。
   *
   * @returns {void}
   */
  const clearAll = () => {
    setQuery('')
    setScene('all')
    setCountry('all')
    setCuisine('all')
    setProvince('all')
    setGroupBy('country')
  }

  /**
   * 删除我的菜谱（先确认，避免误点）。
   *
   * @param {object} entry 菜谱条目
   * @returns {void}
   */
  const deleteRecipe = (entry) => {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`删除「${entry.name}」？删除后不能恢复。`)) return
    void store.removeUserRecipe(entry.id)
  }

  /**
   * 选择国家：切到国外国家时清空省份（省份只对中国菜生效）。
   *
   * @param {string} nextCountry 国家
   * @returns {void}
   */
  const pickCountry = (nextCountry) => {
    setCountry(nextCountry)
    if (nextCountry !== 'all' && nextCountry !== CHINA_COUNTRY) setProvince('all')
  }

  return (
    <div className="tde-tab tde-tab-recipes">
      <div className="tde-recipe-library-head">
        <div className="tde-recipe-library-title-row">
          <h3 className="tde-recipe-library-title">
            菜谱库 · {RECIPE_COUNT} 道
            {customCount > 0 ? <span className="tde-recipe-library-mine-count"> + 我的 {customCount} 道</span> : null}
          </h3>
          <Btn size="sm" variant="primary" onClick={() => setFormOpen(true)}>➕ 添加我的菜</Btn>
        </div>
        <p className="tde-recipe-library-sub">按国家 / 菜系 / 省份浏览，支持搜索与场景筛选；点开看用量、步骤和外部做法参考</p>
      </div>

      <div className="tde-recipe-search">
        <input
          className="tde-input"
          type="search"
          value={query}
          placeholder="搜索菜名、食材、菜系或国家，如「鸡」「泰国」"
          aria-label="搜索菜谱"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query !== '' ? (
          <Btn size="sm" variant="ghost" onClick={() => setQuery('')}>清空</Btn>
        ) : null}
      </div>

      <div className="tde-chip-row tde-recipe-filters" role="group" aria-label="菜谱场景筛选">
        {RECIPE_FILTERS.map((item) => (
          <Chip key={item.id} active={scene === item.id} title={item.hint} onClick={() => setScene(item.id)}>
            {item.label}
          </Chip>
        ))}
        {customCount > 0 ? (
          <Chip active={scene === 'mine'} title="只看你添加的菜谱" onClick={() => setScene('mine')}>
            我的菜谱
            <span className="tde-chip-count">{customCount}</span>
          </Chip>
        ) : null}
      </div>

      <div className="tde-chip-row tde-recipe-taxonomy-row" role="group" aria-label="菜谱国家筛选">
        <span className="tde-recipe-taxonomy-label">国家</span>
        <Chip active={country === 'all'} title={`全部国家 · 当前范围 ${view.counts.base} 道`} onClick={() => pickCountry('all')}>
          全部国家
          <span className="tde-chip-count">{view.counts.base}</span>
        </Chip>
        {view.countryList.map((item) => (
          <Chip
            key={item}
            active={country === item}
            title={`${item} · 当前范围 ${view.counts.country[item] ?? 0} 道`}
            onClick={() => pickCountry(item)}
          >
            {item}
            <span className="tde-chip-count">{view.counts.country[item] ?? 0}</span>
          </Chip>
        ))}
      </div>

      <div className="tde-chip-row tde-recipe-taxonomy-row" role="group" aria-label="菜谱菜系筛选">
        <span className="tde-recipe-taxonomy-label">菜系</span>
        <Chip active={cuisine === 'all'} title={`全部菜系 · 当前范围 ${view.counts.base} 道`} onClick={() => setCuisine('all')}>
          全部菜系
          <span className="tde-chip-count">{view.counts.base}</span>
        </Chip>
        {RECIPE_CUISINES.map((item) => (
          <Chip
            key={item}
            active={cuisine === item}
            title={`${item} · 当前范围 ${view.counts.cuisine[item] ?? 0} 道`}
            onClick={() => setCuisine(item)}
          >
            {item}
            <span className="tde-chip-count">{view.counts.cuisine[item] ?? 0}</span>
          </Chip>
        ))}
      </div>

      <div className="tde-recipe-province-row">
        <label className="tde-recipe-province-label" htmlFor="tde-recipe-province-select">省份</label>
        <select
          id="tde-recipe-province-select"
          className="tde-input tde-province-select"
          value={provinceDisabled ? 'all' : province}
          disabled={provinceDisabled}
          aria-label="按省份筛选菜谱"
          title={provinceDisabled ? '省份筛选只对中国菜生效（当前已选国外国家）' : '按中国省级行政区筛选'}
          onChange={(event) => setProvince(event.target.value)}
        >
          <option value="all">全部省份（{chineseCount}）</option>
          {provinceOptions.map((item) => (
            <option key={item} value={item}>{item}（{view.counts.province[item] ?? 0}）</option>
          ))}
        </select>
        {province !== 'all' ? (
          <Btn size="sm" variant="ghost" onClick={() => setProvince('all')}>清空省份</Btn>
        ) : null}
      </div>

      <div className="tde-recipe-group-switch" role="group" aria-label="菜谱分组方式">
        <span className="tde-recipe-taxonomy-label">分组</span>
        {GROUP_OPTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={groupBy === item.id ? 'tde-segment tde-segment-on' : 'tde-segment'}
            aria-pressed={groupBy === item.id}
            onClick={() => setGroupBy(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <p className="tde-recipe-result-count" title="菜谱总数与当前筛选后的显示数量">
        共 {totalCount} 道{customCount > 0 ? `（含我的 ${customCount} 道）` : ''} · 当前显示 {view.results.length} 道
        {scene !== 'all' ? ` · ${sceneLabel}` : ''}
        {country !== 'all' ? ` · ${country}` : ''}
        {cuisine !== 'all' ? ` · ${cuisine}` : ''}
        {province !== 'all' ? ` · ${province}` : ''}
        {query.trim() !== '' ? ` · 「${query.trim()}」` : ''}
      </p>

      {view.empty ? (
        <Empty
          emoji="🍳"
          title="没有找到匹配的菜谱"
          hint="换个关键词，或清空筛选看看全部菜谱"
          action={(
            <Btn size="sm" variant="primary" onClick={clearAll}>
              清空搜索与筛选
            </Btn>
          )}
        />
      ) : (
        <div className="tde-recipe-region-groups">
          {view.groups.map((group) => (
            <section key={`${groupBy}-${group.id}`} className="tde-recipe-region-group" aria-label={`${group.label}菜谱`}>
              <h4 className="tde-recipe-region-title">
                {group.label}
                <span className="tde-recipe-region-count">{group.entries.length} 道</span>
              </h4>
              <ul className="tde-list tde-recipe-list">
                {group.entries.map((entry) => (
                  <RecipeCard key={entry.id} entry={entry} onDelete={deleteRecipe} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {formOpen ? <RecipeForm store={store} onClose={() => setFormOpen(false)} /> : null}
    </div>
  )
}
