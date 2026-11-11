/**
 * Plugin configuration: defaults, normalization, and the Standard Schema
 * validator the Loader uses for this row's `config`.
 *
 * Deliberately dependency-free: a linked workspace checkout has no resolvable
 * node_modules, so the Host half may only use node builtins.
 *
 * @module lib/config
 */

export const PLUGIN_ID = 'dsh-free-xianyu'
export const PLUGIN_VERSION = '1.1.0'

/** @typedef {{
 *   projectRoot: string,
 *   pythonPath: string,
 *   serverPort: number,
 *   autoStart: boolean,
 *   aiBaseURL: string,
 *   aiApiKey: string,
 *   aiModel: string,
 *   requestTimeoutMs: number,
 *   manageEnv: boolean,
 *   buildFrontend: boolean,
 *   autoBuildFrontend: boolean,
 *   frontendInstall: boolean,
 *   useBuiltinRuntime: boolean,
 *   autoProvision: boolean,
 * }} GoofishConfig
 */

/** @type {GoofishConfig} */
export const DEFAULTS = {
  projectRoot: '',
  pythonPath: 'python',
  serverPort: 8848,
  autoStart: true,
  aiBaseURL: '',
  aiApiKey: '',
  aiModel: '',
  requestTimeoutMs: 15000,
  manageEnv: true,
  buildFrontend: true,
  autoBuildFrontend: true,
  frontendInstall: true,
  useBuiltinRuntime: true,
  autoProvision: true,
}

const bool = (value, fallback) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  return fallback
}

const int = (value, fallback, { min, max } = {}) => {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.trunc(number)
  if (min !== undefined && rounded < min) return fallback
  if (max !== undefined && rounded > max) return fallback
  return rounded
}

const text = (value, fallback) => {
  if (value === undefined || value === null) return fallback
  return String(value).trim()
}

/**
 * Normalize one row config object into the complete, validated shape.
 * Unknown keys are preserved so a future field written by a newer plugin
 * version is not silently dropped by this build.
 *
 * @param {unknown} raw
 * @returns {GoofishConfig}
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config must be a JSON object')
  }
  const value = /** @type {Record<string, unknown>} */ (raw)
  const config = {
    ...DEFAULTS,
    ...value,
    projectRoot: text(value.projectRoot, DEFAULTS.projectRoot),
    pythonPath: text(value.pythonPath, DEFAULTS.pythonPath) || DEFAULTS.pythonPath,
    serverPort: int(value.serverPort, DEFAULTS.serverPort, { min: 1024, max: 65535 }),
    autoStart: bool(value.autoStart, DEFAULTS.autoStart),
    aiBaseURL: text(value.aiBaseURL, DEFAULTS.aiBaseURL),
    aiApiKey: text(value.aiApiKey, DEFAULTS.aiApiKey),
    aiModel: text(value.aiModel, DEFAULTS.aiModel),
    requestTimeoutMs: int(value.requestTimeoutMs, DEFAULTS.requestTimeoutMs, { min: 1000, max: 120000 }),
    manageEnv: bool(value.manageEnv, DEFAULTS.manageEnv),
    buildFrontend: bool(value.buildFrontend, DEFAULTS.buildFrontend),
    autoBuildFrontend: bool(value.autoBuildFrontend, DEFAULTS.autoBuildFrontend),
    frontendInstall: bool(value.frontendInstall, DEFAULTS.frontendInstall),
    useBuiltinRuntime: bool(value.useBuiltinRuntime, DEFAULTS.useBuiltinRuntime),
    autoProvision: bool(value.autoProvision, DEFAULTS.autoProvision),
  }
  return /** @type {GoofishConfig} */ (config)
}

/**
 * Standard Schema v1 object accepted by Cordis/Loader for `export const Config`.
 * Mirrors the shape the shipped `dsh-ops` plugin uses, without its package deps.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: PLUGIN_ID,
    /** @param {unknown} value */
    validate(value) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
}
