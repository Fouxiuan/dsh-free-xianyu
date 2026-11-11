/**
 * Offline self-test for `lib/frontend.js`.
 *
 * Builds throwaway project fixtures under the OS temp directory and asserts the
 * state machine that decides whether the console can be served:
 *
 *   - no `web-ui/`            → nothing to build, reported as skipped
 *   - sources but no build    → `built: false`, so the caller must build
 *   - build older than source → `stale: true`, so `autoBuildFrontend` rebuilds
 *   - build newer than source → `stale: false`, so a restart only remounts
 *
 * `ensureFrontend` is exercised only on the paths that never spawn npm: the
 * "no sources" skip and the "up to date" skip. A real build is left to the
 * integration check, because spawning npm in a unit test makes it slow and
 * network-dependent.
 *
 * Run: node dsh-plugin/lib/frontend.selftest.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ensureFrontend, frontendPaths, inspectFrontend } from './frontend.js'

let checks = 0
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

const roots = []

/** Create a throwaway project root and remember it for cleanup. */
function makeRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `goofish-frontend-${name}-`))
  roots.push(root)
  return root
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** Give a fixture an apparent build, stamped at `mtime`. */
function writeBuild(root, mtime) {
  const { distDir, indexFile, assetsDir } = frontendPaths(root)
  write(indexFile, '<!doctype html><title>console</title>')
  write(path.join(assetsDir, 'index-abc.js'), 'console.log(1)\n')
  fs.utimesSync(indexFile, mtime, mtime)
}

/** Give a fixture frontend sources, stamped at `mtime`. */
function writeSources(root, mtime) {
  const { webUiDir } = frontendPaths(root)
  const files = [
    path.join(webUiDir, 'index.html'),
    path.join(webUiDir, 'package.json'),
    path.join(webUiDir, 'vite.config.ts'),
    path.join(webUiDir, 'src', 'main.ts'),
  ]
  write(files[0], '<div id="app"></div>')
  write(files[1], JSON.stringify({ name: 'web-ui', scripts: { build: 'vite build' } }))
  write(files[2], 'export default {}\n')
  write(files[3], 'export {}\n')
  // Every file the staleness scan reads must share the fixture's timestamp,
  // otherwise "now" (the real clock) would look newer than a seeded build.
  for (const file of files) fs.utimesSync(file, mtime, mtime)
}

console.log('frontend.selftest:')

await check('inspectFrontend: no frontend sources -> nothing to build', () => {
  const root = makeRoot('empty')
  const state = inspectFrontend(root)
  assert.equal(state.hasWebUi, false)
  assert.equal(state.built, false)
  assert.equal(state.stale, false)
  assert.equal(state.buildError, '')
})

await check('inspectFrontend: sources without a build -> built false', () => {
  const root = makeRoot('unbuilt')
  writeSources(root, new Date('2026-01-01T00:00:00Z'))
  const state = inspectFrontend(root)
  assert.equal(state.hasWebUi, true)
  assert.equal(state.hasPackageJson, true)
  assert.equal(state.hasNodeModules, false)
  assert.equal(state.built, false)
})

await check('inspectFrontend: a partial build is not a build', () => {
  const root = makeRoot('partial')
  writeSources(root, new Date('2026-01-01T00:00:00Z'))
  const { indexFile } = frontendPaths(root)
  write(indexFile, '<!doctype html>')
  // assets/ is missing on purpose.
  assert.equal(inspectFrontend(root).built, false)
})

await check('inspectFrontend: build older than sources -> stale', () => {
  const root = makeRoot('stale')
  writeBuild(root, new Date('2026-01-01T00:00:00Z'))
  writeSources(root, new Date('2026-02-01T00:00:00Z'))
  const state = inspectFrontend(root)
  assert.equal(state.built, true)
  assert.equal(state.stale, true)
  assert.notEqual(state.builtAt, '')
  assert.notEqual(state.newestSource, '')
})

await check('inspectFrontend: build newer than sources -> fresh', () => {
  const root = makeRoot('fresh')
  writeSources(root, new Date('2026-01-01T00:00:00Z'))
  writeBuild(root, new Date('2026-02-01T00:00:00Z'))
  const state = inspectFrontend(root)
  assert.equal(state.built, true)
  assert.equal(state.stale, false)
})

await check('inspectFrontend: a recorded build failure is reported', () => {
  const root = makeRoot('failure')
  writeBuild(root, new Date('2026-02-01T00:00:00Z'))
  writeSources(root, new Date('2026-01-01T00:00:00Z'))
  const { distDir } = frontendPaths(root)
  write(path.join(distDir, '.dsh-build-error.json'), JSON.stringify({ error: 'vite: boom' }))
  assert.equal(inspectFrontend(root).buildError, 'vite: boom')
})

await check('ensureFrontend: no sources -> skipped, never spawns npm', async () => {
  const root = makeRoot('nosources')
  const result = await ensureFrontend({ projectRoot: root })
  assert.equal(result.skipped, true)
  assert.equal(result.built, false)
  assert.match(result.reason, /no frontend sources/)
})

await check('ensureFrontend: fresh build -> skipped as up to date', async () => {
  const root = makeRoot('uptodate')
  writeSources(root, new Date('2026-01-01T00:00:00Z'))
  writeBuild(root, new Date('2026-02-01T00:00:00Z'))
  const result = await ensureFrontend({ projectRoot: root })
  assert.equal(result.skipped, true)
  assert.equal(result.built, false, 'a skip must not claim it built anything')
  assert.equal(result.reason, 'build is up to date')
})

await check('ensureFrontend: missing node_modules honours install=false', async () => {
  const root = makeRoot('noinstall')
  writeSources(root, new Date('2026-01-01T00:00:00Z'))
  const result = await ensureFrontend({ projectRoot: root, install: false })
  assert.equal(result.skipped, true)
  assert.match(result.reason, /node_modules/)
})

console.log(`\nfrontend.selftest: ${checks}/${checks} passed`)

for (const root of roots) {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* Windows may still hold a handle; temp cleanup is best-effort */
  }
}
