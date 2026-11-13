#!/usr/bin/env node
/**
 * 「今天吃什么」client 半离线烟测（轻量版）。
 *
 * 校验不依赖浏览器/DSH 运行时：
 * 1) 产物是经典脚本 + window.__ModuleLoader__.load({ id, factory }) 协议；
 * 2) factory 返回 Cordis 客户端插件对象，且只 require baseline 模块；
 * 3) 关键挂载点 / 浮窗 / 胶囊面板 / API 路径等字符串确实打包进产物；
 * 4) __test 暴露的纯函数（display 的 clamp/位置/模式归一化）行为正确。
 *
 * 说明：完整 UI 交互（渲染、拖动、双击开面板、记录等）由真机 GUI 探针覆盖。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'lib', 'client.js')
const text = fs.readFileSync(bundlePath, 'utf8')
let pass = 0
let fail = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    pass += 1
    console.log('  ✔ ' + name)
  } catch (error) {
    fail += 1
    failures.push([name, error])
    console.log('  ✖ ' + name)
  }
}

console.log('smoke-client · 轻量离线校验（bundle ' + Math.round(text.length / 1024) + ' KB）')

/* ── 静态协议检查 ─────────────────────────────────────── */

test('产物是 ModuleLoader 经典脚本', () => {
  assert.ok(text.includes('window.__ModuleLoader__.load('))
  assert.ok(/id\s*:\s*["'`]dsh-today-eat["'`]/.test(text))
  assert.ok(!/^\s*import\s/m.test(text), '不应包含 ESM import')
  assert.ok(!/^\s*export\s/m.test(text), '不应包含 ESM export')
})

test('只 require baseline 模块（react / react-dom / react/jsx-runtime）', () => {
  const allowed = new Set(['react', 'react-dom', 'react/jsx-runtime'])
  const found = new Set()
  for (const match of text.matchAll(/require\(["'`]([^"'`]+)["'`]\)/g)) found.add(match[1])
  for (const name of found) assert.ok(allowed.has(name), '出现了非 baseline require: ' + name)
})

test('关键挂载点与交互字符串已打包', () => {
  for (const needle of [
    'conversation.input.dock',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'shell.overlay',
    'dsh-today-eat-float',
    'tde-float-capsule-panel',
    '做法参考（外部）',
    'xiachufang.com',
    '/dsh-today-eat/api',
    '/nearby',
    '/shopping',
    'openPanel',
  ]) {
    assert.ok(text.includes(needle), '缺少: ' + needle)
  }
})

test('无外部图片；外部链接只允许菜谱参考站点', () => {
  assert.ok(!/url\(\s*["']?https?:/.test(text), 'CSS 不应引用外部图片')
  const allowedHosts = ['www.xiachufang.com', 'www.douyin.com', 'search.bilibili.com', 'www.xiaohongshu.com']
  const urls = [...text.matchAll(/https?:\/\/[^"'`\s)]+/g)].map((match) => match[0])
  for (const url of urls) {
    assert.ok(
      allowedHosts.some((host) => url.includes(host)),
      '出现未允许的外部 URL: ' + url,
    )
  }
})

/* ── 在 vm 中加载 factory ─────────────────────────────── */

function createReactStub() {
  const fn = () => {}
  const base = {
    createElement: () => ({}),
    Fragment: 'Fragment',
    useState: (init) => [typeof init === 'function' ? init() : init, fn],
    useEffect: fn,
    useLayoutEffect: fn,
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
    useContext: () => ({}),
    createContext: () => ({ Provider: fn, Consumer: fn }),
    memo: (component) => component,
    forwardRef: (component) => component,
  }
  return new Proxy(base, { get: (target, key) => (key in target ? target[key] : fn) })
}

const registrations = []
const state = {
  version: 3, rev: 1, meals: [], plan: { picks: [], locked: {} },
  profile: { identity: { hometown: '云南', city: '四川成都', district: '锦江区', region: '西南', lat: 30.5728, lng: 104.0668, adcode: '511800' }, taste: {}, dietary: {}, budget: {}, cook: {} },
  phase: { kind: 'relax', start: '2026-11-09', weeks: 8, targets: {} },
  settings: { mealTimes: {}, plannedMeals: ['lunch', 'dinner'], notify: {}, amapKey: '' },
  ui: { displayMode: 'float', floatCollapsed: false, floatPos: null },
}
const fetchStub = async (input) => {
  const url = String(input && input.url ? input.url : input)
  if (url.includes('/dsh-today-eat/api/state')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, state, hasAmapKey: false }), text: async () => JSON.stringify({ ok: true, state }) }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, code: 'not-found' }), text: async () => '{}' }
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  queueMicrotask,
  URL,
  URLSearchParams,
  fetch: fetchStub,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, appendChild: () => {}, setAttribute: () => {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { style: {} },
  },
  navigator: { language: 'zh-CN', userAgent: 'smoke' },
  location: { href: 'http://127.0.0.1:49396/' },
  Notification: { permission: 'denied', requestPermission: async () => 'denied' },
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1600,
  innerHeight: 1000,
  performance: { now: () => Date.now() },
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.self = sandbox
sandbox.__ModuleLoader__ = { load: (registration) => registrations.push(registration) }
vm.createContext(sandbox)
vm.runInContext(text, sandbox, { filename: 'lib/client.js' })

test('ModuleLoader registration 正确（id / factory）', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-today-eat')
  assert.equal(typeof registrations[0].factory, 'function')
})

const requireStub = (name) => {
  if (name === 'react') return createReactStub()
  if (name === 'react/jsx-runtime') {
    const jsx = (type, props, key) => ({ type, key: key ?? null, props: props === null || props === undefined ? {} : props })
    return { jsx, jsxs: jsx, Fragment: 'Fragment' }
  }
  if (name === 'react-dom') return { createPortal: (node) => node, flushSync: (callback) => callback() }
  throw new Error('unexpected require: ' + name)
}
const plugin = registrations.length === 1 ? registrations[0].factory(requireStub) : null

/**
 * 展开函数组件，得到可断言的元素树（烟测只渲染纯展示组件，不启动 store）。
 *
 * @param {unknown} node 元素
 * @returns {unknown} 树
 */
function resolveTree(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(resolveTree).flat(Infinity)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const props = node.props === undefined ? {} : node.props
    return resolveTree(node.type(props))
  }
  const props = node.props
  if (props === undefined || !Object.prototype.hasOwnProperty.call(props, 'children')) return node
  return { ...node, props: { ...props, children: resolveTree(props.children) } }
}

/**
 * 深度收集满足条件的元素。
 *
 * @param {unknown} node 节点
 * @param {(element: object) => boolean} predicate 判定
 * @param {object[]} [collected=[]] 收集数组
 * @returns {object[]} 命中的元素
 */
function findElements(node, predicate, collected = []) {
  if (node === null || node === undefined) return collected
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, collected)
    return collected
  }
  if (typeof node !== 'object') return collected
  if (node.type !== undefined && predicate(node)) collected.push(node)
  findElements(node.props === undefined ? undefined : node.props.children, predicate, collected)
  return collected
}

/**
 * 收集元素文本。
 *
 * @param {unknown} node 节点
 * @returns {string} 文本
 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.props === undefined ? undefined : node.props.children)
  return ''
}

test('factory 返回 Cordis 客户端插件对象', () => {
  assert.equal(plugin.name, 'dsh-today-eat')
  assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('slots'))
  assert.equal(typeof plugin.apply, 'function')
})

/* ── 纯函数（__test.display） ─────────────────────────── */

test('display 纯函数：clamp / 位置样式 / 模式归一化', () => {
  const display = plugin.__test.display
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.equal(typeof display.clampFloatPos, 'function')
  assert.deepEqual(plain(display.clampFloatPos({ x: -50, y: -80 }, { width: 1200, height: 800 }, { width: 320, height: 300 })), { x: 8, y: 8 })
  assert.deepEqual(plain(display.clampFloatPos({ x: 5000, y: 5000 }, { width: 1200, height: 800 }, { width: 320, height: 300 })), { x: 872, y: 492 })
  assert.deepEqual(plain(display.floatPositionStyle(null)), { right: 16, bottom: 340 })
  assert.deepEqual(plain(display.floatPositionStyle({ x: 300, y: 400 })), { left: 300, top: 400 })
  assert.equal(display.displayModeOf({ ui: { displayMode: 'dock' } }), 'dock')
  assert.equal(display.displayModeOf({ ui: {} }), 'float')
  assert.equal(display.normalizeUiState({ displayMode: 'nope', floatPos: { x: 'bad' } }).displayMode, 'float')
  assert.deepEqual(plain(display.normalizeUiState({ floatPos: { x: 12, y: 34 } }).floatPos), { x: 12, y: 34 })
  assert.equal(display.normalizeUiState({ floatPos: { x: 'bad', y: 2 } }).floatPos, null)
})

test('拖动阈值：小位移不算拖动', () => {
  const { isDragThresholdExceeded } = plugin.__test.display
  assert.equal(isDragThresholdExceeded({ x: 0, y: 0 }, { x: 2, y: 2 }), false)
  assert.equal(isDragThresholdExceeded({ x: 0, y: 0 }, { x: 20, y: 20 }), true)
})

/* ── 六维味道（酸/甜/苦/辣/咸/鲜，docs/taste-v1.md） ─────── */

test('六维味道文案 / 口味画像字符串已打包', () => {
  for (const needle of [
    '味道偏好',
    '酸（柠檬/醋/酸汤）',
    '甜（糖/蜜/甜口）',
    '苦（苦瓜/苦荞/茶）',
    '辣（辣椒/花椒）',
    '咸（腌制/卤味）',
    '鲜（菌菇/海鲜/高汤）',
    '口味画像',
    '偏爱',
    '偏好设置',
  ]) {
    assert.ok(text.includes(needle), '缺少文案: ' + needle)
  }
})

test('taste.normalizeTaste：旧档案六维迁移 + clamp 0–5', () => {
  const taste = plugin.__test.taste
  const migrated = taste.normalizeTaste({ spicy: 5, sourFruit: 4, sourFermented: 2, sourVinegar: 1, sweet: 2 })
  assert.equal(migrated.sour, 4, 'sour 应取旧果酸最大值的迁移值')
  assert.equal(migrated.spicy, 5)
  assert.equal(migrated.sweet, 2)
  assert.equal(migrated.bitter, 1)
  assert.equal(migrated.salty, 2)
  assert.equal(migrated.umami, 3)
  for (const id of ['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami']) {
    assert.equal(typeof migrated[id], 'number')
  }
  const clamped = taste.normalizeTaste({ sour: 9, spicy: -2, salty: 3.26 })
  assert.equal(clamped.sour, 5)
  assert.equal(clamped.spicy, 0)
  assert.equal(clamped.salty, 3.3)
})

test('taste 设置页：六行滑块模型 + 拖动写回六维', () => {
  const taste = plugin.__test.taste
  const rows = taste.buildSettingsTasteRows({ sour: 4, sweet: 2, bitter: 1, spicy: 5, salty: 2, umami: 3 })
  assert.equal(rows.length, 6)
  const expectedIds = ['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami']
  const expectedLabels = ['酸', '甜', '苦', '辣', '咸', '鲜']
  rows.forEach((row, index) => {
    assert.equal(row.id, expectedIds[index])
    assert.equal(row.label, expectedLabels[index])
  })
  for (const row of rows) {
    assert.equal(typeof row.hint, 'string')
    assert.ok(row.hint.length > 0)
    assert.ok(row.value >= 0 && row.value <= 5)
  }
  // 旧档案 → 草稿 → 调一个维度 → 写回 profile.taste 六维
  const draft = taste.createTasteDraft({ taste: { spicy: 5, sourFruit: 4, oiliness: 3, adventurous: 2 } })
  assert.equal(draft.sour, 4)
  assert.equal(draft.spicy, 5)
  assert.equal(draft.oiliness, 3)
  assert.equal(draft.adventurous, 2)
  const next = taste.applyTasteValue(draft, 'sour', 1)
  assert.equal(next.sour, 1, '滑块改酸应写回 taste.sour')
  assert.equal(next.oiliness, 3, '油腻接受度应保留')
  assert.equal(next.adventurous, 2, '尝鲜意愿应保留')
  for (const id of ['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami']) assert.ok(id in next)
  assert.equal(taste.applyTasteValue(draft, 'umami', 9).umami, 5)
})

test('taste.summarizeTaste：有记录时六维统计（rating 加权）/ 无记录回退偏好', () => {
  const taste = plugin.__test.taste
  const catalog = plugin.__test.recommend.CATALOG
  assert.ok(Array.isArray(catalog) && catalog.length >= 2, '菜品库应可用')
  const profile = { taste: { sour: 5, sweet: 1, bitter: 1, spicy: 5, salty: 2, umami: 4 } }
  const meals = [
    { dishId: catalog[0].id, rating: 1, date: '2026-11-10', meal: 'lunch' },
    { dishId: catalog[1].id, rating: -1, date: '2026-11-11', meal: 'dinner' },
  ]
  const stats = taste.summarizeTaste(meals, catalog, profile)
  assert.equal(stats.samples, 2)
  assert.equal(stats.dimensions.length, 6)
  assert.equal(typeof stats.summary, 'string')
  assert.ok(stats.summary.length > 0)
  for (const dimension of stats.dimensions) {
    assert.ok(['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami'].includes(dimension.id))
    assert.equal(typeof dimension.label, 'string')
    assert.ok(dimension.value >= 0 && dimension.value <= 5)
    assert.equal(Math.round(dimension.value * 10), dimension.value * 10, 'value 应保留 1 位小数')
    assert.ok(dimension.liked >= 0 && dimension.disliked >= 0)
  }
  assert.ok(Array.isArray(stats.topTastes))

  // 无记录：回退偏好设置，samples=0，mode=preference
  const fallback = taste.buildTasteProfile([], catalog, profile)
  assert.equal(fallback.samples, 0)
  assert.equal(fallback.mode, 'preference')
  assert.equal(fallback.dimensions.length, 6)
  const byId = Object.fromEntries(fallback.dimensions.map((dimension) => [dimension.id, dimension.value]))
  assert.equal(byId.sour, 5)
  assert.equal(byId.spicy, 5)
  assert.equal(byId.umami, 4)
  assert.ok(fallback.summary.includes('偏好设置'), '无记录 summary 应使用「偏好设置」')

  // 有记录：mode=stats，summary 为「偏爱：…」或「口味均衡」
  const withMeals = taste.buildTasteProfile(meals, catalog, profile)
  assert.equal(withMeals.mode, 'stats')
  assert.ok(withMeals.summary.includes('偏爱') || withMeals.summary.includes('口味均衡'), '有记录 summary 应使用「偏爱」或「口味均衡」')
})

test('recommend：默认档案六维 + 旧 state 味道迁移不报错', () => {
  const recommend = plugin.__test.recommend
  const defaults = recommend.createDefaultState().profile.taste
  for (const id of ['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami']) {
    assert.equal(typeof defaults[id], 'number')
  }
  assert.equal(typeof defaults.oiliness, 'number')
  assert.equal(typeof defaults.adventurous, 'number')
  const migrated = recommend.normalizeState({ profile: { taste: { spicy: 5, sourFruit: 4, sourFermented: 2, sourVinegar: 1, sweet: 2 } } })
  assert.equal(migrated.profile.taste.sour, 4)
  assert.equal(migrated.profile.taste.spicy, 5)
  for (const id of ['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami']) {
    assert.equal(typeof migrated.profile.taste[id], 'number')
  }
  const profile = recommend.normalizeProfile({ taste: { sour: 2, oiliness: 5, adventurous: 1 } })
  assert.equal(profile.taste.sour, 2)
  assert.equal(profile.taste.oiliness, 5)
  assert.equal(profile.taste.adventurous, 1)
})

/* ── 菜谱库（docs/recipe-library.md §2） ─────────────── */

test('菜谱库静态文案已打包（菜谱库 / 筛选 / 外部参考）', () => {
  for (const needle of [
    '菜谱库',
    '快手 ≤20 分钟',
    '高蛋白 ≥25g',
    '全部菜谱',
    '汤羹',
    '素菜',
    '做法参考（外部）',
    '没有找到匹配的菜谱',
    'tde-recipe-detail',
    '当前显示',
    '全部地区',
    '地区',
    '云南菜',
    '全部国家',
    '全部菜系',
    '全部省份',
    '按国家',
    '按菜系',
    '按省份',
    '省份',
    '湘菜',
    '粤菜',
    '江浙',
    '北方',
    '西北',
    '西南',
    '日韩',
    '西式',
    '快餐',
  ]) {
    assert.ok(text.includes(needle), '缺少: ' + needle)
  }
})

test('PANEL_TABS：菜谱 tab 位于本周与记录之间', () => {
  const tabs = plugin.__test.panelTabs
  assert.ok(Array.isArray(tabs))
  const ids = tabs.map((tab) => tab.id)
  assert.ok(ids.includes('recipes'), 'PANEL_TABS 应包含 recipes')
  assert.equal(ids.indexOf('recipes'), ids.indexOf('week') + 1, '菜谱 tab 应在本周之后')
  assert.equal(ids.indexOf('recipes'), ids.indexOf('history') - 1, '菜谱 tab 应在记录之前')
  const tab = tabs.find((item) => item.id === 'recipes')
  assert.equal(tab.label, '菜谱')
  assert.equal(tab.emoji, '📖')
})

test('菜谱库条目：数量 / 时长 / 主要食材 / 外部参考链接', () => {
  const lib = plugin.__test.recipeLibrary
  assert.ok(lib.RECIPE_COUNT > 0, '菜谱数据应已就绪')
  assert.equal(lib.RECIPE_ENTRIES.length, lib.RECIPE_COUNT, '条目数应等于 RECIPE_COUNT')
  for (const entry of lib.RECIPE_ENTRIES) {
    for (const key of ['id', 'name', 'difficulty', 'minutes', 'kcal', 'protein', 'primaryIngredients', 'steps', 'tips', 'searchText']) {
      assert.ok(key in entry, `${entry.id} 缺少字段 ${key}`)
    }
    assert.equal(entry.minutes, entry.prepMin + entry.cookMin, `${entry.id} 总时长应为备料+烹饪`)
    assert.ok(entry.primaryIngredients.length >= 1 && entry.primaryIngredients.length <= 3)
    assert.ok(entry.steps.length >= 1, `${entry.id} 缺少步骤`)
    assert.equal(entry.searchText, entry.searchText.toLowerCase())
  }
  const links = lib.referenceLinksOf(lib.RECIPE_ENTRIES[0].name)
  assert.ok(links.length > 0)
  for (const link of links) {
    assert.ok(typeof link.label === 'string' && link.label !== '')
    assert.ok(typeof link.url === 'string' && link.url.startsWith('https://'))
  }
})

test('菜谱库筛选：计数 === 对同一数据集独立计算的期望值（不写死数量）', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  assert.equal(lib.filterRecipes(entries, 'all').length, entries.length)

  // 场景筛选 chips（地区维度单独一行，见下方地区用例）
  const scenarioExpectations = [
    ['quick', entries.filter((entry) => entry.minutes <= 20).length],
    ['highProtein', entries.filter((entry) => entry.protein >= 25).length],
    ['soup', entries.filter((entry) => entry.category === '汤羹' || entry.tags.includes('soup')).length],
    ['veg', entries.filter((entry) => entry.tags.includes('veg')).length],
  ]
  for (const [filterId, expected] of scenarioExpectations) {
    const actual = lib.filterRecipes(entries, filterId)
    assert.equal(actual.length, expected, `${filterId} 筛选计数应与独立计算一致`)
    assert.ok(actual.length > 0, `${filterId} 筛选结果不应为空`)
  }
  // 旧地区语义（云南/川菜）仍由 filterRecipes 兼容（页面已迁移到地区行）
  assert.ok(lib.filterRecipes(entries, 'yunnan').length > 0)
  assert.ok(lib.filterRecipes(entries, 'sichuan').length > 0)

  // 每条结果的字段确实满足筛选条件（属性级校验，避免只比数量）
  assert.ok(lib.filterRecipes(entries, 'quick').every((entry) => entry.minutes <= 20))
  assert.ok(lib.filterRecipes(entries, 'highProtein').every((entry) => entry.protein >= 25))
  assert.ok(lib.filterRecipes(entries, 'soup').every((entry) => entry.category === '汤羹' || entry.tags.includes('soup')))
  assert.ok(lib.filterRecipes(entries, 'veg').every((entry) => entry.tags.includes('veg')))
})

test('菜谱库搜索：菜名/食材/菜系 + 组合筛选 + 空态', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  const chicken = lib.searchRecipes(entries, '鸡')
  assert.ok(chicken.length > 0, '搜索「鸡」应有结果')
  for (const entry of chicken) {
    const haystack = [entry.name, entry.cuisine, ...entry.ingredients.map((item) => item.name)].join(' ')
    assert.ok(haystack.includes('鸡'), `${entry.name} 的名称/食材/菜系应包含「鸡」`)
  }
  const quickChicken = lib.selectRecipes(entries, { query: '鸡', filter: 'quick' })
  const chickenIds = new Set(chicken.map((entry) => entry.id))
  const quickIds = new Set(lib.filterRecipes(entries, 'quick').map((entry) => entry.id))
  for (const entry of quickChicken) {
    assert.ok(chickenIds.has(entry.id), `${entry.name} 应在「鸡」搜索结果内`)
    assert.ok(quickIds.has(entry.id), `${entry.name} 应在快手筛选结果内`)
    assert.ok(entry.minutes <= 20)
  }
  assert.ok(quickChicken.length <= chicken.length, '组合筛选应是搜索结果的子集')
  const blank = lib.searchRecipes(entries, '   ')
  assert.equal(blank.length, entries.length, '空白搜索应返回全部')
  const empty = lib.buildRecipeLibraryView(entries, { query: 'zzz不存在的菜', filter: 'all' })
  assert.equal(empty.empty, true)
  assert.equal(empty.results.length, 0)
  assert.equal(empty.total, entries.length)
  const view = lib.buildRecipeLibraryView(entries, { query: '', filter: 'quick' })
  assert.equal(view.filterLabel, '快手 ≤20 分钟')
  assert.ok(view.results.length > 0)
})

test('菜谱详情模型：用量分组 / 步骤 / tips', () => {
  const lib = plugin.__test.recipeLibrary
  const entry = lib.RECIPE_ENTRIES[0]
  const groups = lib.groupRecipeIngredients(entry)
  assert.ok(groups.length > 0)
  assert.ok(groups.every((group) => typeof group.group === 'string' && group.group !== '' && Array.isArray(group.items) && group.items.length > 0))
  assert.equal(typeof lib.totalMinutes(entry), 'number')
  assert.ok(lib.primaryIngredients(entry, 3).length <= 3)
  assert.ok(Array.isArray(entry.tips))
})

/* ── 菜谱地区筛选（第二行 chips） ─────────────────────── */

test('地区定义：全部地区 + 云南 + 10 个菜系（顺序与契约一致）', () => {
  const lib = plugin.__test.recipeLibrary
  assert.ok(Array.isArray(lib.RECIPE_REGIONS))
  const ids = lib.RECIPE_REGIONS.map((region) => region.id)
  const labels = lib.RECIPE_REGIONS.map((region) => region.label)
  assert.equal(ids[0], 'all')
  assert.equal(labels[0], '全部地区')
  assert.equal(ids[1], 'yunnan')
  assert.equal(labels[1], '云南')
  const cuisineRegions = lib.RECIPE_REGION_GROUPS.filter((region) => region.kind === 'cuisine')
  assert.equal(cuisineRegions.length, 10, '应有 10 个菜系地区')
  assert.equal(lib.regionLabelOf('yunnan'), '云南')
  assert.equal(lib.regionLabelOf('sichuan'), '川菜')
  assert.equal(lib.regionMetaOf('yunnan').kind, 'origin')
  assert.ok(lib.RECIPE_REGIONS.every((region) => region.id === 'all' || typeof region.kind === 'string'))
})

test('地区计数动态：云南 = origins 含云南，其余 = 菜系精确匹配（不写死数量）', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  const counts = lib.countRecipesByRegion(entries)
  assert.equal(counts.all, entries.length, '全部地区计数应等于条目总数')
  const yunnanExpected = entries.filter((entry) => entry.origins.includes('云南')).length
  assert.equal(counts.yunnan, yunnanExpected, '云南计数应等于 origins 含云南的条数')
  assert.ok(counts.yunnan > 0, '应有云南菜')
  for (const region of lib.RECIPE_REGION_GROUPS) {
    const filtered = lib.filterRecipesByRegion(entries, region.id)
    assert.equal(counts[region.id], filtered.length, `${region.label} 计数应等于筛选结果数`)
    assert.ok(filtered.length > 0, `${region.label} 不应为空`)
    assert.ok(filtered.every((entry) => lib.matchesRegion(entry, region.id)), `${region.label} 每条应匹配地区`)
    if (region.kind === 'cuisine') {
      assert.ok(filtered.every((entry) => entry.cuisine === region.match), `${region.label} 应按菜系精确匹配`)
    }
    if (region.kind === 'origin') {
      assert.ok(filtered.every((entry) => entry.origins.includes(region.match)), '云南应只含 origins 含云南的菜')
    }
  }
})

test('全部地区分组：按地区顺序、每条只出现一次', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  const view = lib.buildRecipeLibraryView(entries, { region: 'all' })
  assert.ok(view.groups.length > 0)
  const seen = new Set()
  let total = 0
  for (const group of view.groups) {
    assert.ok(typeof group.id === 'string' && typeof group.label === 'string')
    assert.ok(group.entries.length > 0)
    for (const entry of group.entries) {
      assert.equal(lib.primaryRegionOf(entry), group.id, `${entry.name} 应归入主地区 ${group.label}`)
      assert.ok(!seen.has(entry.id), `${entry.name} 不应出现在多个地区组`)
      seen.add(entry.id)
      total += 1
    }
  }
  assert.equal(total, entries.length, '分组后应覆盖全部菜谱')
  const groupIds = view.groups.map((group) => group.id)
  const expectedOrder = lib.RECIPE_REGION_GROUPS.map((region) => region.id)
  const ordered = groupIds.filter((id) => id !== 'other')
  assert.deepEqual(ordered, expectedOrder.filter((id) => groupIds.includes(id)), '地区组顺序应与定义一致')
})

test('地区筛选：结果符合地区、chip 数量随场景/搜索动态、组合为子集', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  const yunnanView = lib.buildRecipeLibraryView(entries, { region: 'yunnan' })
  assert.ok(yunnanView.results.length > 0)
  assert.ok(yunnanView.results.every((entry) => entry.origins.includes('云南')))
  assert.equal(yunnanView.results.length, lib.countRecipesByRegion(entries).yunnan)

  // 场景筛选后地区 chip 数量应基于当前场景结果实时变化
  const quickEntries = lib.filterRecipes(entries, 'quick')
  const quickView = lib.buildRecipeLibraryView(entries, { filter: 'quick' })
  assert.equal(quickView.regionCounts.all, quickEntries.length)
  for (const region of lib.RECIPE_REGION_GROUPS) {
    const expected = lib.filterRecipesByRegion(quickEntries, region.id).length
    assert.equal(quickView.regionCounts[region.id], expected, `快手 + ${region.label} 计数应动态一致`)
  }

  // 搜索 + 场景 + 地区三者组合，是各子集的交集
  const combo = lib.selectRecipes(entries, { query: '鸡', filter: 'quick', region: 'sichuan' })
  for (const entry of combo) {
    assert.equal(entry.cuisine, '川菜')
    assert.ok(entry.minutes <= 20)
    assert.ok([entry.name, entry.cuisine, ...entry.ingredients.map((item) => item.name)].join(' ').includes('鸡'))
  }
  const searchOnly = new Set(lib.searchRecipes(entries, '鸡').map((entry) => entry.id))
  const filterOnly = new Set(lib.filterRecipes(entries, 'quick').map((entry) => entry.id))
  const regionOnly = new Set(lib.filterRecipesByRegion(entries, 'sichuan').map((entry) => entry.id))
  for (const entry of combo) {
    assert.ok(searchOnly.has(entry.id) && filterOnly.has(entry.id) && regionOnly.has(entry.id))
  }
})

test('菜谱页渲染：三维筛选行 / 省份 select / 分组切换 / 卡片标签', () => {
  const lib = plugin.__test.recipeLibrary
  const tab = plugin.__test.recipeTab
  assert.equal(typeof tab, 'function')
  const tree = resolveTree(tab({}))
  const body = textOf(tree)
  assert.ok(body.includes('菜谱库 · ' + lib.RECIPE_COUNT + ' 道'), '标题应显示菜谱总数')
  for (const label of ['全部', '快手 ≤20 分钟', '高蛋白 ≥25g', '汤羹', '素菜']) {
    assert.ok(body.includes(label), '缺少场景筛选 chip: ' + label)
  }
  // 国家行：全部国家 + 数据中出现的国家（数量动态）
  const countries = lib.recipeCountriesOf(lib.RECIPE_ENTRIES)
  assert.ok(countries.length > 0)
  assert.ok(body.includes('全部国家'), '缺少全部国家 chip')
  for (const country of countries) assert.ok(body.includes(country), '缺少国家 chip: ' + country)
  // 菜系行：全部菜系 + 11 菜系（云南菜独立）
  assert.ok(body.includes('全部菜系'), '缺少全部菜系 chip')
  for (const cuisine of lib.RECIPE_CUISINES) assert.ok(body.includes(cuisine), '缺少菜系 chip: ' + cuisine)
  const yunnanCuisineCount = lib.RECIPE_ENTRIES.filter((entry) => entry.cuisine === '云南菜').length
  assert.ok(body.includes('云南菜' + yunnanCuisineCount), '云南菜 chip 应显示动态数量')
  // 省份 select：存在且带全部省份 + 数据中的省级行政区
  const selects = findElements(tree, (element) => element.type === 'select')
  assert.equal(selects.length, 1, '应有省份下拉 select')
  const optionTexts = findElements(selects[0], (element) => element.type === 'option').map((element) => textOf(element))
  assert.ok(optionTexts.some((option) => option.includes('全部省份')), '省份 select 应有「全部省份」')
  const provinces = lib.recipeProvincesOf(lib.RECIPE_ENTRIES)
  assert.ok(provinces.length > 0)
  for (const province of provinces) {
    assert.ok(optionTexts.some((option) => option.includes(province)), '省份 option 缺失: ' + province)
  }
  // 分组切换 segment
  for (const label of ['按国家', '按菜系', '按省份']) assert.ok(body.includes(label), '缺少分组切换: ' + label)
  // 卡片：数量 / 收起态 / 国家+省份+菜系标签
  const heads = findElements(
    tree,
    (element) => element.type === 'button' && typeof element.props.className === 'string' && element.props.className === 'tde-recipe-card-head',
  )
  assert.equal(heads.length, lib.RECIPE_COUNT, '初始应渲染全部菜谱卡片')
  assert.ok(heads.every((head) => head.props['aria-expanded'] === false), '卡片初始应为收起态（详情展开能力保留）')
  const first = lib.RECIPE_ENTRIES[0]
  assert.ok(body.includes(first.country), '卡片应显示国家标签')
  assert.ok(body.includes(first.cuisineLabel), '卡片应显示菜系标签')
  if (first.province !== null) assert.ok(body.includes(first.province), '卡片应显示省份标签')
  assert.ok(body.includes('共 ' + lib.RECIPE_COUNT + ' 道 · 当前显示 ' + lib.RECIPE_COUNT + ' 道'), '结果计数应随数据动态变化')
  // 默认按国家分组，组标题数量与分组一致
  const expectedGroups = lib.buildRecipeLibraryView(lib.RECIPE_ENTRIES, { groupBy: 'country' }).groups
  const groupTitles = findElements(
    tree,
    (element) => typeof element.props.className === 'string' && element.props.className === 'tde-recipe-region-title',
  )
  assert.equal(groupTitles.length, expectedGroups.length, '分组标题数量应与分组一致')
  for (const group of expectedGroups) {
    assert.ok(groupTitles.some((node) => textOf(node).includes(group.label)), '缺少分组标题: ' + group.label)
  }
  assert.ok(body.includes(lib.RECIPE_ENTRIES[0].name), '列表应包含第一道菜名')
  assert.ok(body.includes('主料：'))
  const linkCount = findElements(tree, (element) => element.type === 'a').length
  assert.equal(linkCount, 0, '收起态不渲染外部参考链接')
})

/* ── 三维分类：国家 / 菜系 / 省份（docs/recipe-taxonomy.md §2） ── */

test('三维字段：每条 entry 有 country/province/cuisineLabel，国外菜 province 为 null', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  const seenProvinces = new Set()
  for (const entry of entries) {
    assert.ok(typeof entry.country === 'string' && entry.country !== '', `${entry.name} 缺国家`)
    assert.ok(typeof entry.cuisineLabel === 'string' && entry.cuisineLabel !== '', `${entry.name} 缺菜系标签`)
    if (entry.country === lib.CHINA_COUNTRY) {
      if (entry.province !== null) {
        assert.ok(lib.CHINA_PROVINCES.includes(entry.province), `${entry.name} 省份应合法: ${entry.province}`)
        seenProvinces.add(entry.province)
      }
    } else {
      assert.equal(entry.province, null, `${entry.name} 国外菜 province 应为 null`)
    }
  }
  assert.ok(seenProvinces.size > 0, '应至少解析出一些中国省份')
})

test('三维列表 / 计数：与独立计算一致，不写死数量', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  const countryCounts = lib.countByCountry(entries)
  const countries = lib.recipeCountriesOf(entries)
  assert.equal(countries[0], lib.CHINA_COUNTRY, '国家列表应中国优先')
  for (const country of countries) {
    assert.equal(countryCounts[country], entries.filter((entry) => entry.country === country).length, `${country} 计数应一致`)
    assert.ok(countryCounts[country] > 0)
  }
  assert.equal(Object.values(countryCounts).reduce((sum, value) => sum + value, 0), entries.length)
  assert.equal(Object.keys(countryCounts).length, countries.length)

  const cuisineCounts = lib.countByCuisine(entries)
  const cuisines = lib.recipeCuisinesOf(entries)
  for (const cuisine of cuisines) {
    assert.equal(cuisineCounts[cuisine], entries.filter((entry) => entry.cuisine === cuisine).length, `${cuisine} 计数应一致`)
  }
  assert.equal(Object.values(cuisineCounts).reduce((sum, value) => sum + value, 0), entries.length)

  const provinceCounts = lib.countByProvince(entries)
  const provinces = lib.recipeProvincesOf(entries)
  for (const province of provinces) {
    assert.equal(
      provinceCounts[province],
      entries.filter((entry) => entry.country === lib.CHINA_COUNTRY && entry.province === province).length,
      `${province} 计数应一致`,
    )
    assert.ok(lib.CHINA_PROVINCES.includes(province), '省份列表应只含合法省级行政区')
  }
  const chineseWithProvince = entries.filter((entry) => entry.country === lib.CHINA_COUNTRY && entry.province !== null).length
  assert.equal(Object.values(provinceCounts).reduce((sum, value) => sum + value, 0), chineseWithProvince, '省份计数不应包含国外菜')
})

test('三维组合筛选：国家/菜系/省份 + 场景 + 搜索互为子集', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  const countries = lib.recipeCountriesOf(entries)
  const foreignCountry = [...countries].reverse().find((country) => country !== lib.CHINA_COUNTRY) ?? lib.CHINA_COUNTRY
  const byCountry = lib.filterRecipes(entries, { country: foreignCountry })
  assert.ok(byCountry.length > 0, '所选国家应有结果')
  assert.ok(byCountry.every((entry) => entry.country === foreignCountry))

  const provinces = lib.recipeProvincesOf(entries)
  const sampleProvince = provinces[0]
  const byProvince = lib.filterRecipes(entries, { province: sampleProvince })
  assert.ok(byProvince.length > 0)
  assert.ok(byProvince.every((entry) => entry.country === lib.CHINA_COUNTRY && entry.province === sampleProvince))

  const cuisine = lib.recipeCuisinesOf(entries).find((item) => lib.filterRecipes(entries, { country: foreignCountry, cuisine: item }).length > 0) ?? 'all'
  const combo = lib.filterRecipes(entries, { query: '鸡', scene: 'quick', country: foreignCountry, cuisine })
  const searchSet = new Set(lib.searchRecipes(entries, '鸡').map((entry) => entry.id))
  const quickSet = new Set(lib.filterRecipes(entries, { scene: 'quick' }).map((entry) => entry.id))
  const cuisineSet = new Set(lib.filterRecipes(entries, { cuisine }).map((entry) => entry.id))
  for (const entry of combo) {
    assert.equal(entry.country, foreignCountry)
    assert.ok(entry.minutes <= 20)
    if (cuisine !== 'all') assert.equal(entry.cuisine, cuisine)
    assert.ok(searchSet.has(entry.id) && quickSet.has(entry.id) && cuisineSet.has(entry.id))
  }
  assert.ok(combo.length <= quickSet.size)
  assert.equal(lib.filterRecipes(entries, { scene: 'all', country: 'all', cuisine: 'all', province: 'all' }).length, entries.length)
})

test('分组切换：按国家/菜系/省份，每条只出现一次且顺序稳定', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  for (const by of ['country', 'cuisine', 'province']) {
    const groups = lib.groupRecipes(entries, by)
    const seen = new Set()
    let total = 0
    for (const group of groups) {
      assert.ok(group.entries.length > 0, `${by} 组不应为空: ${group.label}`)
      for (const entry of group.entries) {
        assert.ok(!seen.has(entry.id), `${by} 分组中 ${entry.name} 重复出现`)
        seen.add(entry.id)
        total += 1
      }
    }
    assert.equal(total, entries.length, `${by} 分组应覆盖全部条目`)
    if (by === 'country') {
      assert.deepEqual([...groups.map((group) => group.id)], [...lib.recipeCountriesOf(entries)])
    }
    if (by === 'province') {
      const ids = groups.map((group) => group.id)
      const ordered = lib.CHINA_PROVINCES.filter((province) => ids.includes(province))
      assert.deepEqual(ids.slice(0, ordered.length), ordered, '省份组应按标准省级行政区顺序')
      assert.ok(ids.includes('overseas'), '含国外菜时应有「海外」分组')
    }
  }
})

test('地区样例：泰国 / 云南数据存在时筛选结果符合地区', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  const countries = lib.recipeCountriesOf(entries)
  if (countries.includes('泰国')) {
    const thai = lib.filterRecipes(entries, { country: '泰国' })
    assert.ok(thai.length > 0)
    assert.ok(thai.every((entry) => entry.country === '泰国'))
  }
  const provinces = lib.recipeProvincesOf(entries)
  if (provinces.includes('云南')) {
    const yunnan = lib.filterRecipes(entries, { province: '云南' })
    assert.ok(yunnan.length > 0)
    assert.ok(yunnan.every((entry) => entry.country === lib.CHINA_COUNTRY && entry.province === '云南'))
  }
})

test('视图：counts/groupBy/省份选择动态一致', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  const view = lib.buildRecipeLibraryView(entries, { groupBy: 'country' })
  assert.equal(view.total, entries.length)
  assert.equal(view.counts.base, entries.length)
  assert.equal(view.results.length, entries.length)
  assert.deepEqual(Object.keys(view.counts.country).sort(), [...lib.recipeCountriesOf(entries)].sort())
  assert.deepEqual([...view.countryList], [...lib.recipeCountriesOf(entries)])
  // 选省份后只显示该省，且仍按所选维度分组
  const provinces = lib.recipeProvincesOf(entries)
  if (provinces.length > 0) {
    const province = provinces[0]
    const provinceView = lib.buildRecipeLibraryView(entries, { province, groupBy: 'province' })
    assert.ok(provinceView.results.length > 0)
    assert.ok(provinceView.results.every((entry) => entry.province === province))
    assert.ok(provinceView.groups.every((group) => group.entries.every((entry) => entry.province === province)))
  }
  // 选场景后各维度 chip 数量按当前基础集动态变化
  const quickBase = lib.filterRecipes(entries, { scene: 'quick' })
  const quickView = lib.buildRecipeLibraryView(entries, { scene: 'quick', groupBy: 'country' })
  assert.equal(quickView.counts.base, quickBase.length)
  assert.equal(
    Object.values(quickView.counts.country).reduce((sum, value) => sum + value, 0),
    quickBase.length,
  )
})

test('三维解析：优先 dish.country/province，旧数据用 origins 兜底', () => {
  const lib = plugin.__test.recipeLibrary
  // 新数据：显式字段优先
  assert.equal(lib.countryOfDish({ country: '泰国', origins: [] }), '泰国')
  assert.equal(lib.countryOfDish({ country: '中国', origins: ['日本'] }), '中国')
  assert.equal(lib.provinceOfDish({ country: '中国', province: '四川', origins: [] }), '四川')
  assert.equal(lib.provinceOfDish({ country: '日本', province: null, origins: ['日本'] }), null)
  assert.equal(lib.provinceOfDish({ country: '中国', province: '其他', origins: [] }), null)
  // 旧数据（无 country/province 字段）：origins / 菜系兜底
  assert.equal(lib.provinceOfDish({ origins: ['成都'], cuisine: '川菜' }), '四川')
  assert.equal(lib.provinceOfDish({ origins: ['东北'], cuisine: '北方' }), '辽宁')
  assert.equal(lib.provinceOfDish({ origins: ['云南'], cuisine: '西南' }), '云南')
  assert.equal(lib.countryOfDish({ origins: ['日本'], cuisine: '日韩' }), '日本')
  assert.equal(lib.countryOfDish({ origins: ['云南'], cuisine: '西南' }), '中国')
  assert.equal(lib.countryOfDish({ origins: [], cuisine: '日韩' }), '日本')
  assert.equal(lib.countryOfDish({ origins: [], cuisine: '西式' }), '美国')
  assert.equal(lib.cuisineLabelOf('川菜'), '川菜')
  assert.equal(lib.cuisineLabelOf('') , '其他')
})

test('云南菜独立菜系：11 类 / chip 计数动态 / 筛选与分组使用云南菜', () => {
  const lib = plugin.__test.recipeLibrary
  const entries = lib.RECIPE_ENTRIES
  assert.equal(lib.RECIPE_CUISINES.length, 11, '菜系枚举应为 11 类')
  assert.equal(lib.RECIPE_CUISINES[0], '云南菜', '云南菜应在菜系枚举中独立列出')
  assert.equal(lib.cuisineLabelOf('云南菜'), '云南菜')

  const yunnanCuisine = entries.filter((entry) => entry.cuisine === '云南菜')
  const count = yunnanCuisine.length
  // 数据未切换时 count=0 也应通过；切换后动态匹配
  assert.equal(lib.filterRecipes(entries, { cuisine: '云南菜' }).length, count)
  assert.ok(lib.filterRecipes(entries, { cuisine: '云南菜' }).every((entry) => entry.cuisine === '云南菜' && entry.cuisineLabel === '云南菜'))

  const view = lib.buildRecipeLibraryView(entries, { cuisine: '云南菜', groupBy: 'cuisine' })
  assert.equal(view.results.length, count)
  assert.equal(view.counts.cuisine['云南菜'] ?? 0, count, '云南菜 chip 计数应等于数据中 cuisine===云南菜 的条数')
  assert.ok(view.results.every((entry) => entry.cuisine === '云南菜'))

  const groups = lib.groupRecipes(entries, 'cuisine')
  let total = 0
  for (const group of groups) total += group.entries.length
  assert.equal(total, entries.length, '按菜系分组仍应覆盖全部条目')
  const yunnanGroup = groups.find((group) => group.id === '云南菜')
  if (count > 0) {
    assert.ok(yunnanGroup !== undefined, '按菜系分组应出现「云南菜」组')
    assert.equal(yunnanGroup.label, '云南菜')
    assert.equal(yunnanGroup.entries.length, count)
    assert.ok(yunnanGroup.entries.every((entry) => entry.cuisine === '云南菜'))
    // 云南菜组应出现在西南组之前（契约建议顺序：云南菜…西南…）
    const ids = groups.map((group) => group.id)
    if (ids.includes('西南')) assert.ok(ids.indexOf('云南菜') < ids.indexOf('西南'), '云南菜组应在西南组之前')
  } else {
    assert.equal(yunnanGroup, undefined, '无云南菜数据时不应出现空分组')
  }
})

/* ── 换一个风格（m01400：按菜系多选后只在该风格内抽） ── */

test('换一个风格：菜系枚举 / 归一化 / 目录过滤已打包', () => {
  const display = plugin.__test.display
  assert.equal(display.REROLL_CUISINES.length, 11)
  assert.equal(display.REROLL_CUISINES[0], '云南菜')
  assert.equal(display.normalizeRerollCuisines(['川菜', '云南菜', '川菜', '不存在', '']).join(','), '云南菜,川菜')
  assert.equal(display.normalizeRerollCuisines('川菜').length, 0)
  assert.equal(display.normalizeRerollCuisines(undefined).length, 0)
  const catalog = plugin.__test.recommend.CATALOG
  assert.equal(display.filterCatalogByCuisines(catalog, []).length, catalog.length)
  const yunnan = display.filterCatalogByCuisines(catalog, ['云南菜'])
  assert.ok(yunnan.length > 0)
  assert.ok(yunnan.every((dish) => dish.cuisine === '云南菜'))
  for (const needle of ['换一个风格', '按风格换一个', '选菜系，可多选', '未选 = 全部菜系']) {
    assert.ok(text.includes(needle), '缺少文案: ' + needle)
  }
})

test('换一个风格：selectRecommendation 按菜系过滤推荐与备选', () => {
  const recommend = plugin.__test.recommend
  const state = recommend.createDefaultState()
  const now = new Date('2026-11-13T12:00:00+08:00')
  const all = recommend.selectRecommendation({ state, now })
  assert.ok(all.dish, '未选菜系时应有推荐')
  const yunnan = recommend.selectRecommendation({ state, now, cuisines: ['云南菜'] })
  assert.ok(yunnan.dish, '选云南菜时应有推荐')
  assert.equal(yunnan.dish.cuisine, '云南菜')
  for (const alternative of yunnan.alternatives) {
    assert.equal(alternative.cuisine, '云南菜', '备选也必须来自所选菜系')
  }
  const multi = recommend.selectRecommendation({ state, now, cuisines: ['川菜', '湘菜'] })
  assert.ok(multi.dish, '多选菜系时应有推荐')
  assert.ok(['川菜', '湘菜'].includes(multi.dish.cuisine))
})

test('我的菜谱：自定义菜谱合并进库、标记 custom、可筛选可搜索', () => {
  const lib = plugin.__test.recipeLibrary
  const custom = {
    'custom-demo': {
      name: '青柠手撕鸡',
      cuisine: '云南菜',
      category: '家常菜',
      country: '中国',
      province: '云南',
      kcal: 320,
      protein: 30,
      ingredients: [{ name: '鸡胸肉', amount: 200, unit: 'g' }],
      steps: ['煮熟撕丝', '拌料汁'],
    },
  }
  const entries = lib.buildUserRecipeEntries(custom)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'custom-demo')
  assert.equal(entries[0].custom, true, '自定义菜谱应标记 custom')
  assert.equal(entries[0].cuisine, '云南菜')
  assert.equal(entries[0].cuisineLabel, '云南菜')
  assert.equal(entries[0].country, '中国')
  assert.equal(entries[0].province, '云南')
  assert.ok(entries[0].primaryIngredients.includes('鸡胸肉'))

  const merged = lib.mergeRecipeEntries(custom)
  assert.equal(merged.length, lib.RECIPE_COUNT + 1, '内置 400 + 我的 1')
  assert.equal(merged[0].id, 'custom-demo', '我的菜谱排在最前')
  assert.equal(lib.filterRecipes(merged, { scene: 'mine' }).length, 1)
  const searched = lib.filterRecipes(merged, { query: '青柠' })
  assert.ok(searched.some((entry) => entry.id === 'custom-demo'), '搜索「青柠」应能找到我的菜谱')
  assert.equal(lib.mergeRecipeEntries({}).length, lib.RECIPE_COUNT, '无自定义时只返回内置')
})

test('我的菜谱：添加按钮 / 表单文案已打包', () => {
  for (const needle of ['添加我的菜', '我的菜谱', '保存到我的菜谱', '菜名和菜系必填', '删除后不能恢复']) {
    assert.ok(text.includes(needle), '缺少文案: ' + needle)
  }
})

console.log('')
if (fail > 0) {
  console.log('✖ smoke-client 有 ' + fail + ' 项失败（通过 ' + pass + ' 项）')
  for (const [name, error] of failures) console.log('\n[' + name + ']\n' + (error && error.stack ? error.stack : String(error)))
  process.exit(1)
}
console.log('✔ smoke-client 全部通过（' + pass + ' 项）')
