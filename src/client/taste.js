/**
 * 「今天吃什么」client 半 —— 六维味道适配层（酸 / 甜 / 苦 / 辣 / 咸 / 鲜）。
 *
 * 契约：docs/taste-v1.md。核心算法在 src/core/taste.js（host/client 共用），
 * 本文件只做三件事（不重复实现算法）：
 * 1) 复用 core 的 TASTE_DIMENSIONS / TASTE_LABELS，补设置页中文 hint；
 * 2) 给 core 输出做展示态归一化（补键 / clamp / 1 位小数 / 中文 summary）；
 * 3) 提供设置页草稿与记录页画像所需的纯函数（createTasteDraft / applyTasteValue / buildSettingsTasteRows / buildTasteProfile）。
 */

import {
  TASTE_DIMENSIONS,
  TASTE_LABELS,
  dishTasteOf as coreDishTasteOf,
  normalizeTaste as coreNormalizeTaste,
  summarizeTaste as coreSummarizeTaste,
  tastePreferenceOf as coreTastePreferenceOf,
} from '../../src/core/taste.js'

export { TASTE_DIMENSIONS, TASTE_LABELS }

/** 设置页每个维度的中文 hint（契约 §5）。 */
export const TASTE_HINTS = Object.freeze({
  sour: '酸（柠檬/醋/酸汤）',
  sweet: '甜（糖/蜜/甜口）',
  bitter: '苦（苦瓜/苦荞/茶）',
  spicy: '辣（辣椒/花椒）',
  salty: '咸（腌制/卤味）',
  umami: '鲜（菌菇/海鲜/高汤）',
})

/** 六维默认值（与 core / host 默认档案一致）。 */
export const DEFAULT_TASTE = Object.freeze({ sour: 3, sweet: 2, bitter: 1, spicy: 3, salty: 2, umami: 3 })

/** 非味道偏好（油腻接受度 / 尝鲜意愿）保留项的 hint。 */
export const OTHER_TASTE_HINTS = Object.freeze({
  oiliness: '越高越能接受重油 / 油炸，推荐会按这个减分',
  adventurous: '越高越愿意尝试没吃过的菜系和新菜',
})

/**
 * 数值兜底到 0–5 并保留 1 位小数。
 *
 * @param {unknown} value 值
 * @param {number} fallback 兜底
 * @returns {number} 数字
 */
function numberOr(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(5, Math.max(0, Math.round(number * 10) / 10))
}

/**
 * 六维对象归一化（补齐缺省键、clamp 0–5、保留 1 位小数）。
 *
 * @param {unknown} input 六维对象
 * @returns {{ sour: number, sweet: number, bitter: number, spicy: number, salty: number, umami: number }} 六维
 */
export function coerceTaste(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const result = {}
  for (const id of TASTE_DIMENSIONS) result[id] = numberOr(source[id], DEFAULT_TASTE[id] ?? 3)
  return result
}

/**
 * 归一化味道偏好（core 实现，含旧字段迁移：sourFruit/sourFermented/sourVinegar/spicy/sweet）。
 *
 * @param {unknown} input profile.taste 或旧 taste 对象
 * @returns {{ sour: number, sweet: number, bitter: number, spicy: number, salty: number, umami: number }} 六维
 */
export function normalizeTaste(input) {
  return coerceTaste(coreNormalizeTaste(input))
}

/**
 * 取档案的味道偏好（六维）。
 *
 * @param {unknown} profile 档案
 * @returns {ReturnType<typeof normalizeTaste>} 六维
 */
export function tastePreferenceOf(profile) {
  return coerceTaste(coreTastePreferenceOf(profile))
}

/**
 * 菜品六维味道（core 规则，1–5）。
 *
 * @param {object | null | undefined} dish 菜品
 * @returns {{ sour: number, sweet: number, bitter: number, spicy: number, salty: number, umami: number }} 六维
 */
export function dishTasteOf(dish) {
  const source = dish !== null && typeof dish === 'object' ? dish : {}
  const result = {}
  const raw = coreDishTasteOf(source)
  for (const id of TASTE_DIMENSIONS) {
    const number = Number(raw !== null && typeof raw === 'object' ? raw[id] : NaN)
    result[id] = Number.isFinite(number) ? Math.min(5, Math.max(1, Math.round(number))) : 2
  }
  return result
}

/* ────────────────────────────── 设置页六滑块 ────────────────────────────── */

/**
 * 创建设置页可编辑的味道草稿（六维 + 油腻接受度 + 尝鲜意愿）。
 *
 * @param {unknown} profile 档案（或 profile.taste）
 * @returns {{ sour: number, sweet: number, bitter: number, spicy: number, salty: number, umami: number, oiliness: number, adventurous: number }} 草稿
 */
export function createTasteDraft(profile) {
  const source = profile !== null && typeof profile === 'object' ? profile : {}
  const tasteSource = source.taste !== null && typeof source.taste === 'object' ? source.taste : source
  return {
    ...normalizeTaste(tasteSource),
    oiliness: numberOr(tasteSource.oiliness, 2),
    adventurous: numberOr(tasteSource.adventurous, 4),
  }
}

/**
 * 修改某个味道维度的值（0–5），返回可直接写回 profile.taste 的六维对象。
 *
 * @param {unknown} taste 当前六维（可含 oiliness / adventurous）
 * @param {string} id 维度 id
 * @param {number} value 新值
 * @returns {object} 六维（含非味道偏好）
 */
export function applyTasteValue(taste, id, value) {
  const source = taste !== null && typeof taste === 'object' ? taste : {}
  const next = { ...normalizeTaste(source), [id]: numberOr(value, DEFAULT_TASTE[id] ?? 3) }
  next.oiliness = numberOr(source.oiliness, 2)
  next.adventurous = numberOr(source.adventurous, 4)
  return next
}

/**
 * 设置页六行滑动条的展示模型。
 *
 * @param {unknown} taste 当前六维
 * @returns {Array<{ id: string, label: string, hint: string, value: number }>} 六行
 */
export function buildSettingsTasteRows(taste) {
  const normalized = normalizeTaste(taste)
  return TASTE_DIMENSIONS.map((id) => ({
    id,
    label: TASTE_LABELS[id] ?? id,
    hint: TASTE_HINTS[id] ?? '',
    value: normalized[id],
  }))
}

/* ────────────────────────────── 记录页口味画像 ────────────────────────────── */

/**
 * 数值保留 1 位小数。
 *
 * @param {number} value 值
 * @returns {number} 值
 */
function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * 生成中文 summary：`偏爱：酸、辣、鲜`（无记录时用「偏好设置：」）。
 *
 * @param {Array<{ id: string, label: string, value: number }>} dimensions 六维
 * @param {number} samples 样本数
 * @returns {string} summary
 */
export function buildTasteSummary(dimensions, samples) {
  const list = Array.isArray(dimensions) ? dimensions : []
  const high = list.filter((item) => item.value >= 4).slice(0, 3)
  const prefix = samples > 0 ? '偏爱' : '偏好设置'
  if (high.length >= 2) return `${prefix}：${high.map((item) => item.label).join('、')}`
  const sorted = [...list].sort((left, right) => right.value - left.value).slice(0, 2)
  if (sorted.length > 0 && sorted[0].value >= 3) return `${prefix}：${sorted.map((item) => item.label).join('、')}`
  return '口味均衡'
}

/**
 * 归一化 core.summarizeTaste 的结果（补齐六维、标签、1 位小数）。
 *
 * @param {object} result core 结果
 * @param {object} profile 档案
 * @returns {{ samples: number, dimensions: Array<object>, topTastes: string[], summary: string }} 归一化结果
 */
function normalizeTasteStats(result, profile) {
  const source = result !== null && typeof result === 'object' ? result : {}
  const preference = tastePreferenceOf(profile)
  const byId = new Map()
  if (Array.isArray(source.dimensions)) {
    for (const item of source.dimensions) {
      if (item !== null && typeof item === 'object' && typeof item.id === 'string') byId.set(item.id, item)
    }
  }
  const dimensions = TASTE_DIMENSIONS.map((id) => {
    const found = byId.get(id)
    const rawValue = found !== undefined && typeof found.value === 'number' && Number.isFinite(found.value) ? found.value : preference[id]
    return {
      id,
      label: TASTE_LABELS[id] ?? id,
      value: round1(Math.min(5, Math.max(0, rawValue ?? 0))),
      liked: found !== undefined && typeof found.liked === 'number' ? found.liked : 0,
      disliked: found !== undefined && typeof found.disliked === 'number' ? found.disliked : 0,
    }
  })
  const samples = typeof source.samples === 'number' && Number.isFinite(source.samples) ? source.samples : 0
  // summary 统一用 client 口径重算：无记录显示「偏好设置：…」，有记录显示「偏爱：… / 口味均衡」
  const summary = buildTasteSummary(dimensions, samples)
  const topTastes = Array.isArray(source.topTastes) && source.topTastes.length > 0
    ? source.topTastes.filter((id) => typeof id === 'string')
    : [...dimensions].sort((left, right) => right.value - left.value).filter((item) => item.value >= 4).slice(0, 3).map((item) => item.id)
  return { samples, dimensions, topTastes, summary }
}

/**
 * 记录页口味画像统计（core.summarizeTaste：rating=1 权重 1.5 / -1 权重 0.5 / 其余 1）。
 *
 * @param {Array<object>} meals 用餐记录
 * @param {Array<object>} catalog 菜品库
 * @param {object} profile 档案
 * @returns {{ samples: number, dimensions: Array<{ id: string, label: string, value: number, liked: number, disliked: number }>, topTastes: string[], summary: string }} 统计
 */
export function summarizeTaste(meals, catalog, profile) {
  return normalizeTasteStats(coreSummarizeTaste(meals, catalog, profile), profile)
}

/**
 * 记录页口味画像的展示模型（区分「统计」与「偏好设置」两种态）。
 *
 * @param {Array<object>} meals 用餐记录
 * @param {Array<object>} catalog 菜品库
 * @param {object} profile 档案
 * @returns {{ samples: number, dimensions: Array<object>, summary: string, mode: 'stats' | 'preference' }} 画像
 */
export function buildTasteProfile(meals, catalog, profile) {
  const result = summarizeTaste(meals, catalog, profile)
  return {
    samples: result.samples,
    dimensions: result.dimensions,
    summary: result.summary,
    mode: result.samples > 0 ? 'stats' : 'preference',
  }
}
