#!/usr/bin/env node
/**
 * Fixture-driven self-test for `lib/gateway.js`.
 *
 * Plain node, no test framework, no packages, and — deliberately — no real
 * gateway: every HTTP interaction is a tiny server bound to 127.0.0.1:0, and
 * every settings/catalog fixture lives in a fresh temp directory. The machine's
 * real Our Free Model listener is neither required nor contacted.
 *
 * Run: `node dsh-plugin/lib/gateway.selftest.mjs`
 * Prints PASS/FAIL per case and exits non-zero when any case fails.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  resolveGatewayPaths,
  discoverGateway,
  listGatewayModels,
  pickDefaultModel,
  syncAiEnv,
  readAiEnv,
} from './gateway.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-gateway-selftest-'))
const KEY = 'ofm-selftest-key-123'
const servers = new Set()

let passed = 0
let failed = 0

// ── fixtures ──────────────────────────────────────────────────────────────────

/** settings.json + catalog.json under a throwaway DSH home. */
function writeHome(name, { settings, catalog } = {}) {
  const home = path.join(TMP, name)
  const dataDir = path.join(home, 'our-free-model')
  fs.mkdirSync(dataDir, { recursive: true })
  const settingsPath = path.join(dataDir, 'settings.json')
  const catalogPath = path.join(dataDir, 'catalog.json')
  if (settings !== undefined) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
  if (catalog !== undefined) fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8')
  return { home, dataDir, settingsPath, catalogPath }
}

const CATALOG = {
  version: 1,
  at: 0,
  entries: ['deepseek-v4.1-flash-free', 'big-pickle'],
  kiloRows: [
    { id: 'nvidia/nemotron-3.5-super-vl:free', vision: true, channel: 'kilo', name: 'Nemotron VL' },
    { id: 'kilo-auto/free', vision: false, channel: 'kilo', name: 'Kilo Auto' },
  ],
}

/** Tiny OpenAI-shaped `/v1/models` server. Records every request it sees. */
function startModelsServer({ apiKey = '', models = [], status = 200, rawBody } = {}) {
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url ?? '',
      authorization: request.headers.authorization ?? '',
    })
    let pathname = ''
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '')
    } catch {
      pathname = ''
    }
    if (request.method !== 'GET' || (pathname !== '/v1/models' && pathname !== '/models')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    if (apiKey !== '' && request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'missing or invalid API key' } }))
      return
    }
    response.writeHead(status, { 'content-type': 'application/json' })
    if (rawBody !== undefined) {
      response.end(rawBody)
      return
    }
    const data = models.map(model =>
      typeof model === 'string'
        ? { id: model, object: 'model', created: 0, owned_by: 'our-free-model' }
        : model,
    )
    response.end(JSON.stringify({ object: 'list', data }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      servers.add(server)
      resolve({ server, port: server.address().port, requests })
    })
  })
}

function stopServer(server) {
  servers.delete(server)
  return new Promise(resolve => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

/** A 127.0.0.1 port that was just proven closed. */
async function closedPort() {
  const info = await startModelsServer()
  await stopServer(info.server)
  return info.port
}

// ── harness ───────────────────────────────────────────────────────────────────

async function test(name, run) {
  try {
    await run()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${name}`)
    const detail = String(error?.stack ?? error)
    for (const line of detail.split('\n')) console.error(`      ${line}`)
  }
}

const byId = models => new Map(models.map(model => [model.id, model]))

// ── cases ─────────────────────────────────────────────────────────────────────

await test('resolveGatewayPaths: explicit home maps to our-free-model data dir', () => {
  const home = path.join(TMP, 'paths-home')
  const paths = resolveGatewayPaths(home)
  assert.equal(paths.settingsPath, path.join(home, 'our-free-model', 'settings.json'))
  assert.equal(paths.catalogPath, path.join(home, 'our-free-model', 'catalog.json'))
  assert.equal(paths.dataDir, path.join(home, 'our-free-model'))
})

await test('resolveGatewayPaths: DSH_HOME fallback, then ~/.dsh', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = path.join(TMP, 'env-home')
    assert.equal(
      resolveGatewayPaths().settingsPath,
      path.join(TMP, 'env-home', 'our-free-model', 'settings.json'),
    )
    delete process.env.DSH_HOME
    assert.equal(
      resolveGatewayPaths().settingsPath,
      path.join(os.homedir(), '.dsh', 'our-free-model', 'settings.json'),
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

await test('discoverGateway: absent settings.json -> unavailable, never throws', async () => {
  const home = path.join(TMP, 'absent-home')
  fs.mkdirSync(home, { recursive: true })
  let fetchCalls = 0
  const result = await discoverGateway({
    dshHome: home,
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('must not probe without settings')
    },
    timeoutMs: 200,
  })
  assert.equal(result.source, 'unavailable')
  assert.equal(result.enabled, false)
  assert.equal(result.running, false)
  assert.equal(result.baseURL, '')
  assert.equal(result.key, '')
  assert.equal(fetchCalls, 0)
  assert.ok(result.error.length > 0)
  assert.equal(result.settingsPath, path.join(home, 'our-free-model', 'settings.json'))
})

await test('discoverGateway: invalid settings.json -> unavailable, never throws', async () => {
  const fixture = writeHome('invalid-home')
  fs.writeFileSync(fixture.settingsPath, '{ this is not json', 'utf8')
  const result = await discoverGateway({ dshHome: fixture.home, timeoutMs: 200 })
  assert.equal(result.source, 'unavailable')
  assert.equal(result.enabled, false)
  assert.equal(result.running, false)
  assert.ok(result.error.length > 0)
})

await test('discoverGateway: disabled forward listener -> source disabled, no probe', async () => {
  const fixture = writeHome('disabled-home', {
    settings: {
      version: 1,
      forward: { enabled: false, host: '127.0.0.1', port: 18899, lan: { enabled: false, port: 0 } },
      forwardKey: 'ofm-test-key',
    },
  })
  let fetchCalls = 0
  const result = await discoverGateway({
    dshHome: fixture.home,
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('a disabled listener must not be probed')
    },
    timeoutMs: 200,
  })
  assert.equal(result.source, 'disabled')
  assert.equal(result.enabled, false)
  assert.equal(result.running, false)
  assert.equal(result.port, 18899)
  assert.equal(result.baseURL, 'http://127.0.0.1:18899/v1')
  assert.equal(result.key, 'ofm-test-key')
  assert.equal(result.error, '')
  assert.equal(fetchCalls, 0)
})

await test('discoverGateway: forward disabled + relay disabled -> disabled, no probe', async () => {
  const fixture = writeHome('all-off-home', {
    settings: {
      version: 1,
      forward: { enabled: false, host: '127.0.0.1', port: 18899 },
      forwardKey: '',
      chanGateway: { relay: { enabled: false, host: '127.0.0.1', port: 18326, key: 'relay-key' } },
    },
  })
  let fetchCalls = 0
  const result = await discoverGateway({
    dshHome: fixture.home,
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('a disabled listener must not be probed')
    },
    timeoutMs: 200,
  })
  assert.equal(result.source, 'disabled')
  assert.equal(result.enabled, false)
  assert.equal(result.running, false)
  // The hint address is the first listener with a usable port (relay is listed first).
  assert.equal(result.port, 18326)
  assert.equal(result.baseURL, 'http://127.0.0.1:18326/v1')
  assert.equal(fetchCalls, 0)
})

await test('discoverGateway: relay listener enabled (forward off) -> chosen, key from relay', async () => {
  const info = await startModelsServer({ apiKey: 'relay-key', models: ['our-free-model/big-pickle'] })
  try {
    const fixture = writeHome('relay-home', {
      settings: {
        version: 1,
        forward: { enabled: false, host: '127.0.0.1', port: 18899 },
        forwardKey: '',
        chanGateway: { relay: { enabled: true, host: '127.0.0.1', port: info.port, key: 'relay-key' } },
      },
      catalog: CATALOG,
    })
    const result = await discoverGateway({ dshHome: fixture.home, timeoutMs: 2000 })
    assert.equal(result.source, 'forward-listener')
    assert.equal(result.enabled, true)
    assert.equal(result.running, true)
    assert.equal(result.listener, 'relay')
    assert.equal(result.port, info.port)
    assert.equal(result.baseURL, `http://127.0.0.1:${info.port}/v1`)
    assert.equal(result.key, 'relay-key')
    assert.equal(result.error, '')
    assert.ok(info.requests.length > 0)
    assert.equal(info.requests[0].authorization, 'Bearer relay-key')
  } finally {
    await stopServer(info.server)
  }
})

await test('discoverGateway: relay wins over forward when both enabled', async () => {
  const relayInfo = await startModelsServer({ apiKey: 'relay-key', models: ['m'] })
  const forwardInfo = await startModelsServer({ apiKey: 'forward-key', models: ['m'] })
  try {
    const fixture = writeHome('both-home', {
      settings: {
        version: 1,
        forward: { enabled: true, host: '127.0.0.1', port: forwardInfo.port },
        forwardKey: 'forward-key',
        chanGateway: { relay: { enabled: true, host: '127.0.0.1', port: relayInfo.port, key: 'relay-key' } },
      },
    })
    const result = await discoverGateway({ dshHome: fixture.home, timeoutMs: 2000 })
    assert.equal(result.listener, 'relay')
    assert.equal(result.port, relayInfo.port)
    assert.equal(result.key, 'relay-key')
    assert.equal(result.running, true)
  } finally {
    await stopServer(relayInfo.server)
    await stopServer(forwardInfo.server)
  }
})

await test('discoverGateway: relay enabled but port invalid -> error, not a crash', async () => {
  const fixture = writeHome('bad-relay-home', {
    settings: {
      version: 1,
      chanGateway: { relay: { enabled: true, host: '127.0.0.1', port: 0, key: 'k' } },
    },
  })
  const result = await discoverGateway({
    dshHome: fixture.home,
    fetchImpl: async () => { throw new Error('must not probe an invalid port') },
    timeoutMs: 200,
  })
  assert.equal(result.enabled, true)
  assert.equal(result.running, false)
  assert.match(result.error, /chanGateway\.relay/)
})

await test('discoverGateway: enabled + running -> forward-listener, key sent as bearer', async () => {
  const info = await startModelsServer({
    apiKey: KEY,
    models: ['nvidia/nemotron-3.5-super-vl:free', 'deepseek-v4.1-flash-free'],
  })
  try {
    const fixture = writeHome('running-home', {
      settings: { version: 1, forward: { enabled: true, host: '127.0.0.1', port: info.port }, forwardKey: KEY },
      catalog: CATALOG,
    })
    const result = await discoverGateway({ dshHome: fixture.home, timeoutMs: 2000 })
    assert.equal(result.source, 'forward-listener')
    assert.equal(result.enabled, true)
    assert.equal(result.running, true)
    assert.equal(result.port, info.port)
    assert.equal(result.baseURL, `http://127.0.0.1:${info.port}/v1`)
    assert.equal(result.key, KEY)
    assert.equal(result.error, '')
    assert.ok(info.requests.length > 0)
    assert.equal(info.requests[0].authorization, `Bearer ${KEY}`)
  } finally {
    await stopServer(info.server)
  }
})

await test('discoverGateway: enabled but wrong forwardKey -> running false with 401', async () => {
  const info = await startModelsServer({ apiKey: 'right-key', models: ['some-model'] })
  try {
    const fixture = writeHome('wrong-key-home', {
      settings: { version: 1, forward: { enabled: true, host: '127.0.0.1', port: info.port }, forwardKey: 'wrong-key' },
    })
    const result = await discoverGateway({ dshHome: fixture.home, timeoutMs: 2000 })
    assert.equal(result.source, 'forward-listener')
    assert.equal(result.enabled, true)
    assert.equal(result.running, false)
    assert.match(result.error, /401/)
  } finally {
    await stopServer(info.server)
  }
})

await test('discoverGateway: enabled but nothing listening -> running false, no throw', async () => {
  const port = await closedPort()
  const fixture = writeHome('closed-home', {
    settings: { version: 1, forward: { enabled: true, host: '127.0.0.1', port }, forwardKey: 'ofm-key' },
  })
  const result = await discoverGateway({ dshHome: fixture.home, timeoutMs: 600 })
  assert.equal(result.source, 'forward-listener')
  assert.equal(result.enabled, true)
  assert.equal(result.running, false)
  assert.ok(result.error.length > 0)
})

await test('discoverGateway: enabled but invalid port -> unavailable', async () => {
  const fixture = writeHome('bad-port-home', {
    settings: { version: 1, forward: { enabled: true, host: '127.0.0.1', port: 0 }, forwardKey: 'ofm-key' },
  })
  const result = await discoverGateway({ dshHome: fixture.home, timeoutMs: 200 })
  assert.equal(result.source, 'unavailable')
  assert.equal(result.enabled, true)
  assert.equal(result.running, false)
  assert.ok(result.error.length > 0)
})

await test('discoverGateway: manual baseURL override probes without settings', async () => {
  const info = await startModelsServer({ apiKey: KEY, models: ['override-model'] })
  try {
    const result = await discoverGateway({
      dshHome: path.join(TMP, 'no-such-home'),
      baseURL: `http://127.0.0.1:${info.port}/v1/`,
      apiKey: KEY,
      timeoutMs: 2000,
    })
    assert.equal(result.source, 'manual-override')
    assert.equal(result.enabled, true)
    assert.equal(result.running, true)
    assert.equal(result.baseURL, `http://127.0.0.1:${info.port}/v1`)
    assert.equal(result.port, info.port)
    assert.equal(result.key, KEY)
    assert.equal(result.error, '')
  } finally {
    await stopServer(info.server)
  }
})

await test('listGatewayModels: gateway roster enriched with vision/free/provider', async () => {
  const info = await startModelsServer({
    apiKey: KEY,
    models: [
      'nvidia/nemotron-3.5-super-vl:free',
      'deepseek-v4.1-flash-free',
      'kilo-auto/free',
      'qwen/qwen2.5-vl-72b:free',
      'mystery-model',
    ],
  })
  try {
    const fixture = writeHome('models-home', { catalog: CATALOG })
    const listing = await listGatewayModels({
      baseURL: `http://127.0.0.1:${info.port}/v1`,
      apiKey: KEY,
      catalogPath: fixture.catalogPath,
      timeoutMs: 2000,
    })
    assert.equal(listing.gatewayReady, true)
    assert.equal(listing.source, 'gateway')
    assert.equal(listing.error, '')
    assert.equal(listing.models.length, 5)
    const models = byId(listing.models)

    const nemotron = models.get('nvidia/nemotron-3.5-super-vl:free')
    assert.equal(nemotron.vision, true) // catalog kiloRows fact
    assert.equal(nemotron.free, true)
    assert.equal(nemotron.provider, 'nvidia')

    const kiloAuto = models.get('kilo-auto/free')
    assert.equal(kiloAuto.vision, false) // catalog says explicitly not vision
    assert.equal(kiloAuto.free, true)

    const deepseek = models.get('deepseek-v4.1-flash-free')
    assert.equal(deepseek.vision, null) // free-lane entry, unknown capability
    assert.equal(deepseek.free, true)
    assert.equal(deepseek.provider, 'free')

    assert.equal(models.get('qwen/qwen2.5-vl-72b:free').vision, true) // id heuristic
    assert.equal(models.get('mystery-model').vision, null)
    assert.equal(models.get('mystery-model').free, false)
  } finally {
    await stopServer(info.server)
  }
})

await test('listGatewayModels: gateway down -> catalog fallback keeps vision flags', async () => {
  const port = await closedPort()
  const fixture = writeHome('catalog-home', { catalog: CATALOG })
  const listing = await listGatewayModels({
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: 'whatever',
    catalogPath: fixture.catalogPath,
    timeoutMs: 600,
  })
  assert.equal(listing.gatewayReady, false)
  assert.equal(listing.source, 'catalog')
  assert.deepEqual(listing.models.map(model => model.id), [
    'deepseek-v4.1-flash-free',
    'big-pickle',
    'nvidia/nemotron-3.5-super-vl:free',
    'kilo-auto/free',
  ])
  const models = byId(listing.models)
  assert.equal(models.get('nvidia/nemotron-3.5-super-vl:free').vision, true)
  assert.equal(models.get('kilo-auto/free').vision, false)
  assert.equal(models.get('big-pickle').vision, null)
  assert.ok(listing.error.length > 0)
})

await test('listGatewayModels: invalid gateway JSON -> catalog fallback', async () => {
  const info = await startModelsServer({ rawBody: 'definitely not json' })
  try {
    const fixture = writeHome('bad-json-home', { catalog: CATALOG })
    const listing = await listGatewayModels({
      baseURL: `http://127.0.0.1:${info.port}/v1`,
      catalogPath: fixture.catalogPath,
      timeoutMs: 2000,
    })
    assert.equal(listing.gatewayReady, false)
    assert.equal(listing.source, 'catalog')
    assert.ok(listing.models.length > 0)
  } finally {
    await stopServer(info.server)
  }
})

await test('listGatewayModels: nothing usable -> source none, empty roster', async () => {
  const listing = await listGatewayModels({
    baseURL: '',
    catalogPath: path.join(TMP, 'no-catalog', 'catalog.json'),
  })
  assert.equal(listing.gatewayReady, false)
  assert.equal(listing.source, 'none')
  assert.deepEqual(listing.models, [])
  assert.ok(listing.error.length > 0)
})

await test('pickDefaultModel: preferred > first vision > first; empty roster', () => {
  const models = [
    { id: 'a', vision: null },
    { id: 'b', vision: true },
    { id: 'c', vision: false },
  ]
  assert.equal(pickDefaultModel(models), 'b')
  assert.equal(pickDefaultModel(models, { preferred: 'c' }), 'c')
  assert.equal(pickDefaultModel(models, { preferred: 'zzz' }), 'b') // unknown preferred falls back
  assert.equal(pickDefaultModel(models, { preferred: '  ' }), 'b')
  assert.equal(pickDefaultModel([{ id: 'x', vision: null }, { id: 'y', vision: false }]), 'x')
  assert.equal(pickDefaultModel([]), '')
  assert.equal(pickDefaultModel(null), '')
  assert.equal(pickDefaultModel([{ id: '' }]), '')
})

await test('syncAiEnv: merges .env, backs up old bytes, preserves comments/unrelated keys', async () => {
  const projectRoot = path.join(TMP, 'project-merge')
  fs.mkdirSync(projectRoot, { recursive: true })
  const envPath = path.join(projectRoot, '.env')
  const original = [
    '# ai-goofish-monitor AI settings',
    'OPENAI_API_KEY="old key"',
    'export OPENAI_BASE_URL=https://api.example.com/v1',
    'OPENAI_MODEL_NAME=gpt-4o',
    'UNRELATED=keep-me',
    '',
    '# keep this comment too',
    '',
  ].join('\r\n')
  fs.writeFileSync(envPath, original, 'utf8')

  const result = await syncAiEnv({
    projectRoot,
    baseURL: 'http://127.0.0.1:18899/v1',
    apiKey: 'ofm-abc123',
    model: 'nvidia/nemotron-3.5-super-vl:free',
  })
  assert.equal(result.envPath, envPath)
  assert.equal(result.changed, true)
  assert.equal(result.backupPath, `${envPath}.bak`)
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original) // exact old bytes
  assert.deepEqual(result.keys, {
    OPENAI_API_KEY: 'ofm-abc123',
    OPENAI_BASE_URL: 'http://127.0.0.1:18899/v1',
    OPENAI_MODEL_NAME: 'nvidia/nemotron-3.5-super-vl:free',
  })

  const written = fs.readFileSync(envPath, 'utf8')
  assert.equal(written.includes('\r'), false, 'CRLF normalized to LF')
  assert.ok(written.startsWith('# ai-goofish-monitor AI settings\n'))
  assert.match(written, /^OPENAI_API_KEY=ofm-abc123$/m)
  assert.match(written, /^export OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:18899\/v1$/m)
  assert.match(written, /^OPENAI_MODEL_NAME=nvidia\/nemotron-3\.5-super-vl:free$/m)
  assert.match(written, /^UNRELATED=keep-me$/m)
  assert.match(written, /^# keep this comment too$/m)
  assert.ok(written.includes('UNRELATED=keep-me\n\n# keep this comment too\n'))
  assert.ok(written.endsWith('\n'))

  const env = readAiEnv({ projectRoot })
  assert.equal(env.exists, true)
  assert.equal(env.error, '')
  assert.equal(env.apiKey, 'ofm-abc123')
  assert.equal(env.baseURL, 'http://127.0.0.1:18899/v1')
  assert.equal(env.model, 'nvidia/nemotron-3.5-super-vl:free')
  assert.equal(env.configured, true)
})

await test('syncAiEnv: second identical sync is a no-op (changed=false, no new backup)', async () => {
  const projectRoot = path.join(TMP, 'project-idempotent')
  fs.mkdirSync(projectRoot, { recursive: true })
  const options = {
    projectRoot,
    baseURL: 'http://127.0.0.1:18899/v1',
    apiKey: 'ofm-idem',
    model: 'some-model:free',
  }
  // Seed a file that differs from the target so the first run changes (and
  // therefore backs up); the second run must then be a no-op.
  fs.writeFileSync(path.join(projectRoot, '.env'), '# pre-existing\nUNRELATED=keep\n', 'utf8')
  const first = await syncAiEnv(options)
  assert.equal(first.changed, true)
  const firstContent = fs.readFileSync(first.envPath, 'utf8')
  const firstBackup = fs.readFileSync(first.backupPath, 'utf8')

  const second = await syncAiEnv(options)
  assert.equal(second.changed, false)
  assert.equal(second.backupPath, null)
  assert.equal(fs.readFileSync(second.envPath, 'utf8'), firstContent)
  assert.equal(fs.readFileSync(first.backupPath, 'utf8'), firstBackup)
})

await test('syncAiEnv: creates .env when absent without a backup', async () => {
  const projectRoot = path.join(TMP, 'project-create')
  fs.mkdirSync(projectRoot, { recursive: true })
  const result = await syncAiEnv({
    projectRoot,
    baseURL: 'http://127.0.0.1:18899/v1',
    apiKey: 'ofm-new',
    model: 'model:free',
  })
  assert.equal(result.changed, true)
  assert.equal(result.backupPath, null)
  assert.equal(fs.existsSync(path.join(projectRoot, '.env.bak')), false)
  assert.ok(fs.readFileSync(result.envPath, 'utf8').length > 0)
})

await test('syncAiEnv: quotes dotenv-special values and round-trips them', async () => {
  const projectRoot = path.join(TMP, 'project-quote')
  fs.mkdirSync(projectRoot, { recursive: true })
  const trickyKey = 'ofm key "with" quotes\\and\\backslash'
  await syncAiEnv({
    projectRoot,
    baseURL: 'http://127.0.0.1:18899/v1',
    apiKey: trickyKey,
    model: 'model/id:free',
  })
  const raw = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')
  // python-dotenv double-quote escaping, same rules env_manager.py writes.
  assert.ok(
    raw.includes('OPENAI_API_KEY="ofm key \\"with\\" quotes\\\\and\\\\backslash"'),
    `unexpected quoting: ${raw}`,
  )
  const env = readAiEnv({ projectRoot })
  assert.equal(env.apiKey, trickyKey)
  assert.equal(env.model, 'model/id:free')
})

await test('syncAiEnv: rejects missing projectRoot/baseURL/model', async () => {
  const projectRoot = path.join(TMP, 'project-validate')
  fs.mkdirSync(projectRoot, { recursive: true })
  await assert.rejects(() => syncAiEnv({ baseURL: 'x', model: 'm' }), TypeError)
  await assert.rejects(() => syncAiEnv({ projectRoot, baseURL: '', model: 'm' }), /baseURL/)
  await assert.rejects(() => syncAiEnv({ projectRoot, baseURL: 'x', model: '' }), /model/)
})

await test('readAiEnv: missing .env -> exists false, not configured, empty values', () => {
  const projectRoot = path.join(TMP, 'project-missing')
  fs.mkdirSync(projectRoot, { recursive: true })
  const env = readAiEnv({ projectRoot })
  assert.equal(env.exists, false)
  assert.equal(env.configured, false)
  assert.equal(env.apiKey, '')
  assert.equal(env.baseURL, '')
  assert.equal(env.model, '')
  assert.equal(env.error, '')
})

// ── cleanup + summary ─────────────────────────────────────────────────────────

for (const server of servers) {
  await stopServer(server)
}
fs.rmSync(TMP, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} case(s) FAILED, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} cases passed`)
process.exit(0)
