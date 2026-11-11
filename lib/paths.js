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
 * The ai-goofish-monitor checkout.
 *
 * An explicit config value always wins. Otherwise the plugin looks for the
 * upstream project next to itself, which is how the README suggests laying the
 * two repositories out:
 *
 * ```
 * <parent>/ai-goofish-monitor   ← the upstream project
 * <parent>/dsh-free-xianyu      ← this plugin
 * ```
 *
 * A plain sibling scan keeps the default usable for the common layout, and the
 * parent directory stays the last resort so an in-tree checkout still works.
 *
 * @param {string} configured - `projectRoot` from the row config
 * @param {string} [selfDir] - this package's directory (for tests)
 */
export function resolveProjectRoot(configured, selfDir = packageDir()) {
  const configuredText = typeof configured === 'string' ? configured.trim() : ''
  if (configuredText !== '') return path.resolve(configuredText)

  const parent = path.dirname(selfDir)
  const sibling = path.join(parent, UPSTREAM_DIR_NAME)
  try {
    if (fs.statSync(path.join(sibling, 'src', 'app.py')).isFile()) return sibling
  } catch {
    /* no sibling checkout: fall through */
  }
  return parent
}

/** Directory name of the upstream project this plugin drives. */
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
