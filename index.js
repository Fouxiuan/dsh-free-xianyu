/**
 * dsh-free-xianyu — Host half.
 *
 * Hosts the ai-goofish-monitor FastAPI backend as a managed child process,
 * exposes `goofish_*` agent tools, serves the same-origin plugin API, and
 * points the project's AI analysis at the Our Free Model local
 * OpenAI-compatible forward gateway.
 *
 * Host half only: the package declares no `dsh.client` entry, so nothing is
 * loaded into the browser during web boot. See README.md for the reason.
 *
 * @module dsh-free-xianyu
 */

import fs from 'node:fs'

import { Config, PLUGIN_ID, PLUGIN_VERSION, normalizeConfig } from './lib/config.js'
import { resolveDshHome, resolveProjectRoot, projectEnvFile } from './lib/paths.js'
import { createBackendManager } from './lib/backend.js'
import { createGoofishApi } from './lib/goofish-api.js'
import { ensureFrontend, inspectFrontend } from './lib/frontend.js'
import {
  discoverGateway,
  listGatewayModels,
  pickDefaultModel,
  syncAiEnv,
  readAiEnv,
} from './lib/gateway.js'
import { createRouteHandler } from './lib/routes.js'
import { createToolDefinitions } from './lib/tools.js'

export const name = PLUGIN_ID
export { Config }

const MODELS_CACHE_TTL_MS = 30000
const AUTO_START_DELAY_MS = 1500
const GATEWAY_HINT =
  'Our Free Model 本地网关未开启：打开 设置 → Our Free Model → 网关设置，开启本地网关后重试，或在本插件配置里手动填写 aiBaseURL / aiApiKey / aiModel。'

const VISION_PATTERN = /(vl|vision|gemini|gpt-4o|gpt-4\.1|gpt-5|claude|omni|qwen.*vl|glm.*v)/i

function isVisionModelId(model) {
  return VISION_PATTERN.test(String(model ?? ''))
}

/**
 * The console URL of a running backend, or '' when it is not reachable.
 * `src/app.py` serves the Vue build at `/`, so this is the address a user opens.
 */
function consoleURLOf(server) {
  const url = typeof server?.url === 'string' ? server.url.trim() : ''
  if (url === '') return ''
  return url.replace(/\/+$/, '') + '/'
}

function maskKey(key) {
  const text = String(key ?? '')
  if (text === '') return ''
  if (text.length <= 8) return '••••'
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

/**
 * @param {import('./lib/config.js').GoofishConfig} config
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const dshHome = resolveDshHome()
  const projectRoot = resolveProjectRoot(config.projectRoot)
  const envFile = projectEnvFile(projectRoot)

  const log = (...args) => {
    try { ctx.logger?.info?.(`dsh-free-xianyu: ${args.join(' ')}`) } catch { /* logging is optional */ }
  }
  const warn = (...args) => {
    try { ctx.logger?.warn?.(`dsh-free-xianyu: ${args.join(' ')}`) } catch { /* logging is optional */ }
  }

  /** @type {{ baseURL: string, apiKey: string, model: string, mode: string,
   *   gateway: object, modelsInfo: object, env: Record<string, string>,
   *   configured: boolean, error: string }} */
  let lastAi = {
    baseURL: '',
    apiKey: '',
    model: '',
    mode: 'unknown',
    gateway: { enabled: false, running: false, port: 0, source: 'unknown', settingsPath: '', error: '' },
    modelsInfo: { gatewayReady: false, source: 'none', models: [] },
    env: {},
    configured: false,
    error: '',
  }
  let lastAiError = ''
  let runtimeModel = ''
  let modelsCache = { key: '', at: 0, value: { gatewayReady: false, source: 'none', models: [] } }

  const backend = createBackendManager({ getConfig: () => config, projectRoot, log, warn })

  const api = () => createGoofishApi({ baseURL: backend.baseURL(), timeoutMs: config.requestTimeoutMs })

  function gatewayBaseURL(gateway) {
    if (typeof gateway?.baseURL === 'string' && gateway.baseURL !== '') return gateway.baseURL
    if (Number.isFinite(Number(gateway?.port)) && Number(gateway.port) > 0) {
      return `http://127.0.0.1:${Number(gateway.port)}/v1`
    }
    return ''
  }

  async function gatewayNow() {
    try {
      const gateway = await discoverGateway({ dshHome })
      return {
        settingsPath: gateway?.settingsPath ?? '',
        catalogPath: gateway?.catalogPath ?? '',
        enabled: gateway?.enabled === true,
        running: gateway?.running === true,
        port: Number(gateway?.port) > 0 ? Number(gateway.port) : 0,
        key: typeof gateway?.key === 'string' ? gateway.key : '',
        baseURL: gatewayBaseURL(gateway),
        source: gateway?.source ?? 'unknown',
        error: gateway?.error ?? '',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`gateway discovery failed: ${message}`)
      return {
        settingsPath: '',
        catalogPath: '',
        enabled: false,
        running: false,
        port: 0,
        key: '',
        baseURL: '',
        source: 'unavailable',
        error: message,
      }
    }
  }

  async function modelsFor(gateway, force = false) {
    const cacheKey = `${gateway.baseURL}|${maskKey(gateway.key)}|${gateway.catalogPath}`
    const fresh = Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS
    if (!force && modelsCache.key === cacheKey && fresh) return modelsCache.value
    let value
    try {
      value = await listGatewayModels({
        baseURL: gateway.running ? gateway.baseURL : '',
        apiKey: gateway.key,
        catalogPath: gateway.catalogPath,
      })
    } catch (error) {
      value = {
        gatewayReady: false,
        source: 'none',
        models: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
    modelsCache = { key: cacheKey, at: Date.now(), value }
    return value
  }

  async function inspectAi({ modelOverride = '', forceModels = false } = {}) {
    const env = (() => {
      try { return readAiEnv({ projectRoot }) } catch { return {} }
    })()
    const gateway = await gatewayNow()
    const modelsInfo = await modelsFor(gateway, forceModels)
    const configuredBase = config.aiBaseURL || env.OPENAI_BASE_URL || ''
    const configuredKey = config.aiApiKey || env.OPENAI_API_KEY || ''
    const configuredModel = String(modelOverride || runtimeModel || config.aiModel || env.OPENAI_MODEL_NAME || '').trim()

    if (gateway.running && gateway.baseURL !== '') {
      const model = configuredModel !== '' ? configuredModel : pickDefaultModel(modelsInfo.models)
      const ai = {
        baseURL: gateway.baseURL,
        apiKey: gateway.key,
        model,
        mode: 'gateway',
        gateway,
        modelsInfo,
        env,
        configured: model !== '',
        error: model === '' ? 'Our Free Model 网关未返回可用模型（请检查网关设置或模型清单）。' : '',
      }
      lastAi = ai
      lastAiError = ''
      return ai
    }

    if (configuredBase !== '') {
      const ai = {
        baseURL: configuredBase,
        apiKey: configuredKey,
        model: configuredModel,
        mode: 'manual',
        gateway,
        modelsInfo,
        env,
        configured: configuredModel !== '',
        error: configuredModel === '' ? '已配置 OPENAI_BASE_URL，但缺少 OPENAI_MODEL_NAME。' : '',
      }
      lastAi = ai
      lastAiError = ''
      return ai
    }

    const ai = {
      baseURL: '',
      apiKey: '',
      model: '',
      mode: 'none',
      gateway,
      modelsInfo,
      env,
      configured: false,
      error: gateway.running ? 'Our Free Model 网关正在运行，但未取得可用模型。' : GATEWAY_HINT,
    }
    lastAi = ai
    if (ai.error) lastAiError = ai.error
    return ai
  }

  function publicAi(ai) {
    const models = Array.isArray(ai.modelsInfo?.models) ? ai.modelsInfo.models : []
    const selected = ai.model !== '' ? ai.model : String(ai.env?.OPENAI_MODEL_NAME ?? '')
    const row = models.find((model) => model.id === selected)
    const vision = row ? row.vision === true : isVisionModelId(selected)
    return {
      configured: ai.configured,
      mode: ai.mode,
      baseURL: ai.baseURL,
      baseURLMasked: ai.baseURL,
      apiKeyMasked: maskKey(ai.apiKey),
      model: selected,
      vision: Boolean(vision),
      gateway: {
        enabled: ai.gateway?.enabled === true,
        running: ai.gateway?.running === true,
        port: ai.gateway?.port ?? 0,
        source: ai.gateway?.source ?? 'unknown',
        settingsPath: ai.gateway?.settingsPath ?? '',
        error: ai.gateway?.error ?? '',
      },
      modelsSource: ai.modelsInfo?.source ?? 'none',
      envManaged: config.manageEnv,
      error: ai.error ?? '',
    }
  }

  async function syncProjectEnv(ai) {
    if (!config.manageEnv) return { skipped: true, reason: 'manageEnv=false' }
    if (!ai.baseURL || !ai.model) return { skipped: true, reason: ai.error || 'AI is not configured' }
    try {
      const sync = await syncAiEnv({
        projectRoot,
        baseURL: ai.baseURL,
        apiKey: ai.apiKey || 'not-needed',
        model: ai.model,
      })
      if (sync?.changed) log(`wrote AI settings into ${sync.envPath ?? envFile}`)
      return sync ?? { skipped: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`could not write .env: ${message}`)
      return { skipped: false, error: message }
    }
  }

  function backendEnv(ai) {
    const env = {}
    if (ai.baseURL) env.OPENAI_BASE_URL = ai.baseURL
    if (ai.model) env.OPENAI_MODEL_NAME = ai.model
    if (ai.apiKey) env.OPENAI_API_KEY = ai.apiKey
    return env
  }

  /**
   * Make `dist/` exist before the backend starts.
   *
   * `src/app.py` mounts `/assets` only when `dist/` is already there, and every
   * non-API route serves `dist/index.html`; starting without a build leaves the
   * console at 500 while the API stays fine. `autoBuildFrontend` keeps that from
   * happening silently, and `buildFrontend=false` opts out entirely.
   */
  async function prepareFrontend(options = {}) {
    const force = options.force === true
    if (!config.buildFrontend) {
      return { skipped: true, reason: 'buildFrontend=false', state: inspectFrontend(projectRoot) }
    }
    if (!force && !config.autoBuildFrontend) {
      return { skipped: true, reason: 'autoBuildFrontend=false', state: inspectFrontend(projectRoot) }
    }
    let result
    try {
      result = await ensureFrontend({
        projectRoot,
        force,
        install: config.frontendInstall,
        log,
        warn,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`frontend preparation failed: ${message}`)
      return { skipped: true, reason: message, state: inspectFrontend(projectRoot) }
    }
    return { ...result, state: inspectFrontend(projectRoot) }
  }

  async function startServer(options = {}) {
    const ai = await inspectAi()
    const sync = await syncProjectEnv(ai)
    const frontend = await prepareFrontend({ force: options.rebuildFrontend === true })
    try {
      const server = await backend.start({ extraEnv: backendEnv(ai) })
      log(`backend ${server.healthy ? 'healthy' : 'started'} on ${server.url}`)
      return { server, ai: publicAi(ai), envSync: sync, frontend, consoleURL: consoleURLOf(server) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastAiError = message
      throw error
    }
  }

  async function stopServer() {
    const server = await backend.stop()
    return { server }
  }

  async function restartServer() {
    await backend.stop()
    return startServer()
  }

  async function ensureServer() {
    const current = await backend.status()
    if (current.healthy) return current
    const started = await startServer()
    return started.server
  }

  function getStatus() {
    return (async () => {
      const [server, ai] = await Promise.all([backend.status(), inspectAi()])
      const frontend = inspectFrontend(projectRoot)
      const project = {
        root: projectRoot,
        python: config.pythonPath,
        envFile,
        envExists: fs.existsSync(envFile),
        configured: config,
      }
      return {
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        server,
        console: {
          url: consoleURLOf(server),
          served: server.healthy && frontend.built,
          frontend,
          autoBuild: config.buildFrontend && config.autoBuildFrontend,
        },
        project: { root: project.root, python: project.python, envFile: project.envFile, envExists: project.envExists },
        ai: { ...publicAi(ai), lastError: lastAiError },
      }
    })()
  }

  /** Build (or rebuild) the Vue console without touching the backend. */
  async function buildConsole(options = {}) {
    const frontend = await prepareFrontend({ force: options.force === true })
    const server = await backend.status()
    return {
      frontend,
      console: { url: consoleURLOf(server), served: server.healthy && frontend.state?.built === true },
      restarted: false,
    }
  }

  /** Rebuild the console and restart the backend so the new assets are mounted. */
  async function rebuildConsole() {
    const frontend = await prepareFrontend({ force: true })
    let restarted = false
    const current = await backend.status()
    if (current.healthy) {
      await backend.stop()
      await startServer()
      restarted = true
    }
    const server = await backend.status()
    return {
      frontend,
      console: { url: consoleURLOf(server), served: server.healthy && frontend.state?.built === true },
      restarted,
    }
  }

  async function listAiModels() {
    const ai = await inspectAi({ forceModels: true })
    const models = Array.isArray(ai.modelsInfo?.models) ? ai.modelsInfo.models : []
    const selected =
      String(runtimeModel || config.aiModel || ai.env?.OPENAI_MODEL_NAME || '').trim() || pickDefaultModel(models)
    return {
      gatewayReady: ai.gateway?.running === true,
      source: ai.modelsInfo?.source ?? 'none',
      models,
      selected,
      gateway: publicAi(ai).gateway,
      error: ai.modelsInfo?.error ?? ai.error ?? '',
    }
  }

  async function applyAi(options = {}) {
    const model = typeof options.model === 'string' ? options.model.trim() : ''
    const ai = await inspectAi({ modelOverride: model, forceModels: true })
    if (!ai.baseURL || !ai.model) {
      throw new Error(ai.error || '没有可用的 AI 网关或模型')
    }
    if (model !== '') runtimeModel = model
    const sync = await syncProjectEnv(ai)
    let restarted = false
    const current = await backend.status()
    if (current.healthy) {
      await backend.stop()
      await startServer()
      restarted = true
    }
    return {
      applied: Boolean(ai.model) && (sync?.skipped === true ? true : sync?.error === undefined),
      model: ai.model,
      baseURL: ai.baseURL,
      ai: publicAi(ai),
      envSync: sync?.skipped === true ? sync : { envPath: sync?.envPath, changed: sync?.changed === true, backupPath: sync?.backupPath ?? null },
      restarted,
    }
  }

  const routeDeps = {
    status: getStatus,
    startServer: (options) => startServer(options),
    stopServer,
    api,
    listAiModels,
    applyAi,
    buildConsole,
    rebuildConsole,
    log,
  }

  const toolDeps = {
    getStatus,
    startServer,
    stopServer,
    restartServer,
    ensureServer,
    api,
    listAiModels,
    applyAi,
    buildConsole,
    rebuildConsole,
  }

  ctx.effect(() => {
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      try { backend.dispose() } catch (error) { warn(`backend dispose failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }, 'dsh-free-xianyu: managed backend')

  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => {
      const disposers = createToolDefinitions(toolDeps).map((definition) => scoped.tools.register(definition))
      log(`registered ${disposers.length} goofish tools`)
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* already disposed */ }
        }
      }
    }, 'dsh-free-xianyu: tools')
  })

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: '/api/dsh-free-xianyu',
          handler: createRouteHandler({ ctx: scoped, deps: routeDeps }),
        }),
      'dsh-free-xianyu: routes',
    )
  })

  if (config.autoStart) {
    const timer = setTimeout(() => {
      void ensureServer()
        .then(() => log('auto-start finished'))
        .catch((error) => warn(`auto-start failed: ${error instanceof Error ? error.message : String(error)}`))
    }, AUTO_START_DELAY_MS)
    ctx.effect(() => () => clearTimeout(timer), 'dsh-free-xianyu: auto-start timer')
  }

  log(`loaded for project ${projectRoot} (port ${config.serverPort}, autoStart=${config.autoStart})`)
}
