/**
 * Offline self-test for `lib/runtime.js`.
 *
 * Exercises the state machine that decides whether the plugin can start on its
 * own: the vendored sources must be present, a missing venv must be reported as
 * such, and a venv whose marker does not match the vendored requirements must
 * ask for an install. `provisionRuntime` is only driven down its npm-free paths
 * here; the real create/install/stage cycle is covered by an integration run
 * because a venv build takes ~40s and needs the network.
 *
 * Run: node lib/runtime.selftest.mjs
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectRuntime, provisionRuntime, runtimePaths, DATA_DIRS, CODE_ENTRIES } from './runtime.js'

let checks = 0
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.dirname(here)
const scratch = []

function makeData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-runtime-'))
  scratch.push(dir)
  return dir
}

/** A fake package root carrying just enough of `upstream/` for the checks. */
function makePackage(requirements = 'fastapi\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-pkg-'))
  scratch.push(dir)
  fs.mkdirSync(path.join(dir, 'upstream', 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'upstream', 'src', 'app.py'), '# app\n')
  fs.writeFileSync(path.join(dir, 'upstream', 'requirements.txt'), requirements)
  return dir
}

function fingerprintOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

console.log('runtime.selftest:')

await check('the shipped package carries the vendored sources', () => {
  const paths = runtimePaths(makeData(), packageDir)
  assert.ok(fs.existsSync(path.join(paths.upstreamDir, 'src', 'app.py')), 'upstream/src/app.py must exist in the package')
  assert.ok(fs.existsSync(path.join(paths.upstreamDir, 'requirements.txt')), 'upstream/requirements.txt must exist')
})

await check('runtimePaths: venv python and app dir live under the plugin data dir', () => {
  const dataDir = makeData()
  const paths = runtimePaths(dataDir, packageDir)
  assert.equal(paths.runtimeDir, path.join(dataDir, 'runtime'))
  assert.equal(paths.appDir, path.join(dataDir, 'runtime', 'app'))
  assert.ok(paths.pythonBin.startsWith(paths.venvDir), 'interpreter must be inside the venv')
  assert.ok(paths.pythonBin.endsWith(process.platform === 'win32' ? 'python.exe' : 'python'))
})

await check('inspectRuntime: fresh data dir needs a venv and dependencies', () => {
  const dataDir = makeData()
  const pkg = makePackage()
  const state = inspectRuntime({ dataDir, packageDir: pkg })
  assert.equal(state.ready, false)
  assert.equal(state.needsVenv, true)
  assert.equal(state.needsDeps, true)
  assert.equal(state.pythonFound, false)
  assert.equal(state.upstreamFiles, 1, 'one file under upstream/src')
  assert.equal(state.error, '')
})

await check('inspectRuntime: a matching marker plus a venv means ready', () => {
  const dataDir = makeData()
  const pkg = makePackage('fastapi\n')
  const paths = runtimePaths(dataDir, pkg)
  fs.mkdirSync(path.dirname(paths.pythonBin), { recursive: true })
  fs.writeFileSync(paths.pythonBin, '')
  fs.mkdirSync(path.join(paths.appDir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(paths.appDir, 'src', 'app.py'), '# staged\n')
  fs.mkdirSync(paths.runtimeDir, { recursive: true })
  fs.writeFileSync(
    paths.markerFile,
    JSON.stringify({ requirements: fingerprintOf('fastapi\n'), installedAt: '2026-01-01T00:00:00.000Z' }),
  )
  const state = inspectRuntime({ dataDir, packageDir: pkg })
  assert.equal(state.needsVenv, false)
  assert.equal(state.needsDeps, false)
  assert.equal(state.ready, true)
  assert.equal(state.depsInstalledAt, '2026-01-01T00:00:00.000Z')
})

await check('inspectRuntime: changed requirements invalidate the marker', () => {
  const dataDir = makeData()
  const pkg = makePackage('fastapi\nuvicorn\n')
  const paths = runtimePaths(dataDir, pkg)
  fs.mkdirSync(path.dirname(paths.pythonBin), { recursive: true })
  fs.writeFileSync(paths.pythonBin, '')
  fs.writeFileSync(paths.markerFile, JSON.stringify({ requirements: fingerprintOf('fastapi\n'), installedAt: 'x' }))
  const state = inspectRuntime({ dataDir, packageDir: pkg })
  assert.equal(state.needsDeps, true, 'a requirements change must force a reinstall')
})

await check('inspectRuntime: missing vendored sources are reported, never thrown', () => {
  const dataDir = makeData()
  const emptyPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-empty-'))
  scratch.push(emptyPkg)
  const state = inspectRuntime({ dataDir, packageDir: emptyPkg })
  assert.equal(state.ready, false)
  assert.match(state.error, /missing/)
})

await check('provisionRuntime: missing vendored sources fail with a clear error', async () => {
  const dataDir = makeData()
  const emptyPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-empty2-'))
  scratch.push(emptyPkg)
  const result = await provisionRuntime({ dataDir, packageDir: emptyPkg, pythonPath: 'definitely-not-python-xyz' })
  assert.equal(result.ok, false)
  assert.match(result.error, /missing/)
})

await check('provisionRuntime: an unusable interpreter fails without throwing', async () => {
  const dataDir = makeData()
  const pkg = makePackage()
  const result = await provisionRuntime({
    dataDir,
    packageDir: pkg,
    pythonPath: 'definitely-not-python-xyz',
  })
  assert.equal(result.ok, false)
  assert.equal(result.createdVenv, false)
  assert.ok(result.error.length > 0, 'the failure must carry a message')
})

await check('staging lists are the directories the app writes into', () => {
  for (const name of ['jsonl', 'logs', 'images', 'state', 'data', 'prompts', 'dist']) {
    assert.ok(DATA_DIRS.includes(name), `${name} must be preserved as runtime data`)
  }
  assert.deepEqual([...CODE_ENTRIES], ['src', 'spider_v2.py', 'requirements.txt'])
})

console.log(`\nruntime.selftest: ${checks}/${checks} passed`)

for (const dir of scratch) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows may still hold a handle; temp cleanup is best-effort */
  }
}
