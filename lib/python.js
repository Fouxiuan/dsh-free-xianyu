/**
 * Interpreter discovery.
 *
 * The plugin provisions its own virtualenv, so all it needs from the machine is
 * one Python 3.10+ binary. Assuming `python` exists is wrong on two of the three
 * desktop platforms this plugin targets: macOS ships only `python3` (and often
 * not even that without the Command Line Tools), while Windows resolves the `py`
 * launcher instead. This module probes a short list of candidates, keeps the
 * first one that answers with a supported version, and reports what it tried so
 * a failure can say *why* instead of "backend stopped".
 *
 * Candidates are only probed; nothing here writes to disk.
 *
 * @module lib/python
 */

import { spawn } from 'node:child_process'

/** Oldest interpreter the vendored ai-goofish-monitor runs on. */
export const MIN_PYTHON = [3, 10]

const PROBE_TIMEOUT_MS = 10000

const VERSION_PROBE =
  'import sys;sys.stdout.write("%d.%d.%d" % (sys.version_info[0], sys.version_info[1], sys.version_info[2]))'

/**
 * @typedef {{ command: string, args: string[] }} PythonCandidate
 * @typedef {{ command: string, args: string[], version: string, label: string,
 *   tried: { candidate: string, ok: boolean, version: string, error: string }[],
 *   ok: true } | { ok: false, command: '', args: string[], version: '', label: '',
 *   error: string, tried: { candidate: string, ok: boolean, version: string, error: string }[] }} PythonDetection
 */

/** Parse `3.12.4`; returns [] for anything unparsable. */
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? '').trim())
  if (!match) return []
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** True when `version` (a parsed array) satisfies MIN_PYTHON. */
export function isSupportedVersion(version) {
  const [major = 0, minor = 0] = Array.isArray(version) ? version : []
  const [needMajor, needMinor] = MIN_PYTHON
  return major > needMajor || (major === needMajor && minor >= needMinor)
}

/**
 * Candidate interpreters, most likely first.
 *
 * An explicit `pythonPath` is the only candidate: a user who names an
 * interpreter must see that interpreter fail, not a silent switch to another one.
 * Otherwise the machine's conventional names are tried, then the absolute paths
 * the common installers use (a GUI process often has a much smaller PATH than
 * the login shell).
 *
 * @param {{configured?: string, env?: Record<string, string | undefined>, platform?: string}} [options]
 * @returns {PythonCandidate[]}
 */
export function pythonCandidates(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  /** @type {PythonCandidate[]} */
  const candidates = []
  const add = (command, args = []) => {
    const text = String(command ?? '').trim()
    if (text === '') return
    if (candidates.some((c) => c.command === text && c.args.join('\u0000') === args.join('\u0000'))) return
    candidates.push({ command: text, args: [...args] })
  }

  const configured = String(options.configured ?? '').trim()
  if (configured !== '') {
    add(configured)
    return candidates
  }

  const fromEnv = String(env?.DSH_FREE_XIANYU_PYTHON ?? '').trim()
  if (fromEnv !== '') add(fromEnv)

  if (platform === 'win32') {
    for (const series of ['3.13', '3.12', '3.11', '3.10']) add('py', [`-${series}`])
    add('py', ['-3'])
    add('python3')
    add('python')
    return candidates
  }

  add('python3')
  add('python')
  for (const series of ['3.13', '3.12', '3.11', '3.10']) add(`python${series}`)
  if (platform === 'darwin') {
    for (const absolute of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) add(absolute)
  } else {
    for (const absolute of ['/usr/bin/python3', '/usr/local/bin/python3']) add(absolute)
  }
  return candidates
}

function labelOf(candidate) {
  return [candidate.command, ...candidate.args].join(' ')
}

/** Run one interpreter once and read the version it reports. */
function probe(candidate, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    let child = null
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      child = spawn(candidate.command, [...candidate.args, '-c', VERSION_PROBE], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, version: '', error: error instanceof Error ? error.message : String(error) })
      return
    }

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ ok: false, version: '', error: `did not answer within ${timeoutMs}ms` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, version: '', error: error instanceof Error ? error.message : String(error) })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const version = stdout.trim()
      if (code !== 0) {
        const detail = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
        finish({ ok: false, version: '', error: detail || `exited with code ${code}` })
        return
      }
      if (!version) {
        finish({ ok: false, version: '', error: 'reported no version' })
        return
      }
      finish({ ok: true, version, error: '' })
    })
  })
}

/** @type {{ key: string, value: PythonDetection } | null} */
let cachedSuccess = null

/** Forget the cached interpreter (tests, or after the user installs Python). */
export function resetPythonCache() {
  cachedSuccess = null
}

/**
 * Find a usable Python 3.10+ interpreter.
 *
 * @param {{configured?: string, env?: Record<string, string | undefined>,
 *   platform?: string, log?: (...args: unknown[]) => void,
 *   timeoutMs?: number}} [options]
 * @returns {Promise<PythonDetection>}
 */
export async function detectPython(options = {}) {
  const configured = String(options.configured ?? '').trim()
  const cacheKey = `${configured}|${options.platform ?? process.platform}`
  if (cachedSuccess && cachedSuccess.key === cacheKey) return cachedSuccess.value

  const log = options.log ?? (() => {})
  const candidates = pythonCandidates(options)
  /** @type {{ candidate: string, ok: boolean, version: string, error: string }[]} */
  const tried = []

  for (const candidate of candidates) {
    const label = labelOf(candidate)
    const result = await probe(candidate, options.timeoutMs)
    if (!result.ok) {
      tried.push({ candidate: label, ok: false, version: '', error: result.error })
      log(`python candidate ${label} unusable: ${result.error}`)
      continue
    }
    const version = parseVersion(result.version)
    if (!isSupportedVersion(version)) {
      const error = `version ${result.version} is older than ${MIN_PYTHON.join('.')}`
      tried.push({ candidate: label, ok: false, version: result.version, error })
      log(`python candidate ${label} too old: ${result.version}`)
      continue
    }
    tried.push({ candidate: label, ok: true, version: result.version, error: '' })
    /** @type {PythonDetection} */
    const detection = { ok: true, command: candidate.command, args: candidate.args, version: result.version, label, tried }
    cachedSuccess = { key: cacheKey, value: detection }
    return detection
  }

  const wanted =
    configured !== ''
      ? `pythonPath "${configured}" is not a usable Python ${MIN_PYTHON.join('.')}+ interpreter`
      : `no Python ${MIN_PYTHON.join('.')}+ interpreter found`
  const attempts = tried.map((entry) => `${entry.candidate} (${entry.error})`).join('; ')
  return {
    ok: false,
    command: '',
    args: [],
    version: '',
    label: '',
    error: `${wanted}${attempts ? ` — tried ${attempts}` : ''}. Install Python ${MIN_PYTHON.join('.')}+ or set the pythonPath setting.`,
    tried,
  }
}
