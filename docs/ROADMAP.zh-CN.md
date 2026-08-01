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

## 当前状态

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 独立 fork 与 Git 基线 | **Done** | `chenxigary/persona`，上游仅用于同步 |
| macOS 本地启动与 runbook | **Done** | Electron、权限、模型导入和故障处理已记录 |
| ChatGPT/Codex 音量口型 | **Done** | Automatic listener 已在本机成功验证 |
| 无 VRMA 程序化身体动作 | **In Progress** | 作为 Idle/Speaking 的自动 fallback |
| 自定义 VRMA 动作库 | **Not Started** | 需要素材、兼容性和授权验证 |
| 稳定的 macOS Persona.app | **Not Started** | 需要打包、权限回归和后续签名策略 |
| LiteAvatar renderer | **Not Started** | 等 Persona 事件契约稳定后开始 |

## Now：稳定且不僵硬的 Persona

目标周期：当前迭代。Owner：Xi + Codex。

| Initiative | 结果 | 依赖 | 完成标准 |
| --- | --- | --- | --- |
| 程序化动作 fallback | 无 VRMA 时自动放下手臂、呼吸、摇摆和说话点头 | 标准 VRM Humanoid 骨骼 | Idle 和 Speaking 均无 T-pose；配置 VRMA 后自动让位 |
| Voice 稳定性回归 | 保持 ChatGPT Voice 与口型同时可用 | macOS 系统音频权限、单 Persona 实例 | 冷启动连续验证三次，无 Voice 启动超时 |
| 视觉调校 | Frieren 的大小、镜头、灯光和动作幅度自然 | 程序化动作稳定 | 桌面使用时不遮挡主要内容，动作无穿模或明显抖动 |
| macOS 开发包验证 | 减少 Electron 安装和权限身份不稳定 | `npm run dist:mac` | 本机安装、重启、权限和 Voice 回归通过 |

## Next：个性、动作与可诊断性

目标窗口：未来 1–3 个月。范围会根据 Now 的稳定性调整。

| Initiative | 预期价值 | 关键依赖 |
| --- | --- | --- |
| VRMA 动作库 | 更自然的 Idle、Speaking、Wave 和情绪动作 | 找到兼容且授权清楚的 VRMA 素材 |
| 程序化动作设置 | 可调呼吸、点头、摇摆和手臂角度，可一键关闭 | Appearance 设置 schema 与持久化 |
| MCP 语义动作 | Agent 根据问候、成功、思考等场景触发动作 | 动作元数据与 MCP 工具稳定 |
| Listener 诊断面板 | 快速判断捕获目标、PID 变化、权限和重连状态 | native helper 生命周期日志 |
| 可重复回归脚本 | 降低上游同步和发布带来的回归风险 | 状态 API、人工 Voice 验证清单 |

## Later：多 renderer 的桌面数字人平台

目标窗口：3–6 个月以上，属于方向性投资。

| Initiative | 预期结果 | 风险/依赖 |
| --- | --- | --- |
| LiteAvatar adapter | 写实角色复用相同的 state、audio-level 和 MCP 事件 | 模型许可、GPU/CPU 性能、运行时依赖 |
| Renderer 切换层 | Persona VRM 与 LiteAvatar 可切换而不改语音管线 | 先冻结统一 Avatar Driver contract |
| 自定义本地语音管线 | 本地 ASR/LLM/TTS 通过 External events 驱动角色 | 延迟、设备管理和安装复杂度 |
| 可选 OpenAI Realtime | 需要更精确事件和低延迟时再评估 | API 成本、Key 管理和隐私边界 |
| 签名与分发 | 可安装、可升级的 macOS 应用 | Apple Developer ID、公证和资源授权 |

## 优先级与取舍

1. **Must:** Voice Chat 稳定、口型可靠、无素材时不保持 T-pose。
2. **Should:** VRMA 个性化、MCP 语义动作、诊断能力、稳定打包。
3. **Could:** 本地完整语音管线、更多角色和跨平台打包。
4. **Not now:** 在 Persona 基线稳定前重新引入 OpenAI Realtime 或把 LiteAvatar
   直接耦合进当前 renderer。

本次调整把“程序化动作 fallback”提升到 Now，并把 Realtime 与 LiteAvatar 放到
Later。交换条件是先获得一个无需 API Key、可稳定日常使用的桌面宠物基线。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 硬编码骨骼角度不适合所有 VRM | 穿模、手臂姿势异常 | 先以 Frieren 验证，Next 阶段加入每模型设置 |
| ChatGPT 没有官方跨进程 Voice 事件 | matcher 依赖内部进程与 Core Audio | 保留 External events；加强生命周期诊断 |
| VRMA 素材兼容或授权不明 | 无法发布或动画异常 | 记录来源、许可和 Humanoid 兼容测试 |
| LiteAvatar 资源消耗较高 | 桌面常驻体验变差 | 独立 adapter、性能预算、延后集成 |

## 成功指标

- ChatGPT Voice 启动成功率达到本机连续 10 次验证中的 10 次。
- 助手开始输出后，嘴部与身体在主观上立即响应，无明显停顿或抖动。
- 无 VRMA 时不出现持续 T-pose；有 VRMA 时不与程序化动作争夺骨骼。
- Persona 常驻不要求 OpenAI API Key，不保存或上传原始音频。
- LiteAvatar 开始前，Avatar Driver 的 state、level、animation contract 有文档和测试。

## Roadmap 更新方式

每完成一个 Now initiative 更新状态；每月重新检查 Next 顺序。只有 Voice 稳定性、
资源许可或技术依赖发生明显变化时，才调整 Now/Later 的边界。
