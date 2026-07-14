#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises';

import { createB3PreviewManifest } from '../src/b3-wordmark.ts';

const outputUrl = new URL('../src/b3-wordmark.preview.json', import.meta.url);
await writeFile(outputUrl, `${JSON.stringify(createB3PreviewManifest(), null, 2)}\n`, 'utf8');
console.log(outputUrl.pathname);
