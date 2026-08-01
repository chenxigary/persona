# Persona macOS 本地运行 Runbook

这份 runbook 用于在 Apple Silicon Mac 上从源码运行 Persona，并让角色跟随
ChatGPT/Codex 的输出音量做口型。它记录的是已验证成功的本地路径，不改变 Persona
源码，也不要求 OpenAI API Key。

## 已验证基线

| 项目 | 值 |
| --- | --- |
| 仓库 | `https://github.com/xikhar/persona` |
| 本地目录 | `/Users/xichen/Documents/persona` |
| Git 基线 | `327c8ca1b9a50a4a14d8a125fcf36eb5a9ae57af` |
| 平台 | macOS arm64 |
| Node.js | `v26.3.0` |
| Electron | `39.8.10` |
| 模型 | 本地导入的 `frieren.vrm` |

成功标准：Persona 只运行一个实例，Settings 中已配置默认模型，Voice 使用
Automatic，native listener 显示 available/capturing，ChatGPT Voice 可以正常开始，
角色嘴部会随助手输出音量开合。

## 前置条件

- macOS 14.2 或更新版本。
- Node.js 24 或更新版本及 npm。
- Xcode Command Line Tools。用 `xcode-select -p` 检查；缺失时运行
  `xcode-select --install`。
- 一个合法的本地 `.vrm` 模型。干净 clone 不包含角色或动作媒体。
- 系统设置中允许 Electron 录制系统音频。

## 标准启动流程

先确认当前仓库和分支：

```bash
cd /Users/xichen/Documents/persona
git status --short --branch
git rev-parse HEAD
```

安装依赖、编译并测试 native listener，然后启动：

```bash
npm install
npm run native:build
npm run native:test
npm run demo
```

`npm run demo` 会先构建 renderer，再启动 Electron。日常开发需要热更新时使用
`npm run dev`；第一次验证建议使用 `npm run demo`，减少开发服务器变量。

交互式 zsh 默认可能不把 `#` 识别为注释。复制命令时不要附带行尾注释。

## 首次启动与模型导入

干净仓库没有 `.vrm` 或 `.vrma` 资源。首次启动只出现 Settings 是正常行为。

1. 打开 **Settings → Models**。
2. 导入 `/Users/xichen/Downloads/frieren.vrm`。
3. 第一个导入模型会自动成为默认模型。
4. 回到角色窗口，确认 Frieren 出现。

Persona 的文件选择器要求 `.vrm` 扩展名。如果下载文件名是
`frieren.vrm.glb`，先确认它确实是 VRM，再保留一份扩展名为 `frieren.vrm` 的副本。

模型和设置保存在：

```text
/Users/xichen/Library/Application Support/Persona/
```

不要为了首次运行复制 `library.json.example` 或 `manifest.json.example`。这些示例
引用的测试媒体不在干净仓库中，复制后会产生指向不存在文件的目录。

## 窗口交互与点击穿透

角色窗口是一个 430x680 的透明窗口，固定在屏幕右下角并置于所有应用之上。窗口的
绝大部分是透明的，因此默认启用**点击穿透**：只有指针落在角色身上时窗口才接收鼠标
事件，其余区域的点击直接落到下方的应用上。

- 指针在角色上：可以拖拽旋转、滚轮缩放、右键拖拽平移。
- 指针在透明区域：点击穿透，下方应用的按钮正常可点。
- 需要从空白处操作窗口时，在托盘菜单勾选 **Always interactive**，整个窗口恢复接收
  鼠标事件；调整完取消勾选即可回到穿透模式。

### 悬停边框

指针移到角色上会浮出一圈边框，提供三个操作：

- **顶部横条**：按住拖动可移动整个角色窗口（走系统窗口拖拽）。
- **齿轮按钮**：打开 Settings。
- **减号按钮**：隐藏角色，之后从托盘菜单 Show Persona 恢复。
- **右下角斜纹**：按住拖动缩放窗口，最小 320x480。

边框只在指针进入角色时出现，但**离开角色去点按钮不会让它消失**——判定区域在边框
显形时会扩展到整个边框范围，否则按钮正好落在穿透区里点不到。指针移出边框才收起。

若发现角色挡住了下方按钮且点不动，依次检查：

1. 托盘菜单里 **Always interactive** 是否被勾上了。
2. 是否运行的是旧版本——该行为在引入 `electron/window-interaction.cjs` 之后才有，
   切换分支后需要重新构建 renderer（`npm run demo` 或 `npm run build`）。
3. 角色占屏太大时，在 **Settings → Appearance** 中调小 character size,判定区域
   会跟着缩小。

## 导入 VRMA 动作

Settings → **Actions** 里管理动作。Persona 永远提供 **Idle** 和 **Speaking** 两个固定
槽位，其余是自定义动作——自定义动作的名称、描述和触发场景会写进 MCP 工具描述，
连接的 agent 据此决定何时播放。

导入步骤：

1. 打开 Settings → Actions。
2. 新建自定义动作，填写名称、描述、触发场景。
3. 在该动作下 **Add clips**，在文件选择器里选 `.vrma` 文件（可多选）。
4. 文件会被校验（glTF 2 二进制 + `.vrma` 后缀）并复制进 Persona 的应用数据目录，
   原文件可以随便移动或删除。

一个动作可以包含多个 clip，播放时随机选一个。

### pixiv VRoid Motion Pack 的建议映射

`VRMA_MotionPack` 里的 7 个动作都是**一次性演示动作**，不是循环待机动画：

| 文件 | 内容 | 建议 |
| --- | --- | --- |
| VRMA_01 | Show full body | 自定义 `show-full-body` |
| VRMA_02 | Greeting | 自定义 `greeting`，触发场景写"打招呼、对话开始" |
| VRMA_03 | Peace sign | 自定义 `peace` |
| VRMA_04 | Shoot | 自定义 `finger-gun` |
| VRMA_05 | Spin | 自定义 `spin` |
| VRMA_06 | Model pose | 自定义 `pose` |
| VRMA_07 | Squat | 自定义 `squat` |

**建议 Idle 和 Speaking 都保持为空。** 这两个槽位是长时间循环的，塞一个一次性动作
进去会不断重播，观感很怪；留空则由程序化动作接管，提供呼吸、摇摆和说话点头。
这些 VRMA 更适合当作 MCP 可触发的一次性动作。

### 许可注意

该动作包版权属于 pixiv Inc.，可自由使用（含商用），但要求署名
"Animation credits to pixiv Inc.'s VRoid Project"，并且**禁止以可被提取或重新绑定的
形式再分发**。

因此：用户自行导入没有问题（文件存在本机应用数据目录，不参与分发）；但**不要**把
它们放进 `public/assets/animations/` 并在 `manifest.json` 里标记
`distributionAllowed: true`——那等于随安装包再分发，超出许可范围。

## 系统音频权限

进入：

**系统设置 → 隐私与安全性 → 屏幕与系统音频录制**

为 **Electron** 开启“屏幕与系统音频录制”或“仅系统音频录制”权限。权限变化后：

1. 完全退出 Persona/Electron。
2. 从 Terminal 重新运行 `npm run demo`。
3. 在 **Settings → Voice** 选择 **Automatic**。

Persona 只计算目标进程输出的归一化音量，不录制麦克风、不保存原始音频，也不会把
音频发到网络。

## 验证口型与 ChatGPT Voice

推荐验证顺序：

1. 完全退出所有旧 Persona 实例。
2. 启动 ChatGPT，并先确认普通 Voice Chat 可以开始。
3. 在独立 Terminal 中运行 `npm run demo`，只启动一个 Persona 实例。
4. 打开 **Persona Settings → Voice → Automatic**。
5. 让 ChatGPT Voice 连续说一段话，观察嘴部是否随音量开合。
6. 点击 Voice 页的状态检查，确认 listener 为 available/capturing。

口型是音量驱动，不是音素级 viseme：它能同步开合强弱，但不会精确区分
“a/i/u/e/o”嘴形。Idle/Speaking 没有 `.vrma` 时，Persona 会自动启用轻量程序化
动作，包括手臂放下、呼吸、轻微摇摆、头部运动和说话点头。导入 `.vrma` 后，
对应 action 的程序化动作会自动让位给动画文件。

## Codex MCP

Persona 运行时注册一次：

```bash
codex mcp add persona --url http://127.0.0.1:47831/mcp
codex mcp get persona
```

重新打开 Codex task 后，可以使用 Persona 提供的状态、窗口和动画工具。MCP 用于
控制 Persona，不会替代 ChatGPT Voice 的音频监听。

需要撤销连接时：

```bash
codex mcp remove persona
```

## 故障处理：Electron failed to install correctly

症状：`node_modules/electron/index.js` 报错，且
`node_modules/electron/path.txt` 不存在。已观察到的本机原因是 Electron ZIP 下载
成功，但 npm 使用的解压流程没有正确还原 macOS `.app` bundle 中的符号链接。

先检查 Electron 版本并自动选择一个匹配的缓存文件：

```bash
cd /Users/xichen/Documents/persona
ELECTRON_VERSION=$(node -p 'require("./node_modules/electron/package.json").version')
ELECTRON_ARCHIVE=$(find /Users/xichen/Library/Caches/electron -type f -name "electron-v${ELECTRON_VERSION}-darwin-arm64.zip" -print -quit)
test -f "$ELECTRON_ARCHIVE"
ls -lh "$ELECTRON_ARCHIVE"
```

确认 ZIP 存在且大小合理，再用 macOS 自带的 `ditto` 恢复 bundle。以下命令必须在
同一个 Terminal session 中紧接上一步运行，以保留 `ELECTRON_ARCHIVE`：

```bash
cd /Users/xichen/Documents/persona
test -f "$ELECTRON_ARCHIVE"
rm -rf /Users/xichen/Documents/persona/node_modules/electron/dist
mkdir -p /Users/xichen/Documents/persona/node_modules/electron/dist
ditto -xk "$ELECTRON_ARCHIVE" /Users/xichen/Documents/persona/node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > /Users/xichen/Documents/persona/node_modules/electron/path.txt
xattr -dr com.apple.quarantine /Users/xichen/Documents/persona/node_modules/electron/dist
node -e 'console.log(require("electron"))'
```

只删除上面明确列出的 Electron `dist` 目录。重新安装 `node_modules` 后如果安装器再次
走到有问题的解压路径，需要重新执行这一恢复步骤。

若缓存 ZIP 缺失或明显损坏，先移走对应的单个 ZIP，再重新触发 Electron 下载；不要
递归删除整个用户目录或无关缓存。

## 故障处理：ChatGPT Voice 启动超时

**此问题已定位并修复**，见 commit `c00b13a` 与 `08d2941`。根因是 Core Audio process
tap：只要 tap 挂在 ChatGPT 的进程树上，它的语音会话就建立不起来；会话建立完成后
再挂 tap 则完全正常。

四组对照（每组均为 ChatGPT 全新启动）：

| Persona | tap 目标 | 首次语音连接 |
| --- | --- | --- |
| 未运行 | — | 成功 |
| 运行中 | `/usr/bin/afplay`（无关进程） | 成功 |
| 运行中 | ChatGPT（Automatic） | 失败 |
| 会话建立后才启动 | ChatGPT | 成功，口型正常 |

第二行是隔离变量的关键：Persona 完整运行，唯一差异是 tap 挂在谁身上。

之前"重启 ChatGPT 就好了"是个误导性的观察——起作用的不是重启本身，而是重启后
Persona 需要几秒才匹配到新 PID，那段无 tap 的空窗期正好用来建立会话。

修复后 native helper 改为：轮询 `kAudioProcessPropertyIsRunningOutput`（读这个属性
不需要 tap），目标真正出声后才创建 tap，停声约 3 秒即释放，因此每一轮会话都在无 tap
状态下协商。

若在修复后的版本上仍然超时：

1. 确认已重新编译：`npm run native:build && npm run native:test`。
2. 完全退出 Persona，重试 ChatGPT Voice；若此时恢复，说明仍有 Persona 侧因素。
3. 在 Activity Monitor 中确认没有多个 Persona/Electron/native listener 残留。
4. 检查系统音频权限。
5. 临时绕过：先连上语音，再启动 Persona；或在 **Settings → Voice → External**
   中彻底隔离 native capture。

## 收集诊断证据

问题再次出现时，在退出 Persona 之前记录：

```bash
cd /Users/xichen/Documents/persona
git rev-parse HEAD
node --version
npm --version
pgrep -fl 'Persona|Electron|persona-audio-listener|ChatGPT'
```

同时保存：

- Persona Voice 页的 mode、status、available/capturing 截图；
- ChatGPT Voice 的错误截图；
- Terminal 中 `npm run demo` 的完整输出；
- 问题发生时的启动顺序；
- 退出 Persona 后 ChatGPT Voice 是否立即恢复。

上游追踪：[xikhar/persona#13](https://github.com/xikhar/persona/issues/13)。

## 停止与回滚

- 正常停止：从 Persona 菜单退出，或在启动它的 Terminal 按 `Control-C`。
- 隔离语音监听：在 Voice 设置中选择 External，再重启 Persona。
- 撤销 MCP：运行 `codex mcp remove persona`。
- 本地模型和设置位于 Application Support；排障时先备份，不要直接删除整个目录。

## 每次更新后的回归检查

```bash
cd /Users/xichen/Documents/persona
npm run check
npm run native:build
npm run native:test
npm run demo
```

手工确认模型加载、窗口缩放、ChatGPT Voice 连接、口型开合、退出重启和 MCP 状态。

窗口穿透：在角色旁边打开任意应用，点击被角色窗口覆盖的透明区域，确认点击落到下方
应用；再把指针移到角色身上，确认可以拖拽旋转。

动作切换无 T-pose：给某个动作配一个 VRMA，然后在配了 clip 的动作与没配 clip 的动作
之间来回切换（例如用托盘的 Preview speaking / Preview listening）。角色应当平滑过渡，
**任何时刻都不应出现双臂平举的 T-pose 闪烁**，尤其是某个 clip 第一次播放时。

Listener 不变量（**推荐用这个代替手工数 10 次冷启动**）：带日志跑一段正常使用，
然后让脚本判定。

```bash
PERSONA_DEBUG=1 npm run demo 2>&1 | tee /tmp/persona.log
# 正常用语音应用几分钟，来回说几轮，然后 Control-C
node scripts/check-listener-invariants.cjs /tmp/persona.log
```

脚本检查三条：tap 重建频率（旧 bug 是 20 秒 10 次）、**每次 tap 期间是否真的有说话**
（在目标静默时挂 tap 正是阻断语音会话建立的条件）、以及说话结束后是否及时释放。

这比数 10 次连接更可靠：手工计数只观察症状，而脚本直接验证造成症状的机制。
样本要够——至少来回说三四轮，脚本会在样本不足时明确说"不判定"而不是给个假通过。

External 契约（不依赖进程匹配与 Core Audio）：在 **Settings → Voice** 中选择
External，保持 Persona 运行，然后

```bash
node scripts/check-external-events.cjs
```

脚本会依次推送 listening、一段合成的说话电平、再回到 idle，并校验 `/health` 的最终
状态。角色应当跟着张嘴和摆动。这条通道是 Automatic matcher 失效时的兜底路径,
每次上游同步后值得跑一次。
