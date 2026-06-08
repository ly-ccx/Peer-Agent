# Zeus Atlas i18n 架构设计

> 状态：第一版工程契约  
> 目标：让中英文能力成为客户端运行态的一部分，而不是散落在 UI 组件里的翻译字典。

---

## 一、核心判断

Zeus Atlas 的 i18n 不是普通多语言文案工程。

它需要同时服务三类对象：

- 一线小二和业务用户看到的中文产品表达。
- 国际化、研发、协议和诊断场景需要的英文表达。
- 端云运行态里必须稳定的系统对象名。

所以本项目采用：

```text
中文优先表达业务语义。
英文保留工程对象语义。
locale 进入 session / manifest / evidence。
```

这意味着：

- `Runtime Projection`、`Manifest`、`Tool Call`、`Evidence`、`SDK`、`MCP` 这类协议对象名默认保留英文。
- 面向用户的任务、按钮、确认、能力说明、Evidence 摘要默认支持中文。
- 不允许在组件里用零散 if/else 做中英文切换。

---

## 二、locale 来源

第一阶段 locale 来源：

```text
Electron main
  → session store
    → ClientBootstrap
      → renderer
        → task thread / UI / evidence display
```

优先级：

1. 未来的用户或组织设置。
2. 当前客户端环境变量 `ZEUS_ATLAS_LOCALE`。
3. 系统语言。
4. 默认 `zh-CN`。

Renderer 可以读取 browser preview locale 作为开发预览兜底，但真实客户端的事实源必须是 `ClientBootstrap.session.locale`。

---

## 三、协议对象

i18n 必须进入协议层，而不是只进入 UI 层。

第一阶段协议对象：

```text
LocaleCode = zh-CN | en-US
LocalizedText = Partial<Record<LocaleCode, string>>
ClientSessionState.locale
ClientBootstrap.availableLocales
CapabilityManifest.localizedName
CapabilityManifest.localizedDescription
Evidence.locale
```

设计含义：

- Session 决定本次客户端展示语言。
- Manifest 可以声明多语言能力名和能力说明。
- Task thread 从 session locale 解析展示文案。
- Evidence 记录生成语言，避免审计和回放时丢失上下文。

---

## 四、术语边界

不是所有词都应该翻译。

### 4.1 保留英文的系统对象

这些对象是协议和工程边界，默认保留英文：

- `Cloud CEO Agent Runtime`
- `CU Proxy`
- `Capability Provider`
- `Manifest`
- `Runtime Projection`
- `Tool Call`
- `Evidence`
- `SDK`
- `Plugin`
- `MCP`

### 4.2 翻译为中文的用户表达

这些内容面向用户，应该跟随 locale：

- Sidebar / Header / Composer。
- Review card。
- Tool call 状态。
- 本地能力说明。
- 访问级别。
- Evidence 摘要。
- 错误和降级提示。

---

## 五、运行时链路

```text
Capability Provider
  → Manifest(localizedName/localizedDescription)
    → Runtime Projection(locale)
      → Client Tool Call(displayName/reason)
        → Permission Review(localized)
          → Local Execution
            → Evidence(summary + locale)
```

关键点：

- 能力名不是 UI 自己翻译，而是从 Manifest 本地化字段解析。
- 工具调用原因不是随便拼字符串，而是由 task-thread 按 session locale 生成。
- Evidence summary 由执行适配层按 locale 生成，并带回 `Evidence.locale`。
- 回放历史任务时，应优先按 Evidence 自身 locale 展示原始证据，再允许用户切换查看翻译版。

---

## 六、工程模块

第一阶段新增：

```text
packages/i18n
  → resolveLocale
  → createI18n
  → shared resources
  → capability localize helper
```

模块边界：

- `packages/i18n` 只做文案、术语和 locale 解析，不持有业务状态。
- `packages/protocol` 定义 locale 和本地化字段。
- `packages/task-thread` 基于 session locale 生成任务线程文案。
- `packages/ui` 基于 locale 渲染按钮、状态、Review card。
- `apps/desktop/electron/main` 持有真实 session locale。

---

## 七、第一阶段范围

必须支持：

- `zh-CN` 和 `en-US`。
- 客户端启动时返回 `ClientBootstrap.availableLocales`。
- local health 能力的中英文名称和说明。
- Review card、Tool call card、Evidence summary 的中英文展示。
- Evidence 携带生成语言。

暂缓：

- 在线语言包下载。
- 业务团队自定义术语包。
- 每个组织的术语覆盖。
- 云端动态翻译历史 Evidence。
- 复杂 ICU plural rules。

这些暂缓项后续可以加，但第一阶段先保证主链路有语言边界。
