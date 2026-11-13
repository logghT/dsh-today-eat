/**
 * 「今天吃什么」client 半 —— 应用 store。
 *
 * 职责：
 * - 持有 state / profile / phase / mealTime / offline / 提醒 / 附近 / 采买 等快照；
 * - 60s 轮询 + visibilitychange / focus 刷新（页面隐藏时降频到 5 分钟）；
 * - 30s 饭点检查（隐藏时降频），进入窗口且该餐未记录且当天未提醒过 → 提醒态 +（可选）系统通知；
 * - 所有写操作带 rev；409 自动重拉最新 state 并重试一次；
 * - host 接口 404 / 网络错误 → 本地模式，回退 localStorage 缓存 / v1 旧键；
 * - v1 历史首次迁移到 v2 state.meals。
 *
 * 提醒定时器全部用递归 setTimeout（不用 setInterval），避免阻塞渲染。
 */

import { ApiError, createApi, isOfflineError, isRevConflict } from './api.js'
import {
  buildMealRecord,
  buildPlan,
  createDefaultState,
  dayTotals,
  dishById,
  loadOfflineState,
  normalizeState,
  selectRecommendation,
  summarize,
  weekStartKey,
} from './recommend.js'
import { mealTimeState, normalizeNotify, normalizeSettings } from './mealTime.js'
import { normalizeDisplayMode, normalizeFloatPos, normalizeRerollCuisines } from './display.js'
import { makeUserRecipeId, normalizeUserRecipe } from '../core/user-recipes.js'
import {
  appendHistory,
  markReminded,
  readHistory,
  readMigrated,
  readReminderMarks,
  readSnoozes,
  readStateCache,
  readUi,
  snoozeMeal,
  writeHistory,
  writeMigrated,
  writeReminderMarks,
  writeStateCache,
  writeUi,
} from './storage.js'
import { MEAL_LABELS, PANEL_TABS, dateKeyOf, makeId, todayKey } from './format.js'

/** 页面可见时的刷新间隔。 */
const REFRESH_VISIBLE_MS = 60_000

/** 页面隐藏时的刷新间隔（降频）。 */
const REFRESH_HIDDEN_MS = 300_000

/** 页面可见时的饭点检查间隔。 */
const TICK_VISIBLE_MS = 30_000

/** 页面隐藏时的饭点检查间隔（降频）。 */
const TICK_HIDDEN_MS = 300_000

/** toast 自动消失时间。 */
const TOAST_TTL_MS = 4_000

/** 浮窗位置拖动结束后写回 host 的 debounce（毫秒）。 */
const FLOAT_POS_WRITE_DELAY_MS = 400

/** 单例。 */
let singleton = null

/**
 * 取全局 store 单例。
 *
 * @param {{ api?: object }} [options={}] 选项（测试可注入 api）
 * @returns {Store} store
 */
export function getStore(options = {}) {
  if (singleton === null) singleton = new Store(options)
  return singleton
}

/**
 * 重置单例（仅测试 / HMR 用）。
 *
 * @returns {void}
 */
export function resetStore() {
  if (singleton !== null) singleton.stop()
  singleton = null
}

/**
 * 深合并补丁（只合并普通对象；数组整体替换）。
 *
 * @param {unknown} base 原值
 * @param {unknown} patch 补丁
 * @returns {unknown} 结果
 */
function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(base) || Array.isArray(patch)) return Array.isArray(patch) ? patch.slice() : base
  if (typeof base === 'object' && typeof patch === 'object') {
    const result = { ...base }
    for (const [key, value] of Object.entries(patch)) {
      result[key] = deepMerge(base[key], value)
    }
    return result
  }
  return patch
}

/**
 * 同一天同一餐替换记录（与 host 的 meals upsert 语义一致）。
 *
 * @param {Array<object>} meals 原记录
 * @param {object} meal 新记录
 * @returns {Array<object>} 新记录
 */
function upsertMeal(meals, meal) {
  const list = Array.isArray(meals) ? meals : []
  return [...list.filter((item) => !(item.date === meal.date && item.meal === meal.meal)), meal]
}

/**
 * 判断页面是否隐藏。
 *
 * @returns {boolean} 是否隐藏
 */
function isHidden() {
  try {
    if (typeof document === 'undefined') return false
    return document.visibilityState === 'hidden' || document.hidden === true
  } catch {
    return false
  }
}

/**
 * 空的附近状态。
 *
 * @returns {object} 附近状态
 */
function emptyNearby() {
  return { status: 'idle', items: [], suggestions: [], weather: null, fallbackQueries: [], error: null, loadedAt: 0 }
}

/**
 * 空的采买状态。
 *
 * @returns {object} 采买状态
 */
function emptyShopping() {
  return { status: 'idle', days: 3, window: null, groups: [], estimatedCost: 0, missingRecipes: [], error: null }
}

/**
 * 初始快照（先读缓存，交给 start() 的网络刷新覆盖）。
 *
 * @returns {object} 快照
 */
function initialSnapshot() {
  const cache = readStateCache()
  const legacyUi = readUi()
  const local = loadOfflineState()
  const state = cache === null ? local.state : normalizeState(cache.state)
  state.ui = { ...state.ui, panelTab: state.ui.panelTab || legacyUi.panelTab }
  return {
    status: cache === null ? 'loading' : 'ready',
    offline: false,
    errorMessage: null,
    state,
    hasAmapKey: cache === null ? local.hasAmapKey : cache.hasAmapKey,
    rev: typeof state.rev === 'number' ? state.rev : 0,
    lastSyncedAt: 0,
    mealTime: mealTimeState(new Date(), state.settings, state.meals),
    recommendation: null,
    stats: null,
    excludeIds: [],
    manualDishId: null,
    rerollSeq: 0,
    rerollCuisines: normalizeRerollCuisines(state.ui.rerollCuisines),
    reminder: { active: false, meal: null, dateKey: null, at: 0 },
    nearby: emptyNearby(),
    shopping: emptyShopping(),
    panelTab: state.ui.panelTab || legacyUi.panelTab || 'today',
    panelFocus: null,
    fallbackPanelOpen: false,
    toast: null,
    saving: false,
    notificationPermission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  }
}

/**
 * 应用 store。
 */
export class Store {
  /**
   * @param {{ api?: object }} [options={}] 选项
   */
  constructor(options = {}) {
    this.api = options.api ?? createApi()
    this.listeners = new Set()
    this.seq = 0
    this.started = false
    this.migrating = false
    this.timers = { refresh: null, tick: null, toast: null, floatPos: null }
    this.focusHandler = () => {
      this.refresh()
    }
    this.visibilityHandler = () => this.handleVisibility()
    this.subscribe = (listener) => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }
    this.getSnapshot = () => this.snapshot
    this.snapshot = this.computeDerived(initialSnapshot())
  }

  /* ── 订阅 ───────────────────────────────────────────── */

  /**
   * 通知订阅者。
   *
   * @returns {void}
   */
  emit() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
  }

  /**
   * 更新快照并重算派生值。
   *
   * @param {object} next 增量
   * @returns {void}
   */
  set(next) {
    this.snapshot = this.computeDerived({ ...this.snapshot, ...next })
    this.emit()
  }

  /**
   * 计算派生值（推荐 / 统计 / 饭点 / 面板 tab）。
   *
   * @param {object} snapshot 快照
   * @returns {object} 新快照
   */
  computeDerived(snapshot) {
    const state = snapshot.state
    const now = new Date()
    const mealTime = mealTimeState(now, state.settings, state.meals)
    let recommendation = snapshot.recommendation
    try {
      recommendation = selectRecommendation({
        state,
        now,
        excludeIds: snapshot.excludeIds,
        manualDishId: snapshot.manualDishId,
        cuisines: snapshot.rerollCuisines,
      })
    } catch {
      // 保留上一次推荐
    }
    let stats = snapshot.stats
    try {
      stats = summarize({ state, today: dateKeyOf(now) })
    } catch {
      stats = null
    }
    const panelTab = PANEL_TABS.some((tab) => tab.id === state.ui.panelTab) ? state.ui.panelTab : snapshot.panelTab
    return { ...snapshot, mealTime, recommendation, stats, panelTab }
  }

  /* ── 生命周期 ───────────────────────────────────────── */

  /**
   * 启动：拉取 state + 挂监听 + 定时器（幂等）。
   *
   * @returns {void}
   */
  start() {
    if (this.started) return
    this.started = true
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('focus', this.focusHandler)
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this.visibilityHandler)
      }
    } catch {
      // 非浏览器环境（烟测 / SSR）忽略
    }
    this.scheduleRefresh()
    this.scheduleTick()
    this.refresh()
  }

  /**
   * 停止定时器与监听（HMR / 测试复位用）。
   *
   * @returns {void}
   */
  stop() {
    this.started = false
    for (const key of Object.keys(this.timers)) {
      if (this.timers[key] !== null) {
        try {
          clearTimeout(this.timers[key])
        } catch {
          // 忽略
        }
        this.timers[key] = null
      }
    }
    try {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('focus', this.focusHandler)
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', this.visibilityHandler)
      }
    } catch {
      // 忽略
    }
  }

  /**
   * 安排下一次 60s 刷新（页面隐藏时降频）。
   *
   * @returns {void}
   */
  scheduleRefresh() {
    if (!this.started) return
    if (this.timers.refresh !== null) clearTimeout(this.timers.refresh)
    const delay = isHidden() ? REFRESH_HIDDEN_MS : REFRESH_VISIBLE_MS
    this.timers.refresh = setTimeout(() => {
      this.timers.refresh = null
      this.refresh()
      this.scheduleRefresh()
    }, delay)
  }

  /**
   * 安排下一次 30s 饭点检查（页面隐藏时降频）。
   *
   * @returns {void}
   */
  scheduleTick() {
    if (!this.started) return
    if (this.timers.tick !== null) clearTimeout(this.timers.tick)
    const delay = isHidden() ? TICK_HIDDEN_MS : TICK_VISIBLE_MS
    this.timers.tick = setTimeout(() => {
      this.timers.tick = null
      try {
        this.tickReminder()
      } catch {
        // 提醒失败不影响其他逻辑
      }
      this.scheduleTick()
    }, delay)
  }

  /**
   * 页面可见性变化：回前台立即刷新并恢复高频。
   *
   * @returns {void}
   */
  handleVisibility() {
    if (isHidden()) {
      this.scheduleRefresh()
      this.scheduleTick()
      return
    }
    this.refresh()
    this.scheduleRefresh()
    this.scheduleTick()
  }

  /* ── 拉取 / 离线 ────────────────────────────────────── */

  /**
   * 拉取最新 state（并发保护：只接受最新一次请求的结果）。
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    const seq = ++this.seq
    try {
      const data = await this.api.getState()
      if (seq !== this.seq) return
      if (data === null || typeof data !== 'object' || data.state === null || data.state === undefined) {
        throw new ApiError({ code: 'bad-payload', message: 'state 响应缺少 state 字段', offline: true })
      }
      const state = normalizeState(data.state)
      const hasAmapKey = data.hasAmapKey === true
      this.set({
        status: 'ready',
        offline: false,
        errorMessage: null,
        state,
        hasAmapKey,
        rev: typeof state.rev === 'number' ? state.rev : this.snapshot.rev,
        lastSyncedAt: Date.now(),
        rerollCuisines: normalizeRerollCuisines(state.ui.rerollCuisines),
        panelTab: PANEL_TABS.some((tab) => tab.id === state.ui.panelTab) ? state.ui.panelTab : this.snapshot.panelTab,
      })
      writeStateCache({ state, hasAmapKey })
      this.tickReminder()
      this.migrateLegacyHistory()
    } catch (error) {
      if (seq !== this.seq) return
      if (isOfflineError(error)) {
        this.goOffline()
        return
      }
      this.set({
        status: this.snapshot.status === 'ready' ? 'ready' : 'error',
        errorMessage: error && error.message ? error.message : '同步失败',
      })
    }
  }

  /**
   * 切本地模式：用 localStorage 缓存 / v1 旧键展示，并保留「本地模式」标记。
   *
   * @returns {void}
   */
  goOffline() {
    const local = loadOfflineState()
    const state = normalizeState(local.state)
    if (!PANEL_TABS.some((tab) => tab.id === state.ui.panelTab)) state.ui.panelTab = this.snapshot.panelTab
    this.set({
      status: 'ready',
      offline: true,
      errorMessage: '本地服务未连接，正在使用浏览器缓存',
      state,
      hasAmapKey: local.hasAmapKey,
      rev: typeof state.rev === 'number' ? state.rev : 0,
      rerollCuisines: normalizeRerollCuisines(state.ui.rerollCuisines),
    })
  }

  /**
   * 请求带 rev 的写接口；409 时重拉最新 state 再重试一次。
   *
   * @param {(rev: number) => Promise<object>} run 请求函数
   * @returns {Promise<object>} 响应
   */
  async mutateWithRev(run) {
    const rev = typeof this.snapshot.state.rev === 'number' ? this.snapshot.state.rev : this.snapshot.rev
    try {
      return await run(rev)
    } catch (error) {
      if (!isRevConflict(error) || error.payload === null || error.payload === undefined) throw error
      const fresh = error.payload.state !== null && typeof error.payload.state === 'object' ? normalizeState(error.payload.state) : null
      if (fresh === null) throw error
      this.set({ state: fresh, rev: typeof fresh.rev === 'number' ? fresh.rev : rev, rerollCuisines: normalizeRerollCuisines(fresh.ui.rerollCuisines) })
      writeStateCache({ state: fresh, hasAmapKey: this.snapshot.hasAmapKey })
      return run(typeof fresh.rev === 'number' ? fresh.rev : rev)
    }
  }

  /**
   * 应用服务端返回的 state。
   *
   * @param {object} result 响应
   * @returns {void}
   */
  applyServerState(result) {
    if (result === null || typeof result !== 'object') return
    if (result.state !== null && typeof result.state === 'object') {
      const state = normalizeState(result.state)
      this.set({
        state,
        rev: typeof state.rev === 'number' ? state.rev : this.snapshot.rev,
        lastSyncedAt: Date.now(),
        rerollCuisines: normalizeRerollCuisines(state.ui.rerollCuisines),
      })
    }
    if (typeof result.hasAmapKey === 'boolean') this.set({ hasAmapKey: result.hasAmapKey })
    writeStateCache({ state: this.snapshot.state, hasAmapKey: this.snapshot.hasAmapKey })
  }

  /* ── 迁移 ───────────────────────────────────────────── */

  /**
   * 首次 GET 后：v1 localStorage 历史为空且 v2 meals 为空 → POST 迁移。
   *
   * @returns {Promise<void>}
   */
  async migrateLegacyHistory() {
    if (this.migrating || this.snapshot.offline) return
    if (readMigrated()) return
    const legacy = readHistory()
    if (legacy.length === 0) return
    if (Array.isArray(this.snapshot.state.meals) && this.snapshot.state.meals.length > 0) {
      writeMigrated()
      return
    }
    this.migrating = true
    try {
      const entries = legacy.slice(-60)
      for (const entry of entries) {
        const dish = dishById(entry.dishId) ?? { id: entry.dishId, name: entry.dishId, tags: [], category: '', price: 0 }
        const record = buildMealRecord({
          dish,
          dateKey: entry.date,
          meal: entry.meal,
          mode: dish.cookable === true ? 'home' : 'out',
        })
        record.note = 'v1 旧记录迁移'
        const result = await this.mutateWithRev((rev) => this.api.postMeal(rev, record))
        this.applyServerState(result)
      }
      writeMigrated()
      this.toast(`已迁移 ${entries.length} 条旧记录到 v2 存储`)
    } catch {
      // 迁移失败不标记，下次刷新重试；不影响正常使用
    } finally {
      this.migrating = false
    }
  }

  /* ── 写操作 ─────────────────────────────────────────── */

  /**
   * 保存设置补丁（profile / phase / settings / ui 深合并）。
   *
   * @param {object} patch 补丁
   * @param {{ silent?: boolean, successText?: string }} [options={}] 选项
   * @returns {Promise<boolean>} 是否成功
   */
  async patchState(patch, options = {}) {
    const previousState = this.snapshot.state
    const optimistic = normalizeState(deepMerge(this.snapshot.state, patch))
    this.set({ state: optimistic, saving: true })
    if (this.snapshot.offline) {
      this.persistLocalUi(patch)
      writeStateCache({ state: this.snapshot.state, hasAmapKey: this.snapshot.hasAmapKey })
      this.set({ saving: false })
      if (!options.silent) this.toast('本地模式：已暂存在浏览器')
      return true
    }
    try {
      const result = await this.mutateWithRev((rev) => this.api.postState(rev, patch))
      this.applyServerState(result)
      this.set({ saving: false })
      if (!options.silent) this.toast(options.successText || '已保存')
      return true
    } catch (error) {
      this.set({ saving: false })
      if (isOfflineError(error)) {
        this.goOffline()
        this.set({ state: normalizeState(deepMerge(this.snapshot.state, patch)) })
        if (!options.silent) this.toast('本地模式：已暂存在浏览器')
        return true
      }
      // 回滚到写之前的服务端状态，避免乐观更新残留
      this.set({ state: previousState })
      if (!options.silent) this.toast(error && error.message ? `保存失败：${error.message}` : '保存失败')
      return false
    }
  }

  /**
   * 记录一餐（我吃了 / 面板记录）。
   *
   * @param {{ dish?: object | null, meal?: string, mode?: string, rating?: number, note?: string, dateKey?: string }} [input={}] 参数
   * @returns {Promise<boolean>} 是否成功
   */
  async logMeal(input = {}) {
    const snapshot = this.snapshot
    const dish = input.dish ?? (snapshot.recommendation === null ? null : snapshot.recommendation.dish)
    if (dish === null || dish === undefined) {
      this.toast('还没有可记录的推荐')
      return false
    }
    const mealKey = input.meal ?? (snapshot.mealTime.meal === 'night' ? 'dinner' : snapshot.mealTime.meal)
    const dateKey = input.dateKey ?? dateKeyOf(new Date())
    const record = buildMealRecord({
      dish,
      dateKey,
      meal: mealKey,
      mode: input.mode,
      rating: input.rating,
      note: input.note,
    })
    const localRecord = { ...record, id: record.id === '' ? makeId('m') : record.id }
    this.set({
      saving: true,
      state: { ...snapshot.state, meals: upsertMeal(snapshot.state.meals, localRecord) },
      excludeIds: [...new Set([...snapshot.excludeIds, dish.id])],
      manualDishId: null,
      rerollSeq: snapshot.rerollSeq + 1,
      reminder: { active: false, meal: null, dateKey: null, at: 0 },
    })
    if (this.snapshot.offline) {
      this.persistOfflineMeal(record)
      this.set({ saving: false })
      this.toast(`已记录「${record.dishName}」到本地（本地模式）`)
      return true
    }
    try {
      const result = await this.mutateWithRev((rev) => this.api.postMeal(rev, record))
      this.applyServerState(result)
      this.set({ saving: false })
      this.toast(`已记录${MEAL_LABELS[mealKey] ?? '这一餐'}「${record.dishName}」`)
      return true
    } catch (error) {
      this.set({ saving: false, state: snapshot.state })
      if (isOfflineError(error)) {
        this.goOffline()
        this.persistOfflineMeal(record)
        const offlineState = normalizeState({
          ...this.snapshot.state,
          meals: upsertMeal(this.snapshot.state.meals, localRecord),
        })
        this.set({ state: offlineState })
        this.toast(`已记录「${record.dishName}」到本地（本地模式）`)
        return true
      }
      this.toast(error && error.message ? `记录失败：${error.message}` : '记录失败')
      return false
    }
  }

  /**
   * 更新一条记录（评分 / 备注）。
   *
   * @param {object} meal 原记录
   * @param {object} patch 补丁
   * @returns {Promise<boolean>} 是否成功
   */
  async updateMeal(meal, patch) {
    if (meal === null || typeof meal !== 'object') return false
    const nextMeal = { ...meal, ...patch }
    const snapshot = this.snapshot
    this.set({
      state: { ...snapshot.state, meals: upsertMeal(snapshot.state.meals, nextMeal) },
      saving: true,
    })
    if (this.snapshot.offline) {
      this.set({ saving: false })
      this.toast('本地模式下评分暂存浏览器')
      return true
    }
    try {
      const result = await this.mutateWithRev((rev) => this.api.postMeal(rev, nextMeal))
      this.applyServerState(result)
      this.set({ saving: false })
      this.toast('已更新这餐的评分')
      return true
    } catch (error) {
      this.set({ saving: false })
      if (isOfflineError(error)) {
        this.goOffline()
        this.toast('本地模式：评分暂存浏览器')
        return true
      }
      this.toast('更新失败')
      return false
    }
  }

  /**
   * 删除一条记录。
   *
   * @param {string} id 记录 id
   * @returns {Promise<boolean>} 是否成功
   */
  async deleteMeal(id) {
    if (typeof id !== 'string' || id === '') return false
    const snapshot = this.snapshot
    this.set({
      state: { ...snapshot.state, meals: snapshot.state.meals.filter((meal) => meal.id !== id) },
      saving: true,
    })
    if (this.snapshot.offline) {
      this.removeLegacyMeal(id)
      this.set({ saving: false })
      this.toast('已删除（本地模式）')
      return true
    }
    try {
      const result = await this.mutateWithRev((rev) => this.api.deleteMeal(id))
      this.applyServerState(result)
      this.set({ saving: false })
      this.toast('已删除这条记录')
      return true
    } catch (error) {
      this.set({ saving: false, state: snapshot.state })
      this.toast(isOfflineError(error) ? '本地模式：删除失败' : '删除失败')
      return false
    }
  }

  /**
   * 保存周计划。
   *
   * @param {object} plan 计划
   * @returns {Promise<boolean>} 是否成功
   */
  async savePlan(plan) {
    if (plan === null || typeof plan !== 'object') return false
    const snapshot = this.snapshot
    this.set({ state: { ...snapshot.state, plan }, saving: true })
    if (this.snapshot.offline) {
      writeStateCache({ state: this.snapshot.state, hasAmapKey: this.snapshot.hasAmapKey })
      this.set({ saving: false })
      this.toast('计划已生成（本地模式，暂存在浏览器）')
      return true
    }
    try {
      const result = await this.mutateWithRev((rev) => this.api.postPlan(rev, plan))
      this.applyServerState(result)
      this.set({ saving: false })
      return true
    } catch (error) {
      this.set({ saving: false, state: snapshot.state })
      if (isOfflineError(error)) {
        this.goOffline()
        this.set({ state: { ...this.snapshot.state, plan } })
        this.toast('计划已生成（本地模式）')
        return true
      }
      this.toast('计划保存失败')
      return false
    }
  }

  /**
   * 重新生成一周计划（保留锁定日）。
   *
   * @param {{ regenerate?: boolean }} [options={}] 选项
   * @returns {Promise<boolean>} 是否成功
   */
  async regeneratePlan(options = {}) {
    const snapshot = this.snapshot
    this.set({ saving: true })
    try {
      const plan = buildPlan({
        state: snapshot.state,
        startDate: weekStartKey(todayKey()),
        previous: snapshot.state.plan,
        locked: options.regenerate === false ? snapshot.state.plan.locked : snapshot.state.plan.locked,
        seed: snapshot.state.plan.seed,
      })
      if (!plan || !Array.isArray(plan.picks) || plan.picks.length === 0) {
        this.set({ saving: false })
        this.toast('生成失败：菜品库为空')
        return false
      }
      const ok = await this.savePlan(plan)
      if (ok) this.toast('本周计划已重新排好')
      return ok
    } catch (error) {
      this.set({ saving: false })
      this.toast(error && error.message ? `生成失败：${error.message}` : '生成计划失败')
      return false
    }
  }

  /**
   * 保存 / 清除高德 Key。
   *
   * @param {string} key Key（空串清除）
   * @returns {Promise<boolean>} 是否成功
   */
  async saveAmapKey(key) {
    const value = typeof key === 'string' ? key.trim() : ''
    if (this.snapshot.offline) {
      this.toast('本地模式下无法保存高德 Key')
      return false
    }
    try {
      const result = await this.api.postAmapKey(value)
      this.set({ hasAmapKey: result !== null && result.hasAmapKey === true })
      this.toast(value === '' ? '已清除高德 Key' : '高德 Key 已保存')
      return true
    } catch (error) {
      if (isOfflineError(error)) this.goOffline()
      this.toast(error && error.message ? error.message : '高德 Key 保存失败')
      return false
    }
  }

  /* ── 推荐交互 ───────────────────────────────────────── */

  /**
   * 换一个：把当前菜加入本次排除列表并重算。
   *
   * @returns {void}
   */
  reroll() {
    const snapshot = this.snapshot
    const current = snapshot.recommendation === null ? null : snapshot.recommendation.dish
    if (current === null || current === undefined) return
    const excludeIds = [...new Set([...snapshot.excludeIds, current.id])].slice(-30)
    this.set({ excludeIds, manualDishId: null, rerollSeq: snapshot.rerollSeq + 1 })
    const next = this.snapshot.recommendation
    if (next === null || next === undefined || next.dish === null || next.dish === undefined) {
      this.toast('这个风格下暂时没有合适的菜，换几个菜系试试', 'error')
    }
  }

  /**
   * 选中一道备选。
   *
   * @param {string} dishId 菜品 id
   * @returns {void}
   */
  setManualDish(dishId) {
    if (dishById(dishId) === null) return
    this.set({ manualDishId: dishId })
  }

  /* ── 面板导航 ───────────────────────────────────────── */

  /**
   * 切换面板 tab（持久化到 state.ui.panelTab）。
   *
   * @param {string} tab tab id
   * @param {string | null} [focus=null] 分区
   * @returns {void}
   */
  setPanelTab(tab, focus = null) {
    const nextTab = PANEL_TABS.some((item) => item.id === tab) ? tab : 'today'
    this.set({ panelTab: nextTab, panelFocus: focus })
    writeUi({ ...readUi(), collapsed: this.snapshot.state.ui.collapsed === true, panelTab: nextTab })
    this.patchState({ ui: { panelTab: nextTab } }, { silent: true })
  }

  /**
   * 清空分区 focus（避免重复滚动）。
   *
   * @returns {void}
   */
  clearPanelFocus() {
    if (this.snapshot.panelFocus !== null) this.set({ panelFocus: null })
  }

  /**
   * 收起 / 展开横条。
   *
   * @returns {void}
   */
  toggleCollapsed() {
    const collapsed = this.snapshot.state.ui.collapsed !== true
    writeUi({ ...readUi(), collapsed, panelTab: this.snapshot.panelTab })
    this.set({ state: normalizeState({ ...this.snapshot.state, ui: { ...this.snapshot.state.ui, collapsed } }) })
    this.patchState({ ui: { collapsed } }, { silent: true })
  }

  /* ── 多形态显示：浮窗 / 横条 / 仅面板 ─────────────── */

  /**
   * 写本机 UI 兜底（离线 / host 未就绪时也保留用户选择）。
   *
   * @param {object} uiPatch ui 补丁
   * @returns {void}
   */
  writeLocalUi(uiPatch) {
    try {
      writeUi({ ...readUi(), ...uiPatch })
    } catch {
      // localStorage 不可用：忽略，内存态仍然生效
    }
  }

  /**
   * 先把 ui 补丁落到本机快照，再静默 patch host。
   *
   * patchState 失败时会回滚到「调用它之前」的快照（此时本机改动已生效），
   * 因此写回失败只会保留本地状态，不抛错、不打断交互。
   *
   * @param {object} uiPatch ui 补丁
   * @returns {Promise<boolean>} 是否同步成功
   */
  async persistUiPatch(uiPatch) {
    try {
      return await this.patchState({ ui: uiPatch }, { silent: true })
    } catch {
      return false
    }
  }

  /**
   * 切换显示方式：float（浮窗）/ dock（横条）/ panel（仅面板）。
   *
   * @param {string} mode 显示方式
   * @returns {Promise<boolean>} 是否同步成功
   */
  async setDisplayMode(mode) {
    const displayMode = normalizeDisplayMode(mode)
    if (this.snapshot.state.ui.displayMode === displayMode) return true
    this.writeLocalUi({ displayMode })
    this.set({ state: { ...this.snapshot.state, ui: { ...this.snapshot.state.ui, displayMode } } })
    const ok = await this.persistUiPatch({ displayMode })
    if (!ok && !this.snapshot.offline) this.toast('显示方式已在本机生效，暂未同步到 host', 'error')
    return ok
  }

  /**
   * 设置浮窗收起态（true = 收起成小球）。
   *
   * @param {boolean} collapsed 是否收起
   * @returns {Promise<boolean>} 是否同步成功
   */
  async setFloatCollapsed(collapsed) {
    const floatCollapsed = collapsed === true
    if (this.snapshot.state.ui.floatCollapsed === floatCollapsed) return true
    this.writeLocalUi({ floatCollapsed })
    this.set({ state: { ...this.snapshot.state, ui: { ...this.snapshot.state.ui, floatCollapsed } } })
    return this.persistUiPatch({ floatCollapsed })
  }

  /**
   * 设置「换一个风格」选中的菜系（空数组 = 全部菜系）。
   *
   * 变更后清掉本次换菜排除列表与手动选择，让新风格有足够候选。
   *
   * @param {unknown} cuisines 菜系列表
   * @returns {Promise<boolean>} 是否同步成功
   */
  async setRerollCuisines(cuisines) {
    const rerollCuisines = normalizeRerollCuisines(cuisines)
    const current = this.snapshot.rerollCuisines
    if (current.length === rerollCuisines.length && current.every((item, index) => item === rerollCuisines[index])) return true
    this.writeLocalUi({ rerollCuisines })
    this.set({
      rerollCuisines,
      excludeIds: [],
      manualDishId: null,
      state: { ...this.snapshot.state, ui: { ...this.snapshot.state.ui, rerollCuisines } },
    })
    return this.persistUiPatch({ rerollCuisines })
  }

  /**
   * 添加一条「我的菜谱」。
   *
   * @param {object} input 表单输入（name/cuisine/category/...）
   * @returns {Promise<boolean>} 是否成功
   */
  async addUserRecipe(input) {
    const now = Date.now()
    const id = makeUserRecipeId(now)
    const recipe = normalizeUserRecipe({ ...input, id }, { now })
    if (recipe === null) {
      this.toast('菜谱还缺菜名或菜系，先补齐再保存')
      return false
    }
    const ok = await this.patchState({ userRecipes: { [recipe.id]: recipe } }, { successText: '已加入我的菜谱' })
    return ok
  }

  /**
   * 删除一条「我的菜谱」。
   *
   * 用 `{ [id]: null }` 提交，host normalize 时会把 null 项过滤掉（数组根不能直接 patch）。
   *
   * @param {string} id 菜谱 id
   * @returns {Promise<boolean>} 是否成功
   */
  async removeUserRecipe(id) {
    if (typeof id !== 'string' || id === '') return false
    const exists = this.snapshot.state.userRecipes !== null && typeof this.snapshot.state.userRecipes === 'object' && this.snapshot.state.userRecipes[id] !== undefined
    if (!exists) return true
    return this.patchState({ userRecipes: { [id]: null } }, { successText: '已从我的菜谱删除' })
  }

  /**
   * 切换浮窗收起态。
   *
   * @returns {Promise<boolean>} 是否同步成功
   */
  toggleFloatCollapsed() {
    return this.setFloatCollapsed(this.snapshot.state.ui.floatCollapsed !== true)
  }

  /**
   * 设置浮窗位置（视口像素）。默认 debounce 写回 host，拖动过程中只更新本机。
   *
   * @param {{ x: number, y: number } | null} pos 位置（null = 恢复默认右下角）
   * @param {{ immediate?: boolean, delay?: number }} [options={}] 选项
   * @returns {Promise<boolean>} 立即写回时的同步结果；debounce 时返回 true
   */
  setFloatPos(pos, options = {}) {
    const floatPos = normalizeFloatPos(pos)
    this.writeLocalUi({ floatPos })
    this.set({ state: { ...this.snapshot.state, ui: { ...this.snapshot.state.ui, floatPos } } })
    const run = () => this.persistUiPatch({ floatPos })
    if (options.immediate === true) return run()
    const delay = typeof options.delay === 'number' && options.delay >= 0 ? options.delay : FLOAT_POS_WRITE_DELAY_MS
    if (this.timers.floatPos !== null) {
      try {
        clearTimeout(this.timers.floatPos)
      } catch {
        // 忽略
      }
      this.timers.floatPos = null
    }
    this.timers.floatPos = setTimeout(() => {
      this.timers.floatPos = null
      void run().catch(() => false)
    }, delay)
    return Promise.resolve(true)
  }

  /**
   * 重置浮窗位置到默认右下角（写回 host）。
   *
   * @returns {Promise<boolean>} 是否同步成功
   */
  resetFloatPos() {
    return this.setFloatPos(null, { immediate: true })
  }

  /* ── 附近 / 采买 ────────────────────────────────────── */

  /**
   * 加载附近餐厅。
   *
   * @param {{ radius?: number }} [options={}] 选项
   * @returns {Promise<void>}
   */
  async loadNearby(options = {}) {
    const snapshot = this.snapshot
    if (snapshot.offline) {
      this.set({ nearby: { ...emptyNearby(), status: 'error', error: '本地模式：附近餐厅需要连接本地服务并配置高德 Key' } })
      return
    }
    const meal = snapshot.mealTime.meal === 'night' ? 'dinner' : snapshot.mealTime.meal
    this.set({ nearby: { ...snapshot.nearby, status: 'loading', error: null } })
    try {
      const result = await this.api.getNearby({ meal, radius: typeof options.radius === 'number' ? options.radius : 1500 })
      if (result !== null && typeof result === 'object' && result.ok === true) {
        this.set({
          nearby: {
            status: 'ready',
            items: Array.isArray(result.items) ? result.items : [],
            suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
            weather: result.weather ?? null,
            fallbackQueries: [],
            error: null,
            loadedAt: Date.now(),
          },
        })
        return
      }
      if (result !== null && typeof result === 'object' && result.code === 'amap-key-missing') {
        this.set({
          nearby: {
            status: 'no-key',
            items: [],
            suggestions: [],
            weather: null,
            fallbackQueries: Array.isArray(result.fallbackQueries) ? result.fallbackQueries : [],
            error: null,
            loadedAt: Date.now(),
          },
        })
        return
      }
      this.set({ nearby: { ...emptyNearby(), status: 'error', error: (result && result.message) || '附近餐厅加载失败' } })
    } catch (error) {
      if (isOfflineError(error)) {
        this.goOffline()
        this.set({ nearby: { ...emptyNearby(), status: 'error', error: '本地模式：附近餐厅不可用' } })
        return
      }
      this.set({ nearby: { ...emptyNearby(), status: 'error', error: error && error.message ? error.message : '附近餐厅加载失败' } })
    }
  }

  /**
   * 加载采买清单。
   *
   * @param {number} [days=3] 天数
   * @returns {Promise<void>}
   */
  async loadShopping(days = 3) {
    const snapshot = this.snapshot
    if (snapshot.offline) {
      this.set({ shopping: { ...emptyShopping(), days, status: 'error', error: '本地模式：采买清单需要连接本地服务，可先按菜谱用量采买' } })
      return
    }
    this.set({ shopping: { ...snapshot.shopping, days, status: 'loading', error: null } })
    try {
      const result = await this.api.getShopping(days)
      if (result !== null && typeof result === 'object' && result.ok === true) {
        this.set({
          shopping: {
            status: 'ready',
            days,
            window: result.window ?? null,
            groups: Array.isArray(result.groups) ? result.groups : [],
            estimatedCost: typeof result.estimatedCost === 'number' ? result.estimatedCost : 0,
            missingRecipes: Array.isArray(result.missingRecipes) ? result.missingRecipes : [],
            error: null,
          },
        })
        return
      }
      this.set({ shopping: { ...emptyShopping(), days, status: 'error', error: (result && result.message) || '采买清单加载失败' } })
    } catch (error) {
      if (isOfflineError(error)) {
        this.goOffline()
        this.set({ shopping: { ...emptyShopping(), days, status: 'error', error: '本地模式：采买清单不可用' } })
        return
      }
      this.set({ shopping: { ...emptyShopping(), days, status: 'error', error: error && error.message ? error.message : '采买清单加载失败' } })
    }
  }

  /* ── 提醒 ───────────────────────────────────────────── */

  /**
   * 饭点检查：窗口内 + 未记录 + 当天未提醒 → 提醒态（可选系统通知）。
   *
   * @returns {void}
   */
  tickReminder() {
    const snapshot = this.snapshot
    const settings = normalizeSettings(snapshot.state.settings)
    // 饭点状态机复用 src/core/mealTime.js（与 host 工具同口径），client 只做去重 / 通知
    const nowDate = new Date()
    const mealState = mealTimeState(nowDate, settings, snapshot.state.meals)
    const now = Date.now()
    const marks = readReminderMarks()
    const snoozes = readSnoozes()
    const dateKey = dateKeyOf(nowDate)
    const meal = mealState.meal ?? 'lunch'
    const marked = marks[dateKey] !== undefined && marks[dateKey][meal] !== undefined
    const snoozedUntil = snoozes[dateKey] !== undefined ? snoozes[dateKey][meal] : undefined
    const snoozed = typeof snoozedUntil === 'number' && now < snoozedUntil
    const permission = this.snapshot.notificationPermission
    const canSystem = settings.notify.system && permission === 'granted'
    const inWindow = mealState.phase === 'in' && mealState.shouldNotify
    const shouldFire = inWindow && !marked && !snoozed && (settings.notify.inApp || canSystem)

    if (shouldFire) {
      markReminded(dateKey, meal)
      if (canSystem) this.sendSystemNotification(mealState, dateKey)
      if (settings.notify.inApp) {
        this.set({ reminder: { active: true, meal, dateKey, at: now }, mealTime: mealState })
        return
      }
    }
    const active = this.snapshot.reminder.active
    if (active && (!inWindow || !settings.notify.inApp || !mealState.shouldNotify)) {
      this.set({ reminder: { active: false, meal: null, dateKey: null, at: 0 }, mealTime: mealState })
      return
    }
    this.set({ mealTime: mealState })
  }

  /**
   * 发送系统通知（不主动申请权限）。
   *
   * @param {ReturnType<typeof mealTimeState>} mealState 饭点状态
   * @param {string} dateKey 日期键
   * @returns {void}
   */
  sendSystemNotification(mealState, dateKey) {
    try {
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') return
      const recommendation = this.snapshot.recommendation
      const dishName = recommendation !== null && recommendation.dish !== null ? recommendation.dish.name : ''
      const label = MEAL_LABELS[mealState.meal] ?? '饭点'
      const body = dishName === '' ? `到${label}时间啦，去看看今天吃什么` : `今天${label}推荐「${dishName}」，记得记录哦`
      // eslint-disable-next-line no-new
      new Notification('到饭点啦', { body, tag: `dsh-today-eat-${dateKey}-${mealState.meal}` })
    } catch {
      // 系统通知失败静默
    }
  }

  /**
   * 用户点「开启系统通知」：显式 requestPermission。
   *
   * @returns {Promise<boolean>} 是否授权
   */
  async requestNotifications() {
    if (typeof Notification === 'undefined') {
      this.set({ notificationPermission: 'unsupported' })
      this.toast('当前环境不支持系统通知，横条提醒照常工作')
      return false
    }
    try {
      const permission = await Notification.requestPermission()
      this.set({ notificationPermission: permission })
      if (permission === 'granted') {
        await this.patchState({ settings: { notify: { system: true } } }, { silent: true })
        this.toast('系统通知已开启')
        return true
      }
      this.toast('没有获得通知权限，横条提醒照常工作')
      return false
    } catch {
      this.toast('申请通知权限失败')
      return false
    }
  }

  /**
   * 知道了：关闭本次提醒横幅（当天不再提醒该餐）。
   *
   * @returns {void}
   */
  dismissReminder() {
    const reminder = this.snapshot.reminder
    if (reminder.dateKey !== null && reminder.meal !== null) markReminded(reminder.dateKey, reminder.meal)
    this.set({ reminder: { active: false, meal: null, dateKey: null, at: 0 } })
  }

  /**
   * 稍后提醒：按 notify.snoozeMin 延后（到点后可再次提醒）。
   *
   * @returns {void}
   */
  snoozeReminder() {
    const reminder = this.snapshot.reminder
    const settings = normalizeNotify(this.snapshot.state.settings.notify)
    if (reminder.dateKey !== null && reminder.meal !== null) {
      snoozeMeal(reminder.dateKey, reminder.meal, Date.now() + settings.snoozeMin * 60 * 1000)
      // 清掉「已提醒」标记，让稍后到点还能再提醒
      const marks = readReminderMarks()
      if (marks[reminder.dateKey] !== undefined) {
        delete marks[reminder.dateKey][reminder.meal]
        writeReminderMarks(marks)
      }
    }
    this.set({ reminder: { active: false, meal: null, dateKey: null, at: 0 } })
    this.toast(`好，${settings.snoozeMin} 分钟后再喊你`)
  }

  /* ── toast / 导出 / 本地持久化 ─────────────────────── */

  /**
   * 显示 toast。
   *
   * @param {string} text 文案
   * @param {'info' | 'error'} [kind='info'] 类型
   * @returns {void}
   */
  toast(text, kind = 'info') {
    if (typeof text !== 'string' || text === '') return
    this.set({ toast: { text, kind, at: Date.now() } })
    if (this.timers.toast !== null) clearTimeout(this.timers.toast)
    this.timers.toast = setTimeout(() => {
      this.timers.toast = null
      if (this.snapshot.toast !== null) this.set({ toast: null })
    }, TOAST_TTL_MS)
  }

  /**
   * 导出 state JSON 文本。
   *
   * @returns {string} JSON
   */
  exportJson() {
    return JSON.stringify(
      { exportedAt: new Date().toISOString(), app: 'dsh-today-eat', version: 3, state: this.snapshot.state },
      null,
      2,
    )
  }

  /**
   * 今天的营养合计（供面板使用）。
   *
   * @param {string} [dateKey] 日期键
   * @returns {ReturnType<typeof dayTotals>} 合计
   */
  dayTotals(dateKey = todayKey()) {
    return dayTotals(this.snapshot.state.meals, dateKey)
  }

  /**
   * 离线时把一条记录写入 localStorage（旧键 + 缓存）。
   *
   * @param {object} record 记录
   * @returns {void}
   */
  persistOfflineMeal(record) {
    appendHistory({ dishId: record.dishId, date: record.date, meal: record.meal })
    writeStateCache({ state: this.snapshot.state, hasAmapKey: this.snapshot.hasAmapKey })
  }

  /**
   * 离线时同步 UI 补丁到旧键。
   *
   * @param {object} patch 补丁
   * @returns {void}
   */
  persistLocalUi(patch) {
    if (patch === null || typeof patch !== 'object' || patch.ui === undefined) return
    const ui = { ...readUi(), ...patch.ui }
    writeUi(ui)
  }

  /**
   * 离线删除时同步旧历史。
   *
   * @param {string} id 记录 id
   * @returns {void}
   */
  removeLegacyMeal(id) {
    const target = this.snapshot.state.meals.find((meal) => meal.id === id)
    const history = readHistory()
    if (target === undefined) return
    writeHistory(history.filter((entry) => !(entry.dishId === target.dishId && entry.date === target.date && entry.meal === target.meal)))
  }
}
