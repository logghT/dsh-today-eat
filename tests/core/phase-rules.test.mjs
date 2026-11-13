/**
 * src/core/phase-rules.js 单元测试：九阶段动态适配 / 加减分 / 纯素硬过滤。
 *
 * 数据里 1000 道菜只有旧四维 phases；新阶段靠 nutrition/tags/ingredients 计算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  phaseFitFor,
  phaseHardEligible,
  phaseScoreAdjustment,
} from '../../src/core/phase-rules.js'

/**
 * 构造测试菜。
 *
 * @param {object} [overrides] 覆盖字段
 * @returns {object} 菜品
 */
function dish(overrides = {}) {
  return {
    id: 'dish-test',
    name: '测试菜',
    category: '家常菜',
    tags: ['微辣', 'meat', 'rice'],
    ingredients: [{ name: '鸡胸肉', amount: 200, unit: 'g' }],
    nutrition: { kcal: 500, protein: 30, fat: 10, carbs: 50, veg: 1 },
    phases: { fitness: 3, healthy: 3, relax: 3, indulgence: 3 },
    ...overrides,
  }
}

test('performance：复用旧 fitness 分，蛋白高加分、油炸减分', () => {
  const lean = dish({
    name: '鸡胸沙拉',
    phases: { fitness: 5, healthy: 4, relax: 2, indulgence: 1 },
    nutrition: { kcal: 420, protein: 38, fat: 8, carbs: 30, veg: 3 },
  })
  const fried = dish({
    name: '炸鸡',
    ingredients: [{ name: '炸鸡', amount: 1, unit: '份' }],
    phases: { fitness: 1, healthy: 1, relax: 5, indulgence: 5 },
    nutrition: { kcal: 900, protein: 20, fat: 45, carbs: 60, veg: 0 },
  })
  assert.ok(phaseFitFor(lean, 'performance') >= 4)
  assert.ok(phaseFitFor(lean, 'performance') > phaseFitFor(fried, 'performance'))
  // 旧名别名
  assert.equal(phaseFitFor(lean, 'fitness'), phaseFitFor(lean, 'performance'))
})

test('treat：取旧 indulgence/relax 较高分，油炸甜口加分', () => {
  const feast = dish({
    name: '炸鸡啤酒',
    tags: ['油炸', '甜', 'meat'],
    ingredients: [{ name: '炸鸡', amount: 1, unit: '份' }, { name: '蜂蜜', amount: 1, unit: '勺' }],
    phases: { fitness: 1, healthy: 1, relax: 5, indulgence: 5 },
    nutrition: { kcal: 900, protein: 20, fat: 45, carbs: 80, veg: 0 },
  })
  assert.equal(phaseFitFor(feast, 'treat'), 5)
  assert.ok(phaseScoreAdjustment(feast, 'treat') > 0)
})

test('low_sugar：甜口/高碳水更低，蛋白质高、蔬菜多更高', () => {
  const sweet = dish({
    name: '糖醋里脊',
    tags: ['甜', 'meat'],
    ingredients: [{ name: '里脊', amount: 200, unit: 'g' }, { name: '冰糖', amount: 20, unit: 'g' }],
    nutrition: { kcal: 700, protein: 20, fat: 25, carbs: 85, veg: 0 },
  })
  const light = dish({
    name: '清蒸鱼配西兰花',
    tags: ['清淡', 'seafood'],
    ingredients: [{ name: '鲈鱼', amount: 200, unit: 'g' }, { name: '西兰花', amount: 200, unit: 'g' }],
    nutrition: { kcal: 380, protein: 35, fat: 8, carbs: 30, veg: 3 },
  })
  assert.ok(phaseFitFor(light, 'low_sugar') > phaseFitFor(sweet, 'low_sugar'))
  assert.ok(phaseScoreAdjustment(sweet, 'low_sugar') < 0)
})

test('high_fiber：蔬菜/全谷更高；nutrition 嵌套字段被正确读取', () => {
  const veggie = dish({
    name: '杂粮饭配时蔬',
    tags: ['vegan', 'vegetable'],
    ingredients: [{ name: '糙米', amount: 100, unit: 'g' }, { name: '西兰花', amount: 200, unit: 'g' }],
    nutrition: { kcal: 420, protein: 16, fat: 10, carbs: 55, veg: 4 },
  })
  const meatOnly = dish({
    name: '烤肉',
    tags: ['meat'],
    ingredients: [{ name: '猪五花', amount: 250, unit: 'g' }],
    nutrition: { kcal: 800, protein: 28, fat: 55, carbs: 5, veg: 0 },
  })
  assert.ok(phaseFitFor(veggie, 'high_fiber') > phaseFitFor(meatOnly, 'high_fiber'))
  assert.ok(phaseScoreAdjustment(veggie, 'high_fiber') > 0)
})

test('plant_based 硬过滤：纯素排除蛋奶/肉，蛋奶素排除肉海鲜', () => {
  const tofu = dish({
    name: '家常豆腐',
    tags: ['vegan', 'vegetable'],
    ingredients: [{ name: '豆腐', amount: 300, unit: 'g' }],
  })
  const egg = dish({
    name: '番茄炒蛋',
    tags: ['vegetable'],
    ingredients: [{ name: '鸡蛋', amount: 2, unit: '个' }, { name: '番茄', amount: 2, unit: '个' }],
  })
  const meat = dish({ name: '红烧肉', tags: ['meat'] })

  assert.equal(phaseHardEligible(tofu, 'plant_based', 'vegan'), true)
  assert.equal(phaseHardEligible(egg, 'plant_based', 'vegan'), false)
  assert.equal(phaseHardEligible(egg, 'plant_based', 'lacto_ovo'), true)
  assert.equal(phaseHardEligible(meat, 'plant_based', 'lacto_ovo'), false)
  // 非 plant_based 不做硬过滤
  assert.equal(phaseHardEligible(meat, 'performance'), true)
})
