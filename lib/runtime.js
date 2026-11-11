/**
 * Runtime provisioner for the vendored upstream project.
 *
 * The plugin ships ai-goofish-monitor's Python sources in `upstream/`, so nothing
 * is cloned at install time. What still has to exist on the machine is a Python
 * interpreter and that project's third-party dependencies; this module owns
 * turning a plain interpreter into a ready-to-run runtime:
 *
 *   <plugin-data>/runtime/
 *   ├── venv/            ← created once with `python -m venv`
 *   ├── deps.json        ← fingerprint recording which requirements were installed
 *   └── app/             ← writable working tree (config.json, prompts/, jsonl/, logs/…)
 *
 * `upstream/` stays read-only inside the package: the app writes `dist/`, `logs/`,
 * `jsonl/`, `state/` and `.env` next to its own sources, so the provisioner copies
 * the vendored tree into `app/` once and runs there. Re-provisioning refreshes the
 * copy while keeping the user's data.
 *
 * Nothing here throws for an expected condition: a missing interpreter, a failed
 * pip install or a timeout all come back as `{ ok: false, error }`, and the caller
 * degrades instead of taking the plugin down.
 *
 * @module lib/runtime
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Directories the app creates at runtime; preserved across a code refresh. */
const DATA_DIRS = ['jsonl', 'logs', 'images', 'state', 'data', 'prompts', 'dist']

/** Files copied from the package on every provision (code, never user data). */
const CODE_ENTRIES = ['src', 'spider_v2.py', 'requirements.txt']

/** Pip install can take a while on a cold cache. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const VENV_TIMEOUT_MS = 3 * 60 * 1000

/** Marker file describing what has been installed into the venv. */
const DEPS_MARKER = 'deps.json'

/**
 * @param {string} dataDir - this plugin's data directory (`<DSH_HOME>/dsh-free-xianyu`)
 * @param {string} packageDir - the installed package root (contains `upstream/`)
 */
export function runtimePaths(dataDir, packageDir) {
  const runtimeDir = path.join(dataDir, 'runtime')
  return {
    runtimeDir,
    venvDir: path.join(runtimeDir, 'venv'),
    appDir: path.join(runtimeDir, 'app'),
    markerFile: path.join(runtimeDir, DEPS_MARKER),
    upstreamDir: path.join(packageDir, 'upstream'),
    pythonBin:
      process.platform === 'win32'
        ? path.join(runtimeDir, 'venv', 'Scripts', 'python.exe')
        : path.join(runtimeDir, 'venv', 'bin', 'python'),
  }
}

/** Hash of the vendored requirements, used as the install fingerprint. */
function requirementsFingerprint(upstreamDir) {
  try {
    const bytes = fs.readFileSync(path.join(upstreamDir, 'requirements.txt'))
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

/** Read the marker recording which requirements the venv satisfies. */
function readMarker(markerFile) {
  try {
    return JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Report the provisioned state without changing anything.
 *
 * @param {{dataDir: string, packageDir: string, pythonPath?: string}} options
 * @returns {{ready: boolean, needsVenv: boolean, needsDeps: boolean,
 *   pythonFound: boolean, venvDir: string, appDir: string, upstreamDir: string,
 *   venvPython: string, upstreamFiles: number, depsInstalledAt: string,
 *   error: string}}
 */
export function inspectRuntime(options) {
  const paths = runtimePaths(options.dataDir, options.packageDir)
  const state = {
    ready: false,
    needsVenv: true,
    needsDeps: true,
    pythonFound: false,
    venvDir: paths.venvDir,
    appDir: paths.appDir,
    upstreamDir: paths.upstreamDir,
    venvPython: paths.pythonBin,
    upstreamFiles: 0,
    depsInstalledAt: '',
    error: '',
  }

  state.pythonFound = fs.existsSync(paths.pythonBin)
  state.needsVenv = !state.pythonFound

  let upstream = ''
  try {
    upstream = requirementsFingerprint(paths.upstreamDir)
    state.upstreamFiles = countFiles(path.join(paths.upstreamDir, 'src'))
  } catch {
    state.error = 'vendored upstream sources are missing from the package'
    return state
  }
  if (upstream === '') {
    state.error = 'vendored upstream sources are missing from the package'
    return state
  }

  const marker = readMarker(paths.markerFile)
  state.needsDeps = !(marker && marker.requirements === upstream && state.pythonFound)
  state.depsInstalledAt = marker?.installedAt ?? ''
  state.ready = !state.needsVenv && !state.needsDeps && fs.existsSync(path.join(paths.appDir, 'src', 'app.py'))
  return state
}

function countFiles(dir, depth = 0) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (depth < 8) total += countFiles(path.join(dir, entry.name), depth + 1)
      continue
    }
    total += 1
  }
  return total
}

/** Run a command to completion, capturing its output for the log. */
function run(command, args, { cwd, timeoutMs, log, label, env }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      // On Windows the interpreter may be a bare `python` (a shell-resolved shim)
      // and the venv python is a real path; a shell handles both. Every argument
      // here is either a fixed literal or an absolute path we built ourselves.
      const shell = process.platform === 'win32'
      child = spawn(shell ? `${command} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}` : command, shell ? [] : args, {
        cwd,
        shell,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, code: null, output: `could not spawn ${command}: ${error instanceof Error ? error.message : String(error)}` })
      return
    }

    let output = ''
    const capture = (chunk) => {
      const text = String(chunk)
      output = (output + text).slice(-12000)
      const last = text.trim().split('\n').filter(Boolean).slice(-1)[0]
      if (last) log(`${label}: ${last}`)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: null, output: `${output}\n${label}: timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, code: null, output: `${label}: ${error instanceof Error ? error.message : String(error)}` })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, code, output })
    })
  })
}

/** Copy the vendored code into the writable app directory, keeping user data. */
function syncAppTree(paths) {
  fs.mkdirSync(paths.appDir, { recursive: true })
  for (const name of DATA_DIRS) fs.mkdirSync(path.join(paths.appDir, name), { recursive: true })

  for (const entry of CODE_ENTRIES) {
    const source = path.join(paths.upstreamDir, entry)
    const target = path.join(paths.appDir, entry)
    if (!fs.existsSync(source)) continue
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(source, target, { recursive: true })
  }

  // Static assets the app mounts; only copied when the package ships them.
  const staticSource = path.join(paths.upstreamDir, 'static')
  if (fs.existsSync(staticSource)) {
    const staticTarget = path.join(paths.appDir, 'static')
    fs.rmSync(staticTarget, { recursive: true, force: true })
    fs.cpSync(staticSource, staticTarget, { recursive: true })
  }

  // Prebuilt Vue console. Shipped so the panel's "open console" works on a fresh
  // install; `ensureFrontend` only rebuilds it when the user supplies `web-ui/`.
  const distSource = path.join(paths.upstreamDir, 'dist')
  if (fs.existsSync(path.join(distSource, 'index.html'))) {
    const distTarget = path.join(paths.appDir, 'dist')
    fs.rmSync(distTarget, { recursive: true, force: true })
    fs.cpSync(distSource, distTarget, { recursive: true })
  }

  // Seed writable files the app expects on first run.
  const example = path.join(paths.upstreamDir, 'config.json.example')
  const config = path.join(paths.appDir, 'config.json')
  if (!fs.existsSync(config) && fs.existsSync(example)) fs.copyFileSync(example, config)

  // `src/app.py` mounts StaticFiles(directory="static") unconditionally and
  // aborts at import when the directory is absent. The packaged copy carries no
  // static assets (they are unrelated screenshots in the upstream repo), so the
  // directory only has to exist.
  const staticDir = path.join(paths.appDir, 'static')
  if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true })

  // The same holds for `dist/assets`: `app.py` mounts it when `dist/` exists, and
  // Starlette raises when the subdirectory is missing. Seeding the empty pair
  // means the backend can boot before the Vue build has ever run.
  const distDir = path.join(paths.appDir, 'dist')
  const assetsDir = path.join(distDir, 'assets')
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })

  const promptsSource = path.join(paths.upstreamDir, 'prompts')
  if (fs.existsSync(promptsSource)) {
    for (const name of fs.readdirSync(promptsSource)) {
      const target = path.join(paths.appDir, 'prompts', name)
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(promptsSource, name), target)
    }
  }
}

/**
 * Create the venv and install the vendored requirements, then stage the app tree.
 *
 * Idempotent: a venv whose marker matches the current requirements is reused, and
 * the app tree is refreshed in place so the user's tasks/results survive a plugin
 * upgrade.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.packageDir
 * @param {string} [options.pythonPath] - interpreter used to create the venv
 * @param {boolean} [options.force] - reinstall dependencies even when the marker matches
 * @param {(...args: unknown[]) => void} [options.log]
 * @param {(...args: unknown[]) => void} [options.warn]
 * @returns {Promise<{ok: boolean, createdVenv: boolean, installedDeps: boolean,
 *   staged: boolean, durationMs: number, python: string, appDir: string,
 *   error: string, output: string}>}
 */
export async function provisionRuntime(options) {
  const { dataDir, packageDir, force = false } = options
  const basePython = options.pythonPath || 'python'
  const log = options.log ?? (() => {})
  const warn = options.warn ?? (() => {})
  const started = Date.now()
  const paths = runtimePaths(dataDir, packageDir)
  const result = {
    ok: false,
    createdVenv: false,
    installedDeps: false,
    staged: false,
    durationMs: 0,
    python: paths.pythonBin,
    appDir: paths.appDir,
    error: '',
    output: '',
  }

  if (!fs.existsSync(path.join(paths.upstreamDir, 'src', 'app.py'))) {
    result.error = `vendored upstream sources missing at ${paths.upstreamDir}`
    return result
  }

  fs.mkdirSync(paths.runtimeDir, { recursive: true })
  const fingerprint = requirementsFingerprint(paths.upstreamDir)

  if (!fs.existsSync(paths.pythonBin) || force) {
    log(`creating virtualenv with ${basePython}`)
    const venv = await run(basePython, ['-m', 'venv', '--clear', paths.venvDir], {
      cwd: paths.runtimeDir,
      timeoutMs: VENV_TIMEOUT_MS,
      log,
      label: 'venv',
    })
    result.output = venv.output
    if (!venv.ok || !fs.existsSync(paths.pythonBin)) {
      result.error =
        venv.output.split('\n').filter(Boolean).slice(-1)[0] ||
        `could not create a virtualenv; is "${basePython}" a Python 3.10+ interpreter on PATH?`
      warn(`runtime venv failed: ${result.error}`)
      result.durationMs = Date.now() - started
      return result
    }
    result.createdVenv = true
  }

  const marker = readMarker(paths.markerFile)
  const depsOk = !force && marker && marker.requirements === fingerprint
  if (!depsOk) {
    log('installing upstream requirements into the plugin venv')
    const install = await run(
      paths.pythonBin,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(paths.upstreamDir, 'requirements.txt')],
      {
        cwd: paths.runtimeDir,
        timeoutMs: INSTALL_TIMEOUT_MS,
        log,
        label: 'pip install',
        env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
      },
    )
    result.output = install.output
    if (!install.ok) {
      result.error = install.output.split('\n').filter(Boolean).slice(-1)[0] || 'pip install failed'
      warn(`runtime deps failed: ${result.error}`)
      result.durationMs = Date.now() - started
      return result
    }
    result.installedDeps = true
    fs.writeFileSync(
      paths.markerFile,
      JSON.stringify({ requirements: fingerprint, installedAt: new Date().toISOString() }, null, 2),
    )
  }

  try {
    syncAppTree(paths)
    result.staged = true
  } catch (error) {
    result.error = `could not stage the app tree: ${error instanceof Error ? error.message : String(error)}`
    warn(result.error)
    result.durationMs = Date.now() - started
    return result
  }

  result.ok = true
  result.durationMs = Date.now() - started
  log(`runtime ready in ${result.durationMs}ms → ${paths.appDir}`)
  return result
}

export { DATA_DIRS, CODE_ENTRIES }
