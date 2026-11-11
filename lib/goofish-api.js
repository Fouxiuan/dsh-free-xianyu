/**
 * HTTP client for the ai-goofish-monitor FastAPI backend.
 * OWNED BY: api-client teammate.
 *
 * Plain ESM, no dependencies: only `node:*` builtins (none needed) and the global
 * `fetch`. `fetchImpl` may be injected for tests.
 *
 * Every method resolves with the backend's parsed JSON body (no re-wrapping) and
 * rejects with an `Error` for network failures, timeouts and non-2xx responses.
 * HTTP errors carry:
 *   - `err.status`      numeric HTTP status (0 for network/timeout failures)
 *   - `err.detail`      backend `detail` (string, or JSON string for validation errors)
 *   - `err.body`        parsed response body (null when empty)
 *   - `err.method`, `err.url`, `err.code`, `err.cause`
 *
 * Verified against a live `python -m src.app` on test port 18848 (2026-11):
 *   GET    /health                       -> { status: "healthy", message: "服务正常运行" }
 *   GET    /api/tasks                    -> Array<task>  (serialized Task + next_run_at)
 *   POST   /api/tasks/                   -> { message, task }
 *   GET    /api/tasks/{id}               -> task         (404 detail "任务未找到")
 *   PATCH  /api/tasks/{id}               -> { message, task }
 *   DELETE /api/tasks/{id}               -> { message }
 *   POST   /api/tasks/start/{id}         -> { message }  (no request body; see startTask)
 *   POST   /api/tasks/stop/{id}          -> { message }  (no request body; see stopTask)
 *   GET    /api/results/files            -> { files: string[] }
 *   GET    /api/results/{filename}       -> { total_items, page, limit, items: object[] }
 *   GET    /api/logs/tail                -> { content, has_more, next_offset, new_pos }
 *   GET    /api/dashboard/summary         -> { summary, task_summaries, recent_activities, focus_file }
 *   GET    /api/settings/ai               -> { OPENAI_BASE_URL, OPENAI_MODEL_NAME,
 *                                             SKIP_AI_ANALYSIS, PROXY_URL }
 *   PUT    /api/settings/ai               -> { message }
 *
 * Task object (serialize_task): all Task fields (id, task_name, enabled, keyword,
 * description, analyze_images, max_pages, personal_only, min_price, max_price, cron,
 * ai_prompt_base_file, ai_prompt_criteria_file, account_state_file, account_strategy,
 * free_shipping, new_publish_option, region, decision_mode, keyword_rules, is_running)
 * plus `next_run_at` (ISO string | null). Note: `TaskCreate` accepts the same fields but
 * has no `id`/`is_running`; `decision_mode` is `"ai"` (needs a non-empty `description`
 * to be useful) or `"keyword"` (needs a non-empty `keyword_rules` array).
 *
 * @module lib/goofish-api
 */

const DEFAULT_TIMEOUT_MS = 15000

/**
 * Trim whitespace and every trailing slash so `${baseURL}${path}` is well formed.
 * @param {unknown} baseURL
 * @returns {string}
 */
function normalizeBaseURL(baseURL) {
  if (typeof baseURL !== 'string') return ''
  return baseURL.trim().replace(/\/+$/, '')
}

/**
 * Append a query object, skipping undefined/null values. Booleans become
 * "true"/"false"; arrays repeat the key.
 * @param {string} path
 * @param {Record<string, unknown> | undefined} query
 * @returns {string}
 */
function withQuery(path, query) {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.append(key, typeof value === 'boolean' ? String(value) : String(value))
    }
  }
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * FastAPI error bodies are `{ detail: string }` for HTTPException and
 * `{ detail: [{ loc, msg, type }] }` for request validation errors.
 * @param {unknown} body
 * @param {string} fallback
 * @returns {string}
 */
function extractDetail(body, fallback) {
  if (isPlainObject(body)) {
    if (body.detail !== undefined && body.detail !== null) {
      if (typeof body.detail === 'string') return body.detail
      try {
        return JSON.stringify(body.detail)
      } catch {
        return String(body.detail)
      }
    }
    if (typeof body.error === 'string' && body.error) return body.error
    if (typeof body.message === 'string' && body.message) return body.message
  }
  if (typeof body === 'string' && body.trim()) return body.trim()
  return fallback
}

/**
 * Read a response body: JSON when possible, raw text otherwise, null when empty.
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function readBody(response) {
  const text = await response.text()
  if (!text || !text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * @param {{ method: string, url: string, status: number, statusText: string,
 *           body: unknown, detail: string }} info
 * @returns {Error & { status: number, detail: string, body: unknown, method: string, url: string }}
 */
function buildHttpError({ method, url, status, statusText, body, detail }) {
  const error = new Error(
    `goofish-api ${method} ${url} failed: HTTP ${status}` +
      (statusText ? ` ${statusText}` : '') +
      (detail ? ` - ${detail}` : ''),
  )
  error.name = 'GoofishApiError'
  error.status = status
  error.detail = detail
  error.body = body
  error.method = method
  error.url = url
  return error
}

/**
 * Create a client bound to a running ai-goofish-monitor backend.
 *
 * @param {{ baseURL: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {{
 *   getHealth: () => Promise<{ status: string, message: string }>,
 *   listTasks: () => Promise<Record<string, unknown>[]>,
 *   getTask: (taskId: number) => Promise<Record<string, unknown>>,
 *   createTask: (payload: Record<string, unknown>) => Promise<{ message: string, task: Record<string, unknown> }>,
 *   updateTask: (taskId: number, payload: Record<string, unknown>) => Promise<{ message: string, task: Record<string, unknown> }>,
 *   deleteTask: (taskId: number) => Promise<{ message: string }>,
 *   startTask: (taskId: number, options?: { debugLimit?: number }) => Promise<{ message: string }>,
 *   stopTask: (taskId: number) => Promise<{ message: string }>,
 *   listResultFiles: () => Promise<{ files: string[] }>,
 *   getResults: (filename: string, options?: {
 *     page?: number, limit?: number, sortBy?: string, sortOrder?: string,
 *     aiRecommendedOnly?: boolean }) => Promise<{ total_items: number, page: number, limit: number, items: Record<string, unknown>[] }>,
 *   tailLogs: (options?: { taskId?: number, limitLines?: number, offsetLines?: number }) =>
 *     Promise<{ content: string, has_more: boolean, next_offset: number, new_pos: number }>,
 *   getDashboardSummary: () => Promise<Record<string, unknown>>,
 *   getAiSettings: () => Promise<{ OPENAI_BASE_URL: string, OPENAI_MODEL_NAME: string,
 *     SKIP_AI_ANALYSIS: boolean, PROXY_URL: string }>,
 *   applyAiSettings: (patch: Record<string, unknown>) => Promise<{ message: string }>,
 * }}
 */
export function createGoofishApi(options = {}) {
  const baseURL = normalizeBaseURL(options.baseURL)
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  /**
   * @param {string} method
   * @param {string} path absolute path beginning with "/"
   * @param {{ query?: Record<string, unknown>, body?: unknown }} [init]
   * @returns {Promise<any>}
   */
  async function request(method, path, init = {}) {
    if (!baseURL) {
      const configError = new Error(
        'goofish-api: baseURL is required, e.g. createGoofishApi({ baseURL: "http://127.0.0.1:8848" })',
      )
      configError.name = 'GoofishApiConfigError'
      configError.code = 'EBASEURL'
      configError.status = 0
      throw configError
    }
    if (typeof fetchImpl !== 'function') {
      const fetchError = new Error('goofish-api: no fetch implementation available')
      fetchError.name = 'GoofishApiConfigError'
      fetchError.code = 'EFETCH'
      fetchError.status = 0
      throw fetchError
    }

    const url = `${baseURL}${withQuery(path, init.query)}`
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' }
    let payload
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(init.body)
    }

    const controller = new AbortController()
    const timeoutError = new Error(`goofish-api ${method} ${url} timed out after ${timeoutMs}ms`)
    timeoutError.name = 'TimeoutError'
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)

    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      })
    } catch (cause) {
      if (cause === timeoutError || cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
        const error = new Error(`goofish-api ${method} ${url} timed out after ${timeoutMs}ms`)
        error.name = 'GoofishApiTimeoutError'
        error.code = 'ETIMEDOUT'
        error.status = 0
        error.detail = `request timed out after ${timeoutMs}ms`
        error.method = method
        error.url = url
        error.cause = cause
        throw error
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      const error = new Error(`goofish-api ${method} ${url} request failed: ${message}`)
      error.name = 'GoofishApiNetworkError'
      error.code = cause?.code ?? 'ENETWORK'
      error.status = 0
      error.detail = message
      error.method = method
      error.url = url
      error.cause = cause
      throw error
    } finally {
      clearTimeout(timer)
    }

    const body = await readBody(response)
    if (!response.ok) {
      throw buildHttpError({
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        body,
        detail: extractDetail(body, response.statusText || 'request failed'),
      })
    }
    return body
  }

  /**
   * @param {unknown} value
   * @param {string} label
   * @returns {Record<string, unknown>}
   */
  function requireObject(value, label) {
    if (!isPlainObject(value)) {
      throw new TypeError(`goofish-api: ${label} must be a plain object`)
    }
    return value
  }

  /**
   * @param {unknown} value
   * @param {string} label
   * @returns {number}
   */
  function requireTaskId(value, label = 'taskId') {
    const id = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    // The project's storage can hand out id 0 for the first task (see
    // sqlite_task_repository), so 0 is a valid id; negative ids are not.
    if (!Number.isInteger(id) || Number(id) < 0) {
      throw new TypeError(`goofish-api: ${label} must be a non-negative integer`)
    }
    return Number(id)
  }

  return {
    /**
     * GET /health — liveness probe (no auth required).
     * @returns {Promise<{ status: string, message: string }>}
     */
    getHealth() {
      return request('GET', '/health')
    },

    /**
     * GET /api/tasks — serialized task list (`serialize_tasks` + `next_run_at`).
     * Resolves with the raw array; callers wrap it as `{ tasks }` if needed.
     * @returns {Promise<Record<string, unknown>[]>}
     */
    listTasks() {
      return request('GET', '/api/tasks')
    },

    /**
     * GET /api/tasks/{id} — one serialized task. 404 detail is "任务未找到".
     * @param {number} taskId
     * @returns {Promise<Record<string, unknown>>}
     */
    getTask(taskId) {
      return request('GET', `/api/tasks/${requireTaskId(taskId)}`)
    },

    /**
     * POST /api/tasks/ — create a task from TaskCreate fields.
     * The trailing slash is required: FastAPI also serves `/api/tasks`, but that
     * redirects (307), so the contract path is used directly.
     * Body fields: task_name, keyword (required); optional enabled, description,
     * analyze_images, max_pages, personal_only, min_price, max_price, cron,
     * ai_prompt_base_file, ai_prompt_criteria_file, account_state_file,
     * account_strategy, free_shipping, new_publish_option, region, decision_mode,
     * keyword_rules. Resolves `{ message, task }`.
     * @param {Record<string, unknown>} payload
     * @returns {Promise<{ message: string, task: Record<string, unknown> }>}
     */
    createTask(payload) {
      return request('POST', '/api/tasks/', { body: requireObject(payload, 'createTask payload') })
    },

    /**
     * PATCH /api/tasks/{id} — partial TaskUpdate. Resolves `{ message, task }`.
     * WARNING: an update to `description` while `decision_mode` is "ai" makes the
     * backend call the AI provider synchronously to regenerate the criteria file;
     * with an unreachable AI endpoint this can be slow or fail with HTTP 500.
     * @param {number} taskId
     * @param {Record<string, unknown>} payload
     * @returns {Promise<{ message: string, task: Record<string, unknown> }>}
     */
    updateTask(taskId, payload) {
      return request('PATCH', `/api/tasks/${requireTaskId(taskId)}`, {
        body: requireObject(payload, 'updateTask payload'),
      })
    },

    /**
     * DELETE /api/tasks/{id} — stops the process (if any), removes the task, its
     * result file rows (when the keyword is no longer used) and its log file.
     * Resolves `{ message }`.
     * @param {number} taskId
     * @returns {Promise<{ message: string }>}
     */
    deleteTask(taskId) {
      return request('DELETE', `/api/tasks/${requireTaskId(taskId)}`)
    },

    /**
     * POST /api/tasks/start/{id} — start the spider subprocess.
     *
     * The FastAPI route (`tasks.py::start_task`) takes NO request body and NO query
     * parameters; it just returns `{ message: "任务 '<name>' 已启动" }`. The debug
     * limit is therefore NOT transmitted over HTTP: `src/services/process_service.py`
     * reads the SERVER-side environment variable `SPIDER_DEBUG_LIMIT` and appends
     * `--debug-limit <n>` when spawning `spider_v2.py`. Pass `{ debugLimit }` here
     * for signature compatibility with the contract, but it only takes effect if
     * the backend process itself was started with SPIDER_DEBUG_LIMIT=<n>. The value
     * is validated locally and otherwise intentionally not sent (a body would be
     * ignored by the backend and silently mislead callers).
     * @param {number} taskId
     * @param {{ debugLimit?: number }} [options]
     * @returns {Promise<{ message: string }>}
     */
    startTask(taskId, options = {}) {
      const id = requireTaskId(taskId)
      if (options?.debugLimit !== undefined && options.debugLimit !== null) {
        const limit = Number(options.debugLimit)
        if (!Number.isInteger(limit) || limit < 0) {
          throw new TypeError('goofish-api: debugLimit must be a non-negative integer')
        }
      }
      return request('POST', `/api/tasks/start/${id}`)
    },

    /**
     * POST /api/tasks/stop/{id} — stop the spider subprocess (no request body).
     * Resolves `{ message: "任务ID <id> 已发送停止信号" }` even when nothing was
     * running; the task's `is_running` flag is synced asynchronously.
     * @param {number} taskId
     * @returns {Promise<{ message: string }>}
     */
    stopTask(taskId) {
      return request('POST', `/api/tasks/stop/${requireTaskId(taskId)}`)
    },

    /**
     * GET /api/results/files — result file names from the storage backend.
     * Resolves `{ files: string[] }` (filenames such as `<keyword>_full_data.jsonl`).
     * @returns {Promise<{ files: string[] }>}
     */
    listResultFiles() {
      return request('GET', '/api/results/files')
    },

    /**
     * GET /api/results/{filename} — paginated result items.
     * Query mapping: page, limit (1..100), sort_by, sort_order,
     * ai_recommended_only. Resolves
     * `{ total_items, page, limit, items: object[] }` where each item is a stored
     * record enriched with price insight fields (`商品信息`, `价格信息`,
     * `ai_analysis`, price history, ...). A missing file is HTTP 404 with detail
     * "结果文件未找到"; a malformed name is HTTP 400.
     * @param {string} filename
     * @param {{ page?: number, limit?: number, sortBy?: string, sortOrder?: string,
     *           aiRecommendedOnly?: boolean }} [options]
     * @returns {Promise<{ total_items: number, page: number, limit: number, items: Record<string, unknown>[] }>}
     */
    getResults(filename, options = {}) {
      if (typeof filename !== 'string' || filename.trim() === '') {
        throw new TypeError('goofish-api: getResults filename must be a non-empty string')
      }
      const {
        page = 1,
        limit = 20,
        sortBy = 'crawl_time',
        sortOrder = 'desc',
        aiRecommendedOnly = false,
      } = options ?? {}
      return request('GET', `/api/results/${encodeURIComponent(filename)}`, {
        query: {
          page,
          limit,
          sort_by: sortBy,
          sort_order: sortOrder,
          ai_recommended_only: aiRecommendedOnly,
        },
      })
    },

    /**
     * GET /api/logs/tail — last lines of the task's log file.
     * Query mapping: task_id, offset_lines, limit_lines (1..1000).
     * Resolves `{ content: string, has_more: boolean, next_offset: number,
     * new_pos: number }`; `content` uses "\n" joins and is "" when the task has no
     * log yet. With `taskId` omitted the backend returns the same empty shape
     * (no task selected). An unknown task id is HTTP 404 with an empty content body.
     * @param {{ taskId?: number, limitLines?: number, offsetLines?: number }} [options]
     * @returns {Promise<{ content: string, has_more: boolean, next_offset: number, new_pos: number }>}
     */
    tailLogs(options = {}) {
      const { taskId, limitLines = 80, offsetLines = 0 } = options ?? {}
      return request('GET', '/api/logs/tail', {
        query: {
          task_id: taskId === undefined || taskId === null ? undefined : requireTaskId(taskId),
          limit_lines: limitLines,
          offset_lines: offsetLines,
        },
      })
    },

    /**
     * GET /api/dashboard/summary — aggregated dashboard snapshot:
     * `{ summary: { enabled_tasks, running_tasks, result_files, scanned_items,
     *               recommended_items, ai_recommended_items,
     *               keyword_recommended_items, last_updated_at },
     *    task_summaries: object[], recent_activities: object[],
     *    focus_file: string|null }`.
     * @returns {Promise<Record<string, unknown>>}
     */
    getDashboardSummary() {
      return request('GET', '/api/dashboard/summary')
    },

    /**
     * GET /api/settings/ai — effective AI config.
     * Resolves `{ OPENAI_BASE_URL, OPENAI_MODEL_NAME, SKIP_AI_ANALYSIS: boolean,
     * PROXY_URL }`. The API key is never returned.
     * @returns {Promise<{ OPENAI_BASE_URL: string, OPENAI_MODEL_NAME: string,
     *                     SKIP_AI_ANALYSIS: boolean, PROXY_URL: string }>}
     */
    getAiSettings() {
      return request('GET', '/api/settings/ai')
    },

    /**
     * PUT /api/settings/ai — patch `.env` AI settings; resolves `{ message }`.
     * Accepted keys: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL_NAME,
     * SKIP_AI_ANALYSIS (boolean), PROXY_URL. Only supplied keys are touched; the
     * backend rewrites the project `.env` file (the DSH plugin layer is expected to
     * manage backups itself when it needs them). Invalid types → HTTP 422 with a
     * validation-error `detail` array.
     * @param {Record<string, unknown>} patch
     * @returns {Promise<{ message: string }>}
     */
    applyAiSettings(patch) {
      return request('PUT', '/api/settings/ai', {
        body: requireObject(patch, 'applyAiSettings patch'),
      })
    },
  }
}
