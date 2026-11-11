/**
 * Frontend build bridge.
 *
 * The FastAPI app mounts `dist/` at startup: `src/app.py` only registers the
 * `/assets` static mount when `dist/` already exists, and every non-API route
 * answers `dist/index.html`. So the console at `http://127.0.0.1:<port>/` needs
 * a build that finished *before* the backend starts — starting the backend on a
 * missing `dist/` silently yields JSON 500s on `/`.
 *
 * This module owns that step: inspect the build state, optionally run
 * `npm run build` in `web-ui/`, and report what happened. It never throws for an
 * expected condition (no Node, no `web-ui/`, install refused); the caller
 * decides whether a missing build blocks the server or only warns.
 *
 * @module lib/frontend
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Files whose presence means a usable build exists. */
const ENTRY_FILES = ['index.html', path.join('assets')]

/** Wall-clock ceiling for `npm install` / `npm run build`. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const BUILD_TIMEOUT_MS = 10 * 60 * 1000

/** Where the frontend sources and the build output live inside the project. */
export function frontendPaths(projectRoot) {
  return {
    webUiDir: path.join(projectRoot, 'web-ui'),
    distDir: path.join(projectRoot, 'dist'),
    indexFile: path.join(projectRoot, 'dist', 'index.html'),
    assetsDir: path.join(projectRoot, 'dist', 'assets'),
  }
}

function hasBuild(distDir, indexFile, assetsDir) {
  try {
    if (!fs.statSync(indexFile).isFile()) return false
    if (!fs.statSync(assetsDir).isDirectory()) return false
    if (!fs.existsSync(distDir)) return false
  } catch {
    return false
  }
  return true
}

/** Newest mtime under a directory, or 0 when it cannot be read. */
function newestMtime(dir, depth = 0) {
  let newest = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < 6) newest = Math.max(newest, newestMtime(full, depth + 1))
      continue
    }
    try {
      newest = Math.max(newest, fs.statSync(full).mtimeMs)
    } catch {
      /* ignore unreadable files */
    }
  }
  return newest
}

/**
 * Describe the build without changing anything.
 *
 * @param {string} projectRoot
 * @returns {{distDir: string, webUiDir: string, built: boolean, stale: boolean,
 *   hasWebUi: boolean, hasNodeModules: boolean, hasPackageJson: boolean,
 *   builtAt: string, newestSource: string, buildError: string}}
 */
export function inspectFrontend(projectRoot) {
  const paths = frontendPaths(projectRoot)
  const built = hasBuild(paths.distDir, paths.indexFile, paths.assetsDir)
  const hasWebUi = fs.existsSync(path.join(paths.webUiDir, 'index.html'))
  const hasPackageJson = fs.existsSync(path.join(paths.webUiDir, 'package.json'))
  const hasNodeModules = fs.existsSync(path.join(paths.webUiDir, 'node_modules'))

  let builtAt = 0
  if (built) {
    try {
      builtAt = fs.statSync(paths.indexFile).mtimeMs
    } catch {
      builtAt = 0
    }
  }
  const newestSource = hasWebUi ? newestMtime(path.join(paths.webUiDir, 'src')) : 0
  const newestConfig = hasWebUi
    ? Math.max(
        filedMtime(path.join(paths.webUiDir, 'package.json')),
        filedMtime(path.join(paths.webUiDir, 'vite.config.ts')),
        filedMtime(path.join(paths.webUiDir, 'index.html')),
      )
    : 0
  const sourceTime = Math.max(newestSource, newestConfig)

  return {
    distDir: paths.distDir,
    webUiDir: paths.webUiDir,
    built,
    stale: built && sourceTime > builtAt,
    hasWebUi,
    hasNodeModules,
    hasPackageJson,
    builtAt: builtAt > 0 ? new Date(builtAt).toISOString() : '',
    newestSource: sourceTime > 0 ? new Date(sourceTime).toISOString() : '',
    buildError: readBuildError(paths.distDir),
  }
}

/** Last failure recorded by `ensureFrontend`, kept beside the build for the UI. */
function buildErrorFile(distDir) {
  return path.join(distDir, '.dsh-build-error.json')
}

function readBuildError(distDir) {
  try {
    const raw = fs.readFileSync(buildErrorFile(distDir), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.error === 'string' ? parsed.error : ''
  } catch {
    return ''
  }
}

/** Persist the last build failure so a later status call can explain a 500 page. */
function recordBuildError(distDir, error) {
  try {
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(
      buildErrorFile(distDir),
      JSON.stringify({ at: new Date().toISOString(), error: String(error).slice(0, 4000) }, null, 2),
    )
  } catch {
    /* reporting the failure is best-effort */
  }
}

/** Clear the recorded failure after a successful build. */
function clearBuildError(distDir) {
  try {
    fs.rmSync(buildErrorFile(distDir), { force: true })
  } catch {
    /* ignore */
  }
}

function filedMtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Run one npm script in `web-ui/`, streaming output to the plugin log. */
function runNpm(args, { cwd, timeoutMs, log, label }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      child = spawn('npm', args, {
        cwd,
        shell: process.platform === 'win32',
        env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, code: null, output: `could not spawn npm: ${error instanceof Error ? error.message : String(error)}` })
      return
    }

    let output = ''
    const capture = (chunk) => {
      const text = String(chunk)
      output = (output + text).slice(-8000)
      const line = text.trim()
      if (line !== '') log(`${label}: ${line.split('\n').slice(-1)[0]}`)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: null, output: output + `\n${label}: timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, code: null, output: `npm error: ${error instanceof Error ? error.message : String(error)}` })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, code, output })
    })
  })
}

/**
 * Ensure `dist/` matches the sources, building when needed.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {boolean} [options.force] - build even when a fresh build exists
 * @param {boolean} [options.install] - run `npm install` when `node_modules` is missing
 * @param {(...args: unknown[]) => void} [options.log]
 * @param {(...args: unknown[]) => void} [options.warn]
 * @returns {Promise<{built: boolean, skipped: boolean, reason: string,
 *   installed: boolean, durationMs: number, distDir: string, error: string,
 *   output: string}>}
 */
export async function ensureFrontend(options) {
  const { projectRoot, force = false, install = true } = options
  const log = options.log ?? (() => {})
  const warn = options.warn ?? (() => {})
  const started = Date.now()
  const before = inspectFrontend(projectRoot)
  const result = {
    built: false,
    skipped: false,
    reason: '',
    installed: false,
    durationMs: 0,
    distDir: before.distDir,
    error: '',
    output: '',
  }

  if (!before.hasWebUi || !before.hasPackageJson) {
    result.skipped = true
    result.reason = `no frontend sources at ${before.webUiDir}`
    return result
  }
  if (before.built && !before.stale && !force) {
    result.skipped = true
    result.reason = 'build is up to date'
    return result
  }

  if (!before.hasNodeModules) {
    if (!install) {
      result.skipped = true
      result.reason = 'web-ui/node_modules is missing and install is disabled'
      return result
    }
    log(`installing frontend dependencies in ${before.webUiDir}`)
    const installed = await runNpm(['install', '--no-audit', '--no-fund', '--replace-registry-host=always'], {
      cwd: before.webUiDir,
      timeoutMs: INSTALL_TIMEOUT_MS,
      log,
      label: 'npm install',
    })
    result.output = installed.output
    if (!installed.ok) {
      result.skipped = true
      result.reason = 'npm install failed'
      result.error = installed.output.split('\n').filter(Boolean).slice(-1)[0] ?? 'npm install failed'
      warn(`frontend install failed: ${result.error}`)
      result.durationMs = Date.now() - started
      return result
    }
    result.installed = true
  }

  log(`building frontend in ${before.webUiDir}`)
  const built = await runNpm(['run', 'build'], {
    cwd: before.webUiDir,
    timeoutMs: BUILD_TIMEOUT_MS,
    log,
    label: 'npm run build',
  })
  result.output = built.output
  const after = inspectFrontend(projectRoot)
  result.built = after.built && built.ok
  if (!result.built) {
    result.error = built.ok
      ? 'build command succeeded but dist/index.html or dist/assets is missing'
      : (built.output.split('\n').filter(Boolean).slice(-1)[0] ?? 'npm run build failed')
    recordBuildError(after.distDir, result.error)
    warn(`frontend build failed: ${result.error}`)
  } else {
    clearBuildError(after.distDir)
    log(`frontend built in ${Date.now() - started}ms → ${after.distDir}`)
  }
  result.durationMs = Date.now() - started
  return result
}

export { ENTRY_FILES }
