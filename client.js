/**
 * Browser half of `dsh-free-xianyu`.
 *
 * Registers the two public client contracts a plugin may own for the left rail:
 * a `sidebar.panellist` icon and the `main` panel it opens. Both use the same id
 * because the shell selects the central panel by the sidebar entry id — the
 * pattern `dsh-context` and `dshmarket` use.
 *
 * This file is deliberately small and synchronous. A browser entry that never
 * reaches ACTIVE makes the Web boot audit refuse to start the app
 * (`web boot: N entries did not activate`), so the factory only defines
 * components and `apply()` never throws: every registration is guarded and the
 * page handles its own failures instead of propagating them.
 *
 * @module client
 */

;(() => {
  const PACKAGE_ID = 'dsh-free-xianyu'
  const API = '/api/dsh-free-xianyu'
  const LABEL = '闲鱼免费监控'
  /** Between 上下文洞察 (20) and the host's own trailing rows. */
  const ORDER = 46
  const REFRESH_MS = 5000

  window.__ModuleLoader__.load({
    id: PACKAGE_ID,
    factory(require) {
      const React = require('react')
      const h = React.createElement

  const S = {
    root: {
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      padding: '18px 22px 28px',
      minHeight: '100%',
      boxSizing: 'border-box',
      fontSize: '13px',
      lineHeight: '1.5',
      overflow: 'auto',
    },
    header: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
    title: { fontSize: '17px', fontWeight: 600, margin: 0 },
    subtitle: { opacity: 0.6, fontSize: '12px' },
    card: {
      border: '1px solid rgba(127,127,127,0.25)',
      borderRadius: '10px',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      background: 'rgba(127,127,127,0.04)',
    },
    cardTitle: { fontWeight: 600, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
    row: { display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' },
    key: { opacity: 0.6, minWidth: '84px' },
    value: { wordBreak: 'break-all', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
    buttons: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
    button: {
      border: '1px solid rgba(127,127,127,0.35)',
      borderRadius: '7px',
      background: 'transparent',
      color: 'inherit',
      padding: '4px 11px',
      fontSize: '12px',
      cursor: 'pointer',
      font: 'inherit',
    },
    buttonPrimary: { borderColor: 'transparent', background: 'rgba(56,132,255,0.16)', color: 'inherit' },
    buttonDanger: { borderColor: 'rgba(220,80,80,0.4)', background: 'rgba(220,80,80,0.12)' },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
    th: { textAlign: 'left', padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,0.25)', fontWeight: 600, opacity: 0.75 },
    td: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,0.12)', verticalAlign: 'middle' },
    badge: { display: 'inline-block', padding: '1px 8px', borderRadius: '999px', fontSize: '11px', border: '1px solid rgba(127,127,127,0.35)' },
    ok: { borderColor: 'rgba(60,180,110,0.5)', background: 'rgba(60,180,110,0.14)' },
    bad: { borderColor: 'rgba(220,80,80,0.5)', background: 'rgba(220,80,80,0.14)' },
    pre: {
      margin: 0,
      maxHeight: '240px',
      overflow: 'auto',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '11.5px',
      lineHeight: '1.45',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      background: 'rgba(0,0,0,0.18)',
      borderRadius: '8px',
      padding: '10px 12px',
    },
    select: {
      font: 'inherit',
      fontSize: '12px',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid rgba(127,127,127,0.35)',
      borderRadius: '7px',
      padding: '3px 6px',
      maxWidth: '100%',
    },
    error: { color: '#e06c6c', fontSize: '12px' },
    notice: { color: '#4aa96c', fontSize: '12px' },
    muted: { opacity: 0.6, fontSize: '12px' },
  }

  function button(style, label, onClick, disabled) {
    return h(
      'button',
      { type: 'button', style: { ...S.button, ...style }, onClick, disabled: disabled === true },
      label,
    )
  }

  function Row(props) {
    if (props.value === undefined || props.value === null || props.value === '') return null
    return h('div', { style: S.row }, h('span', { style: S.key }, props.label), h('span', { style: S.value }, String(props.value)))
  }

  async function call(path, options) {
    const init = { credentials: 'same-origin', ...options }
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      init.body = JSON.stringify(init.body)
      init.headers = { 'content-type': 'application/json', ...(init.headers ?? {}) }
    }
    const res = await fetch(API + path, init)
    const text = await res.text()
    let payload = null
    if (text !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
    }
    if (!res.ok || (payload && payload.ok === false)) {
      const message = (payload && payload.error) || text || 'HTTP ' + res.status
      throw new Error(message)
    }
    return payload ?? {}
  }

  function fileNameOf(entry) {
    if (typeof entry === 'string') return entry
    const name = entry && (entry.filename ?? entry.name ?? entry.file ?? entry.path)
    return typeof name === 'string' ? name : ''
  }

  function taskRunState(task) {
    const raw = task && (task.status ?? task.run_status ?? task.state)
    return typeof raw === 'string' && raw !== '' ? raw : ''
  }

  function Icon(props) {
    const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', {
        d: 'M2.6 12.1c2.2-3.7 5.3-5.5 9.2-5.5 2.5 0 4.6.6 6.3 1.9l2.5-1.4-.7 3 1.7 2-1.7 2 .7 3-2.5-1.4c-1.7 1.3-3.8 1.9-6.3 1.9-3.9 0-7-1.8-9.2-5.5Z',
      }),
      h('circle', { cx: 6.6, cy: 11.9, r: 0.95, fill: 'currentColor', stroke: 'none' }),
    )
  }

  function MonitorPage() {
    const [status, setStatus] = React.useState(null)
    const [tasks, setTasks] = React.useState([])
    const [files, setFiles] = React.useState([])
    const [logTaskId, setLogTaskId] = React.useState(null)
    const [logs, setLogs] = React.useState('')
    const [models, setModels] = React.useState([])
    const [model, setModel] = React.useState('')
    const [busy, setBusy] = React.useState('')
    const [error, setError] = React.useState('')
    const [notice, setNotice] = React.useState('')

    const reload = React.useCallback(async () => {
      try {
        const [s, t, f] = await Promise.all([
          call('/status'),
          call('/tasks'),
          call('/results/files'),
        ])
        setStatus(s)
        setTasks(Array.isArray(t.tasks) ? t.tasks : [])
        setFiles(Array.isArray(f.files) ? f.files : [])
        setError('')
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }, [])

    const loadModels = React.useCallback(async () => {
      try {
        const payload = await call('/ai/models')
        const list = Array.isArray(payload.models) ? payload.models : []
        setModels(list)
        if (payload.selected) setModel(payload.selected)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }, [])

    React.useEffect(() => {
      void reload()
      void loadModels()
      const timer = setInterval(() => {
        void reload()
      }, REFRESH_MS)
      return () => clearInterval(timer)
    }, [reload, loadModels])

    const run = React.useCallback(
      async (action, path, body) => {
        setBusy(action)
        setNotice('')
        setError('')
        try {
          const payload = await call(path, { method: 'POST', body: body ?? {} })
          const model_ = payload && payload.result && payload.result.message
          setNotice(model_ ? action + '：' + model_ : action + ' 完成')
          await reload()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy('')
        }
      },
      [reload],
    )

    const loadLogs = React.useCallback(async (taskId) => {
      setLogTaskId(taskId)
      if (taskId === null || taskId === undefined) {
        setLogs('')
        return
      }
      try {
        const payload = await call('/logs?taskId=' + encodeURIComponent(String(taskId)) + '&lines=120')
        setLogs(typeof payload.content === 'string' ? payload.content : '')
      } catch (cause) {
        setLogs('')
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }, [])

    const server = (status && status.server) || {}
    const ai = (status && status.ai) || {}
    const gateway = ai.gateway || {}
    const consoleInfo = (status && status.console) || {}
    const frontend = consoleInfo.frontend || {}
    const runtimeInfo = (status && status.runtime) || {}
    const healthy = server.healthy === true
    const consoleUrl = typeof consoleInfo.url === 'string' ? consoleInfo.url : ''
    const consoleServed = consoleInfo.served === true
    const runtimeReady = runtimeInfo.ready === true

    return h(
      'div',
      { style: S.root },
      h(
        'div',
        { style: S.header },
        h(Icon, { size: 22 }),
        h('h1', { style: S.title }, LABEL),
        h('span', { style: S.subtitle }, '闲鱼二手选品 · 免费模型分析'),
        h('span', { style: { flex: 1 } }),
        button({}, busy === '刷新' ? '刷新中…' : '刷新', () => void reload(), busy !== ''),
      ),

      error !== '' ? h('div', { style: S.error }, '错误：' + error) : null,
      notice !== '' ? h('div', { style: S.notice }, notice) : null,

      h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.cardTitle },
          '服务状态',
          h('span', { style: { ...S.badge, ...(healthy ? S.ok : S.bad) } }, healthy ? '运行中' : server.running ? '未就绪' : '已停止'),
          h('span', { style: { flex: 1 } }),
          button({ ...S.buttonPrimary }, busy === '启动' ? '启动中…' : '启动', () => void run('启动', '/server/start'), busy !== ''),
          button({ ...S.buttonDanger }, busy === '停止' ? '停止中…' : '停止', () => void run('停止', '/server/stop'), busy !== ''),
        ),
        h(Row, { label: '地址', value: server.url }),
        h(Row, { label: '端口', value: server.port }),
        h(Row, { label: 'PID', value: server.pid }),
        h(Row, { label: '项目目录', value: status && status.project && status.project.root }),
        h(Row, { label: '日志文件', value: server.logPath }),
        server.error ? h(Row, { label: '服务错误', value: server.error }) : null,
        h(
          'div',
          { style: S.row },
          h('span', { style: S.key }, '完整控制台'),
          h('span', { style: { ...S.badge, ...(consoleServed ? S.ok : S.bad) } }, consoleServed ? '可直接打开' : frontend.built ? '未挂载' : '前端未构建'),
          consoleUrl !== '' && healthy
            ? h('a', { href: consoleUrl, target: '_blank', rel: 'noopener noreferrer', style: S.value }, consoleUrl)
            : h('span', { style: S.muted }, frontend.built ? '启动服务后可打开' : '点「构建前端」生成页面'),
          h('span', { style: { flex: 1 } }),
          button({}, busy === '构建前端' ? '构建中…' : '构建前端', () => void run('构建前端', '/console/build', { restart: true }), busy !== ''),
        ),
        frontend.buildError ? h(Row, { label: '构建错误', value: frontend.buildError }) : null,
        h(
          'div',
          { style: S.row },
          h('span', { style: S.key }, '运行环境'),
          h(
            'span',
            { style: { ...S.badge, ...(runtimeReady ? S.ok : S.bad) } },
            runtimeReady ? (runtimeInfo.builtin === false ? '外部项目' : '内置就绪') : '待初始化',
          ),
          h('span', { style: S.muted }, runtimeInfo.builtin === false ? '使用 projectRoot 指定的项目' : `内置上游 ${runtimeInfo.upstreamFiles ?? 0} 个文件`),
          h('span', { style: { flex: 1 } }),
          runtimeReady
            ? null
            : button({ ...S.buttonPrimary }, busy === '初始化环境' ? '初始化中…' : '初始化环境', () => void run('初始化环境', '/runtime/setup', {}), busy !== ''),
        ),
        runtimeInfo.error ? h(Row, { label: '环境错误', value: runtimeInfo.error }) : null,
        h(
          'div',
          { style: S.row },
          h('span', { style: S.key }, 'AI 模式'),
          h('span', { style: S.value }, ai.mode || 'unknown'),
          h('span', { style: S.muted }, ai.baseURL || '未配置'),
        ),
        h(Row, { label: 'AI 模型', value: ai.model }),
        h(Row, { label: '网关', value: gateway.running ? '运行中 · 端口 ' + gateway.port : gateway.enabled ? '已启用未运行' : '未启用' }),
        ai.error ? h('div', { style: S.muted }, ai.error) : null,
      ),

      h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.cardTitle },
          'AI 模型',
          h('span', { style: { flex: 1 } }),
          button({}, '刷新模型', () => void loadModels(), busy !== ''),
          button(
            { ...S.buttonPrimary },
            busy === '应用模型' ? '应用中…' : '应用到项目',
            () => void run('应用模型', '/ai/apply', { model }),
            busy !== '' || model === '',
          ),
        ),
        models.length === 0
          ? h('div', { style: S.muted }, '没有取到模型：请在 设置 → Our Free Model → 网关设置 中启用转发网关。')
          : h(
              'select',
              { style: S.select, value: model, onChange: (event) => setModel(event.target.value) },
              models.map((entry) =>
                h('option', { key: entry.id, value: entry.id }, entry.id + (entry.vision ? ' · 视觉' : '')),
              ),
            ),
      ),

      h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.cardTitle },
          '监控任务',
          h('span', { style: { ...S.badge, ...(tasks.length > 0 ? S.ok : {}) } }, tasks.length + ' 个'),
        ),
        tasks.length === 0
          ? h('div', { style: S.muted }, '暂无任务。可以让 Agent 用 goofish_task_create 创建，或在项目控制台里创建。')
          : h(
              'table',
              { style: S.table },
              h('thead', null, h('tr', null, ['ID', '任务', '关键词', '状态', ''].map((label) => h('th', { key: label, style: S.th }, label)))),
              h(
                'tbody',
                null,
                tasks.map((task) => {
                  const id = Number(task.id)
                  const state = taskRunState(task)
                  return h(
                    'tr',
                    { key: String(id) },
                    h('td', { style: S.td }, String(task.id)),
                    h('td', { style: S.td }, String(task.task_name ?? '')),
                    h('td', { style: S.td }, String(task.keyword ?? '')),
                    h(
                      'td',
                      { style: S.td },
                      h('span', { style: { ...S.badge, ...(task.enabled ? S.ok : {}) } }, task.enabled ? '已启用' : '已停用'),
                      state !== '' ? h('span', { style: { ...S.badge, marginLeft: '6px' } }, state) : null,
                    ),
                    h(
                      'td',
                      { style: S.td },
                      h(
                        'span',
                        { style: S.buttons },
                        button({}, '运行', () => void run('运行任务', '/tasks/run', { taskId: id }), busy !== ''),
                        button({}, '停止', () => void run('停止任务', '/tasks/stop', { taskId: id }), busy !== ''),
                        button({}, '日志', () => void loadLogs(id), false),
                      ),
                    ),
                  )
                }),
              ),
            ),
        logTaskId !== null
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h(
                'div',
                { style: S.cardTitle },
                '日志 · 任务 ' + String(logTaskId),
                h('span', { style: { flex: 1 } }),
                button({}, '刷新日志', () => void loadLogs(logTaskId), false),
                button({}, '收起', () => void loadLogs(null), false),
              ),
              h('pre', { style: S.pre }, logs === '' ? '（暂无日志）' : logs),
            )
          : null,
      ),

      h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.cardTitle },
          '结果文件',
          h('span', { style: { ...S.badge, ...(files.length > 0 ? S.ok : {}) } }, files.length + ' 个'),
        ),
        files.length === 0
          ? h('div', { style: S.muted }, '暂无抓取结果。运行任务后结果写入项目 jsonl/ 目录。')
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
              files.slice(0, 30).map((entry, index) => {
                const name = fileNameOf(entry)
                return h('div', { key: name + ':' + index, style: S.value }, name === '' ? String(entry) : name)
              }),
            ),
      ),
    )
  }

  const module_ = { exports: {} }

  function apply(ctx) {
    try {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PACKAGE_ID, order: ORDER, label: () => LABEL }, Icon),
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PACKAGE_ID }, MonitorPage))
    } catch (cause) {
      try {
        console.error('[dsh-free-xianyu] sidebar registration failed:', cause)
      } catch {
        /* ignore */
      }
    }
  }

  module_.exports = { name: PACKAGE_ID, inject: ['slots'], apply }

  return module_.exports
    },
  })
})()
