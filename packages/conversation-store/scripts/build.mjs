import { copyFile, mkdir, rm } from 'node:fs/promises';

const sourceDirectory = new URL('../src/', import.meta.url);
const outputDirectory = new URL('../dist/', import.meta.url);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await Promise.all([
  copyFile(new URL('index.mjs', sourceDirectory), new URL('index.mjs', outputDirectory)),
  copyFile(new URL('index.d.ts', sourceDirectory), new URL('index.d.ts', outputDirectory)),
]);
