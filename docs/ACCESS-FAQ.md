# autoclaw 访问与排错 FAQ（Windows 原生版）

> 适用场景：用户访问 `http://test.autoclaw.com/` 报
> `browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1228/...`

---

## 1. 一句话结论

**报错来自「仍然跑在 WSL 里的旧 autoclaw 服务」，不是新的 Windows 原生服务。**
你访问的是 `http://test.autoclaw.com/`（没带 `:7788`，默认走 **80 端口**），这个 80 端口被
`wslrelay.exe` 转发进了 WSL，命中了 WSL 里没杀干净的旧服务，它去 `/root/.cache/...`（Linux 路径）
找 Playwright 浏览器，但那个浏览器在 WSL 里没装，于是报同样的错。

**新的 Windows 原生服务本身是正常的**，它监听 **7788** 且用本机 Chrome（路径在 Windows 上）。
请直接访问带端口的地址：

```
http://test.autoclaw.com:7788/
http://test.openclaw.com:7788/
http://127.0.0.1:7788/
http://localhost:7788/
```

---

## 2. 为什么「确认 Chrome / start-win.bat」没用？

| 你做的步骤 | 实际作用 | 为什么没解决 |
|---|---|---|
| kill-old-service.bat | 只杀 **Windows** 上占用 **3000** 端口的旧 node | 真正的旧服务在 **WSL** 里（WSL 进程 Windows 的 .bat 杀不到）；而且该 .bat 需管理员才能 `taskkill` 成功 |
| 确认 Chrome | 新服务确实用本机 Chrome | 报错根本不走新服务，而是走 WSL 旧服务的 Playwright headless shell |
| start-win.bat | 启动新 Windows 服务到 **7788** | 新服务正常，但你不带端口访问 80，依旧命中 WSL 旧服务 |

---

## 3. 现场实况（排查时抓取）

- hosts：`test.autoclaw.com` / `test.openclaw.com` **已正确指向 `127.0.0.1`** ✅（无需改）
- 新 Windows 服务：`node.exe` **PID 9172**，监听 `0.0.0.0:7788` + `[::]:7788`，`/api/status` 返回正常 JSON ✅
- 旧 Windows 服务：`node.exe` **PID 42744**，监听 `0.0.0.0:3000`（kill-old-service.bat 没杀掉，需管理员）
- `wslrelay.exe` **PID 47048**，监听 `127.0.0.1:80` + `[::1]:7788`（把 Windows 的 80 转发进 WSL）
- WSL（Ubuntu，Running）内：**`node app.js` PID 45424 仍在跑**，监听 WSL 的 `0.0.0.0:80` 与 `*:7788`
  —— 这就是 `/root/.cache/...` 报错的源头

请求流向（你现在的访问方式，错误路径）：
```
浏览器 http://test.autoclaw.com/
  -> hosts -> 127.0.0.1
  -> Windows 端口 80 (wslrelay.exe, PID 47048)
  -> 转发进 WSL
  -> WSL 旧 node app.js (PID 45424) 监听 WSL:80
  -> 提交任务时 Playwright 启动 /root/.cache/... 浏览器
  -> 浏览器不存在 -> 报错 ✗
```

正确路径（带端口）：
```
浏览器 http://test.autoclaw.com:7788/
  -> hosts -> 127.0.0.1:7788
  -> Windows 新服务 node (PID 9172, 0.0.0.0:7788)
  -> 用本机 Chrome 启动可见窗口 -> 正常 ✓
```

---

## 4. 修复步骤（按顺序）

### 步骤 A：彻底清理旧服务（关键）
以**管理员身份**运行：
```
scripts/kill-old-service.bat
```
它会：
1. 杀 Windows 上占用 3000 的旧 node（PID 42744）
2. 杀 WSL 内仍在跑的旧 autoclaw（`pkill -f 'node app.js'`）
3. 复查端口 80，并提示下一步

> 这一步是「之前没生效」的真正补丁：旧服务在 WSL，必须在 WSL 里杀。

### 步骤 B：确认 Chrome 已安装
新服务用本机 Chrome（`channel: 'chrome'`）。没装就去装 Chrome。

### 步骤 C：启动新服务
```
start-win.bat
```
启动后访问 **带端口** 的地址：
```
http://test.autoclaw.com:7788/
```

### 步骤 D（可选）：让裸域名也能用
若你/用户总忘记加 `:7788`，以**管理员身份**运行：
```
scripts/enable-port80.bat
```
它会设置 Windows 端口转发 `127.0.0.1:80 -> 127.0.0.1:7788`，之后
`http://test.autoclaw.com/`（不带端口）即可直达新服务。
撤销命令：
```
netsh interface portproxy delete v4tov4 listenport=80 listenaddress=127.0.0.1
```

---

## 5. 是否需要把新服务改成监听 80？

**不建议直接改 `app.js` 监听 80。** 原因：
- 端口 80 当前被 `wslrelay.exe` 占用，新服务直接绑 80 会 `EADDRINUSE`；
- 绑 80 需要管理员常驻，且和 WSL 转发互相打架；
- 用 `netsh portproxy`（步骤 D）做 80->7788 转发更干净、可随时撤销、不动源码。

保持新服务监听 **7788**，引导用户加端口，或用步骤 D 的转发兜底，是最稳的方案。

---

## 6. 给技术支持的诊断脚本

若上述仍无法解决，运行（无需管理员）：
```
scripts/diagnose.bat
```
把它的**完整输出**复制粘贴发回，即可定位剩余问题（如仍有其他反向代理、WSL 进程未清、DNS 未刷新等）。

---

## 7. 关键文件清单

| 文件 | 作用 |
|---|---|
| `scripts/kill-old-service.bat` | 彻底清理（Windows 3000 + WSL 旧服务） |
| `scripts/enable-port80.bat` | 可选：启用 80->7788 转发，裸域名可用 |
| `scripts/diagnose.bat` | 只读诊断，输出供排错 |
| `start-win.bat` | 启动新 Windows 原生服务（7788） |
| `scripts/update-hosts.bat` | 写入 hosts 解析（需管理员） |

> 核心代码（`app.js` / `core/*`）无需改动；本次问题与代码无关，是环境里旧服务/WSL 转发未清理。
