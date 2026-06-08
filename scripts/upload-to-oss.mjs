#!/usr/bin/env node
/**
 * upload-to-oss.mjs
 *
 * 将 dist-electron/ 中的构建产物上传到阿里云 OSS。
 * electron-updater 的 generic provider 需要 latest-mac.yml / latest.yml 作为 manifest。
 *
 * Usage:
 *   node scripts/upload-to-oss.mjs --channel beta
 *   node scripts/upload-to-oss.mjs --channel latest
 *
 * Environment:
 *   OSS_ACCESS_KEY_ID     (from dict ID: 262)
 *   OSS_ACCESS_KEY_SECRET (from dict ID: 262)
 *
 * OSS Structure:
 *   releases/{channel}/latest-mac.yml
 *   releases/{channel}/latest.yml
 *   releases/{channel}/Zeus-Atlas-{version}-universal.dmg
 *   releases/{channel}/Zeus-Atlas-{version}-universal.zip
 *   releases/{channel}/Zeus-Atlas-Setup-{version}.exe
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist-electron');

// ── Parse args ──
const args = process.argv.slice(2);
const channelIdx = args.indexOf('--channel');
const channel = channelIdx !== -1 ? args[channelIdx + 1] : 'beta';

if (!['beta', 'latest'].includes(channel)) {
  console.error(`[upload-to-oss] Invalid channel: ${channel}. Must be "beta" or "latest".`);
  process.exit(1);
}

// ── OSS config ──
const OSS_REGION = 'oss-cn-beijing';
const OSS_BUCKET = 'zeus-atlas';
const OSS_ENDPOINT = `https://${OSS_REGION}.aliyuncs.com`;

const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;

if (!accessKeyId || !accessKeySecret) {
  console.error('[upload-to-oss] Missing OSS_ACCESS_KEY_ID or OSS_ACCESS_KEY_SECRET env vars.');
  console.error('  These credentials come from dictionary ID: 262.');
  process.exit(1);
}

// ── Dynamic import ali-oss (CommonJS package) ──
async function createOSSClient() {
  // ali-oss is CJS, use createRequire for ESM compatibility
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const OSS = require('ali-oss');
  return new OSS({
    region: OSS_REGION,
    accessKeyId,
    accessKeySecret,
    bucket: OSS_BUCKET,
    endpoint: OSS_ENDPOINT,
    authorizationV4: true,
  });
}

// ── Upload logic ──
// Patterns to upload (everything electron-builder puts in dist-electron/)
const UPLOAD_EXTENSIONS = ['.dmg', '.zip', '.exe', '.blockmap', '.yml', '.yaml'];

async function main() {
  console.log(`[upload-to-oss] Channel: ${channel}`);
  console.log(`[upload-to-oss] Dist dir: ${DIST_DIR}`);

  const files = readdirSync(DIST_DIR).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return UPLOAD_EXTENSIONS.includes(ext) && statSync(path.join(DIST_DIR, f)).isFile();
  });

  if (files.length === 0) {
    console.error('[upload-to-oss] No uploadable files found in dist-electron/');
    process.exit(1);
  }

  console.log(`[upload-to-oss] Found ${files.length} file(s) to upload:`);
  files.forEach((f) => console.log(`  - ${f}`));

  const client = await createOSSClient();
  const prefix = `releases/${channel}`;

  for (const file of files) {
    const localPath = path.join(DIST_DIR, file);
    const ossKey = `${prefix}/${file}`;
    const fileSize = statSync(localPath).size;

    console.log(`[upload-to-oss] Uploading ${file} (${(fileSize / 1024 / 1024).toFixed(1)} MB) → ${ossKey}`);

    if (fileSize > 100 * 1024 * 1024) {
      // 大于 100MB 使用分片上传
      await client.multipartUpload(ossKey, localPath, {
        partSize: 10 * 1024 * 1024, // 10MB per part
        progress: (p) => {
          process.stdout.write(`\r  progress: ${(p * 100).toFixed(1)}%`);
        },
      });
      console.log('');
    } else {
      await client.put(ossKey, localPath);
    }

    console.log(`  ✓ uploaded: https://${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com/${ossKey}`);
  }

  console.log(`\n[upload-to-oss] Done! ${files.length} file(s) uploaded to /${prefix}/`);
  console.log(`[upload-to-oss] Update URL: https://${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com/${prefix}/`);
}

main().catch((err) => {
  console.error('[upload-to-oss] Fatal error:', err);
  process.exit(1);
});
