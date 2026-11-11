/**
 * Our Free Model bridge: discover the plugin's local OpenAI-compatible forward
 * listener, list its models (with vision capability), and write the project
 * `.env` so ai-goofish-monitor calls that gateway.
 * OWNED BY: gateway-bridge teammate — implementation follows
 * `.agents/notes/contract.md` (section "lib/gateway.js").
 *
 * Everything here is read-only with respect to the Our Free Model plugin: the
 * only writes ever performed are `<projectRoot>/.env` (+ `.env.bak`), and the
 * caller decides when that happens.
 *
 * Plain ESM, node builtins + global `fetch` only — the linked DSH checkout has
 * no resolvable `node_modules`, so this module must never import a package.
 *
 * Data shapes read from `<DSH_HOME or ~/.dsh>/our-free-model/`:
 * - `settings.json`: `{ forward: { enabled, host, port }, forwardKey }` (plus
 *   many unrelated settings this module ignores).
 * - `catalog.json`: `{ entries: string[], kiloRows: [{ id, vision, ... }] }`.
 *
 * @module lib/gateway
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Our Free Model's data directory name under the harness home. */
const DATA_DIR_NAME = 'our-free-model'

/** The forward listener binds loopback only (see src/forward.js in that plugin). */
const GATEWAY_HOST = '127.0.0.1'

/** The three `.env` keys the ai-goofish-monitor backend reads (AISettings). */
export const AI_ENV_KEYS = Object.freeze({
  apiKey: 'OPENAI_API_KEY',
  baseURL: 'OPENAI_BASE_URL',
  model: 'OPENAI_MODEL_NAME',
})

const MANAGED_ENV_KEYS = Object.freeze([AI_ENV_KEYS.apiKey, AI_ENV_KEYS.baseURL, AI_ENV_KEYS.model])

/** Same plain-value rule the project's own env_manager.py uses when it writes .env. */
const PLAIN_ENV_VALUE = /^[A-Za-z0-9_./:-]+$/

/** Escape table python-dotenv decodes inside double-quoted values. */
const DOTENV_ESCAPES = Object.freeze({
  '\\': '\\',
  '"': '"',
  "'": "'",
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
})

/** `$DSH_HOME` (trimmed) else `~/.dsh`, matching the plugin's own resolution. */
function defaultDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** Normalize an explicit home argument, falling back to the plugin's default. */
function normalizeDshHome(value) {
  if (typeof value === 'string' && value.trim() !== '') return path.resolve(value.trim())
  return defaultDshHome()
}

/** Strip trailing slashes from an OpenAI base URL (`.../v1/` -> `.../v1`). */
function trimBaseURL(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

/** Read a whole error into a short message (never a stack, never a key). */
function errorMessage(error) {
  return String(error?.message ?? error)
}

function positiveTimeout(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.trunc(n)
}

/** Node's AbortSignal.timeout is available on the supported runtime; degrade if not. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  return undefined
}

/**
 * Absolute paths for the plugin-owned data directory.
 *
 * @param {string} [dshHome] - overrides `$DSH_HOME` / `~/.dsh`
 * @returns {{dshHome: string, dataDir: string, settingsPath: string, catalogPath: string}}
 */
export function resolveGatewayPaths(dshHome) {
  const home = normalizeDshHome(dshHome)
  const dataDir = path.join(home, DATA_DIR_NAME)
  return {
    dshHome: home,
    dataDir,
    settingsPath: path.join(dataDir, 'settings.json'),
    catalogPath: path.join(dataDir, 'catalog.json'),
  }
}

/** Read + parse a JSON file without throwing; absent is not an error. */
async function readJsonFile(file) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: undefined, error: '' }
    return { exists: false, value: undefined, error: `unreadable file: ${errorMessage(error)}` }
  }
  try {
    return { exists: true, value: JSON.parse(raw), error: '' }
  } catch (error) {
    return { exists: true, value: undefined, error: `invalid JSON: ${errorMessage(error)}` }
  }
}

/** Accept `{ data: [...] }`, a bare array, or strings; dedupe by model id. */
function modelRowsOf(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    let id = ''
    let ownedBy = ''
    if (typeof row === 'string') {
      id = row.trim()
    } else if (row !== null && typeof row === 'object' && typeof row.id === 'string') {
      id = row.id.trim()
      if (typeof row.owned_by === 'string') ownedBy = row.owned_by.trim()
    }
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({ id, ownedBy })
  }
  return out
}

/**
 * Probe `<baseURL>/models`, the listener's authenticated liveness + roster route.
 * Never throws: every failure is returned as `{ ok: false, error }`.
 */
async function fetchModels({ baseURL, apiKey, fetchImpl, timeoutMs }) {
  const base = trimBaseURL(baseURL)
  if (base === '') return { ok: false, status: 0, rows: [], error: 'no gateway base URL configured' }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 0, rows: [], error: 'no fetch implementation available' }
  }
  const ms = positiveTimeout(timeoutMs, 4000)
  const headers = { accept: 'application/json' }
  // The forward listener requires a key on every route below `/health`; an
  // empty forwardKey means the listener has not started (it mints one on bind).
  if (typeof apiKey === 'string' && apiKey !== '') headers.authorization = `Bearer ${apiKey}`
  let response
  try {
    response = await fetchImpl(`${base}/models`, { method: 'GET', headers, signal: timeoutSignal(ms) })
  } catch (error) {
    const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      rows: [],
      error: aborted ? `timed out after ${ms} ms` : `request failed: ${errorMessage(error)}`,
    }
  }
  let payload
  let parseError = ''
  try {
    payload = await response.json()
  } catch (error) {
    parseError = errorMessage(error)
  }
  const rows = modelRowsOf(payload)
  if (!response.ok) {
    const detail = typeof payload?.error?.message === 'string' ? ` (${payload.error.message.slice(0, 200)})` : ''
    return { ok: false, status: response.status, rows, error: `HTTP ${response.status}${detail}` }
  }
  if (parseError !== '') return { ok: false, status: response.status, rows, error: `invalid JSON: ${parseError}` }
  return { ok: true, status: response.status, rows, error: '' }
}

/** Port of a URL, or 0 when it cannot be parsed / is absent. */
function portOfBaseURL(baseURL) {
  try {
    const url = new URL(trimBaseURL(baseURL))
    return Number.isInteger(Number(url.port)) && Number(url.port) > 0 ? Number(url.port) : 0
  } catch {
    return 0
  }
}

/**
 * Discover the forward listener from the Our Free Model settings file.
 *
 * `source` records where the answer came from:
 * - `forward-listener` — settings.json was read and a listener is enabled
 *   (`chanGateway.relay` first, then `forward`); `running` then says whether
 *   `GET /v1/models` answered 200.
 * - `manual-override` — the caller passed an explicit `baseURL` (+ `apiKey`).
 * - `disabled` — settings readable, every listener switched off (no probe).
 * - `unavailable` — settings absent/unreadable/port invalid, or a probe error.
 *
 * Never throws for absent/disabled/unreadable settings; the failure lives in
 * `error` with `running: false`.
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] - harness home override
 * @param {string} [options.baseURL] - manual gateway base URL override
 * @param {string} [options.apiKey] - manual bearer key override
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs=2500]
 * @returns {Promise<{settingsPath: string, catalogPath: string, enabled: boolean,
 *   running: boolean, port: number, key: string, baseURL: string,
 *   source: 'forward-listener'|'manual-override'|'disabled'|'unavailable',
 *   dshHome: string, error: string}>}
 */
export async function discoverGateway(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 2500
  const paths = resolveGatewayPaths(options.dshHome)
  const result = {
    settingsPath: paths.settingsPath,
    catalogPath: paths.catalogPath,
    dshHome: paths.dshHome,
    enabled: false,
    running: false,
    port: 0,
    key: '',
    baseURL: '',
    listener: '',
    source: 'unavailable',
    error: '',
  }

  const manualBase = trimBaseURL(options.baseURL)
  if (manualBase !== '') {
    result.enabled = true
    result.source = 'manual-override'
    result.baseURL = manualBase
    result.port = portOfBaseURL(manualBase)
    result.key = typeof options.apiKey === 'string' ? options.apiKey : ''
    const probe = await fetchModels({ baseURL: manualBase, apiKey: result.key, fetchImpl, timeoutMs })
    result.running = probe.ok
    if (!probe.ok) result.error = probe.error
    return result
  }

  const settings = await readJsonFile(paths.settingsPath)
  if (!settings.exists) {
    result.error = `Our Free Model settings not found at ${paths.settingsPath}`
    return result
  }
  if (settings.error !== '') {
    result.error = `Our Free Model settings unusable: ${settings.error}`
    return result
  }
  if (settings.value === null || typeof settings.value !== 'object' || Array.isArray(settings.value)) {
    result.error = 'Our Free Model settings are not a JSON object'
    return result
  }

  // The plugin exposes two different OpenAI-compatible listeners:
  //   chanGateway.relay — the "启用网关" switch on the 网关设置 page (relay, keyed)
  //   forward           — the older LAN forward listener
  // Either one is a valid gate for this plugin, so take the first that is on.
  const candidates = collectListeners(settings.value)
  const chosen = candidates.find((entry) => entry.enabled) ?? null

  if (chosen === null) {
    // Nothing switched on: still report the address that would be used so the
    // UI can tell the user where to look once they enable one.
    const hint = candidates.find((entry) => entry.port > 0) ?? null
    result.port = hint?.port ?? 0
    result.key = hint?.key ?? ''
    if (result.port > 0) result.baseURL = `http://${GATEWAY_HOST}:${result.port}/v1`
    result.source = 'disabled'
    return result
  }

  result.port = chosen.port
  result.key = chosen.key
  result.enabled = true
  result.listener = chosen.listener
  if (chosen.port > 0) result.baseURL = `http://${GATEWAY_HOST}:${chosen.port}/v1`

  if (chosen.port === 0) {
    result.error = `${chosen.field}.port is missing or invalid in Our Free Model settings`
    return result
  }

  result.source = 'forward-listener'
  const probe = await fetchModels({ baseURL: result.baseURL, apiKey: chosen.key, fetchImpl, timeoutMs })
  result.running = probe.ok
  if (!probe.ok) result.error = probe.error
  return result
}

/**
 * Normalize every OpenAI-compatible listener declared in settings.json.
 *
 * @param {Record<string, unknown>} settings
 * @returns {Array<{listener: string, field: string, enabled: boolean, port: number, key: string}>}
 */
function collectListeners(settings) {
  const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
  const toPort = (value) => {
    const raw = Number(value)
    return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 0
  }
  const relay = asObject(asObject(settings.chanGateway).relay)
  const forward = asObject(settings.forward)
  return [
    {
      listener: 'relay',
      field: 'chanGateway.relay',
      enabled: relay.enabled === true,
      port: toPort(relay.port),
      key: typeof relay.key === 'string' ? relay.key.trim() : '',
    },
    {
      listener: 'forward',
      field: 'forward',
      enabled: forward.enabled === true,
      port: toPort(forward.port),
      key: typeof settings.forwardKey === 'string' ? settings.forwardKey.trim() : '',
    },
  ]
}

/** Catalog index: free-lane ids, kilo rows, and the kilo vision flags. */
function buildCatalogIndex(catalog) {
  const freeIds = new Set()
  const visionById = new Map()
  for (const id of catalog.entries) freeIds.add(id)
  for (const row of catalog.kiloRows) {
    freeIds.add(row.id)
    // Persisted kilo rows are built entries, so `vision` is a real boolean.
    visionById.set(row.id, row.vision === true)
  }
  return { entries: catalog.entries, kiloRows: catalog.kiloRows, freeIds, visionById }
}

/** Read catalog.json, tolerating absence and damage (returns empty lists). */
async function readCatalogFile(catalogPath) {
  const result = { entries: [], kiloRows: [], error: '' }
  const parsedFile = await readJsonFile(catalogPath)
  if (!parsedFile.exists) return result
  if (parsedFile.error !== '') {
    result.error = `catalog.json unusable: ${parsedFile.error}`
    return result
  }
  const value = parsedFile.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    result.error = 'catalog.json is not a JSON object'
    return result
  }
  const seenEntries = new Set()
  for (const entry of Array.isArray(value.entries) ? value.entries : []) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id === '' || seenEntries.has(id)) continue
    seenEntries.add(id)
    result.entries.push(id)
  }
  const seenRows = new Set()
  for (const row of Array.isArray(value.kiloRows) ? value.kiloRows : []) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    if (typeof row.id !== 'string') continue
    const id = row.id.trim()
    if (id === '' || seenRows.has(id)) continue
    seenRows.add(id)
    result.kiloRows.push({ id, vision: row.vision === true, name: typeof row.name === 'string' ? row.name : '' })
  }
  return result
}

/**
 * Vision is a hard requirement for goofish's multimodal analysis, so for ids
 * the catalog does not describe we guess from the id itself. Guesses only ever
 * upgrade `null` -> `true`; catalog facts always win.
 */
function visionHeuristic(id) {
  const lower = id.toLowerCase()
  if (lower.includes('vision') || lower.includes('gemini') || lower.includes('gpt-4o') || lower.includes('claude')) {
    return true
  }
  // `vl` as a whole token: qwen2.5-vl-72b, nemotron-3.5-super-vl, ... but not
  // an accidental substring inside an unrelated word.
  if (/(?:^|[-_/.:])vl(?:$|[-_/.:])/.test(lower)) return true
  return null
}

function isFreeId(index, id) {
  if (index.freeIds.has(id)) return true
  const lower = id.toLowerCase()
  if (lower.endsWith(':free') || lower.endsWith('-free')) return true
  if (lower === 'kilo-auto/free') return true
  return false
}

function providerOf(index, id, ownedBy) {
  const slash = id.indexOf('/')
  if (slash > 0) return id.slice(0, slash)
  if (isFreeId(index, id)) return 'free'
  if (typeof ownedBy === 'string' && ownedBy !== '' && ownedBy !== 'our-free-model') return ownedBy
  return 'our-free-model'
}

/** One public model record: `{ id, provider, vision, free }`. */
function toModel(index, id, ownedBy = '') {
  let vision
  if (index.visionById.has(id)) vision = index.visionById.get(id)
  else vision = visionHeuristic(id)
  return {
    id,
    provider: providerOf(index, id, ownedBy),
    vision,
    free: isFreeId(index, id),
  }
}

/** Build the roster from the catalog alone (gateway down but cache present). */
function catalogModels(index) {
  const models = []
  const seen = new Set()
  for (const id of index.entries) {
    if (seen.has(id)) continue
    seen.add(id)
    models.push(toModel(index, id))
  }
  for (const row of index.kiloRows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    models.push(toModel(index, row.id))
  }
  return models
}

/**
 * List the gateway's models, enriched with vision capability.
 *
 * When the listener answers, `source: 'gateway'` and its roster wins. When it
 * does not, the cached catalog is used (`source: 'catalog'`). Nothing usable is
 * `source: 'none'` with an empty list. Never throws.
 *
 * @param {object} [options]
 * @param {string} [options.baseURL] - gateway base URL, e.g. `http://127.0.0.1:18899/v1`
 * @param {string} [options.apiKey] - bearer key (`forwardKey`)
 * @param {string} [options.catalogPath] - explicit catalog.json path
 * @param {string} [options.dshHome] - harness home for the default catalog path
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs=4000]
 * @returns {Promise<{gatewayReady: boolean, source: 'gateway'|'catalog'|'none',
 *   models: Array<{id: string, provider: string, vision: boolean|null, free: boolean}>,
 *   catalogPath: string, error: string}>}
 */
export async function listGatewayModels(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 4000
  const paths = resolveGatewayPaths(options.dshHome)
  const catalogPath = typeof options.catalogPath === 'string' && options.catalogPath.trim() !== ''
    ? path.resolve(options.catalogPath.trim())
    : paths.catalogPath
  const baseURL = trimBaseURL(options.baseURL)

  const result = {
    gatewayReady: false,
    source: 'none',
    models: [],
    catalogPath,
    error: '',
  }

  const catalog = await readCatalogFile(catalogPath)
  const index = buildCatalogIndex(catalog)

  if (baseURL !== '') {
    const probe = await fetchModels({ baseURL, apiKey: options.apiKey, fetchImpl, timeoutMs })
    if (probe.ok) {
      result.gatewayReady = true
      result.source = 'gateway'
      result.models = probe.rows.map(row => toModel(index, row.id, row.ownedBy))
      return result
    }
    result.error = `gateway probe failed: ${probe.error}`
  } else {
    result.error = 'no gateway base URL configured'
  }

  const cached = catalogModels(index)
  if (cached.length > 0) {
    result.source = 'catalog'
    result.models = cached
    if (catalog.error !== '') result.error = catalog.error
    return result
  }

  if (catalog.error !== '') result.error = catalog.error
  return result
}

/**
 * Choose the model the project should use.
 *
 * An explicit `preferred` wins when it is present in the list; otherwise the
 * first vision-capable model wins (goofish analysis sends product images), and
 * finally the first model. Returns `''` for an empty roster.
 *
 * @param {Array<{id: string, vision?: boolean|null}>} models
 * @param {{preferred?: string}} [options]
 * @returns {string}
 */
export function pickDefaultModel(models, options = {}) {
  const list = (Array.isArray(models) ? models : []).filter(
    model => model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== '',
  )
  const preferred = typeof options.preferred === 'string' ? options.preferred.trim() : ''
  if (preferred !== '' && list.some(model => model.id === preferred)) return preferred
  const vision = list.find(model => model.vision === true)
  if (vision !== undefined) return vision.id
  return list.length > 0 ? list[0].id : ''
}

/** Quote a value the way python-dotenv expects; plain values stay unquoted. */
function serializeEnvValue(value) {
  const text = String(value ?? '')
  if (text === '') return ''
  if (PLAIN_ENV_VALUE.test(text)) return text
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/**
 * Merge the three AI keys into `.env`.
 *
 * Unrelated lines, comments and blank lines are preserved byte-for-byte; a
 * managed key keeps its position (and an `export ` prefix) but its value is
 * replaced, and duplicate assignments of a managed key are dropped. Missing
 * keys are appended. The file is written with `\n` line endings regardless of
 * what it had before (CRLF input is normalized; `.env` consumers use
 * python-dotenv, which accepts both). Written through a temp file + rename so a
 * crash cannot truncate the real file; the previous content lands in
 * `.env.bak` first when the content changes.
 *
 * @param {object} options
 * @param {string} options.projectRoot - the ai-goofish-monitor repo root
 * @param {string} options.baseURL - `OPENAI_BASE_URL`
 * @param {string} [options.apiKey] - `OPENAI_API_KEY`
 * @param {string} options.model - `OPENAI_MODEL_NAME`
 * @returns {Promise<{envPath: string, changed: boolean, backupPath: string|null,
 *   keys: {OPENAI_API_KEY: string, OPENAI_BASE_URL: string, OPENAI_MODEL_NAME: string}}>}
 */
export async function syncAiEnv(options = {}) {
  const projectRoot = normalizeDshHome(options.projectRoot)
  if (typeof options.projectRoot !== 'string' || options.projectRoot.trim() === '') {
    throw new TypeError('syncAiEnv: projectRoot is required')
  }
  const baseURL = String(options.baseURL ?? '').trim()
  const apiKey = String(options.apiKey ?? '')
  const model = String(options.model ?? '').trim()
  if (baseURL === '') throw new Error('syncAiEnv: baseURL is required')
  if (model === '') throw new Error('syncAiEnv: model is required')

  const envPath = path.join(projectRoot, '.env')
  const keys = {
    [AI_ENV_KEYS.apiKey]: apiKey,
    [AI_ENV_KEYS.baseURL]: baseURL,
    [AI_ENV_KEYS.model]: model,
  }
  const managed = new Map(Object.entries(keys))

  let previous = null
  try {
    previous = await fsp.readFile(envPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const next = mergeEnvText(previous ?? '', managed)
  if (previous !== null && next === previous) {
    return { envPath, changed: false, backupPath: null, keys }
  }

  let backupPath = null
  if (previous !== null) {
    backupPath = `${envPath}.bak`
    await fsp.writeFile(backupPath, previous, 'utf8')
  }
  await writeFileAtomic(envPath, next)
  return { envPath, changed: true, backupPath, keys }
}

/** Preserve every non-managed line; replace/append the managed keys. */
function mergeEnvText(text, managed) {
  const inputLines = text === '' ? [] : text.split(/\r?\n/)
  const out = []
  const seen = new Set()
  const assignment = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/
  for (const line of inputLines) {
    const match = assignment.exec(line)
    if (match === null) {
      out.push(line)
      continue
    }
    const [, prefix, key] = match
    if (!managed.has(key)) {
      out.push(line)
      continue
    }
    if (seen.has(key)) continue // duplicate assignment of a managed key
    seen.add(key)
    out.push(`${prefix}${key}=${serializeEnvValue(managed.get(key))}`)
  }
  for (const [key, value] of managed) {
    if (!seen.has(key)) out.push(`${key}=${serializeEnvValue(value)}`)
  }
  // Normalize the trailing newline: drop the empty tail split() produced and
  // always end with exactly one newline (an existing final newline is kept).
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  if (out.length === 0) return ''
  return `${out.join('\n')}\n`
}

/** Write via a sibling temp file + rename so a crash cannot truncate `file`. */
async function writeFileAtomic(file, content) {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  )
  try {
    await fsp.writeFile(temp, content, 'utf8')
    await fsp.rename(temp, file)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Decode a dotenv value (double quotes decode escapes, single quotes are literal). */
function parseEnvValue(raw) {
  let value = String(raw ?? '').trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\([\\'"abfnrtv])/g, (_, char) => DOTENV_ESCAPES[char] ?? char)
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  const inlineComment = value.search(/\s#/)
  if (inlineComment >= 0) value = value.slice(0, inlineComment).trim()
  return value
}

/** Parse `.env` text into a key -> value map (last assignment wins). */
function parseEnvText(text) {
  const values = new Map()
  const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = assignment.exec(line)
    if (match === null) continue
    values.set(match[1], parseEnvValue(match[2]))
  }
  return values
}

/**
 * Read the project's current AI configuration from `.env`.
 *
 * Synchronous and read-only; tolerates a missing file (returns `exists: false`
 * with empty values). `configured` mirrors AISettings.is_configured() in the
 * backend: a base URL and a model name are both present.
 *
 * @param {object} options
 * @param {string} options.projectRoot - the ai-goofish-monitor repo root
 * @returns {{envPath: string, exists: boolean, apiKey: string, baseURL: string,
 *   model: string, configured: boolean,
 *   values: {OPENAI_API_KEY: string, OPENAI_BASE_URL: string, OPENAI_MODEL_NAME: string},
 *   error: string}}
 */
export function readAiEnv(options = {}) {
  const result = {
    envPath: '',
    exists: false,
    apiKey: '',
    baseURL: '',
    model: '',
    configured: false,
    values: {
      [AI_ENV_KEYS.apiKey]: '',
      [AI_ENV_KEYS.baseURL]: '',
      [AI_ENV_KEYS.model]: '',
    },
    error: '',
  }
  if (typeof options.projectRoot !== 'string' || options.projectRoot.trim() === '') {
    result.error = 'readAiEnv: projectRoot is required'
    return result
  }
  const projectRoot = path.resolve(options.projectRoot.trim())
  result.envPath = path.join(projectRoot, '.env')

  let text
  try {
    text = fs.readFileSync(result.envPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') result.error = `could not read .env: ${errorMessage(error)}`
    return result
  }
  result.exists = true
  const parsed = parseEnvText(text)
  for (const key of MANAGED_ENV_KEYS) {
    const value = parsed.get(key)
    result.values[key] = typeof value === 'string' ? value : ''
  }
  result.apiKey = result.values[AI_ENV_KEYS.apiKey]
  result.baseURL = result.values[AI_ENV_KEYS.baseURL]
  result.model = result.values[AI_ENV_KEYS.model]
  result.configured = result.baseURL !== '' && result.model !== ''
  return result
}
