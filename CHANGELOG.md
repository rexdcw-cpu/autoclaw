# Changelog

本文件记录 autoclaw 每个发布版本的变更。版本号遵循语义化版本（SemVer）。

---

## [0.3.23] — 2026-07-24
- **fix(vpnLauncher)：纠正「步骤1」的误判逻辑**。autoclaw 的 Chrome 用 `--proxy-server=127.0.0.1:7890` 直连 Mihomo 内核，**不读 Windows 系统代理**，故原"点击系统代理开关"对谷歌无效且误导。改为：① 先 TCP 探 7890 监听，监听即过（内核常驻的常见情况）；② 未监听则 best-effort 拉起 Mihomo Party 主程序（带起内核 sidecar），等 5s 重测；③ 仍不通则发明确告警"请在 Mihomo Party 启动内核"，不再假装"开启 VPN"；④ 原 `vpn_toggle.py` 点击脚本保留为可选（`AUTOCLAW_VPN_CLICK_SYSPROXY=1` 才启用）。worker 步骤文案同步改为"确认 Mihomo 内核/7890 可用"。实测：本机内核运行中，790/9090 监听、密钥鉴权通过、`getAvailableMainNodes` 返回 17 节点/15 可用、走 7890 打 Google 返回 200。

## [0.3.22] — 2026-07-24
- **feat(VPN 启动)：谷歌任务新增「步骤1 · 开启VPN」显式步骤**
  - 新增 `scripts/vpn_toggle.py`：用 `uiautomation` 操作桌面 Mihomo Party，点击左上角「系统代理」开启按钮（灰=关→蓝=开）。支持 `--on/--off/--status/--click-only/--debug`；以 TCP 连 `127.0.0.1:7890` 是否监听作为「是否已开」的客观判据；含名称查找 + 坐标兜底 + 调试输出。依赖 `pip install uiautomation`，须在交互桌面会话运行。
  - 新增 `core/vpnLauncher.js`：`ensureOn()` 经子进程调用上述脚本，永不抛异常；python 缺失/脚本不存在/点击失败/7890 仍不通一律降级为 `{ok:false}` 并 ALERT 提示手动开启，**不阻断**谷歌任务。
  - `scripts/worker.js`：谷歌阶段最开头插入「步骤1 · 开启VPN」——先发 `STEP(running)`，再 `vpnLauncher.ensureOn()`，成功发 `STEP(success)`、失败发 `STEP(failed)`+`ALERT`。
  - `public/js/progress.js`：`STEP_LABEL` 增 `vpn_on:'步骤1 · 开启VPN'`，进度页可见该步骤。
  - 测试：`test/phasedTask.test.js` 6 个用例均注入 `makeFakeVpnLauncher`；断言仅谷歌阶段调用一次、仅百度阶段不调用。全量 274 项（273 通过 / 1 skip）。

## [0.3.21] — 2026-07-24
- **feat(日志统计)：新增「任务时长」维度（对齐自动化「任务时长统计」诉求）**
  - `core/taskStats.js`：
    - `newRun` 增 `endedAt` / `durationMs`（阶段级，百度/谷歌各自一份）；新增 `fmtDur()` 毫秒→可读（`1.2 s` / `3m20s`）。
    - `recordWifi` 增 `startedAt` / `endedAt` / `durationMs`（节点级，每个 WiFi/VPN 节点本轮流程真实墙钟耗时）。
    - `summarize` 增 `totalDurationMs`（阶段总耗时）与 `avgNodeDurationMs`（单节点平均耗时）。
    - `renderMarkdown`：总体统计加「阶段总耗时 / 单节点平均耗时」两行；逐轮明细表新增「耗时」列；顶部补「结束时间 / 总耗时」。
    - `save` 落盘前补齐 `endedAt`/`durationMs`（worker 已打则沿用），滚动汇总 `task-completion-stats.json` 每条增 `endedAt`/`durationMs`。
  - `scripts/worker.js`：百度 WiFi 轮询、谷歌 VPN 节点轮询、legacy 分支——在每轮 `eng.run()` 前后打 `Date.now()` 时间戳，按节点写入 `durationMs`；阶段进入时覆写 `run.startedAt` 为阶段起点，`save` 前写入 `run.endedAt`（切失败/skipped 节点 `durationMs:0`）。
  - 测试：新增 `test/phasedTask.test.js#6` 验证节点 `durationMs≥0`+起止时间戳、阶段 `endedAt` 存在且谷歌晚于百度；全量 274 项（273 通过 / 1 skip）。

## [0.3.20] — 2026-07-24
- **feat(分阶段任务流)：百度、谷歌改为「独立阶段 + 独立统计」，谷歌按 VPN 节点轮询**
  - 用户设计：同时勾选百度+谷歌时，百度所有任务先跑完（pollWifi 则按 WiFi 切 N 次），先出【百度统计】；再开 VPN 跑谷歌，谷歌**只用本地网线、不切 WiFi**，按「可用 VPN 节点」轮询，跑完出【谷歌统计】。两份数据独立。
  - 实现：`scripts/worker.js` 按 `config.rounds.platform` 拆为百度/谷歌两阶段：
    - 百度阶段：沿用 WiFi 轮询（切 WiFi+停 5s，不碰 VPN），结束 `taskStats.save(run,'baidu')` + 推一条 `TASK_STATS`；
    - 谷歌阶段：先 `vpnController.getAvailableMainNodes()`（剔除超时/不可达），无可用节点→ALERT+跳过(skipped)；否则按 `available` 节点循环 `selectNode`+重拉带代理 Chrome 跑 google 轮次（每节点一次），结束 `save(run,'google')`+推 `TASK_STATS`。
  - `core/taskEngine.js`：`run(roundsOverride, {vpnPreset})` 支持按平台过滤轮次；新增 `vpnPreset`（worker 逐节点注入已选节点+代理），谷歌轮次直接走预设代理、跳过内部再探测；`_makeStats` 改用分阶段轮次数。
  - `core/taskStats.js`：`newRun` 记 `platform`；`save(run, fileSuffix)` 文件名加 `-baidu/-google` 避免两份统计互盖；`recordWifi` 支持 `via:'wifi'|'vpn'`；Markdown 按平台出标题/逐轮明细表头（WIFI / VPN 节点）；滚动汇总含 `platform`。
  - **修复 v0.3.18 潜藏 bug**：`core/progressEvent.js` 的 `makeProgress` 此前裁剪了自定义字段，导致 `VPN_INFO.vpn` 与 `TASK_STATS.statsDetail` 永远为空——前端 VPN 状态行与完成度总结明细卡死。本次补齐透传，VPN 状态行与总结卡片恢复渲染。
  - 向后兼容：无 `config.rounds` 时走 `runLegacy` 分支，行为与 v0.3.19 完全一致（11 个旧单测不受影响）。
  - 测试：新增 `test/phasedTask.test.js`（5 项，注入式 fake wifi/engine/vpn/stats），覆盖分阶段顺序、百度 WiFi/谷歌 VPN 节点轮询轴、仅百度/仅谷歌、无可用节点跳过、via 标注；全量 272/1skip 通过。

## [0.3.19] — 2026-07-24
- **fix(vpn)：修复谷歌任务「重拉带代理浏览器」崩溃导致整组谷歌失败并误触发熔断**
  - 根因：`taskEngine.run()` 创建 `BrowserSession` 后未将其挂到 `this.session`，`_relaunch()` 调 `this.session.launch()` 时 `this.session` 为 undefined → 抛 `Cannot read properties of undefined (reading 'launch')`。
  - 连带 bug：`_googleUnavailable` 标志在首轮探测失败后已置位，但后续谷歌轮次绕过探测、拿「无代理」浏览器直接开 google → `page.goto https://www.google.com/ Timeout 20000ms` 级联失败 → 失败率 40% > 30% 阈值 → 自动熔断。
  - 修复：① `run()` 内 `this.session = session`；② 谷歌分支开头增加 `if (this._googleUnavailable) return false` 守卫，VPN 不可用时整组谷歌轮次统一 SKIPPED（不计入失败率），杜绝级联误熔断。
  - 验证：VPN 节点探测本身正常（报错发生在重拉浏览器步骤，证明 `getAvailableMainNodes`/切节点已通）。

## [0.3.18] — 2026-07-24
- **feat(vpn)：谷歌任务自动开启 VPN 出口（多选平台流程打通）**
  - 前端放开「谷歌」多选（此前 `display:none` 隐藏）；同时勾选百度+谷歌时，沿用既有的百度→谷歌串行顺序——先跑完百度（本机真实 IP），再切到谷歌时自动开启 VPN。
  - 新增 `core/vpnController.js`：对接本地 Mihomo Party / Clash 控制 API（9090），任务前列举 VPN 主节点组、逐个测延迟、**剔除【超时】/不可达节点**、选延迟最低节点切过去，并返回给引擎本机代理地址（mihomo mixed 端口 7890）。
  - 安全：控制端口 `secret` **不写死在源码**（避免公开仓库泄露），优先读 `AUTOCLAW_VPN_SECRET`，缺失时回落读取 `%APPDATA%/mihomo-party/mihomo.yaml` 的 `secret` 字段；所有 HTTP 调用 try/catch，API 不可达时优雅返回空（谷歌轮次跳过而非崩溃）。
  - 引擎 `core/taskEngine.js`：切入谷歌前 `_ensurePlatformNetwork` 探测可用节点；无可用则 `ALERT` + 跳过谷歌轮次（`RoundStatus.SKIPPED`，不计入失败率）；有则选最优节点并重拉带代理的 Chrome 走 VPN。百度轮次始终不带代理。
  - 完成度汇总 `core/taskStats.js` 新增 VPN 维度（`recordVpn` + Markdown「VPN 出口」段落 + 滚动条目），`scripts/worker.js` 捕获 `VPN_INFO` 事件落盘；进度页 `progress.js` 渲染 VPN 状态行。
  - `EventType.VPN_INFO` / `ERR.ERR_VPN_UNAVAILABLE` 新增；新增 `test/vpnController.test.js`（6 项，注入假 transport，覆盖超时剔除/排序/切节点/API 不可达/yaml 解析 secret）。
  - 全量 268 项测试通过（0 失败 / 1 跳过）。

## [0.3.14] — 2026-07-23
- **fix(ui)：任务结束后展示「完成度总结」卡片**
  - 根因：`progress.js` 的 `renderEvent` 没有处理后端早已发出的 `task_stats` 事件（含汇总 + 逐 WIFI 明细），
    导致任务跑完前端看不到任何聚合总结，用户只能去翻 `data/task-stats-*.md` 文件。
  - 修复：进度页 `task_stats` 事件触发时渲染总结卡片——总数/完成/失败/跳过/完成率/总尝试/累计重试/整体结论，
    以及逐 WIFI 终态、尝试次数、重试次数、失败备注表格；并修正 `updateStats` 误把 WIFI 维度 summary 当逐步失败率。
  - progress.html 新增 `#task-summary` 容器，style.css 补充 `.summary-grid/.summary-cell/.summary-table/.hint.warn/.badge.skip` 样式。
- **fix(透明度)：WIFI 轮询启用消息诚实标注序列来源**
  - 原消息写死「仅遍历『已存』的 N 个 WIFI」，即使实际走兜底（未收到面板已存集合）也这么说，误导用户以为只轮询已存的。
  - 新消息区分两种来源：收到 `rememberedWifis` →「按面板『已存』集合的 N 个（已剔除不可见 M 个）遍历」；
    走兜底 →「按兜底：可见且本机已存凭证的 M 个（未收到面板已存集合，将轮询全部可见网络）遍历」。
- **fix(ui)：提交前提示轮询范围**
  - 轮询复选框勾选后，若面板「已存」WiFi 数为 0，提示「⚠️ 面板没有已存 WiFi 密码，将回退轮询全部可见网络」，提交前即可发现会走兜底。

---

## [0.3.17] — 2026-07-23
- **feat(google 适配器完善)：对齐百度适配器的成熟稳健度**
  - 旧版谷歌适配器是「裸实现」：直接 `fill` 搜索框 + `Enter` + 等 `#rso`，真实环境必踩三类坑且报错笼统。本版全部补齐：
  - **Google 同意页（consent.google.com）**：新 IP/区域首次访问会被重定向到「Before you continue」同意页（无搜索框无 #rso），旧版傻等超时。现 `open/search` 命中后自动点击「同意/Accept」并等待离开。
  - **异常流量验证码（google.com/sorry）**：谷歌对自动化极敏感，搜索后常跳「异常流量」拦截页。现命中进入轮询（上限 120s、间隔 2s），提示用户在可见 Chrome 窗口手动过码，过码后自动继续；轮询耗尽抛 `ERR_GOOGLE_CAPTCHA`。
  - **search 分步 + 明确中文错误 + evaluate 写值绕开可见性**：步骤A 等待搜索框 `attached`；步骤B 用 `page.evaluate` 对 `textarea[name="q"]` 赋原生 value 并派发 input/change（不依赖可见性）；步骤C 用 `page.evaluate` 触发 `form.requestSubmit()`（回退点击搜索按钮）；步骤D 轮询等待 `#rso`，期间识别同意页/验证码并据情处理。
  - **locateTarget 精准定位 + 复用基类双匹配 + 诊断**：改用 `#rso h3 a` 精准取每条结果的标题主链接（修复旧版遍历结果块内「全部 `<a>`」导致的 sitelink/页脚噪声误匹配）；解析 Google 跳转链接（`/url?q=`/相对路径）为真实落地地址；复用 `PlatformAdapter.matchTarget`（non-strict，启用 domain-only 兜底）；未命中时抛出明确中文诊断（域名未进排名 / 标题未中关键词）。
  - 新增 `test/googleAdapter.test.js`（16 项，镜像 `test/baiduAdapter.test.js` 的假 page 模式），覆盖同意页/验证码/稳健搜索/精准定位/诊断。全量 262/1skip 通过。

---

## [0.3.16] — 2026-07-23
- **fix(数据卫生，O1 回归根治)：单测不再污染生产 `data/`**
  - 根因：上版只清理了假文件，但 `test/wifiPoll.test.js` 多数用例未注入 `statsModule`，
    真实 `taskStats.save` 仍把 `t-*` 假任务写进 `data/task-stats-*.{json,md}` 与滚动汇总；一跑测试就复发。
  - 修复：测试文件顶部设置 `process.env.AUTOCLAW_STATS_DIR` 指向 `os.tmpdir()` 临时目录，
    所有未注入假模块的用例落盘到隔离目录，生产 `data/` 不再被污染。
- **fix(统计透明度，O2)：完成度摘要据实标注轮询来源**
  - 根因：`.md` 摘要「任务模式」写死「WIFI 轮询（遍历全部可用 WIFI）」，
    实际可能是「面板已存集合」或「兜底」，文字与真实序列来源不符。
  - 修复：`worker.js` 把 `wifiSource`（`remembered`/`fallback`）传给 `taskStats.newRun`，
    摘要据实显示「面板『已存』集合遍历」或「兜底：可见且本机已存凭证」。
- 单测 `test/wifiPoll.test.js` 11/11 通过；全量 245/1skip 通过。

---

## [0.3.15] — 2026-07-23
- **fix(进度透明度)：轮询任务不再误报「任务结束」**
  - 根因：`taskEngine.run()` 每跑完一个 WIFI 的完整流程就 emit 一次 `TASK_END`（"任务结束"）。
    轮询任务含多个 WIFI，进度页于是把一个任务渲染成 N 次「■ 任务结束」，看起来像任务中途断了 N 次。
  - 修复：`worker.js` 在轮询模式下把子流程的 `TASK_END` 改写为一条普通 `wifi_poll`「【WIFI 子流程结束】…」提示
    （保留 stats 供实时失败率），真正的终态框只由 worker 末尾的 `TASK_END` 渲染一次。
- **fix(统计准确性)：完成度总结记录真实跑过的关键词**
  - 根因：`taskConfig` 只产出 `keywords` 数组（如 万年移民/万年移民公司/万年移民中介），没有单数 `keyword`，
    而 `worker.js` 传给统计的是 `config.keyword`（undefined）→ 总结里「关键词」恒为"(未指定)"。
  - 修复：`worker.js` 同时透传 `keywords`；`taskStats.newRun/renderMarkdown` 改用关键词列表展示。
- **fix(重试间隔 env 失效)：`AUTOCLAW_WIFI_RETRY_GAP_MS` 现在真正生效**
  - 根因：生产默认 `retryWait` 是空函数，重试 0 间隔连发，env 设了不生效（注释却写"默认 2 秒"自相矛盾）。
  - 修复：默认 `retryWait` 改为 `sleep(ms)`，重试前按 `RETRY_GAP_MS`（默认 2000）停顿，env 可覆盖。
- **fix(数据卫生)：清理滚动汇总里的假任务**
  - `data/task-completion-stats.json` 混入了 99 条单测/e2e 假任务（`t-nonpoll`/`t-poll-0` 等），污染真实统计。
  - 已一次性剔除并删除对应 18 个 `task-stats-t-*.{json,md}` 假文件；后续 e2e 请用 `AUTOCLAW_STATS_DIR` 隔离写盘
    （`taskStats` 已支持该 env）。

---

## [0.3.13] — 2026-07-23
- **fix(wifi 轮询)：轮询序列改为「面板已存集合」驱动，严格只遍历用户记住密码的 WiFi**
  - 根因：上一版的 `getConnectableNetworks()` 取的是 Windows `netsh wlan show profiles` 全部配置文件
    （本机 14 个），与控制台 WiFi 面板的「🔑已存（localStorage）」不是同一数据源——面板只显示
    7 个（含当前 805_5G），但轮询却跑了 14 轮，其中 5 个早已搜不到、白白占轮、拉低完成率。
  - 修复：勾选轮询时，前端在提交时把面板「已存」集合（localStorage `autoclaw_wifi_pw_v1` 的 SSID 列表）
    作为 `rememberedWifis` 透传给后端；`scripts/worker.js` 优先用它构建序列，**与 Windows 全部历史
    配置文件解耦**。序列再与 `listNetworks()`（当前可见）取交集剔除不可见的，当前已连置顶。
    未传该集合（如直接调 API）时回退到「可见且本机已存凭证」的 WIFI（旧 `getConnectableNetworks`）。
  - 效果：轮询序列 = 面板「已存」且当前可见的 WiFi（实测即 7 个，而非 14），完成率回到 100%。
  - 前端增强：轮询复选框旁实时显示「将轮询『已存』的 N 个 WIFI」，提交前即可确认轮询范围。
- 单测 `test/wifiPoll.test.js` 扩至 11 例（新增 rememberedWifis 优先、当前置顶等 2 例）。

---

## [0.3.12] — 2026-07-22
- **feat(wifi 轮询)：单个 WIFI 流程失败重试，而非立即跳过**
  - 原行为：某 WIFI 的 engine.run 返回 FAILED 即标记该 WIFI 失败并跳过，整体标记 FAILED。
  - 新行为：某 WIFI 流程熔断后，在「该 WIFI 内」重跑，最多重试 `AUTOCLAW_WIFI_FLOW_RETRIES` 次
    （默认 3，即该 WIFI 最多跑 1+3=4 次）；全部尝试仍失败才标记该 WIFI 失败并跳过，继续下一个 WIFI。
  - 重试前短暂停顿 `AUTOCLAW_WIFI_RETRY_GAP_MS`（默认 2000ms），避免把瞬时故障放大。
  - 暂停/停止（PAUSED/STOPPED）受控中断不再重试，立即跳出。
- **feat(stats)：任务完成度统计与分析，持久化保存**
  - 新增 `core/taskStats.js`：汇总每个 WIFI/网络的流程尝试次数、重试次数、终态，计算完成率与累计重试。
  - 任务结束自动写盘：`data/task-stats-<taskId>.json`、`data/task-stats-<taskId>.md`（人类可读分析）、
    `data/task-completion-stats.json`（滚动汇总日志，保留最近 200 条）；数据目录可由 `AUTOCLAW_STATS_DIR` 覆盖。
  - worker 结束前推送一条 `TASK_STATS` 进度事件（含 summary + 明细），前端可实时展示。
  - progressEvent 新增 `EventType.TASK_STATS`。
- 验证：`test/wifiPoll.test.js` 扩至 9 例（覆盖重试成功/重试耗尽/统计汇总/非轮询统计），`node --test` 全过。

## [0.3.11] — 2026-07-22
- 新增「WIFI 轮询」任务模式：任务表单增加复选框「轮询切换 WIFI」。
- 勾选后：每跑完一轮完整流程自动切换下一个可用 WIFI（本机已存凭证、可无密码直连的网络），
  停留 5 秒后重跑，直到所有可用 WIFI 都跑过一遍才算任务完成。
- 不勾选（默认）：仅跑当前网络一次即完成（原有行为）。
- 后端：wifiManager 新增 listSavedProfiles / getConnectableNetworks / connectSaved；
  taskConfig 解析 pollWifi 字段；worker 实现轮询外层循环 + 暂停/停止中断 + WIFI_POLL 进度事件。
- 进度页新增「WIFI 轮询 i/n」状态条，实时显示当前第几个 / 共几个可用 WIFI。

## [0.3.10] — 2026-07-22
- **fix(web): 静态资源禁用缓存，根治「刷新还是老问题」**
  - 根因：`app.js` 用 `express.static` 提供前端文件且无 `Cache-Control` 头，`index.html` 里 `<script src="/js/wifi.js">` 也无版本号，浏览器缓存了旧 `wifi.js`，服务端虽已升到 v0.3.9，前端仍跑旧逻辑 → 表现为 WiFi 信息不更新。
  - `express.static` 增加 `setHeaders`：对 `public/` 下所有文件下发 `no-cache, no-store, must-revalidate`（含 `Pragma`/`Expires`），每次刷新都拉最新 JS/CSS。
  - 本地单用户工具性能无影响；今后改前端无需再依赖用户手动硬刷新。

---

## [0.3.9] — 2026-07-21
- **fix(wifi): 当前连接 IP 锁定 WLAN 网卡，切换 WiFi 后反映最新连接 IP**
  - 新增 `getWifiLocalIp(iface)`：优先取 WLAN 适配器自身 IP（未桥接），被桥接时取网桥 IP
  - 修复旧 `getLocalIp`/`parseLocalIp` 中文 netsh 输出正则不匹配（"接口 "网桥" 的配置"/"IP 地址:"）导致始终返回空、且会取到默认出口（网线）IP 的问题
  - `/api/wifi/info` 返回 `wifiIp` 字段（替代"机器默认出口 IP"）；前端显示「WiFi连接IP」+「外网IP」+ 地区
  - 重试成功判定改为 wifiIp && publicIp 都拿到，切 WiFi 后 WiFi 连接 IP 立即正确、公网 IP 稍后补齐

## [0.3.8] — 2026-07-21

**修复**：连上新 WiFi 后「当前连接」信息（外网 IP / 地区）不刷新。

### 修复（Fixes）
- **前端 `public/js/wifi.js` 的 `loadCurrentInfo` 改为带退避重试**
  - 现象：刚连上 WiFi 时系统外网还没通，`/api/wifi/info` 单次请求拿不到公网 IP/地区，前端只发一次、失败即静默放弃，面板停在只有 SSID、没有 IP/地区。
  - 新增 `fetchCurrentInfo(attempt)`：外网 IP 为空（或请求失败）时按 2.5s/3s 退避重试，最多 `INFO_MAX_RETRY=6` 次；重试期间显示「获取中…」，成功或耗尽后再给最终态（成功 / 获取失败原因）。
  - 抽离 `renderCurrentInfo(i, pending)` 统一渲染，区分「获取中 / 成功 / 失败」三态。
  - 连网成功后的 `loadList()` 仍会触发 `loadCurrentInfo()`，重试链自动兜住「刚连上还没就绪」的窗口。

### 验证
- `node --check public/js/wifi.js` 语法通过。
- 已重启 7789 实例；连网后观察面板应由「获取中…」自动变为外网 IP + 中文地区。

---

## [0.3.7] — 2026-07-21

**修复**：WiFi 当前连接「地区获取失败」+ 改为只显示外网 IP。

### 修复（Fixes）
- **公网 IP 归属地多服务商容错（根因：默认 ipapi.co 被 Cloudflare 拦截）**
  - 现象：线上 7789 实例 `/api/wifi/info` 返回 `geoError: "响应非 JSON：Unexpected token '<'..."`——`ipapi.co/json/` 返回的是 Cloudflare「Just a moment…」挑战页 HTML，JSON 解析失败。
  - `core/wifiManager.js` 的 `getPublicGeo` 重写为**多服务商容错链**：首选 `ipinfo.io`（结构化 JSON，免 token）→ 备用 `myip.ipip.net`（中文文本，国内可达性好）→ 再备 `ipapi.co`；逐一尝试，跳过「返回 HTML 挑战页 / 解析失败 / 不含 IP」的服务，取第一个有效 IP；全部失败时返回聚合错误（含每个服务的具体原因）。
  - 新增 `httpGetText`（返回 `{ ok, status, text, error }`），替代原 `httpGetJson`；并检测被拦截返回的 `<!DOCTYPE` / `<html` 页面自动跳过，不再误判「成功但空」。
  - 环境变量 `AUTOCLAW_GEO_API` 仍可覆盖首选（ipinfo.io）地址，不影响备用链。
- **前端只显示外网 IP**：`public/js/wifi.js` 的 `loadCurrentInfo` 去掉「本地 IP」展示，改为只显示**外网 IP**（标签 `外网IP：`），地区保留 `country/region/city` 顺序（如 `中国/广东/肇庆`）；外网 IP 或地区获取失败时给出明确原因。

### 验证
- 沙箱直测：`ipapi.co` 返回 Cloudflare 页；`ipinfo.io`、`myip.ipip.net` 均正常返回公网 IP 与中文归属地。
- 单元：`node --test test/*.test.js`（默认 mysql mock 路径）全绿。

---

## [0.3.6] — 2026-07-21

**优化**：WiFi 列表排序置顶 + 当前连接显示 IP 与归属地。

### 新增（Features）
- **排序置顶**：当前已连接的 WiFi，以及曾经连接成功并记住密码（localStorage）的 WiFi，自动排到列表最前，组内仍按信号降序；当前连接行高亮，并加 `● 当前` / `🔑 已存` 徽章。
- **当前连接信息**：新增 `GET /api/wifi/info` 返回当前 SSID、本地出口 IPv4、公网 IP 与归属地（城市/地区/国家/运营商）。
  - 本地 IP：`netsh interface ipv4 show addresses` 中取「有默认网关且 InterfaceMetric 最小」的接口（兼容 WLAN 被桥接、IP 落在网桥上的场景，本机实测返回 `192.168.1.187`）。
  - 公网 IP 归属地：内置 `https` 调 `https://ipapi.co/json/`，可用环境变量 `AUTOCLAW_GEO_API` 覆盖为其他服务；查不到时优雅降级（前端显示「地区：获取失败」），不阻塞列表。
- 前端 `loadList` 拉列表后异步调 `/api/wifi/info`，把「本地IP / 公网IP / 地区」补充进当前连接行。

### 测试
- 新增 `parseLocalIp` 单测（桥接场景取活跃出口 IP / 无网关返回空串）；全套 **235/234/1skip** 全绿。

---

## [0.3.5] — 2026-07-21

**优化**：WiFi 密码记忆（连接成功一次后免重复输入）。

### 新增（Features）
- 前端 `public/js/wifi.js`：连接成功后把正确密码按 SSID 存入 `localStorage`（键 `autoclaw_wifi_pw_v1`），之后该 SSID 的密码框自动预填；加「忘记」链接可单条清除。
- 仅连接成功（`code===0`）才保存；连接失败不落盘，避免记住错误密码。
- 配套样式：`public/css/style.css` 增加 `.link-btn.small` / `.link-btn.faint`（「忘记」链接弱化显示）。

### 说明
- 密码以**明文**存于浏览器 `localStorage`，仅本机浏览器可读；介意者可点行内「忘记」清除。Windows 自身也会在 `netsh wlan add profile` 时持久化配置文件（含密钥），因此重启后系统层本就会自动重连，此项优化针对的是控制台输入界面。

---

## [0.3.4] — 2026-07-21

**修复**：WiFi 列表解析错误 + 前端静默吞错导致「点击刷新没反应」。

### 修复（Fixes）
- **parseNetworks 重写**：原正则 `/\n\s*SSID\s+\d+\s*:\s*/` 会把 `BSSID` 行里的 "SSID" 误当分隔符，切出 "Network type : Infrastructure" 之类的垃圾条目（还顺带偷用下一个网络的认证类型）。改为逐行、锚定行首解析，`BSSID` 不再误匹配；多 BSSID 取最强信号，隐藏网络跳过。
- **前端 loadList 不再静默吞错**：后端返回错误（code≠0）时显示具体原因，而非静默渲染空列表；点击刷新按钮有「刷新中…」禁用态与成功清除错误提示；网络异常提示里加「请确认服务已用新版本重启」。

### 验证
- 本地 7799 端口起实例实测：`/api/wifi/list` 返回 `code=0`、当前连接、63 个网络、无垃圾条目、锁/开标记正确。
- 单测回归：新增 BSSID 误切断言，全套 233/232/1skip 全绿。

---

## [0.3.3] — 2026-07-21

**里程碑**：WiFi 切换功能（原独立脚本整合进控制台）。

### 新增（Features）
- **WiFi 切换面板**：在 autoclaw 控制台内新增「WiFi 切换」卡片，复用本机无线网卡。
  - 后端 `core/wifiManager.js`：封装 `netsh wlan`，兼容中英文输出（`chcp 65001` 解决中文 SSID/标签乱码）；安全类型归一化（WPA2 个人→`WPA2PSK/AES`、WPA3→`WPA3SAE/AES`、WPA 个人→`WPAPSK`、开放→`open/none`，企业 802.1X 识别为不支持）；生成带 UTF-8 BOM 的 WLAN 配置 XML（对 SSID/密码做 XML 转义）；连接后轮询确认。
  - 路由 `routes/wifiRoutes.js`：`GET /api/wifi/list`（列可见网络+当前连接，只读）、`POST /api/wifi/connect`（`{ ssid, password }` 切换，secured 网络需密码），均经 `taskTokenAuth` 保护，沿用 `code/data/message` 信封。
  - 前端 `public/index.html` 新增卡片 + `public/js/wifi.js` 交互（拉列表 / 输密码 / 点击连接，复用 localStorage 令牌），`public/css/style.css` 补充 `.wifi-row` 样式。
  - 设计定位：作为手动切换出口 IP 的辅助手段（与 proxy 互补），不做任务级自动切网/回切。

### 测试（Tests）
- 新增 `test/wifiManager.test.js`（11 条）：覆盖中英文 `parseNetworks`、同名 SSID 去重、`normalizeSecurity` 各类型映射、`buildProfileXml` 合法片段与 XML 转义。全套 **233 用例 / 232 通过 / 1 skip** 全绿。



**里程碑**：proxy 代理入口端到端打通 + 运行日志两项优化（基于实跑日志分析）。

### 新增（Features）
- **代理（proxy）端到端可用（F-18 入口落地）**
  - `core/taskConfig.js` 新增 `sanitizeProxy`：兼容多种写法——字符串 URL（`'http://1.2.3.4:8080'`）、`{ server }`、`{ httpProxy }`、`{ proxy }`，统一归一化为 `{ httpProxy }`，并校验必须为 `http(s)://` 或 `socks(5)://`，非法格式抛 `ERR_INVALID_CONFIG`。空值（null/''/`{}`）视为不走代理。
  - 前端 `index.html` 增加「代理地址（可选）」输入框；`public/js/config.js` 提交时收集 `proxy` 字段、历史回填时还原。
  - 底层注入（`browserSession.launch` → Playwright `contextOptions.proxy = { server }`）此前已就绪，本次补齐归一化与前端入口后，从界面填代理即可真正走代理，实现多 IP 分散搜索风控。

### 修复（Fixes）
- **轮间停顿可调参**：`core/taskEngine.js` 的轮间 8–20s 随机停顿改为读 `AUTOCLAW_INTER_ROUND_MIN / AUTOCLAW_INTER_ROUND_MAX` 环境变量（默认不变），与项目其他拟人/策略参数风格一致。
- **运行日志 error 列误填**：`config/db.js` 的 `flattenEvent` 原先会把普通成功事件的 `message`（如 task_end「任务结束」）写入 `error` 列，导致 `WHERE error IS NOT NULL` 误判成功任务为失败。改为仅在事件显式携带 `error` 字段时才填充；`scripts/worker.js` 的 worker 异常事件补充 `error` 字段，保证异常仍能进 error 列。

### 测试
- `test/errorCode.test.js` 新增 2 条断言（成功 task_end 的 error 列必须为 null；worker 异常事件 error 列正确填充）。
- `test/taskConfig.test.js` 新增 7 条 proxy 归一化断言（字符串 / server / httpProxy / 空值 / 非法格式）。
- 全套：`node --test test/*.test.js` = **222 用例 / 221 通过 / 1 skip**。

---

## [0.3.1] — 2026-07-20

**里程碑**：实测基线发布——将 v0.3.0 之后的「默认搜索关键词」修正固化为正式版本，并记录最近一次实跑验证（任务 `a78e2545...`，百度 3 轮，145s，0 报错）。

### 修复（Fixes）
- **默认搜索关键词修正**：`core/taskConfig.js` 的默认关键词由旧值改为 `万年移民|万年移民公司|万年移民中介`（对应 `config/site.config.js` 的 `AUTOCLAW_TITLE_KEYWORDS` 默认值同步）。

### 验证
- **实跑验证**：任务 `a78e2545-d57a-4e74-9c01-21fa10039875`，百度 3 轮（r0/3 ~ r2/3）全部 success，总时长 145s，运行日志 `err=0`、无重试。
- **单元测试**：`node --test test/*.test.js` = **213 用例 / 212 通过 / 1 skip**（默认 mysql mock 路径；skip 为真实浏览器 e2e，需 `AUTOCLAW_REAL_BROWSER=1`）。
- **注**：运行日志分析显示 ~90% 耗时在防风控拟人/停留上，仅 ~10% 为真实导航；已识别 2 个 P1 优化项（轮间停顿硬编码、task_end 的 error 列误填），见后续版本。

---

## [0.3.0] — 2026-07-18

**里程碑**：流程拟人化增强——每个关键步骤之间插入「随机思考停顿 + 随机微动作」，降低被搜索引擎风控的概率。

### 新增（Features）
- **拟人微动作（humanize）**：在 search → locate → enter → stay → browse → close 各步骤之间，插入一次随机拟人微动作：
  - 随机思考停顿：`randInt(minMs, maxMs) + randInt(0, jitterAmp)`，每次随机、不可预测。
  - 三类微动作按权重随机触发（移动鼠标 / 滚轮轻推 / 悬停或按键），全部静默容错，绝不抛出、不影响主流程。
  - 进度看板新增 `human` 步骤（标签「拟人」），可见拟人节奏。
- **配置透传**：`core/taskConfig.js` 解析并浅合并 `payload.humanize`（enabled / minMs / maxMs / jitterAmp / moveProb / scrollProb / hoverProb / wheelAmp），默认值来自 `config/defaults.js` 的 `DEFAULT_HUMANIZE`（支持 `AUTOCLAW_HUMANIZE_*` 环境变量覆盖）。
- **前端**：`index.html` 增加「拟人微动作（步骤间）」配置块（启用开关 + 最短/最长停顿 ms）；`public/js/config.js` 读取并提交、历史回填。

### 测试
- 新增 `test/humanizer.test.js`（10 用例）：覆盖随机间隔边界、三类微动作分支、页面关闭/方法抛错的静默容错、enabled=false 早退、taskConfig 透传。
- 修复：`_humanInterstitial` 的停顿改为可覆盖的 `this._sleep()`（测试即时化），避免大量随机用例拖慢整文件。

### 验证
- `node --test test/*.test.js` = **213 用例 / 212 通过 / 1 skip**（skip 为真实浏览器 e2e，需 `AUTOCLAW_REAL_BROWSER=1`）。

---

## [0.2.0] — 2026-07-18

**里程碑**：客户线（P0-8~P0-11）完整落地 + BROWSE 站内锚点相对路径修复（端到端验证通过）。

### 新增（Features）
- **客户线（P0-8~P0-11）**
  - 数据层：`client` 表 + `task_config.client_id` 列（sqlite / mysql 双后端，含幂等迁移）。
  - 路由：`routes/clientRoutes.js` 挂载 `/api/client`，含 list / create / get / update / delete / stats / report（report 支持 markdown / csv / html 三种导出），复用 `x-autoclaw-token` 鉴权。
  - 配置层：`core/taskConfig.js` 透传 `clientId` / `client_id`，任务归属客户。
  - 前端：`index.html` 增加「归属客户」下拉 + 「客户管理」面板；`public/js/config.js` 拉取客户列表、提交携带 clientId、增删客户。
  - 错误码：新增 `ERR_CLIENT_NOT_FOUND`、`ERR_CLIENT_HAS_TASKS`（删除有关联任务的客户时拒删 → 409）。
- **测试**：新增 `test/clientRoutes.test.js`、`test/clientData.test.js`、`test/browseRelativeLink.test.js`。

### 修复（Fixes）
- **BROWSE 站内锚点相对路径解析（T-6）**
  - 根因：导航栏链接为相对路径（如 `href="about.html"`），原 `_findContactLink` 只处理 `/` 绝对路径与完整 `http(s)://` URL，相对路径被忽略 → 返回 `null` → BROWSE 软失败（日志显示「候选链接：关于万年」却找不到）。
  - 修复：`core/taskEngine.js` 改用 `new URL(href, base.href)` 统一解析 `/about.html`、相对路径、完整 URL；过滤 `#` / `javascript:` / `mailto:` / `tel:` / `data:` 伪链接；`_collectLinkDiag` 同时输出链接文本与解析后的 URL，便于排查。

### 验证
- **端到端实测**：任务 `8843780e-1b88-4806-be63-70565a7507c3`，关键词 `[万年移民, 万年移民公司, 万年移民中介]` 打 `manincorp.cn`，3 轮 `search→locate→enter→stay→browse→close` **全部 success**，browse 修复确认生效。
- **单元测试**：`node --test test/*.test.js` = **203 用例 / 202 通过 / 1 skip**（skip 为真实浏览器 e2e，需 `AUTOCLAW_REAL_BROWSER=1`）。

### 文档
- `docs/prd-autoclaw-handoff.md`：§4.3 目录树补 `routes/clientRoutes.js`；§4.6 API 表补 `/api/client/*`；§7.2 新增 T-6；§10 第 10 条修正说明；§6 / §8 / §9 同步版本与测试计数。

---

## [0.1.0] — 2026-07-18（基线）

- 初始交付：Express + socket.io + Playwright 复用本机 Chrome 的 SEO 浏览器自动化控制台。
- 平台适配器：Baidu（已实现）、Google（代码就位，需 VPN 实测）。
- 任务引擎：search / locate / enter / stay / browse / close 六步流水线，串行/并行模式，熔断与重试。
- 持久化：MySQL / SQLite 双后端，任务配置 + 运行日志落库，实时进度看板。
- 单元测试：155 基线用例（接手时），后续随修复增长。
