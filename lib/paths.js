/**
 * Filesystem locations for the plugin: DSH home, the ai-goofish-monitor project
 * root, the runtime data directory this plugin owns, and the project `.env`.
 *
 * @module lib/paths
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory containing index.js / lib/ (the bundle package root). */
export function packageDir() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)))
}

/**
 * Harness home: `$DSH_HOME` else `~/.dsh` — the same resolution the shipped
 * `our-free-model` plugin uses for its own data directory.
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * An explicitly configured ai-goofish-monitor checkout, or '' for "use the
 * vendored copy".
 *
 * Only an explicit `projectRoot` counts. The plugin ships its own sources in
 * `upstream/`, so silently adopting a sibling checkout would make the installed
 * plugin depend on a directory the user never asked it to use — and would switch
 * behaviour based on whatever happens to sit next to the package.
 *
 * @param {string} configured - `projectRoot` from the row config
 * @returns {string} absolute path, or '' when the vendored runtime applies
 */
export function resolveProjectRoot(configured) {
  const configuredText = typeof configured === 'string' ? configured.trim() : ''
  if (configuredText !== '') return path.resolve(configuredText)
  return ''
}

/** True when the package ships its own copy of the upstream sources. */
export function hasVendoredUpstream(selfDir = packageDir()) {
  try {
    return fs.statSync(path.join(selfDir, 'upstream', 'src', 'app.py')).isFile()
  } catch {
    return false
  }
}

/** Directory name of the upstream project, used only for diagnostics. */
export const UPSTREAM_DIR_NAME = 'ai-goofish-monitor'

/** Plugin-owned runtime data (backend logs, state); created on demand. */
export function pluginDataDir(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'dsh-free-xianyu')
}

/** The project's env file, read by both the FastAPI app and the spider. */
export function projectEnvFile(projectRoot) {
  return path.join(projectRoot, '.env')
}

/** Where the managed backend process writes stdout/stderr. */
export function backendLogFile(dshHome = resolveDshHome()) {
  return path.join(pluginDataDir(dshHome), 'backend.log')
}
