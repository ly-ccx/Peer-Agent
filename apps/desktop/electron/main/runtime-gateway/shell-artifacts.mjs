import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

export function createShellArtifactStore({ userDataPath }) {
  const rootPath = path.join(userDataPath, 'shell-artifacts');

  async function writeTaskArtifacts({
    taskId,
    toolCallId,
    command,
    cwd,
    stdout,
    stderr,
    classification,
    startedAt,
    completedAt,
  }) {
    const artifactDir = path.join(rootPath, dateKey(), taskId);
    await mkdir(artifactDir, { recursive: true });
    const cappedStdout = capArtifact(stdout);
    const cappedStderr = capArtifact(stderr);
    await writeFile(path.join(artifactDir, 'stdout.txt'), cappedStdout.text, 'utf8');
    await writeFile(path.join(artifactDir, 'stderr.txt'), cappedStderr.text, 'utf8');
    await writeFile(path.join(artifactDir, 'metadata.json'), `${JSON.stringify({
      taskId,
      toolCallId,
      command,
      cwd,
      classification,
      startedAt,
      completedAt,
      stdoutTruncated: cappedStdout.truncated,
      stderrTruncated: cappedStderr.truncated,
    }, null, 2)}\n`, 'utf8');

    return {
      artifactRef: `local-shell-artifact://${taskId}`,
      artifactRefs: [
        `local-shell-artifact://${taskId}/stdout`,
        `local-shell-artifact://${taskId}/stderr`,
        `local-shell-artifact://${taskId}/metadata`,
      ],
      localPath: artifactDir,
      truncated: cappedStdout.truncated || cappedStderr.truncated,
    };
  }

  return {
    rootPath,
    writeTaskArtifacts,
  };
}
