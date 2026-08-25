# Changelog

All notable changes to Peer Agent are tracked here.

## Unreleased

## 0.0.8 - 2026-08-25

### Notes

- Stable release that turns the workbench into a cross-task radar: home shows Needs you / Peer advancing / Unread. A finished Goal is terminal — no extra result-ready acceptance bucket.
- Empty inbox fills the main column. Isolated tasks merge the worktree back on completion; unisolated work skips the handoff gate.
- Start a new task from a workspace row. The source-branch picker can search, group, and create branches.
- CLI agent loops are unbounded like Desktop. Docs changelog is generated from `release-notes/v0.0.8.md`.

### Added

- Empty workbench radar surface that stretches the main column when nothing needs you.
- Isolated complete-and-merge: isolated worktrees merge to the target branch on Goal completion.
- New-task action on a workspace row (context menu / hover plus).
- Source-branch search, grouping, and local-branch create in the composer picker.
- Isolation glyph on isolated task lines.

### Changed

- Home workbench drops leftover result-ready / acceptance buckets; pulse keeps need/run only.
- Plan titles follow intent, not the first utterance.
- Sidebar Workbench badge shows the needs-you count only.
- Mode and access sit before branch chrome.
- Composer returns to the source capsule after handoff; Worktree toggle is the next-run preference.
- Isolation cannot be toggled while a task is running.
- Attachments render as media tiles and document cards.

### Fixed

- Resume the current turn after a stream or network failure.
- Interactive CLI and Goal workers no longer inherit a 64-turn cap.
- Other workspace groups stay open when switching sessions.
- macOS traffic lights are centered in the 40px titlebar; the app icon fills the squircle.
- Sidebar selection fill follows the conversation, not the whole workspace group.
- Nested workspace shadows no longer clip; context-usage popover shadow restored.
- Overview-list jank and tray/CLI main-thread stalls.
- Shared new-task drafts clear after send; incomplete evidence can be force-archived.

### CLI

- First-class CLI archives remain `peer-darwin-arm64.tar.gz` and `peer-linux-x64.tar.gz`.
- Install with `npm i -g @peer-agent/cli@latest`; `postinstall` downloads this release's archive.

## 0.0.7 - 2026-08-25

### Notes

- Stable release that splits workspace HEAD from the conversation task line, lets new tasks pick a source branch, and shows prior Goals on the result view.
- Sidebar conversations are flat list rows; workspace names take the first line and the path moves under them.
- CLI adds Fast mode; narrow TUI Goal summaries become a Now Playing row.
- Docs changelog is generated from `release-notes/v0.0.7.md`.

### Added

- Draft composer source-branch picker that saves the workspace source without checking out git.
- Composer / header chrome that shows workspace HEAD separately from the task line or isolation mark.
- Prior Goals on the task result view (status, completed work, files already touched).
- CLI Fast mode for ChatGPT / Grok OAuth (`service_tier=priority` when admission and the flag are on).
- TUI compact Goal row restyled as Now Playing.

### Changed

- Sidebar conversation rows are a flat fill with the pin in the trailing actions, not a lifted capsule.
- Workspace name uses the full first line; path stacks on the second line.
- Sidebar titles use `--ui-font-control` so they follow appearance font-scale at chrome size.
- Opening a conversation lands on the latest messages.
- Startup loads a short workspace task preview instead of fetching every conversation for counts.
- Large diffs virtualize file-index hover; TUI streaming drops the 32ms delta buffer.
- TUI activity uses a stable `working...` highlight sweep.

### Fixed

- Missing `evidenceRefs` on historical Goals no longer crash the renderer.
- Same-workspace Goal bindings no longer leave isolation or the composer chip on a stale HEAD.
- Stale Goal handoff is not treated as an empty model reply.
- CLI prompt-cache hits survive split Responses usage details.
- Unused workspace avatar badges are removed.

### Release

- Desktop: install the platform asset from the `v0.0.7` GitHub Release.
- CLI / TUI: `npm i -g @peer-agent/cli@latest` or `npm i -g @peer-agent/cli@0.0.7`.

## 0.0.6 - 2026-08-23

### Notes

- Stable release that treats acceptance as a sign-off pack, keeps new tasks on the current workspace, and isolates to a worktree only when the user opts in.
- Workbench home is a list + detail split with independent column scrolling.
- CLI ships Linux x64 archives; `peer exec` drives Goal plans created in that run to a terminal state.
- Docs changelog is generated from `release-notes/v0.0.6.md`.

### Added

- Acceptance sign-off pack: criteria, repo changes, leftover gates, and an Evidence close gate before one-click accept.
- Task branches from the workspace base, with optional worktree isolation and a visible bound-branch line.
- Workbench split layout (list + detail), conversation-grouped home cards, and independent column scroll.
- Composer occupancy ring opens a provider-scaled request-composition breakdown.
- Headless browser tool execution when the panel is closed.
- First-class Linux x64 CLI archive `peer-linux-x64.tar.gz`; npm postinstall downloads it on linux-x64.
- `peer exec` attaches the Goal Runner to plans it created and waits for a terminal or human-stop state.

### Changed

- New tasks stay on the chosen workspace; worktrees stay off until the conversation opts in.
- Sidebar conversation rows are denser; the leading pin follows the row padding token.
- Thinking uses the weaving orb; the trailing chevron appears on hover only.
- Drop Cloud CEO and Enterprise copy from Desktop and TUI.

### Fixed

- Result drawer open no longer focuses/scrolls a message.
- Removed workspaces no longer resurface; sibling workbench cards stay stable under concurrent tasks.
- Grok OAuth keeps scope when reading shared credentials.
- Updater install button stays alive across rechecks and sleep.
- Error-boundary reload text is readable in dark theme.
- Windows / Linux no longer reserve macOS traffic-light space.

### Release

- Desktop: install the platform asset from the `v0.0.6` GitHub Release.
- CLI / TUI: `npm i -g @peer-agent/cli@latest` or `npm i -g @peer-agent/cli@0.0.6`.

## 0.0.5 - 2026-08-19

### Notes

- Stable release that graduates the `0.0.5-beta.1`–`0.0.5-beta.4` Goal workbench, review drawer, and headless CLI.
- Group pending reviews by Goal Thread on the global workbench; the result drawer reuses the current conversation and can accept a whole thread.
- Open workbench artifacts in a remembered editor with syntax highlighting; keep review cards until delivery finishes.
- Add headless `peer exec` with provider-aware model disambiguation and no default turn cutoff.

### Added

- Goal Thread grouping on the global workbench, flattened into a sibling list, with jump-to-message from a round.
- Result drawer that reuses the live chat surface, with maximize and accept-all on a thread.
- Foldable primary artifacts on task overview, with hover previews for code diffs and image thumbnails.
- Split-open control on preview headers: remembered editor, another installed app, or reveal the folder.
- Source-mode highlighting via the existing highlight.js highlighter for common languages.
- Headless `peer exec` for one Agent turn from the current directory without opening the TUI.
- Provider-aware model disambiguation so same-named models do not collide in `peer exec`.
- Persistent cwd and env for foreground `local.shell.exec` inside one conversation.
- Optional `start_line` / `end_line` on `read_file` for numbered slices.
- Single-line live thinking bar; first-run lands in chat.
- Workbench-header entry to open the current workspace's capability panel.
- Composer `@` mentions for workspace files.

### Changed

- Keep thinking collapsed until expanded; replace character arrows with linear SVG icons.
- Task artifacts show real filenames and +N/−M, with line numbers aligned to unified-diff hunks.
- Leave `peer exec` unbounded unless `--max-turns` is set.
- Keep working-set tool results inline so they stay in the current context.
- Goal plan history renders as aligned sibling cards instead of an indented tree.

### Fixed

- Restore left-side rounded corners on the session / result drawer when maximized.
- Send accepted completed cards into history; opening history no longer freezes the drawer.
- After a jump to a message, sending no longer replays the old scroll target.
- Keep virtual turns aligned so a long thread no longer opens as a blank spacer.
- Restore editor menu icons from local icns instead of leaving them blank.
- Render Markdown image syntax in chat; pack workbench cards by the shortest column.

### Release

- Desktop: install the platform asset from the `v0.0.5` GitHub Release.
- CLI / TUI: `npm i -g @peer-agent/cli@latest` or `npm i -g @peer-agent/cli@0.0.5`.

## 0.0.5-beta.4 - 2026-08-18

### Notes

- Follow-up beta on the `0.0.5` line after `0.0.5-beta.3`.
- Add headless `peer exec` with provider-aware model disambiguation and no default turn cutoff.
- Persist foreground shell cwd/env across calls, and let `read_file` return a numbered line range.
- Keep the thinking ticker collapsed until expanded; restore editor menu icons and linear SVG arrows.

### Added

- `peer exec` runs one Agent turn from the current directory without opening the TUI.
- Provider-aware model disambiguation so same-named models do not collide in `peer exec`.
- Persistent cwd and env for foreground `local.shell.exec` inside one conversation.
- Optional `start_line` / `end_line` on `read_file` for numbered slices.

### Changed

- Leave `peer exec` unbounded unless `--max-turns` is set.
- Keep working-set tool results inline so they stay in the current context.

### Fixed

- Hide the live thinking ticker until the thinking block is expanded.
- Restore editor menu icons from local icns instead of leaving them blank.
- Replace character arrows with linear SVG icons.
- Pass an unbounded turn limit when TUI `exec` omits `--max-turns`.

## 0.0.5-beta.3 - 2026-08-17

### Notes

- Follow-up beta on the `0.0.5` line after `0.0.5-beta.2`.
- Restore left-side rounded corners on the session / result drawer.
- Accepted completed cards move into history without freezing the drawer; sending after a message jump no longer flashes the old target.

### Fixed

- Restore the left-side rounded corners on the session / result drawer so maximize no longer clips them into a square.
- Send accepted completed cards into history; opening history no longer freezes the drawer.
- After a successful jump to a message, keep that one-shot navigation from replaying on send so the view does not scroll back and flash the old target.

## 0.0.5-beta.2 - 2026-08-17

### Notes

- Follow-up beta on the `0.0.5` line after `0.0.5-beta.1`.
- Open workbench files in the remembered editor, highlight source previews, and keep accept cards until delivery actually lands.
- Clicking a Goal Thread round jumps to the matching message; long chats no longer open as a blank spacer.

### Added

- Split-open control on preview headers: open the current file in the remembered editor, pick another installed app, or open/reveal the containing folder.
- Source-mode highlighting via the existing highlight.js highlighter for common languages such as jsx/tsx; unknown languages and files over the 20k-character cap stay as plain text.

### Changed

- Task artifacts show real filenames and +N/−M, with line numbers aligned to unified-diff hunks instead of generic “code change / new file” labels.
- Goal plan history renders as aligned sibling cards instead of an indented tree.

### Fixed

- Keep virtual turns aligned with the live viewport so a long thread no longer opens as a blank spacer.
- Keep accept cards visible until delivery actually finishes, then celebrate and dismiss; rebase when the target branch moved, and keep conflicts visible with a retry path.
- Clicking a Goal Thread round scrolls to the matching message instead of only opening the conversation at the default position.
- Stop appending the same streaming delta twice.

## 0.0.5-beta.1 - 2026-08-16

### Notes

- First published beta on the `0.0.5` line after stable `0.0.4`.
- Bring Goal Threads onto the global workbench, reuse live chat in the result drawer, and fold primary artifacts into task overview.
- First-run lands in chat; thinking stays on a single live line.

### Added

- Goal Thread grouping on the global workbench, flattened into a sibling list instead of a nested tree.
- Result drawer that reuses the live chat surface, with maximize and accept-all on a thread.
- Foldable primary artifacts on task overview, with hover previews for code diffs and image thumbnails.
- Single-line live thinking bar that follows the latest tail.
- Workbench-header entry to open the current workspace's capability panel.
- Composer `@` mentions for workspace files, without false attachment errors.
- First-run landing directly in chat.

### Changed

- Result view reuses chat turn rendering and can preview images and HTML.
- Workbench cards pack by the shortest column; character icons become linear SVGs.
- Empty home hides the composer when no provider is configured.
- Accepting a result card refills the list more smoothly.

### Fixed

- Render Markdown image syntax in chat.
- Keep self-parent Goal Threads grouped on one card.
- Make `@` picker rows usable, pin folders, and keep highlight around session ids.
- Enlarge images in the result view and stop clipping result-card corners.
- Let background tasks schedule the in-conversation browser.
- Stamp changelog `generatedAt` with a real time so docs-site drift gates stay honest.

## 0.0.4 - 2026-08-14

### Notes

- Stable Task Flow release that gathers Goal landing, workbench collaboration, and channel expansion since 0.0.3.
- Collapse follow-up Goals into one Goal Thread and keep a single workbench card.
- Run bound Goals in an isolated Git worktree, land accepted changes back into the original workspace, and close the delivery-routing plus quality-review loop.
- Add OpenRouter as a first-class official API channel, and expose Grok Fast / xhigh.
- Keep workbench discussions, read state, search, and refresh steadier, and open project folders from the sidebar.

### Added

- Goal Thread grouping for related acceptance cards, including follow-ups that omit `parentPlanId`.
- One result card per thread, bound to the latest pending round, with a compact parent/child tree.
- Isolated Goal landing with a visible delivery handoff after acceptance.
- Delivery-type routing and a quality-review loop that starts after the result is viewed.
- Official OpenRouter API as a third-party OpenAI Chat channel with a prefilled base URL and API key.
- Grok Fast mode and a higher xhigh reasoning effort.
- Project-folder sidebar entry instead of closing the workspace.
- Running-task sidebar markers, unread project discussions, workspace-grouped conversation search, and a result-drawer scroll button.

### Changed

- Query task overview from the current session or workspace index, merge scroll probes, and pause background refresh under drawers.
- Keep the home discussion section even when nothing is unread, and show the full result-ready queue.
- Merge workbench broadcasts, skip hidden reloads, back off tray rebuilds, and cache unchanged plan indexes.
- Persist task-overview read state, unify running / interrupted card hierarchy, and reduce refresh flicker.
- Keep continuing an existing task separate from submitting new input, and preserve reasoning effort when restoring a session.
- Rewrite README and docs landing copy around fully open source (MIT) and task-flow handoff / continuity / follow-up.

### Fixed

- Fix drawer, scroll, and input jank when multiple tasks run in parallel.
- Preserve interrupted Goal state, and stop unread task progress events from slowing the current page.
- Treat vanished worktrees as already cleaned, collect worktree changes before cleanup, reconcile the foreground runner, and keep unaccepted plans across follow-ups.
- Unify SkillHub toolbar control radius.
- Restore the open-sky cat brand icons instead of the full-bleed day and night illustrations.

### Release

- Desktop: install the platform asset from the `v0.0.4` GitHub Release.
- CLI / TUI: `npm i -g @peer-agent/cli@latest` or `npm i -g @peer-agent/cli@0.0.4`.

## 0.0.4-beta.4 - 2026-08-14

### Notes

- Collapse follow-up Goals into one Goal Thread and keep a single workbench card.
- Add OpenRouter as a first-class official API channel.
- Keep workbench discussions and the full pending-result queue visible, and throttle refresh storms.
- Align README and docs narrative around fully open source plus task flow.

### Added

- Goal Thread grouping for related acceptance cards, including follow-ups that omit `parentPlanId`.
- One result card per thread, bound to the latest pending round, with a compact parent/child tree.
- Official OpenRouter API as a third-party OpenAI Chat channel with a prefilled base URL and API key.

### Changed

- Keep the home discussion section even when nothing is unread, and show the full result-ready queue.
- Merge workbench broadcasts, skip hidden reloads, back off tray rebuilds, and cache unchanged plan indexes.
- Rewrite README and docs landing copy around fully open source (MIT) and task-flow handoff / continuity / follow-up.

### Fixed

- Unify SkillHub toolbar control radius.
- Restore the open-sky cat brand icons instead of the full-bleed day and night illustrations.

### Release

- Desktop: install the platform asset from the `v0.0.4-beta.4` GitHub Release.
- CLI / TUI: `npm i -g @peer-agent/cli@beta` or `npm i -g @peer-agent/cli@0.0.4-beta.4`.

## 0.0.4-beta.3 - 2026-08-14

### Notes

- Run bound Goals in an isolated Git worktree, land accepted changes back into the original workspace, and close the delivery-routing plus quality-review loop.
- Expose Grok Fast / xhigh and replace workspace-close with project folders.
- Refresh app and docs brand assets, and keep the docs changelog in sync with this release.

### Added

- Isolated Goal landing with a visible delivery handoff after acceptance.
- Delivery-type routing and a quality-review loop that starts after the result is viewed.
- Grok Fast mode and a higher xhigh reasoning effort.
- Project-folder sidebar entry instead of closing the workspace.
- A result-drawer scroll button for long results.

### Changed

- Shorten the sidebar wordmark to Peer and refresh Desktop / docs brand assets.
- Drop the result-drawer subtitle, move home-card runtime meta onto the action row, lock the chat header height, and cap acceptance shatter particles.
- Keep Goal progress compact and isolate the drawer workbench from the main one.

### Fixed

- Abort in-flight file search and skip stale home hydrates.
- Start the first runner turn after intake handoff, keep the old plan when a new Goal starts in the same conversation, and preserve unaccepted plans across follow-ups.
- Treat vanished worktrees as already cleaned, collect worktree changes before cleanup, and reconcile foreground runner state.
- Close the result drawer before card shatter, open project folders from the workspace context menu, and keep Grok xhigh above a stale effort cache.
- Render markdown links, draw the decision arrow as SVG, and show the total discussion count.

### Release

- Desktop: install the platform asset from the `v0.0.4-beta.3` GitHub Release.
- CLI / TUI: `npm i -g @peer-agent/cli@beta` or `npm i -g @peer-agent/cli@0.0.4-beta.3`.

## 0.0.2 - 2026-08-10

### Notes

- Graduate the full `0.0.2-beta.1` → `0.0.2-beta.5` line to the stable `latest` channel.
- Move Peer from tool-capable chat toward a Task Flow Agent: structured intake and follow-up questions, complexity-aware planning, persisted goals, and Evidence-backed completion.
- Preserve the governed local chain: Manifest → Runtime Projection → Tool Call → PermissionGrant → Evidence.

### Added

- Add Agent / Plan / Goal workflows with persisted plan graphs, subtasks, pause/resume, `waiting_user`, and read-only Explorer investigations.
- Add executable success criteria (command, test, file-exists, file-contains) with `criterionResults` and `evidenceRefs` as the completion gate.
- Add the global Workbench for advancing tasks, results awaiting acceptance, history, background shell threads, and continue-task flows.
- Add conversation-driven Automation proposals, isolated Git worktree runs, commit/diff artifact refs, run receipts, history, and tray status.
- Add an embedded Browser with visible navigation, click, type, DOM, and screenshot tools under PermissionGrant + Evidence.
- Publish the host-neutral Open Runtime packages: `@peer-agent/protocol`, `@peer-agent/runtime-core`, and `@peer-agent/runtime-sdk`.
- Add SkillHub, MCP/tool controls, skill details/capsules, tool definitions, provider channel wiring, and uninstall paths.
- Add npm-installed CLI/TUI binaries, `/version`, shared conversations/settings, and clearer runtime feedback.
- Protect a random vault master key with the platform keychain while encrypting Provider API keys and OAuth tokens locally with AES-256-GCM.
- Share Provider metadata, default model selection, and credential access across Desktop, TUI, and CLI on the same machine.
- Support custom OpenAI / Anthropic-compatible endpoints plus main-model / fallback-vision routing for text-only models.

### Changed

- Share runtime, System Context, conversation data, and `~/.peer-agent` configuration across Desktop, TUI, and CLI.
- Stabilize prompt prefixes and add cache metrics, including ChatGPT Responses cache-hit token accounting.
- Refine the workspace tree, composer, model strip, task cards, usage charts, and result-acceptance motion.

### Fixed

- Fix streaming scroll, context-usage restoration, provider stream metadata, Qoder local-auth errors, Kimi reasoning, Automation idempotency, and stale result-acceptance state.
- Harden long-task continuity with compaction, continuity sources, prompt checksums, and Evidence-preserving resume behavior.

### Release

- Desktop: install the platform asset from the `v0.0.2` GitHub Release.
- CLI / TUI: `npm i -g @peer-agent/cli@latest` or `npm i -g @peer-agent/cli@0.0.2`.
- Memory, self-evolution, full multi-agent collaboration, Agent swarm, and Canvas remain planned and are not shipped in 0.0.2.

## 0.0.2-beta.5 - 2026-08-10

### Notes

- Turn the Desktop workbench into a real task hub: global workbench separate from workspace views, task overview/history drawers, result-acceptance animations, continue-task flows, a flattened workspace sidebar tree, skill capsules, and chat/usage polish.
- Skills gain tool definitions, uninstall paths, header capability-list detail entry, and more readable SkillHub install errors.
- Local capability execution, explicit authorization, and Evidence remain unchanged.

### Added

- Separate the global workbench from workspace views to centralize in-progress tasks, results awaiting acceptance, and history, with task overview and history drawers.
- Show plan steps on advancing cards, continue the same task for unaccepted results, and animate accept cards with right-to-left shatter transitions.
- Show completion time on result-ready cards and drop stale unaccepted results from the acceptance queue.
- Surface Peer background shell threads in the workbench.
- Flatten the sidebar into a workspace tree; pick a draft workspace for new chats and lock the workspace for existing chats.
- Track lastReadAt / markRead watermarks so recent discussions become unread-only “discussing”.
- Surface conversation task context in chat; show the full goal step list on dock hover.
- Open skill detail from the header capability list, show skill capsules, and make SkillHub install errors readable.
- Add skill tool definitions, provider channel wiring, and skill uninstall.
- Add cache metrics engine and prompt-prefix stabilization; report prompt cache hit tokens for ChatGPT Responses usage.
- Add TUI `/version` slash command to show the CLI version.

### Changed

- Unify chat composer padding, enlarge the stop glyph, refine action-row/attach-chip spacing, use a text-only editing banner, and apply a control-level model-strip font.
- Restore last context-usage display when switching sessions.
- Collapse accept cards so the list slides up; restore dual-column workbench result cards.
- Smooth usage-trend chart corners; shorten task-overview copy.
- Keep open tooltips during stream auto-scroll; wire the running dot to the status token.

### Fixed

- Reopen the same task when continuing unaccepted results instead of starting another.
- Surface waiting-for-user tasks correctly in the workbench.
- Fix `durationLabel is not defined` crash in GlobalWorkbenchPage.
- Open the workbench correctly after workspace switches; stop sidebar rows from clipping.
- Stop streaming scroll bounce from an out-of-sync virtual spacer.
- Show six recent discussions on the task overview; align discussion-status fallback assertions.
- Map Qoder local-auth errno codes to readable errors and fall back to the host node for auth reads.
- Fix provider stream metadata, skill id extraction, and task-overview rules.
- Center the skill-detail close icon geometrically; align skill card radius.

## 0.0.2-beta.4 - 2026-08-07

### Notes

- Bring the full Tencent SkillHub skill marketplace to Desktop, with remote metadata sync, verified install-time ZIP download, global/workspace install scope, and uninstall.
- Preview local chat attachment images inline, and polish Kimi multi-level reasoning effort plus several Desktop detail interactions.
- Local capability execution, explicit authorization, and Evidence remain unchanged.

### Added

- Sync SkillHub marketplace metadata into a local paginated index with search, category filters, sorting, background resume, and last-complete-snapshot fallback.
- Install SkillHub skills after Ed25519 platform signature, ZIP MD5, hash v1 content fingerprint, and archive safety checks into the existing Skill Store.
- Choose install scope in the marketplace detail panel: global (`userData/skills`) or current workspace (`workspace/skills`).
- Uninstall user-installed skills from the installed list; project-level workspace skills stay protected.
- Render local chat attachment images inline through a dedicated file data-url IPC path.

### Changed

- Prefer SkillHub `iconUrl` for marketplace avatars, with letter fallback.
- Use the shared Dropdown for marketplace category filtering and flatten nested detail chrome around install actions.
- Map Kimi Coding Plan / Moonshot to official off/low/high/max effort and align the discrete effort slider geometry.
- Clarify Automation detail header hierarchy and check for updates when the app is reactivated.

### Fixed

- Close the skill detail overlay with the shared exit animation after uninstall instead of hard-unmounting it.
- Keep marketplace card footers bottom-aligned across equal-height grid cards.

## 0.0.2-beta.3 - 2026-08-06

### Notes

- Make Automation run results easier to find, trace, compare, and control while preserving Fresh Run, isolated-worktree, immutable Receipt, permission, and Evidence boundaries.
- Continue polishing Automation proposals and the Desktop composer experience.

### Added

- Persist final Automation summaries in immutable Run Receipts, with a final-assistant-message fallback and an explicit successful-run fallback.
- Show recent Automation results in Overview and the system tray, with direct navigation to the exact Run.
- Compare the current result with the previous completed result and optionally notify only when a successful result changes.
- Project Automation conversations back to their origin workspace and expose a clickable Automation origin badge in Fresh Run chats.

### Changed

- Refresh Automation Runs and the selected Receipt when runtime state changes.
- Collapse terminal Automation proposals by default, clear proposal cards after confirm or cancel, and use clearer green active-status pills.
- Tighten home composer controls and keep Automation proposal cards from flex-collapse.

### Fixed

- Convert missing-runner and asynchronous startup failures into visible failed Runs with failure Receipts.
- Preserve idempotent Automation proposal confirmation after the proposal card is cleared, returning the original Receipt without creating a duplicate.
- Update `lastRunAt` on terminal Automation states and skip intake-contract handling for system-task notifications.

## 0.0.2-beta.2 - 2026-08-06

### Notes

- Desktop polish release after 0.0.2-beta.1, focused on composer attachment layout, action-bar spacing, and cascading model-menu placement.
- Local capability execution, explicit authorization, and Evidence remain unchanged.

### Fixed

- Keep pasted image thumbnails on a dedicated composer row so they no longer cover draft text.
- Tighten home/session composer padding around the bottom action bar.
- Align cascading model submenus to the current provider row instead of stacking from the first item.

## 0.0.2-beta.1 - 2026-08-05

### Notes

- First public beta in the 0.0.2 line, building on the 0.0.1 stable release.
- Local execution, explicit permission grants, and Evidence remain the governing boundary for all new Automation and Workbench capabilities.

### Added

- Create scheduled Automations from structured proposals in conversations, with explicit confirmation, idempotent identity checks, and authoritative creation receipts.
- Prompt-first Automation Center creation with model-assisted detection, editable generated plans, confirmation overlays, access presets, and tray runtime status.
- Workbench file create / folder create, refresh, and filter actions.
- Configurable model context-window tiers carried into chat runtime budgeting.
- Automatic update checks and localized release prompts.

### Changed

- Unified settings, capability, Automation, and import toggles on accessible Switch / Checkbox controls with governed theme tokens.
- Improved Provider connection flows, model catalog handling, refresh-result preservation, service icons, and model settings.
- Let CSS own chat composer auto-sizing with a higher thread input limit, avoiding synchronous per-character layout measurement.
- Bounded TUI streaming refresh, Markdown, and syntax-highlight work for more stable long-session rendering.
- Kept TUI theme state aligned with the palette actually applied after system-theme changes.

### Fixed

- Clear or replace context accounting correctly after external conversation reloads.
- Release the Workbench layout column outside Chat while preserving the user's open state.
- Align Workbench file opening, directory refresh, and watcher calls with their canonical interfaces.
- Prevent stale, repeated, or cross-conversation Automation proposals from creating duplicate tasks.
- Preserve Provider catalog refresh results and surface Automation runtime status in the tray.

## 0.0.1 - 2026-08-04

### Notes

- First stable / latest release. **Graduates the full `0.0.1-beta.7` → `0.0.1-beta.49` line**, not just the beta.49 delta.
- beta.49 is only the freeze point; this section summarizes the product surface proven across the beta series.

### Added

- Desktop shell + CLI (`peer`) with shared runtime/config model.
- Agent / Plan self-driven workflows (plans, subtasks, evidence, next steps).
- Conversation UX foundations: streaming, reasoning display, trackable compression, long-session stability, attachments/queue.
- Provider connection center: official API, OAuth, custom compatible, and third-party / coding-plan templates.
- Brand icons + locked centered modal for add-provider setup; confirm-before-delete for provider groups.
- Third-party / coding-plan channel set (DeepSeek, GLM CN/Global, Kimi/Moonshot, MiniMax CN/Global, Volcengine Ark, Xiaomi MiMo/Token Plan, Aliyun Bailian, OpenCode Go, and more).
- MCP local management / OAuth / tool toggles.
- Browser workbench readiness + screenshot visual context.
- Usage/quota surfaces and Desktop/CLI accounting alignment.

### Fixed / Hardened

- Runtime hardening across compression, usage, stream-loop guards, main-process and update paths (accumulated through the beta line).
- Local credential security paths (e.g. OS keychain).

## 0.0.1-beta.49 - 2026-08-04

### Added

- Third-party / coding-plan service templates: GLM Coding Plan (CN/Global), Kimi Coding Plan, Moonshot, MiniMax (CN/Global), Volcengine Ark, Xiaomi MiMo / Token Plan, Aliyun Bailian Coding Plan, and OpenCode Go (OpenAI / Anthropic).
- DeepSeek official API channel (`api.deepseek.com`).
- Provider / model brand icons for Zhipu, Kimi/Moonshot, MiniMax, Volcengine, Xiaomi, Bailian, and OpenCode.
- Locked provider setup modal: keep the service catalog behind a centered modal; lock channel + auth to the selected template; collapse official advanced fields with expand/collapse animation.
- Confirm-before-delete for provider channel groups.

### Fixed

- Browser workbench waits for workspace registration; inject `ensureBrowserReady` into the agent tool path; feed screenshots into visual context.
- Preserve frosted glass styling in production builds.
- Service catalog dark-theme surfaces.
- Stop Qoder pricing backfill thrash.
- Add spacing above the first chat message.

## 0.0.1-beta.48 - 2026-08-03

### Added

- Unified provider catalog with service templates and catalog motion on the connect-a-model surface.
- Conversation-bound Browser panel reveal for the current chat.
- Qoder private-channel copy labels the channel as local CLI and documents connect prerequisites.

### Changed

- Model / channel settings lists no longer block on OAuth silent refresh: list APIs return local data immediately, coalesce a single background refresh, and push `llm:oauth:refreshed` only when credentials actually change.
- Desktop auto-update channel graduates from beta to stable by default for installed clients.
- Usage stats group providers by channel instead of model-entry UUID; By Model shows the configured `modelLabel`.

### Fixed

- Qoder context-tier projection anchors the input reserve to the smallest tier that fits `max_input_tokens`, so a selected 1M tier projects ~980k usable input instead of collapsing to 180k.
- Restored conversation context windows reproject capacity from the live model tier while keeping occupied tokens from the snapshot (no more stale 180k UI after tier changes).
- Goal Runner stream remaps keep `turnStartedAt`, so the turn timer no longer resets mid-run.
- Goal permission gate allows fresh command requests through instead of blocking legitimate capabilities.
- ChatGPT subscription pricing no longer thrash-backfills models.dev prices.
- UI polish: unify modal frosted glass and chip/panel radii for tooltips and sidebar branch badges.

## 0.0.1-beta.47 - 2026-08-02

### Added

- Markdown code-block syntax highlighting and diff add/remove coloring.
- Per-request Provider / Model attribution for billing and token usage.
- Desktop architecture gates for lifecycle, IPC ownership, dependency direction, overlay, and motion primitives.

### Changed

- Unified Desktop glass styling (window chrome, vibrancy layout, dark contrast, shared overlay radius).
- Improved file-tree information hierarchy and browsing presentation.
- Electron Main single Composition Root with named startup phases, fatal/optional semantics, reverse rollback, and idempotent cleanup.
- Governed startup order: Local Runtime ready → Desktop IPC registration → first Renderer window.
- Centralized IPC / preload catalog; no direct IPC registration in `main.mjs`.
- Shared Desktop/TUI host-neutral surface via `@peer-agent/runtime-node`.
- Hide unfinished Appshots settings entry from the product surface.

### Fixed

- Long-conversation main-thread stalls by moving expensive work off critical interaction paths.
- Stream text jitter via animation-frame paced incremental updates.
- Compaction concurrency for a single conversation; surface real failures and refresh context usage after compaction.
- Goal handoff terminal-state retention and runner timing sync after recovery.
- macOS Dock reactivation recreates the main window after it was closed.
- Qoder FREE_INPUT keeps `image_url` parts; thinking effort aligns with `reasoning_effort`.
- Missing cache-write tokens no longer reported as a fabricated zero.
- Conversation Store tests no longer read/write real user data.
- Appearance-preview duplicate titles, lost code line breaks, and extra blank spacing in diff lines.

## 0.0.1-beta.46 - 2026-07-31

### Added

- Quick Chat system menus: workspace / mode / access / effort via native `Menu.popup`; models grouped by provider submenus.
- Single-line Quick Chat capsule by default (grows with content); Codex-style image attachment chips.

### Changed

- Quick Chat theme sync with light/dark/system; rely on window vibrancy without CSS fill covering native material.
- Shorter Agent/Plan mode menu copy; denser capsule spacing.

### Fixed

- IME composition Enter no longer sends in main Composer and Quick Chat.
- Quick Chat menu selection updates the bar (selection IPC + Menu click/close race).
- Menu.popup uses window-local coordinates so menus stay near the trigger.
- Composer attachment strip isolated from draft re-renders.
- Desktop provider/OAuth/quota/model-catalog traffic stays on Electron `net.fetch` (system proxy + macOS trust store).
- Cold-start first paint: defer window show until ready-to-show; boot background + error boundary.
- TUI: Desktop model-entry uuid binding; system-context prompt alignment; workspace name in terminal tab title; hide sticky YOU while target user bubble is visible.

## 0.0.1-beta.45 - 2026-07-29

### Added

- Goal active runtime timing display during plan execution.
- Goal durable checkpoint/idempotency and compaction follow-ups.
- Virtual chat turn list isolation and background stream buffer for inactive conversations.
- Browser overflow menu P0, password manager Phase 1, Chrome site-cookie import; Files tree refresh/light watch.
- Qoder credits/discounts/quota in settings and context ring.
- GPT reasoning summary split from reasoning text; GPT-5.6 reasoning tiers.
- TUI prompt cache hit rate.

### Changed

- Stop stream frames from invalidating PlanCard memo via split InteractionContext + stable selectInteractionOption.
- Coalesce soft runner-progress IPC (100ms), dedupe dual-channel runner snapshots, and cache local Qoder catalog reads (5s TTL).
- Memoize GoalPlanPanel view model and relation props.
- Composer CSS field-sizing autosize; defer historical attachment image loading/decoding.
- Frost glass polish for overlays, selected sidebar rows, Goal/Quick Chat/Skills surfaces.
- Semantic, budget-safe context compaction; persist provider_usage at observe time.
- Remove the unused `cu-proxy-core` Rust health stub and `local.health` scaffold (capability, provider, IPC, packaging, and tests). Keep `peer-credential-helper`.

### Fixed

- Tray More: native submenu for conversations 6–20; stop hard-clamping tray recent list to 5 or only opening the app.
- Sidebar context menu portal + viewport clamp.
- Stick-to-bottom during streaming after jump-to-latest.
- ChatGPT overload/server_error retries; Qoder queue/duplicate stream retries; recovering-fetch rebuilds RequestInit on connection retries.
- Attachment unsupported copy reflects that agents can still read local files.
- GPT subscription context window restored to 258k; stop requesting reasoning summary by default.
- Browser visible readiness wait; assorted sidebar/status-dot/workspace hover/docs dark theme fixes.


## 0.0.1-beta.44 - 2026-07-28

### Added

- Default **Agent** mode with L0–L3 adaptive planning, diagnosis gate for symptom fixes, and Plan kept as approval-gated workflow.
- macOS menu-bar tray for recent sessions and quick activation.
- Skills global/workspace split and capability detail dialog.
- First-run model setup path for empty chat.
- Product documentation site (landing + changelog + denser docs content).

### Changed

- Desktop/CLI mode product surface is Agent/Plan only; legacy `goal` displays as Agent and keeps the self-driven kernel.
- Cap `write_file` payload size and raise stream idle timeout.
- Widen docs changelog content measure.

### Fixed

- CLI multi-image paste: same-basename files no longer collapse; local path strings no longer leak into message text.
- CLI mode picker no longer exposes Goal as a separate selectable mode.
- Preserve continuity during compaction; prevent glued GPT reasoning status phrases.
- Sidebar no longer flashes empty conversation list on refresh; softer sidebar edge.
- Keep protocol tests out of npm package dist.


## 0.0.1-beta.26 - 2026-07-07

### Added

- Goal mode now runs an intake discrimination phase before creating a goal: a pure Q&A silently reverts to normal chat, an ambiguous ask triggers a clarifying question, and only a clear goal is accepted and self-driven — no more "turn every message into a goal".
- New qoder CLI model provider: connect via local CLI auth without storing remote credentials in the app.
- LLM model list is now a grouped accordion — models fold under their group, share credentials per group while keeping per-model params; model drawers and icons unified.

### Fixed

- Chat scroll position is now remembered per conversation when switching conversations.
- Adding a model under a group no longer re-shows provider-level fields (channel/auth/BaseURL/APIKey) already inherited from the group.
- Aligned the context window for ChatGPT subscription mode.
- Fixed duplicated body text on stream reattach.
- Fixed duplicated tool-call segments on stream reattach.
- Conversation list no longer flashes an empty "no conversations" state during refresh; stale slow responses can no longer overwrite a newer view.

## 0.0.1-beta.25 - 2026-07-06

### Added

- Goal auto-execution binds to the target repo workspace so cross-repo actions land in the right place, with run-trace tracking surfaced in the Goal panel.
- New `--ui-*` semantic token layer; chat UI styles migrated onto it for theme consistency and easier future theming.

### Changed

- Add/edit model provider now opens a centered Overlay modal instead of an inline form at the bottom of the list.
- Goal task breakdown wording is plainer: subtask titles drop jargon and packed numbering in favor of one plain sentence per step.

### Fixed

- Chat cancel now goes through the same-origin gateway instead of a bare cross-origin fetch, fixing cross-origin auth 401.
- Thinking-state animation: removed the extra dots on the active "thinking" state and fixed the shimmer sweep.

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
