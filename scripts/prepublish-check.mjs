#!/usr/bin/env node
/**
 * Pre-publish gate.
 *
 * Runs automatically from `npm run prepublishOnly`, before npm builds the
 * tarball, so a broken package cannot reach the registry. It checks the things a
 * published artifact actually needs — the vendored sources, the prebuilt
 * console, the bundle manifest — and then runs every offline self-test.
 *
 * Deliberately no dependencies: this runs in the repository, not in a consumer
 * install, and a gate that needs `npm install` first is a gate people skip.
 *
 * Run directly with: node scripts/prepublish-check.mjs
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const failures = []

function check(label, fn) {
  try {
    const detail = fn()
    console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

function requireFile(relative) {
  const full = path.join(root, relative)
  if (!fs.existsSync(full)) throw new Error(`missing ${relative}`)
  return fs.statSync(full).size
}

function requireDir(relative, minimum) {
  const full = path.join(root, relative)
  if (!fs.existsSync(full)) throw new Error(`missing ${relative}/`)
  let count = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name))
      else count += 1
    }
  }
  walk(full)
  if (count < minimum) throw new Error(`${relative}/ has only ${count} files, expected at least ${minimum}`)
  return `${count} files`
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

console.log('prepublish-check:')

check('package is publishable', () => {
  if (pkg.private === true) throw new Error('"private": true blocks npm publish')
  if (pkg.publishConfig?.access !== 'public') throw new Error('publishConfig.access must be "public"')
  return `${pkg.name}@${pkg.version}`
})

check('bundle manifest is declared', () => {
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch must be ./cordis.patch.yml')
  requireFile('cordis.patch.yml')
  return pkg.dsh.bundle.patch
})

check('browser half is declared and shipped', () => {
  if (pkg.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform must be "web"')
  if (pkg.exports?.['./client'] !== './client.js') throw new Error('exports["./client"] must point at ./client.js')
  requireFile('client.js')
  return pkg.dsh.client.platform
})

check('host half exists', () => {
  requireFile('index.js')
  return 'index.js'
})

check('vendored upstream sources are present', () => {
  requireFile('upstream/requirements.txt')
  requireFile('upstream/spider_v2.py')
  return requireDir('upstream/src', 60)
})

check('prebuilt console ships with the package', () => {
  requireFile('upstream/dist/index.html')
  return requireDir('upstream/dist/assets', 10)
})

check('LICENSE and NOTICE ship', () => {
  requireFile('LICENSE')
  requireFile('NOTICE.md')
  return 'MIT + third-party notices'
})

check('npm files whitelist covers everything the plugin needs', () => {
  const listed = pkg.files ?? []
  for (const required of ['index.js', 'client.js', 'lib', 'upstream', 'cordis.patch.yml', 'LICENSE']) {
    if (!listed.includes(required)) throw new Error(`files[] does not list ${required}`)
  }
  return `${listed.length} entries`
})

check('repository metadata points at the public repo', () => {
  const url = pkg.repository?.url ?? ''
  if (!url.includes('github.com/Fouxiuan/dsh-free-xianyu')) throw new Error(`unexpected repository URL: ${url}`)
  return url
})

console.log('\nprepublish-check: offline self-tests')

for (const test of [
  'client.selftest.mjs',
  'lib/runtime.selftest.mjs',
  'lib/frontend.selftest.mjs',
  'lib/gateway.selftest.mjs',
  'lib/goofish-api.selftest.mjs',
]) {
  check(test, () => {
    execFileSync(process.execPath, [test], { cwd: root, stdio: 'pipe' })
    return 'passed'
  })
}

if (failures.length > 0) {
  console.error(`\nprepublish-check: ${failures.length} check(s) failed — refusing to publish`)
  console.error(`  ${failures.join('\n  ')}`)
  process.exit(1)
}

console.log('\nprepublish-check: ready to publish')
