#!/usr/bin/env node
/**
 * Self-test for `dsh-plugin/lib/goofish-api.js`.
 *
 * Usage (from the repo worktree root):
 *   node dsh-plugin/lib/goofish-api.selftest.mjs
 *     -> runs the dependency-free offline checks; if GOOFISH_TEST_BASEURL is
 *        unset it prints "skipped" and exits 0 (no backend required).
 *   GOOFISH_TEST_BASEURL=http://127.0.0.1:18848 node dsh-plugin/lib/goofish-api.selftest.mjs
 *     -> offline checks + full read-only live smoke against a running backend:
 *        /health, /api/tasks, /api/results/files (+ /api/results/{file} when a
 *        result file exists), /api/dashboard/summary, /api/settings/ai,
 *        /api/logs/tail and a live 404 error shape.
 *   GOOFISH_TEST_BASEURL=... GOOFISH_TEST_MUTATE=1 node dsh-plugin/lib/goofish-api.selftest.mjs
 *     -> additionally creates a temporary keyword-mode task, reads it back and
 *        deletes it again (never touches existing tasks).
 *
 * No test framework, no packages: node builtins/global fetch only.
 */
import { createGoofishApi } from './goofish-api.js'

const results = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`ok   - ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.error(`FAIL - ${name}: ${error?.message ?? error}`)
  }
}

function jsonResponse(status, body, statusText = '') {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}

const EXPECTED_METHODS = [
  'getHealth',
  'listTasks',
  'getTask',
  'createTask',
  'updateTask',
  'deleteTask',
  'startTask',
  'stopTask',
  'listResultFiles',
  'getResults',
  'tailLogs',
  'getDashboardSummary',
  'getAiSettings',
  'applyAiSettings',
]

async function runOfflineChecks() {
  await test('export: all 14 documented methods exist', () => {
    const api = createGoofishApi({ baseURL: 'http://127.0.0.1:18848' })
    for (const name of EXPECTED_METHODS) {
      assert(typeof api[name] === 'function', `missing method ${name}`)
    }
  })

  await test('config: empty baseURL rejects with EBASEURL before fetch', async () => {
    let fetched = false
    const api = createGoofishApi({
      baseURL: '',
      fetchImpl: async () => {
        fetched = true
        return jsonResponse(200, { status: 'healthy' })
      },
    })
    let error = null
    try {
      await api.getHealth()
    } catch (caught) {
      error = caught
    }
    assert(error, 'expected rejection')
    assert(error.code === 'EBASEURL', `unexpected code ${error.code}`)
    assert(error.status === 0, `unexpected status ${error.status}`)
    assert(fetched === false, 'fetch must not be called without baseURL')
  })

  await test('url: trailing slash is trimmed and POST /api/tasks/ keeps its slash', async () => {
    let captured = null
    const api = createGoofishApi({
      baseURL: 'http://127.0.0.1:18848///',
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init }
        return jsonResponse(200, { message: '任务创建成功', task: { id: 7 } })
      },
    })
    const created = await api.createTask({ task_name: 'x', keyword: 'x' })
    assert(created.task.id === 7, 'createTask should resolve the parsed body')
    assert(captured.url === 'http://127.0.0.1:18848/api/tasks/', `bad url ${captured.url}`)
    assert(captured.init.method === 'POST', `bad method ${captured.init.method}`)
    assert(
      captured.init.headers['content-type'] === 'application/json',
      'missing JSON content-type',
    )
    assert(
      JSON.parse(captured.init.body).task_name === 'x',
      'request body was not JSON-serialized',
    )
    assert(captured.init.signal, 'request should carry an abort signal (timeout)')
  })

  await test('url: getResults encodes the filename and maps query parameters', async () => {
    let captured = null
    const api = createGoofishApi({
      baseURL: 'http://127.0.0.1:18848',
      fetchImpl: async (url) => {
        captured = String(url)
        return jsonResponse(200, { total_items: 0, page: 1, limit: 5, items: [] })
      },
    })
    const result = await api.getResults('MacBook Air_full_data.jsonl', {
      page: 2,
      limit: 5,
      sortBy: 'crawl_time',
      sortOrder: 'asc',
      aiRecommendedOnly: true,
    })
    assert(result.total_items === 0, 'expected parsed result body')
    assert(
      captured.startsWith('http://127.0.0.1:18848/api/results/MacBook%20Air_full_data.jsonl?'),
      `bad url ${captured}`,
    )
    assert(captured.includes('page=2'), 'missing page')
    assert(captured.includes('limit=5'), 'missing limit')
    assert(captured.includes('sort_by=crawl_time'), 'missing sort_by')
    assert(captured.includes('sort_order=asc'), 'missing sort_order')
    assert(captured.includes('ai_recommended_only=true'), 'missing ai_recommended_only')
  })

  await test('url: tailLogs maps taskId/limitLines/offsetLines', async () => {
    let captured = null
    const api = createGoofishApi({
      baseURL: 'http://127.0.0.1:18848',
      fetchImpl: async (url) => {
        captured = String(url)
        return jsonResponse(200, {
          content: '',
          has_more: false,
          next_offset: 0,
          new_pos: 0,
        })
      },
    })
    await api.tailLogs({ taskId: 5, limitLines: 10, offsetLines: 3 })
    assert(captured.includes('/api/logs/tail?'), `bad url ${captured}`)
    assert(captured.includes('task_id=5'), 'missing task_id')
    assert(captured.includes('limit_lines=10'), 'missing limit_lines')
    assert(captured.includes('offset_lines=3'), 'missing offset_lines')
  })

  await test('error: non-2xx carries status + backend detail', async () => {
    const api = createGoofishApi({
      baseURL: 'http://127.0.0.1:18848',
      fetchImpl: async () => jsonResponse(404, { detail: '任务未找到' }, 'Not Found'),
    })
    let error = null
    try {
      await api.getTask(999)
    } catch (caught) {
      error = caught
    }
    assert(error, 'expected rejection')
    assert(error.status === 404, `unexpected status ${error.status}`)
    assert(error.detail === '任务未找到', `unexpected detail ${error.detail}`)
    assert(error.name === 'GoofishApiError', `unexpected name ${error.name}`)
    assert(String(error.message).includes('任务未找到'), 'message should include detail')
  })

  await test('error: validation detail array is stringified, not lost', async () => {
    const api = createGoofishApi({
      baseURL: 'http://127.0.0.1:18848',
      fetchImpl: async () =>
        jsonResponse(
          422,
          { detail: [{ loc: ['body', 'task_name'], msg: 'Field required', type: 'missing' }] },
          'Unprocessable Entity',
        ),
    })
    let error = null
    try {
      await api.createTask({ keyword: 'x' })
    } catch (caught) {
      error = caught
    }
    assert(error && error.status === 422, 'expected HTTP 422')
    assert(
      typeof error.detail === 'string' && error.detail.includes('Field required'),
      `unexpected detail ${error.detail}`,
    )
  })

  await test('error: network failure is wrapped with status 0', async () => {
    const api = createGoofishApi({
      baseURL: 'http://127.0.0.1:1',
      fetchImpl: async () => {
        const cause = new Error('connect ECONNREFUSED 127.0.0.1:1')
        cause.code = 'ECONNREFUSED'
        throw cause
      },
    })
    let error = null
    try {
      await api.getHealth()
    } catch (caught) {
      error = caught
    }
    assert(error, 'expected rejection')
    assert(error.status === 0, `unexpected status ${error.status}`)
    assert(error.name === 'GoofishApiNetworkError', `unexpected name ${error.name}`)
    assert(error.code === 'ECONNREFUSED', `unexpected code ${error.code}`)
  })

  await test('error: timeoutMs aborts the request and reports ETIMEDOUT', async () => {
    const api = createGoofishApi({
      baseURL: 'http://127.0.0.1:18848',
      timeoutMs: 25,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        }),
    })
    let error = null
    try {
      await api.getHealth()
    } catch (caught) {
      error = caught
    }
    assert(error, 'expected rejection')
    assert(error.status === 0, `unexpected status ${error.status}`)
    assert(error.name === 'GoofishApiTimeoutError', `unexpected name ${error.name}`)
    assert(error.code === 'ETIMEDOUT', `unexpected code ${error.code}`)
    assert(String(error.message).includes('timed out'), 'message should mention timeout')
  })
}

async function runLiveChecks(baseURL) {
  const api = createGoofishApi({ baseURL })

  await test('live: baseURL with one trailing slash still works', () => {
    return createGoofishApi({ baseURL: `${baseURL}/` })
      .getHealth()
      .then((health) => {
        assert(health && health.status === 'healthy', `unexpected health ${JSON.stringify(health)}`)
      })
  })

  let tasks = []
  await test('live: GET /health', async () => {
    const health = await api.getHealth()
    assert(health && health.status === 'healthy', `unexpected health ${JSON.stringify(health)}`)
    assert(typeof health.message === 'string', 'health.message should be a string')
  })

  await test('live: GET /api/tasks returns an array of tasks', async () => {
    tasks = await api.listTasks()
    assert(Array.isArray(tasks), `expected array, got ${typeof tasks}`)
    for (const task of tasks) {
      assert(typeof task.id === 'number', 'task.id should be a number')
      assert(typeof task.task_name === 'string', 'task.task_name should be a string')
      assert(typeof task.enabled === 'boolean', 'task.enabled should be a boolean')
      assert('next_run_at' in task, 'task should expose next_run_at')
    }
  })

  await test('live: GET /api/results/files returns { files: string[] }', async () => {
    const payload = await api.listResultFiles()
    assert(payload && Array.isArray(payload.files), 'expected { files: string[] }')
    for (const name of payload.files) assert(typeof name === 'string', 'filename should be a string')
  })

  await test('live: GET /api/results/{file} (skipped only when no result file exists)', async () => {
    const { files } = await api.listResultFiles()
    if (!files || files.length === 0) {
      console.log('       (no result files present; pagination shape not exercised)')
      return
    }
    const payload = await api.getResults(files[0], { page: 1, limit: 1 })
    assert(typeof payload.total_items === 'number', 'total_items should be a number')
    assert(typeof payload.page === 'number', 'page should be a number')
    assert(typeof payload.limit === 'number', 'limit should be a number')
    assert(Array.isArray(payload.items), 'items should be an array')
  })

  await test('live: GET /api/dashboard/summary', async () => {
    const snapshot = await api.getDashboardSummary()
    assert(snapshot && typeof snapshot === 'object', 'expected an object')
    assert(snapshot.summary && typeof snapshot.summary === 'object', 'missing summary')
    assert(typeof snapshot.summary.enabled_tasks === 'number', 'missing summary.enabled_tasks')
    assert(Array.isArray(snapshot.task_summaries), 'task_summaries should be an array')
    assert(Array.isArray(snapshot.recent_activities), 'recent_activities should be an array')
    assert('focus_file' in snapshot, 'missing focus_file')
  })

  await test('live: GET /api/settings/ai', async () => {
    const ai = await api.getAiSettings()
    assert(typeof ai.OPENAI_BASE_URL === 'string', 'OPENAI_BASE_URL should be a string')
    assert(typeof ai.OPENAI_MODEL_NAME === 'string', 'OPENAI_MODEL_NAME should be a string')
    assert(typeof ai.SKIP_AI_ANALYSIS === 'boolean', 'SKIP_AI_ANALYSIS should be a boolean')
    assert(typeof ai.PROXY_URL === 'string', 'PROXY_URL should be a string')
  })

  await test('live: GET /api/logs/tail', async () => {
    const taskId = tasks.length > 0 ? tasks[0].id : undefined
    const tail = await api.tailLogs({ taskId, limitLines: 5, offsetLines: 0 })
    assert(typeof tail.content === 'string', 'content should be a string')
    assert(typeof tail.has_more === 'boolean', 'has_more should be a boolean')
    assert(typeof tail.next_offset === 'number', 'next_offset should be a number')
    assert(typeof tail.new_pos === 'number', 'new_pos should be a number')
  })

  await test('live: GET /api/tasks/{id} 404 maps status + detail', async () => {
    let error = null
    try {
      await api.getTask(987654321)
    } catch (caught) {
      error = caught
    }
    assert(error, 'expected rejection for a nonexistent task')
    assert(error.status === 404, `unexpected status ${error.status}`)
    assert(typeof error.detail === 'string' && error.detail.length > 0, 'missing detail')
  })

  await test('live: startTask validates debugLimit locally', async () => {
    let error = null
    try {
      await api.startTask(987654321, { debugLimit: -1 })
    } catch (caught) {
      error = caught
    }
    assert(error instanceof TypeError, 'debugLimit must be validated before HTTP')
  })
}

async function runMutateChecks(baseURL) {
  const api = createGoofishApi({ baseURL })
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  await test('mutate: create temp keyword-mode task, read back, delete', async () => {
    let createdId = null
    try {
      const created = await api.createTask({
        task_name: `dsh-api-selftest-${stamp}`,
        keyword: `dsh-api-selftest-${stamp}`,
        description: 'Temporary task created by dsh-plugin goofish-api selftest.',
        decision_mode: 'keyword',
        keyword_rules: ['selftest'],
        max_pages: 1,
        personal_only: true,
      })
      assert(created && typeof created.message === 'string', 'createTask response lacks message')
      assert(created.task && typeof created.task === 'object', 'createTask response lacks task')
      createdId = created.task.id
      assert(typeof createdId === 'number', 'created task has no numeric id')
      assert(created.task.decision_mode === 'keyword', 'expected keyword mode')
      assert(
        Array.isArray(created.task.keyword_rules) && created.task.keyword_rules.includes('selftest'),
        'keyword_rules not persisted',
      )

      const fetched = await api.getTask(createdId)
      assert(fetched.id === createdId, 'getTask returned the wrong task')
      assert(
        fetched.task_name === created.task.task_name,
        'getTask task_name does not match created task',
      )

      await api.deleteTask(createdId)
      createdId = null

      let notFound = null
      try {
        await api.getTask(fetched.id)
      } catch (error) {
        notFound = error
      }
      assert(notFound && notFound.status === 404, 'deleted task should be gone (404)')
    } finally {
      if (createdId !== null) {
        try {
          await api.deleteTask(createdId)
        } catch (cleanupError) {
          console.error(`       cleanup: failed to delete temp task ${createdId}:`, cleanupError)
        }
      }
    }
  })
}

async function main() {
  const baseURL = (process.env.GOOFISH_TEST_BASEURL ?? '').trim().replace(/\/+$/, '')

  console.log('[goofish-api selftest] offline checks')
  await runOfflineChecks()

  if (!baseURL) {
    console.log(
      '[goofish-api selftest] skipped live smoke: GOOFISH_TEST_BASEURL is unset ' +
        '(set it to a running backend, e.g. GOOFISH_TEST_BASEURL=http://127.0.0.1:18848)',
    )
  } else {
    console.log(`[goofish-api selftest] live smoke against ${baseURL}`)
    await runLiveChecks(baseURL)
    if (process.env.GOOFISH_TEST_MUTATE === '1') {
      console.log('[goofish-api selftest] mutate checks (GOOFISH_TEST_MUTATE=1)')
      await runMutateChecks(baseURL)
    } else {
      console.log(
        '[goofish-api selftest] skipped mutate checks: set GOOFISH_TEST_MUTATE=1 to create/delete a temp task',
      )
    }
  }

  const failed = results.filter((item) => !item.ok)
  const passed = results.length - failed.length
  console.log(`[goofish-api selftest] ${passed}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.error(`[goofish-api selftest] FAILED: ${failed.map((item) => item.name).join(' | ')}`)
    process.exitCode = 1
  } else {
    process.exitCode = 0
  }
}

main().catch((error) => {
  console.error('[goofish-api selftest] crashed:', error)
  process.exitCode = 1
})
