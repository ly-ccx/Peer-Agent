/**
 * mac 自管更新下载链路的纯 URL 构造工具（无 electron 依赖，便于单测）。
 *
 * 约定与 electron-builder.yml 的 artifactName 保持一致：
 *   Peer-Agent-${version}-${arch}.dmg
 * 一旦 artifactName 改动，此处需同步（由 auto-updater.test.mjs 锁定形态）。
 */

/** process.arch → dmg 文件名中的 arch 片段。 */
export function mapArch(arch) {
  return arch === 'x64' ? 'x64' : 'arm64';
}

/** 按 artifactName 约定拼出 dmg 的下载 URL。 */
export function buildDmgUrl({ owner, repo, version, arch }) {
  const file = `Peer-Agent-${version}-${arch}.dmg`;
  return `https://github.com/${owner}/${repo}/releases/download/v${version}/${encodeURIComponent(file)}`;
}

/** 该版本对应的 GitHub Release 页面 URL（兜底用）。 */
export function buildReleaseUrl({ owner, repo, version }) {
  return `https://github.com/${owner}/${repo}/releases/tag/v${version}`;
}
