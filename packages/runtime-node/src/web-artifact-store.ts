import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MAX_ARTIFACT_CHARS = 2_000_000;

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function capArtifact(value: string): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= MAX_ARTIFACT_CHARS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, MAX_ARTIFACT_CHARS)}\n...[artifact truncated]`,
    truncated: true,
  };
}

export interface NodeWebArtifact {
  readonly artifactRef: string;
  readonly artifactRefs: readonly string[];
  readonly localPath: string;
  readonly contentPath: string;
  readonly metadataPath: string;
  readonly truncated: boolean;
}

export interface NodeWebArtifactStore {
  readonly rootPath: string;
  writeFetchArtifact(input: {
    readonly fetchId?: string;
    readonly toolCallId: string;
    readonly requestedUrl: string;
    readonly finalUrl: string;
    readonly title: string;
    readonly content: string;
    readonly contentType: string;
    readonly httpStatus?: number;
    readonly fetchMode: string;
    readonly startedAt: string;
    readonly completedAt: string;
  }): Promise<NodeWebArtifact>;
}

export function createNodeWebArtifactStore(options: {
  readonly rootPath?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
} = {}): NodeWebArtifactStore {
  const rootPath = path.resolve(options.rootPath ?? path.join(homedir(), '.peer-agent', 'web-artifacts'));
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  return {
    rootPath,
    async writeFetchArtifact(input) {
      const fetchId = input.fetchId ?? idFactory();
      const artifactDir = path.join(rootPath, dateKey(now()), fetchId);
      await mkdir(artifactDir, { recursive: true });
      const cappedContent = capArtifact(input.content);
      const contentPath = path.join(artifactDir, 'content.txt');
      const metadataPath = path.join(artifactDir, 'metadata.json');
      await writeFile(contentPath, cappedContent.text, 'utf8');
      await writeFile(metadataPath, `${JSON.stringify({
        fetchId,
        toolCallId: input.toolCallId,
        requestedUrl: input.requestedUrl,
        finalUrl: input.finalUrl,
        title: input.title,
        contentType: input.contentType,
        httpStatus: input.httpStatus,
        fetchMode: input.fetchMode,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        contentTruncated: cappedContent.truncated,
        contentChars: input.content.length,
        contentLines: input.content.split('\n').length,
      }, null, 2)}\n`, 'utf8');
      return {
        artifactRef: `local-web-artifact://${fetchId}`,
        artifactRefs: [
          `local-web-artifact://${fetchId}/content`,
          `local-web-artifact://${fetchId}/metadata`,
        ],
        localPath: artifactDir,
        contentPath,
        metadataPath,
        truncated: cappedContent.truncated,
      };
    },
  };
}
