/**
 * 「今天吃什么」v2 host 半 —— 高德地图 Web 服务封装。
 *
 * 设计要点（design-v2 §8 Amap 细节）：
 * - Base `https://restapi.amap.com/v3`，用 Node 全局 `fetch`（Node 24）；
 * - 每个请求 8s 超时；成功结果内存缓存 10 分钟；
 * - 未配置 Key 时**绝不抛错**，返回 `{ ok:false, code:'amap-key-missing', fallbackQueries }`；
 * - 网络 / HTTP / 高德业务错误一律转成结构化结果，不把 Key 泄漏到 message 里；
 * - 关键词按 phase 生成；每家店附「点单建议」：连锁品牌按公开菜单，
 *   查不到公开菜单的小店建议顾客自行点单（见 src/core/chain-menu.js）。
 *
 * 本文件零外部依赖：只用 node: 内置模块与相对 import。
 */

import { shanghaiDate } from './state.js'
import { buildOrderSuggestion } from '../src/core/chain-menu.js'
import { canonicalPhaseKind } from '../src/core/phase.js'

/** 高德 Web 服务根地址。 */
export const AMAP_BASE = 'https://restapi.amap.com/v3'

/** 单请求超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = 8000

/** 结果缓存时长（毫秒）。 */
export const CACHE_TTL_MS = 10 * 60 * 1000

/** 按阶段生成的高德关键词（新九阶段；旧四阶段自动映射）。 */
export const PHASE_KEYWORDS = Object.freeze({
  performance: Object.freeze(['轻食', '沙拉', '鸡胸', '酸汤鱼', '荞麦面', '蒸菜', '清汤']),
  low_sugar: Object.freeze(['轻食', '沙拉', '蒸菜', '杂粮', '低糖']),
  low_sodium: Object.freeze(['少油', '清汤', '蒸', '粥', '蔬菜']),
  gentle: Object.freeze(['粥', '汤', '面馆', '蒸菜', '清淡']),
  high_fiber: Object.freeze(['素食', '蔬菜', '沙拉', '杂粮', '轻食']),
  plant_based: Object.freeze(['素食', '蔬菜', '豆制品', '沙拉', '菌菇']),
  special: Object.freeze(['清淡', '汤', '粥', '营养餐', '蒸菜']),
  recovery: Object.freeze(['粥', '汤', '蒸菜', '面馆', '清淡']),
  treat: Object.freeze(['火锅', '烧烤', '自助', '川菜', '小吃']),
})

/** 无 Key / 请求失败时的兜底建议上限。 */
const MAX_FALLBACK_QUERIES = 4

/** nearby 最多返回的 POI 条数。 */
const MAX_ITEMS = 10

/**
 * 取阶段的搜索关键词列表。
 *
 * @param {string} [phaseKind] 阶段类型
 * @returns {string[]} 关键词
 */
export function phaseKeywords(phaseKind) {
  const kind = canonicalPhaseKind(phaseKind) ?? 'performance'
  return [...(PHASE_KEYWORDS[kind] || PHASE_KEYWORDS.performance)]
}

/**
 * 把 JSON 里的数字字段（可能是 '' / [] / '4.5'）转成有限数字或 null。
 *
 * @param {unknown} value 候选
 * @returns {number | null} 数字或 null
 */
function toNumberOrNull(value) {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === '' || raw === undefined || raw === null) return null
  const number = Number(raw)
  return Number.isFinite(number) ? number : null
}

/**
 * 简单字符串哈希（缓存 key 用，避免把真实 Key 拼进缓存键）。
 *
 * @param {string} text 文本
 * @returns {string} 哈希
 */
function hashText(text) {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

/**
 * 把异常/业务信息里可能出现的 Key 抹掉。
 *
 * @param {unknown} message 原始信息
 * @param {string} key 高德 Key
 * @returns {string} 脱敏后的信息
 */
function sanitizeMessage(message, key) {
  let text = typeof message === 'string' ? message : message === undefined || message === null ? '' : String(message)
  if (key !== '') text = text.split(key).join('***')
  return text.replace(/key=[^&\s]+/gi, 'key=***').slice(0, 300)
}

/**
 * 生成无 Key 时的兜底搜索词（可复制到地图 App / 网页里搜）。
 *
 * @param {{ profile?: object, phaseKind?: string, keywords?: string[] | string, meal?: string }} [options] 上下文
 * @returns {string[]} 搜索词
 */
export function buildFallbackQueries(options = {}) {
  const profile = options.profile && typeof options.profile === 'object' ? options.profile : {}
  const identity = profile.identity && typeof profile.identity === 'object' ? profile.identity : {}
  const city = typeof identity.city === 'string' ? identity.city.trim() : ''
  const district = typeof identity.district === 'string' ? identity.district.trim() : ''
  const prefix = city === '' ? '' : district !== '' && !city.includes(district) ? `${city} ${district}` : city
  const keywords = Array.isArray(options.keywords)
    ? options.keywords
    : typeof options.keywords === 'string' && options.keywords !== ''
      ? options.keywords.split(/[,，|/]/)
      : phaseKeywords(options.phaseKind)
  const terms = keywords
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '')
    .slice(0, MAX_FALLBACK_QUERIES)
  const queries = terms.map((term) => `${prefix} ${term}`.trim())
  const meal = typeof options.meal === 'string' && options.meal !== '' ? options.meal : ''
  if (queries.length === 0) queries.push(`${prefix} 餐厅`)
  if (meal !== '') queries.push(`${prefix} ${mealLabel(meal)} 附近 餐厅`)
  return [...new Set(queries)].slice(0, MAX_FALLBACK_QUERIES + 1)
}

/**
 * 餐次中文标签。
 *
 * @param {string} meal 餐次
 * @returns {string} 中文
 */
function mealLabel(meal) {
  return { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', night: '夜宵' }[meal] || '吃饭'
}

/**
 * 按阶段与口味给出一两条中文点单建议。
 *
 * @param {object} [item] POI（目前只用于必要时拼店名）
 * @param {string} [phaseKind] 阶段类型
 * @param {object} [profile] 用户档案
 * @returns {string[]} 点单建议
 */
export function suggestOrder(item = {}, phaseKind = 'performance', profile = {}) {
  const kind = canonicalPhaseKind(phaseKind) ?? 'performance'
  const taste = profile && typeof profile.taste === 'object' ? profile.taste : {}
  const list = []
  if (kind === 'performance') {
    list.push('主菜选蒸/煮/烤的鱼禽牛，配杂粮饭半份 + 一份时蔬，避开油炸/糖醋/干锅')
    list.push('让店家少油少盐、米饭减半，饮料换无糖茶')
  } else if (kind === 'low_sugar') {
    list.push('饮料选无糖，避开糖醋/甜酱/含糖小吃，主食减半')
    list.push('优先清蒸/白灼/炖煮，配一份蔬菜和蛋白')
  } else if (kind === 'low_sodium') {
    list.push('清汤或蒸菜打底，加一份绿叶菜，主食换杂粮')
    list.push('少蘸料、少辣椒油，汤底选清汤')
  } else if (kind === 'gentle') {
    list.push('选粥/汤/面这类温和好消化的，别点重辣和油炸')
    list.push('少冰饮，少量多次吃')
  } else if (kind === 'high_fiber') {
    list.push('加一份蔬菜/菌菇，主食换杂粮或全谷')
    list.push('多点豆制品和绿叶菜，肉适量')
  } else if (kind === 'plant_based') {
    list.push('优先蔬菜、豆制品、菌菇，主食选杂粮')
    list.push('避开动物性单品，注意用豆类补蛋白')
  } else if (kind === 'special') {
    list.push('孕期避开生食/酒/高汞鱼；银发选软烂少盐；青少年保证蛋白')
    list.push('按身体情况点，不确定就问店家做法')
  } else if (kind === 'recovery') {
    list.push('选软烂、少油、蛋白足的粥/汤/蒸菜，先别吃辣')
    list.push('少量多次，配一份易消化的蔬菜')
  } else {
    list.push('按招牌点，配蔬菜/酸饮解腻，别硬撑')
    list.push('吃高兴最重要，主食和甜点适量就好')
  }
  // 六维味道：sour 优先，兼容旧档的 sourFruit/sourFermented/sourVinegar
  const sour = Math.max(
    Number(taste.sour) || 0,
    Number(taste.sourFruit) || 0,
    Number(taste.sourFermented) || 0,
    Number(taste.sourVinegar) || 0,
  )
  if (sour >= 4) {
    list.push('加一份青柠/酸木瓜小菜，果酸解腻更对味')
  } else if (Number(taste.spicy) >= 4) {
    list.push('蘸水要小米辣 + 青柠汁，辣得清爽')
  }
  const name = typeof item.name === 'string' && item.name !== '' ? `${item.name}：` : ''
  return list.slice(0, 2).map((text) => `${name}${text}`)
}

/**
 * 创建高德客户端（可注入 fetch / 时间 / 缓存时长，测试可完全离线）。
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   getKey?: () => string,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   ttlMs?: number,
 * }} [options] 注入项
 * @returns {object} 高德客户端
 */
export function createAmap(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const getKey = typeof options.getKey === 'function' ? options.getKey : () => ''
  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl !== '' ? options.baseUrl.replace(/\/$/, '') : AMAP_BASE
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : REQUEST_TIMEOUT_MS
  const ttlMs = Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0
    ? Number(options.ttlMs)
    : CACHE_TTL_MS
  const cache = new Map()

  /**
   * 解析本次请求应使用的 Key。
   *
   * @param {unknown} explicitKey 显式传入的 Key
   * @returns {string} Key
   */
  function resolveKey(explicitKey) {
    if (typeof explicitKey === 'string' && explicitKey.trim() !== '') return explicitKey.trim()
    const provided = getKey()
    return typeof provided === 'string' ? provided.trim() : ''
  }

  /**
   * 请求高德接口（带缓存 / 超时 / 结构化错误）。
   *
   * @param {string} apiPath 接口路径（如 `/place/around`）
   * @param {Record<string, string | number>} params 查询参数（不含 key）
   * @param {string} key 高德 Key
   * @returns {Promise<object>} 结构化结果
   */
  async function request(apiPath, params, key) {
    const cacheKey = `${apiPath}|${hashText(key)}|${JSON.stringify(params)}`
    const hit = cache.get(cacheKey)
    if (hit !== undefined && hit.expiresAt > now()) return hit.value
    if (typeof fetchImpl !== 'function') {
      return { ok: false, code: 'amap-request-failed', message: '当前运行环境没有 fetch' }
    }
    const query = new URLSearchParams()
    for (const [name, value] of Object.entries(params)) query.set(name, String(value))
    query.set('key', key)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let result
    try {
      const response = await fetchImpl(`${baseUrl}${apiPath}?${query.toString()}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response || response.ok !== true) {
        result = {
          ok: false,
          code: 'amap-request-failed',
          message: `高德接口 HTTP ${response && response.status !== undefined ? response.status : 'unknown'}`,
        }
      } else {
        let payload
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!payload || typeof payload !== 'object') {
          result = { ok: false, code: 'amap-request-failed', message: '高德接口返回了非 JSON 内容' }
        } else if (String(payload.status) !== '1') {
          result = {
            ok: false,
            code: 'amap-error',
            message: sanitizeMessage(payload.info || payload.infocode || '高德接口返回失败', key),
          }
        } else {
          result = { ok: true, payload }
        }
      }
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
      result = {
        ok: false,
        code: aborted ? 'amap-timeout' : 'amap-request-failed',
        message: aborted
          ? `高德接口超时（${timeoutMs}ms）`
          : sanitizeMessage(error && error.message ? error.message : '网络请求失败', key),
      }
    } finally {
      clearTimeout(timer)
    }
    cache.set(cacheKey, { value: result, expiresAt: now() + ttlMs })
    return result
  }

  /**
   * 清理缓存（测试 / 换 Key 后调用）。
   *
   * @returns {void}
   */
  function clearCache() {
    cache.clear()
  }

  /**
   * 城市地理编码：返回经纬度与 adcode。
   *
   * @param {string} city 城市名（可带区县）
   * @param {{ key?: string }} [callOptions] 调用项
   * @returns {Promise<object>} `{ok, location, adcode, ...}` 或结构化错误
   */
  async function geocodeCity(city, callOptions = {}) {
    if (typeof city !== 'string' || city.trim() === '') {
      return { ok: false, code: 'invalid-city', message: '缺少城市名' }
    }
    const key = resolveKey(callOptions.key)
    if (key === '') return { ok: false, code: 'amap-key-missing', message: '未配置高德 Key' }
    const result = await request('/geocode/geo', { address: city.trim() }, key)
    if (!result.ok) return result
    const geocodes = Array.isArray(result.payload.geocodes) ? result.payload.geocodes : []
    const first = geocodes.find((item) => item && typeof item === 'object') || {}
    const location = typeof first.location === 'string' ? first.location.split(',') : []
    const lng = Number(location[0])
    const lat = Number(location[1])
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return { ok: false, code: 'geocode-not-found', message: `没有找到城市：${city}` }
    }
    return {
      ok: true,
      query: city.trim(),
      city: typeof first.city === 'string' ? first.city : city.trim(),
      province: typeof first.province === 'string' ? first.province : '',
      district: typeof first.district === 'string' ? first.district : '',
      adcode: typeof first.adcode === 'string' ? first.adcode : '',
      level: typeof first.level === 'string' ? first.level : '',
      location: { lng, lat },
    }
  }

  /**
   * 周边餐饮 POI 搜索 + 过滤 + 点单建议。
   *
   * @param {{
   *   key?: string, lng: number, lat: number, keywords?: string[] | string,
   *   radius?: number, maxCost?: number, phase?: string, profile?: object,
   * }} searchOptions 搜索参数
   * @returns {Promise<object>} `{ok:true, items, suggestions, keywords}` 或结构化错误
   */
  async function searchNearby(searchOptions = {}) {
    const lng = Number(searchOptions.lng)
    const lat = Number(searchOptions.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return { ok: false, code: 'invalid-location', message: '缺少有效经纬度' }
    }
    const phaseKind = typeof searchOptions.phase === 'string' ? searchOptions.phase : 'fitness'
    const keywords = Array.isArray(searchOptions.keywords)
      ? searchOptions.keywords.filter((item) => typeof item === 'string' && item !== '')
      : typeof searchOptions.keywords === 'string' && searchOptions.keywords !== ''
        ? searchOptions.keywords.split(/[,，|/]/).map((item) => item.trim()).filter(Boolean)
        : phaseKeywords(phaseKind)
    const radiusRaw = Number(searchOptions.radius)
    const radius = Number.isFinite(radiusRaw) && radiusRaw > 0 ? Math.min(5000, Math.round(radiusRaw)) : 1500
    const maxCost = Number.isFinite(Number(searchOptions.maxCost)) && Number(searchOptions.maxCost) > 0
      ? Number(searchOptions.maxCost)
      : null
    const key = resolveKey(searchOptions.key)
    if (key === '') {
      return {
        ok: false,
        code: 'amap-key-missing',
        message: '未配置高德 Key',
        fallbackQueries: buildFallbackQueries({ profile: searchOptions.profile, phaseKind, keywords }),
      }
    }
    const result = await request('/place/around', {
      location: `${lng},${lat}`,
      radius,
      types: '050000',
      keywords: keywords.join('|'),
      offset: 25,
      page: 1,
      extensions: 'all',
    }, key)
    if (!result.ok) {
      return {
        ...result,
        fallbackQueries: buildFallbackQueries({ profile: searchOptions.profile, phaseKind, keywords }),
      }
    }
    const pois = Array.isArray(result.payload.pois) ? result.payload.pois : []
    const items = pois
      .filter((poi) => poi && typeof poi === 'object')
      .map((poi) => {
        const biz = poi.biz_ext && typeof poi.biz_ext === 'object' ? poi.biz_ext : {}
        return {
          name: typeof poi.name === 'string' ? poi.name : '',
          address: typeof poi.address === 'string' ? poi.address : '',
          distance: toNumberOrNull(poi.distance),
          rating: toNumberOrNull(biz.rating),
          cost: toNumberOrNull(biz.cost),
          tel: typeof poi.tel === 'string' ? poi.tel : '',
          type: typeof poi.type === 'string' ? poi.type : '',
          location: typeof poi.location === 'string' ? poi.location : '',
        }
      })
      .filter((item) => item.name !== '')
      .filter((item) => item.distance === null || item.distance <= radius)
      .filter((item) => item.rating === null || item.rating >= 4.0)
      .filter((item) => maxCost === null || item.cost === null || item.cost <= maxCost)
      .sort((left, right) => {
        const ratingDiff = (right.rating ?? 0) - (left.rating ?? 0)
        if (ratingDiff !== 0) return ratingDiff
        return (left.distance ?? Number.POSITIVE_INFINITY) - (right.distance ?? Number.POSITIVE_INFINITY)
      })
      .slice(0, MAX_ITEMS)
    const profile = searchOptions.profile && typeof searchOptions.profile === 'object' ? searchOptions.profile : {}
    const itemsWithAdvice = items.map((item) => {
      const advice = buildOrderSuggestion(item.name, phaseKind, profile)
      return { ...item, suggestion: advice.text, orderKind: advice.kind }
    })
    return {
      ok: true,
      items: itemsWithAdvice,
      suggestions: ['点单建议按店铺类型：连锁品牌按公开菜单，查不到公开菜单的小店请自行看菜单点单。'],
      keywords,
      radius,
    }
  }

  /**
   * 天气查询：返回今天的白天/夜间天气与温度。
   *
   * @param {{ key?: string, adcode?: string }} [weatherOptions] 参数
   * @returns {Promise<object>} `{ok:true, weather}` 或结构化错误
   */
  async function weather(weatherOptions = {}) {
    const adcode = typeof weatherOptions.adcode === 'string' ? weatherOptions.adcode.trim() : ''
    if (adcode === '') return { ok: false, code: 'invalid-adcode', message: '缺少 adcode' }
    const key = resolveKey(weatherOptions.key)
    if (key === '') return { ok: false, code: 'amap-key-missing', message: '未配置高德 Key' }
    const result = await request('/weather/weatherInfo', { city: adcode, extensions: 'all' }, key)
    if (!result.ok) return result
    const forecasts = Array.isArray(result.payload.forecasts) ? result.payload.forecasts : []
    const forecast = forecasts.find((item) => item && typeof item === 'object') || {}
    const casts = Array.isArray(forecast.casts) ? forecast.casts : []
    const today = shanghaiDate(now())
    const cast = casts.find((item) => item && item.date === today) || casts[0] || {}
    return {
      ok: true,
      adcode,
      city: typeof forecast.city === 'string' ? forecast.city : '',
      weather: {
        date: typeof cast.date === 'string' ? cast.date : today,
        dayWeather: typeof cast.dayweather === 'string' ? cast.dayweather : '',
        nightWeather: typeof cast.nightweather === 'string' ? cast.nightweather : '',
        dayTemp: toNumberOrNull(cast.daytemp),
        nightTemp: toNumberOrNull(cast.nighttemp),
        dayWind: typeof cast.daywind === 'string' ? cast.daywind : '',
        dayPower: typeof cast.daypower === 'string' ? cast.daypower : '',
      },
    }
  }

  return {
    baseUrl,
    timeoutMs,
    ttlMs,
    geocodeCity,
    searchNearby,
    weather,
    suggestOrder,
    phaseKeywords,
    buildFallbackQueries,
    clearCache,
    cacheSize: () => cache.size,
  }
}
