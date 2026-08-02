import { pathToFileURL } from 'node:url';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateRegistrationInventory } from '../electron/ipc/registration-inventory.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const mainRoot = path.join(desktopRoot, 'electron/main');
const catalogPath = path.join(desktopRoot, 'electron/ipc/channels.mjs');
const sourcePath = path.join(desktopRoot, 'electron/preload/preload.source.cjs');
const generatedPath = path.join(desktopRoot, 'electron/preload/preload.cjs');
const checkOnly = process.argv.includes('--check');
const SOURCE_TOKEN = '/* __PEER_IPC_CHANNELS__ */ []';

const PRELOAD_CALL_PATTERN = /ipcRenderer\.(invoke|sendSync|send|on|removeListener)\(\s*(['"])([^'"\n]+)\2/g;
const MAIN_SEND_PATTERN = /(?:\?\.|\.)send\(\s*(['"])([^'"\n]+)\1/g;

const PRELOAD_TRANSPORT = Object.freeze({
  invoke: 'invoke',
  send: 'send',
  sendSync: 'send-sync',
  on: 'event',
  removeListener: 'event',
});

async function listProductionMainFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listProductionMainFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
      result.push(absolute);
    }
  }
  return result;
}

async function loadCatalog() {
  const url = `${pathToFileURL(catalogPath).href}?t=${Date.now()}-${Math.random()}`;
  return (await import(url)).DESKTOP_IPC_CATALOG;
}

function validateCatalog(catalog) {
  const transportCounts = new Map();
  const channels = new Set();
  for (const [key, entry] of Object.entries(catalog)) {
    if (!entry || entry.key !== key || typeof entry.channel !== 'string' || !entry.channel) {
      throw new Error(`Invalid catalog entry: ${key}`);
    }
    if (channels.has(entry.channel)) throw new Error(`Duplicate Desktop IPC channel: ${entry.channel}`);
    if (!['invoke', 'send', 'send-sync', 'event'].includes(entry.transport)) {
      throw new Error(`Invalid transport for ${key}: ${entry.transport}`);
    }
    if (!entry.owner || !Array.isArray(entry.allowedWindowRoles)) {
      throw new Error(`Incomplete caller policy for ${key}`);
    }
    const rendererToMain = entry.transport !== 'event';
    if (rendererToMain && (!entry.framePolicy || !entry.originPolicy)) {
      throw new Error(`Renderer-to-main channel lacks frame/origin policy: ${key}`);
    }
    channels.add(entry.channel);
    transportCounts.set(entry.transport, (transportCounts.get(entry.transport) ?? 0) + 1);
  }
  return { channels, transportCounts };
}

function validatePreloadSource(source, catalog) {
  if (!source.includes(SOURCE_TOKEN)) {
    throw new Error(`preload.source.cjs must contain ${SOURCE_TOKEN}`);
  }
  const usedKeys = new Set();
  let operationCount = 0;
  for (const match of source.matchAll(PRELOAD_CALL_PATTERN)) {
    const operation = match[1];
    const key = match[3];
    const entry = catalog[key];
    if (!entry) throw new Error(`Preload references unknown catalog key: ${key}`);
    if (entry.transport !== PRELOAD_TRANSPORT[operation]) {
      throw new Error(`Preload transport mismatch for ${key}: ${operation} vs ${entry.transport}`);
    }
    usedKeys.add(key);
    if (operation !== 'removeListener') operationCount += 1;
  }
  if (operationCount === 0) throw new Error('Preload source contains no catalog-backed IPC operations');
  return { operationCount, usedKeys };
}

async function validateMainInventory(catalog) {
  const files = [];
  const staticChannels = new Set();
  for (const file of await listProductionMainFiles(mainRoot)) {
    const text = await readFile(file, 'utf8');
    const relativePath = path.relative(desktopRoot, file);
    files.push({ path: relativePath, source: text });
    for (const match of text.matchAll(MAIN_SEND_PATTERN)) {
      const key = match[2];
      const entry = catalog[key];
      if (!entry) {
        throw new Error(`Main renderer event is missing from catalog: ${relativePath} -> ${key}`);
      }
      if (entry.transport !== 'event') throw new Error(`Main send transport mismatch for ${key}`);
      staticChannels.add(key);
    }
  }
  const inventory = validateRegistrationInventory({ catalog, files });
  for (const key of inventory.registeredKeys) staticChannels.add(key);
  return { ...inventory, staticChannels };
}

function generatePreload(source, catalog) {
  const overrides = Object.entries(catalog)
    .filter(([key, entry]) => entry.channel !== key)
    .map(([key, entry]) => [key, entry.channel]);
  const injected = `/* generated from electron/ipc/channels.mjs */ ${JSON.stringify(overrides, null, 2)}`;
  return source.replace(SOURCE_TOKEN, injected);
}

const catalog = await loadCatalog();
const { channels, transportCounts } = validateCatalog(catalog);
const source = await readFile(sourcePath, 'utf8');
const { operationCount, usedKeys } = validatePreloadSource(source, catalog);
const {
  registrationCount,
  handleCount,
  onCount,
  directCount,
  ownerCount,
} = await validateMainInventory(catalog);
const generated = generatePreload(source, catalog);

if (checkOnly) {
  const current = await readFile(generatedPath, 'utf8');
  if (current !== generated) throw new Error('preload.cjs is stale; run pnpm ipc:generate');
  console.log(
    `Desktop IPC catalog fresh: ${channels.size} channels, ` +
    `${operationCount} preload operations, ${registrationCount} main registrations ` +
    `(handle=${handleCount}, on=${onCount}, direct=${directCount}, owner=${ownerCount})`,
  );
} else {
  await writeFile(generatedPath, generated, 'utf8');
  console.log(
    `Generated sandbox preload from ${channels.size} canonical channels ` +
    `(${usedKeys.size} used by preload; transports=${JSON.stringify(Object.fromEntries(transportCounts))})`,
  );
}
