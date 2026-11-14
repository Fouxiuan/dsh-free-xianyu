/**
 * Offline self-test for `lib/python.js`.
 *
 * The provisioner used to assume a `python` binary exists, which is false on a
 * stock macOS install — the plugin then reported "backend stopped" with an empty
 * log. These checks pin the behaviour that replaced it: a version gate, a
 * platform-aware candidate list, and a failure that names what was tried.
 *
 * Run: node lib/python.selftest.mjs
 */

import assert from 'node:assert/strict'

import {
  detectPython,
  isSupportedVersion,
  parseVersion,
  pythonCandidates,
  resetPythonCache,
  MIN_PYTHON,
} from './python.js'

let checks = 0
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

console.log('python.selftest:')

await check('parseVersion understands release strings and rejects junk', () => {
  assert.deepEqual(parseVersion('3.12.4'), [3, 12, 4])
  assert.deepEqual(parseVersion('3.10'), [3, 10, 0])
  assert.deepEqual(parseVersion('3.12.4 (main, Oct 25 2026)'), [3, 12, 4])
  assert.deepEqual(parseVersion('not a version'), [])
  assert.deepEqual(parseVersion(''), [])
})

await check('isSupportedVersion enforces the 3.10 floor', () => {
  assert.equal(isSupportedVersion([3, 10, 0]), true)
  assert.equal(isSupportedVersion([3, 12, 1]), true)
  assert.equal(isSupportedVersion([4, 0, 0]), true)
  assert.equal(isSupportedVersion([3, 9, 18]), false)
  assert.equal(isSupportedVersion([2, 7, 18]), false)
  assert.equal(isSupportedVersion([]), false)
  assert.deepEqual(MIN_PYTHON, [3, 10])
})

await check('pythonCandidates: Unix tries python3 before python and knows Homebrew paths', () => {
  const names = pythonCandidates({ platform: 'darwin', env: {} }).map((c) => c.command)
  assert.equal(names[0], 'python3', 'python3 must be the first guess on macOS')
  assert.ok(names.includes('python'))
  assert.ok(names.includes('/opt/homebrew/bin/python3'))
  assert.equal(new Set(names).size, names.length, 'candidates must be de-duplicated')
})

await check('pythonCandidates: Windows uses the py launcher', () => {
  const candidates = pythonCandidates({ platform: 'win32', env: {} })
  assert.ok(candidates.some((c) => c.command === 'py' && c.args.includes('-3')))
  assert.equal(candidates[0].command, 'py')
})

await check('pythonCandidates: an explicit pythonPath is the only candidate', () => {
  const candidates = pythonCandidates({ configured: '/usr/local/bin/python3.12', platform: 'darwin', env: {} })
  assert.deepEqual(candidates, [{ command: '/usr/local/bin/python3.12', args: [] }])
})

await check('pythonCandidates: an env override is honoured before the guesses', () => {
  const candidates = pythonCandidates({
    platform: 'linux',
    env: { DSH_FREE_XIANYU_PYTHON: '/opt/py/bin/python3' },
  })
  assert.equal(candidates[0].command, '/opt/py/bin/python3')
})

await check('detectPython fails clearly when the configured interpreter is missing', async () => {
  resetPythonCache()
  const detection = await detectPython({ configured: 'definitely-not-python-xyz', timeoutMs: 15000 })
  assert.equal(detection.ok, false)
  assert.match(detection.error, /definitely-not-python-xyz/, 'the error must name the configured interpreter')
  assert.match(detection.error, /pythonPath/, 'the error must point at the setting')
  assert.equal(detection.tried.length, 1)
  assert.equal(detection.tried[0].ok, false)
})

await check('detectPython reports an executable that cannot speak Python', async () => {
  resetPythonCache()
  // node is a real executable, but `node -c ...` exits non-zero: a stand-in for
  // "found a binary, wrong program" that exists on every machine running this.
  const detection = await detectPython({ configured: process.execPath, timeoutMs: 15000 })
  assert.equal(detection.ok, false)
  assert.equal(detection.tried.length, 1)
  assert.ok(detection.tried[0].error.length > 0)
})

console.log(`\npython.selftest: ${checks}/${checks} passed`)
