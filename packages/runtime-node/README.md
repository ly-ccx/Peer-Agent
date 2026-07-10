# @peer-agent/runtime-node

Reusable Node host adapter for `@peer-agent/runtime-sdk`.

The package translates generic Runtime SDK ports into Node-host conventions:

- enrich provider execution with session, locale, workspace, and request identifiers;
- translate `PreToolUse` ask decisions into a host permission prompt;
- preserve denied approval grants and reasons;
- create fail-closed blocked executions and unsupported-capability fallbacks;
- attach host-provided Hook Evidence without depending on Electron.

Electron, terminal UI, filesystem discovery, process execution, and secret storage remain outside this package. Desktop and the future TUI provide concrete capability providers, Hook runners, approval UI, result factories, and Evidence adapters.
