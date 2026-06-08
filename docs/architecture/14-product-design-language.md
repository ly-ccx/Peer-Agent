# Zeus Atlas 产品设计语言

> 状态：设计治理基准草案
> 适用范围：Zeus Atlas Desktop 的产品结构、视觉语言、交互状态和组件实现。
> 目标：先固定统一审美和交互契约，再继续改 UI，避免每次补丁都把产品推向不同方向。

---

## 一、产品定位

Zeus Atlas Desktop 不是 Web 后台，不是普通聊天壳，也不是把调试入口堆在桌面里的工程面板。

它应该是：

```text
1688 宙斯员工版
  + Cloud CEO Agent 的任务工作台
  + Channel 会话索引
  + 本地能力代理的执行入口
  + 可解释、可回放、可治理的任务线程
```

产品气质：

```text
高端、简约、克制、强大。
```

这四个词不是装饰词，而是实现约束：

| 气质 | 设计含义 | 反例 |
|---|---|---|
| 高端 | 精准留白、细边界、少量高质量层次 | 大面积亮色、廉价渐变、厚重描边 |
| 简约 | 首屏只保留当前任务最需要的操作 | 把状态、调试、治理、发布入口全摆出来 |
| 克制 | 信息优先级清晰，动效只服务状态变化 | 每个模块都做卡片、每个状态都抢注意力 |
| 强大 | 用户能感知 Agent 在做事、能接管、能追踪证据 | 只有聊天气泡，看不到执行链路和边界 |

---

## 二、参考对象

### 2.1 借鉴 Codex.app

借鉴点：

- 侧栏通顶，作为任务索引而不是后台导航。
- 主区域是任务线程，不是多个管理页面。
- 输入框是任务入口和权限入口，不只是 textarea。
- 用户操作与 Agent 执行结果在同一条线程里发生。
- 低对比、细边界、柔和大圆角、稳态深色背景。

不照搬：

- 不出现项目工程概念。
- 不暴露模型选择。
- 不把本地代码执行假设带进 Zeus Atlas。
- 不出现 Codex 的 Review / Git / Workspace 语义，除非 Zeus Atlas 有等价业务对象。

### 2.2 借鉴 Claude Desktop / Cowork

借鉴点：

- 新会话首屏需要有明确的中心重心，而不是空白。
- Composer 可以成为视觉核心。
- 建议任务应该像能力提示，不像营销卡片。
- 账户入口在左下角，与 Settings 融合。

不照搬：

- 不使用强品牌暖色块作为主视觉。
- 不做大面积纹理装饰。
- 不把“技能 / project / model”这些非本产品对象放到主流程。

---

## 三、Zeus 的产品特色

上一节只说明“参考谁”，这一节定义 Zeus Atlas 自己的识别度。

Zeus Atlas 的特色不应该来自装饰图形，而应该来自三个产品机制：

```text
Channel Command
  + Executive Thread
  + Evidence-aware Execution
```

### 3.1 Channel Command

Codex 的左侧是 Project / Chat 索引，Zeus 的左侧是组织沟通 Channel。

这不是换个名字，而是产品重心不同：

```text
Channel 代表业务入口。
Conversation 代表一次业务任务。
Thread 代表任务执行现场。
```

设计特色：

- Channel 是左侧的一级对象，视觉上像“信号频段”，不是普通菜单。
- Channel 展开后，会话列表嵌在其下方，形成“当前信号源下的任务队列”。
- 会话元信息使用 `channel · cloud id · time · count`，强化它来自真实业务会话。
- 侧栏滚动时，账户入口永远留在底部，像工作台的固定身份锚点。

视觉细节：

```text
selected channel:
  background: barely lifted graphite
  left icon: hash / channel glyph
  count: right aligned, muted
  no border unless focused by keyboard

expanded conversation:
  padding-left: channel text start + 24px
  title: one line, 13px
  meta: 11px, low contrast
  row actions: hover only
```

### 3.2 Executive Thread

Zeus 的主区域不是 IM 聊天，也不是表单页，而是“高层决策线程”。

设计特色：

- Agent 长文输出像 briefing note，重视阅读结构。
- 用户消息像任务指令，短、右侧、低干扰。
- Thinking / Tool timeline 是可展开的执行痕迹，不能抢占最终回答。
- Evidence 是可信度入口，默认轻量，必要时展开。

主线程应该看起来像：

```text
minimal title
  -> user instruction
  -> agent briefing
     -> optional execution trace
     -> optional evidence
  -> composer
```

而不是：

```text
large card
  -> nested card
    -> debug panel
      -> tool dump
```

阅读面细节：

- Agent 回复默认不放在厚卡片里，而是放在一个“阅读面”上：轻微抬升、细边界、暗色透气。
- Markdown heading 不能像网页文章标题那么大，应该像内部 briefing 小标题。
- 表格是决策信息，需要清楚但不重：细线、低对比表头、横向滚动。
- 重要结论可以使用 subtle callout，但不能大面积高亮。

### 3.3 Evidence-aware Execution

Zeus 的强大感来自“我知道 Agent 在做什么”，不是来自按钮多。

执行态必须有三层：

| 层级 | 默认显示 | 展开后 |
|---|---|---|
| Answer | 最终回答 | Markdown 全量内容 |
| Trace | Thinking / Tool 摘要 | Tool 参数、结果、耗时、状态 |
| Evidence | 来源和执行证据摘要 | 原始证据、调用链、审计信息 |

设计特色：

- Trace 默认是细小折叠行，不是大气泡。
- Tool card 像“运行记录”，不做彩色警示牌。
- Evidence 入口只在有证据时出现，避免空壳 UI。
- 状态用文字 + 轻量 icon，不用大面积颜色表达。

### 3.4 指令台 Composer

Composer 是 Zeus 的产品核心，应该像“指令台”，不是普通输入框。

特色结构：

```text
top typing plane
  + left context affordance
  + right send / stop
bottom status rail only when needed
```

细节：

- 空状态 Composer 位于主区域中上方，像启动一个任务。
- 会话中 Composer 固定在底部，像持续下达指令。
- 输入框圆角比普通控件更柔，但边界必须薄。
- Send / Stop 永远是同一个位置，不制造额外停止按钮。
- 内部对象名不进入 placeholder；placeholder 要像业务助理：
  `继续交代任务或补充信息...`

### 3.5 账户按钮

账户不是右上角装饰，而是工作台身份。

左下角账户按钮应同时承担：

- 当前用户身份。
- 设置入口。
- 退出入口。
- 用量 / 权限入口。

形态：

```text
avatar
name
chevron
```

点击后弹出紧贴左下角的菜单：

```text
user identity
account type / organization
Settings
Usage / permission
Log out
```

这会成为 Zeus 左侧栏的稳定收口，避免右上角散落用户信息。

---

## 四、关键屏幕设计

### 4.1 新会话首屏

目标：不要空，不要营销，不要像 demo。

构图：

```text
main surface center
  title: 今天要我先处理什么？
  composer: large command surface
  suggestions: 3-5 rows
```

尺寸建议：

| 对象 | 规格 |
|---|---|
| title | 28px / 600 / centered |
| composer width | 720-940px |
| composer height | 136-156px |
| suggestion row | 36px height, no card |
| vertical position | viewport top 28%-34% |

建议任务文案应该贴近 1688 员工工作：

- 梳理今天的业务风险。
- 把这段聊天整理成待办。
- 根据会议记录生成纪要。
- 帮我拆一个执行方案。
- 查一个业务问题的证据链。

禁止：

- “选择一个会话，或直接发送消息创建真实云端会话”这类工程说明。
- 大面积空黑页。
- 连接插件、连接文件之类非当前主价值卡片。

### 4.2 会话加载屏

当前选中会话后，不应该出现孤立 loading 气泡。

推荐：

```text
thread title appears immediately
below title:
  two-line skeleton aligned to agent message start
composer disabled with muted placeholder
```

视觉：

- skeleton 宽度 320px / 220px，像内容将要出现。
- 点状 loading 可以放在 skeleton 行尾，但不能成为主视觉。
- loading 超过 600ms 才显示文字；短请求只做淡入 skeleton。

文案：

```text
正在载入这段会话
```

不使用：

```text
正在加载会话
Loading conversation
Cloud Runtime
```

### 4.3 已有会话屏

目标：像一个稳定的执行现场。

布局：

```text
title row: compact, left aligned
message stream: max-width controlled
composer: bottom, same width as readable thread
```

尺寸建议：

| 对象 | 规格 |
|---|---|
| thread left padding | 48-64px |
| readable width | 840-1040px |
| user message max width | 420px |
| agent message max width | 860px |
| composer width | min(1040px, available - 96px) |
| bottom safe gap | 24-32px |

消息排列：

- 用户消息靠右，但不要贴右边缘。
- Agent 消息靠左，和 title / composer 左边界形成视觉轴线。
- 长文本不应从屏幕左侧跨到右侧，必须限制阅读宽度。
- 线程滚动条只在主内容滚动，不让整个窗口乱滚。

### 4.4 自动化页面

自动化不是侧栏重复项。点击上方 Automations 后，主区域进入独立任务面。

桌面端应该借鉴 Web 端的信息结构，但做深色、紧凑、执行台化：

```text
title: Automation 运行台
summary tabs: 运行中 / 已暂停 / 已结束
automation cards:
  name + status + channel
  prompt
  schedule / stop condition / next run / last result
  metrics
  actions: edit / pause / run once / logs
```

特色：

- 卡片像运行账本，不像营销卡片。
- 状态色只用于状态点和短 tag。
- “展开执行流水”是二级动作，放在卡片底部右侧。

---

## 五、组件级设计细节

### 5.1 Sidebar

尺寸：

```text
width default: 300px
width min: 248px
width max: 420px
traffic light safe top: 52px
bottom account height: 52px
```

分区：

- Primary actions：固定在上方。
- Channels：可滚动主体。
- Account：固定在底部。

Hover 行为：

- 行背景淡入。
- 行动作从 0 opacity 到 1，不改变布局宽度。
- selected 行只改变背景和文字亮度，不加粗到发胖。

### 5.2 Divider

拖拽分隔条不是普通 border。

细节：

- 默认 1px 线。
- hit area 12px。
- hover 时显示 2px 柔和高亮。
- dragging 时主区域禁用文本选中。
- 双击恢复默认宽度。

### 5.3 Message

用户消息：

```text
label: hidden or very muted
surface: slightly lighter than background
border: subtle
radius: 18px
padding: 12px 14px
```

Agent 消息：

```text
label: Agent, 11px muted
content: 14px / 1.72
surface: none for normal paragraphs
tool/review/evidence: contained surfaces
```

消息进入：

- 180ms fade + 6px rise。
- 不做从左右飞入。

### 5.4 Tool / Thinking

Thinking 折叠行：

```text
small disclosure
label: Thinking / Tool timeline
status: running / completed / failed
tool count
```

展开后：

- 每个 tool 是一条 timeline row。
- 左侧细线连接执行步骤。
- 参数和结果默认折叠。
- 错误用低饱和红，不做红底块。

### 5.5 Popover

账户、更多操作、删除确认都使用同一 popover 语言：

- 深色半透明 surface。
- 18px radius。
- 1px low contrast border。
- 轻微 shadow。
- 菜单项高度 36-40px。
- destructive action 不常驻红色，只在 hover 或确认态强调。

---

## 六、品牌化但克制

Zeus Atlas 需要有自己的味道，但不能靠 logo 堆砌。

### 6.1 设计母题

建议母题：

```text
黑曜石工作台
  + 黄铜焦点
  + 冷钢边界
  + 象牙文本
```

对应含义：

- 黑曜石：稳定、安静、深度。
- 黄铜：决策焦点，不是装饰。
- 冷钢：系统边界、可执行、可信。
- 象牙文本：长时间阅读友好。

### 6.2 Signature Details

只保留少量能形成识别度的细节：

- Composer 顶部极细高光线，表达“指令台”。
- selected Channel 使用内凹感，而不是外发光。
- Agent briefing 的左侧可以有 1px 低对比执行线。
- Evidence / Tool 使用小型 monospaced tag。
- 账户按钮使用头像 + 姓名 + chevron，成为侧栏底部锚点。

禁止把特色做成：

- 大 logo。
- 大面积品牌色。
- 装饰性图案。
- 发光粒子。
- 复杂背景纹理。

### 6.3 Appearance 与主题系统

Zeus Atlas 必须支持黑白配色和用户自定义主题，类似 Codex 的 Appearance，但要更贴近 Zeus 的产品语义。

主题不是装饰面板，而是长时间办公产品的基础能力：

```text
Light / Dark / System
  + preset themes
  + black / white quick switch
  + custom color tokens
  + font controls
  + contrast / translucency controls
  + import / copy theme
```

#### 6.3.1 Theme Mode

必须支持：

| 模式 | 行为 |
|---|---|
| Light | 使用浅色工作台，适合白天办公和投屏 |
| Dark | 使用深色工作台，适合长时间任务处理 |
| System | 跟随系统外观 |

默认建议：

```text
System as app default
Dark as product preview default
```

设计约束：

- Light theme 不能只是把黑色反转成白色，要有独立的纸面层次。
- Dark theme 不能一味黑，要保留 graphite / surface / border 的层级。
- System 切换时，当前自定义主题的 light/dark 两套 token 都要保留。

#### 6.3.2 Preset Themes

内置主题建议：

| 名称 | 类型 | 说明 |
|---|---|---|
| Black | dark | 默认黑色专业模式，低色彩干扰 |
| White | light | 默认白色专业模式，适合白天办公 |
| Obsidian | dark | 默认深色，黑曜石工作台 |
| Paper | light | 默认浅色，干净纸面工作台 |
| Graphite | dark | 更中性的黑白灰，少品牌色 |
| Ivory | light | 更温和的浅色阅读主题 |
| High Contrast | both | 给复杂表格和投屏使用 |

Preset 只给起点，不锁死用户。

账户菜单必须提供 Black / White / System 快捷切换，完整 Appearance 面板负责进一步编辑两套主题。

#### 6.3.3 Custom Theme

用户可自定义的最小集合：

| 字段 | 说明 |
|---|---|
| Accent | 重点色，用于 focus、active、primary action、少量状态 |
| Background | 页面底色 |
| Foreground | 主文字颜色 |
| UI font | 界面字体 |
| Code font | 代码 / id / token 字体 |
| Translucent sidebar | 是否启用半透明侧栏 |
| Contrast | 0-100，调整 surface / border / muted text 的对比 |

不开放每个组件单独改色。自定义应通过三个核心颜色派生语义 token：

```text
background
  -> bg-0 / bg-1 / panel / surface
foreground
  -> text / text-soft / text-muted / text-faint
accent
  -> focus / active / primary / subtle accent
```

这样用户有自由度，但界面不会碎。

#### 6.3.4 Theme Editor

Appearance 页面结构建议：

```text
Appearance
  ├── Theme: Light / Dark / System
  ├── Live preview
  │   ├── sidebar sample
  │   ├── thread sample
  │   └── composer sample
  ├── Light theme
  │   ├── preset selector
  │   ├── accent / background / foreground
  │   ├── UI font / code font
  │   ├── translucent sidebar
  │   └── contrast
  └── Dark theme
      ├── preset selector
      ├── accent / background / foreground
      ├── UI font / code font
      ├── translucent sidebar
      └── contrast
```

细节：

- Preview 不能用代码 diff 假图；Zeus 应用自己的真实对象预览：Channel、会话行、Agent message、Composer、Tool tag。
- Light / Dark 两套配置并列存在，System 模式根据系统选择其中一套。
- 支持 `Import theme` 和 `Copy theme`，方便团队共享。
- 导入主题必须校验 contrast，低于可读阈值时给出提示并自动修正 muted text / border。

#### 6.3.5 黑白主题原则

黑白主题不是“无品牌”，而是 Zeus 的专业模式。

黑白主题要求：

- Accent 降低到最少，只用于焦点和可执行动作。
- Channel selected 使用灰阶内凹面。
- Composer 用柔和高光表达可输入状态。
- Agent briefing 更像文档阅读面，减少色彩干扰。
- 表格、Evidence、Tool tag 优先靠边界和字体层级区分。

黑白主题禁止：

- 用纯黑 `#000` 和纯白 `#fff` 作为大面积相邻区域。
- 所有组件只有 border 没有 surface 层次。
- selected / hover 只靠文字加粗。
- 为了“黑白”丢掉状态色；成功、危险、警告仍需要语义色，但面积要小。

#### 6.3.6 配置持久化

主题配置属于本地用户偏好，不进入云端认知。

建议对象：

```ts
type AppearanceMode = 'light' | 'dark' | 'system';

interface AppearanceTheme {
  readonly name: string;
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
  readonly uiFont: string;
  readonly codeFont: string;
  readonly translucentSidebar: boolean;
  readonly contrast: number;
}

interface AppearanceSettings {
  readonly mode: AppearanceMode;
  readonly light: AppearanceTheme;
  readonly dark: AppearanceTheme;
}
```

落地原则：

- Renderer 只消费 CSS variables。
- 设置页负责编辑和预览。
- Electron / local storage 负责本地持久化。
- 不把主题配置写入会话消息或云端任务上下文。

---

## 七、核心布局

### 7.1 App Shell

固定结构：

```text
Window
  ├── Full-height Sidebar
  │   ├── Window traffic-light safe area
  │   ├── Primary actions
  │   ├── Channel groups
  │   ├── Conversation list
  │   └── Account / Settings button
  ├── Resizable divider
  └── Main task surface
      ├── Minimal thread title
      ├── Thread event stream
      └── Composer
```

约束：

- 侧栏必须通顶，不被顶部 header 截断。
- 顶部不能做厚重 header；除了 macOS traffic lights 和必要账户状态，主视觉应留给任务线程。
- 主区域默认不做整页卡片，不做后台面板。
- 左右分栏之间的 divider 必须可拖动，并有细微 hover affordance。
- Main surface 的内容宽度受控，避免消息气泡漂在无限宽黑幕里。

### 7.2 首屏空状态

新会话不能是空白页。

推荐结构：

```text
中央问题标题
  + 大号 Composer
  + 3-5 个轻量建议任务
```

约束：

- 标题必须像任务邀请，不像产品广告。
- 建议任务是文本行或轻量按钮，不做厚卡片。
- Composer 是首屏视觉核心，位置靠中上，不贴底。
- 当进入真实会话后，Composer 回到底部。

---

## 八、侧栏规则

### 8.1 信息结构

侧栏不是项目列表，也不是后台菜单。它只承载：

- 新会话。
- 搜索。
- 插件。
- 自动化入口。
- Channel。
- 当前 Channel 下的会话列表。
- 账户 / 设置入口。

Channel 替代 Codex 的 Project：

```text
Channels
  ├── 单人
  ├── 钉钉
  ├── 单聊
  ├── 群聊
  ├── 圆桌
  └── 分享
```

约束：

- 不显示“全部”，除非产品语义明确需要总入口。
- 不重复展示同一分类，例如上方有“自动化”入口时，Channel 列表不再重复“自动化”。
- Channel 点击后展开其会话列表；数字是计数，不加多余箭头图标。
- 会话数据必须来自真实接口，不 mock “置顶”。

### 8.2 会话行

会话行结构：

```text
pin affordance
title
metadata: channel · id · time · count
row actions on hover: pin / delete
```

约束：

- 删除会话绑定到左侧 row hover，不放在主线程右上角。
- 固定功能绑定到左侧 row hover，不做常驻强图标。
- 非 hover 状态下，行内动作尽量隐藏，避免列表显脏。
- selected 状态只需要低对比面，不要强描边大卡片。

---

## 九、线程规则

### 9.1 线程是主界面

线程承载：

- 用户消息。
- Agent 回复。
- Thinking / Tool timeline。
- Human confirmation。
- Evidence。
- Markdown 内容。
- Artifact / image / file。

约束：

- 不把治理、上下文、代理状态做成输入框下面的管理区。
- 不在主线程右上角放“删除会话 / 停止”等脱离对象归属的按钮。
- 停止动作绑定 Composer 右侧按钮。
- 删除 / 固定动作绑定侧栏会话对象。

### 9.2 消息视觉

消息不是普通 IM 气泡，也不是后台卡片。

建议：

- 用户消息靠右，窄、轻、低干扰。
- Agent 消息靠左，宽度可读，承载 Markdown 和执行事件。
- Agent 内容不需要每段都套卡；只有 Tool / Review / Evidence / Artifact 需要明确容器。
- Thinking 默认折叠，只显示状态摘要；展开后再显示 timeline。

### 9.3 Markdown

Markdown 是主能力，不是附加能力。

必须支持：

- 标题。
- 段落。
- 列表。
- 粗体。
- 引用。
- 代码。
- 表格。
- 图片链接。
- 内联 HTML-like legacy token 的安全降级显示。

表格规则：

- 表格应横向可滚，不撑破消息容器。
- 表头低对比加权。
- 单元格边界用细线，不用强底色。
- 数字和短标签要保持扫描性。

---

## 十、Composer 规则

Composer 是任务入口，不只是输入框。

结构：

```text
Textarea
  + attach / context affordance
  + send / stop button
```

约束：

- 空状态 Composer 可以大；会话中 Composer 应贴近底部，保持稳定。
- 圆角柔和，不能像硬矩形，也不能像过度胶囊。
- 边框低对比，背景比页面亮一档。
- Send 与 Stop 是同一个位置的状态切换。
- 不允许在 Composer 上方放 Agent selector；默认就是 CEO Agent。
- Placeholder 用业务语义，不出现 Cloud Runtime、CEO Agent Runtime 等内部对象名。

---

## 十一、状态与动效

### 11.1 Loading

会话切换 loading 不应该是孤立的丑气泡。

推荐表现：

```text
保持目标会话标题
  + thread skeleton / subtle loading row
  + composer disabled
```

约束：

- 不显示巨大 loading 卡片。
- 不显示工程化文本。
- loading 应在 120-220ms 内淡入，避免一闪而过。
- 数据回来后自动滚到底部。
- 快速切换会话时，旧请求不能覆盖新会话。

### 11.2 Streaming

流式输出时：

- Assistant 消息应在内容区增量出现。
- Thinking 只放工具过程和推理摘要，不吞掉最终回答。
- Composer 右侧按钮切换为 Stop。
- 停止后保留已输出内容和停止状态。

### 11.3 Motion

动效原则：

- 只用于状态变化、展开收起、消息进入。
- 位移小于 12px。
- 时长优先使用 140ms / 220ms / 360ms。
- 所有动效尊重 `prefers-reduced-motion`。

禁止：

- 弹跳。
- 大幅缩放。
- 闪烁描边。
- 大面积渐变扫光。

---

## 十二、视觉 Token

### 12.1 颜色

主调：

```text
background: near black
surface: dark graphite
line: low-opacity warm gray
text: warm off-white
accent: restrained gold / steel, only for focus or status
```

约束：

- 不做单一紫蓝调。
- 不做大面积金色。
- 不做科技感霓虹。
- 不用红绿黄作为装饰，只用于真实状态。

主题 token 必须分两层：

```text
base user tokens:
  --za-user-accent
  --za-user-background
  --za-user-foreground

derived semantic tokens:
  --za-bg-0
  --za-bg-1
  --za-panel-1
  --za-surface-0
  --za-surface-1
  --za-line
  --za-line-strong
  --za-text
  --za-text-soft
  --za-text-muted
  --za-accent
  --za-accent-soft
```

实现规则：

- 组件只能使用 semantic tokens，不能直接读用户输入色。
- 用户改 Accent / Background / Foreground 后，由主题引擎派生 semantic tokens。
- Dark / Light 两套 token 同时存在，用 `[data-theme="dark"]` / `[data-theme="light"]` 或等价机制切换。
- Contrast slider 不直接改文字大小，只调整 surface、line、muted text 的透明度和亮度距离。
- Translucent sidebar 只影响 sidebar surface，不改变主线程阅读面的稳定性。

黑白主题建议初始值：

| Theme | Accent | Background | Foreground |
|---|---|---|---|
| Black Dark | `#ECECE6` | `#080808` | `#F4F4F0` |
| White Light | `#111111` | `#FFFFFF` | `#141414` |
| Obsidian Dark | `#CDB77A` | `#07080A` | `#F2F2EF` |
| Graphite Dark | `#D7D7D2` | `#08090B` | `#F4F4F1` |
| Paper Light | `#1F2937` | `#F4F2EC` | `#101114` |
| Ivory Light | `#6B5A36` | `#F8F5EC` | `#15130E` |

### 12.2 字体

字体栈：

```text
SF Pro Text
PingFang SC
Inter
system-ui
```

规则：

- 默认正文 13px-14px。
- 侧栏主文本 13px。
- 元信息 11px-12px。
- 页面标题 20px-28px，仅空状态或重要标题使用。
- 字重少用 700；常规界面用 400 / 500 / 600。
- 不使用负 letter-spacing。

### 12.3 圆角

圆角分层：

| 对象 | 建议 |
|---|---:|
| small control | 10px |
| sidebar row | 12px |
| message / tool card | 16px |
| composer | 22px-28px |
| popover | 18px |

圆角不能一刀切。输入框可以更柔，列表行要更克制。

### 12.4 间距

基础节奏：

```text
4 / 8 / 12 / 16 / 20 / 24 / 32
```

约束：

- 左侧列表密度要高于主线程。
- 主线程要给阅读留白，但不能让消息漂浮。
- 空状态可以更大留白，真实会话必须高效。

---

## 十三、禁止项

这些以后默认不能再出现：

- 顶部厚 header。
- 右上角发布、运行、退出、状态 chips。
- 主线程右上角删除会话。
- Composer 上方 Agent selector。
- “本地能力代理”“Cloud Runtime”等内部工程文案进入用户主流程。
- 输入框下面的上下文调试面板。
- mock 置顶。
- Channel 中重复的自动化。
- 常驻删除图标污染会话列表。
- 所有内容都套卡片。
- 大面积空黑页。
- loading 独立丑气泡。
- AI 味很重的渐变、发光、装饰 blob。

---

## 十四、实现治理

后续所有 UI 改动必须先过这份清单：

1. 这个元素属于哪个对象：Channel、Conversation、Thread、Message、Composer、Account，还是内部调试？
2. 如果是内部调试，默认不能进主流程。
3. 它是否和 Codex-like 的任务线程结构一致？
4. 它是否复用现有 token，而不是写一次性颜色 / 圆角 / 阴影？
5. 它是否有 empty / loading / hover / selected / disabled / streaming 状态？
6. 它是否能在 1280px 和宽屏下保持对齐？
7. 它是否让用户更快完成任务，而不是只是看起来功能多？

文件治理：

- 大组件继续拆分为 Shell、Sidebar、Thread、Composer、Message、Markdown、Account、Automation。
- 样式按模块拆分，但 token 只能在全局 token 文件定义。
- 新增视觉模式必须先进入本设计文档或相邻设计文档。
- 不允许为了一个状态把逻辑塞回大文件。

---

## 十五、重构顺序

建议下一轮 UI 治理按这个顺序推进：

1. **删减主流程噪音**：确认所有内部工程文案、调试面板、重复入口都已消失。
2. **重做 App Shell**：侧栏通顶、divider 可拖、账户设置融合在左下。
3. **重做空状态**：中央标题 + 大 Composer + 轻建议任务。
4. **重做侧栏密度**：Channel 展开逻辑、会话行 hover actions、selected 态。
5. **重做线程布局**：消息宽度、Markdown、表格、Thinking 折叠、loading 过渡。
6. **重做 Composer**：统一输入框、send/stop、disabled/streaming 状态。
7. **视觉 QA**：用截图逐屏检查对齐、字号、圆角、暗色层次和滚动状态。

这份文档是后续所有视觉实现的基线；如果实际 UI 和本文冲突，先改 UI，除非产品判断明确更新本文。
