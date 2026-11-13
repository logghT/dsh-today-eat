/**
 * 「我的菜谱」纯函数（host state 归一化 / client 表单共用）。
 *
 * 存储形态：`state.userRecipes` 是对象 map `{ [id]: recipe }`，原因见 docs/user-recipes.md：
 * - `/api/state` 的 patch 只接受普通对象根，数组根会被拒绝；
 * - 新增 = patch `{ [id]: recipe }` 深合并；删除 = patch `{ [id]: null }`，
 *   normalize 时把 null / 非法项过滤掉，map 保持紧凑。
 *
 * 本文件零依赖（不 import 任何模块），可被 host（lib/state.js）与 client（store / 表单）同时使用。
 */

/** 我的菜谱允许的菜系（与菜谱库 11 类保持一致）。 */
export const USER_RECIPE_CUISINES = Object.freeze([
  '云南菜', '川菜', '粤菜', '湘菜', '江浙', '北方', '西北', '西南', '日韩', '西式', '快餐',
])

/** 我的菜谱允许的分类（与 data/dishes.js 的 category 一致）。 */
export const USER_RECIPE_CATEGORIES = Object.freeze([
  '米饭', '面食', '汤羹', '小吃', '家常菜', '火锅烧烤', '轻食', '早餐',
])

/** 食材分组（与菜谱数据 ingredients[].group 一致）。 */
export const USER_RECIPE_GROUPS = Object.freeze(['蔬菜', '肉蛋', '水产', '豆制品', '主食', '调料', '水果', '其他'])

/** 份数 / 时间 / 营养上限（防御异常输入）。 */
export const USER_RECIPE_LIMIT = 300

const DIFFICULTIES = Object.freeze(['易', '中', '难'])

const MAX_NAME = 40
const MAX_STEP = 300
const MAX_INGREDIENTS = 60
const MAX_STEPS = 40
const MAX_TIPS = 20

/**
 * 取整并夹在区间内。
 *
 * @param {unknown} value 原始值
 * @param {number} min 最小
 * @param {number} max 最大
 * @param {number} fallback 非法时兜底
 * @returns {number} 结果
 */
function intIn(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * 文本归一化：去首尾空白、限长。
 *
 * @param {unknown} value 原始值
 * @param {number} max 最大长度
 * @returns {string} 结果
 */
function text(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/**
 * 生成自定义菜谱 id。
 *
 * @param {number} [now] 时间戳
 * @returns {string} id（custom-<时间 base36>-<随机>）
 */
export function makeUserRecipeId(now = Date.now()) {
  const stamp = Math.max(0, Math.round(Number(now) || 0)).toString(36)
  return `custom-${stamp}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 根据食材名猜分组（表单不强制用户选分组）。
 *
 * @param {string} name 食材名
 * @returns {string} 分组
 */
export function guessIngredientGroup(name) {
  const value = typeof name === 'string' ? name : ''
  if (/盐|糖|醋|酱|油|酒|椒|粉|孜然|香料|味精|鸡精|蚝油|生抽|老抽|豆瓣|淀粉|料酒|蜂蜜|咖喱|芥末|辣酱|芝麻/.test(value)) return '调料'
  if (/鸡|鸭|猪|牛|羊|肉|蛋|排骨|培根|火腿|香肠|午餐肉/.test(value)) return '肉蛋'
  if (/鱼|虾|蟹|贝|鱿|海参|牡蛎|蛤|海带|紫菜/.test(value)) return '水产'
  if (/豆腐|豆干|豆皮|腐竹|豆浆|黄豆|毛豆|豆芽|千张/.test(value)) return '豆制品'
  if (/米|面|粉|馒头|面包|燕麦|年糕|饺子|馄饨|粉丝|意面|吐司|饼/.test(value)) return '主食'
  if (/苹果|香蕉|橙|柠檬|青柠|木瓜|酸角|百香果|菠萝|芒果|莓|桃|梨|葡萄|西瓜|椰|枣|枸杞/.test(value)) return '水果'
  if (/菜|瓜|茄|椒|葱|姜|蒜|萝卜|土豆|山药|藕|笋|菌|菇|木耳|番茄|洋葱|玉米|豌豆|西兰花/.test(value)) return '蔬菜'
  return '其他'
}

/**
 * 归一化一条食材。
 *
 * @param {unknown} input 原始食材
 * @returns {{name: string, amount: number | null, unit: string, group: string} | null} 结果
 */
function normalizeIngredient(input) {
  if (input === null || typeof input !== 'object') return null
  const name = text(input.name, 30)
  if (name === '') return null
  const amountRaw = Number(input.amount)
  const amount = Number.isFinite(amountRaw) && amountRaw >= 0 ? Math.round(amountRaw * 100) / 100 : null
  const unit = text(input.unit, 8)
  const group = USER_RECIPE_GROUPS.includes(input.group) ? input.group : guessIngredientGroup(name)
  return { name, amount, unit, group }
}

/**
 * 归一化单条菜谱（非法返回 null）。
 *
 * @param {unknown} input 原始菜谱
 * @param {{ now?: number, id?: string }} [options] 选项
 * @returns {object | null} 菜谱
 */
export function normalizeUserRecipe(input, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const name = text(input.name, MAX_NAME)
  if (name === '') return null
  const cuisine = USER_RECIPE_CUISINES.includes(input.cuisine) ? input.cuisine : ''
  if (cuisine === '') return null
  const category = USER_RECIPE_CATEGORIES.includes(input.category) ? input.category : '家常菜'
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const id = text(input.id ?? options.id, 80)
  const ingredients = Array.isArray(input.ingredients)
    ? input.ingredients.map(normalizeIngredient).filter((item) => item !== null).slice(0, MAX_INGREDIENTS)
    : []
  const steps = Array.isArray(input.steps)
    ? input.steps.map((step) => text(step, MAX_STEP)).filter((step) => step !== '').slice(0, MAX_STEPS)
    : []
  const tips = Array.isArray(input.tips)
    ? input.tips.map((tip) => text(tip, MAX_STEP)).filter((tip) => tip !== '').slice(0, MAX_TIPS)
    : []
  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag) => text(tag, 12)).filter((tag) => tag !== '').slice(0, 8)
    : []
  const country = text(input.country, 20) || '中国'
  const provinceRaw = text(input.province, 20)
  const province = country === '中国' && provinceRaw !== '' ? provinceRaw : null
  return {
    id: id === '' ? makeUserRecipeId(now) : id,
    name,
    cuisine,
    category,
    country,
    province,
    difficulty: DIFFICULTIES.includes(input.difficulty) ? input.difficulty : '易',
    servings: intIn(input.servings, 1, 20, 2),
    prepMin: intIn(input.prepMin, 0, 600, 0),
    cookMin: intIn(input.cookMin, 0, 600, 0),
    kcal: intIn(input.kcal, 0, 3000, 0),
    protein: intIn(input.protein, 0, 300, 0),
    ingredients,
    steps,
    tips,
    tags,
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : now,
    updatedAt: now,
  }
}

/**
 * 归一化整个 userRecipes map：丢弃 null / 非法项，键名作为兜底 id。
 *
 * @param {unknown} input 原始 map（也兼容旧的数组形态）
 * @returns {Record<string, object>} 归一化后的 map
 */
export function normalizeUserRecipes(input) {
  /** @type {Record<string, object>} */
  const result = {}
  if (Array.isArray(input)) {
    for (const item of input.slice(0, USER_RECIPE_LIMIT)) {
      const recipe = normalizeUserRecipe(item)
      if (recipe !== null) result[recipe.id] = recipe
    }
    return result
  }
  if (input === null || typeof input !== 'object') return result
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(result).length >= USER_RECIPE_LIMIT) break
    if (value === null || typeof value !== 'object') continue
    const recipe = normalizeUserRecipe({ ...value, id: typeof value.id === 'string' && value.id !== '' ? value.id : key }, {})
    if (recipe !== null) result[recipe.id] = recipe
  }
  return result
}

/**
 * 取 map 中的菜谱列表（按创建时间倒序，最新在前）。
 *
 * @param {unknown} input userRecipes map
 * @returns {Array<object>} 列表
 */
export function userRecipeList(input) {
  return Object.values(normalizeUserRecipes(input)).sort((left, right) => {
    const leftAt = Number(left.createdAt) || 0
    const rightAt = Number(right.createdAt) || 0
    return rightAt - leftAt
  })
}

/**
 * 解析表单里的食材行：每行「名称 数量单位」，数量可省略。
 *
 * 例：`鸡胸肉 200g` / `小米辣 2 个` / `盐` → {name, amount, unit, group}
 *
 * @param {string} value 多行文本
 * @returns {Array<object>} 食材列表
 */
export function parseIngredientLines(value) {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const match = line.match(/^(.+?)(?:\s+([\d.]+)\s*([^\s\d]*))?$/)
      if (match === null) return null
      const name = text(match[1], 30)
      if (name === '') return null
      const amount = match[2] === undefined ? null : Number(match[2])
      return {
        name,
        amount: Number.isFinite(amount) ? amount : null,
        unit: match[3] === undefined ? '' : text(match[3], 8),
        group: guessIngredientGroup(name),
      }
    })
    .filter((item) => item !== null)
}

/**
 * 解析步骤文本（每行一步）。
 *
 * @param {string} value 多行文本
 * @returns {Array<string>} 步骤
 */
export function parseStepLines(value) {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, MAX_STEPS)
}

/**
 * 解析小贴士文本（每行一条）。
 *
 * @param {string} value 多行文本
 * @returns {Array<string>} 小贴士
 */
export function parseTipLines(value) {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, MAX_TIPS)
}
