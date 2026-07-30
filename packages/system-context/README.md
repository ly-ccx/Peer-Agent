# @peer-agent/system-context

Canonical Node System Context assembler shared by Desktop and TUI.

Hosts inject runtime facts such as workspace, provider/model, Goal store, MCP
registry, reminders and continuity. The package owns Source registration,
layering, rendering, checksums and prompt snapshots.

Host-configured instructions (`systemInstructions`, `replyLanguage`, and
`gitBranchPrefix`) are materialized here as one canonical instruction set so
Desktop and TUI cannot drift in wording or defaults.
