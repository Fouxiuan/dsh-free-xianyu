/**
 * Agent tools for the ai-goofish-monitor project.
 *
 * Every tool that needs the backend calls `deps.ensureServer()` first, so the
 * model never has to babysit a process. Parameters are full JSON Schema objects
 * (the framework hands `parameters` to the model verbatim).
 *
 * @module lib/tools
 */

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
})

const str = (description) => ({ type: 'string', description })
const int = (description, minimum, maximum) => ({
  type: 'integer',
  description,
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
})
const bool = (description) => ({ type: 'boolean', description })

/**
 * @param {{
 *   getStatus: () => Promise<object>,
 *   startServer: () => Promise<object>,
 *   stopServer: () => Promise<object>,
 *   restartServer: () => Promise<object>,
 *   ensureServer: () => Promise<object>,
 *   api: () => any,
 *   listAiModels: () => Promise<object>,
 *   applyAi: (options: { model?: string }) => Promise<object>,
 *   buildConsole: (options?: { force?: boolean }) => Promise<object>,
 *   rebuildConsole: () => Promise<object>,
 * }} deps
 */
export function createToolDefinitions(deps) {
  /** @type {import('./tools-types.js').GoofishTool[]} */
  const tools = [
    {
      name: 'goofish_status',
      description:
        'Report ai-goofish-monitor state: whether its FastAPI backend is running and healthy, the port and console URL, the project root, and which AI gateway/model its analysis uses (Our Free Model local OpenAI gateway when enabled).',
      parameters: objectSchema({}),
      output: textOutput,
      async execute() {
        return deps.getStatus()
      },
    },
    {
      name: 'goofish_server',
      description:
        'Start, stop, or restart the ai-goofish-monitor backend managed by this plugin. The backend is managed automatically by other goofish_* tools; use this only to control it explicitly.',
      parameters: objectSchema(
        { action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Lifecycle action.' } },
        ['action'],
      ),
      output: textOutput,
      async execute(args) {
        const action = String(args?.action ?? '').trim()
        if (action === 'start') return deps.startServer()
        if (action === 'stop') return deps.stopServer()
        if (action === 'restart') return deps.restartServer()
        throw new Error(`unknown action "${action}"; expected start, stop, or restart`)
      },
    },
    {
      name: 'goofish_console',
      description:
        'The full Vue console of ai-goofish-monitor at the backend root URL (http://127.0.0.1:<port>/). The backend only serves it when the build output dist/ exists at startup, so this tool reports the build state and can build it: action "status" reports, "build" runs `npm run build` in web-ui/ and restarts the backend when restart is true.',
      parameters: objectSchema(
        {
          action: { type: 'string', enum: ['status', 'build'], description: 'Report the console build state, or build it.' },
          force: bool('Rebuild even when dist/ looks up to date (build action).'),
          restart: bool('Restart the backend after building so it mounts the new assets.'),
        },
        ['action'],
      ),
      output: textOutput,
      async execute(args) {
        const action = String(args?.action ?? 'status').trim()
        if (action === 'status') {
          const status = await deps.getStatus()
          return { console: status.console ?? {}, server: status.server ?? {} }
        }
        if (action === 'build') {
          return args?.restart === true
            ? deps.rebuildConsole()
            : deps.buildConsole({ force: args?.force === true })
        }
        throw new Error(`unknown action "${action}"; expected status or build`)
      },
    },
    {
      name: 'goofish_tasks',
      description:
        'List every monitor task defined in ai-goofish-monitor, including whether it is running, its keyword, price range, cron schedule, and next scheduled run.',
      parameters: objectSchema({}),
      output: textOutput,
      async execute() {
        await deps.ensureServer()
        const tasks = await deps.api().listTasks()
        return { tasks }
      },
    },
    {
      name: 'goofish_task_create',
      description:
        'Create a persistent ai-goofish-monitor monitor task. decisionMode "ai" needs a non-empty description of the wanted item (the free vision model judges the listings); decisionMode "keyword" needs keywordRules (any keyword hit recommends the listing).',
      parameters: objectSchema(
        {
          taskName: str('Unique, descriptive task name, e.g. "MacBook Air M1 16G".'),
          keyword: str('Search keyword used on Goofish.'),
          decisionMode: { type: 'string', enum: ['ai', 'keyword'], description: 'Judgement mode; defaults to ai.' },
          description: str('Detailed requirement text (required in ai mode).'),
          keywordRules: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keywords for keyword mode; any hit recommends. Required in keyword mode.',
          },
          minPrice: str('Minimum price in CNY, as text.'),
          maxPrice: str('Maximum price in CNY, as text.'),
          maxPages: int('Maximum listing pages to crawl.', 1, 20),
          cron: str('Optional cron expression for scheduled runs (e.g. "0 */2 * * *").'),
          enabled: bool('Whether the task is enabled; defaults to true.'),
          analyzeImages: bool('Whether the AI should analyze listing images; defaults to true.'),
          freeShipping: bool('Only accept free-shipping listings; defaults to true.'),
        },
        ['taskName', 'keyword'],
      ),
      output: textOutput,
      async execute(args) {
        const payload = {
          task_name: String(args?.taskName ?? '').trim(),
          keyword: String(args?.keyword ?? '').trim(),
          decision_mode: args?.decisionMode === 'keyword' ? 'keyword' : 'ai',
        }
        if (payload.task_name === '') throw new Error('taskName is required')
        if (payload.keyword === '') throw new Error('keyword is required')
        const description = String(args?.description ?? '').trim()
        if (description !== '') payload.description = description
        const rules = Array.isArray(args?.keywordRules) ? args.keywordRules.map((rule) => String(rule).trim()).filter(Boolean) : []
        if (rules.length > 0) payload.keyword_rules = rules
        if (typeof args?.minPrice === 'string' && args.minPrice.trim() !== '') payload.min_price = args.minPrice.trim()
        if (typeof args?.maxPrice === 'string' && args.maxPrice.trim() !== '') payload.max_price = args.maxPrice.trim()
        if (Number.isInteger(args?.maxPages)) payload.max_pages = args.maxPages
        if (typeof args?.cron === 'string' && args.cron.trim() !== '') payload.cron = args.cron.trim()
        if (typeof args?.enabled === 'boolean') payload.enabled = args.enabled
        if (typeof args?.analyzeImages === 'boolean') payload.analyze_images = args.analyzeImages
        if (typeof args?.freeShipping === 'boolean') payload.free_shipping = args.freeShipping
        if (payload.decision_mode === 'ai' && !payload.description) {
          throw new Error('ai mode requires a description of the wanted item')
        }
        if (payload.decision_mode === 'keyword' && rules.length === 0) {
          throw new Error('keyword mode requires keywordRules')
        }
        await deps.ensureServer()
        return deps.api().createTask(payload)
      },
    },
    {
      name: 'goofish_task_update',
      description:
        'Update fields of an existing ai-goofish-monitor task (PATCH). Only the fields you pass are changed; the backend ignores unknown ones. Use enabled to switch a task on before goofish_task_run, or off to stop cron scheduling.',
      parameters: objectSchema(
        {
          taskId: int('Task id from goofish_tasks (0 is valid).', 0),
          taskName: str('New task name.'),
          keyword: str('New search keyword.'),
          description: str('New requirement text (ai mode).'),
          decisionMode: { type: 'string', enum: ['ai', 'keyword'], description: 'Judgement mode.' },
          keywordRules: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keywords for keyword mode; any hit recommends.',
          },
          minPrice: str('Minimum price in CNY, as text.'),
          maxPrice: str('Maximum price in CNY, as text.'),
          maxPages: int('Maximum listing pages to crawl.', 1, 20),
          cron: str('New cron expression; pass an empty string to clear it.'),
          enabled: bool('Whether the task is enabled (required before goofish_task_run).'),
          analyzeImages: bool('Whether the AI should analyze listing images.'),
          freeShipping: bool('Only accept free-shipping listings.'),
        },
        ['taskId'],
      ),
      output: textOutput,
      async execute(args) {
        const taskId = Number(args?.taskId)
        if (!Number.isInteger(taskId) || taskId < 0) throw new Error('taskId must be a non-negative integer')
        const payload = {}
        if (typeof args?.taskName === 'string' && args.taskName.trim() !== '') payload.task_name = args.taskName.trim()
        if (typeof args?.keyword === 'string' && args.keyword.trim() !== '') payload.keyword = args.keyword.trim()
        if (typeof args?.description === 'string') payload.description = args.description.trim()
        if (args?.decisionMode === 'ai' || args?.decisionMode === 'keyword') payload.decision_mode = args.decisionMode
        if (Array.isArray(args?.keywordRules)) payload.keyword_rules = args.keywordRules.map((rule) => String(rule).trim()).filter(Boolean)
        if (typeof args?.minPrice === 'string') payload.min_price = args.minPrice.trim()
        if (typeof args?.maxPrice === 'string') payload.max_price = args.maxPrice.trim()
        if (Number.isInteger(args?.maxPages)) payload.max_pages = args.maxPages
        if (typeof args?.cron === 'string') payload.cron = args.cron.trim() === '' ? null : args.cron.trim()
        if (typeof args?.enabled === 'boolean') payload.enabled = args.enabled
        if (typeof args?.analyzeImages === 'boolean') payload.analyze_images = args.analyzeImages
        if (typeof args?.freeShipping === 'boolean') payload.free_shipping = args.freeShipping
        if (Object.keys(payload).length === 0) throw new Error('no fields to update')
        await deps.ensureServer()
        return deps.api().updateTask(taskId, payload)
      },
    },
    {
      name: 'goofish_task_delete',
      description:
        'Delete an ai-goofish-monitor task. The backend stops its spider first (if running) and removes the task row; result files and logs are kept on disk.',
      parameters: objectSchema({ taskId: int('Task id from goofish_tasks (0 is valid).', 0) }, ['taskId']),
      output: textOutput,
      async execute(args) {
        const taskId = Number(args?.taskId)
        if (!Number.isInteger(taskId) || taskId < 0) throw new Error('taskId must be a non-negative integer')
        await deps.ensureServer()
        return { taskId, result: await deps.api().deleteTask(taskId) }
      },
    },
    {
      name: 'goofish_task_run',
      description:
        'Start one monitor task now. The backend spawns the Playwright spider; progress goes to logs (goofish_logs) and discovered listings to results (goofish_results). Debug crawling limits are a backend environment setting (SPIDER_DEBUG_LIMIT), not a per-run argument.',
      parameters: objectSchema({ taskId: int('Task id from goofish_tasks (0 is valid).', 0) }, ['taskId']),
      output: textOutput,
      async execute(args) {
        const taskId = Number(args?.taskId)
        if (!Number.isInteger(taskId) || taskId < 0) throw new Error('taskId must be a non-negative integer')
        await deps.ensureServer()
        const result = await deps.api().startTask(taskId)
        return { taskId, result }
      },
    },
    {
      name: 'goofish_task_stop',
      description: 'Stop a running ai-goofish-monitor task and its spider process.',
      parameters: objectSchema({ taskId: int('Task id from goofish_tasks (0 is valid).', 0) }, ['taskId']),
      output: textOutput,
      async execute(args) {
        const taskId = Number(args?.taskId)
        if (!Number.isInteger(taskId) || taskId < 0) throw new Error('taskId must be a non-negative integer')
        await deps.ensureServer()
        return { taskId, result: await deps.api().stopTask(taskId) }
      },
    },
    {
      name: 'goofish_results',
      description:
        'Read ai-goofish-monitor analysis results. action "list" lists stored result files; action "preview" returns analyzed listings (title, price, AI recommendation) from one file.',
      parameters: objectSchema(
        {
          action: { type: 'string', enum: ['list', 'preview'], description: 'list files or preview one file.' },
          file: str('Result file name for preview (from list).'),
          limit: int('How many listings to preview (1-100, default 10).', 1, 100),
        },
        ['action'],
      ),
      output: textOutput,
      async execute(args) {
        const action = String(args?.action ?? 'list').trim()
        await deps.ensureServer()
        const api = deps.api()
        if (action === 'list') {
          const payload = await api.listResultFiles()
          const files = Array.isArray(payload) ? payload : (payload?.files ?? [])
          return { files }
        }
        if (action === 'preview') {
          const file = String(args?.file ?? '').trim()
          if (file === '') throw new Error('preview requires a file name')
          const limit = Number.isInteger(args?.limit) ? args.limit : 10
          return { file, result: await api.getResults(file, { limit, page: 1 }) }
        }
        throw new Error(`unknown action "${action}"; expected list or preview`)
      },
    },
    {
      name: 'goofish_logs',
      description: 'Read the tail of one ai-goofish-monitor task log to diagnose crawling, login-state, or AI failures.',
      parameters: objectSchema(
        {
          taskId: int('Task id from goofish_tasks (0 is valid).', 0),
          lines: int('Number of trailing lines (1-1000, default 80).', 1, 1000),
        },
        ['taskId'],
      ),
      output: textOutput,
      async execute(args) {
        const taskId = Number(args?.taskId)
        if (!Number.isInteger(taskId) || taskId < 0) throw new Error('taskId must be a non-negative integer')
        const lines = Number.isInteger(args?.lines) ? args.lines : 80
        await deps.ensureServer()
        const payload = await deps.api().tailLogs({ taskId, limitLines: lines })
        return { taskId, content: payload?.content ?? '', hasMore: payload?.has_more === true }
      },
    },
    {
      name: 'goofish_ai',
      description:
        'Inspect or configure the AI analysis model. action "status" reports the effective OpenAI-compatible endpoint and model; action "models" lists models reachable through the Our Free Model local gateway; action "apply" writes the chosen model (and the gateway endpoint/key) into the project .env so tasks use it.',
      parameters: objectSchema(
        {
          action: { type: 'string', enum: ['status', 'models', 'apply'], description: 'AI gateway action.' },
          model: str('Model id to apply (action "apply"); omit to auto-pick a vision model.'),
        },
        ['action'],
      ),
      output: textOutput,
      async execute(args) {
        const action = String(args?.action ?? 'status').trim()
        if (action === 'status') return deps.getStatus().then((status) => status.ai)
        if (action === 'models') return deps.listAiModels()
        if (action === 'apply') {
          const model = typeof args?.model === 'string' ? args.model.trim() : ''
          return deps.applyAi({ model })
        }
        throw new Error(`unknown action "${action}"; expected status, models, or apply`)
      },
    },
  ]
  return tools
}
