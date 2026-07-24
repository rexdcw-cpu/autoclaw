# Autoclaw 任务日志审查 + BUG 修复（2026-07-23）

## 一、最新任务执行情况（taskId = d59e9c71-8998-4ff8-93bf-c02bbd20ce1c）

| 项 | 结果 |
| --- | --- |
| 是否执行完 | ✅ 已结束 |
| 模式 | WIFI 轮询（面板「已存」集合驱动） |
| 轮询序列 | **面板『已存』集合遍历 5 个 WIFI（共 5 个已存）**：ROSNET7 → HUAWEI-805 → ROSNET9 → ROSNET6 → 805_5G |
| 每 WIFI 流程 | 3 轮关键词（万年移民 / 万年移民公司 / 万年移民中介），每步 search→human→locate→enter→stay→browse→close 全部 `success` |
| 完成 | 5/5，完成率 **100%**，0 失败、0 重试 |
| 耗时 | 04:17:12 → 04:31:32（约 14 分钟） |

**关键结论**：之前"走兜底 9/14 轮"的 BUG 已根治——这次正确使用了面板已存集合（5 个），没有再把搜不到的旧网络拉进来空跑。

## 二、发现并修复的问题

### ✅ B1（进度透明度）轮询任务误报多次"任务结束"
- **现象**：轮询任务里 `task_end` "任务结束"出现了 5 次（每个 WIFI 子流程一次），看起来像任务中途断了 5 次。
- **根因**：`taskEngine.run()` 每跑完一个 WIFI 的完整流程就 emit 一次 `TASK_END`；轮询模式下被原样渲染成终态框。
- **修复**：`scripts/worker.js` 在轮询模式下把子流程的 `TASK_END` 改写为一条普通 `wifi_poll`「【WIFI 子流程结束】…」提示（保留 stats 供实时失败率），真正的终态框只由 worker 末尾的 `TASK_END` 渲染一次。

### ✅ B2（统计准确性）完成度总结的关键词恒为"(未指定)"
- **现象**：总结里"关键词"永远是"(未指定)"，丢了真实跑过的词。
- **根因**：`taskConfig` 只产出 `keywords` 数组，没有单数 `keyword`；worker 传的是 `config.keyword`（undefined）。
- **修复**：worker 同时透传 `keywords`；`core/taskStats.js` 的 `newRun`/`renderMarkdown` 改用关键词列表展示（如"万年移民、万年移民公司、万年移民中介"）。

### ✅ B4（重试间隔 env 失效）`AUTOCLAW_WIFI_RETRY_GAP_MS` 设了不生效
- **现象**：生产环境重试 0 间隔连发；代码注释却写"默认 2 秒"，自相矛盾。
- **根因**：默认 `retryWait` 是空函数，env 只在测试注入 retrySleep 时才有用。
- **修复**：默认 `retryWait` 改为 `sleep(ms)`，重试前按 `RETRY_GAP_MS`（默认 2000）停顿，env 现在真正生效。

### ✅ O1（数据卫生）滚动汇总混入假任务
- **现象**：`data/task-completion-stats.json` 混了 99 条单测/e2e 假任务（`t-nonpoll`/`t-poll-0` 等），污染真实统计。
- **修复**：一次性剔除并删除对应 18 个 `task-stats-t-*.{json,md}` 假文件；后续 e2e 请用 `AUTOCLAW_STATS_DIR` 隔离写盘（`taskStats` 已支持该 env）。清理后滚动汇总只剩 3 条真实任务。

## 三、未改（观察项，当前无害）
- 每个 WIFI 切换后固定停留 5 秒（`wait(5000)`）。对稳定网络略浪费，但属保守稳妥，暂不改；如需可加 `AUTOCLAW_WIFI_DWELL_MS` 配置。
- 非轮询单网络模式：引擎的 `TASK_END` 仍正确渲染一次终态框（B1 改写仅作用于轮询模式）。

## 四、验证
- 版本升至 **v0.3.15**，重启 7788 实例（`/api/status` 确认）。
- 单测 `test/wifiPoll.test.js` → **11/11 通过**。
- 滚动汇总已清理（3 条真实任务：7aa942c8 / 5325aea1 / d59e9c71）。

> 注：本机 7788 实例跑在沙箱会话；WiFi 切换(netsh)正常，但跑**真实 SEO 任务**若需带窗 Chrome 弹不出，需在桌面会话用相同命令重启。
