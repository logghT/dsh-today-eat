/**
 * lib/state.js 单元测试：原子写、rev、损坏备份、patch 白名单、meals/plan/amapKey。
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  PATCH_ROOTS,
  TASTE_DIMENSIONS,
  createDefaultState,
  createStore,
  defaultTargetsFor,
  maskState,
  normalizeState,
  normalizeTasteProfile,
  resolveStatePath,
  shanghaiDate,
} from '../../lib/state.js'
import { FIXED_NOW, FIXED_TS, cleanupTempDirs, makeStore, makeTempDir, stateFileDir } from './helpers.mjs'

after(cleanupTempDirs)

test('resolveStatePath：DSH_HOME 注入 / 缺省 ~/.dsh', () => {
  const home = join(makeTempDir(), 'custom-home')
  assert.equal(
    resolveStatePath({ env: { DSH_HOME: home } }),
    join(home, 'storages', 'dsh-today-eat', 'state.json'),
  )
  assert.equal(
    resolveStatePath({ env: {} }),
    join(homedir(), '.dsh', 'storages', 'dsh-today-eat', 'state.json'),
  )
  assert.equal(resolveStatePath({ statePath: 'relative/state.json' }).endsWith('state.json'), true)
})

test('默认状态包含 design-v2 §2 的全部字段', () => {
  const state = createDefaultState(FIXED_TS)
  assert.equal(state.version, 3)
  assert.equal(state.rev, 1)
  assert.deepEqual(Object.keys(state).sort(), ['meals', 'phase', 'plan', 'profile', 'rev', 'settings', 'ui', 'userRecipes', 'version'])
  assert.deepEqual(state.userRecipes, {}, '我的菜谱默认空 map')
  assert.equal(state.profile.identity.city, '')
  assert.deepEqual(
    TASTE_DIMENSIONS.map((id) => state.profile.taste[id]),
    [3, 3, 3, 3, 3, 3],
    '默认六维味道偏好应为中性 3',
  )
  assert.equal(state.profile.taste.oiliness, 3, '油腻接受度中性')
  assert.equal(state.profile.taste.adventurous, 3, '尝鲜意愿中性')
  assert.equal(state.phase.kind, 'performance')
  assert.equal(state.phase.subgoal, 'fat_loss')
  assert.equal(state.phase.start, '2026-11-09')
  assert.equal(state.phase.targets.proteinG, 120)
  assert.deepEqual(state.settings.plannedMeals, ['lunch', 'dinner'])
  assert.equal(state.settings.amapKey, '')
  assert.equal(state.ui.panelTab, 'today')
})

test('六维味道迁移：旧 sourFruit/sourFermented/sourVinegar → sour=max，且旧字段保留', () => {
  const dir = makeTempDir()
  const statePath = join(dir, 'state.json')
  const oldState = {
    version: 3,
    rev: 2,
    profile: {
      identity: { city: '四川成都' },
      taste: { spicy: 4, sourFruit: 5, sourFermented: 2, sourVinegar: 1, sweet: 3, oiliness: 2, adventurous: 4 },
    },
  }
  writeFileSync(statePath, JSON.stringify(oldState), 'utf8')
  const store = createStore({ statePath, now: FIXED_NOW })
  const taste = store.getState().profile.taste
  assert.equal(taste.sour, 5, 'sour = max(旧酸字段)')
  assert.equal(taste.spicy, 4)
  assert.equal(taste.sweet, 3)
  assert.equal(taste.bitter, 1, '缺失维度回退 core 默认 1')
  assert.equal(taste.salty, 2)
  assert.equal(taste.umami, 3)
  assert.equal(taste.sourFruit, 5, '旧字段必须保留')
  assert.equal(taste.sourFermented, 2)
  assert.equal(taste.sourVinegar, 1)
  assert.deepEqual(TASTE_DIMENSIONS.filter((id) => !(id in taste)), [], '六键齐全')
})

test('六维味道 normalize：clamp 0-5、保留 1 位小数、旧字段保留', () => {
  const normalized = normalizeTasteProfile({
    sour: 9,
    sweet: -2,
    bitter: 2.26,
    spicy: 3,
    salty: 4.55,
    umami: 'x',
    sourFruit: 4,
    arbitraryLegacy: 7,
  })
  assert.equal(normalized.sour, 5, '越界 clamp 到 5（新字段为准，旧 sourFruit 不参与）')
  assert.equal(normalized.sweet, 0)
  assert.equal(normalized.bitter, 2.3)
  assert.equal(normalized.salty, 4.6)
  assert.equal(normalized.umami, 3, '非法值回退默认')
  assert.equal(normalized.sourFruit, 4, '旧字段保留')
  assert.equal(normalized.arbitraryLegacy, 7, '未知旧字段也保留')
  assert.deepEqual(TASTE_DIMENSIONS.filter((id) => !(id in normalized)), [])
})

test('patch：深合并、rev+1、返回掩码状态', () => {
  const store = makeStore('patch')
  const before = store.getState()
  const result = store.patch(before.rev, {
    profile: { taste: { sour: 5, umami: 4 }, budget: { perMeal: [20, 60] } },
    settings: { plannedMeals: ['lunch', 'dinner', 'night'] },
    ui: { collapsed: true, panelTab: 'settings' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.rev, before.rev + 1)
  assert.equal(result.state.profile.taste.sour, 5)
  assert.equal(result.state.profile.taste.umami, 4)
  assert.equal(result.state.profile.taste.spicy, 3, '未 patch 的维度保持默认')
  assert.deepEqual(result.state.profile.budget.perMeal, [20, 60])
  assert.deepEqual(result.state.settings.plannedMeals, ['lunch', 'dinner', 'night'])
  assert.equal(result.state.ui.collapsed, true)
  assert.equal(store.getRev(), before.rev + 1)
  assert.equal(result.hasAmapKey, false)
})

test('patch：rev 冲突返回 rev-mismatch 并带当前掩码状态', () => {
  const store = makeStore('conflict')
  const rev = store.getRev()
  assert.equal(store.patch(rev, { ui: { collapsed: true } }).ok, true)
  const stale = store.patch(rev, { ui: { collapsed: false } })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'rev-mismatch')
  assert.equal(stale.state.rev, rev + 1)
  assert.equal(stale.state.settings.amapKey, '')
})

test('ui.rerollCuisines：默认空数组，patch 归一化去重/过滤/按枚举排序', () => {
  const store = makeStore('reroll-cuisines')
  assert.deepEqual(store.getState().ui.rerollCuisines, [])
  const result = store.patch(store.getRev(), { ui: { rerollCuisines: ['川菜', '云南菜', '川菜', '不存在', ''] } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.state.ui.rerollCuisines, ['云南菜', '川菜'])
  const cleared = store.patch(store.getRev(), { ui: { rerollCuisines: 'not-an-array' } })
  assert.equal(cleared.ok, true)
  assert.deepEqual(cleared.state.ui.rerollCuisines, [])
})

test('userRecipes：patch 新增 / 删除（null）/ 非法项过滤', () => {
  const store = makeStore('user-recipes')
  assert.deepEqual(store.getState().userRecipes, {}, '默认空 map')

  const added = store.patch(store.getRev(), {
    userRecipes: {
      'custom-1': {
        name: '青柠手撕鸡',
        cuisine: '云南菜',
        category: '家常菜',
        kcal: 320,
        protein: 30,
        servings: 1,
        ingredients: [{ name: '鸡胸肉', amount: 200, unit: 'g' }],
        steps: ['煮熟撕丝', '拌料汁'],
      },
    },
  })
  assert.equal(added.ok, true)
  const recipe = added.state.userRecipes['custom-1']
  assert.equal(recipe.name, '青柠手撕鸡')
  assert.equal(recipe.cuisine, '云南菜')
  assert.equal(recipe.country, '中国')
  assert.equal(recipe.ingredients[0].group, '肉蛋', '食材分组自动推断')
  assert.equal(recipe.servings, 1)

  const removed = store.patch(store.getRev(), { userRecipes: { 'custom-1': null } })
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.state.userRecipes, {}, 'null 表示删除并归一化掉')

  const invalid = store.patch(store.getRev(), {
    userRecipes: {
      'custom-bad-name': { name: '', cuisine: '川菜' },
      'custom-bad-cuisine': { name: '怪菜', cuisine: '不存在菜系' },
      'custom-good': { name: '怪味鸡', cuisine: '川菜', category: '不存在的分类' },
    },
  })
  assert.equal(invalid.ok, true)
  assert.deepEqual(Object.keys(invalid.state.userRecipes), ['custom-good'])
  assert.equal(invalid.state.userRecipes['custom-good'].category, '家常菜', '非法分类回退家常菜')
})

test('patch：白名单只允许 profile/phase/settings/ui/userRecipes', () => {
  assert.deepEqual([...PATCH_ROOTS], ['profile', 'phase', 'settings', 'ui', 'userRecipes'])
  const store = makeStore('whitelist')
  for (const root of ['meals', 'plan', 'rev', 'version']) {
    const result = store.patch(store.getRev(), { [root]: [] })
    assert.equal(result.ok, false, `${root} 应被拒绝`)
    assert.equal(result.code, 'patch-not-allowed')
  }
  const badValue = store.patch(store.getRev(), { profile: 'x' })
  assert.equal(badValue.ok, false)
  assert.equal(badValue.code, 'invalid-patch')
  const badRev = store.patch(undefined, { ui: {} })
  assert.equal(badRev.ok, false)
  assert.equal(badRev.code, 'rev-required')
})

test('patch：settings.amapKey 不能经 patch 改写（专用接口保护）', () => {
  const store = makeStore('amap-patch')
  store.setAmapKey('real-key')
  const result = store.patch(store.getRev(), { settings: { amapKey: '' } })
  assert.equal(result.ok, true)
  assert.equal(store.getAmapKey(), 'real-key', 'patch 不得清除高德 Key')
  assert.equal(store.getState().settings.amapKey, '')
})

test('patch：phase 非法 kind 被忽略并保留旧值', () => {
  const store = makeStore('phase')
  const result = store.patch(store.getRev(), { phase: { kind: 'unknown-kind' } })
  assert.equal(result.ok, true)
  assert.equal(result.state.phase.kind, 'performance')
  const good = store.patch(store.getRev(), { phase: { kind: 'relax' } })
  assert.equal(good.state.phase.kind, 'treat')
  assert.equal(good.state.phase.subgoal, 'treat')
  assert.deepEqual(good.state.phase.targets, defaultTargetsFor('treat', 'treat'))
})

test('原子写：tmp+rename、不残留 .tmp、磁盘与内存 rev 一致', () => {
  const store = makeStore('atomic')
  store.patch(store.getRev(), { ui: { collapsed: true } })
  assert.ok(existsSync(store.statePath))
  assert.ok(!readdirSync(stateFileDir(store.statePath)).includes('state.json.tmp'))
  const onDisk = JSON.parse(readFileSync(store.statePath, 'utf8'))
  assert.equal(onDisk.rev, store.getRev())
  assert.equal(onDisk.ui.collapsed, true)
  assert.equal(onDisk.version, 3)
})

test('损坏恢复：坏 JSON 备份为 state.json.bad-<ts> 并回退默认', () => {
  const store = makeStore('corrupt')
  store.patch(store.getRev(), { ui: { collapsed: true } })
  writeFileSync(store.statePath, 'not json at all', 'utf8')
  const reopened = createStore({ statePath: store.statePath, now: FIXED_NOW })
  const state = reopened.getState()
  assert.equal(state.rev, 1)
  assert.equal(state.ui.collapsed, false)
  const backups = readdirSync(stateFileDir(store.statePath)).filter((name) => /^state\.json\.bad-/.test(name))
  assert.equal(backups.length, 1)
})

test('旧版本 / 残缺状态迁移：字段补齐且 version 升到 3', () => {
  const dir = makeTempDir()
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify({ version: 1, rev: 4, profile: { identity: { city: '昆明' } }, meals: [{ dishName: '米线', meal: 'lunch' }] }), 'utf8')
  const state = createStore({ statePath, now: FIXED_NOW }).getState()
  assert.equal(state.version, 3)
  assert.equal(state.rev, 4)
  assert.equal(state.profile.identity.city, '昆明')
  assert.equal(state.profile.identity.hometown, '')
  assert.equal(state.meals.length, 1)
  assert.equal(state.meals[0].date, '2026-11-09')
  assert.equal(state.settings.notify.inApp, true)
})

test('normalizeState / maskState 纯函数行为', () => {
  const normalized = normalizeState({ rev: 9, settings: { amapKey: 'secret' } }, { now: FIXED_TS })
  assert.equal(normalized.rev, 9)
  assert.equal(normalized.settings.amapKey, 'secret')
  const masked = maskState(normalized)
  assert.equal(masked.settings.amapKey, '')
  assert.equal(normalized.settings.amapKey, 'secret', 'maskState 不修改入参')
  assert.equal(shanghaiDate(FIXED_TS), '2026-11-09')
})

test('meals：新增 / 同 date+meal 替换 / 删除 / 404 语义', () => {
  const store = makeStore('meals')
  const first = store.upsertMeal(store.getRev(), { meal: 'lunch', dishId: 'dish-a', dishName: '酸汤鱼', rating: 1, kcal: 380 })
  assert.equal(first.ok, true)
  assert.equal(first.state.meals.length, 1)
  assert.match(first.meal.id, /^m-/)
  assert.equal(first.meal.date, '2026-11-09')
  const replaced = store.upsertMeal(store.getRev(), { meal: 'lunch', dishName: '换一道', rating: -1 })
  assert.equal(replaced.state.meals.length, 1, '同 date+meal 必须替换')
  assert.equal(replaced.state.meals[0].dishName, '换一道')
  assert.equal(replaced.state.meals[0].rating, -1)
  const dinner = store.upsertMeal(store.getRev(), { meal: 'dinner', dishName: '晚饭' })
  assert.equal(dinner.state.meals.length, 2)
  const stale = store.upsertMeal(store.getRev() - 1, { meal: 'lunch', dishName: '冲突' })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'rev-mismatch')
  const target = store.getState().meals.find((meal) => meal.meal === 'dinner')
  const deleted = store.deleteMeal(target.id)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.state.meals.length, 1)
  const missing = store.deleteMeal(target.id)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'meal-not-found')
})

test('meals：非法 mode/rating 被归一化，kcal 非法为 null', () => {
  const store = makeStore('meals-normalize')
  const result = store.upsertMeal(store.getRev(), {
    meal: 'night',
    mode: 'weird',
    rating: 5,
    kcal: 'not-a-number',
    proteinG: 'x',
    date: 'bad-date',
    ts: FIXED_TS,
  })
  assert.equal(result.ok, true)
  const meal = result.state.meals[0]
  assert.equal(meal.mode, null)
  assert.equal(meal.rating, 0)
  assert.equal(meal.kcal, null)
  assert.equal(meal.proteinG, null)
  assert.equal(meal.date, '2026-11-09')
})

test('plan：写入/归一化 picks', () => {
  const store = makeStore('plan')
  const result = store.setPlan(store.getRev(), {
    start: '2026-11-09',
    seed: 7,
    generatedAt: FIXED_TS,
    locked: { '2026-11-10': true },
    picks: [
      { date: '2026-11-09', meal: 'lunch', dishId: 'dish-a', mode: 'home' },
      { date: 'bad', meal: 'x', dishId: 'dish-b' },
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.state.plan.picks.length, 1)
  assert.equal(result.state.plan.seed, 7)
  assert.deepEqual(result.state.plan.locked, { '2026-11-10': true })
  const stale = store.setPlan(store.getRev() - 1, {})
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'rev-mismatch')
})

test('amapKey：保存 / 掩码 / 清除 / hasAmapKey', () => {
  const store = makeStore('amap-key')
  assert.equal(store.hasAmapKey(), false)
  assert.equal(store.getAmapKey(), '')
  const saved = store.setAmapKey('  abc123  ')
  assert.equal(saved.ok, true)
  assert.equal(saved.hasAmapKey, true)
  assert.equal(store.getAmapKey(), 'abc123', '保存时 trim')
  assert.equal(store.getState().settings.amapKey, '')
  const cleared = store.setAmapKey('')
  assert.equal(cleared.hasAmapKey, false)
  assert.equal(store.hasAmapKey(), false)
  assert.equal(store.setAmapKey(123).ok, false)
})

test('recentHistory：只取近 7 天且带 dishId 的记录', () => {
  const store = makeStore('history')
  store.upsertMealInternal({ meal: 'lunch', dishId: 'dish-a', date: '2026-11-09' })
  store.upsertMealInternal({ meal: 'dinner', dishId: 'dish-b', date: '2026-10-25' })
  store.upsertMealInternal({ meal: 'breakfast', dishId: '', date: '2026-11-09' })
  const history = store.recentHistory({ now: FIXED_TS, days: 7 })
  assert.deepEqual(history.map((item) => item.dishId), ['dish-a'])
})

test('不要写入真实 ~/.dsh：所有用例都用临时 statePath', () => {
  const store = makeStore('sandbox')
  assert.ok(store.statePath.includes('dsh-today-eat-test-'), '状态文件必须位于临时目录')
  assert.equal(store.statePath.includes(join(homedir(), '.dsh')), false)
})
