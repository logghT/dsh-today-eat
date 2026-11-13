/**
 * lib/api.js 单元测试：路由表、鉴权、rev 409、nearby/shopping、Node handler 适配。
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'

import { API_ROUTES, checkRequest, createApiRoutes, handleApiRequest, isLoopbackHostname } from '../../lib/api.js'
import { cleanupTempDirs, createStubAmap, createStubCore, makeRequest, makeStore } from './helpers.mjs'

after(cleanupTempDirs)

/**
 * 新建一套 API 依赖。
 *
 * @param {object} [overrides] 覆盖项
 * @returns {object} deps
 */
function makeDeps(overrides = {}) {
  return {
    store: makeStore('api'),
    amap: createStubAmap(),
    core: createStubCore(),
    ...overrides,
  }
}

/**
 * 调一次 API。
 *
 * @param {object} deps 依赖
 * @param {object} overrides 请求覆盖
 * @returns {Promise<{status:number, body:object, headers:object}>} 响应
 */
async function call(deps, overrides = {}) {
  return handleApiRequest(deps, makeRequest(overrides))
}

test('路由表：8 条方法级路由，6 个注册路径', () => {
  assert.equal(API_ROUTES.length, 8)
  assert.deepEqual(API_ROUTES.map((route) => `${route.method} ${route.path}`), [
    'GET /dsh-today-eat/api/state',
    'POST /dsh-today-eat/api/state',
    'POST /dsh-today-eat/api/meals',
    'DELETE /dsh-today-eat/api/meals',
    'POST /dsh-today-eat/api/plan',
    'POST /dsh-today-eat/api/amap-key',
    'GET /dsh-today-eat/api/nearby',
    'GET /dsh-today-eat/api/shopping',
  ])
  const routes = createApiRoutes(makeDeps())
  assert.equal(routes.length, 8)
  assert.equal(new Set(routes.map((route) => route.path)).size, 6)
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
  assert.throws(() => createApiRoutes(), /store/)
})

test('回环主机判断', () => {
  for (const host of ['localhost', 'LOCALHOST', 'foo.localhost', '127.0.0.1', '127.9.9.9', '[::1]']) {
    assert.equal(isLoopbackHostname(host), true, host)
  }
  for (const host of ['', '192.168.1.5', '127.0.0.1.evil.com', '::2', 'example.com', '127.0.0.256']) {
    assert.equal(isLoopbackHostname(host), false, host)
  }
})

test('鉴权：跨源 / 非回环写 / 非 JSON / 缺 Host / 非法 Origin / 跨站', () => {
  const base = { host: '127.0.0.1:49396', 'content-type': 'application/json' }
  const cases = [
    [{ host: '127.0.0.1:1', origin: 'http://evil.example', 'content-type': 'application/json' }, 'POST', 403, 'cross-origin'],
    [{ host: '192.168.1.5:1234', 'content-type': 'application/json' }, 'POST', 403, 'non-loopback'],
    [{ host: '127.0.0.1:1', 'content-type': 'text/plain' }, 'POST', 415, 'unsupported-media-type'],
    [{ origin: 'http://127.0.0.1:1' }, 'GET', 403, 'missing-host'],
    [{ host: '127.0.0.1:1', origin: 'not-a-url' }, 'GET', 403, 'invalid-origin'],
    [{ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' }, 'GET', 403, 'cross-site'],
    [{ host: '127.0.0.1:1', origin: 'null' }, 'GET', undefined, null],
  ]
  for (const [headers, method, status, code] of cases) {
    const rejection = checkRequest(method, headers, method === 'POST' ? '{}' : '')
    if (status === undefined) assert.equal(rejection, null, JSON.stringify(headers))
    else {
      assert.equal(rejection.status, status, JSON.stringify(headers))
      assert.equal(rejection.body.code, code)
    }
  }
  assert.equal(checkRequest('GET', base), null)
})

test('鉴权：无 Origin 的 curl GET 允许；写接口的 DELETE 无 body 允许', () => {
  assert.equal(checkRequest('GET', { host: '127.0.0.1:1' }), null)
  assert.equal(checkRequest('DELETE', { host: '127.0.0.1:1' }, ''), null)
  assert.equal(checkRequest('DELETE', { host: '127.0.0.1:1', 'content-type': 'text/plain' }, 'x').status, 415)
})

test('GET /state：返回掩码状态与 hasAmapKey', async () => {
  const deps = makeDeps()
  deps.store.setAmapKey('secret-key')
  const result = await call(deps)
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.state.version, 3)
  assert.equal(result.body.state.settings.amapKey, '')
  assert.equal(result.body.hasAmapKey, true)
  assert.match(String(result.headers['content-type']), /application\/json/)
})

test('POST /state：patch 成功 rev+1；旧 rev 409；patch 越界 400', async () => {
  const deps = makeDeps()
  const rev = (await call(deps)).body.state.rev
  const patched = await call(deps, { method: 'POST', rawBody: JSON.stringify({ rev, patch: { ui: { collapsed: true } } }) })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.ok, true)
  assert.equal(patched.body.rev, rev + 1)
  assert.equal(patched.body.state.ui.collapsed, true)
  const conflict = await call(deps, { method: 'POST', rawBody: JSON.stringify({ rev, patch: { ui: { collapsed: false } } }) })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, 'rev-mismatch')
  assert.equal(conflict.body.state.settings.amapKey, '')
  const forbidden = await call(deps, { method: 'POST', rawBody: JSON.stringify({ rev: deps.store.getRev(), patch: { plan: {} } }) })
  assert.equal(forbidden.status, 400)
  assert.equal(forbidden.body.code, 'patch-not-allowed')
  const missingPatch = await call(deps, { method: 'POST', rawBody: JSON.stringify({ rev: deps.store.getRev() }) })
  assert.equal(missingPatch.status, 400)
  assert.equal(missingPatch.body.code, 'patch-required')
  const badJson = await call(deps, { method: 'POST', rawBody: '{oops' })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.code, 'invalid-json')
})

test('POST /meals + DELETE /meals：写入/替换/删除/404/409', async () => {
  const deps = makeDeps()
  const rev = deps.store.getRev()
  const added = await call(deps, { method: 'POST', path: '/dsh-today-eat/api/meals', rawBody: JSON.stringify({ rev, meal: { meal: 'lunch', dishName: '酸汤鱼', rating: 1, kcal: 380 } }) })
  assert.equal(added.status, 200)
  assert.equal(added.body.state.meals.length, 1)
  const replaced = await call(deps, {
    method: 'POST',
    path: '/dsh-today-eat/api/meals',
    rawBody: JSON.stringify({ rev: added.body.rev, meal: { meal: 'lunch', dishName: '换一道', rating: -1 } }),
  })
  assert.equal(replaced.status, 200)
  assert.equal(replaced.body.state.meals.length, 1)
  const replacedId = replaced.body.state.meals[0].id
  const stale = await call(deps, { method: 'POST', path: '/dsh-today-eat/api/meals', rawBody: JSON.stringify({ rev, meal: { meal: 'dinner' } }) })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'rev-mismatch')
  const invalid = await call(deps, { method: 'POST', path: '/dsh-today-eat/api/meals', rawBody: JSON.stringify({ rev: deps.store.getRev(), meal: 'x' }) })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.code, 'invalid-meal')
  const deleted = await call(deps, {
    method: 'DELETE',
    path: `/dsh-today-eat/api/meals?id=${encodeURIComponent(replacedId)}`,
    rawBody: '',
    headers: { host: '127.0.0.1:49396', origin: 'http://127.0.0.1:49396' },
  })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.state.meals.length, 0)
  const notFound = await call(deps, {
    method: 'DELETE',
    path: '/dsh-today-eat/api/meals?id=nope',
    headers: { host: '127.0.0.1:49396' },
  })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.body.code, 'meal-not-found')
})

test('POST /plan：写入计划；rev 冲突 409', async () => {
  const deps = makeDeps()
  const rev = deps.store.getRev()
  const result = await call(deps, {
    method: 'POST',
    path: '/dsh-today-eat/api/plan',
    rawBody: JSON.stringify({ rev, plan: { start: '2026-11-09', seed: 7, picks: [{ date: '2026-11-09', meal: 'lunch', dishId: 'stub-sour-fish', mode: 'home' }] } }),
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.state.plan.picks.length, 1)
  const conflict = await call(deps, { method: 'POST', path: '/dsh-today-eat/api/plan', rawBody: JSON.stringify({ rev, plan: {} }) })
  assert.equal(conflict.status, 409)
})

test('POST /amap-key：保存 / 清除 / 掩码', async () => {
  const deps = makeDeps()
  const saved = await call(deps, { method: 'POST', path: '/dsh-today-eat/api/amap-key', rawBody: JSON.stringify({ key: 'abc123' }) })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.hasAmapKey, true)
  const state = await call(deps)
  assert.equal(state.body.hasAmapKey, true)
  assert.equal(state.body.state.settings.amapKey, '')
  const cleared = await call(deps, { method: 'POST', path: '/dsh-today-eat/api/amap-key', rawBody: JSON.stringify({ key: '' }) })
  assert.equal(cleared.body.hasAmapKey, false)
  const invalid = await call(deps, { method: 'POST', path: '/dsh-today-eat/api/amap-key', rawBody: JSON.stringify({}) })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.code, 'key-required')
})

test('GET /nearby：无 Key → amap-key-missing + fallbackQueries（HTTP 200）', async () => {
  const deps = makeDeps()
  const result = await call(deps, { method: 'GET', path: '/dsh-today-eat/api/nearby?meal=lunch&radius=1500' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'amap-key-missing')
  assert.ok(Array.isArray(result.body.fallbackQueries) && result.body.fallbackQueries.length > 0)
})

test('GET /nearby：有 Key → items/suggestions/weather', async () => {
  const deps = makeDeps()
  deps.store.setAmapKey('k-123')
  const result = await call(deps, { method: 'GET', path: '/dsh-today-eat/api/nearby?meal=lunch' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.items.length, 2)
  assert.equal(result.body.items[0].name, '川味小馆')
  assert.equal(result.body.weather.dayWeather, '多云')
})

test('GET /nearby：高德抛错不返回 500（结构化 amap-request-failed）', async () => {
  const deps = makeDeps({
    amap: {
      async searchNearby() {
        throw new Error('network down')
      },
      buildFallbackQueries: () => ['兜底搜索'],
    },
  })
  deps.store.setAmapKey('k-123')
  const result = await call(deps, { method: 'GET', path: '/dsh-today-eat/api/nearby' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'amap-request-failed')
  assert.ok(result.body.fallbackQueries.length > 0)
})

test('GET /shopping：window/groups/estimatedCost/missingRecipes', async () => {
  const deps = makeDeps()
  const result = await call(deps, { method: 'GET', path: '/dsh-today-eat/api/shopping?days=3' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.groups[0].group, '蔬菜')
  assert.equal(result.body.estimatedCost, 18)
  assert.deepEqual(result.body.missingRecipes, [])
  assert.ok(result.body.window.from)
  const noCore = makeDeps({ core: {} })
  const fallback = await call(noCore, { method: 'GET', path: '/dsh-today-eat/api/shopping' })
  assert.equal(fallback.status, 200)
  assert.deepEqual(fallback.body.groups, [])
})

test('路由错误：405 / 404 / 未匹配方法', async () => {
  const deps = makeDeps()
  const methodNotAllowed = await call(deps, { method: 'PUT', rawBody: '{}' })
  assert.equal(methodNotAllowed.status, 405)
  assert.equal(methodNotAllowed.body.code, 'method-not-allowed')
  assert.match(String(methodNotAllowed.headers.allow), /GET/)
  const notFound = await call(deps, { method: 'GET', path: '/dsh-today-eat/api/nope' })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.body.code, 'not-found')
})

test('Node handler 适配：GET /state 写入状态码与 JSON body', async () => {
  const deps = makeDeps()
  const routes = createApiRoutes(deps)
  const route = routes.find((item) => item.method === 'GET' && item.path === '/dsh-today-eat/api/state')
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); return this },
    setHeader(name, value) { this.headers[name] = value },
    end(chunk) { if (chunk !== undefined) this.body += chunk },
  }
  await route.handler({ method: 'GET', url: '/dsh-today-eat/api/state', headers: { host: '127.0.0.1:49396' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.match(String(res.headers['content-type']), /application\/json/)
})

test('Node handler 适配：POST 读取 req.body 字符串（假 req）', async () => {
  const deps = makeDeps()
  const routes = createApiRoutes(deps)
  const route = routes.find((item) => item.method === 'POST' && item.path === '/dsh-today-eat/api/state')
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status) { this.statusCode = status; return this },
    setHeader() {},
    end(chunk) { if (chunk !== undefined) this.body += chunk },
  }
  await route.handler({
    method: 'POST',
    url: '/dsh-today-eat/api/state',
    headers: { host: '127.0.0.1:49396', 'content-type': 'application/json' },
    body: JSON.stringify({ rev: deps.store.getRev(), patch: { ui: { collapsed: true } } }),
  }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).state.ui.collapsed, true)
})
