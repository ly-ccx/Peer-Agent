import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_ARTIFACT_CHARS = 2_000_000;
const TRUNCATION_MARKER = '\n...[artifact truncated]\n';

export interface NodeShellArtifactDescriptor {
  readonly artifactRef: string;
  readonly artifactRefs: readonly string[];
  readonly localPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly metadataPath: string;
  readonly truncated: boolean;
}

export interface NodeShellArtifactMetadata {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly command: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly classification?: unknown;
  readonly startedAt: string;
  readonly completedAt?: string | null;
  readonly status?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly timedOut?: boolean;
  readonly interrupted?: boolean;
  readonly stopReason?: string | null;
  readonly truncated?: boolean;
  readonly [key: string]: unknown;
}

export interface NodeShellArtifactSession {
  readonly descriptor: NodeShellArtifactDescriptor;
  appendStdout(chunk: string): Promise<void>;
  appendStderr(chunk: string): Promise<void>;
  finalize(metadata: NodeShellArtifactMetadata): Promise<NodeShellArtifactDescriptor>;
}

export interface NodeShellArtifactStore {
  readonly rootPath: string;
  createTaskArtifact(metadata: NodeShellArtifactMetadata): Promise<NodeShellArtifactSession>;
}

export interface CreateNodeShellArtifactStoreOptions {
  readonly rootPath?: string;
  readonly maxArtifactChars?: number;
}

function dateKey(isoDate: string): string {
  return isoDate.slice(0, 10);
}

function assertTaskId(taskId: string): void {
  if (!/^shell_[0-9a-f-]{36}$/i.test(taskId)) {
    throw new TypeError('Shell artifact taskId must be an opaque shell_<uuid> identifier.');
  }
}

export function createNodeShellArtifactStore(
  options: CreateNodeShellArtifactStoreOptions = {},
): NodeShellArtifactStore {
  const rootPath = path.resolve(options.rootPath ?? path.join(homedir(), '.peer-agent', 'shell-artifacts'));
  const maxArtifactChars = Math.max(1, options.maxArtifactChars ?? DEFAULT_MAX_ARTIFACT_CHARS);

  return {
    rootPath,
    async createTaskArtifact(initialMetadata) {
      assertTaskId(initialMetadata.taskId);
      const artifactDir = path.join(rootPath, dateKey(initialMetadata.startedAt), initialMetadata.taskId);
      const stdoutPath = path.join(artifactDir, 'stdout.txt');
      const stderrPath = path.join(artifactDir, 'stderr.txt');
      const metadataPath = path.join(artifactDir, 'metadata.json');
      const artifactRef = `local-shell-artifact://${initialMetadata.taskId}`;
      const artifactRefs = [
        `${artifactRef}/stdout`,
        `${artifactRef}/stderr`,
        `${artifactRef}/metadata`,
      ] as const;

      await mkdir(artifactDir, { recursive: true });
      await Promise.all([
        writeFile(stdoutPath, '', 'utf8'),
        writeFile(stderrPath, '', 'utf8'),
        writeFile(metadataPath, `${JSON.stringify(initialMetadata, null, 2)}\n`, 'utf8'),
      ]);

      let stdoutChars = 0;
      let stderrChars = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let closed = false;
      let writeQueue = Promise.resolve();

      const descriptor = (): NodeShellArtifactDescriptor => ({
        artifactRef,
        artifactRefs,
        localPath: artifactDir,
        stdoutPath,
        stderrPath,
        metadataPath,
        truncated: stdoutTruncated || stderrTruncated,
      });

      const enqueueAppend = (
        targetPath: string,
        chunk: string,
        stream: 'stdout' | 'stderr',
      ): Promise<void> => {
        if (closed || chunk.length === 0) return writeQueue;
        const written = stream === 'stdout' ? stdoutChars : stderrChars;
        const alreadyTruncated = stream === 'stdout' ? stdoutTruncated : stderrTruncated;
        if (alreadyTruncated) return writeQueue;

        const available = maxArtifactChars - written;
        const content = available > 0 ? chunk.slice(0, available) : '';
        const truncated = chunk.length > content.length;
        if (stream === 'stdout') {
          stdoutChars += content.length;
          stdoutTruncated = truncated;
        } else {
          stderrChars += content.length;
          stderrTruncated = truncated;
        }
        const appendContent = `${content}${truncated ? TRUNCATION_MARKER : ''}`;
        if (!appendContent) return writeQueue;
        writeQueue = writeQueue.then(() => appendFile(targetPath, appendContent, 'utf8'));
        return writeQueue;
      };

      return {
        get descriptor() {
          return descriptor();
        },
        appendStdout(chunk) {
          return enqueueAppend(stdoutPath, String(chunk ?? ''), 'stdout');
        },
        appendStderr(chunk) {
          return enqueueAppend(stderrPath, String(chunk ?? ''), 'stderr');
        },
        async finalize(metadata) {
          if (closed) {
            await writeQueue;
            return descriptor();
          }
          closed = true;
          await writeQueue;
          const finalDescriptor = descriptor();
          await writeFile(
            metadataPath,
            `${JSON.stringify({ ...metadata, truncated: finalDescriptor.truncated }, null, 2)}\n`,
            'utf8',
          );
          return finalDescriptor;
        },
      };
    },
  };
}
