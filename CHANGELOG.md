# Changelog

All notable changes to Peer Agent are tracked here.

## 0.0.1-beta.11 - 2026-06-24

### Added

- Workbench diff view resolves and opens cross-repo file paths; file path links in chat are clickable.
- Model configuration supports duplication for non-subscription providers.
- Anthropic xhigh reasoning tier maps faithfully to native `output_config.effort=xhigh` instead of folding into high.

### Changed

- Default workbench width increased from 420 to 600.
- Workbench auto-expands when a follow-up plan is created within the same conversation.
- Rounded corners on the updater modal mascot icon.
- Removed dead `targetRatio` / `keepRecentCount` code from context compaction (no behavior change).

### Fixed

- Path links are resolved by actual file existence, no longer mistaking git branch names or `org/repo` strings for clickable local paths.
- Goal plan panel scrolling: cards are no longer compressed, the body scrolls correctly, and the progress bar shows in the main card.

## 0.0.1 - Unreleased

Status: active development.

Scope:

- Initialize the Electron desktop shell.
- Add BUC OAuth2.1 PKCE authentication.
- Add client bootstrap, Cloud Runtime state, local session state, capability registry, and project index.
- Add `zh-CN` / `en-US` i18n scaffolding.
- Add architecture documents for engineering philosophy, project structure, i18n, Codex.app reference, BUC authentication, and Chat parity.
- Add protocol contracts for local capability execution.
- Add Chat parity protocol contracts for conversation, execution, channel, memory, and share.
- Add `chat-kernel` SSE parser, chat reducer, thinking reducer, confirmation reducer, message action gates, and tests.
- Add Electron main-side Cloud Chat Gateway and preload IPC surface for real conversation, message stream, execution, assistant, and agent APIs.
- Add renderer Cloud Chat Surface for real cloud conversations, streaming messages, Thinking / Tool timeline, and human confirmation review actions.
- Add Cloud Chat Gateway coverage for Web parity APIs: message mutation, branching, Working Memory, Memory Wiki, Billing, Thinking detail state, and Share.
- Add client-side Channel runtime filters for web, DingTalk direct/group, RoundTable, Automation, and Share conversations.
- Add minimal `client_tool_call` handling: local ToolCall card, permission approval, `local.health` execution, Evidence creation, and Cloud Gateway result reporting.
- Add client message operation surface for copy, branch, single-message share, truncate, message deletion, and conversation deletion against real Cloud Chat Gateway APIs.
- Add context panel parity for Memory Wiki status/pages/initialization and Share list/continue/revoke using real Cloud Chat Gateway APIs.
- Add Composer Agent runtime controls for real Agent list selection, assistant suggestions, and inline completion.
- Add rich message rendering for images, references, assistant actions, sender/skill metadata, and structured render data.
- Add user-triggered Runtime Projection publishing so local Capability Manifests are sent outbound to Cloud Gateway only after local consent.
- Add outbound Local Capability Proxy polling controls for client_tool_call tasks, keeping cloud-to-local work on a client-initiated connection.
- Add desktop Execution Inspector parity for real Cloud Execution status and COT event snapshots.
- Add P2 Cloud Governance bridge for Access, Automation, RoundTable, and Agent Evolution Patch APIs with a task-local governance panel.
- Add Cloud Observability bridge for message/conversation trace, Tool Call statistics, Thinking list, Memory Compile, and Agent Billing real APIs.
- Add per-message Cloud Inspector for real message detail, trace, Tool Calls, Thinking, and context APIs.
- Add Execution Inspector evidence for real execution detail, final result, and source-trace APIs.
- Add Execution Inspector controls for real execution list, related Shadow executions, and cancel APIs.
- Add Dispatch Review panel for real pending dispatch lookup and approve/reject confirmation APIs.
- Add Chat Statistics panel for real overview, trends, tool ranking, user ranking, and realtime statistics APIs.
- Add Chat Statistics cloud export bridge for `/api/chat/statistics/export`, with local JSON/CSV snapshot fallback when the cloud returns no artifact.
- Add Chat Statistics local export snapshots through Electron save dialogs using real cloud statistics data.
- Add Agent Studio panel for real OpenClaw scene, event, channel, channel session, and explicit enter APIs.
- Add OpenClaw Governance read-only directory panel for real catalog, identity, capability, memory evolution, release, alert, remediation, and effective-config APIs.
- Add Agent Memory Review panel for patch clues, memory candidates, simulation evals, training runs, Peer Agent backflow, and related Shadow execution review.
- Add read-only Channel Evidence panel for DingTalk, RoundTable, enterprise callback clues, and raw source metadata from real conversation/message data.
- Expand OpenClaw Governance read-only parity for service refs, memory workspaces/snapshots, model/credential/eval policies, schedules, human takeovers, and upgrade jobs.
- Add OpenClaw write-action gate matrix for real Governance and Studio POST surfaces, keeping high-risk writes blocked until policy, confirmation, audit, and Evidence contracts are wired.
- Add Agent Memory migration/simulation write-action gate matrix for real pre/local-only endpoints without exposing execution buttons.
- Add a client-cloud parity completion audit mapping the 0.0.1 goal to concrete artifacts, verification gates, and remaining blockers.
- Add executable `parity:audit` gate for client-cloud parity artifacts and blocked write-policy coverage.
- Add production E2E validation runbook, report template, and `prod-e2e:validate` report validator for live BUC/Cloud Gateway acceptance.
- Add `prod-e2e:preflight` to verify branch, version, BUC PKCE config, Cloud Gateway URL, redirect port, and desktop client_secret policy before production acceptance.
- Add `prod-e2e:create-report` to initialize a production acceptance report with the current branch, commit, tester work ID, and required check list.
- Add `.env.example` with non-secret BUC PKCE production E2E defaults and Cloud Gateway placeholders.
- Add local `.env` loading for Electron main and `prod-e2e:preflight` without overriding explicit shell variables.
- Add the 0.0.1 high-risk write scope decision: show gate matrices, keep execution buttons out of scope until cloud policy, confirmation, audit, idempotency, Evidence, and rollback contracts are ready.
- Tighten `prod-e2e:preflight` so production Cloud Gateway must use HTTPS.
- Tighten `prod-e2e:validate` so production reports must match the current `dev/0.0.1` HEAD commit.
- Redact the configured Cloud Gateway origin from successful `prod-e2e:preflight` logs.
- Reject obvious pre-release Cloud Gateway hosts in `prod-e2e:preflight`.
- Set the production Cloud Gateway default in `.env.example` to `https://cbu-xiaoer-service.alibaba-inc.com`.
- Add a non-authenticated Cloud Gateway reachability probe to `prod-e2e:preflight`.
- Fix the production Agent list/get endpoint mapping to use `api/xiaoerAiApi/agents/*` on `cbu-xiaoer-service`.
- Harden real conversation rendering for production empty/partial `thinkingProcess`, Working Memory, and Share payloads so malformed optional arrays render as empty states instead of crashing the task surface.
- Record the 2026-05-14 partial production smoke evidence and the remaining local proxy / OpenClaw governance backend blockers in the parity completion audit.
- Stop Local Capability Proxy polling after a production HTTP 404 so missing cloud endpoints are shown as a backend blocker instead of repeatedly hammering the gateway.
- Lazy-load collapsed Dispatch, Statistics, Observability, Governance, OpenClaw Studio, and Agent Memory Review panels so selecting a real conversation does not trigger non-primary cloud control-plane calls until the user expands or refreshes those panels.
- Add `prod-e2e:probe-contract` to check production Cloud Gateway contract readiness for local proxy polling, Evidence return, Runtime Projection, Chat Statistics export, OpenClaw Governance, and OpenClaw Studio endpoints before claiming full client-cloud parity.
- Surface the same cloud contract probe inside the Local Capability Proxy UI so backend route blockers are visible in the desktop task surface, not only in command-line diagnostics.
- Allow `prod-e2e:create-report --with-contract-probe` to embed the current cloud contract probe snapshot into the production acceptance report, and validate the optional snapshot shape.
- Tighten `prod-e2e:validate` so an embedded cloud contract probe with any missing, not implemented, server-error, unreachable, or unexpected endpoint class blocks production acceptance.
- Add `parity:completion-audit` to map the active goal to concrete artifact evidence and block completion while no current-head production E2E report validates successfully.
- Add the client runtime cloud contract handoff for backend routes required to unblock local proxy polling, Runtime Projection publish, Evidence return, and OpenClaw read readiness.
- Mark outbound client-tool Evidence as returned before posting it to the Cloud Gateway, and add a desktop unit test for the Evidence payload semantics.
- Convert local capability adapter exceptions into failed client-tool Evidence so execution failures can still be reported to the Cloud Gateway.
- Add a deny path for local client tool calls so rejected local execution creates denied Evidence and reports it to the Cloud Gateway.
- Add task-thread coverage for denied client-tool Evidence and make Evidence artifact event ids stable per evidence id.
- Extend the completion audit to require task-thread Evidence artifact coverage before the 0.0.1 parity goal can pass.
- Add a retry path for local client-tool Evidence return so a local-only result can be reported to Cloud Gateway without re-running the local tool.
- Add JSON and file snapshot output for the production cloud contract probe while preserving non-zero exits on blockers.
- Record the 2026-05-14 production cloud contract probe blocker snapshot for backend handoff diffing.
- Surface the latest cloud contract blocker snapshot in the completion audit while still blocking completion on missing production E2E acceptance.
- Carry the accepted Runtime Projection id into Local Capability Proxy polling so client-tool tasks are tied to the active cloud projection instead of only the local session.
- Extend the completion audit and cloud handoff document to require accepted Runtime Projection ids in Local Capability Proxy polling.
- Correct production contract probe runbook commands so `--json` and `--out` are passed to the probe script correctly.
- Add Electron main-side coverage for the Rust CU Proxy health stub Evidence path.
- Tighten completion audit validation for cloud contract blocker snapshots so required route ids, methods, paths, and blocker counts must match the probe contract.
- Share cloud contract probe blocker classes and expected route specs between the probe, completion audit, and prod E2E report validator.
- Add Electron main-side coverage for cloud contract probe classification, expected route specs, and local proxy route overrides.
- Block stale `prod-e2e:probe-contract -- --json/--out` runbook command forms in the parity audit.
- Add branch and version checks to the client-cloud completion audit.
- Link the cloud contract handoff and completion audit flow from the README entrypoint.
- Add a `dev/0.0.1` review summary with delivered client surfaces, verification commands, and remaining cloud blockers.
- Add a backend-facing cloud contract tasklist for the remaining Runtime Projection, client tool polling, Evidence return, and OpenClaw route blockers.
- Record the `cbu-xiaoer-node-service` backend implementation branch that starts closing the remaining cloud contract blockers.
- Anchor the client-cloud completion audit to the current client HEAD, backend implementation branch, and latest production contract blocker snapshot.
- Update backend handoff evidence to the `5c8272e` backend implementation code commit, which persists matched client-tool Evidence into the existing tool-call ledger, validates malformed client runtime payloads, and covers controller-level HTTP status propagation.
- Record backend `origin/master` head `9a4cdda`, which maps production contract probes to backend route and test evidence; production still reports six blockers until Aone deployment picks up the master change.
- Refresh the production cloud contract probe snapshot from the `dev/0.0.1` validation baseline, confirming production still has six cloud contract blockers before backend deployment.
- Add the client review summary text and backend merge/deploy handoff metadata to the `dev/0.0.1` review summary.

Release gate:

- `npx --yes pnpm@10.22.0 version:check`
- `npx --yes pnpm@10.22.0 --filter @peer-agent/chat-kernel test`
- `npx --yes pnpm@10.22.0 --filter @peer-agent/desktop test`
- `npx --yes pnpm@10.22.0 --filter @peer-agent/task-thread test`
- `npx --yes pnpm@10.22.0 typecheck`
- `npx --yes pnpm@10.22.0 parity:audit`
- `npx --yes pnpm@10.22.0 build`
- `cargo build --workspace`
