/**
 * 「今天吃什么」client 半 —— host HTTP API 封装。
 *
 * 所有请求走同源绝对路径 `/dsh-today-eat/api/...`（DSH Web GUI 的 host 路由），
 * 统一处理：rev 冲突（409）、404/网络错误 → offline 标记、非 JSON 响应（插件未装）。
 */

/** API 前缀（同源绝对路径）。 */
export const API_BASE = '/dsh-today-eat/api'

/** 请求超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * API 错误。
 */
export class ApiError extends Error {
  /**
   * @param {{ code?: string, message?: string, status?: number, payload?: unknown, offline?: boolean }} options 参数
   */
  constructor(options = {}) {
    super(options.message || options.code || '请求失败')
    this.name = 'ApiError'
    this.code = options.code || 'unknown'
    this.status = typeof options.status === 'number' ? options.status : 0
    this.payload = options.payload ?? null
    this.offline = options.offline === true
  }
}

/**
 * 判断是否「接口不可用」，应该切本地模式。
 *
 * @param {unknown} error 错误
 * @returns {boolean} 是否离线
 */
export function isOfflineError(error) {
  if (error === null || error === undefined) return false
  return error.offline === true || error.status === 404
}

/**
 * 判断是否 rev 冲突。
 *
 * @param {unknown} error 错误
 * @returns {boolean} 是否冲突
 */
export function isRevConflict(error) {
  return error instanceof ApiError && (error.status === 409 || error.code === 'rev-mismatch')
}

/**
 * 拼接 query。
 *
 * @param {Record<string, unknown> | undefined} query query 参数
 * @returns {string} query 串
 */
function buildQuery(query) {
  if (query === null || query === undefined) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * 从响应中解析 JSON，并统一抛出 ApiError。
 *
 * @param {Response} response fetch 响应
 * @returns {Promise<object>} JSON 体
 */
async function readResponse(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  let body = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (response.ok === false) {
    if (response.status === 404) {
      throw new ApiError({
        code: (body && body.code) || 'not-found',
        message: (body && body.message) || '本地服务未就绪（404）',
        status: 404,
        payload: body,
        offline: true,
      })
    }
    if (response.status === 409) {
      throw new ApiError({
        code: (body && body.code) || 'rev-mismatch',
        message: (body && body.message) || '数据版本冲突，正在重新同步',
        status: 409,
        payload: body,
      })
    }
    throw new ApiError({
      code: (body && body.code) || `http-${response.status}`,
      message: (body && body.message) || `服务返回 ${response.status}`,
      status: response.status,
      payload: body,
    })
  }
  if (body === null || typeof body !== 'object') {
    // 典型场景：插件未安装时，Web 服务器把未知路径回退成 index.html。
    throw new ApiError({
      code: 'bad-json',
      message: '接口返回的不是 JSON，插件 host 半可能未就绪',
      status: response.status,
      offline: true,
    })
  }
  return body
}

/**
 * 创建 API 客户端。
 *
 * @param {{ fetchImpl?: Function }} [options={}] 选项（测试可注入 fetch）
 * @returns {object} API 客户端
 */
export function createApi(options = {}) {
  const globalFetch = typeof fetch === 'function' ? fetch : null
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalFetch
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS

  /**
   * 发一个 JSON 请求。
   *
   * @param {string} path 路径（不含 API_BASE）
   * @param {{ method?: string, body?: unknown, query?: Record<string, unknown> }} [request={}] 请求参数
   * @returns {Promise<object>} 响应 JSON
   */
  async function request(path, requestOptions = {}) {
    if (fetchImpl === null) {
      throw new ApiError({ code: 'no-fetch', message: '当前环境不支持 fetch', offline: true })
    }
    const method = requestOptions.method || 'GET'
    const url = `${API_BASE}${path}${buildQuery(requestOptions.query)}`
    const init = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {},
    }
    if (requestOptions.body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(requestOptions.body)
    }
    if (typeof AbortController === 'function' && timeoutMs > 0) {
      const controller = new AbortController()
      init.signal = controller.signal
      const timer = setTimeout(() => {
        try {
          controller.abort()
        } catch {
          // 忽略
        }
      }, timeoutMs)
      try {
        const response = await fetchImpl(url, init)
        return await readResponse(response)
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw new ApiError({ code: 'network', message: '连不上本地服务，已切本地模式', status: 0, offline: true })
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      const response = await fetchImpl(url, init)
      return await readResponse(response)
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError({ code: 'network', message: '连不上本地服务，已切本地模式', status: 0, offline: true })
    }
  }

  return {
    /** GET /state */
    getState() {
      return request('/state')
    },
    /** POST /state */
    postState(rev, patch) {
      return request('/state', { method: 'POST', body: { rev, patch } })
    },
    /** POST /meals */
    postMeal(rev, meal) {
      return request('/meals', { method: 'POST', body: { rev, meal } })
    },
    /** DELETE /meals?id= */
    deleteMeal(id) {
      return request('/meals', { method: 'DELETE', query: { id } })
    },
    /** POST /plan */
    postPlan(rev, plan) {
      return request('/plan', { method: 'POST', body: { rev, plan } })
    },
    /** POST /amap-key */
    postAmapKey(key) {
      return request('/amap-key', { method: 'POST', body: { key } })
    },
    /** GET /nearby */
    getNearby(query) {
      return request('/nearby', { query: query || {} })
    },
    /** GET /shopping */
    getShopping(days) {
      return request('/shopping', { query: { days: days === undefined ? 3 : days } })
    },
  }
}
