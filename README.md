# dsh-free-xianyu · 闲鱼免费监控
领到免费token不知道拿来做什么，做开发又怕不安全，额度不够，对话又有点多余，不如做些实际的功能，又不会又风险的事情把

[![npm](https://img.shields.io/npm/v/dsh-free-xianyu.svg)](https://www.npmjs.com/package/dsh-free-xianyu)
[![license](https://img.shields.io/npm/l/dsh-free-xianyu.svg)](LICENSE)
[![install](https://img.shields.io/badge/install-dsh%20plugin%20add%20dsh--free--xianyu-blue)](https://www.npmjs.com/package/dsh-free-xianyu)

把闲鱼（Goofish）二手商品监控做成 **DeepSeek Harness 插件**：装进 Harness 后，左侧导航多一个
「闲鱼免费监控」，点开就能起服务、建任务、跑抓取、看 AI 选品结果；AI 分析走 **dsh-our-free-model**
的免费模型，不需要自己的付费 API Key。

> **装完即可用，不需要另外克隆仓库。** 上游
> [ai-goofish-monitor](https://github.com/Usagi-org/ai-goofish-monitor) 的源代码已内置在本仓库的
> `upstream/` 里；插件首次启动会自动建好专属 Python 虚拟环境、装好依赖、布置好工作目录。
> 机器上只要有 **Python 3.10+**，其余都不用手动准备。

**一条命令安装**

```bash
dsh plugin --profile desktop add dsh-free-xianyu
```

装完重启 Harness，左侧导航出现「闲鱼免费监控」。

也可以用 `add github:Fouxiuan/dsh-free-xianyu` 直接从仓库装（不经过 npm）。其他方式见[安装](#安装)章节。

<details>
<summary>关于内置上游代码</summary>

- `upstream/` 是 ai-goofish-monitor 的后端源码与预构建控制台（`src/`、`spider_v2.py`、`prompts/`、
  `dist/` 等，约 1.3MB），采用上游的 MIT 许可，版权归其作者（见 [NOTICE.md](NOTICE.md)）。
- 插件在 `<DSH_HOME>/dsh-free-xianyu/runtime/` 下创建 venv 与工作目录，**不改动** `upstream/`；
  自己的任务、结果、日志都写在运行时目录里，升级插件不会丢数据。
- 如果你更想用自己维护的那份上游项目，把 `projectRoot` 指向它（或把 `useBuiltinRuntime` 设为
  `false`），插件就改为驱动你的目录，内置副本不再使用。
- 内置副本是**快照**。上游更新后要跟进，需要重新同步 `upstream/`；想始终跟随上游就切外部模式。

</details>

<p align="center">
  <img src="icon.svg" width="96" height="96" alt="dsh-free-xianyu icon">
</p>

## 它做了什么

```
DeepSeek Harness Host 进程
└─ dsh-free-xianyu
   ├─ Host 半身 (index.js + lib/)
   │  ├─ 内置上游 + 自动运行环境: <DSH_HOME>/dsh-free-xianyu/runtime/
   │  │  ├─ venv/    ← python -m venv + pip install（首次约 40 秒）
   │  │  └─ app/     ← 布置好的工作目录（任务/结果/日志都在这）
   │  ├─ 托管子进程: venv/python -m src.app  → http://127.0.0.1:8848
   │  ├─ 13 个 goofish_* Agent 工具
   │  ├─ 同源 API: /api/dsh-free-xianyu/*
   │  └─ 控制台: upstream/dist（内置）/ 有 web-ui 源码时自动重建
   └─ 浏览器半身 (client.js)
      ├─ sidebar.panellist → 左侧导航「闲鱼免费监控」图标
      └─ main             → 监控面板（状态/任务/结果/日志/AI 模型）

AI 调用链
└─ ai-goofish-monitor 的 .env
   OPENAI_BASE_URL=http://127.0.0.1:<网关端口>/v1
   OPENAI_API_KEY=<网关 Key>
   OPENAI_MODEL_NAME=<免费视觉模型>
   ↑ 由 dsh-our-free-model 的本地网关提供
```

### 特性

- **零外部依赖安装**：上游源码与预构建控制台都在 `upstream/` 里，首次启动自动建 venv、装依赖、
  布置工作目录。机器上只要有 Python 3.10+。
- **一站式生命周期**：装好插件自动起后台；停止/重启/健康检查/退出清理都由插件负责。已经在跑的实例会被
  复用（不会去杀不是它启动的进程）。
- **控制台开箱可用**：内置了预构建的 Vue 控制台，`http://127.0.0.1:8848/` 装完即可打开；如果你提供了
  上游的 `web-ui/` 源码，插件也能自动 `npm install` + `npm run build` 重建。
- **13 个 Agent 工具**：模型可以直接建任务、跑任务、读结果、看日志、切模型、初始化环境、构建前端。
- **免费模型接入**：自动发现 dsh-our-free-model 的本地网关（`chanGateway.relay` 或 `forward`），
  挑选带视觉能力的免费模型，写进运行时目录的 `.env`（备份为 `.env.bak`）。
- **无登录态也能启动**：服务、任务列表、结果、日志、控制台都不依赖闲鱼登录态；只有真正跑抓取任务才需要。
- **侧边栏面板**：不离开 Harness 就能看服务状态、运行环境、任务列表、结果文件、日志与 AI 配置。

## 上游项目

| 项目 | 关系 | 链接 |
| --- | --- | --- |
| **ai-goofish-monitor** | 抓取与分析的实现，源码已**内置**在 `upstream/` | <https://github.com/Usagi-org/ai-goofish-monitor> |
| **dsh-our-free-model** | 提供免费模型的本地网关，需另行安装 | <https://github.com/Ebony-Vinyl/dsh-our-free-model> |

装上本插件就已经包含 ai-goofish-monitor 的后端代码，**不需要再克隆它**。
dsh-our-free-model 是另一个独立插件，AI 分析需要它（也可以改用你自己的付费 API）。

两个上游各自独立维护；内置副本遵守其 MIT 许可，版权归原作者（见 [NOTICE.md](NOTICE.md)）。

## 安装

**只有两个前置条件**：机器上有 Python 3.10+，以及（用于 AI 分析）装上 dsh-our-free-model。

### 1. 装本插件

三种方式，按方便程度排。**先完全退出 Harness 桌面程序**再执行命令（profile 有写锁）。

**用 Harness CLI 一条命令装（推荐）**

```bash
# 从 npm 装（最短）
dsh plugin --profile desktop add dsh-free-xianyu

# 或直接从 GitHub 装：不经过 npm
dsh plugin --profile desktop add github:Fouxiuan/dsh-free-xianyu
```

桌面版和被 `dsh web` 启动的 profile 都适用；`desktop` 之外的 profile 换成对应名字即可
（如 `--profile tui`）。装完会自动写进 profile 的 `dependencies` 与 `dsh.profile.bundles`。

更新：npm 方式用 `add dsh-free-xianyu@latest`；github 方式重跑同一条命令。想锁定版本：

```bash
dsh plugin --profile desktop add dsh-free-xianyu@1.1.0
dsh plugin --profile desktop add github:Fouxiuan/dsh-free-xianyu#<commit-sha>
```

**在 Harness 界面里装**

设置 → 插件 → 从本地目录安装，指向本仓库目录；或让 Agent 执行：

```text
plugin_manager action=install_bundle target=<本仓库目录>
```

**本地路径（开发时最方便，改代码立即生效）**

```bash
dsh plugin --profile desktop add link:/absolute/path/to/dsh-free-xianyu
```

> 三种方式装到的都是同一份完整内容（含内置的 `upstream/`），功能完全一致；
> 区别只在更新方式和是否需要联网拉取。

### 2. 首次启动会自动准备环境

插件激活后自动执行一次（约 40 秒，只需一次）：

1. `python -m venv` 建专属虚拟环境 → `<DSH_HOME>/dsh-free-xianyu/runtime/venv/`
2. `pip install` 装内置的依赖清单 → 18 条声明、52 个包，含 fastapi / playwright / openai
3. 把 `upstream/` 的源码、提示词与预构建控制台布置到工作目录 → `runtime/app/`

之后就运行在 `runtime/app/`，任务、结果、日志都写在里面。

> 机器没有网络、或想手动控制时机时，把 `autoProvision` 设为 `false`，
> 需要时调用 `goofish_runtime action=setup`。

### 3. 确认

```text
goofish_status                     # 看 runtime.ready 是否为 true
goofish_runtime action=status      # 运行环境详情
goofish_console action=status      # 控制台构建状态
```

侧边栏面板的「运行环境」一行也会显示 `待初始化` / `内置就绪`，未就绪时旁边有「初始化环境」按钮。

### 4. （可跳过）改用你自己的上游项目

如果你想用自己维护的 ai-goofish-monitor，在 `cordis.patch.yml` 里把 `projectRoot` 指到它的
绝对路径（或设 `useBuiltinRuntime: false`），插件就改为驱动那个目录，内置副本不再使用。此时需要
你自己装好它的依赖。

## 项目结构

运行原理可以看这张交互式架构图（点节点跳到对应源码，支持深色模式与导出）：
[`dsh-free-xianyu-architecture.html`](dsh-free-xianyu-architecture.html)

```
dsh-free-xianyu/
├── index.js              Host 半身入口（注册工具、路由、托管后台）
├── client.js             浏览器半身（侧边栏图标 + 监控面板）
├── cordis.patch.yml      bundle 挂载行
├── lib/
│   ├── runtime.js        ★ 内置运行环境：建 venv、装依赖、布置工作目录
│   ├── backend.js        后台子进程生命周期
│   ├── frontend.js       可选的前端重建（有 web-ui 源码时）
│   ├── gateway.js        dsh-our-free-model 网关发现与 .env 写入
│   ├── goofish-api.js    后端 HTTP 客户端
│   ├── routes.js         同源 API /api/dsh-free-xianyu/*
│   ├── tools.js          13 个 goofish_* 工具定义
│   ├── config.js / paths.js
│   └── *.selftest.mjs    5 套离线自测
├── upstream/             ★ 内置的 ai-goofish-monitor（源码 + 预构建控制台）
├── dsh-free-xianyu-architecture.html   架构图（自包含单文件）
├── docs/screenshots/     README 截图
└── locale/ icon.svg
```

运行时数据（不属于仓库）：

```
<DSH_HOME>/dsh-free-xianyu/
├── runtime/venv/         插件专属虚拟环境
├── runtime/app/          工作目录：任务、结果、日志、登录态、.env
├── runtime/deps.json     依赖指纹
└── backend.log           后台进程日志
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖该行的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `useBuiltinRuntime` | `true` | 用内置上游 + 自动 venv；设 `false` 则改为驱动 `projectRoot` 指定的项目 |
| `autoProvision` | `true` | 首次启动自动建 venv / 装依赖 / 布置工作目录 |
| `projectRoot` | 空 | 可选：你自己的 ai-goofish-monitor 目录；空 = 用内置副本 |
| `pythonPath` | `python` | 用来**创建 venv** 的 Python；外部模式下则是运行解释器 |
| `serverPort` | `8848` | 后台监听端口（仅本机） |
| `autoStart` | `true` | 插件激活时自动启后台 |
| `aiBaseURL` | 空 | 手动指定 OpenAI 兼容地址；空 = 自动用免费模型网关 |
| `aiApiKey` | 空 | 手动指定网关 Key；空 = 自动读 |
| `aiModel` | 空 | 固定模型 id；空 = 自动选带视觉的免费模型 |
| `requestTimeoutMs` | `15000` | 调用后台接口超时 |
| `manageEnv` | `true` | 是否把 AI 设置写入运行时目录的 `.env` |
| `buildFrontend` | `true` | 是否管理前端构建（关掉则完全不碰 `web-ui/`、`dist/`） |
| `autoBuildFrontend` | `true` | 启后台前自动补齐/重建 `dist/` |
| `frontendInstall` | `true` | 缺 `web-ui/node_modules` 时自动 `npm install` |

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `goofish_status` | 服务、AI、项目、控制台、运行环境状态 |
| `goofish_runtime` | 运行环境状态 / 手动初始化（建 venv、装依赖、布置目录） |
| `goofish_server` | 启动 / 停止 / 重启后台 |
| `goofish_console` | 控制台构建状态 / 触发构建（可顺带重启） |
| `goofish_tasks` | 任务列表 |
| `goofish_task_create` | 建任务（AI 判断或关键词判断） |
| `goofish_task_update` / `goofish_task_delete` | 改 / 删任务（任务需启用后才能跑） |
| `goofish_task_run` / `goofish_task_stop` | 运行 / 停止任务 |
| `goofish_results` | 结果文件列表 / 商品分析预览 |
| `goofish_logs` | 任务日志尾部 |
| `goofish_ai` | AI 网关状态 / 模型列表 / 应用模型 |

调试抓取条数不是工具参数，而是后台环境变量 `SPIDER_DEBUG_LIMIT`（由 ai-goofish-monitor 的
`src/services/process_service.py` 读取），要在启动后台前设置。

## 接入免费模型的步骤

1. 在 Harness 里装好 `dsh-our-free-model`。
2. 打开 **设置 → Our Free Model → 网关设置**，开启网关（渠道模型网关 / 中继）。
   插件会按顺序探测该插件声明的两个 OpenAI 兼容监听器：先 `chanGateway.relay`（页面上的
   「启用网关」），再旧版 `forward` 监听（默认 18899）。任一开启即可。
3. `goofish_ai action=models` 看可用模型，`goofish_ai action=apply model=<id>` 应用。
   推荐带视觉的免费模型，例如 `our-free-model/nemotron-3.5-super-vl-free`。
4. 插件把三项写进 ai-goofish-monitor 的 `.env` 并重启后台：

   ```dotenv
   OPENAI_BASE_URL=http://127.0.0.1:<网关端口>/v1
   OPENAI_API_KEY=<网关 Key>
   OPENAI_MODEL_NAME=our-free-model/nemotron-3.5-super-vl-free
   ```

> **免费车道的额外前置**：`our-free-model/*-free` 系列由 dsh-our-free-model 通过本机 **Bun**
> 转发。没装 Bun 会返回 502 并提示「需要本机 Bun」：`npm i -g --allow-scripts=bun bun`。
> 非免费车道模型（如 `cline/nvidia/nemotron-3.5-super-vl`）不需要 Bun。

## 使用方式

- **侧边栏面板**：左侧「闲鱼免费监控」→ 服务状态与启停、完整控制台入口、AI 模型下拉、任务列表
  （运行/停止/看日志）、结果文件。每 5 秒自动刷新。
- **完整 Vue 控制台**：`http://127.0.0.1:8848/`（端口取 `serverPort`）。内置了预构建版本，
  装完直接能开；任务、结果、日志、设置都在这里。
- **对话里**：直接说「建一个监控 MacBook Air M1、2500-3500 的任务并跑一次」，模型会调用对应工具。

## 截图

### 1. Harness 里的面板 + 完整控制台

左侧是插件注册的「闲鱼免费监控」面板，内嵌的是插件托管的 ai-goofish-monitor 控制台
（`http://127.0.0.1:8848/dashboard`）：任务量、已扫描商品、AI 推荐数、价格曲线、实时动态。

![Harness 侧边栏面板与完整控制台](docs/screenshots/01-harness-panel.png)

### 2. 服务状态卡

地址、端口、PID、项目目录、日志文件、完整控制台链接（「可直接打开」）、AI 模式、
AI 模型、网关端口，以及启动/停止/构建前端三个动作。

![插件面板的服务状态卡](docs/screenshots/03-service-status.png)

### 3. AI 模型选择

模型下拉直接列出 dsh-our-free-model 网关返回的全部模型；选中后点「应用到项目」，
插件会写入 `.env` 并重启后台。下方是监控任务表（运行/停止/日志）与结果文件列表。

![AI 模型下拉、监控任务与结果文件](docs/screenshots/02-ai-models.png)

## 前置条件

- **Python 3.10+**（唯一必须自己准备的东西）。依赖由插件装进专属 venv，不污染全局环境。
- **Node.js + npm**：只在构建 Vue 控制台时需要。首次构建缺依赖时插件会自动 `npm install`；
  没装 Node 也能用后台 API 和侧边栏面板，只是没有完整的 Web 控制台。
- **闲鱼登录态**：需要用上游的 Chrome 扩展（`upstream/chrome-extension/`）导出一次，
  放进运行时目录的 `state/` 下。**没有登录态时服务照样能启动**，任务列表、结果、日志都能看，
  只有真正跑抓取任务会报“未找到登录状态文件”。
- **Playwright 浏览器**：首次抓取时若缺浏览器，执行
  `runtime/venv/Scripts/python -m playwright install chromium`（或用系统已有的 Chrome/Edge，
  上游默认走系统浏览器，通常不必额外下载）。
- 商品分析默认读图片，必须用**支持视觉**的模型。

## 安全说明

- 后台服务只绑定本机回环；插件的 API 走 Harness 同源路由，并用与 Harness `/api` 相同的准入校验
  （`connection.requestRejection`），不额外暴露到局域网。
- 网关 Key 只写进运行时目录的 `.env`，插件的状态接口只返回掩码。
- 本插件**不修改** dsh-our-free-model 的设置；开启网关要你在它自己的设置页操作。
- 虚拟环境与工作目录都在 `<DSH_HOME>/dsh-free-xianyu/` 下，不写入系统 Python、不改 `upstream/`。

## 常见问题

**首次启动卡在「待初始化」？**
看 `goofish_runtime action=status` 的 `error`，再到 `<DSH_HOME>/dsh-free-xianyu/backend.log`
看 pip 输出。最常见的是机器上找不到 `python`：把 `pythonPath` 写成解释器绝对路径
（`python3` / `py -3` 也可以）后重试 `goofish_runtime action=setup`。

**装完没网，自动装依赖失败？**
把 `autoProvision` 设为 `false`，联网后再手动 `goofish_runtime action=setup`。
已装好的 venv 有指纹记录，不会重复安装。

**控制台打开是 500 / 空白？**
`upstream/dist` 里内置了预构建版本，正常可直接打开。若被你自己清掉，重新
`goofish_runtime action=setup` 即可恢复；想用自己的前端就提供 `web-ui/` 源码后
`goofish_console action=build restart=true`。

**跑任务报「未找到登录状态文件」？**
闲鱼登录态还没有。用 `upstream/chrome-extension/` 导出一次 JSON，放进
`<DSH_HOME>/dsh-free-xianyu/runtime/app/state/`。**这不是启动失败**——服务、面板、结果、日志
在无登录态时都正常。

**抓取报浏览器相关错误？**
上游默认走系统 Chrome / Edge；两者都没有时安装 Playwright 浏览器：
`<DSH_HOME>/dsh-free-xianyu/runtime/venv/Scripts/python -m playwright install chromium`。

**升级插件后数据会丢吗？**
不会。重新部署只覆盖 `runtime/app/` 里的**代码**（`src/`、`spider_v2.py`、`dist/`），
`jsonl/`、`logs/`、`images/`、`state/`、`prompts/` 都保留。

**怎么跟随上游更新？**
内置副本是快照。要么重新同步 `upstream/`，要么设 `useBuiltinRuntime: false` +
`projectRoot` 指向你自己维护的 checkout。

**`dsh plugin add` 报了 pnpm / 写锁相关的错误？**
说明 Harness 还开着。先完全退出桌面程序（包括托盘），再执行命令。另外这条命令走的是
pnpm，需要机器上有 pnpm；桌面版自带一份，`dsh web` 启动的场景则需要你自己装。

**从 `link:` 换成 `github:` 安装，报依赖冲突？**
同一个包不能同时有两种来源。先移除再装：

```bash
dsh plugin --profile desktop remove dsh-free-xianyu
dsh plugin --profile desktop add github:Fouxiuan/dsh-free-xianyu
```

## 开发与自测

```bash
# 语法检查
node --check index.js
node --check client.js
node --check lib/*.js

# 纯逻辑自测（不需要真实网关 / 后台 / 网络）
node client.selftest.mjs              # 浏览器半身：插槽注册契约
node lib/runtime.selftest.mjs         # 运行环境状态判定
node lib/frontend.selftest.mjs        # 前端构建状态判定
node lib/gateway.selftest.mjs         # 免费模型网关发现与环境写入
node lib/goofish-api.selftest.mjs     # HTTP 客户端；设 GOOFISH_TEST_BASEURL 时跑真实接口
```

浏览器半身只做两件事：注册 `sidebar.panellist`（图标）和 `main`（面板），写法与
`dsh-context`、`dshmarket` 一致；`apply()` 全同步、所有注册都包在 try/catch 里，页面请求失败只显示在
面板内，不会阻塞 Harness 的 `web boot`。

## 许可证

[MIT](LICENSE) © 2026 Fouxiuan

`upstream/` 内置了 ai-goofish-monitor 的源码与构建产物，遵守其 **MIT** 许可
（Copyright (c) 2025 dingyufei615）；`dsh-our-free-model` 是运行时依赖的另一个插件，
本仓库不包含它的代码，许可见其仓库声明。完整第三方归属见 [NOTICE.md](NOTICE.md)。
