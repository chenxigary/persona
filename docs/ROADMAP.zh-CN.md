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
- 同一套事件契约已经可以驱动 VRM 与写实 LiteAvatar，并保持可回退。

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
| Listener 不干扰宿主应用 | **In Progress** | macOS 已修复并初步验证；当前只考虑 macOS，Windows/Linux 不在本轮范围 |
| 无 VRMA 程序化身体动作 | **In Progress** | 已实现为 Idle/Speaking 的自动 fallback，动作数学已抽成纯函数并覆盖测试，待人眼验收 |
| 窗口点击穿透 | **Ready for Dogfood** | 主进程改用屏幕坐标维护 frame lease，离开 220ms 后才释放；点击前 `mouseout/blur`、resize、窗口移动与显式调整模式自动通过，待人工确认顶部 bar / 四角手感 |
| 动作过渡不闪 T-pose | **In Progress** | 已改为按 mixer 权重加权混合，待导入 VRMA 后人眼验收 |
| 自定义 VRMA 动作库 | **In Progress** | pixiv VRoid Motion Pack（7 个一次性动作）已验证格式与许可；程序化动作与 VRMA 的混合已修复，待实际导入与观感验收 |
| External 事件契约验证 | **Paused** | 发送端脚本已就绪并可用；接真实本地管线的工作暂停 |
| 稳定的 macOS Persona.app | **Not Started** | 需要打包、权限回归和后续签名策略 |
| Avatar Driver v1 | **In Progress** | contract、capability、adapter 生命周期、队列与 VRM fallback 均已实现；自动回归通过，待人工 dogfood 后按 10 次口径收口 |
| macOS 写实 PCM 数据面 | **In Progress** | native 预分配 ring、严格协议、重采样、有界队列均已实现；真实 WAV 全链路 0 丢帧/0 失败，待带系统权限的真实宿主音频验收 |
| LiteAvatar renderer | **In Progress** | 真实 worker、MPS decoder、JPEG surface、健康检查、单次重启与 VRM fallback 已跑通；待人工评估约 2.1 秒首个口型帧延迟 |
| S4b 预渲染写实 renderer | **Ready for Dogfood 4** | 单 surface 的闪烁/尺寸已人工通过；P0-A 边框与 P0-B 双阈值嘴部包络均自动通过。三轮持续静音 326–332ms 闭嘴，80/160/240ms 谷不中断，跨 loop 边界继续播放，待真实 Voice 复验 |
| S4b Google Flow 素材 pilot | **Planned after Dogfood 4** | Runbook 已改为锚点图 + 单一 speaking 视频 + neutral schema 兼容片；先确认当前角色交互与门控，再生产 3–6 条 Lite 候选加最多 1 条 Fast 精修 |

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
| 窗口不遮挡下层应用 | 角色旁边的应用照常可点，需要时又能抓住窗口调整 | 主进程屏幕坐标命中、renderer frame rect、显式调整模式 | 人物到 bar / 四角各 20/20 不消失；移动/缩放各 10/10；退出后透明区点击下层 10/10 |
| 视觉调校 | Frieren 的大小、镜头、灯光和动作幅度自然 | 程序化动作稳定 | 桌面使用时不遮挡主要内容，动作无穿模或明显抖动 |
| LiteAvatar Gate B 人工验收 | 判断写实画面是否值得当前资源与同步代价 | 自动 Gate B 已通过 | 真实 ChatGPT/Codex Voice 可驱动口型；失败或重启时 VRM 可用；明确接受或否决感知延迟 |
| S4b 人工验收 | 判断通用预渲染口型的低延迟是否胜过 LiteAvatar 的较准但滞后 | 单 surface 连续性已人工通过；P0-A/P0-B 自动 gate 已通过 | 连续语音不错误停嘴，句尾不拖嘴；边框可移动/缩放；10 分钟稳定；明确接受其非音素级口型 |
| S4b Google Flow 单素材 pilot | 用可授权的新人物替换当前本地样例，同时不重启全帧换片 | Dogfood 4、`S4B_GOOGLE_AI_PRO_RUNBOOK.zh-CN.md` | 1 个闭嘴 anchor、1 条 speaking 成片、1 条本地 neutral 兼容片；同 URL/矩形 gate 与 10 分钟 dogfood 通过 |

## Next：个性、动作与可诊断性

目标窗口：未来 1–3 个月。范围会根据 Now 的稳定性调整。

| Initiative | 预期价值 | 关键依赖 |
| --- | --- | --- |
| Voice 10/10 发布 gate | 发布前确认 ChatGPT Voice 与口型同时稳定 | macOS 系统音频权限、单 Persona 实例；当前启动无明显问题，按用户决定延后 |
| macOS 开发包发布 gate | 发布前验证安装、重启、权限身份和 Voice 回归 | `npm run dist:mac`；按用户决定延后 |
| VRMA 动作库 | 更自然的 Idle、Speaking、Wave 和情绪动作 | 找到兼容且授权清楚的 VRMA 素材 |
| 程序化动作设置 | 可调呼吸、点头、摇摆和手臂角度，可一键关闭 | Appearance 设置 schema 与持久化；**需要先定义每骨骼的仲裁规则**，现在是整体二选一 |
| MCP 语义动作 | Agent 根据问候、成功、思考等场景触发动作 | 动作元数据与 MCP 工具稳定 |
| Listener 诊断面板 | 快速判断捕获目标、PID 变化、权限和重连状态 | native helper 生命周期日志 |
| 可重复回归脚本 | 降低上游同步和发布带来的回归风险 | 状态 API、人工 Voice 验证清单 |
| 写实 adapter Gate C | 若人工验收接受方向，解决同步、运行时安装和可分发许可 | Gate B 数据、外部 runtime、签名/公证策略 |

## Later：多 renderer 的桌面数字人平台

目标窗口：3–6 个月以上，属于方向性投资。

| Initiative | 预期结果 | 风险/依赖 |
| --- | --- | --- |
| LiteAvatar 产品化 | 自动安装/升级 runtime 与角色资源，形成可分发能力 | 模型许可、约 2.5 GB runtime、签名与升级策略 |
| 更多 renderer | 在不改 Voice/PCM 层的情况下比较其他本地或 hosted 写实引擎 | Avatar Driver v1 与 renderer 切换层已验证 |
| Windows / Linux 验证 | 未来若重新扩展平台，再检查 WASAPI loopback、`pw-record` 与打包 | 当前明确只考虑 macOS，不进入近期排期 |
| External 事件契约接真实管线 | 自建管线 POST state + audio-level，绕开进程匹配与 Core Audio tap 这一整类风险 | **已暂停**。发送端 `scripts/check-external-events.cjs` 可用，随时能重启这条线 |
| 完整本地语音管线 | 本地 ASR/LLM/TTS 驱动角色（External 契约是它的前置） | 延迟、设备管理和安装复杂度 |
| 可选 OpenAI Realtime | 需要更精确事件和低延迟时再评估 | API 成本、Key 管理和隐私边界 |
| 签名与分发 | 可安装、可升级的 macOS 应用 | Apple Developer ID、公证和资源授权 |

## 优先级与取舍

1. **Must:** Voice Chat 稳定、口型可靠、无素材时不保持 T-pose、**Persona 不得损害宿主应用**。
2. **Should:** VRMA 个性化、MCP 语义动作、诊断能力、稳定打包。
3. **Could:** 本地完整语音管线、更多角色和跨平台打包。
4. **Not now:** 重新引入 OpenAI Realtime、把外部 Python runtime 塞进正式安装包，
   或在人工接受同步代价前把 LiteAvatar 设为默认 renderer。

本次调整把"程序化动作 fallback"提升到 Now，并把 Realtime 与 LiteAvatar 放到
Later。交换条件是先获得一个无需 API Key、可稳定日常使用的桌面宠物基线。

第二次调整把 **External 事件契约验证提到 Next**。理由：当前 Must 里最关键的
"Voice Chat 稳定"完全架在 ChatGPT 桌面端上，而这恰恰是本文档自己标记为最不可控的
依赖——没有官方跨进程事件流、靠进程名匹配、且已证实会双向干扰。External 通道
在 Persona 里已经存在，验活成本很低，能在上游某次更新打断进程匹配时兜底。

第三次调整（2026-08-02）：**本地 speech-to-speech 方向暂停**，External 契约从 Next
退回 Later。接受的代价要写明白——语音这一半继续完全依赖 ChatGPT 桌面端，靠进程名匹配
和 Core Audio tap 维系，上游任何一次改动打断进程匹配就没有退路。发送端脚本
`scripts/check-external-events.cjs` 保留可用，重启这条线的成本很低。在此期间精力集中在
视觉侧：把 Now 的验收欠账清掉、VRMA 动作库、MCP 语义动作。

第四次调整（2026-08-02）：Voice 10/10 与 macOS 开发包仍保留为发布验收欠账，但因
当前本地启动无明显问题，暂不在本轮继续消耗。先启动两个可回退的视觉基础设施任务：
**Avatar Driver v1** 与 **macOS 写实 PCM 数据面 spike**。默认仍是 VRM；PCM 必须显式
开启、只在内存中流动、任何积压都丢 avatar 输入而不能阻塞音频回调。这个调整不等于
当时只启动 PCM 基础设施，真实模型进程和视频帧 surface 仍需单独 Gate B。

第五次调整（2026-08-02）：按当前任务完成 **LiteAvatar Gate B 自动部分**。Persona
自带隔离 worker wrapper，但复用外部项目的 Python/OpenAvatarChat runtime（只读，不复制
也不修改）。两轮真实 5.55 秒 WAV 与实际 Electron renderer 均通过：加载 6.6–16.5 秒、
20.6–20.7 fps、frame interval p95 50–141 ms、RSS 1,577–2,408 MB、83–142 个 speech
frame、PCM 队列 0 丢帧/0 失败；renderer 使用双缓冲后非空截图门禁通过。
主要反证也必须保留：Persona 被动监听已经播放的宿主音频，无法像参考管线那样吞掉原音频
再播放对齐版本，因此首个 speech frame 实测波动在 0.487–2.144 秒。现在进入人工
dogfood，而不是把
Gate B 的“能跑”偷换成“同步已产品化”。

第六次调整（2026-08-02）：实现参考项目的 S4b 降级路线，但把它作为独立 driver，
不覆盖 LiteAvatar。四段本地循环只通过受限 `persona-s4b:` 协议暴露；新片段有可解码
当前帧之前旧片段继续显示，避免白闪。说话状态与嘴部播放分离，电平超过阈值立即播放，
静音 140ms 后回闭嘴首帧。真实 Electron 自动门禁结果：启动至画面 559ms、Listening /
Thinking 切换 50/44ms、直接电平事件开嘴 2ms、闭嘴 155ms、30 个转场截图全部非空。
这些数字不含 ChatGPT 首次出声后 Core Audio tap 的发现时间，也不代表音素对齐；下一步
是人工 GPT Voice dogfood，而不是把“嘴马上动”表述成“嘴型对字”。

第七次调整（2026-08-02）：首轮 S4b dogfood 实测首嘴接近 1 秒、通用口型过快并偶发
闪烁。macOS 统一日志证实 Codex 出声后首个 tap 在 318ms 内被进程成员轮询杀掉，第二个
tap 到出声后约 604ms 才启动。native helper 现在在发现输出后先发 `attaching`，主进程从
该点到首个有效电平期间禁止非必要重建，并把空闲输出检测从 250ms 缩短到 100ms；完全
失去原目标 PID 时仍立即重连，Windows 的普通 `ready` 不进入此保护。speaking 素材从
150 帧 / 5 秒改为保留原始节奏的 176 帧 / 5.867 秒，音量只控制启停，不再把播放速度
推高到 1.12 倍。闭嘴改用预解码 canvas 覆盖层，不再在约 30Hz 的低电平流中反复 seek
可见视频。新版自动门禁两次重复结果为启动 595–884ms、闭嘴帧就绪 604–884ms、状态切换
44–52ms、直连开嘴 2–3ms、闭嘴 144–153ms、12/12 静音流截图与 30/30 转场截图非空、静音
期间 0 seek。Dogfood 调试
日志和五秒资源样本会持久化到 `~/.persona/logs/persona-dogfood.log`，下一步验证真实首嘴
是否已降到可接受范围。

第八次调整（2026-08-02）：第二轮 dogfood 一讲话就闪烁、人物大小跳变，并且 hover 边框
点击/拖动时自动消失。抽帧确认原始 `bg_video` 与 LiteAvatar 生成式 speaking 素材虽然都是
890×1920，但人物头部位置、身体比例和构图不同；全帧 cross-fade 无法掩盖这种换片。renderer
现在只保留 speaking 媒体作为唯一可见 surface，静音时用它自身的预解码闭嘴帧覆盖，并给
同一 stage 加极轻的环境运动。讲话前后不再更换 URL 或 DOM rectangle，同时只解码一个视频，
自动门禁中的 renderer 工作集从约 595MB 降到约 125MB。边框消失来自 macOS app-region 移动
触发 `blur/mouseout` 后过早恢复整窗鼠标穿透；renderer 与主进程现在分别锁住手势状态，移动
事件停止 250ms 后才释放。重复门禁为启动/闭嘴帧 579–839ms、Listening/Thinking 状态更新
7–10/2–3ms、开嘴 2–3ms、闭嘴 144–152ms、12/12 静音与 30/30 转场截图非空、0 seek，并通过按住缩放后失焦及
真实 BrowserWindow 移动锁测试。顶部原生 grip 的最终手感仍由下一轮人工 dogfood 验收。

第九次调整（2026-08-02）：第三轮 dogfood 已确认单一 speaking surface 修复了讲话闪烁
和人物大小跳变，但同时证伪了“边框已可验收”的判断。人工失败发生在 pointerdown 之前：
指针从人物移进 macOS app-region chrome 时边框先消失，因此之前的按住失焦与窗口已移动
自动化只覆盖了后半段。P0-A 改为由主进程用屏幕坐标持续命中 character/frame rect，
离开后迟滞释放；托盘增加显式“调整位置与大小”模式作为可靠兜底。

同轮新增“语音仍在输出、嘴偶尔停止”。speaking `<video>` 已设置 `loop`，日志不支持
片尾停播；更可能是 S4b 的 140ms close gate 比 Voice activity 的 900ms release 激进，
而 dogfood 日志又只记录大于 0.025 的节流样本，看不到触发 close 的低电平谷。P0-B 先给
mouth transition 增加原因/level/activity/paused/currentTime 诊断，再比较延长 delay、降低
阈值与双阈值短时包络；主方案是后者，目标为跨过 80–240ms 句中低谷，同时在持续静音
350–500ms 内闭嘴。

Google AI Pro 素材 runbook 也按这次产品结论收缩：当前 V1 只生产闭嘴 anchor 和一条
speaking 动态视频，非说话槽共用 Mac 从 anchor 生成的 neutral 兼容片。三条独立状态
视频保留为未来 Prompt 库，但不能在当前 renderer 重新启用全帧切换。P0-A/P0-B 通过前
不再邀请下一轮 dogfood；Voice 10/10 与 macOS 开发包继续按此前决定留作以后发布欠账。

第十次调整（2026-08-02）：完成 P0-A/P0-B 自动修复。边框不再由 renderer 的
`mouseout/blur` 单独释放；主进程接收 frame rect，以 33ms 轮询真实屏幕指针，并在指针
离开 220ms 后释放 mouse lease。托盘新增 “Adjust position and size”，可固定边框和整窗
交互，关闭或 Escape 退出。纯逻辑覆盖人物到 toolbar、离开迟滞、重新进入与无效几何；
Electron 新增 pointerdown 前 `mouseout/blur` 回归，并继续覆盖 resize 与窗口移动。

嘴部把单一 0.018 阈值改为开/关迟滞：开口仍使用 pack 阈值，打开后使用最高 0.008 的
close threshold 刷新至少 320ms peak-hold；每次开闭把原因、level、Voice activity、
paused 和 media time 写入有界 dogfood 日志。三轮 Electron 实测闭嘴 326–332ms，
80/160/240ms 低电平谷均未暂停，0.01 轻声可保持，视频跨 loop 边界继续播放。
`npm run check` 为 Node 152/152、renderer 104/104、audit 0、build 通过；macOS native
self-test 与 LiteAvatar Electron 48/48 唯一帧回归也通过。现在进入 Dogfood 4，只复验
这两个 P0 的真实手感与 Voice 行为，不插入 Google Flow 素材变量。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **Persona 的采集行为改变宿主应用** | 已实证：tap 存在时 ChatGPT 语音会话无法建立 | 已按"出声才挂、停声即放"修复；任何触碰 listener 或新增 renderer 的改动都必须重跑冷启动回归 |
| ChatGPT 没有官方跨进程 Voice 事件 | matcher 依赖内部进程与 Core Audio | 保留 External events 并在 Next 验活；加强生命周期诊断 |
| 程序化动作与模型体型不匹配 | 手臂穿模、幅度不自然 | 旋转基准本身可移植（用 `getNormalizedBoneNode()`，three-vrm 归一化骨骼是规范 T-pose 空间，与模型原始 rest pose 无关）；残留风险是**体型比例**，缓解方向是按比例缩放幅度或加碰撞检查，而非逐模型手调 |
| 程序化动作与 VRMA 争夺骨骼 | 动作叠加、抽搐，或切换瞬间闪回 T-pose | **已修复**：不再按"是否配置了 clip"整体二选一，而是按 mixer 的实时权重加权混合。原实现在 clip 异步加载和淡入淡出期间会把骨骼还原到归一化 T-pose，产生可见闪烁 |
| 置顶窗口遮挡下层操作 | 角色覆盖区域的按钮点不到，桌面常驻变成负担 | 默认点击穿透；主进程按屏幕坐标维护 character/frame 命中与迟滞，显式调整模式整窗接管。renderer `mouseout/blur` 不再单独决定释放 |
| VRMA 素材授权限制分发 | 可用于本地，但不能随安装包发布 | pixiv VRoid Motion Pack 禁止以可提取形式再分发：用户自行导入可以，放进 `public/assets/animations/` 并标 `distributionAllowed: true` 不行。打包用素材仍需另找 |
| LiteAvatar 资源消耗较高 | 桌面常驻体验变差 | 独立 adapter；实测 worker RSS 约 1.58 GB；默认仍为 VRM；人工 dogfood 决定是否继续产品化 |
| LiteAvatar 被动采集无法回放对齐音频 | 画面口型落后已经播放的助手声音 | Gate B 实测首帧约 0.487–2.144 秒；人工评估可接受性；若不可接受则比较低上下文模型或改为拥有播放链路的 driver |
| S4b 通用口型不对应具体音素 | 开口很快但某些词形明显不匹配 | 明确定位为轻量写实档；音量只控制启停、不改变播放速度；若必须对字则保留 LiteAvatar 或未来使用 TTS 音素时间轴 |
| S4b 句中低电平错误闭嘴 | 助手仍在讲话但人物嘴部停住，明显不自然 | 已记录 mouth transition 原因并使用双阈值 + 至少 320ms peak-hold；不能直接跟随 Voice 900ms release，也不能靠加速素材补偿 |
| S4b 素材背景不带 alpha | 写实人物仍显示原视频矩形背景 | renderer 已接受内嵌 alpha 视频；人物分割必须在离线素材阶段完成，当前 LiteAvatar sample 保持不透明且不伪装成已抠图 |
| 写实 driver 拖慢或拖垮 Voice | 口型/画面收益反而破坏宿主通话 | 默认关闭 PCM；native callback 使用预分配 SPSC ring；Electron 再做有界队列；过载只丢写实帧；adapter 独立进程并可回退 VRM |

## 成功指标

- ChatGPT Voice 冷启动成功率达到连续 10 次中的 10 次；同一次运行内挂断重连同样 10/10。
- 助手开始输出后，嘴部与身体在主观上立即响应，无明显停顿或抖动。
- 无 VRMA 时不出现持续 T-pose；有 VRMA 时不与程序化动作争夺骨骼。
- 角色常驻时，被其窗口覆盖的下层应用按钮依然可以直接点击。
- Persona 自身不需要 OpenAI API Key，不保存或上传原始音频。（注意：当前形态仍
  依赖 ChatGPT 桌面端的登录与订阅——"无 API Key"不等于"无 OpenAI 依赖"，
  真正的解耦要等 External 管线。）
- LiteAvatar worker 崩溃、超时或未安装时不影响 Voice，且 renderer 自动保留或回退 VRM。

## Roadmap 更新方式

每完成一个 Now initiative 更新状态；每月重新检查 Next 顺序。只有 Voice 稳定性、
资源许可或技术依赖发生明显变化时，才调整 Now/Later 的边界。

标记 Done 前对照"验收口径"一节。当一条能力的验证方式本身被证明不充分时
（例如只验了口型没验连接），除了修状态，还要把新的验证方式写进完成标准。
