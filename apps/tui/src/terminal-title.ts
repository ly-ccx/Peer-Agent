import path from 'node:path';

/**
 * Format the terminal tab/window title for the TUI.
 *
 * Layout follows the VS Code convention: workspace folder name first,
 * then the product name — e.g. `peer-knowledge — Peer`.
 * Falls back to plain `Peer` when the workspace root has no usable basename
 * (e.g. filesystem root).
 */
export function formatTerminalTitle(workspaceRoot: string): string {
  const name = path.basename(workspaceRoot.trim());
  if (!name || name === path.sep || name === '/') {
    return 'Peer';
  }
  return `${name} — Peer`;
}
