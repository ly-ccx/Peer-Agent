import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Web fetch 正文 artifact 落盘 —— 见 ADR 38（local.web.fetch）。
 *
 * 与 shell-artifacts 同构：联网抓取得到的网页正文是「事实/用户上下文」，
 * 体量可能很大且不应整段回灌进模型上下文。Provider 把正文落到本地 artifact，
 * 仅向模型返回 标题 + 摘要 + 最终 URL + artifactRef，符合 evidencePolicy=artifact_ref。
 */

const MAX_ARTIFACT_CHARS = 2_000_000;

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function capArtifact(value) {
  const text = String(value ?? '');
  if (text.length <= MAX_ARTIFACT_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, MAX_ARTIFACT_CHARS)}\n...[artifact truncated]`,
    truncated: true,
  };
}

export function createWebArtifactStore({ userDataPath }) {
  const rootPath = path.join(userDataPath, 'web-artifacts');

  async function writeFetchArtifacts({
    fetchId,
    toolCallId,
    requestedUrl,
    finalUrl,
    title,
    content,
    contentType,
    httpStatus,
    fetchMode,
    startedAt,
    completedAt,
  }) {
    const artifactDir = path.join(rootPath, dateKey(), fetchId);
    await mkdir(artifactDir, { recursive: true });
    const cappedContent = capArtifact(content);
    await writeFile(path.join(artifactDir, 'content.txt'), cappedContent.text, 'utf8');
    await writeFile(path.join(artifactDir, 'metadata.json'), `${JSON.stringify({
      fetchId,
      toolCallId,
      requestedUrl,
      finalUrl,
      title,
      contentType,
      httpStatus,
      fetchMode,
      startedAt,
      completedAt,
      contentTruncated: cappedContent.truncated,
      contentChars: String(content ?? '').length,
      contentLines: String(content ?? '').split('\n').length,
    }, null, 2)}\n`, 'utf8');

    return {
      artifactRef: `local-web-artifact://${fetchId}`,
      artifactRefs: [
        `local-web-artifact://${fetchId}/content`,
        `local-web-artifact://${fetchId}/metadata`,
      ],
      localPath: artifactDir,
      contentPath: path.join(artifactDir, 'content.txt'),
      metadataPath: path.join(artifactDir, 'metadata.json'),
      truncated: cappedContent.truncated,
    };
  }

  return {
    rootPath,
    writeFetchArtifacts,
  };
}
