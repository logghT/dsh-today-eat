import assert from 'node:assert/strict'
import { test } from 'node:test'

import { REFERENCE_SITES, referenceLinksOf } from '../../src/core/reference.js'

test('reference：空菜名返回空数组，非字符串/空白同样为空', () => {
  assert.deepEqual(referenceLinksOf(''), [])
  assert.deepEqual(referenceLinksOf('   '), [])
  assert.deepEqual(referenceLinksOf(null), [])
  assert.deepEqual(referenceLinksOf(undefined), [])
  assert.deepEqual(referenceLinksOf(42), [])
})

test('reference：返回下厨房 / 抖音 / B站 / 小红书四个链接，并正确 URL 编码', () => {
  const links = referenceLinksOf('番茄酸汤鱼片')
  assert.equal(links.length, 4)
  assert.deepEqual(links.map((link) => link.id), ['xiachufang', 'douyin', 'bilibili', 'xiaohongshu'])
  assert.ok(links.every((link) => link.label.length > 0 && link.hint.length > 0))
  const encoded = encodeURIComponent('番茄酸汤鱼片')
  for (const link of links) {
    assert.ok(link.url.includes(encoded), `${link.id} 应包含编码后的菜名：${link.url}`)
    assert.ok(link.url.startsWith('https://'), '只使用 https 链接')
    assert.ok(!link.url.includes(' '), 'URL 不应含空格')
  }
})

test('reference：中文 / 英文 / 空格菜名都不会产生非法 URL', () => {
  for (const name of ['蛋炒饭', 'Tom Yum Goong', '酸 辣 面']) {
    const links = referenceLinksOf(name)
    for (const link of links) {
      assert.ok(link.url.startsWith('https://'))
      const url = new URL(link.url)
      const queryKeyword = url.searchParams.get('keyword')
      const pathKeyword = decodeURIComponent(url.pathname)
      assert.ok(
        queryKeyword === name || pathKeyword.includes(name),
        `query/path 应原样保留菜名：${link.url}`,
      )
    }
  }
})

test('reference：站点清单顺序与展示顺序一致', () => {
  assert.deepEqual(REFERENCE_SITES.map((site) => site.label), ['下厨房', '抖音', 'B站', '小红书'])
})
