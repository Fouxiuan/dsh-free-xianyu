# Third-party notices

`dsh-free-xianyu` is a DeepSeek Harness plugin. It does **not** vendor the
projects it drives: it installs, starts, and talks to them at runtime. Their
source lives in their own repositories, under their own licenses.

## 1. ai-goofish-monitor

- Repository: <https://github.com/Usagi-org/ai-goofish-monitor>
- License: MIT — Copyright (c) 2025 dingyufei615
- What it provides: the FastAPI backend, the Playwright scraper, the SQLite
  storage, and the Vue 3 console. This plugin launches that backend as a child
  process, calls its HTTP API, and builds its frontend bundle.

The MIT text above is reproduced in this repository's [`LICENSE`](LICENSE)
(Copyright (c) 2025 dingyufei615 applies to that project's files). Any
redistribution of ai-goofish-monitor must keep its copyright notice.

## 2. dsh-our-free-model

- Repository: <https://github.com/Ebony-Vinyl/dsh-our-free-model>
- License: see that repository's own declaration
- What it provides: the local OpenAI-compatible gateway and the free model
  lanes this plugin points listing analysis at.

This plugin only **reads** that plugin's settings file
(`<DSH_HOME>/our-free-model/settings.json`) to discover the gateway port and
key, and probes `GET /v1/models`. It never modifies the other plugin's state.

## 3. DeepSeek Harness

- The host application this plugin is written for. Plugin APIs used here are
  documented public contracts (`ctx.tools`, `ctx.webServer`,
  `ctx.slots`, `ctx.locale`).
