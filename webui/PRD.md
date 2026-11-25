# Pi Web UI 需求文档（PRD）

版本：v0.2（草案，关键决策已确认，见第 9 节）
日期：2026-11-24
状态：待评审

## 1. 背景

pi 目前的交互界面只有终端 TUI。`pi --mode rpc` 提供了完整的 JSONL 双向协议（命令 + 流式事件），官方文档明确其适用场景包括"custom user interfaces"。本文档定义一个基于该协议的本地 Web 界面，作为 TUI 之外的补充形态。

## 2. 目标

- 在浏览器中完成 TUI 的核心工作流：对话、查看工具执行、切换模型、管理会话。
- 复用 pi 的 RPC 协议，不 fork、不修改 pi 本体；pi 升级后协议变更通过文档对齐。
- 部署形态：单用户、本机使用，桥接服务只绑定 127.0.0.1。

### 非目标

- 不做多用户、多租户、远程公网暴露（不替代 p2/p3 的方向）。
- 不做多会话同屏编排界面（浏览器一次只看/只操作一个会话，其余会话的运行时在后台继续跑）。
- 不做移动端原生 App；仅保证桌面浏览器可用，移动端"可看不保证可用"。

## 3. 总体架构

```
浏览器 (SPA)  <--WebSocket(JSONL 透传)-->  bridge (Node 进程)  <--stdin/stdout JSONL-->  pi --mode rpc   (每会话一个)
        ^--- 静态资源由 bridge 提供 (http://127.0.0.1:端口)
```

- **bridge**：一个薄 Node 服务。职责：spawn/管理 pi 子进程、把 stdin/stdout JSONL 与 WebSocket 双向透传、提供静态文件、报告 pi 进程退出/崩溃并支持重启。
- **每会话一个 pi 运行时**：pi 的 `switch_session`/`new_session` 会先 `session.abort()` 再替换会话（`agent-session-runtime.ts` 的 `teardownCurrent`），所以用单个 pi 进程无法做到"切走不停"。bridge 因此按会话维护运行时表：`bridge_attach` 接上某个会话的运行时（没有就用 `pi --session <path>` 新起一个并接上），`bridge_new_session` 直接起新运行时；浏览器一次只接一个运行时（沿用单活动标签页决策），后台运行时的 stdout 照常消费（背压要求），切回来用 `get_state`/`get_messages` 重建现场，再用 `bridge_resume` 重放当前这一条正在流式输出的消息（`get_messages` 里没有未完成消息，否则刷新/切回会丢掉已经打出来的半截回答）。非当前且空闲 10 分钟的运行时会被停掉，正在跑的永不回收。
- **透传原则**：bridge 不解析、不改写协议记录（除进程生命周期消息与 `bridge_*` 命令外），前端直接按 `docs/rpc.md` / `docs/json.md` / `rpc-commands.md` 的记录格式处理。协议文档即前端实现文档。bridge 只旁路观察少量记录：`agent_start`/`agent_settled` 判断该运行时是否在跑，`get_state` 学会话文件路径，正在流式输出的那条 assistant 消息的原始记录被原样缓存，供 `bridge_resume` 重放。
- **协议回退**：bridge 启动 pi 前记录其版本（`pi --version`）；若前端能力集与协议不匹配，提示而不是静默失败。

### 端口与启动

- bridge 默认监听 `127.0.0.1:5173`，`--port` 可覆盖；端口被占用时启动失败并提示，不自动换端口。
- `npm run dev`：同时启动 bridge 与 Vite dev server（Vite 将 WS 与 API 代理到 bridge，浏览器单端口访问）。
- 生产：`npm run build` 后 bridge 直接服务 `dist/` 静态产物，同一端口。

### 布局

- 左栏：会话列表与状态（P1，M1 用顶部下拉代替）。
- 中间：消息流（唯一核心区域）。
- 右侧/底部抽屉：模型与设置、Bash 面板、会话树。

## 4. 功能需求

### P0 —— 对话核心（对应里程碑 M1）

| 编号 | 需求 | 说明 |
|---|---|---|
| F-01 | 连接与会话恢复 | 页面打开后 bridge 已运行的 pi 会话自动接入：`get_state` + `get_messages` 重建完整消息流；页面刷新不丢内容 |
| F-02 | 发送 prompt | 输入框发送，`prompt` 命令；空闲时直接发送 |
| F-03 | 流式渲染 assistant 回复 | 按 `message_update` 的 `text_delta` 增量拼接，`text_end`/`message_end` 到达后用权威内容整体替换 |
| F-04 | 中止 | 发送中显示"停止"按钮，映射 `abort`；`agent_settled(aborted=true)` 后恢复输入 |
| F-05 | 运行状态指示 | `agent_start`→`agent_settled` 之间显示运行中；注意 `agent_end` 不等于完成（可能重试/压缩中），完成判定用 `agent_settled` |
| F-06 | 模型显示与切换 | `get_state` 显示当前模型；`get_available_models` 列表选择，`set_model` 切换 |
| F-07 | 推理档位 | `get_available_thinking_levels` + `set_thinking_level` |
| F-08 | prompt disposition 处理 | `prompt` 响应 `data.disposition`：`started`/`queued`/`handled` 分别给出"开始运行/已排队/由扩展命令处理"的用户反馈；流式中发送必须显式携带 `streamingBehavior` |

### P1 —— 工具可视化与输入增强（M2）

| 编号 | 需求 | 说明 |
|---|---|---|
| F-10 | Markdown 渲染 | assistant 文本按 Markdown 渲染，代码块语法高亮 |
| F-11 | Thinking 折叠块 | thinking 内容默认折叠、单行摘要，可展开 |
| F-12 | 工具调用卡片 | `tool_execution_start/update/end` 按 `toolCallId` 关联生命周期；进行中显示 spinner，结束显示耗时与是否出错 |
| F-13 | Bash 卡片实时输出 | `bash` 工具的 `partialResult` 持续追加显示，类似终端；`tool_execution_update` 到达即刷新 |
| F-14 | 文件编辑 diff | `edit`/`write` 工具结果展示为 diff 视图（增删行着色）；`read` 显示文件路径与摘要 |
| F-15 | 图片附件 | 输入框支持粘贴/选择图片，转 base64 走 `prompt.images`；发送前显示缩略图，可移除 |
| F-16 | 队列与插话 | 运行中输入框仍可用：提供"插话(steer)/排队(followUp)"两种投递（`streamingBehavior`）；队列内容可见，支持 `clear_queue` |
| F-17 | Token 与费用 | 每条 assistant 消息显示 usage（输入/输出/缓存 tokens、cost）；会话累计 `get_session_stats` |
| F-18 | 自动滚动 | 流式输出时跟随滚动；用户上滚即暂停跟随，出现"回到底部"按钮 |

### P2 —— 会话管理与扩展集成（M3）

| 编号 | 需求 | 说明 |
|---|---|---|
| F-20 | 会话列表/切换 | 最近会话列表（bridge 读 `--session-dir` 的会话文件）；切换走 `bridge_attach`、新建走 `bridge_new_session`（每个会话一个 pi 运行时，见第 3 节；不再用会中止当场运行的 `switch_session`/`new_session`） |
| F-21 | 会话树与 fork | `get_tree` 渲染分支树；`fork`、`clone` 操作；`get_fork_messages` 预览 |
| F-22 | 会话操作 | `set_session_name`、`get_session_stats`、`export_html`（导出后在浏览器新标签打开） |
| F-23 | Slash 命令面板 | `get_commands` 拉取可用命令（含扩展命令），输入 `/` 弹出补全；执行即发送对应 prompt |
| F-24 | 扩展 UI 事件映射 | 按 `rpc-extension-ui.md`：`select`→下拉、`confirm`→确认框、`input`→文本框、`editor`→多行编辑器、`notify`→toast；响应/取消按协议回写；不支持的部分明确降级并显示原文 |
| F-25 | 扩展状态区 | `setStatus`/`setWidget`/`setTitle` 映射到状态栏/页签标题 |
| F-26 | Bash 面板 | 独立于对话的命令面板，走 `bash`/`abort_bash` 命令，输出实时滚动 |
| F-27 | 压缩与重试控制 | `compact` 按钮、`set_auto_compaction`、`set_auto_retry`/`abort_retry`；压缩/重试事件期间状态栏明确提示 |
| F-28 | 队列模式设置 | `set_steering_mode`/`set_follow_up_mode` |
| F-29 | Git 全屏视图 | 顶栏入口 + 全屏视图（Esc 退出，与 Bash 面板互斥）：分支/上游/ahead-behind、暂存/未暂存/未跟踪三组改动与逐文件 diff（文件级与 hunk 级 stage/unstage/discard）、提交（含 amend）、历史（分支/标签/全部分支筛选 + 标题/作者/sha 搜索 + 泳道图 + 分支/远程/标签徽标 + 提交详情：父提交、文件 numstat、单文件补丁，滚到底自动加载）、`fetch --prune` / `pull --ff-only` / `push`（无上游或游离 HEAD 时置灰并给出 `git push -u` 命令，推送先确认）；全部经 `POST /api/git`（argv 直调 git，不带 shell，路径/SHA 在 bridge 侧校验），改动通知走 `GET /api/git/events`（SSE） |
| F-30 | AI 提交说明 | 提交框右上角「AI 生成」：把已暂存 diff（没有暂存时用全部改动，每文件截断 200 行）交给 `pi --mode text` 一次性生成 Conventional Commits 说明，30 秒超时；输入框已有文字时先确认再覆盖，失败只进顶部提示条 |
| F-31 | Git 分支与高级操作（未实现） | 分支列表/切换/新建、stash、merge/rebase/cherry-pick/revert/reset、tag、进行中操作提示与逐行冲突解决面板 |

### P3 —— 打磨（M4）

- 亮/暗主题（默认跟随系统）。
- 快捷键：Enter 发送、Shift+Enter 换行、Esc 中止，可配置。
- 连接断开自动重连 + pi 进程崩溃自动重启（可配置开关），期间 UI 明确提示。
- 可选访问 token（缓解本机多用户场景，默认关闭）。

## 5. 非功能需求

| 类别 | 要求 |
|---|---|
| 安全 | bridge 只监听 127.0.0.1；无认证不提供远程访问；pi 以用户当前权限运行（pi 本身无权限系统，见 `containerization.md`） |
| 背压 | bridge 必须持续读取 pi stdout（协议规定：不读会卡死 pi 进程）；WS 慢消费者时缓冲策略：丢弃 UI 增量可以，丢弃 `message_end`/`tool_execution_end` 不行 |
| 协议正确性 | JSONL 按 LF 分帧、容忍 CRLF；禁用 Node `readline`（其会按 U+2028/U+2029 错误分帧）；命令用唯一 id 关联响应 |
| 平台 | Windows（含路径显示）、macOS、Linux；Windows 上子进程树终止用可靠方式（taskkill /T） |
| 性能 | 长会话（数千条消息）不卡 UI：消息流虚拟滚动或分区懒渲染；单次流式更新不做全量重渲染 |
| 复杂度 | bridge 不依赖框架（Node 内置 http + `ws` 即可）；前端构建产物静态化，`npm run build` 一次生成 |

## 6. 技术选型（建议）

| 层 | 选择 | 理由 |
|---|---|---|
| bridge | Node.js ESM + `ws`，无其他运行时依赖 | 职责单一；与 pi 同为 Node，开发体验一致 |
| 前端 | TypeScript + Vite + Preact（已确认） | 体积小、无 runtime 警告 |
| Markdown/高亮 | `marked` + `highlight.js`（pi 已依赖 hljs，风格统一） | 成熟稳定 |
| Diff | `diff` 包（pi 已依赖） | diff 渲染直接复用 |
| 样式 | 手写 CSS（CSS 变量做主题） | 不引 CSS 框架，控制体积 |

## 7. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M1 对话骨架 | bridge + WS 透传、会话恢复、流式对话、中止、模型/推理档切换、disposition 反馈 | 刷新页面不丢消息；发送→流式→完成全程无假死；abort 生效 |
| M2 工具可视化 | Markdown/thinking/工具卡片/bash 实时输出/diff/图片/队列/usage | bash 长输出实时刷新；edit 显示正确 diff；费用数字与 TUI 一致 |
| M3 会话与扩展 | 会话列表/切换/fork/树、slash 命令、扩展 UI 映射、Bash 面板、压缩/重试 | 含 select/confirm 的扩展在网页可正常交互完成 |
| M4 打磨 | 主题、快捷键、重连/重启、可选 token | 断网重连后自动恢复现场；崩溃自动重启 |

每个里程碑结束：`cd webui && npm run check` 通过（tsc；webui 独立目录，根 check 不覆盖）。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| delta-only 流重建逻辑易错（`contentIndex` 定位、权威覆盖） | 严格按 `json.md` 的"Reconstruct streaming messages"实现，`message_end` 整体替换兜底 |
| `agent_end` ≠ 完成，误判导致 UI 状态错 | 只用 `agent_settled` 作为完成信号 |
| 扩展 UI 协议有明确 Limitations | 实现前通读 `rpc-extension-ui.md`，不支持的类型显式提示降级 |
| pi 进程退出（用户在别处关闭/崩溃） | bridge 捕获退出码，WS 推送 lifecycle 记录，UI 提示并可一键重启 |
| 多标签页同时连一个会话导致状态分裂 | M1 约定单客户端；多标签互斥（后连者接管、前连者只读提示），放在 M4 决策 |
| 每会话一个 pi 进程导致进程数与内存增长 | 非当前且空闲 10 分钟的运行时自动停掉；正在跑的永不回收（见第 3 节） |

## 9. 已确认决策（原"待确认问题"）

1. **界面语言**：中文为主，技术术语保留英文（如 `agent_settled`、`streamingBehavior`）。不做多语言。
2. **项目名**：目录 `webui/`，CLI 脚本名 `pi-web`（`npm run dev` 启动 bridge + 静态服务）。
3. **前端框架**：Preact + Vite + TypeScript。
4. **位置**：独立目录 `webui/`，不并入根 `npm run check`；`webui/` 内提供自己的 `npm run check`（tsc + eslint，若引入 eslint）。
5. **M3 会话列表**：最近 20 个，不做分页（待评审时仍可推翻）。
6. **启动与端口**：固定默认端口（见第 3 节"端口"），支持 `--port` 覆盖；冲突时启动失败并提示，不自动换端口。
7. **切换会话不中止运行**：每个会话一个 pi 运行时（`bridge_attach`/`bridge_new_session`），不用 pi 的 `switch_session`（它会 abort 当前轮）；浏览器仍一次只接一个运行时，后台运行时的记录被丢弃但 stdout 持续消费，切回（或刷新页面）时用 `get_state`/`get_messages` 重建现场，并重放正在流式输出的那条消息（`bridge_resume`）。`fork`/`clone` 仍是当前运行时内的操作（pi 替换会话时必然中止当场那一轮）。
8. **运行时回收**：非当前会话的运行时空闲 10 分钟即停（`RuntimePool` 周期扫描），正在运行的运行时永不回收；删除会话前先停掉其运行时（Windows 无法删除被占用的文件）。

## 10. 开放问题（不阻塞 M1，按里程碑到期前定）

1. **M3 会话列表**：是否需要显示任意久远的历史会话（涉及分页），还是最近 20 个足够？（已按"最近 20 个"执行，如需分页在 M3 前提出）
2. **多标签页互斥**：后连者接管、前连者只读，还是仅提示不允许？（M4 决策，见第 8 节风险表）

## 11. 里程碑排期与启动方式补充

- 开发启动：`cd webui && npm run dev`（bridge + Vite dev server 一并起，dev 模式代理 WS；生产模式 `npm run build` 后 bridge 直接服务 `dist/`）。
- 固定端口：bridge 默认监听 `127.0.0.1:5173`（与 Vite 默认一致，dev/prod 同端口，浏览器书签固定）；`--port` 可覆盖；被占用时启动失败并列出占用进程提示。
