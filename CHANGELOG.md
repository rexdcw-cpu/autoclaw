# Changelog

本文件记录 autoclaw 每个发布版本的变更。版本号遵循语义化版本（SemVer）。

---

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
