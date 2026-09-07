import { copyFile, mkdir, rm } from 'node:fs/promises';

const sourceDirectory = new URL('../src/', import.meta.url);
const outputDirectory = new URL('../dist/', import.meta.url);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const runtimeFiles = [
  'index.mjs',
  'index.d.ts',
  'selection-reference.mjs',
  'persisted-history.mjs',
  'inherited-background.mjs',
  'background-snapshot-store.mjs',
];
await Promise.all(runtimeFiles.map((file) =>
  copyFile(new URL(file, sourceDirectory), new URL(file, outputDirectory))));
