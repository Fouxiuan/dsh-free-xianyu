/**
 * Offline self-test for the browser half (`client.js`).
 *
 * Runs the bundle in a sandbox with a fake `window.__ModuleLoader__` and a fake
 * React, then asserts the registration contract the shell relies on: the two
 * slot registrations, the panel id shared by both, the exports shape, and the
 * packaging facts (declared client entry, built file present).
 *
 * The crash that motivated this test was a browser entry that never reached
 * ACTIVE, so the guards here are also about *not* throwing: `apply()` must
 * survive a missing service, and the module top level must do nothing but
 * register its factory.
 *
 * Run: node dsh-plugin/client.selftest.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, 'client.js')
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
const source = fs.readFileSync(clientPath, 'utf8')

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

/** Load the bundle in a sandbox and return { loader, exports, registrations }. */
function loadBundle() {
  let loader = null
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
  }
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load(definition) {
          if (loader !== null) throw new Error('load() called twice')
          loader = definition
        },
      },
    },
    fetch() {
      throw new Error('client.js must not fetch at module scope')
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.notEqual(loader, null, 'client.js never called window.__ModuleLoader__.load')
  const exports = loader.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  })
  return { loader, exports, React }
}

console.log('client.selftest:')
const { loader, exports: clientExports, React } = loadBundle()

check('loader definition id is the package name', () => {
  assert.equal(loader.id, pkg.name)
})

check('factory returns { name, inject, apply }', () => {
  assert.equal(typeof clientExports, 'object')
  assert.equal(clientExports.name, pkg.name)
  assert.deepEqual([...clientExports.inject], ['slots'])
  assert.equal(typeof clientExports.apply, 'function')
})

check('apply registers sidebar.panellist + main with one shared id', () => {
  const seen = []
  const ctx = {
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(definition, component) {
        seen.push({ definition, component })
        return () => {}
      },
    },
  }
  clientExports.apply(ctx)
  assert.equal(seen.length, 2, 'expected exactly two registrations')
  const [panellist, main] = seen
  assert.equal(panellist.definition.name, 'sidebar.panellist')
  assert.equal(panellist.definition.id, pkg.name)
  assert.equal(typeof panellist.definition.order, 'number')
  assert.equal(typeof panellist.definition.label, 'function')
  assert.equal(panellist.definition.label(), '闲鱼免费监控')
  assert.equal(main.definition.name, 'main')
  assert.equal(main.definition.key, pkg.name, 'main panel must be keyed by the sidebar id')
  assert.equal(typeof panellist.component, 'function')
  assert.equal(typeof main.component, 'function')
})

check('apply tolerates a missing or foreign service without throwing', () => {
  assert.equal(clientExports.apply({}), undefined)
  assert.equal(clientExports.apply({ slots: {} }), undefined)
  const throwing = {
    slots: {
      inject() {
        throw new Error('service exploded')
      },
      register() {
        throw new Error('service exploded')
      },
    },
  }
  assert.equal(clientExports.apply(throwing), undefined)
})

check('icon renders an svg that honours the size prop', () => {
  const { component } = (() => {
    const seen = []
    clientExports.apply({
      slots: { inject: (_n, cb) => cb(), register: (definition, component) => seen.push({ definition, component }) },
    })
    return seen[0]
  })()
  const icon = component({ size: 20 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 20)
  const fallback = component({})
  assert.equal(typeof fallback.props.width, 'number')
})

check('page component is a component function', () => {
  const seen = []
  clientExports.apply({
    slots: { inject: (_n, cb) => cb(), register: (definition, component) => seen.push({ definition, component }) },
  })
  const page = seen[1].component
  assert.equal(typeof page, 'function')
  // Hooks cannot run outside a renderer; the shape check is what matters here.
  assert.equal(page.length <= 1, true)
})

check('module top level only registers a factory (no fetch, no side effects)', () => {
  assert.equal(source.includes('settings.section'), false, 'the retired settings page registration must not come back')
  assert.equal(source.includes('immediately'), false, 'client.js must not force eager graph rows')
  const fetchCall = /\bfetch\s*\(/.exec(source)
  assert.notEqual(fetchCall, null, 'the page fetches its API lazily, inside handlers')
  assert.equal(typeof React.createElement, 'function')
})

check('package declares the built browser entry', () => {
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately === true, false, 'no eager activation')
  assert.ok(fs.existsSync(path.join(here, 'client.js')), 'client.js must exist at the declared path')
  assert.ok(pkg.files.includes('client.js'), 'npm files must ship client.js')
})

check('bundle parses as a classic script', () => {
  assert.equal(source.includes('export '), false, 'the served bundle must not contain ESM export syntax')
  assert.equal(source.trimEnd().endsWith('})()'), true, 'expected the IIFE wrapper')
})

console.log(`\nclient.selftest: ${checks}/${checks} passed`)
