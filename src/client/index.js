/**
 * 「今天吃什么」client 半 —— 插件入口（Cordis client 插件）。
 *
 * 构建产物 lib/client.js 是经典脚本（window.__ModuleLoader__.load），factory 返回
 * 本文件的默认导出：{ name, inject, apply }。
 *
 * 挂载点（按 `state.ui.displayMode` 三档切换）：
 * - shell.overlay：右下角浮窗（list / root，默认形态，可拖动 / 收起成小球）；
 * - conversation.input.dock：输入框上方横条（displayMode='dock' 时显示）；
 * - sidebar.right.pane.tab / .title + sidebarRightTabs：右栏四页面板（三种模式都保留入口）。
 */

import { ApiError, createApi, isOfflineError, isRevConflict } from './api.js'
import TodayEatDock from './dock.jsx'
import { DISPLAY_MODE_META, DISPLAY_MODES, REROLL_CUISINES, clampFloatPos, displayModeOf, filterCatalogByCuisines, floatPositionStyle, isDragThresholdExceeded, moveFloatPos, normalizeFloatPos, normalizeRerollCuisines, normalizeUiState } from './display.js'
import TodayEatFallbackPanel from './fallback-panel.jsx'
import TodayEatFloat from './float.jsx'
import { PANEL_TABS } from './format.js'
import { ensureStyles } from './styles.js'
import TodayEatPanel, { TodayEatPanelTitle } from './panel.jsx'
import { CATALOG, buildPlan, createDefaultState, loadOfflineState, normalizeProfile, normalizeState, selectRecommendation, summarize } from './recommend.js'
import {
  CHINA_COUNTRY,
  CHINA_PROVINCES,
  OVERSEAS_PROVINCE,
  PROVINCE_OTHER,
  RECIPE_COUNT,
  RECIPE_CUISINES,
  RECIPE_ENTRIES,
  RECIPE_FILTERS,
  RECIPE_REGIONS,
  RECIPE_REGION_GROUPS,
  buildRecipeLibraryView,
  buildUserRecipeEntries,
  countByCountry,
  countByCuisine,
  countByProvince,
  countRecipesByRegion,
  countryOfDish,
  cuisineLabelOf,
  filterRecipes,
  filterRecipesByRegion,
  groupRecipeIngredients,
  groupRecipes,
  groupRecipesByRegion,
  matchesRegion,
  mergeRecipeEntries,
  primaryIngredients,
  primaryRegionOf,
  provinceOfDish,
  recipeCountriesOf,
  recipeCuisinesOf,
  recipeProvincesOf,
  referenceLinksOf,
  regionLabelOf,
  regionMetaOf,
  searchRecipes,
  selectRecipes,
  totalMinutes,
} from './recipe-library.js'
import RecipesTab from './tabs/recipes.jsx'
import { normalizeMealTimes, mealTimeState } from './mealTime.js'
import { openPanel, runtime, setPanelOpener } from './runtime.js'
import { getStore, resetStore, Store } from './store.js'
import {
  TASTE_DIMENSIONS,
  TASTE_HINTS,
  TASTE_LABELS,
  applyTasteValue,
  buildSettingsTasteRows,
  buildTasteProfile,
  createTasteDraft,
  dishTasteOf,
  normalizeTaste,
  summarizeTaste,
  tastePreferenceOf,
} from './taste.js'

/** 插件名（与 package.json name 一致）。 */
const PLUGIN_NAME = 'dsh-today-eat'

/** 横条槽位：输入框上方整行列表槽位（list / session scope）。 */
const DOCK_SLOT = 'conversation.input.dock'

/** 浮窗槽位：全框架浮层列表槽位（list / root scope，默认 click-through）。 */
const FLOAT_SLOT = 'shell.overlay'

/** 浮窗条目 id。 */
const FLOAT_ID = 'dsh-today-eat-float'

/** 兜底面板条目 id（右栏面板不可见时使用）。 */
const FALLBACK_ID = 'dsh-today-eat-fallback'

/** 右栏 tab id / kind（同一插件只注册一个）。 */
const TAB_ID = 'dsh-today-eat'
const TAB_KIND = 'dsh-today-eat'

/**
 * 注册右栏面板：① 声明 tab 类型 + guide 入口；② keyed slot 注册正文与标题。
 * 任一步失败都只清理已注册项，不向外抛（不能影响横条）。
 *
 * @param {object} scope 带 sidebarRightTabs / slots 的作用域
 * @returns {() => void} 清理函数
 */
function registerPanel(scope) {
  const disposers = []

  /**
   * 收集 disposer。
   *
   * @param {unknown} disposable 注册返回值
   * @returns {void}
   */
  const own = (disposable) => {
    if (typeof disposable === 'function') disposers.push(disposable)
  }

  try {
    const tabs = scope === null || scope === undefined ? undefined : scope.sidebarRightTabs
    if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return () => {}
    own(tabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      title: () => '今天吃什么',
      guide: [
        {
          id: TAB_ID,
          order: 30,
          title: () => '今天吃什么',
          description: () => '饮食管家：今日推荐 / 本周计划 / 记录统计 / 设置',
        },
      ],
    }))
    own(scope.slots.inject('sidebar.right.pane.tab', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, TodayEatPanel),
    ))
    own(scope.slots.inject('sidebar.right.pane.tab.title', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, TodayEatPanelTitle),
    ))
  } catch {
    // 右栏组件版本不一致 / 无前台会话：清理后静默退出
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 忽略
      }
    }
    return () => {}
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 忽略
      }
    }
  }
}

/** 供烟测使用的内部接口（运行时框架忽略多余属性）。 */
const testables = {
  PLUGIN_NAME,
  DOCK_SLOT,
  FLOAT_SLOT,
  FLOAT_ID,
  FALLBACK_ID,
  TAB_ID,
  api: { createApi, ApiError, isOfflineError, isRevConflict },
  display: {
    DISPLAY_MODE_META,
    DISPLAY_MODES,
    REROLL_CUISINES,
    clampFloatPos,
    displayModeOf,
    filterCatalogByCuisines,
    floatPositionStyle,
    isDragThresholdExceeded,
    moveFloatPos,
    normalizeFloatPos,
    normalizeRerollCuisines,
    normalizeUiState,
  },
  mealTime: { mealTimeState, normalizeMealTimes },
  panelTabs: PANEL_TABS,
  recommend: { CATALOG, buildPlan, createDefaultState, loadOfflineState, normalizeProfile, normalizeState, selectRecommendation, summarize },
  recipeLibrary: {
    CHINA_COUNTRY,
    CHINA_PROVINCES,
    OVERSEAS_PROVINCE,
    PROVINCE_OTHER,
    RECIPE_COUNT,
    RECIPE_CUISINES,
    RECIPE_ENTRIES,
    RECIPE_FILTERS,
    RECIPE_REGIONS,
    RECIPE_REGION_GROUPS,
    buildRecipeLibraryView,
    buildUserRecipeEntries,
    countByCountry,
    countByCuisine,
    countByProvince,
    countRecipesByRegion,
    countryOfDish,
    cuisineLabelOf,
    filterRecipes,
    filterRecipesByRegion,
    groupRecipeIngredients,
    groupRecipes,
    groupRecipesByRegion,
    matchesRegion,
    mergeRecipeEntries,
    primaryIngredients,
    primaryRegionOf,
    provinceOfDish,
    recipeCountriesOf,
    recipeCuisinesOf,
    recipeProvincesOf,
    referenceLinksOf,
    regionLabelOf,
    regionMetaOf,
    searchRecipes,
    selectRecipes,
    totalMinutes,
  },
  recipeTab: RecipesTab,
  taste: {
    TASTE_DIMENSIONS,
    TASTE_HINTS,
    TASTE_LABELS,
    applyTasteValue,
    buildSettingsTasteRows,
    buildTasteProfile,
    createTasteDraft,
    dishTasteOf,
    normalizeTaste,
    summarizeTaste,
    tastePreferenceOf,
  },
  store: { getStore, resetStore, Store },
  openPanel,
}

export default {
  name: PLUGIN_NAME,
  inject: ['slots'],
  /**
   * 插件入口。
   *
   * @param {object} ctx Cordis client 上下文
   * @returns {void}
   */
  apply(ctx) {
    ensureStyles()

    // 1) 打开面板的能力写入 runtime（拿不到 sidebarRight 就静默）
    const store = getStore()
    runtime.ctx = ctx ?? null
    setPanelOpener((tab, focus) => {
      try {
        store.setPanelTab(tab ?? 'today', focus ?? null)
      } catch {
        // 忽略
      }
      try {
        if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return
        const sidebarRight = ctx.get('sidebarRight')
        if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.openTab !== 'function') return
        sidebarRight.openTab(TAB_ID)
      } catch {
        // 无前台会话时 openTab 会抛：静默
      }
    })
    // 右栏不可见（无会话 / 插件页 / 无右栏服务）时，用插件自己的全屏兜底面板
    runtime.openFallback = (tab) => {
      try {
        store.setPanelTab(tab ?? 'today')
        store.set({ fallbackPanelOpen: true })
      } catch {
        // 忽略
      }
    }

    // 2) 启动 store（幂等；组件挂载时也会调用）
    store.start()
    // 插件卸载 / HMR 替换时停掉轮询与提醒定时器，避免旧 bundle 的定时器残留
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => store.stop(), 'dsh-today-eat: stop poll timers')
      }
    } catch {
      // 旧版 Cordis 无 effect：不影响主流程
    }

    // 3) 横条（输入框上方，仅 displayMode==='dock' 时显示）
    try {
      ctx.slots.inject(DOCK_SLOT, () =>
        ctx.slots.register({ name: DOCK_SLOT, id: PLUGIN_NAME, order: 50 }, TodayEatDock),
      )
    } catch {
      // 横条注册失败也不应让插件崩溃
    }

    // 4) 右下角浮窗（全框架浮层，仅 displayMode==='float' 时显示；默认形态）
    try {
      ctx.slots.inject(FLOAT_SLOT, () =>
        ctx.slots.register({ name: FLOAT_SLOT, id: FLOAT_ID, order: 80, locale: undefined }, TodayEatFloat),
      )
    } catch {
      // 宿主没有 shell.overlay：浮窗不可用，横条 / 面板仍然工作
    }

    // 4.1) 兜底面板（同一 shell.overlay 列表的另一条目；只在右栏面板不可见时渲染）
    try {
      ctx.slots.inject(FLOAT_SLOT, () =>
        ctx.slots.register({ name: FLOAT_SLOT, id: FALLBACK_ID, order: 120, locale: undefined }, TodayEatFallbackPanel),
      )
    } catch {
      // 没有 shell.overlay：兜底面板不可用，不影响横条
    }

    // 5) 右栏面板（可选增强）
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs', 'slots'], (scope) => registerPanel(scope))
      }
    } catch {
      // 宿主没有 sidebarRightTabs：面板不可用，横条仍工作
    }
  },
  __test: testables,
}
