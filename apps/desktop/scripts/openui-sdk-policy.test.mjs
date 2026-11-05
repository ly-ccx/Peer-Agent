import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import { peerOpenuiSdkPolicy } from './openui-sdk-policy.mjs';

test('the SDK transform removes the development bootstrap from the actual public entry', async () => {
  const file = fileURLToPath(import.meta.resolve('@openuidev/react-lang'));
  const original = readFileSync(file, 'utf8');
  assert.match(original, /import\("@openuidev\/devtools"\)/, 'the fixed SDK test exercises its real bootstrap');
  console.info('[sdk-policy-test] Transforming public SDK entry');
  const transformed = await peerOpenuiSdkPolicy().transform(original, `${file}?v=peer-test`);
  assert.ok(transformed?.code); assert.ok(transformed.map);
  assert.doesNotMatch(transformed.code, /import\("@openuidev\/devtools"\)|data-openui-devtools-auto-mount|Symbol\.for\("openui\.devtools/);
  assert.match(transformed.code, /Renderer/);
});

test('the actual Vite dev transform applies the policy before import analysis, without a GUI or listening port', { timeout: 60000 }, async () => {
  const file = fileURLToPath(import.meta.resolve('@openuidev/react-lang'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'peer-sdk-policy-cache-'));
  console.info('[sdk-policy-test] Creating isolated middleware server');
  const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, cacheDir,
    plugins: [{ name: 'peer-sdk-policy-test-no-prebundle', enforce: 'post', config(config) {
      // React adds optimizer entries after the inline config is merged. This
      // middleware-only fixture has no browser crawl to settle their lifecycle.
      config.optimizeDeps.include = [];
    } }],
    optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'silent' });
  try {
    assert.ok(server.config.optimizeDeps.exclude.includes('@openuidev/react-lang'));
    assert.deepEqual(server.config.optimizeDeps.include, []);
    console.info('[sdk-policy-test] Running Vite import analysis');
    const result = await server.transformRequest(`/@fs/${file}`);
    assert.ok(result?.code);
    assert.doesNotMatch(result.code, /@openuidev\/devtools|data-openui-devtools-auto-mount/);
    assert.match(result.code, /Renderer/);
  } finally {
    console.info('[sdk-policy-test] Closing middleware server');
    await server.close();
    console.info('[sdk-policy-test] Middleware server closed');
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('application and other dependency development behavior stays outside the SDK transform', async () => {
  const plugin = peerOpenuiSdkPolicy(), code = 'if (process.env.NODE_ENV === "development") console.log("application development");';
  for (const id of ['/tmp/peer/Panel.jsx', '/tmp/react/index.js', '\0virtual:peer']) assert.equal(await plugin.transform(code, id), null);
});
