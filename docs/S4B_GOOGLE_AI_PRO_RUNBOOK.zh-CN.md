# Google Flow 写实数字人素材生产 Runbook

本 Runbook 只说明如何在 Google Flow 中创建写实数字人素材，并提供可直接复制的
Prompt。项目实现和进度另见 [S4B.md](./S4B.md) 与
[ROADMAP.zh-CN.md](./ROADMAP.zh-CN.md)。

## 目标产物

一次生产只需要从 Flow 下载：

- `anchor-neutral.png`：闭嘴、中性、固定构图的角色锚点图。
- `speaking-selected.mp4`：由同一张锚点图约束首帧和尾帧的说话循环候选成片。

建议先生成 3 条 speaking 候选；方向正确后再补到最多 6 条。不要在确认角色、构图和
动作方向前批量消耗 credits。

## 前置条件

- 年满 18 岁且已完成账号年龄验证。
- 所在地区支持 Google Flow。
- Google AI Plus、Pro 或 Ultra 订阅。
- 使用电脑浏览器打开 [Google Flow](https://labs.google/flow)。
- 使用真人形象前，确认本人身份和素材授权；不要仿制未授权真人。

Flow 的模型、功能、地区限制和 credits 会变化。每次生成前，以 Prompt 设置中显示的
模型能力和 credit 数为准：

- [创建 Flow 视频](https://support.google.com/flow/answer/16353334?hl=en)
- [Flow 模型与支持能力](https://support.google.com/flow/answer/16352836?hl=en)
- [创建并使用 Flow Avatar](https://support.google.com/flow/answer/17102997?hl=en)
- [Flow 使用条件与地区](https://support.google.com/flow/answer/16353333?hl=en)

## 1. 创建项目并固定角色变量

1. 在 Flow 创建项目，建议命名为 `persona-s4b-google-flow-v1`。
2. 在项目说明或外部笔记中填写下面五个变量。
3. 后续 Prompt 始终复用同一套文字，不要随意替换同义词。

```text
CHARACTER = [年龄、性别呈现、脸型、肤色、发型、发色、稳定且不侵权的辨识特征]
WARDROBE = [上衣、下装、鞋和配饰；后续保持完全一致]
BACKGROUND = [固定、简洁、低对比度的室内或纯色背景]
FRAMING = centered three-quarter body portrait, head and both hands fully visible
LIGHTING = soft even studio lighting from the front-left, no changing shadows
```

背景应避开人物、窗帘、屏幕、树叶、强反光和其他容易产生漂移的元素。衣服与背景不要
使用过于接近的颜色。

## 2. 可选：创建本人的 Flow Avatar

仅在使用本人形象时执行：

1. 在 Flow 右上角打开头像菜单，选择 **Create avatar**。
2. 选择 **Get started**，用手机或平板扫描二维码。
3. 按屏幕提示完成身份和外观采集。
4. 回到项目，在生成锚点图的 Prompt 中输入 `@me` 引用本人 Avatar。

Avatar 的可用地区和具体入口可能不同，以 Flow 当前界面为准。虚构角色跳过此步骤，
直接使用固定的 `CHARACTER` 描述。

## 3. 生成闭嘴锚点图

### 3.1 Flow 操作

1. 在 Prompt 设置中选择 **Image**。
2. 初稿可选择 Nano Banana 2 Lite；需要更高细节时再改用 Nano Banana 2 或 Pro。
3. 画幅选择 **9:16**。
4. 粘贴下面的 Prompt，并替换方括号变量。
5. 真人 Avatar 用户在 Prompt 开头保留 `@me`；虚构角色删除该行。
6. 生成并筛选锚点图，必要时使用“锚点修正 Prompt”局部重做。
7. 将最终图片保存在 Flow 项目中，并下载为 `anchor-neutral.png`。

### 3.2 锚点图 Prompt

```text
@me

Create one production reference image for a photorealistic desktop digital
human. Use the referenced avatar as the exact identity.

Character: [CHARACTER]
Wardrobe: [WARDROBE]
Background: [BACKGROUND]

Vertical 9:16 composition. Centered three-quarter body portrait. The full head,
shoulders, torso, forearms, and both hands are visible with comfortable margin.
Eye-level locked camera, natural 50 mm portrait perspective. Soft, even studio
lighting from the front-left. Neutral standing pose, shoulders relaxed, arms
resting naturally, eyes looking just above the camera, neutral friendly
expression, lips fully closed.

Photorealistic, clean, and production-ready. Realistic anatomy, skin, hair,
hands, and clothing texture. Stable facial proportions and a simple completely
still background.

Create a single image, not a contact sheet. No text, logo, border, caption,
dramatic perspective, cropped head, cropped hands, extra fingers, open mouth,
visible teeth, props, other people, or background motion.
```

虚构角色版本：删除第一段 `@me` 和 “referenced avatar” 句，完整填写 `CHARACTER`。

### 3.3 锚点图修正 Prompt

对已生成的图片进行编辑时，只描述要修正的部分：

```text
Keep the accepted identity, hairstyle, wardrobe, background, lighting, camera,
crop, pose, and body proportions exactly unchanged.

Fix only the following issue: [ISSUE]. Make the lips fully closed with no teeth
visible, preserve natural facial anatomy, and keep the full head and both hands
inside the frame. Do not redesign or restyle any accepted element.
```

### 3.4 锚点图验收

- 嘴完全闭合，不露齿。
- 五官、双手和手指没有明显错误。
- 头顶、双手、肩膀和身体边缘没有被裁掉。
- 人物身份、衣着、灯光和背景都适合在后续视频中保持不变。
- 缩小查看时，脸和嘴仍然清晰可辨。

## 4. 使用首尾帧生成 speaking 视频

### 4.1 Flow 操作

1. 在项目 Prompt 设置中选择 **Video → Frames**。
2. 将 `anchor-neutral.png` 拖入 **Add start frame**。
3. 将完全相同的图片再次拖入 **Add end frame**。
4. 选择支持 **First + last frames** 的模型；当前优先使用 Veo 3.1 Lite。
5. 画幅选择 **9:16**，时长选择 **6 seconds**。
6. 粘贴 speaking Prompt。
7. 每次生成一条，记录候选编号、模型和 Prompt 版本。
8. 先生成 3 条；至少一条方向正确后，再补到最多 6 条。

如果 Flow 当前模型不支持 First + last frames，切换到模型能力页列出的兼容模型；不要
放弃相同首尾帧约束，也不要用不同图片分别作为首帧和尾帧。

### 4.2 Speaking Prompt

```text
Use the supplied start and end frames as strict references for the exact same
identity, face, hair, wardrobe, background, lighting, camera, crop, pose, and
body proportions.

Create one continuous 6-second generic conversational-speaking loop. The
camera is completely locked. Begin in the exact supplied pose with the lips
fully closed. From 0.6 to 5.0 seconds, the character silently articulates a
short natural sentence with restrained and varied mouth shapes, two very small
head nods, and minimal upper-body conversational motion. Keep the hands within
the original silhouette and never cover the face. From 5.0 to 6.0 seconds,
close the mouth and smoothly return to the exact supplied neutral pose so the
final frame matches the first frame.

Keep the motion calm and natural at small desktop-window scale. Preserve the
exact same face, teeth, jaw, identity, and proportions in every frame.

No audible speech, music, ambient audio, exaggerated or rapid mouth movement,
stuck-open mouth, tongue close-up, large hand gesture, camera motion, zoom,
cut, new object, flicker, morphing, identity drift, changing background, text,
subtitle, or logo.
```

### 4.3 通用单问题修正 Prompt

重试时保留原 Prompt，并在末尾追加：

```text
Correction for this take only: keep every accepted visual element unchanged.
Fix only [IDENTITY DRIFT / LOOP SEAM / EXCESSIVE MOTION / RAPID MOUTH MOVEMENT /
MOUTH NOT CLOSED]. Reduce the affected motion amplitude by 50 percent and begin
the smooth return to the supplied end frame at 4.3 seconds. Do not introduce
any new action, camera change, or visual element.
```

### 4.4 嘴部动作过快修正 Prompt

```text
Keep the exact identity, framing, pose, camera, wardrobe, lighting, background,
and accepted body motion unchanged. Fix only the mouth animation. Use slower,
smaller, restrained conversational mouth shapes with brief natural closed-lip
moments between phrases. Reduce jaw travel and mouth-motion speed by 40 percent.
No exaggerated vowels, rapid chewing motion, repeated cycles, or frozen mouth.
```

### 4.5 循环接缝修正 Prompt

```text
Keep the exact identity and all accepted motion unchanged. Fix only the loop
seam. Begin returning to the supplied neutral end frame at 4.3 seconds. By 5.7
seconds, match the supplied pose, closed lips, gaze, shoulders, hands, hair
silhouette, lighting, and background exactly, then remain still through the
final frame. No camera movement or cross-scene transition.
```

## 5. 候选命名与筛选

### 5.1 命名

```text
speaking-c01-lite-p1.mp4
speaking-c02-lite-p1.mp4
speaking-c03-lite-p1.mp4
```

`c01` 是候选编号，`lite` 是模型档位，`p1` 是 Prompt 版本。修正后递增 Prompt 版本，
不要覆盖原候选。

### 5.2 评分

每项 0–2 分，总分至少 8 分才可入选：

| 项目 | 0 分 | 1 分 | 2 分 |
| --- | --- | --- | --- |
| 身份稳定 | 明显换脸 | 轻微漂移 | 全程稳定 |
| 首尾循环 | 明显跳变 | 轻微接缝 | 肉眼无缝 |
| 说话动作 | 抽搐或快嘴 | 尚可 | 自然克制 |
| 解剖与服装 | 明显错误 | 小瑕疵 | 稳定自然 |
| 构图与背景 | 漂移或裁切 | 轻微变化 | 完全固定 |

以下任一情况直接淘汰：

- 第 0 帧没有闭嘴。
- 切镜、推拉、背景闪烁或构图改变。
- 人脸、牙齿、下颌、手指或衣服明显变形。
- 嘴部突然冻结、持续张开或动作明显过快。
- 首尾帧存在明显姿态、亮度或人物尺寸跳变。

## 6. 下载最终素材

1. 打开评分最高的 speaking 候选。
2. 如果 Flow 提供分辨率提升选项，先选择可用的最高合适分辨率。
3. 下载视频并命名为 `speaking-selected.mp4`。
4. 下载最终锚点图并命名为 `anchor-neutral.png`。
5. 保留实际使用的 Prompt、模型名、生成日期和候选评分。

Flow 输出可能包含 SynthID 或地区要求的可见水印。遵守当前界面和当地要求，不裁切、
遮挡或规避强制来源标记。

## 7. 可选 Prompt 库

以下 Prompt 只在需要额外状态素材时使用。每条仍采用同一张
`anchor-neutral.png` 作为 start frame 和 end frame，并复用第 4.1 节设置。

### Idle Prompt

```text
Use the supplied start and end frames as strict references for the exact same
identity, wardrobe, background, lighting, camera, crop, pose, and proportions.

Create one continuous 6-second idle loop. The camera is completely locked.
The character remains calm and almost still. From 0.0 to 4.5 seconds, show one
gentle natural breathing cycle, one soft blink, and an extremely small weight
shift. Keep the hands, clothing, hair silhouette, and background stable. From
4.5 to 6.0 seconds, smoothly return to the exact supplied neutral pose so the
final frame matches the first frame.

The mouth remains fully closed for the entire clip. No speaking, lip movement,
smile change, hand gesture, camera motion, zoom, cut, new object, flicker,
morphing, text, subtitle, logo, music, dialogue, or ambient audio.
```

### Listening Prompt

```text
Use the supplied start and end frames as strict references for the exact same
identity, wardrobe, background, lighting, camera, crop, pose, and proportions.

Create one continuous 6-second attentive-listening loop. The camera is
completely locked. The character keeps eye contact just above the camera,
slightly tilts the head by only two or three degrees, raises the eyebrows very
subtly, and performs one small acknowledging nod. Keep the hands and body
silhouette stable. From 4.5 to 6.0 seconds, smoothly return to the exact
supplied neutral pose so the final frame matches the first frame.

The mouth remains fully closed for the entire clip. No speaking, lip movement,
repeated nodding, large gesture, camera motion, zoom, cut, new object, flicker,
morphing, text, subtitle, logo, music, dialogue, or ambient audio.
```

### Thinking Prompt

```text
Use the supplied start and end frames as strict references for the exact same
identity, wardrobe, background, lighting, camera, crop, pose, and proportions.

Create one continuous 6-second subtle-thinking loop. The camera is completely
locked. The character briefly shifts the eyes slightly upward and to their
left, lowers the chin a few degrees, and makes a very small thoughtful brow
movement. Add one soft blink. Do not touch the face and do not move the hands
across the body. From 4.5 to 6.0 seconds, smoothly return to the exact supplied
neutral pose so the final frame matches the first frame.

The mouth remains fully closed for the entire clip. No speaking, lip movement,
exaggerated confusion, large gesture, camera motion, zoom, cut, new object,
flicker, morphing, text, subtitle, logo, music, dialogue, or ambient audio.
```

## 8. Flow 生产记录模板

```text
Flow project:
Creation date:
Character/reference source and license:
Avatar used: yes / no
Image model:
Video model:
Credits shown before generation:

Anchor image filename:
Anchor prompt version:
Speaking candidate count:
Selected candidate filename:
Speaking prompt version:

Identity stability score:
Loop score:
Speaking-motion score:
Anatomy/wardrobe score:
Composition/background score:
Visible watermark requirement:
Notes:
```
