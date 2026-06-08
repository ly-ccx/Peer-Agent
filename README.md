# Zeus Atlas

Current development version: `0.0.1`.

Zeus Atlas 是面向 Zeus / Xiaoer 体系的桌面端客户端工程。

它不是一个本地 Agent，也不是把云端 CEO Agent Runtime 下沉到用户机器。它的工程定位是：

```text
Electron Rich Client Shell
  + Local Capability Runtime
  + Cloud CEO Agent Runtime
```

其中：

- Electron Shell 负责 Codex-like 的任务线程、Composer、Review card、项目索引和桌面体验。
- Local Capability Runtime 负责本地能力声明、授权、执行、Evidence 和审计。
- Cloud CEO Agent Runtime 继续负责认知、规划、调度、工具选择、云端治理和最终解释。

## Design Source

本仓库的设计源头来自：

- `/Users/liangyin/Documents/MiaoYan/xiaoer_design/knowledge/definition/2026-05-12-客户端版小二助手产品与实现方案.md`
- `/Users/liangyin/Documents/MiaoYan/xiaoer_design/knowledge/definition/2026-05-12-端云能力边界与扩展接入协议详设.md`
- `/Users/liangyin/Documents/MiaoYan/xiaoer_design/knowledge/definition/2026-05-12-端云安全边界与能力分级契约-v0.1.md`
- `/Users/liangyin/Documents/MiaoYan/xiaoer_design/behavior/agent-design-philosophy-from-defense-to-enablement.md`
- `/Users/liangyin/Documents/MiaoYan/xiaoer_design/knowledge/experience/从Harness到认知操作系统.md`

## Architecture Docs

- [工程哲学](./docs/architecture/00-engineering-philosophy.md)
- [工程结构设计](./docs/architecture/01-project-structure.md)
- [i18n 架构设计](./docs/architecture/02-i18n-architecture.md)
- [Codex.app 参考架构](./docs/architecture/03-codex-app-reference-architecture.md)
- [BUC OAuth2.1 登录架构](./docs/architecture/04-buc-oauth-authentication.md)
- [客户端 Chat 能力补齐实施设计](./docs/architecture/05-chat-parity-client-implementation.md)
- [版本管理](./docs/architecture/06-version-management.md)
- [客户端端云能力补齐完成审计](./docs/architecture/07-client-cloud-parity-completion-audit.md)
- [生产 E2E 验收 Runbook](./docs/architecture/08-prod-e2e-validation-runbook.md)
- [0.0.1 高风险写入范围裁剪](./docs/architecture/09-high-risk-write-scope.md)
- [客户端运行态云端合约交接](./docs/architecture/11-client-runtime-cloud-contract-handoff.md)
- [dev/0.0.1 评审摘要](./docs/architecture/12-dev-0.0.1-review-summary.md)
- [云端后端合约任务单](./docs/architecture/13-cloud-backend-contract-tasklist.md)

## First Milestone

第一阶段目标不是完善 SDK，也不是一次性做完整本地安全核心。

第一阶段目标是跑通：

```text
Codex-like Desktop Shell
  + protocol contracts
  + client bootstrap
  + capability registry
  + local access level
  + real empty task state
  + one local health capability
```

只有当本地能力真的进入文件、MCP、Plugin、命令或本地个人经验时，Local Capability Runtime 才进入高信任执行路径。

## Current Scaffold

当前代码不在 renderer 里伪造运行态数据：

- Renderer 启动时通过 `bootstrap:get` 获取本地 session 和能力清单。
- Electron main 持有本地 session store、capability registry、project index、权限审批入口和 Rust core adapter。
- Capability registry 从 `capabilities/*.json` 读取真实 Manifest，而不是前端常量。
- Project index 从当前 workspace、package.json 和 git status 读取真实项目与变更状态。
- Cloud Runtime 状态从 `ZEUS_ATLAS_CLOUD_GATEWAY_URL` 判断；未配置时不会伪装成已连接。
- BUC 登录通过 OAuth2.1 PKCE 接入，token 只在 Electron main 内处理，不暴露给 renderer。
- 没有来自 Cloud CEO Agent Runtime 的 task thread 时，主界面只展示真实空态和 bootstrap 事实，不再伪造本地 health 任务。
- i18n 由 `ClientBootstrap.session.locale` 驱动，能力名、运行态空态、认证状态和项目索引支持 `zh-CN` / `en-US`。
- 第一条能力只允许 `local.health`，它不会读取文件、不会调用 MCP、不会执行任意命令。

第一阶段仍然刻意不做完整 SDK、Plugin 安装、MCP lifecycle 和任意本地工具执行。

## Development

当前本机全局 `pnpm` 可能较旧，建议先用项目声明的 pnpm 版本：

```bash
npx --yes pnpm@10.22.0 install
npx --yes pnpm@10.22.0 typecheck
npx --yes pnpm@10.22.0 build
cargo build --workspace
```

启动 renderer 预览：

```bash
npx --yes pnpm@10.22.0 --filter @zeus-atlas/desktop exec vite --host 127.0.0.1 --port 5173
```

启动 Electron 桌面壳：

```bash
VITE_DEV_SERVER_URL=http://127.0.0.1:5173 npx --yes pnpm@10.22.0 --filter @zeus-atlas/desktop exec electron .
```

配置 BUC 登录：

```bash
export ZEUS_ATLAS_BUC_ENV=prod
export ZEUS_ATLAS_BUC_CLIENT_ID=cbu-xiaoer-node-service
export ZEUS_ATLAS_BUC_REDIRECT_URI=http://127.0.0.1:16888/oauth/callback
export ZEUS_ATLAS_BUC_LOGOUT_BACK_URL=http://127.0.0.1:16888/logout/callback
export ZEUS_ATLAS_BUC_SCOPE="profile openid"
```

也可以从 `.env.example` 复制一份本地 `.env`。桌面 main 进程和 `prod-e2e:preflight` 会自动读取仓库根目录 `.env`，但不会覆盖 shell 中已经设置的变量。不要配置 `client_secret`。

桌面端使用 PKCE，不需要也不应该配置 `client_secret`。

配置 Cloud Chat Gateway：

```bash
export ZEUS_ATLAS_CLOUD_GATEWAY_URL=https://cbu-xiaoer-service.alibaba-inc.com
# Runtime Gateway 是独立 WS 入口，不要配置成 node-service。
export ZEUS_ATLAS_RUNTIME_GATEWAY_URL=wss://your-runtime-gateway-host
# 可选：默认 /api/chat/client-tool/result
export ZEUS_ATLAS_CLIENT_TOOL_RESULT_PATH=/api/chat/client-tool/result
# 可选：默认 /api/client/runtime/tasks/poll
export ZEUS_ATLAS_CLIENT_TOOL_POLL_PATH=/api/client/runtime/tasks/poll
# 可选：默认 /api/client/runtime/projection
export ZEUS_ATLAS_RUNTIME_PROJECTION_PATH=/api/client/runtime/projection
```

开发者模式请求预发 Cloud Gateway：

客户端内可通过左侧导航 `开发者模式` 页面或 `Cmd/Ctrl + Shift + D` 快速切换生产、预发和自定义地址；该设置保存在 Electron `userData`，优先级高于下面的环境变量。

```bash
export ZEUS_ATLAS_DEVELOPER_MODE=pre
# 可选：默认 https://pre-cbu-xiaoer-service.alibaba-inc.com
export ZEUS_ATLAS_PRE_CLOUD_GATEWAY_URL=https://pre-cbu-xiaoer-service.alibaba-inc.com
# 可选：预发 Runtime Gateway WS 入口，不配置时客户端不会连接 node-service 的 /runtime/ws
export ZEUS_ATLAS_PRE_RUNTIME_GATEWAY_URL=wss://your-pre-runtime-gateway-host
# 可选：SSE 直连预发地址，不配置时复用预发 gateway
export ZEUS_ATLAS_PRE_CLOUD_STREAM_URL=https://pre-cbu-xiaoer-service.alibaba-inc.com
```

关闭开发者模式只需要去掉 `ZEUS_ATLAS_DEVELOPER_MODE`，客户端会回到 `ZEUS_ATLAS_CLOUD_GATEWAY_URL`。

生产 E2E 前置检查：

```bash
npx --yes pnpm@10.22.0 prod-e2e:preflight
npx --yes pnpm@10.22.0 prod-e2e:probe-contract
npx --yes pnpm@10.22.0 prod-e2e:create-report --tester <work_id> --out docs/architecture/prod-e2e-report.<date>.json
npx --yes pnpm@10.22.0 prod-e2e:validate docs/architecture/prod-e2e-report.<date>.json
npx --yes pnpm@10.22.0 parity:completion-audit
```

BUC token 只保存在 Electron main 侧，renderer 通过 IPC 调用 Cloud Chat Gateway，不直接持有 token。

`parity:completion-audit` 必须保持阻塞，直到生产 `prod-e2e:probe-contract` 没有云端合约 blocker，且当前 HEAD 有真实生产 E2E pass 报告。

本仓库已在 `.npmrc` 配置 Electron 镜像：

```text
electron_mirror=https://npmmirror.com/mirrors/electron/
```
