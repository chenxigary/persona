# Persona Desktop Voice Pet Roadmap

这份路线图描述 `chenxigary/persona` 从可运行的上游 fork 演进为本地
speak-to-speak 桌面数字人的方向。采用 **Now / Next / Later**，不承诺虚假的精确日期；
只有 Now 属于当前承诺范围。

## 产品目标

让一个本地运行的桌面角色在 ChatGPT、Codex 或自定义语音管线旁边自然地存在：

- 助手说话时嘴部及时响应；
- 没有动画素材时身体也不僵硬；
- 有语义信息时能做合适的表情和动作；
- 动画和 MCP 不能破坏 Voice Chat 的稳定性；
- 后续可以复用同一套事件契约驱动写实 LiteAvatar。

## 验收口径

一条能力只有在**冷启动连续 10 次全部通过**后才记为 Done。"本机跑通过一次"记为
In Progress。这条口径是被实践修正过的：`ChatGPT/Codex 音量口型` 曾因为口型可用
就被记为 Done，而当时首次语音连接实际上是**完全失败**的——口型正确掩盖了
上游链路已经断掉的事实。

## 当前状态

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 独立 fork 与 Git 基线 | **Done** | `chenxigary/persona`，上游仅用于同步 |
| macOS 本地启动与 runbook | **Done** | Electron、权限、模型导入和故障处理已记录 |
| ChatGPT/Codex 音量口型 | **In Progress** | 口型本身可用；曾因 process tap 阻断语音会话建立而首连必败，已修复（见下），待补 10 次冷启动验证 |
| Listener 不干扰宿主应用 | **In Progress** | macOS 已修复并初步验证；Windows/Linux 未验证 |
| 无 VRMA 程序化身体动作 | **In Progress** | 已实现为 Idle/Speaking 的自动 fallback，动作数学已抽成纯函数并覆盖测试，待人眼验收 |
| 窗口点击穿透 | **In Progress** | 透明区域已可穿透，托盘可切换 Always interactive，待日常使用验证 |
| 自定义 VRMA 动作库 | **Not Started** | 需要素材、兼容性和授权验证 |
| External 事件契约验证 | **Not Started** | 已提升到 Next，作为进程匹配的对冲 |
| 稳定的 macOS Persona.app | **Not Started** | 需要打包、权限回归和后续签名策略 |
| LiteAvatar renderer | **Not Started** | 等 Persona 事件契约稳定后开始 |

### 已修复：process tap 阻断宿主语音会话

对照实验（每组均为宿主应用全新启动）：

| Persona | tap 目标 | 首次语音连接 |
| --- | --- | --- |
| 未运行 | — | 成功 |
| 运行中 | `/usr/bin/afplay`（无关进程） | 成功 |
| 运行中 | ChatGPT（Automatic） | **失败** |
| 会话建立后才启动 | ChatGPT | 成功，口型正常 |

第二行是隔离变量的关键：Persona 完整运行，唯一差异是 tap 挂在谁身上。
修复为两个 commit：`c00b13a` 消除进程树抖动导致的反复重建（实测 20 秒 10 次），
`08d2941` 改为轮询 `kAudioProcessPropertyIsRunningOutput`、目标真正出声后才建 tap、
停声约 3 秒即释放，使每一轮会话都在无 tap 状态下协商。

## Now：稳定且不僵硬的 Persona

目标周期：当前迭代。Owner：Xi + Codex。

| Initiative | 结果 | 依赖 | 完成标准 |
| --- | --- | --- | --- |
| 程序化动作 fallback | 无 VRMA 时自动放下手臂、呼吸、摇摆和说话点头 | 标准 VRM Humanoid 骨骼 | Idle 和 Speaking 均无 T-pose；配置 VRMA 后自动让位 |
| ~~程序化动作测试补齐~~ **已完成** | 动作数学抽为 `proceduralPose` / `advanceElapsed` / `applyPose` / `restorePose` 等纯函数并测试 | 无新增依赖 | 已覆盖 delta 钳位、说话与静默的差异、禁用时骨骼精确还原、缺失骨骼与无 humanoid |
| 窗口不遮挡下层应用 | 角色旁边的应用照常可点，需要时又能抓住窗口调整 | `electron/window-interaction.cjs`、渲染层上报角色屏幕矩形 | 透明区域点击穿透；指针在角色上可旋转缩放；托盘 Always interactive 可整窗接管 |
| Voice 稳定性回归 | 保持 ChatGPT Voice 与口型同时可用 | macOS 系统音频权限、单 Persona 实例 | 冷启动连续 10 次全部成功，无 Voice 启动超时；挂断后重连同样成立 |
| 视觉调校 | Frieren 的大小、镜头、灯光和动作幅度自然 | 程序化动作稳定 | 桌面使用时不遮挡主要内容，动作无穿模或明显抖动 |
| macOS 开发包验证 | 减少 Electron 安装和权限身份不稳定 | `npm run dist:mac` | 本机安装、重启、权限和 Voice 回归通过 |

## Next：个性、动作与可诊断性

目标窗口：未来 1–3 个月。范围会根据 Now 的稳定性调整。

| Initiative | 预期价值 | 关键依赖 |
| --- | --- | --- |
| External 事件契约最小验证 | 自建管线 POST state + audio-level 跑通端到端，绕开进程匹配与 Core Audio tap 这一整类风险 | **发送端已就绪**：`node scripts/check-external-events.cjs`，剩下的是接一条真实本地管线 |
| Windows / Linux 干扰验证 | 确认 WASAPI loopback 与 `pw-record` 是否同样影响宿主 | 各平台一台可测机器 |
| VRMA 动作库 | 更自然的 Idle、Speaking、Wave 和情绪动作 | 找到兼容且授权清楚的 VRMA 素材 |
| 程序化动作设置 | 可调呼吸、点头、摇摆和手臂角度，可一键关闭 | Appearance 设置 schema 与持久化；**需要先定义每骨骼的仲裁规则**，现在是整体二选一 |
| MCP 语义动作 | Agent 根据问候、成功、思考等场景触发动作 | 动作元数据与 MCP 工具稳定 |
| Listener 诊断面板 | 快速判断捕获目标、PID 变化、权限和重连状态 | native helper 生命周期日志 |
| 可重复回归脚本 | 降低上游同步和发布带来的回归风险 | 状态 API、人工 Voice 验证清单 |

## Later：多 renderer 的桌面数字人平台

目标窗口：3–6 个月以上，属于方向性投资。

| Initiative | 预期结果 | 风险/依赖 |
| --- | --- | --- |
| LiteAvatar adapter | 写实角色复用相同的 state、audio-level 和 MCP 事件 | 模型许可、GPU/CPU 性能、运行时依赖 |
| Renderer 切换层 | Persona VRM 与 LiteAvatar 可切换而不改语音管线 | 先冻结统一 Avatar Driver contract |
| 完整本地语音管线 | 本地 ASR/LLM/TTS 驱动角色（Next 的 External 验证是它的前置） | 延迟、设备管理和安装复杂度 |
| 可选 OpenAI Realtime | 需要更精确事件和低延迟时再评估 | API 成本、Key 管理和隐私边界 |
| 签名与分发 | 可安装、可升级的 macOS 应用 | Apple Developer ID、公证和资源授权 |

## 优先级与取舍

1. **Must:** Voice Chat 稳定、口型可靠、无素材时不保持 T-pose、**Persona 不得损害宿主应用**。
2. **Should:** External 契约验证、VRMA 个性化、MCP 语义动作、诊断能力、稳定打包。
3. **Could:** 本地完整语音管线、更多角色和跨平台打包。
4. **Not now:** 在 Persona 基线稳定前重新引入 OpenAI Realtime 或把 LiteAvatar
   直接耦合进当前 renderer。

本次调整把"程序化动作 fallback"提升到 Now，并把 Realtime 与 LiteAvatar 放到
Later。交换条件是先获得一个无需 API Key、可稳定日常使用的桌面宠物基线。

第二次调整把 **External 事件契约验证提到 Next**。理由：当前 Must 里最关键的
"Voice Chat 稳定"完全架在 ChatGPT 桌面端上，而这恰恰是本文档自己标记为最不可控的
依赖——没有官方跨进程事件流、靠进程名匹配、且已证实会双向干扰。External 通道
在 Persona 里已经存在，验活成本很低，能在上游某次更新打断进程匹配时兜底。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **Persona 的采集行为改变宿主应用** | 已实证：tap 存在时 ChatGPT 语音会话无法建立 | 已按"出声才挂、停声即放"修复；任何触碰 listener 或新增 renderer 的改动都必须重跑冷启动回归 |
| ChatGPT 没有官方跨进程 Voice 事件 | matcher 依赖内部进程与 Core Audio | 保留 External events 并在 Next 验活；加强生命周期诊断 |
| 程序化动作与模型体型不匹配 | 手臂穿模、幅度不自然 | 旋转基准本身可移植（用 `getNormalizedBoneNode()`，three-vrm 归一化骨骼是规范 T-pose 空间，与模型原始 rest pose 无关）；残留风险是**体型比例**，缓解方向是按比例缩放幅度或加碰撞检查，而非逐模型手调 |
| 程序化动作与 VRMA 争夺骨骼 | 动作叠加或抽搐 | 当前是整体二选一，安全但粗糙；Next 引入可调设置前必须先定义每骨骼仲裁 |
| 置顶窗口遮挡下层操作 | 角色覆盖区域的按钮点不到，桌面常驻变成负担 | 默认点击穿透，仅角色所在矩形接收指针；托盘提供整窗接管开关。判定用包围盒投影而非精确轮廓，边缘会略微保守 |
| VRMA 素材兼容或授权不明 | 无法发布或动画异常 | 记录来源、许可和 Humanoid 兼容测试 |
| LiteAvatar 资源消耗较高 | 桌面常驻体验变差 | 独立 adapter、性能预算、延后集成 |

## 成功指标

- ChatGPT Voice 冷启动成功率达到连续 10 次中的 10 次；同一次运行内挂断重连同样 10/10。
- 助手开始输出后，嘴部与身体在主观上立即响应，无明显停顿或抖动。
- 无 VRMA 时不出现持续 T-pose；有 VRMA 时不与程序化动作争夺骨骼。
- 角色常驻时，被其窗口覆盖的下层应用按钮依然可以直接点击。
- Persona 自身不需要 OpenAI API Key，不保存或上传原始音频。（注意：当前形态仍
  依赖 ChatGPT 桌面端的登录与订阅——"无 API Key"不等于"无 OpenAI 依赖"，
  真正的解耦要等 External 管线。）
- LiteAvatar 开始前，Avatar Driver 的 state、level、animation contract 有文档和测试。

## Roadmap 更新方式

每完成一个 Now initiative 更新状态；每月重新检查 Next 顺序。只有 Voice 稳定性、
资源许可或技术依赖发生明显变化时，才调整 Now/Later 的边界。

标记 Done 前对照"验收口径"一节。当一条能力的验证方式本身被证明不充分时
（例如只验了口型没验连接），除了修状态，还要把新的验证方式写进完成标准。
