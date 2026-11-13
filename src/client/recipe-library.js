/**
 * 「今天吃什么」client 半 —— 菜谱库数据与检索（纯函数）。
 *
 * 菜谱数据来自 data/recipes.js（由 menu-data 维护，字段结构见 docs/recipe-library.md §1）；
 * 菜系 / 标签 / 分类从 data/dishes.js 关联，用于筛选与卡片展示。
 * 外部参考链接复用 src/core/reference.js 的 referenceLinksOf。
 *
 * 所有函数纯同步、无副作用，页面只负责渲染（便于烟测直接测数据层）。
 */

import { referenceLinksOf } from '../core/reference.js'
import { userRecipeList } from '../core/user-recipes.js'
import { DISHES } from '../../data/dishes.js'
import { RECIPES } from './recipes.js'

export { referenceLinksOf }

/* ────────────────────────────── 筛选定义 ────────────────────────────── */

/** 场景筛选 chips（地区维度单独一行；云南 / 各菜系见 RECIPE_REGIONS）。 */
export const RECIPE_FILTERS = Object.freeze([
  { id: 'all', label: '全部', hint: '全部菜谱' },
  { id: 'quick', label: '快手 ≤20 分钟', hint: '备料 + 烹饪 ≤ 20 分钟' },
  { id: 'highProtein', label: '高蛋白 ≥25g', hint: '每份蛋白 ≥ 25g' },
  { id: 'soup', label: '汤羹', hint: '汤羹类' },
  { id: 'veg', label: '素菜', hint: '素食标签' },
])

/* ────────────────────────────── 三维分类（国家 / 菜系 / 省份） ────────────────────────────── */

/** 中国（国内菜系的 country 值）。 */
export const CHINA_COUNTRY = '中国'

/** 标准省级行政区（省份 select / 分组顺序）。 */
export const CHINA_PROVINCES = Object.freeze([
  '云南', '四川', '重庆', '贵州', '广西', '广东', '湖南', '湖北', '河南', '河北',
  '山东', '山西', '陕西', '甘肃', '青海', '宁夏', '新疆', '西藏', '内蒙古', '辽宁',
  '吉林', '黑龙江', '北京', '天津', '上海', '江苏', '浙江', '安徽', '福建', '江西',
  '海南', '台湾', '香港', '澳门',
])

/** 11 个菜系（云南菜单独成类；顺序即 chip / 分组顺序）。 */
export const RECIPE_CUISINES = Object.freeze(['云南菜', '川菜', '粤菜', '湘菜', '江浙', '北方', '西北', '西南', '日韩', '西式', '快餐'])

/** 国家展示顺序：中国优先，其余按契约示例 + 海外地区。 */
export const COUNTRY_ORDER = Object.freeze([
  '中国', '日本', '韩国', '泰国', '越南', '印度', '美国', '意大利', '法国', '墨西哥',
  '西班牙', '英国', '土耳其', '德国', '俄罗斯', '巴西', '挪威', '比利时', '希腊', '北欧', '地中海',
])

/** 省份分组兜底：中国菜但缺省份。 */
export const PROVINCE_OTHER = Object.freeze({ id: 'other', label: '其他' })

/** 省份分组兜底：国外菜（province 为 null）。 */
export const OVERSEAS_PROVINCE = Object.freeze({ id: 'overseas', label: '海外' })

/** origins 中的城市 / 地区 → 省级行政区。 */
const PROVINCE_ALIASES = Object.freeze({
  雅安: '四川', 乐山: '四川', 成都: '四川', 绵阳: '四川', 自贡: '四川',
  昆明: '云南', 大理: '云南', 丽江: '云南', 西双版纳: '云南', 腾冲: '云南',
  广州: '广东', 潮汕: '广东', 顺德: '广东', 深圳: '广东',
  杭州: '浙江', 宁波: '浙江', 绍兴: '浙江',
  苏州: '江苏', 南京: '江苏', 扬州: '江苏', 无锡: '江苏',
  西安: '陕西', 延安: '陕西',
  兰州: '甘肃', 敦煌: '甘肃',
  乌鲁木齐: '新疆', 喀什: '新疆', 伊犁: '新疆',
  拉萨: '西藏', 林芝: '西藏',
  哈尔滨: '黑龙江', 齐齐哈尔: '黑龙江',
  沈阳: '辽宁', 大连: '辽宁', 丹东: '辽宁',
  长春: '吉林', 延边: '吉林',
  呼和浩特: '内蒙古', 呼伦贝尔: '内蒙古',
  银川: '宁夏', 吴忠: '宁夏',
  西宁: '青海', 海东: '青海',
  太原: '山西', 大同: '山西', 平遥: '山西',
  济南: '山东', 青岛: '山东', 烟台: '山东', 淄博: '山东',
  郑州: '河南', 洛阳: '河南', 开封: '河南',
  武汉: '湖北', 宜昌: '湖北',
  长沙: '湖南', 湘西: '湖南', 张家界: '湖南',
  合肥: '安徽', 黄山: '安徽', 徽州: '安徽',
  福州: '福建', 厦门: '福建', 泉州: '福建', 沙县: '福建',
  南昌: '江西', 景德镇: '江西', 赣州: '江西',
  南宁: '广西', 桂林: '广西', 柳州: '广西',
  海口: '海南', 三亚: '海南',
  贵阳: '贵州', 遵义: '贵州', 黔东南: '贵州',
})

/** origins 中的泛地域 → 省级行政区（契约 §1 映射规则）。 */
const PROVINCE_UMBRELLA = Object.freeze({
  北方: '山东', 江浙: '江苏', 西南: '云南', 东北: '辽宁', 西北: '陕西', 华南: '广东', 华东: '江苏', 华中: '湖北',
})

/** origins 中出现的国家关键字（含数据里已有的海外地区写法）。 */
const COUNTRY_KEYWORDS = Object.freeze([
  '中国', '日本', '韩国', '泰国', '越南', '印度', '美国', '意大利', '法国', '墨西哥',
  '西班牙', '英国', '土耳其', '德国', '俄罗斯', '巴西', '挪威', '比利时', '希腊', '北欧', '地中海',
  '新加坡', '马来西亚', '印尼', '菲律宾', '澳大利亚', '加拿大',
])

/**
 * 菜系中文标签（未知菜系给原值 / 其他）。
 *
 * @param {unknown} cuisine 菜系
 * @returns {string} 标签
 */
export function cuisineLabelOf(cuisine) {
  if (typeof cuisine !== 'string' || cuisine === '') return '其他'
  return RECIPE_CUISINES.includes(cuisine) ? cuisine : cuisine
}

/**
 * 解析菜品国家（优先 dish.country；否则 origins；否则按菜系兜底，兼容旧数据）。
 *
 * @param {object | null | undefined} dish 菜品
 * @returns {string} 国家
 */
export function countryOfDish(dish) {
  if (dish === null || typeof dish !== 'object') return CHINA_COUNTRY
  if (typeof dish.country === 'string' && dish.country.trim() !== '') return dish.country.trim()
  const origins = stringList(dish.origins)
  for (const origin of origins) {
    if (origin === CHINA_COUNTRY) return CHINA_COUNTRY
    if (COUNTRY_KEYWORDS.includes(origin)) return origin
    if (CHINA_PROVINCES.includes(origin) || PROVINCE_ALIASES[origin] !== undefined || PROVINCE_UMBRELLA[origin] !== undefined) return CHINA_COUNTRY
  }
  // 未识别的 origins 当作国家标签（例如数据里的「北欧」等写法）
  for (const origin of origins) {
    if (!CHINA_PROVINCES.includes(origin) && PROVINCE_ALIASES[origin] === undefined && PROVINCE_UMBRELLA[origin] === undefined) return origin
  }
  // 完全没有 origins 的旧数据：按菜系兜底
  if (dish.cuisine === '日韩') return '日本'
  if (dish.cuisine === '西式') return '美国'
  return CHINA_COUNTRY
}

/**
 * 解析菜品省份（优先 dish.province；仅中国菜；否则用 origins 城市/省份/泛地域兜底）。
 *
 * @param {object | null | undefined} dish 菜品
 * @param {string} [country] 已解析的国家
 * @returns {string | null} 省级行政区
 */
export function provinceOfDish(dish, country = countryOfDish(dish)) {
  if (country !== CHINA_COUNTRY) return null
  if (dish === null || typeof dish !== 'object') return null
  if (typeof dish.province === 'string' && dish.province.trim() !== '') {
    const value = dish.province.trim()
    return value === '其他' ? null : value
  }
  const origins = stringList(dish.origins)
  for (const origin of origins) {
    if (CHINA_PROVINCES.includes(origin)) return origin
    if (PROVINCE_ALIASES[origin] !== undefined) return PROVINCE_ALIASES[origin]
    if (PROVINCE_UMBRELLA[origin] !== undefined) return PROVINCE_UMBRELLA[origin]
  }
  return null
}

/** dishId -> dish。 */
const DISH_MAP = new Map(
  (Array.isArray(DISHES) ? DISHES : [])
    .filter((dish) => dish !== null && typeof dish === 'object' && typeof dish.id === 'string')
    .map((dish) => [dish.id, dish]),
)

/**
 * 数字兜底。
 *
 * @param {unknown} value 值
 * @param {number} fallback 兜底
 * @returns {number} 数字
 */
function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * 字符串数组兜底。
 *
 * @param {unknown} value 值
 * @returns {string[]} 字符串数组
 */
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
}

/**
 * 单条菜谱的总时长（备料 + 烹饪，分钟）。
 *
 * @param {object | null | undefined} recipe 菜谱（或菜谱库条目）
 * @returns {number} 分钟
 */
export function totalMinutes(recipe) {
  if (recipe === null || typeof recipe !== 'object') return 0
  return Math.max(0, numberOr(recipe.prepMin, 0) + numberOr(recipe.cookMin, 0))
}

/**
 * 主要食材前 N 个（默认 3）。
 *
 * @param {object | null | undefined} recipe 菜谱
 * @param {number} [count=3] 数量
 * @returns {string[]} 食材名
 */
export function primaryIngredients(recipe, count = 3) {
  const ingredients = recipe !== null && typeof recipe === 'object' && Array.isArray(recipe.ingredients) ? recipe.ingredients : []
  return ingredients
    .filter((item) => item !== null && typeof item === 'object' && typeof item.name === 'string' && item.name !== '')
    .slice(0, Math.max(1, count))
    .map((item) => item.name)
}

/**
 * 菜谱食材按 group 分组（保持首次出现顺序）。
 *
 * @param {object | null | undefined} recipe 菜谱
 * @returns {Array<{ group: string, items: Array<object> }>} 分组
 */
export function groupRecipeIngredients(recipe) {
  const ingredients = recipe !== null && typeof recipe === 'object' && Array.isArray(recipe.ingredients) ? recipe.ingredients : []
  const groups = new Map()
  for (const item of ingredients) {
    if (item === null || typeof item !== 'object' || typeof item.name !== 'string') continue
    const group = typeof item.group === 'string' && item.group !== '' ? item.group : '其他'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(item)
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
}

/* ────────────────────────────── 条目构建 ────────────────────────────── */

/**
 * 把菜谱 + 菜品信息合并成菜谱库条目。
 *
 * @param {object} recipe 菜谱
 * @returns {object} 条目
 */
function buildEntry(recipe) {
  const dish = DISH_MAP.get(recipe.dishId) ?? DISH_MAP.get(recipe.id) ?? null
  const tags = stringList(dish === null ? recipe.tags : dish.tags)
  const origins = stringList(dish === null ? recipe.origins : dish.origins)
  const cuisine = dish !== null && typeof dish.cuisine === 'string'
    ? dish.cuisine
    : typeof recipe.cuisine === 'string' ? recipe.cuisine : ''
  const category = dish !== null && typeof dish.category === 'string'
    ? dish.category
    : typeof recipe.category === 'string' ? recipe.category : ''
  const country = dish !== null
    ? countryOfDish(dish)
    : typeof recipe.country === 'string' && recipe.country !== '' ? recipe.country : CHINA_COUNTRY
  const province = dish !== null
    ? provinceOfDish(dish, country)
    : country === CHINA_COUNTRY && typeof recipe.province === 'string' && recipe.province !== ''
      ? recipe.province
      : null
  const cuisineLabel = cuisineLabelOf(cuisine)
  const ingredientNames = primaryIngredients(recipe, 100)
  const name = typeof recipe.name === 'string' && recipe.name !== '' ? recipe.name : String(recipe.id)
  const searchText = [name, country, province ?? '', cuisineLabel, category, ...ingredientNames, ...tags, ...origins]
    .join(' ')
    .toLowerCase()
  return {
    id: recipe.id,
    dishId: typeof recipe.dishId === 'string' ? recipe.dishId : recipe.id,
    name,
    country,
    province,
    cuisine,
    cuisineLabel,
    category,
    tags,
    origins,
    difficulty: typeof recipe.difficulty === 'string' ? recipe.difficulty : '—',
    prepMin: Math.max(0, numberOr(recipe.prepMin, 0)),
    cookMin: Math.max(0, numberOr(recipe.cookMin, 0)),
    minutes: totalMinutes(recipe),
    kcal: Math.max(0, Math.round(numberOr(recipe.kcal, 0))),
    protein: Math.max(0, Math.round(numberOr(recipe.protein, 0))),
    servings: Math.max(1, Math.round(numberOr(recipe.servings, 1))),
    ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
    steps: stringList(recipe.steps),
    tips: stringList(recipe.tips),
    primaryIngredients: primaryIngredients(recipe, 3),
    custom: dish === null,
    searchText,
  }
}

/** 菜谱库条目（构建期把全部菜谱与菜品信息关联好）。 */
export const RECIPE_ENTRIES = Object.freeze(RECIPES.map(buildEntry))

/** 内置菜谱总数（我的菜谱不计入「菜谱库 · N 道」的「N」中，页面会分开显示）。 */
export const RECIPE_COUNT = RECIPE_ENTRIES.length

/**
 * 把用户自建菜谱转成菜谱库条目。
 *
 * @param {unknown} userRecipes `state.userRecipes`（对象 map）
 * @returns {Array<object>} 条目列表（最新在前）
 */
export function buildUserRecipeEntries(userRecipes) {
  return userRecipeList(userRecipes).map(buildEntry)
}

/**
 * 合并「内置菜谱 + 我的菜谱」：我的菜谱排在前面，便于在列表里看到。
 *
 * @param {unknown} userRecipes `state.userRecipes`
 * @returns {Array<object>} 条目列表
 */
export function mergeRecipeEntries(userRecipes) {
  const custom = buildUserRecipeEntries(userRecipes)
  if (custom.length === 0) return RECIPE_ENTRIES
  return custom.concat(RECIPE_ENTRIES)
}

/* ────────────────────────────── 搜索 / 筛选 ────────────────────────────── */

/**
 * 按关键词搜索（菜名 / 食材 / 菜系 / 分类 / 标签，大小写不敏感）。
 *
 * @param {Array<object>} entries 条目
 * @param {string} query 关键词
 * @returns {Array<object>} 结果
 */
export function searchRecipes(entries, query) {
  const list = Array.isArray(entries) ? entries : []
  const keyword = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (keyword === '') return list
  return list.filter((entry) => typeof entry.searchText === 'string' && entry.searchText.includes(keyword))
}

/**
 * 按场景筛选 id 过滤（内部；对外统一走 filterRecipes）。
 *
 * @param {Array<object>} entries 条目
 * @param {string} sceneId 场景 id
 * @returns {Array<object>} 结果
 */
function filterByScene(entries, sceneId) {
  switch (sceneId) {
    case 'quick':
      return entries.filter((entry) => entry.minutes <= 20)
    case 'highProtein':
      return entries.filter((entry) => entry.protein >= 25)
    case 'yunnan':
      return entries.filter(
        (entry) => entry.origins.includes('云南')
          || entry.cuisine.includes('云南')
          || entry.tags.includes('云南')
          || /云南|傣味|滇味/.test(entry.name),
      )
    case 'sichuan':
      return entries.filter(
        (entry) => entry.cuisine === '川菜'
          || entry.origins.includes('四川')
          || entry.origins.includes('川味')
          || /川菜|麻辣|水煮|回锅/.test(entry.name),
      )
    case 'soup':
      return entries.filter((entry) => entry.category === '汤羹' || entry.tags.includes('soup'))
    case 'veg':
      return entries.filter((entry) => entry.tags.includes('veg'))
    case 'mine':
      return entries.filter((entry) => entry.custom === true)
    case 'all':
    default:
      return entries
  }
}

/**
 * 组合筛选：搜索 + 场景 + 国家 + 菜系 + 省份（三维可任意组合）。
 *
 * 兼容旧签名 `filterRecipes(entries, 'quick')`（只按场景过滤）。
 *
 * @param {Array<object>} entries 条目
 * @param {{ query?: string, scene?: string, filter?: string, country?: string, cuisine?: string, province?: string } | string} [options] 条件
 * @returns {Array<object>} 结果
 */
export function filterRecipes(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  if (typeof options === 'string') return filterByScene(list, options)
  const source = options !== null && typeof options === 'object' ? options : {}
  const scene = typeof source.scene === 'string' ? source.scene : typeof source.filter === 'string' ? source.filter : 'all'
  const query = typeof source.query === 'string' ? source.query : ''
  const country = typeof source.country === 'string' && source.country !== '' ? source.country : 'all'
  const cuisine = typeof source.cuisine === 'string' && source.cuisine !== '' ? source.cuisine : 'all'
  const province = typeof source.province === 'string' && source.province !== '' ? source.province : 'all'
  let result = searchRecipes(filterByScene(list, scene), query)
  if (country !== 'all') result = result.filter((entry) => entry.country === country)
  if (cuisine !== 'all') result = result.filter((entry) => entry.cuisine === cuisine)
  if (province !== 'all') result = result.filter((entry) => entry.country === CHINA_COUNTRY && entry.province === province)
  return result
}

/* ────────────────────────────── 地区（第二行筛选） ────────────────────────────── */

/**
 * 地区筛选定义（第二行 chips）：
 * - 全部地区：不过滤；
 * - 云南：用 dish.origins 含「云南」判定（cuisine 里的「西南」不能代表云南）；
 * - 其余：按菜系 cuisine 精确匹配。
 */
export const RECIPE_REGIONS = Object.freeze([
  { id: 'all', label: '全部地区', kind: 'all', hint: '不按地区过滤' },
  { id: 'yunnan', label: '云南', kind: 'origin', match: '云南', hint: '菜的 origins 含「云南」' },
  { id: 'sichuan', label: '川菜', kind: 'cuisine', match: '川菜', hint: '菜系 = 川菜' },
  { id: 'hunan', label: '湘菜', kind: 'cuisine', match: '湘菜', hint: '菜系 = 湘菜' },
  { id: 'cantonese', label: '粤菜', kind: 'cuisine', match: '粤菜', hint: '菜系 = 粤菜' },
  { id: 'jiangzhe', label: '江浙', kind: 'cuisine', match: '江浙', hint: '菜系 = 江浙' },
  { id: 'northern', label: '北方', kind: 'cuisine', match: '北方', hint: '菜系 = 北方' },
  { id: 'northwest', label: '西北', kind: 'cuisine', match: '西北', hint: '菜系 = 西北' },
  { id: 'southwest', label: '西南', kind: 'cuisine', match: '西南', hint: '菜系 = 西南' },
  { id: 'japanese-korean', label: '日韩', kind: 'cuisine', match: '日韩', hint: '菜系 = 日韩' },
  { id: 'western', label: '西式', kind: 'cuisine', match: '西式', hint: '菜系 = 西式' },
  { id: 'fastfood', label: '快餐', kind: 'cuisine', match: '快餐', hint: '菜系 = 快餐' },
])

/** 全部地区时的小组顺序（云南优先，其余按菜系枚举顺序）。 */
export const RECIPE_REGION_GROUPS = Object.freeze(RECIPE_REGIONS.filter((region) => region.kind !== 'all'))

/** 未匹配到任何地区的兜底分组。 */
export const OTHER_REGION = Object.freeze({ id: 'other', label: '其他', kind: 'other' })

/**
 * 按 id 取地区定义。
 *
 * @param {string} id 地区 id
 * @returns {object | null} 定义
 */
export function regionMetaOf(id) {
  if (typeof id !== 'string' || id === '') return null
  if (id === OTHER_REGION.id) return OTHER_REGION
  return RECIPE_REGIONS.find((region) => region.id === id) ?? null
}

/**
 * 地区中文名。
 *
 * @param {string} id 地区 id
 * @returns {string} 文案
 */
export function regionLabelOf(id) {
  const meta = regionMetaOf(id)
  return meta === null ? '全部地区' : meta.label
}

/**
 * 判断条目是否属于某地区。
 *
 * @param {object} entry 菜谱条目
 * @param {string} regionId 地区 id（'all' / undefined 表示不过滤）
 * @returns {boolean} 是否匹配
 */
export function matchesRegion(entry, regionId) {
  if (entry === null || typeof entry !== 'object') return false
  if (regionId === undefined || regionId === null || regionId === '' || regionId === 'all') return true
  const meta = regionMetaOf(regionId)
  if (meta === null || meta.kind === 'all') return true
  if (meta.kind === 'origin') return Array.isArray(entry.origins) && entry.origins.includes(meta.match)
  if (meta.kind === 'cuisine') return entry.cuisine === meta.match
  return false
}

/**
 * 条目的主地区（用于「全部地区」时分组；云南优先，保证每条只进一个组）。
 *
 * @param {object} entry 菜谱条目
 * @returns {string} 地区 id
 */
export function primaryRegionOf(entry) {
  if (entry === null || typeof entry !== 'object') return OTHER_REGION.id
  if (Array.isArray(entry.origins) && entry.origins.includes('云南')) return 'yunnan'
  const cuisineRegion = RECIPE_REGION_GROUPS.find((region) => region.kind === 'cuisine' && region.match === entry.cuisine)
  return cuisineRegion === undefined ? OTHER_REGION.id : cuisineRegion.id
}

/**
 * 按地区过滤。
 *
 * @param {Array<object>} entries 条目
 * @param {string} regionId 地区 id
 * @returns {Array<object>} 结果
 */
export function filterRecipesByRegion(entries, regionId) {
  const list = Array.isArray(entries) ? entries : []
  if (regionId === undefined || regionId === null || regionId === '' || regionId === 'all') return list
  return list.filter((entry) => matchesRegion(entry, regionId))
}

/**
 * 统计各地区数量（全部地区 = 总数；云南 = origins 含云南；其余 = 菜系精确匹配）。
 *
 * @param {Array<object>} entries 条目
 * @returns {Record<string, number>} 地区 id -> 数量
 */
export function countRecipesByRegion(entries) {
  const list = Array.isArray(entries) ? entries : []
  const counts = { all: list.length }
  for (const region of RECIPE_REGION_GROUPS) counts[region.id] = 0
  counts[OTHER_REGION.id] = 0
  for (const entry of list) {
    for (const region of RECIPE_REGION_GROUPS) {
      if (matchesRegion(entry, region.id)) counts[region.id] += 1
    }
    counts[OTHER_REGION.id] = primaryRegionOf(entry) === OTHER_REGION.id ? counts[OTHER_REGION.id] + 1 : counts[OTHER_REGION.id]
  }
  return counts
}

/**
 * 按地区分组（组顺序固定；空组跳过；每条只进主地区组）。
 *
 * @param {Array<object>} entries 条目
 * @returns {Array<{ id: string, label: string, entries: Array<object> }>} 分组
 */
export function groupRecipesByRegion(entries) {
  const list = Array.isArray(entries) ? entries : []
  const buckets = new Map()
  for (const region of RECIPE_REGION_GROUPS) buckets.set(region.id, [])
  buckets.set(OTHER_REGION.id, [])
  for (const entry of list) {
    const regionId = primaryRegionOf(entry)
    if (!buckets.has(regionId)) buckets.set(regionId, [])
    buckets.get(regionId).push(entry)
  }
  const groups = []
  for (const region of [...RECIPE_REGION_GROUPS, OTHER_REGION]) {
    const bucket = buckets.get(region.id) ?? []
    if (bucket.length > 0) groups.push({ id: region.id, label: region.label, entries: bucket })
  }
  return groups
}

/* ────────────────────────────── 国家 / 菜系 / 省份（三维分类） ────────────────────────────── */

/**
 * 菜品库中实际出现的国家列表（中国优先，其余按 COUNTRY_ORDER + 动态补充）。
 *
 * @param {Array<object>} entries 条目
 * @returns {string[]} 国家列表
 */
export function recipeCountriesOf(entries) {
  const present = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry !== null && typeof entry === 'object' && typeof entry.country === 'string' && entry.country !== '') present.add(entry.country)
  }
  const known = COUNTRY_ORDER.filter((country) => present.has(country))
  const extra = [...present].filter((country) => !COUNTRY_ORDER.includes(country)).sort((left, right) => left.localeCompare(right, 'zh'))
  return [...known, ...extra]
}

/**
 * 菜品库中实际出现的菜系列表（按 10 菜系顺序）。
 *
 * @param {Array<object>} entries 条目
 * @returns {string[]} 菜系列表
 */
export function recipeCuisinesOf(entries) {
  const present = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry !== null && typeof entry === 'object' && typeof entry.cuisine === 'string' && entry.cuisine !== '') present.add(entry.cuisine)
  }
  const known = RECIPE_CUISINES.filter((cuisine) => present.has(cuisine))
  const extra = [...present].filter((cuisine) => !RECIPE_CUISINES.includes(cuisine)).sort((left, right) => left.localeCompare(right, 'zh'))
  return [...known, ...extra]
}

/**
 * 中国菜中实际出现的省份列表（按标准省级行政区顺序）。
 *
 * @param {Array<object>} entries 条目
 * @returns {string[]} 省份列表
 */
export function recipeProvincesOf(entries) {
  const present = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry !== null && typeof entry === 'object' && entry.country === CHINA_COUNTRY && typeof entry.province === 'string' && entry.province !== '') {
      present.add(entry.province)
    }
  }
  return CHINA_PROVINCES.filter((province) => present.has(province))
}

/**
 * 按国家计数。
 *
 * @param {Array<object>} entries 条目
 * @returns {Record<string, number>} 国家 -> 数量
 */
export function countByCountry(entries) {
  const counts = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.country !== 'string' || entry.country === '') continue
    counts[entry.country] = (counts[entry.country] ?? 0) + 1
  }
  return counts
}

/**
 * 按菜系计数。
 *
 * @param {Array<object>} entries 条目
 * @returns {Record<string, number>} 菜系 -> 数量
 */
export function countByCuisine(entries) {
  const counts = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.cuisine !== 'string' || entry.cuisine === '') continue
    counts[entry.cuisine] = (counts[entry.cuisine] ?? 0) + 1
  }
  return counts
}

/**
 * 按省份计数（仅中国菜；国外菜不出现）。
 *
 * @param {Array<object>} entries 条目
 * @returns {Record<string, number>} 省份 -> 数量
 */
export function countByProvince(entries) {
  const counts = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object' || entry.country !== CHINA_COUNTRY) continue
    if (typeof entry.province !== 'string' || entry.province === '') continue
    counts[entry.province] = (counts[entry.province] ?? 0) + 1
  }
  return counts
}

/**
 * 按国家 / 菜系 / 省份分组（每条只进一个组；组顺序固定）。
 *
 * @param {Array<object>} entries 条目
 * @param {'country' | 'cuisine' | 'province'} [by='country'] 分组维度
 * @returns {Array<{ id: string, label: string, entries: Array<object> }>} 分组
 */
export function groupRecipes(entries, by = 'country') {
  const list = Array.isArray(entries) ? entries : []
  if (by === 'cuisine') {
    const buckets = new Map()
    for (const cuisine of recipeCuisinesOf(list)) buckets.set(cuisine, [])
    for (const entry of list) {
      const key = typeof entry.cuisine === 'string' && entry.cuisine !== '' ? entry.cuisine : '其他'
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(entry)
    }
    return [...buckets.entries()].filter(([, items]) => items.length > 0).map(([id, items]) => ({ id, label: cuisineLabelOf(id), entries: items }))
  }
  if (by === 'province') {
    const buckets = new Map()
    for (const province of CHINA_PROVINCES) buckets.set(province, [])
    buckets.set(PROVINCE_OTHER.id, [])
    buckets.set(OVERSEAS_PROVINCE.id, [])
    for (const entry of list) {
      const key = entry.country !== CHINA_COUNTRY
        ? OVERSEAS_PROVINCE.id
        : typeof entry.province === 'string' && entry.province !== ''
          ? entry.province
          : PROVINCE_OTHER.id
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(entry)
    }
    const order = [...CHINA_PROVINCES, PROVINCE_OTHER.id, OVERSEAS_PROVINCE.id]
    const groups = []
    for (const key of order) {
      const items = buckets.get(key) ?? []
      if (items.length === 0) continue
      const label = key === PROVINCE_OTHER.id ? PROVINCE_OTHER.label : key === OVERSEAS_PROVINCE.id ? OVERSEAS_PROVINCE.label : key
      groups.push({ id: key, label, entries: items })
    }
    return groups
  }
  // 默认按国家
  const order = recipeCountriesOf(list)
  const buckets = new Map(order.map((country) => [country, []]))
  for (const entry of list) {
    const key = typeof entry.country === 'string' && entry.country !== '' ? entry.country : '其他'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(entry)
  }
  return [...buckets.entries()].filter(([, items]) => items.length > 0).map(([id, items]) => ({ id, label: id, entries: items }))
}

/* ────────────────────────────── 页面视图 ────────────────────────────── */

/**
 * 组合搜索 + 场景 + 三维修剪（国家 / 菜系 / 省份）；兼容旧的 region 参数。
 *
 * @param {Array<object>} entries 条目
 * @param {{ query?: string, filter?: string, scene?: string, region?: string, country?: string, cuisine?: string, province?: string }} [options={}] 条件
 * @returns {Array<object>} 结果
 */
export function selectRecipes(entries, options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const result = filterRecipes(entries, {
    query: source.query,
    scene: typeof source.scene === 'string' ? source.scene : source.filter,
    country: source.country,
    cuisine: source.cuisine,
    province: source.province,
  })
  // 旧地区参数（地区行已迁移为三维筛选）：兼容旧调用
  if (typeof source.region === 'string' && source.region !== '' && source.region !== 'all') return filterRecipesByRegion(result, source.region)
  return result
}

/**
 * 页面展示模型：结果 + 三维计数 + 分组 + 当前筛选文案 + 空态标记。
 *
 * - 新 UI 传 `{ query, scene, country, cuisine, province, groupBy }`；
 * - 兼容旧的 `{ filter, region }` 调用（groupBy 未传且 region 存在时仍按旧地区分组）。
 *
 * @param {Array<object>} entries 条目
 * @param {object} [options={}] 条件
 * @returns {object} 视图
 */
export function buildRecipeLibraryView(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  const source = options !== null && typeof options === 'object' ? options : {}
  const query = typeof source.query === 'string' ? source.query : ''
  const scene = typeof source.scene === 'string' ? source.scene : typeof source.filter === 'string' ? source.filter : 'all'
  const country = typeof source.country === 'string' && source.country !== '' ? source.country : 'all'
  const cuisine = typeof source.cuisine === 'string' && source.cuisine !== '' ? source.cuisine : 'all'
  const province = typeof source.province === 'string' && source.province !== '' ? source.province : 'all'
  const legacyRegion = typeof source.region === 'string' && source.region !== '' && source.region !== 'all' ? source.region : 'all'
  const legacyMode = source.groupBy === undefined && source.region !== undefined
  const filterMeta = RECIPE_FILTERS.find((item) => item.id === scene)
  // 基础集：搜索 + 场景先收敛，三维 chip 数量基于这一步实时计算
  const baseResults = searchRecipes(filterByScene(list, scene), query)
  const results = legacyMode
    ? filterRecipesByRegion(baseResults, legacyRegion)
    : filterRecipes(list, { query, scene, country, cuisine, province })
  const groupBy = ['country', 'cuisine', 'province'].includes(source.groupBy)
    ? source.groupBy
    : legacyMode ? 'region' : 'country'
  const groups = groupBy === 'region'
    ? (legacyRegion === 'all' ? groupRecipesByRegion(results) : [{ id: legacyRegion, label: regionLabelOf(legacyRegion), entries: results }])
    : groupRecipes(results, groupBy)
  const region = typeof source.region === 'string' && source.region !== '' ? source.region : 'all'
  return {
    query,
    scene,
    filter: scene,
    filterLabel: filterMeta === undefined ? '全部' : filterMeta.label,
    country,
    cuisine,
    province,
    groupBy,
    total: list.length,
    results,
    counts: {
      base: baseResults.length,
      country: countByCountry(baseResults),
      cuisine: countByCuisine(baseResults),
      province: countByProvince(baseResults),
    },
    countryList: recipeCountriesOf(baseResults),
    cuisineList: recipeCuisinesOf(baseResults),
    provinceList: recipeProvincesOf(baseResults),
    groups,
    // 兼容旧的地区字段（页面已不再使用地区行）
    region,
    regionLabel: regionLabelOf(region),
    regionCounts: countRecipesByRegion(baseResults),
    empty: results.length === 0,
  }
}
