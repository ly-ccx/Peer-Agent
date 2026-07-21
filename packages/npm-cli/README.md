# @peer-agent/cli

Install the Peer Agent terminal CLI with npm or pnpm. This package is a thin installer:

1. `postinstall` downloads `peer` + `peer-credential-helper` for your platform from the matching GitHub Release
2. the `peer` bin launches the vendor binary (helper must stay next to `peer`)

> Monorepo note: the TUI **source** package is `@peer-agent/tui` (`apps/tui`).  
> This package (`@peer-agent/cli`) is the **public npm installer** only.

## Install

```bash
npm install -g @peer-agent/cli
# or
pnpm add -g @peer-agent/cli
```

```bash
peer --version
peer
```

Requires **Node.js 20+**.

## What gets installed

| File | Role |
|------|------|
| `vendor/peer` | CLI / TUI binary |
| `vendor/peer-credential-helper` | credential vault helper (must be same directory as `peer`) |

Version is pinned to the npm package version (e.g. `@peer-agent/cli@0.0.1-beta.38` downloads the `v0.0.1-beta.38` GitHub Release asset).

## Supported platforms (today)

| Platform | Archive | Notes |
|----------|---------|-------|
| macOS arm64 | `peer-darwin-arm64.tar.gz` | First-class |
| other | — | postinstall fails with a clear error until multi-platform CLI ships |

## Environment variables

| Variable | Effect |
|----------|--------|
| `PEER_AGENT_SKIP_DOWNLOAD=1` | Skip binary download (CI publish / offline) |
| `PEER_AGENT_FORCE_DOWNLOAD=1` | Force download even inside the monorepo checkout |
| `PEER_AGENT_RELEASE_BASE` | Override GitHub Releases base URL (tests / mirrors) |

## Monorepo developers

Inside this repository, `postinstall` **does not** download binaries by default (it detects `apps/tui`). Build the real CLI with:

```bash
pnpm --filter @peer-agent/tui build
./apps/tui/dist/peer --version
```

To force the installer path locally:

```bash
PEER_AGENT_FORCE_DOWNLOAD=1 node packages/npm-cli/scripts/postinstall.mjs
```

## Manual install (no npm)

From the GitHub Release for the same version:

```bash
tar -xzf peer-darwin-arm64.tar.gz
export PATH="$PWD/peer-darwin-arm64:$PATH"
peer --version
```

## Uninstall

```bash
npm uninstall -g @peer-agent/cli
```

User data under `~/.peer-agent` is **not** removed (shared with Desktop).

## License

MIT — same as the Peer Agent monorepo.
