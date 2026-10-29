import '../../../scripts/embed-storage-workers.mjs';
import { copyFile, mkdir, rm } from 'node:fs/promises';

const sourceDirectory = new URL('../src/', import.meta.url);
const outputDirectory = new URL('../dist/', import.meta.url);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const runtimeFiles = [
  'index.mjs',
  'index.d.ts',
  'interaction-reader.mjs',
  'interaction-worker-source.generated.mjs',
  'sqlite-runtime.generated.mjs',
  'selection-reference.mjs',
  'persisted-history.mjs',
  'history-projection-reader.mjs',
  'history-source-reader.mjs',
  'inherited-background.mjs',
  'background-snapshot-store.mjs',
  'conversation-file-lock.mjs',
  'terminal-message-committer.mjs',
  'terminal-message-worker.cjs',
];
await Promise.all(runtimeFiles.map((file) =>
  copyFile(new URL(file, sourceDirectory), new URL(file, outputDirectory))));
