/**
 * 「今天吃什么」v2 host 半 —— HTTP API（design-v2 §3）。
 *
 * 路由（全部绝对路径，注册在 `ctx.webServer`）：
 *   GET    /dsh-today-eat/api/state
 *   POST   /dsh-today-eat/api/state
 *   POST   /dsh-today-eat/api/meals
 *   DELETE /dsh-today-eat/api/meals?id=
 *   POST   /dsh-today-eat/api/plan
 *   POST   /dsh-today-eat/api/amap-key
 *   GET    /dsh-today-eat/api/nearby?meal=lunch&radius=1500
 *   GET    /dsh-today-eat/api/shopping?days=3
 *
 * 安全（design-v2 §1.5）：
 * - Host 必须存在；Origin 若存在必须与 Host 同源（GET 也校验）；`Sec-Fetch-Site: cross-site` 拒绝；
 * - 写请求（POST/DELETE）只允许回环 Host；POST 必须 `content-type: application/json`；
 * - 错误统一 `{ ok:false, code, message }`；写接口 rev 冲突 409。
 *
 * 本文件零外部依赖：只用 node: 内置模块与相对 import。
 */

import { Buffer } from 'node:buffer'
import { mealFromTimestamp, shanghaiDate } from './state.js'
import { buildFallbackQueries } from './amap.js'
import { DISHES } from '../data/dishes.js'

/** API 前缀。 */
export const API_PREFIX = '/dsh-today-eat/api'

/** 方法级路由表（design-v2 §3）。 */
export const API_ROUTES = Object.freeze([
  Object.freeze({ key: 'state', method: 'GET', path: `${API_PREFIX}/state` }),
  Object.freeze({ key: 'state', method: 'POST', path: `${API_PREFIX}/state` }),
  Object.freeze({ key: 'meals', method: 'POST', path: `${API_PREFIX}/meals` }),
  Object.freeze({ key: 'meals', method: 'DELETE', path: `${API_PREFIX}/meals` }),
  Object.freeze({ key: 'plan', method: 'POST', path: `${API_PREFIX}/plan` }),
  Object.freeze({ key: 'amap-key', method: 'POST', path: `${API_PREFIX}/amap-key` }),
  Object.freeze({ key: 'nearby', method: 'GET', path: `${API_PREFIX}/nearby` }),
  Object.freeze({ key: 'shopping', method: 'GET', path: `${API_PREFIX}/shopping` }),
])

/** 写请求方法。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** JSON 响应头。 */
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

/** 请求体上限（字节）。 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 读取请求头（大小写不敏感；Node 已小写，测试可能用混合大小写）。
 *
 * @param {object | undefined} headers 请求头
 * @param {string} name 小写头名
 * @returns {string} 头值（缺失返回空串）
 */
function header(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  const direct = headers[name]
  if (direct !== undefined) return Array.isArray(direct) ? String(direct[0]) : String(direct)
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name)
  if (found === undefined) return ''
  const value = headers[found]
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

/**
 * 回环主机名判断：localhost / *.localhost / 127.0.0.0/8 / ::1。
 *
 * @param {string} hostname 主机名
 * @returns {boolean} 回环返回 true
 */
export function isLoopbackHostname(hostname) {
  const name = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (name === '') return false
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (match === null) return false
  if (Number(match[1]) !== 127) return false
  return [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
}

/**
 * 同源 + 回环 + Content-Type 校验。
 *
 * @param {string} method 方法
 * @param {object} headers 请求头
 * @param {string} rawBody 已读取的请求体
 * @returns {{ status: number, body: object } | null} 拒绝响应；通过返回 null
 */
export function checkRequest(method, headers, rawBody = '') {
  const reject = (status, code, message) => ({ status, body: { ok: false, code, message } })
  const hostRaw = header(headers, 'host').trim()
  if (hostRaw === '') return reject(403, 'missing-host', '缺少 Host 请求头')
  let hostUrl
  try {
    hostUrl = new URL(`http://${hostRaw}`)
  } catch {
    return reject(403, 'invalid-host', 'Host 请求头不合法')
  }
  const origin = header(headers, 'origin').trim()
  if (origin !== '' && origin !== 'null') {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return reject(403, 'invalid-origin', 'Origin 请求头不合法')
    }
    if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) {
      return reject(403, 'cross-origin', '跨源请求被拒绝')
    }
  }
  if (header(headers, 'sec-fetch-site').toLowerCase() === 'cross-site') {
    return reject(403, 'cross-site', '跨站请求被拒绝')
  }
  const upper = String(method || 'GET').toUpperCase()
  if (WRITE_METHODS.has(upper) && !isLoopbackHostname(hostUrl.hostname)) {
    return reject(403, 'non-loopback', '写接口只允许本机回环访问')
  }
  const contentType = header(headers, 'content-type').toLowerCase()
  const isJson = contentType.startsWith('application/json')
  if (upper === 'POST' && !isJson) {
    return reject(415, 'unsupported-media-type', '请求必须是 application/json')
  }
  if ((upper === 'DELETE' || upper === 'PUT' || upper === 'PATCH') && isJson === false && String(rawBody || '') !== '') {
    return reject(415, 'unsupported-media-type', '请求必须是 application/json')
  }
  return null
}

/**
 * 生成 JSON 结果。
 *
 * @param {number} status HTTP 状态码
 * @param {object} body 响应体
 * @returns {{ status: number, headers: object, body: object }} 结果
 */
function json(status, body) {
  return { status, headers: { ...JSON_HEADERS }, body }
}

/**
 * 把 store 的结构化失败映射成 HTTP 响应。
 *
 * @param {object} result store 返回值
 * @returns {{ status: number, headers: object, body: object }} 响应
 */
function mapStoreFailure(result) {
  const code = result && typeof result.code === 'string' ? result.code : 'bad-request'
  if (code === 'rev-mismatch') {
    return json(409, {
      ok: false,
      code,
      message: '数据已被其他窗口更新，请刷新后重试',
      state: result.state,
      rev: result.rev,
    })
  }
  if (code === 'meal-not-found') {
    return json(404, { ok: false, code, message: result.message || '记录不存在' })
  }
  return json(400, { ok: false, code, message: result.message || '请求参数不合法' })
}

/**
 * 解析 JSON 请求体。
 *
 * @param {string} rawBody 请求体
 * @returns {{ ok: true, value: object } | { ok: false, body: object }} 解析结果
 */
function parseJsonBody(rawBody) {
  if (typeof rawBody !== 'string' || rawBody.trim() === '') return { ok: true, value: {} }
  try {
    const value = JSON.parse(rawBody)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, body: { ok: false, code: 'invalid-json', message: '请求体必须是 JSON 对象' } }
    }
    return { ok: true, value }
  } catch {
    return { ok: false, body: { ok: false, code: 'invalid-json', message: '请求体不是合法 JSON' } }
  }
}

/**
 * 调 amap 的 fallbackQueries（构造器可能缺失，测试可给极简 stub）。
 *
 * @param {object} amap 高德客户端
 * @param {{ profile?: object, phaseKind?: string, keywords?: string[], meal?: string }} context 上下文
 * @returns {string[]} 兜底搜索词
 */
function fallbackQueries(amap, context) {
  try {
    if (amap && typeof amap.buildFallbackQueries === 'function') return amap.buildFallbackQueries(context)
  } catch {
    // 忽略，走内置实现
  }
  try {
    return buildFallbackQueries(context)
  } catch {
    return []
  }
}

/**
 * 从完整状态推断当前餐次。
 *
 * @returns {string} 餐次
 */
function currentMeal() {
  return mealFromTimestamp(Date.now())
}

/**
 * 处理一条 API 请求（纯函数式入口，便于单元测试）。
 *
 * @param {{ store: object, amap: object, core: object }} deps 依赖
 * @param {{
 *   method?: string, path?: string, url?: string,
 *   headers?: object, rawBody?: string, body?: unknown,
 * }} request 请求
 * @returns {Promise<{ status: number, headers: object, body: object }>} 响应
 */
export async function handleApiRequest(deps, request = {}) {
  const store = deps && deps.store
  if (!store) return json(500, { ok: false, code: 'internal-error', message: '状态仓库未初始化' })
  const method = String(request.method || 'GET').toUpperCase()
  const target = typeof request.path === 'string' && request.path !== ''
    ? request.path
    : typeof request.url === 'string' && request.url !== '' ? request.url : '/'
  let url
  try {
    url = new URL(target, 'http://local.invalid')
  } catch {
    return json(400, { ok: false, code: 'invalid-url', message: '请求路径不合法' })
  }
  const headers = request.headers && typeof request.headers === 'object' ? request.headers : {}
  const rawBody = typeof request.rawBody === 'string' ? request.rawBody : ''
  const security = checkRequest(method, headers, rawBody)
  if (security !== null) return json(security.status, security.body)

  const pathname = url.pathname
  const route = API_ROUTES.find((item) => item.path === pathname)
  if (route === undefined) return json(404, { ok: false, code: 'not-found', message: `没有这个接口：${pathname}` })
  const allowed = [...new Set(API_ROUTES.filter((item) => item.path === pathname).map((item) => item.method))]
  if (!allowed.includes(method)) {
    return {
      status: 405,
      headers: { ...JSON_HEADERS, allow: allowed.join(', ') },
      body: { ok: false, code: 'method-not-allowed', message: `该接口只支持 ${allowed.join('/')}` },
    }
  }
  const query = url.searchParams
  const parsed = parseJsonBody(rawBody)
  if (!parsed.ok) return json(400, parsed.body)
  const body = parsed.value

  try {
    if (route.key === 'state' && method === 'GET') {
      return json(200, { ok: true, state: store.getState(), hasAmapKey: store.hasAmapKey() })
    }
    if (route.key === 'state' && method === 'POST') {
      if (!Object.prototype.hasOwnProperty.call(body, 'patch')) {
        return json(400, { ok: false, code: 'patch-required', message: '缺少 patch 参数' })
      }
      if (body.patch === null || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
        return json(400, { ok: false, code: 'invalid-patch', message: 'patch 必须是对象' })
      }
      const result = store.patch(body.rev, body.patch)
      if (!result.ok) return mapStoreFailure(result)
      return json(200, { ok: true, state: result.state, hasAmapKey: result.hasAmapKey, rev: result.rev })
    }
    if (route.key === 'meals' && method === 'POST') {
      if (body.meal === null || typeof body.meal !== 'object' || Array.isArray(body.meal)) {
        return json(400, { ok: false, code: 'invalid-meal', message: '缺少 meal 参数' })
      }
      const result = store.upsertMeal(body.rev, body.meal)
      if (!result.ok) return mapStoreFailure(result)
      return json(200, { ok: true, state: result.state, rev: result.rev })
    }
    if (route.key === 'meals' && method === 'DELETE') {
      const id = query.get('id') || (typeof body.id === 'string' ? body.id : '')
      const revRaw = query.get('rev') ?? body.rev
      const rev = revRaw === undefined || revRaw === null || revRaw === '' ? undefined : Number(revRaw)
      const result = store.deleteMeal(id, rev)
      if (!result.ok) return mapStoreFailure(result)
      return json(200, { ok: true, state: result.state, rev: result.rev })
    }
    if (route.key === 'plan' && method === 'POST') {
      if (body.plan === null || typeof body.plan !== 'object' || Array.isArray(body.plan)) {
        return json(400, { ok: false, code: 'invalid-plan', message: '缺少 plan 参数' })
      }
      const result = store.setPlan(body.rev, body.plan)
      if (!result.ok) return mapStoreFailure(result)
      return json(200, { ok: true, state: result.state, rev: result.rev })
    }
    if (route.key === 'amap-key' && method === 'POST') {
      if (typeof body.key !== 'string') {
        return json(400, { ok: false, code: 'key-required', message: '缺少 key 参数（传空串可清除）' })
      }
      const result = store.setAmapKey(body.key, body.rev)
      if (!result.ok) return mapStoreFailure(result)
      return json(200, { ok: true, hasAmapKey: result.hasAmapKey, rev: result.rev })
    }
    if (route.key === 'nearby' && method === 'GET') {
      return handleNearby(deps, query)
    }
    if (route.key === 'shopping' && method === 'GET') {
      return await handleShopping(deps, query)
    }
  } catch (error) {
    return json(500, {
      ok: false,
      code: 'internal-error',
      message: error && typeof error.message === 'string' ? error.message.slice(0, 200) : '服务器内部错误',
    })
  }
  return json(404, { ok: false, code: 'not-found', message: '没有这个接口' })
}

/**
 * GET /api/nearby：周边餐厅 + 天气 + 点单建议；无 Key 时返回 amap-key-missing（HTTP 200）。
 *
 * @param {{ store: object, amap: object, core: object }} deps 依赖
 * @param {URLSearchParams} query 查询参数
 * @returns {Promise<{ status: number, headers: object, body: object }>} 响应
 */
async function handleNearby(deps, query) {
  const store = deps.store
  const amap = deps.amap
  const full = store.getFullState()
  const profile = full.profile || {}
  const identity = profile.identity || {}
  const phaseKind = full.phase && typeof full.phase.kind === 'string' ? full.phase.kind : 'fitness'
  const mealRaw = query.get('meal')
  const meal = ['breakfast', 'lunch', 'dinner', 'night'].includes(mealRaw) ? mealRaw : currentMeal()
  const radiusRaw = Number(query.get('radius'))
  const radius = Number.isFinite(radiusRaw) && radiusRaw > 0 ? Math.min(5000, Math.max(100, Math.round(radiusRaw))) : 1500
  const keywordsRaw = query.get('keywords')
  const keywords = typeof keywordsRaw === 'string' && keywordsRaw.trim() !== ''
    ? keywordsRaw.split(/[,，|/]/).map((item) => item.trim()).filter(Boolean)
    : undefined
  const queries = fallbackQueries(amap, { profile, phaseKind, keywords, meal })
  const key = store.getAmapKey()
  if (key === '') {
    return json(200, {
      ok: false,
      code: 'amap-key-missing',
      message: '未配置高德 Key，可在「今天吃什么 → 设置」里填写',
      fallbackQueries: queries,
    })
  }
  // 出差/换城市友好：有 Key 时先按档案「城市+区县」做一次高德地理编码（客户端带 10 分钟缓存），
  // 成功则以地理编码结果为准；失败才退回档案里的经纬度。
  let lng = Number(identity.lng)
  let lat = Number(identity.lat)
  let adcode = typeof identity.adcode === 'string' ? identity.adcode : ''
  const cityQuery = [identity.city, identity.district].filter((part) => typeof part === 'string' && part.trim() !== '').join('')
  if (cityQuery !== '' && amap && typeof amap.geocodeCity === 'function') {
    try {
      const geo = await amap.geocodeCity(cityQuery)
      if (geo && geo.ok === true && geo.location && Number.isFinite(geo.location.lng) && Number.isFinite(geo.location.lat)) {
        lng = geo.location.lng
        lat = geo.location.lat
        if (typeof geo.adcode === 'string' && geo.adcode !== '') adcode = geo.adcode
      }
    } catch {
      // 地理编码失败沿用档案坐标
    }
  }
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return json(400, {
      ok: false,
      code: 'location-missing',
      message: '档案里缺少经纬度，请先在设置里选择城市',
      fallbackQueries: queries,
    })
  }
  const budget = profile.budget && Array.isArray(profile.budget.perMeal) ? Number(profile.budget.perMeal[1]) : NaN
  let search
  try {
    if (!amap || typeof amap.searchNearby !== 'function') {
      return json(200, { ok: false, code: 'amap-unavailable', message: '高德客户端不可用', fallbackQueries: queries })
    }
    search = await amap.searchNearby({
      key,
      lng,
      lat,
      keywords,
      radius,
      maxCost: Number.isFinite(budget) ? budget : undefined,
      phase: phaseKind,
      profile,
    })
  } catch {
    return json(200, {
      ok: false,
      code: 'amap-request-failed',
      message: '高德请求失败，请稍后重试',
      fallbackQueries: queries,
    })
  }
  if (!search || search.ok !== true) {
    return json(200, {
      ok: false,
      code: search && typeof search.code === 'string' ? search.code : 'amap-request-failed',
      message: search && typeof search.message === 'string' ? search.message : '高德请求失败',
      fallbackQueries: Array.isArray(search && search.fallbackQueries) ? search.fallbackQueries : queries,
    })
  }
  const payload = { ok: true, items: Array.isArray(search.items) ? search.items : [], suggestions: Array.isArray(search.suggestions) ? search.suggestions : [] }
  try {
    if (amap && typeof amap.weather === 'function') {
      const weatherResult = await amap.weather({ key, adcode })
      if (weatherResult && weatherResult.ok === true && weatherResult.weather) payload.weather = weatherResult.weather
    }
  } catch {
    // 天气失败不影响附近结果
  }
  return json(200, payload)
}

/**
 * GET /api/shopping：按当前周计划生成采买清单。
 *
 * @param {{ store: object, amap: object, core: object }} deps 依赖
 * @param {URLSearchParams} query 查询参数
 * @returns {Promise<{ status: number, headers: object, body: object }>} 响应
 */
async function handleShopping(deps, query) {
  const store = deps.store
  const core = deps.core || {}
  const full = store.getFullState()
  const daysRaw = Number(query.get('days'))
  const days = Number.isFinite(daysRaw) && daysRaw >= 1 ? Math.min(14, Math.round(daysRaw)) : 3
  const today = shanghaiDate()
  const fallbackWindow = { from: today, to: shanghaiDate(Date.now() + (days - 1) * 86400000) }
  if (typeof core.buildShoppingList !== 'function') {
    return json(200, {
      ok: true,
      window: fallbackWindow,
      groups: [],
      estimatedCost: 0,
      missingRecipes: [],
      note: '推荐内核未就绪',
    })
  }
  let result
  try {
    result = await core.buildShoppingList({
      plan: full.plan,
      days,
      servings: 1,
      profile: full.profile,
      phase: full.phase,
      meals: full.meals,
      // core.buildShoppingList 需要 catalog 才能把 state.plan.picks 的 dishId 换成价格，
      // 否则 estimatedCost 恒为 0；recipes 由 core 门面（index.js）注入，deps 也可覆盖。
      ...(deps.catalog !== undefined ? { catalog: deps.catalog } : { catalog: DISHES }),
      ...(Array.isArray(deps.recipes) ? { recipes: deps.recipes } : {}),
    })
  } catch (error) {
    return json(500, {
      ok: false,
      code: 'shopping-failed',
      message: error && typeof error.message === 'string' ? error.message.slice(0, 200) : '采买清单生成失败',
    })
  }
  const source = result && typeof result === 'object' ? result : {}
  return json(200, {
    ok: true,
    window: source.window && typeof source.window === 'object' ? source.window : fallbackWindow,
    groups: Array.isArray(source.groups) ? source.groups : [],
    estimatedCost: Number.isFinite(Number(source.estimatedCost)) ? Number(source.estimatedCost) : 0,
    missingRecipes: Array.isArray(source.missingRecipes) ? source.missingRecipes : [],
  })
}

/**
 * 读取 Node 请求体。
 *
 * @param {object} req Node IncomingMessage 或 `{ body }` 假对象
 * @returns {Promise<string>} 请求体文本
 * @throws {{ code: string }} 超过上限时抛出 `BODY_TOO_LARGE`
 */
async function readRequestBody(req) {
  if (req === null || req === undefined) return ''
  if (typeof req.body === 'string') return req.body
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'object' ? JSON.stringify(req.body) : String(req.body)
  }
  if (typeof req[Symbol.asyncIterator] !== 'function') return ''
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      const error = new Error('request body too large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 写 JSON 响应。
 *
 * @param {object} res Node ServerResponse 或假对象
 * @param {{ status: number, headers: object, body: object }} result 响应
 * @returns {void}
 */
function writeJson(res, result) {
  const body = JSON.stringify(result.body)
  if (res === null || res === undefined) return
  if (typeof res.writeHead === 'function') {
    res.writeHead(result.status, { ...result.headers, 'content-length': Buffer.byteLength(body) })
    res.end(body)
    return
  }
  res.statusCode = result.status
  if (typeof res.setHeader === 'function') {
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value)
    res.setHeader('content-length', Buffer.byteLength(body))
  }
  if (typeof res.end === 'function') res.end(body)
}

/**
 * 为某个 API 路径生成 Node HTTP handler（同一路径的多个方法共用）。
 *
 * @param {{ store: object, amap: object, core: object }} deps 依赖
 * @param {string} pathname 路径（用于信息兜底）
 * @returns {(req: object, res: object) => Promise<void>} handler
 */
function makeNodeHandler(deps, pathname) {
  return async function nodeHandler(req, res) {
    try {
      const rawBody = await readRequestBody(req)
      const result = await handleApiRequest(deps, {
        method: req && req.method ? req.method : 'GET',
        path: req && typeof req.url === 'string' && req.url !== '' ? req.url : pathname,
        headers: req && req.headers && typeof req.headers === 'object' ? req.headers : {},
        rawBody,
      })
      writeJson(res, result)
    } catch (error) {
      const tooLarge = error && error.code === 'BODY_TOO_LARGE'
      writeJson(res, tooLarge
        ? json(400, { ok: false, code: 'body-too-large', message: '请求体过大' })
        : json(500, { ok: false, code: 'internal-error', message: '服务器内部错误' }))
    }
  }
}

/**
 * 生成可直接注册到 `ctx.webServer.register()` 的路由列表。
 *
 * 说明：同一路径的 GET/POST（/state）与 POST/DELETE（/meals）各占一个方法级条目，
 * 共 8 条；注册时同一 path 只需要注册一次（handler 内部按 method 分发）。
 *
 * @param {{ store: object, amap: object, core: object }} deps 依赖
 * @returns {Array<{ kind: string, method: string, path: string, handler: Function }>} 路由
 */
export function createApiRoutes(deps) {
  if (!deps || !deps.store) throw new TypeError('createApiRoutes 需要注入 { store, amap, core }')
  const handlers = new Map()
  return API_ROUTES.map((entry) => {
    if (!handlers.has(entry.path)) handlers.set(entry.path, makeNodeHandler(deps, entry.path))
    return Object.freeze({
      kind: 'exact',
      method: entry.method,
      path: entry.path,
      handler: handlers.get(entry.path),
    })
  })
}
