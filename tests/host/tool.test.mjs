/**
 * lib/tool.js 单元测试：7 个工具定义结构、execute 输出 schema、/food 命令。
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'

import { COMMAND_NAME, TOOL_NAMES, createCommandDefinition, createTools, formatTasteCompact, projectDish, projectNutrition, projectSummary, truncateCommandText } from '../../lib/tool.js'
import { assertSupportedSchema, cleanupTempDirs, createStubAmap, createStubCore, FIXED_NOW, makeStore, validateValue } from './helpers.mjs'

after(cleanupTempDirs)

/**
 * 新建一套工具依赖。
 *
 * @param {object} [overrides] 覆盖项
 * @returns {object} deps
 */
function makeDeps(overrides = {}) {
  return {
    store: makeStore('tool'),
    amap: createStubAmap(),
    core: createStubCore(),
    now: FIXED_NOW,
    ...overrides,
  }
}

/**
 * 取工具。
 *
 * @param {object[]} tools 工具列表
 * @param {string} name 工具名
 * @returns {object} 工具
 */
function toolOf(tools, name) {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `缺少工具 ${name}`)
  return tool
}

test('7 个工具：名字、顺序、description/output 结构', () => {
  const tools = createTools(makeDeps())
  assert.equal(TOOL_NAMES.length, 7)
  assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES])
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/)
    assert.notEqual(tool.name, 'run_code')
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.output.schema.type, 'object', `${tool.name} output 根必须是 object`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.required, undefined, `${tool.name} 参数应全部可选`)
  }
  assert.throws(() => createTools(), /store/)
})

test('7 个工具参数 / 输出 schema 均在 raw JSON Schema 子集内', () => {
  for (const tool of createTools(makeDeps())) {
    assertSupportedSchema(tool.parameters, `${tool.name}.parameters`)
    assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`)
  }
})

test('7 个工具 execute 返回值符合 output.schema 且 render 中文文本', async () => {
  const deps = makeDeps()
  const tools = createTools(deps)
  const cases = [
    ['update_profile', { city: '四川成都', sour: 4, spicy: 5, umami: 4, phaseKind: 'healthy' }],
    ['recommend_meal', { meal: 'lunch' }],
    ['plan_week', { regenerate: true }],
    ['cook_plan', {}],
    ['find_nearby', {}],
    ['log_meal', { dishId: 'stub-lemon-chicken', dishName: '柠檬鸡胸沙拉', meal: 'lunch', mode: 'home', rating: 1 }],
    ['meal_stats', { days: 7 }],
  ]
  for (const [name, args] of cases) {
    const tool = toolOf(tools, name)
    const value = await tool.execute(args)
    const errors = validateValue(tool.output.schema, value, name)
    assert.deepEqual(errors, [], `${name} 输出不符合 schema：${errors.join('; ')}`)
    const blocks = tool.output.render(args, value)
    assert.ok(Array.isArray(blocks) && blocks.length >= 1)
    for (const block of blocks) {
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
      assert.ok(block.text.length > 0)
    }
  }
})

test('update_profile：六维味道参数 + 档案/阶段写入 + render 六维摘要', async () => {
  const deps = makeDeps()
  const tools = createTools(deps)
  const tool = toolOf(tools, 'update_profile')
  const value = await tool.execute({
    city: '云南昆明',
    district: '五华区',
    sour: 4,
    sweet: 2,
    bitter: 1,
    spicy: 5,
    salty: 3,
    umami: 4,
    phaseKind: 'relax',
    phaseWeeks: 4,
    budgetPerMealMax: 50,
  })
  assert.ok(value.summary.includes('city'))
  assert.ok(value.summary.includes('phaseKind'))
  assert.ok(value.summary.includes('味道偏好：酸4 甜2 苦1 辣5 咸3 鲜4'), value.summary)
  assert.ok(Array.isArray(value.fields) && value.fields.includes('phaseWeeks'))
  assert.ok(value.fields.includes('sour') && value.fields.includes('umami'))
  const state = deps.store.getState()
  assert.equal(state.profile.identity.city, '云南昆明')
  assert.equal(state.profile.identity.district, '五华区')
  assert.equal(state.profile.taste.sour, 4)
  assert.equal(state.profile.taste.sweet, 2)
  assert.equal(state.profile.taste.bitter, 1)
  assert.equal(state.profile.taste.spicy, 5)
  assert.equal(state.profile.taste.salty, 3)
  assert.equal(state.profile.taste.umami, 4)
  assert.equal(state.phase.kind, 'treat')
  assert.equal(state.phase.subgoal, 'treat')
  assert.equal(state.phase.weeks, 4)
  assert.deepEqual(state.profile.budget.perMeal, [20, 50])
  const rendered = tool.output.render({}, value)
  assert.ok(rendered[0].text.includes('味道偏好：'))
  const empty = await tool.execute({})
  assert.ok(empty.summary.includes('没有可更新'))
  assert.ok(empty.summary.includes('味道偏好：'), '没有更新时也展示当前六维')
  assert.deepEqual(empty.fields, [])
})

test('update_profile：旧酸参数兼容（sour = max(sourFruit, sourFermented, sourVinegar)）', async () => {
  const deps = makeDeps()
  const tool = toolOf(createTools(deps), 'update_profile')
  const value = await tool.execute({ sourFruit: 2, sourFermented: 5, sourVinegar: 3, spicy: 4 })
  assert.ok(value.fields.includes('sour'))
  assert.ok(value.summary.includes('味道偏好：酸5 甜3 苦3 辣4 咸3 鲜3'), value.summary)
  const taste = deps.store.getState().profile.taste
  assert.equal(taste.sour, 5)
  assert.equal(taste.spicy, 4)
  assert.equal(taste.umami, 3, '未传维度保持默认')
  const explicit = await tool.execute({ sour: 1, sourFruit: 5 })
  assert.equal(deps.store.getState().profile.taste.sour, 5, 'sour 与旧参数同时出现取最大值')
  assert.equal(explicit.summary.includes('酸5'), true)
})

test('recommend_meal：excludeIds 生效、输出 nutrition、备选最多 3 道', async () => {
  const deps = makeDeps()
  const tool = toolOf(createTools(deps), 'recommend_meal')
  const value = await tool.execute({ meal: 'dinner', excludeIds: ['stub-sour-fish', 'stub-lemon-chicken'] })
  assert.equal(value.meal, 'dinner')
  assert.equal(value.dish.id, 'stub-tomato-noodle')
  assert.equal(value.nutrition.kcal, 520)
  assert.ok(value.alternatives.length <= 3)
  assert.equal(typeof value.reason, 'string')
  assert.equal(value.fallbackNote, null)
})

test('plan_week：默认生成 7 天并写入状态；已有计划时复用', async () => {
  const deps = makeDeps()
  const tool = toolOf(createTools(deps), 'plan_week')
  const value = await tool.execute({ regenerate: true })
  assert.equal(value.days.length, 7)
  assert.equal(value.days[0].meals.length, 2)
  assert.equal(value.summary.uniqueDishes, 3)
  assert.equal(deps.store.getFullState().plan.picks.length, 14)
  const reused = await tool.execute({})
  assert.equal(reused.days.length, 7)
  assert.equal(deps.store.getFullState().plan.picks.length, 14, '复用不应重复写状态')
})

test('cook_plan：菜谱步骤/用量/采买清单', async () => {
  const deps = makeDeps()
  const tool = toolOf(createTools(deps), 'cook_plan')
  const value = await tool.execute({ dishId: 'stub-lemon-chicken' })
  assert.equal(value.dishName, '柠檬鸡胸沙拉')
  assert.equal(value.prepMin, 8)
  assert.equal(value.cookMin, 10)
  assert.ok(value.steps.length >= 1)
  assert.equal(value.ingredients[0].name, '鸡胸肉')
  assert.equal(value.ingredients[0].amount, 150)
  assert.ok(value.shopping.groups.length >= 1)
  const missing = await tool.execute({ dishId: 'no-such-dish' })
  assert.equal(missing.steps.length, 0)
  assert.ok(missing.note.length > 0)
})

test('find_nearby：无 Key → amap-key-missing；有 Key → items/weather', async () => {
  const deps = makeDeps()
  const tools = createTools(deps)
  const tool = toolOf(tools, 'find_nearby')
  const noKey = await tool.execute({})
  assert.equal(noKey.ok, false)
  assert.equal(noKey.code, 'amap-key-missing')
  assert.ok(noKey.fallbackQueries.length > 0)
  deps.store.setAmapKey('k-123')
  const withKey = await tool.execute({ radius: 800 })
  assert.equal(withKey.ok, true)
  assert.equal(withKey.code, null)
  assert.equal(withKey.items.length, 2)
  assert.equal(withKey.weather.dayWeather, '多云')
  assert.ok(withKey.suggestions.length > 0)
  const rendered = tool.output.render({}, withKey)
  assert.match(rendered[0].text, /附近推荐/)
})

test('log_meal：记录写入状态并返回统计摘要', async () => {
  const deps = makeDeps()
  const tools = createTools(deps)
  const tool = toolOf(tools, 'log_meal')
  const value = await tool.execute({ dishId: 'stub-lemon-chicken', meal: 'lunch', mode: 'home', rating: 1, note: '好吃' })
  assert.equal(value.logged, true)
  assert.equal(value.meal.dishName, '柠檬鸡胸沙拉')
  assert.equal(value.meal.kcal, 420)
  assert.equal(value.meal.proteinG, 38)
  assert.equal(value.summary.loggedDays, 1)
  const meals = deps.store.getFullState().meals
  assert.equal(meals.length, 1)
  assert.equal(meals[0].note, '好吃')
  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /已记录午餐/)
})

test('meal_stats：六维 taste schema（dimensions/samples/summary）+ 画像 render', async () => {
  const deps = makeDeps()
  deps.store.upsertMealInternal({ dishId: 'stub-sour-fish', meal: 'lunch', rating: 1 })
  const tool = toolOf(createTools(deps), 'meal_stats')
  const value = await tool.execute({ days: 14 })
  assert.equal(value.days, 14)
  assert.ok(Array.isArray(value.taste.dimensions))
  assert.equal(value.taste.dimensions.length, 6)
  assert.deepEqual(value.taste.dimensions.map((dimension) => dimension.id), ['sour', 'sweet', 'bitter', 'spicy', 'salty', 'umami'])
  assert.deepEqual(value.taste.dimensions.map((dimension) => dimension.label), ['酸', '甜', '苦', '辣', '咸', '鲜'])
  for (const dimension of value.taste.dimensions) {
    assert.equal(typeof dimension.value, 'number')
    assert.ok(dimension.value >= 0 && dimension.value <= 5)
    assert.equal(typeof dimension.liked, 'number')
    assert.equal(typeof dimension.disliked, 'number')
  }
  assert.ok(value.taste.samples >= 1)
  assert.equal(typeof value.taste.summary, 'string')
  assert.equal(value.summary.loggedDays, 1)
  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /最近 14 天/)
  assert.match(rendered[0].text, /口味画像：酸 \d\.\d · 甜 \d\.\d · 苦 \d\.\d · 辣 \d\.\d · 咸 \d\.\d · 鲜 \d\.\d/)
})

test('meal_stats：无记录时六维回退偏好并提示', async () => {
  const deps = makeDeps()
  const tool = toolOf(createTools(deps), 'meal_stats')
  const value = await tool.execute({})
  assert.equal(value.taste.samples, 0)
  assert.equal(value.taste.dimensions.length, 6)
  assert.equal(value.taste.dimensions[0].value, 3, '回退档案默认酸=3')
  assert.equal(value.taste.dimensions[3].value, 3, '回退档案默认辣=3')
  assert.match(value.taste.summary, /偏好设置/)
  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /还没有记录，先显示你的偏好设置/)
  assert.match(rendered[0].text, /口味画像：/)
})

test('/food 命令：5 个子命令 success 且 ≤200 字', async () => {
  const command = createCommandDefinition(makeDeps())
  assert.equal(command.name, COMMAND_NAME)
  assert.equal(command.name, 'food')
  assert.equal(typeof command.description, 'string')
  assert.equal(typeof command.input.hint, 'string')
  for (const rawInput of ['', '附近', '周计划', '自己做', '统计']) {
    const result = await command.handler({ rawInput })
    assert.equal(result.kind, 'success')
    assert.equal(typeof result.text, 'string')
    assert.ok(result.text.length > 0, `/${rawInput} 不应为空`)
    assert.ok(result.text.length <= 200, `/${rawInput} 超长：${result.text.length}`)
  }
})

test('/food 命令：无 Key 的「附近」给出配置/兜底提示', async () => {
  const command = createCommandDefinition(makeDeps())
  const result = await command.handler({ rawInput: '附近' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Key|高德|配置/)
})

test('truncateCommandText / project* 纯函数', () => {
  const long = 'a'.repeat(300)
  const truncated = truncateCommandText(long)
  assert.ok(truncated.length <= 200)
  assert.ok(truncated.endsWith('…'))
  assert.equal(truncateCommandText('短文本'), '短文本')
  assert.deepEqual(projectDish(null), null)
  assert.equal(projectDish({ id: 'x' }).name, 'x')
  assert.deepEqual(projectNutrition({ kcal: 100, protein: 10 }), { kcal: 100, protein: 10, fat: 0, carbs: 0, veg: 0 })
  const summary = projectSummary({ streak: 2 })
  assert.equal(summary.streak, 2)
  assert.deepEqual(summary.topCuisines, [])
  // core.summarizeMeals 的 topCuisines 是 [{cuisine, count}]（对象数组），也要兼容 string[]
  const withCuisines = projectSummary({ topCuisines: [{ cuisine: '川菜', count: 3 }, { cuisine: '云南菜', count: 2 }, '北方'] })
  assert.deepEqual(withCuisines.topCuisines, [
    { cuisine: '川菜', count: 3 },
    { cuisine: '云南菜', count: 2 },
    { cuisine: '北方', count: 0 },
  ])
  // 六维味道紧凑摘要（update_profile render）
  assert.equal(
    formatTasteCompact({ sour: 4, sweet: 2, bitter: 1, spicy: 5, salty: 3, umami: 4 }),
    '酸4 甜2 苦1 辣5 咸3 鲜4',
  )
  assert.equal(formatTasteCompact({ sour: 3.25, sweet: 2 }), '酸3.3 甜2 苦1 辣3 咸2 鲜3')
})
