/**
 * Same-origin HTTP API for the browser half.
 *
 * The plugin's route prefix is longer than the kernel's `/api`, so webServer
 * dispatch reaches this handler before the connection service's own admission
 * check. Every request is therefore fenced here with `connection.requestRejection`,
 * exactly like the shipped `our-free-model` plugin does, so the page is never
 * weaker than the rest of the app.
 *
 * @module lib/routes
 */

const PREFIX = '/api/dsh-free-xianyu'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function send(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function hostIsLoopback(req) {
  const raw = String(req.headers?.host ?? '').trim().toLowerCase()
  if (raw === '') return false
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
  return LOOPBACK_HOSTS.has(host)
}

/**
 * @param {{ get?: (name: string) => any }} ctx
 * @param {import('node:http').IncomingMessage} req
 * @returns {number | undefined} rejection status
 */
function rejectionStatus(ctx, req) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection && typeof connection.requestRejection === 'function') {
      return connection.requestRejection(req) ?? undefined
    }
  } catch {
    // Never fall through to "allowed" when a mounted service fails.
    return 503
  }
  return hostIsLoopback(req) ? undefined : 403
}

async function readJson(req, limitBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('request body must be a JSON object')
    }
    return value
  } catch (error) {
    const wrapped = new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`)
    wrapped.status = 400
    throw wrapped
  }
}

function intParam(searchParams, name, fallback, { min, max } = {}) {
  const raw = searchParams.get(name)
  if (raw === null || raw.trim() === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return fallback
  if (min !== undefined && value < min) return fallback
  if (max !== undefined && value > max) return fallback
  return value
}

/**
 * @param {{ ctx: object, deps: {
 *   status: () => Promise<object>,
 *   startServer: (extraEnv?: Record<string, string>) => Promise<object>,
 *   stopServer: () => Promise<object>,
 *   api: () => any,
 *   statusAi: () => Promise<object>,
 *   listAiModels: () => Promise<object>,
 *   applyAi: (options: { model?: string }) => Promise<object>,
 *   buildConsole: (options?: { force?: boolean }) => Promise<object>,
 *   rebuildConsole: () => Promise<object>,
 *   runtimeAction: (options?: { action?: string, force?: boolean }) => Promise<object>,
 *   log?: (...args: unknown[]) => void,
 * } }} options
 */
export function createRouteHandler(options) {
  const { ctx, deps } = options
  const log = deps.log ?? (() => {})

  return async function handler(req, res) {
    const rejection = rejectionStatus(ctx, req)
    if (rejection !== undefined) {
      send(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'admission unavailable' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      send(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      send(res, 400, { ok: false, error: 'invalid request URL' })
      return
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const routePath = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) || '/' : pathname
    const search = url.searchParams

    try {
      if (req.method === 'GET' && (routePath === '/' || routePath === '/health')) {
        send(res, 200, { ok: true, plugin: 'dsh-free-xianyu', routes: true })
        return
      }

      if (req.method === 'GET' && routePath === '/status') {
        send(res, 200, { ok: true, ...(await deps.status()) })
        return
      }

      if (req.method === 'GET' && routePath === '/console') {
        const status = await deps.status()
        send(res, 200, { ok: true, console: status.console ?? null, server: status.server ?? null, project: status.project ?? null })
        return
      }

      if (req.method === 'POST' && routePath === '/console/build') {
        const body = await readJson(req)
        const result = body?.restart === true ? await deps.rebuildConsole() : await deps.buildConsole({ force: body?.force === true })
        send(res, 200, { ok: true, ...result })
        return
      }

      if (req.method === 'GET' && routePath === '/runtime') {
        send(res, 200, { ok: true, ...(await deps.runtimeAction({ action: 'status' })) })
        return
      }

      if (req.method === 'POST' && routePath === '/runtime/setup') {
        const body = await readJson(req)
        send(res, 200, { ok: true, ...(await deps.runtimeAction({ action: 'setup', force: body?.force === true })) })
        return
      }

      if (req.method === 'POST' && routePath === '/server/start') {
        const body = await readJson(req)
        send(res, 200, { ok: true, ...(await deps.startServer({ rebuildFrontend: body?.rebuildFrontend === true, env: body?.env })) })
        return
      }

      if (req.method === 'POST' && routePath === '/server/stop') {
        send(res, 200, { ok: true, ...(await deps.stopServer()) })
        return
      }

      if (req.method === 'GET' && routePath === '/tasks') {
        const api = deps.api()
        const tasks = await api.listTasks()
        send(res, 200, { ok: true, tasks })
        return
      }

      if (req.method === 'POST' && routePath === '/tasks/run') {
        const body = await readJson(req)
        const taskId = Number(body?.taskId)
        if (!Number.isInteger(taskId) || taskId < 0) throw badRequest('taskId must be a non-negative integer')
        // The backend start route accepts no body/query; debug limiting is a
        // server-side env (SPIDER_DEBUG_LIMIT) read when the spider spawns.
        const result = await deps.api().startTask(taskId)
        send(res, 200, { ok: true, result })
        return
      }

      if (req.method === 'POST' && routePath === '/tasks/stop') {
        const body = await readJson(req)
        const taskId = Number(body?.taskId)
        if (!Number.isInteger(taskId) || taskId < 0) throw badRequest('taskId must be a non-negative integer')
        const result = await deps.api().stopTask(taskId)
        send(res, 200, { ok: true, result })
        return
      }

      if (req.method === 'GET' && routePath === '/results/files') {
        const files = await deps.api().listResultFiles()
        const list = Array.isArray(files) ? files : (files?.files ?? [])
        send(res, 200, { ok: true, files: list, selected: list[0] ?? '' })
        return
      }

      if (req.method === 'GET' && routePath === '/results/file') {
        const name = String(search.get('name') ?? '').trim()
        if (name === '') throw badRequest('name is required')
        const limit = intParam(search, 'limit', 10, { min: 1, max: 100 })
        const payload = await deps.api().getResults(name, { limit, page: 1 })
        const items = Array.isArray(payload) ? payload : (payload?.items ?? payload?.results ?? [])
        const total = Array.isArray(payload) ? items.length : Number(payload?.total_items ?? payload?.total ?? items.length)
        send(res, 200, { ok: true, file: name, items, total })
        return
      }

      if (req.method === 'GET' && routePath === '/logs') {
        const rawTaskId = search.get('taskId')
        const taskId = rawTaskId === null || rawTaskId.trim() === '' ? null : Number.parseInt(rawTaskId, 10)
        const lines = intParam(search, 'lines', 80, { min: 1, max: 1000 })
        if (taskId === null || !Number.isInteger(taskId) || taskId < 0) {
          send(res, 200, { ok: true, taskId: null, content: '', hasMore: false })
          return
        }
        const payload = await deps.api().tailLogs({ taskId, limitLines: lines })
        send(res, 200, { ok: true, taskId, content: payload?.content ?? '', hasMore: payload?.has_more === true })
        return
      }

      if (req.method === 'GET' && routePath === '/ai/models') {
        send(res, 200, { ok: true, ...(await deps.listAiModels()) })
        return
      }

      if (req.method === 'POST' && routePath === '/ai/apply') {
        const body = await readJson(req)
        const model = typeof body?.model === 'string' ? body.model.trim() : ''
        send(res, 200, { ok: true, ...(await deps.applyAi({ model })) })
        return
      }

      send(res, 404, { ok: false, error: `unknown route ${routePath}` })
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      if (status >= 500) log(`route ${routePath} failed: ${message}`)
      send(res, status, { ok: false, error: message })
    }
  }
}

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}
