# Peer Frost 实现规范（UI Implementation Guide）

> 状态：实现治理 checklist（可执行）
> 适用范围：`apps/desktop/renderer` 下所有 UI / 样式改动。
> 关系定位：
> - 产品结构与视觉意图的权威文档是 `docs/architecture/14-product-design-language.md`（架构目录，只读）。
> - Token / 颜色 / 红线的**真源（source of truth）**是 `apps/desktop/renderer/src/styles/tokens.css` 文件头注释与变量定义。
> - 本文件不重新定义设计语言，只把"写代码时必须遵守的约束"固化成对照清单，避免每次改 UI 凭局部感觉拍脑袋。
>
> 若本文与 `tokens.css` 冲突，以 `tokens.css` 为准，并回头更新本文。

---

## 一、设计语言：Peer Frost

清晨冰面上的工具集 —— 冷玻璃 + 石墨 + 冰湖青。

```text
chrome 系列   = 环境层 (canvas / chrome)   冷感纯白   hue 210-220 sat 14-19%
paper 系列    = 内容层 (message / panel)   冷雪纸     hue 210-215 sat 10-13%
control 系列  = 控件层 (composer / fill)   冷感灰     hue 216-220 sat 16-19%
graphite 系列 = 文字阶                      中性偏冷石墨 hue 210-220 sat 5-14%
azure 系列    = 印记                        冰湖青     hue 200-205
state 系列    = 状态色                      全冷化；warn 与 confirm 同 hue 区，靠 icon+文案区分
```

历史：Vellum（朱砂 + 暖墨 + 羊皮纸）经过 v0.2 → v0.2.3 四次"去黄"仍无法满足冷感诉求，整套推翻重建为 Peer Frost（v1.0, 2026-05-27）。**不要再引入任何暖色 motif。**

---

## 二、8 条红线（不可逾越）

来源：`tokens.css` 文件头。任何一条违反都视为设计回归。

| # | 红线 | 实现含义 |
|---|---|---|
| 1 | **Azure 不上 CTA** | 主操作（CTA / primary button）一律用 `--graphite-base` 石墨填充 + 高对比文字阶，绝不用 `--azure-*` 做主按钮底色 |
| 2 | **H1 字号 ≥ 30px** | 页面级主标题不小于 30px |
| 3 | **Serif 中文标题不可去** | 重要标题用 `--font-serif-zh`（Noto Serif SC 等） |
| 4 | **单屏 azure ≤ 3 处** | 冰湖青是"印记"，整屏出现不超过 3 次 |
| 5 | **纯黑禁 / 纯白仅环境层** | 不写 `#000`、`#fff`、`rgba(0,0,0,…)`、`rgba(255,255,255,…)`；最深用 `--graphite-base`，纯白仅允许出现在环境层 token |
| 6 | **状态不只靠颜色** | 状态必须叠加 icon / 文案；warn 与 confirm 同 hue 区，仅靠颜色无法区分 |
| 7 | **阴影限定 2 场景** | 只用 `--shadow-popover`（浮层）和 `--shadow-drag`（拖拽）；不自造阴影值 |
| 8 | **圆角 ≤ 16px** | 用 `--radius-*`（最大 `--radius-xl: 16px`）；不写裸圆角数值 |

---

## 三、Token 体系与优先级

`tokens.css` 提供三套变量，**新代码只能用第 1 套正名 token**：

### 1. Frost 正名 token（新代码必须用）

```text
--chrome-*    环境层：canvas / raised / sunken / hover / active / hairline
--paper-*     内容层：base / sheet / sunken / hover / active
--control-*   控件层：composer / fill / fill-hover
--graphite-*  文字阶：base / base-hover / soft / fade / mute / hairline
--azure-*     印记：  seal / soft / trace（白名单使用，见红线 1、4）
--state-*     状态：  thinking / active-on / confirm / success / warn / danger / denied
```

间距 / 圆角 / 阴影：

```text
--space-1..16   4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 64
--radius-xs..xl 2 / 6 / 8 / 12 / 16
--shadow-popover  0 2px 12px rgba(26,29,33,.06)   （浅色）
--shadow-drag     0 4px 16px rgba(26,29,33,.10)   （浅色）
```

### 2. 兼容别名（已有代码可用，不要在新代码扩散）

```text
--surface-vellum-*  →  --paper-*
--ink-*             →  --graphite-*
--cinnabar-*        →  --azure-*
--za-*              →  Frost 值（18 个旧 CSS/TSX 文件继续消费）
```

这些别名的值已切到 Frost，旧文件零改动即可全冷化。维护旧文件时可沿用，但**不要在新组件里引入别名，也不要自造新硬编码**。

### 3. 多主题

- 暗色模式：`--shadow-popover/-drag` 用更深的 rgba（在 `:root` 暗色块内重定义），其余 token 同名切值。
- `[data-palette="catppuccin"]`：覆盖正名层 + `--za-*` 别名层，红线沿用 Frost（accent 不上 CTA）。
- 新增主题必须同时覆盖正名层与 `--za-*` 别名层（组件实际消费层），否则旧组件不会变色。

---

## 四、浮层 / 弹窗范式

参照既有范式 `image-preview-overlay`，不要每次新造：

```text
遮罩    冷调毛玻璃（backdrop-filter blur + 冷色半透明，禁用 rgba(0,0,0,…)）
卡片    --chrome-raised 底 + --chrome-hairline 描边 + --shadow-popover
圆角    --radius-xl (16px) 或更小
入场    复用全局关键帧 za-details-in / za-content-reveal / mcp-modal-* 等，勿自造
降级    必须响应 prefers-reduced-motion（全局已兜底，新动效需自检）
主操作  --graphite-base 填充；次操作描边（红线 1）
busy    保存中锁定遮罩关闭，防误关
```

---

## 五、字体 / 圆角 / 间距速查

```text
正文          13-14px
侧栏主文本     13px
元信息         11-12px
页面主标题      ≥30px（红线 2），用 --font-serif-zh（红线 3）
字重          常规 400/500/600，少用 700

圆角分层
  small control  10px / --radius-*           sidebar row 12px
  message/card   16px (--radius-xl)          composer 22-28px（输入框可更柔）
  popover        16-18px

间距节奏       4 / 8 / 12 / 16 / 20 / 24 / 32（--space-*）
```

---

## 六、改动前后纪律（每次必过）

改 UI 之前：

1. 这个元素属于哪个对象（Channel / Conversation / Thread / Message / Composer / Account / 设置 / 内部调试）？内部调试默认不进主流程。
2. 找仓库里的权威基线对照，而不是新造：
   - 规范面板：`LlmSettingsPanel`
   - 浮层范式：`image-preview-overlay`
   - token 真源：`tokens.css`
3. 是否复用现有 token，而不是写一次性颜色 / 圆角 / 阴影？
4. 是否覆盖了 empty / loading / hover / selected / disabled / streaming 状态？

改 UI 之后（验证）：

5. 括号/标签配平（CSS `{` `}` 计数、JSX 标签）。
6. grep 残留硬编码：`#fff` / `#000` / `rgba(0,0,0` / `rgba(255,255,255` / 裸圆角 / 裸阴影。
7. `pnpm typecheck` + `pnpm build`（或对应脚本）通过。
8. 截图自检：对齐、字号、圆角、层次、暗色、滚动态。

---

## 七、常见回归对照表

| 症状 | 错误写法 | 正确写法 |
|---|---|---|
| 主按钮发蓝 | `background: var(--azure-seal)` 做 CTA | `background: var(--graphite-base)`（红线 1） |
| 硬编码白卡 | `background: #fff` | `var(--chrome-raised)` / `var(--paper-sheet)` |
| 硬编码遮罩 | `rgba(0, 0, 0, .28)` | 冷调毛玻璃 + 冷色半透明（红线 5） |
| 自造阴影 | `box-shadow: 0 1px 2px rgba(0,0,0,.08)` | `var(--shadow-popover)`（红线 7） |
| 裸圆角 | `border-radius: 20px` 列表行 | `var(--radius-lg)` 等 ≤16px（红线 8） |
| 标题用黑体 | 默认 sans 大标题 | `font-family: var(--font-serif-zh)`（红线 3） |
| 只用颜色表状态 | 仅红/绿色块 | 颜色 + icon + 文案（红线 6） |

---

> 维护：当 `tokens.css` 新增 token、调整红线或新增主题时，同步更新本文第三、五节。本文是实现侧对照清单，设计意图变更仍以 `docs/architecture/14-product-design-language.md` 与 `tokens.css` 为准。
