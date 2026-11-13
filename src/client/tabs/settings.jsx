/**
 * 面板 · 设置。
 *
 * 档案 / 阶段 / 饭点 / 提醒（含系统通知授权）/ 高德 Key / 数据说明。
 * 草稿在本地编辑，点「保存更改」一次性 patch 到 host（rev 冲突由 store 自动重拉重试）。
 */

import { useState } from 'react'
import { DISPLAY_MODE_META, displayModeOf, floatPosOf } from '../display.js'
import { MEAL_LABELS, PHASES, PLANNED_MEALS, REGIONS, phaseMeta, subgoalsFor, todayKey } from '../format.js'
import { normalizePhase, normalizeProfile } from '../recommend.js'
import { OTHER_TASTE_HINTS, TASTE_DIMENSIONS, TASTE_HINTS, TASTE_LABELS, applyTasteValue, createTasteDraft } from '../taste.js'
import { Btn, Chip, Field, Section, Segmented, Switch, Tag } from '../ui.jsx'

/** 权限状态中文。 */
const PERMISSION_LABELS = Object.freeze({
  granted: '已授权',
  denied: '已拒绝',
  default: '未申请',
  unsupported: '环境不支持',
})

/**
 * 深拷贝纯 JSON 数据。
 *
 * @param {unknown} value 值
 * @returns {unknown} 副本
 */
function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

/**
 * 从 state 生成可编辑草稿。
 *
 * @param {object} state state
 * @returns {object} 草稿
 */
function createDraft(state) {
  const profile = normalizeProfile(state.profile)
  const phase = normalizePhase(state.phase)
  const settings = state.settings
  return {
    identity: { ...profile.identity },
    // 六维味道 + 油腻接受度 / 尝鲜意愿（旧档案由 core.normalizeTaste 迁移）
    taste: createTasteDraft(profile),
    dietary: {
      vegetarian: profile.dietary.vegetarian === true,
      allergies: Array.isArray(profile.dietary.allergies) ? [...profile.dietary.allergies] : [],
      avoidTags: Array.isArray(profile.dietary.avoidTags) ? [...profile.dietary.avoidTags] : [],
    },
    budget: {
      perMeal: Array.isArray(profile.budget.perMeal) && profile.budget.perMeal.length === 2 ? [...profile.budget.perMeal] : [15, 45],
      weekly: typeof profile.budget.weekly === 'number' ? profile.budget.weekly : 350,
    },
    phase: {
      kind: phase.kind,
      subgoal: phase.subgoal ?? 'fat_loss',
      start: phase.start,
      weeks: phase.weeks,
    },
    mealTimes: clone(settings.mealTimes),
    plannedMeals: [...settings.plannedMeals],
    notify: { ...settings.notify },
  }
}

/**
 * 逗号/空格分隔的文本 → 数组。
 *
 * @param {string} text 文本
 * @returns {string[]} 数组
 */
function splitTags(text) {
  return String(text)
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 面板 · 设置 tab。
 *
 * @param {{ store: object, snapshot: object }} props 属性
 * @returns {object} React 元素
 */
export default function SettingsTab({ store, snapshot }) {
  const [draft, setDraft] = useState(() => createDraft(snapshot.state))
  const [dirty, setDirty] = useState(false)
  const [amapInput, setAmapInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const { offline, hasAmapKey, notificationPermission, state } = snapshot
  const permission = notificationPermission ?? 'unsupported'

  /**
   * 修改草稿。
   *
   * @param {(draft: object) => void} mutate 修改函数
   * @returns {void}
   */
  const update = (mutate) => {
    setDraft((previous) => {
      const next = clone(previous)
      mutate(next)
      return next
    })
    setDirty(true)
  }

  /**
   * 保存全部设置。
   *
   * @returns {Promise<void>}
   */
  const handleSave = async () => {
    const phaseTargets = normalizePhase({
      kind: draft.phase.kind,
      subgoal: draft.phase.subgoal,
      start: draft.phase.start,
      weeks: draft.phase.weeks,
    }).targets
    const ok = await store.patchState(
      {
        profile: {
          identity: draft.identity,
          taste: draft.taste,
          dietary: draft.dietary,
          budget: draft.budget,
        },
        phase: {
          kind: draft.phase.kind,
          subgoal: draft.phase.subgoal,
          start: draft.phase.start,
          weeks: draft.phase.weeks,
          targets: phaseTargets,
        },
        settings: {
          mealTimes: draft.mealTimes,
          plannedMeals: draft.plannedMeals,
          notify: draft.notify,
        },
      },
      { successText: '设置已保存' },
    )
    if (ok) {
      setDirty(false)
      setDraft(createDraft(store.getSnapshot().state))
    }
  }

  /**
   * 保存高德 Key。
   *
   * @returns {Promise<void>}
   */
  const handleSaveKey = async () => {
    setSavingKey(true)
    const ok = await store.saveAmapKey(amapInput)
    setSavingKey(false)
    if (ok) setAmapInput('')
  }

  /**
   * 清除高德 Key。
   *
   * @returns {Promise<void>}
   */
  const handleClearKey = async () => {
    setSavingKey(true)
    await store.saveAmapKey('')
    setSavingKey(false)
    setAmapInput('')
  }

  return (
    <div className="tde-tab tde-tab-settings">
      {offline ? (
        <div className="tde-tip-box tde-tip-box-warn">
          <p>当前是本地模式：设置会暂存在浏览器，等 host 服务恢复后自动再同步。</p>
        </div>
      ) : null}

      <Section title="显示方式" hint="切换后立即生效，保存在 host（重启后仍在）">
        <Segmented
          options={DISPLAY_MODE_META.map((item) => ({ id: item.id, label: item.label, emoji: item.emoji }))}
          value={displayModeOf(state)}
          onChange={(mode) => store.setDisplayMode(mode)}
        />
        <p className="tde-tip-line">
          {DISPLAY_MODE_META.find((item) => item.id === displayModeOf(state))?.desc ?? ''}
        </p>
        <div className="tde-inline-row">
          <Btn size="sm" onClick={() => store.resetFloatPos()}>重置浮窗位置</Btn>
          <span className="tde-muted-label">
            {floatPosOf(state) === null ? '浮窗位置：默认右下角' : `浮窗位置：${floatPosOf(state).x}, ${floatPosOf(state).y}`}
          </span>
        </div>
        <p className="tde-tip-line">浮窗可以按住头部拖动，位置自动保存；窗口缩小时会自动限制在视口内。</p>
      </Section>

      <Section title="档案" hint="推荐与点单建议都会用到">
        <div className="tde-field-grid">
          <Field label="家乡">
            <input className="tde-input" type="text" value={draft.identity.hometown ?? ''} onChange={(event) => update((next) => { next.identity.hometown = event.target.value })} />
          </Field>
          <Field label="城市">
            <input className="tde-input" type="text" value={draft.identity.city ?? ''} onChange={(event) => update((next) => { next.identity.city = event.target.value })} />
          </Field>
          <Field label="区县">
            <input className="tde-input" type="text" value={draft.identity.district ?? ''} onChange={(event) => update((next) => { next.identity.district = event.target.value })} />
          </Field>
          <Field label="大区">
            <select className="tde-input" value={draft.identity.region ?? '西南'} onChange={(event) => update((next) => { next.identity.region = event.target.value })}>
              {REGIONS.map((region) => <option key={region} value={region}>{region}</option>)}
            </select>
          </Field>
        </div>

        <div className="tde-field-label">味道偏好（0 = 无感，5 = 非常喜欢）</div>
        {TASTE_DIMENSIONS.map((dimension) => (
          <Field
            key={dimension}
            label={`${TASTE_LABELS[dimension] ?? dimension}：${draft.taste[dimension] ?? 0} / 5`}
            hint={TASTE_HINTS[dimension] ?? ''}
          >
            <input
              className="tde-range"
              type="range"
              min={0}
              max={5}
              step={1}
              value={draft.taste[dimension] ?? 0}
              aria-label={TASTE_HINTS[dimension] ?? dimension}
              onChange={(event) => update((next) => {
                next.taste = applyTasteValue(next.taste, dimension, Number(event.target.value))
              })}
            />
          </Field>
        ))}
        <Field label={`油腻接受度：${draft.taste.oiliness ?? 2} / 5`} hint={OTHER_TASTE_HINTS.oiliness}>
          <input
            className="tde-range"
            type="range"
            min={0}
            max={5}
            step={1}
            value={draft.taste.oiliness ?? 2}
            onChange={(event) => update((next) => { next.taste.oiliness = Number(event.target.value) })}
          />
        </Field>
        <Field label={`尝鲜意愿：${draft.taste.adventurous ?? 4} / 5`} hint={OTHER_TASTE_HINTS.adventurous}>
          <input
            className="tde-range"
            type="range"
            min={0}
            max={5}
            step={1}
            value={draft.taste.adventurous ?? 4}
            onChange={(event) => update((next) => { next.taste.adventurous = Number(event.target.value) })}
          />
        </Field>
        <Field label="忌口" hint="逗号分隔，例如：香菜，折耳根">
          <input
            className="tde-input"
            type="text"
            value={(draft.dietary.avoidTags ?? []).join('，')}
            onChange={(event) => update((next) => { next.dietary.avoidTags = splitTags(event.target.value) })}
          />
        </Field>
        <Field label="过敏原" hint="逗号分隔，留空表示没有">
          <input
            className="tde-input"
            type="text"
            value={(draft.dietary.allergies ?? []).join('，')}
            onChange={(event) => update((next) => { next.dietary.allergies = splitTags(event.target.value) })}
          />
        </Field>
        <Switch
          label="素食"
          hint="只推荐不含肉与海鲜的菜"
          checked={draft.dietary.vegetarian === true}
          onChange={(checked) => update((next) => { next.dietary.vegetarian = checked })}
        />
        <div className="tde-field-grid">
          <Field label="单餐预算下限（元）">
            <input
              className="tde-input"
              type="number"
              min={0}
              value={draft.budget.perMeal[0]}
              onChange={(event) => update((next) => { next.budget.perMeal[0] = Number(event.target.value) })}
            />
          </Field>
          <Field label="单餐预算上限（元）">
            <input
              className="tde-input"
              type="number"
              min={1}
              value={draft.budget.perMeal[1]}
              onChange={(event) => update((next) => { next.budget.perMeal[1] = Number(event.target.value) })}
            />
          </Field>
        </div>
      </Section>

      <Section title="饮食阶段" hint="按目标或吃饭场景选；旧阶段会自动迁移">
        <div className="tde-chip-row">
          {PHASES.map((kind) => {
            const meta = phaseMeta(kind)
            return (
              <Chip
                key={kind}
                active={draft.phase.kind === kind}
                title={meta.desc}
                onClick={() => update((next) => {
                  next.phase.kind = kind
                  next.phase.subgoal = subgoalsFor(kind)[0]?.id ?? null
                })}
              >
                {meta.emoji} {meta.label}
              </Chip>
            )
          })}
        </div>
        {subgoalsFor(draft.phase.kind).length > 1 ? (
          <Field label={`${phaseMeta(draft.phase.kind).label}子目标`}>
            <div className="tde-chip-row">
              {subgoalsFor(draft.phase.kind).map((subgoal) => (
                <Chip
                  key={subgoal.id}
                  active={draft.phase.subgoal === subgoal.id}
                  onClick={() => update((next) => { next.phase.subgoal = subgoal.id })}
                >
                  {subgoal.label}
                </Chip>
              ))}
            </div>
          </Field>
        ) : null}
        <div className="tde-field-grid">
          <Field label="阶段周数">
            <input
              className="tde-input"
              type="number"
              min={1}
              max={52}
              value={draft.phase.weeks}
              onChange={(event) => update((next) => { next.phase.weeks = Number(event.target.value) })}
            />
          </Field>
          <Field label="开始日期">
            <input
              className="tde-input"
              type="date"
              value={draft.phase.start}
              onChange={(event) => update((next) => { next.phase.start = event.target.value || todayKey() })}
            />
          </Field>
        </div>
        {(() => {
          const targets = normalizePhase(draft.phase).targets
          const kcalText = targets.kcalMin === null || targets.kcalMax === null ? '不设热量硬上限' : `${targets.kcalMin}–${targets.kcalMax} kcal`
          return (
            <p className="tde-tip-line">
              当前目标：{kcalText} · 蛋白 {targets.proteinG}g · 每周自由餐 {targets.freeMealsPerWeek} 次
            </p>
          )
        })()}
      </Section>

      <Section title="饭点" hint="饭点窗口内如果还没记录，横条会提醒">
        {PLANNED_MEALS.map((meal) => (
          <div key={meal} className="tde-mealtime-row">
            <span className="tde-mealtime-label">{MEAL_LABELS[meal]}</span>
            <input
              className="tde-input tde-input-time"
              type="time"
              value={draft.mealTimes[meal][0]}
              onChange={(event) => update((next) => { next.mealTimes[meal][0] = event.target.value })}
            />
            <span className="tde-mealtime-sep">–</span>
            <input
              className="tde-input tde-input-time"
              type="time"
              value={draft.mealTimes[meal][1]}
              onChange={(event) => update((next) => { next.mealTimes[meal][1] = event.target.value })}
            />
          </div>
        ))}
        <div className="tde-field-label">计划餐次</div>
        <div className="tde-chip-row">
          {PLANNED_MEALS.map((meal) => (
            <Chip
              key={meal}
              active={draft.plannedMeals.includes(meal)}
              onClick={() => update((next) => {
                if (next.plannedMeals.includes(meal)) {
                  if (next.plannedMeals.length > 1) next.plannedMeals = next.plannedMeals.filter((item) => item !== meal)
                } else {
                  next.plannedMeals = [...next.plannedMeals, meal]
                }
              })}
            >
              {MEAL_LABELS[meal]}
            </Chip>
          ))}
        </div>
      </Section>

      <Section title="提醒" hint="提醒只在饭点窗口内触发一次">
        <Switch
          label="应用内提醒"
          hint="饭点到了在横条上显示「🔔 午饭时间到」"
          checked={draft.notify.inApp !== false}
          onChange={(checked) => update((next) => { next.notify.inApp = checked })}
        />
        <Switch
          label="系统通知"
          hint="需要浏览器通知权限；只在你点下面按钮授权后才会弹"
          checked={draft.notify.system !== false}
          onChange={(checked) => update((next) => { next.notify.system = checked })}
        />
        <div className="tde-inline-row">
          <span className="tde-input-label">稍后提醒</span>
          <input
            className="tde-input tde-input-number"
            type="number"
            min={5}
            max={180}
            value={draft.notify.snoozeMin}
            onChange={(event) => update((next) => { next.notify.snoozeMin = Number(event.target.value) })}
          />
          <span className="tde-muted-label">分钟</span>
        </div>
        <div className="tde-inline-row">
          <Btn size="sm" onClick={() => store.requestNotifications()}>开启系统通知</Btn>
          <Tag tone={permission === 'granted' ? 'success' : permission === 'denied' ? 'warn' : 'muted'}>
            {PERMISSION_LABELS[permission] ?? permission}
          </Tag>
          <span className="tde-tip-line">未授权时只在页面内提醒，不弹系统通知。</span>
        </div>
      </Section>

      <Section title="高德 Key" hint="附近餐厅 / 天气需要高德 Web 服务 Key">
        <div className="tde-inline-row">
          <input
            className="tde-input"
            type="password"
            placeholder={hasAmapKey === true ? '已保存，输入新 Key 可替换' : '粘贴高德 Web 服务 Key'}
            value={amapInput}
            onChange={(event) => setAmapInput(event.target.value)}
          />
          <Btn size="sm" variant="primary" disabled={savingKey === true || amapInput.trim() === ''} onClick={handleSaveKey}>保存</Btn>
          <Btn size="sm" variant="ghost" disabled={savingKey === true || hasAmapKey !== true} onClick={handleClearKey}>清除</Btn>
        </div>
        <p className="tde-tip-line">
          当前：{hasAmapKey === true ? '已配置（Key 只存在 host 本地，不显示明文）' : '未配置'}
          {offline ? ' · 本地模式下无法修改' : ''}
        </p>
      </Section>

      <Section title="数据说明">
        <ul className="tde-notes">
          <li>长期状态存在 host 的 state.json（DSH_HOME/storages/dsh-today-eat/state.json），换浏览器也不会丢。</li>
          <li>host 不可用时会自动切「本地模式」，用浏览器缓存 + 旧版记录继续展示与记录；恢复后自动同步。</li>
          <li>旧版（v1）浏览器历史只迁移一次；迁移后旧键保留不删。</li>
          <li>状态版本 rev {state.rev ?? 0} · 最近同步 {snapshot.lastSyncedAt > 0 ? '刚刚' : '尚未'}。</li>
        </ul>
        <Btn size="sm" onClick={() => store.refresh()}>立即同步</Btn>
      </Section>

      <div className="tde-save-bar">
        <span className="tde-save-hint">{dirty ? '有未保存的修改' : '所有设置已同步'}</span>
        <Btn variant="primary" disabled={dirty === false || snapshot.saving === true} onClick={handleSave}>
          {snapshot.saving === true ? '保存中…' : '保存更改'}
        </Btn>
      </div>
    </div>
  )
}
