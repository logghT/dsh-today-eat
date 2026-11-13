/**
 * src/core/chain-menu.js 单元测试：连锁识别 / 真实菜单建议 / 小店不编造。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHAIN_BRAND_COUNT,
  CHAIN_BRANDS,
  buildOrderSuggestion,
  matchChainBrand,
} from '../../src/core/chain-menu.js'

test('连锁品牌：识别门店后缀 / 英文别名 / 子品牌', () => {
  assert.equal(matchChainBrand('海底捞火锅(成都万达店)').brand.brand, '海底捞')
  assert.equal(matchChainBrand('麦当劳（雨城店）').brand.brand, '麦当劳')
  assert.equal(matchChainBrand('KFC 成都店').brand.brand, '肯德基')
  assert.equal(matchChainBrand('太二酸菜鱼·万达店').brand.brand, '太二酸菜鱼')
  assert.equal(matchChainBrand('曹记美味特色面馆'), null)
  assert.equal(matchChainBrand(''), null)
})

test('连锁品牌：训练补给给公开菜单单品 + 更轻的选法', () => {
  const suggestion = buildOrderSuggestion('海底捞火锅(成都万达店)', 'performance')
  assert.equal(suggestion.kind, 'chain')
  assert.equal(suggestion.brand, '海底捞')
  assert.match(suggestion.text, /捞派毛肚/)
  assert.match(suggestion.text, /训练补给优先/)
  assert.match(suggestion.text, /清汤锅/)
  assert.match(suggestion.text, /以门店为准/)
})

test('连锁品牌：非训练阶段按招牌点，但仍带免责声明', () => {
  const treat = buildOrderSuggestion('老乡鸡', 'treat')
  assert.equal(treat.kind, 'chain')
  assert.match(treat.text, /肥西老母鸡汤/)
  assert.match(treat.text, /按招牌点/)
  assert.match(treat.text, /菜单可能调整/)

  // 旧 relax / indulgence 仍可识别，统一迁移到「吃的高兴」
  const legacy = buildOrderSuggestion('麦当劳', 'indulgence')
  assert.equal(legacy.kind, 'chain')
  assert.match(legacy.text, /巨无霸/)
  assert.match(legacy.text, /按招牌点/)
})

test('查不到公开菜单的小店：明确让顾客自行点，不编具体菜名', () => {
  const suggestion = buildOrderSuggestion('曹记美味特色面馆', 'fitness')
  assert.equal(suggestion.kind, 'unknown')
  assert.equal(suggestion.brand, null)
  assert.match(suggestion.text, /查不到公开菜单/)
  assert.match(suggestion.text, /看菜单|问老板/)
  assert.match(suggestion.text, /不替你编/)
  // 不得出现任何知识库单品，避免误伤小店
  for (const brand of CHAIN_BRANDS) {
    for (const dish of brand.items) {
      assert.ok(!suggestion.text.includes(dish), `小店建议不应出现「${dish}」`)
    }
  }
})

test('知识库数据质量：品牌数、别名、单品、健身搭配都齐全且不重复', () => {
  assert.equal(CHAIN_BRANDS.length, CHAIN_BRAND_COUNT)
  const names = new Set()
  for (const brand of CHAIN_BRANDS) {
    assert.ok(brand.brand.length >= 2)
    assert.ok(brand.aliases.includes(brand.brand))
    assert.ok(brand.items.length >= 2)
    assert.ok(brand.fit.length >= 2)
    assert.ok(!names.has(brand.brand), `品牌重复：${brand.brand}`)
    names.add(brand.brand)
    for (const alias of brand.aliases) assert.ok(alias.trim() !== '')
  }
})
