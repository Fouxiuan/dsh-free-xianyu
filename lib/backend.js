/**
 * Managed lifecycle for the ai-goofish-monitor FastAPI backend.
 *
 * The backend is a child of the Harness Host process: one instance per plugin
 * activation, killed on unload. It binds loopback only and is reached over
 * HTTP by the tools, the Settings page proxy routes, and the user's browser.
 *
 * @module lib/backend
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { backendLogFile, pluginDataDir } from './paths.js'

const HEALTH_POLL_INTERVAL_MS = 400
const START_TIMEOUT_MS = 45000
const STOP_TIMEOUT_MS = 15000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {{
 *   getConfig: () => import('./config.js').GoofishConfig,
 *   projectRoot: string,
 *   log?: (...args: unknown[]) => void,
 *   warn?: (...args: unknown[]) => void,
 * }} options
 */
export function createBackendManager(options) {
  const { getConfig, projectRoot } = options
  const log = options.log ?? (() => {})
  const warn = options.warn ?? log

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let owned = false
  let startedAt = 0
  let lastError = ''
  let logPath = ''
  let exitInfo = ''
  let stopping = false

  const port = () => getConfig().serverPort
  const baseURL = () => `http://127.0.0.1:${port()}`
  const healthURL = () => `${baseURL()}/health`

  function describeExit(code, signal) {
    if (signal) return `backend exited with signal ${signal}`
    return `backend exited with code ${code}`
  }

  async function probeHealth(timeoutMs = 1500) {
    try {
      const response = await fetch(healthURL(), { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) return { healthy: false, status: response.status, error: `health returned HTTP ${response.status}` }
      const body = await response.json().catch(() => ({}))
      return { healthy: true, status: response.status, body }
    } catch (error) {
      return { healthy: false, status: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  function tailLog(maxChars = 4000) {
    if (!logPath || !fs.existsSync(logPath)) return ''
    try {
      const size = fs.statSync(logPath).size
      const start = Math.max(0, size - maxChars)
      const fd = fs.openSync(logPath, 'r')
      try {
        const buffer = Buffer.alloc(size - start)
        fs.readSync(fd, buffer, 0, buffer.length, start)
        return buffer.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return ''
    }
  }

  function childRunning() {
    return child !== null && child.exitCode === null && child.signalCode === null
  }

  /**
   * Start the backend unless a healthy server already answers on the port.
   * @param {{ extraEnv?: Record<string, string>, force?: boolean }} [startOptions]
   */
  async function start(startOptions = {}) {
    lastError = ''
    exitInfo = ''
    const existing = await probeHealth(1200)
    if (existing.healthy) {
      if (!childRunning()) {
        owned = false
        if (!startedAt) startedAt = Date.now()
      }
      return status()
    }
    if (childRunning()) return waitForHealthy()

    const config = getConfig()
    const dataDir = pluginDataDir()
    fs.mkdirSync(dataDir, { recursive: true })
    logPath = backendLogFile()
    const out = fs.openSync(logPath, 'a')
    try {
      fs.writeSync(out, `\n==== dsh-free-xianyu: starting backend ${new Date().toISOString()} ====\n`)
    } catch {
      /* log write is best-effort */
    }

    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      SERVER_PORT: String(config.serverPort),
      ...(startOptions.extraEnv ?? {}),
    }

    log(`starting backend: ${config.pythonPath} -m src.app (cwd=${projectRoot}, port=${config.serverPort})`)
    try {
      child = spawn(config.pythonPath, ['-m', 'src.app'], {
        cwd: projectRoot,
        env,
        windowsHide: true,
        stdio: ['ignore', out, out],
      })
      owned = true
      startedAt = Date.now()
    } catch (error) {
      lastError = `could not spawn backend: ${error instanceof Error ? error.message : String(error)}`
      try { fs.closeSync(out) } catch { /* ignore */ }
      throw new Error(lastError)
    }

    child.once('exit', (code, signal) => {
      if (!stopping) {
        exitInfo = describeExit(code, signal)
        lastError = lastError || exitInfo
        log(`backend process: ${exitInfo}`)
      }
      startedAt = 0
      child = null
      owned = false
    })
    child.once('error', (error) => {
      lastError = `backend process error: ${error instanceof Error ? error.message : String(error)}`
      warn(lastError)
    })
    child.once('close', () => {
      try { fs.closeSync(out) } catch { /* already closed */ }
    })

    return waitForHealthy()
  }

  async function waitForHealthy() {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (childRunning()) {
        const probe = await probeHealth(1500)
        if (probe.healthy) return status()
      } else if (child !== null && child.exitCode !== null) {
        break
      }
      await sleep(HEALTH_POLL_INTERVAL_MS)
    }
    const tail = tailLog(2500)
    lastError = childRunning()
      ? `backend did not become healthy within ${Math.round(START_TIMEOUT_MS / 1000)}s`
      : `${exitInfo || 'backend stopped before becoming healthy'}${tail ? `\n--- backend log tail ---\n${tail}` : ''}`
    throw new Error(lastError)
  }

  async function stop() {
    if (!childRunning()) {
      const external = await probeHealth(1200)
      if (external.healthy && !owned) {
        return { ...status(), note: 'the running server was not started by this plugin; it was left untouched' }
      }
      child = null
      owned = false
      startedAt = 0
      lastError = ''
      exitInfo = ''
      return status()
    }
    stopping = true
    const pid = child.pid
    log(`stopping backend pid=${pid}`)
    try {
      if (process.platform === 'win32') {
        await runTaskkill(pid)
      } else {
        try { process.kill(-pid, 'SIGTERM') } catch { /* not a group leader */ }
        await waitForExit(STOP_TIMEOUT_MS)
        if (childRunning()) {
          try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
        }
      }
    } catch (error) {
      warn(`backend stop failed: ${error instanceof Error ? error.message : String(error)}`)
      try { child.kill() } catch { /* gone */ }
    }
    await waitForExit(STOP_TIMEOUT_MS)
    if (childRunning()) {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      await waitForExit(3000)
    }
    stopping = false
    child = null
    owned = false
    startedAt = 0
    lastError = ''
    exitInfo = ''
    return status()
  }

  function runTaskkill(pid) {
    return new Promise((resolve) => {
      if (!pid) return resolve(undefined)
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('exit', () => resolve(undefined))
      killer.once('error', () => resolve(undefined))
    })
  }

  async function waitForExit(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!childRunning()) return true
      await sleep(150)
    }
    return !childRunning()
  }

  async function status() {
    const probe = await probeHealth(1200)
    const running = probe.healthy || childRunning()
    return {
      running,
      healthy: probe.healthy,
      owned,
      port: port(),
      pid: child?.pid ?? null,
      url: baseURL(),
      startedAt: startedAt ? new Date(startedAt).toISOString() : '',
      error: probe.healthy ? '' : (lastError || probe.error || ''),
      logPath,
      exitInfo,
    }
  }

  async function ensureRunning() {
    const current = await status()
    if (current.healthy) return current
    return start()
  }

  function dispose() {
    stopping = true
    if (childRunning()) {
      try {
        if (process.platform === 'win32' && child?.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
          try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
        }
      } catch {
        /* best effort */
      }
    }
    child = null
    owned = false
    startedAt = 0
  }

  return { start, stop, status, ensureRunning, baseURL, probeHealth, tailLog, dispose }
}
