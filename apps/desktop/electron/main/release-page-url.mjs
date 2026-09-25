/**
 * 更新失败兜底用的 GitHub Release 页面 URL 构造（无 electron 依赖，便于单测）。
 */

/** 该版本对应的 GitHub Release 页面 URL（兜底用）。 */
export function buildReleaseUrl({ owner, repo, version }) {
  return `https://github.com/${owner}/${repo}/releases/tag/v${version}`;
}
