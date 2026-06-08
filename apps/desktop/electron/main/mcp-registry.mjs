import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathOf } from './zeus-store.mjs';

function registryPath() {
  return pathOf('mcpRegistry');
}

function readRegistry() {
  const filePath = registryPath();
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeRegistry(items) {
  writeFileSync(registryPath(), JSON.stringify(items, null, 2), 'utf8');
}

export function createMcpRegistry() {
  function listInstalled() {
    return readRegistry();
  }

  function install(item) {
    const items = readRegistry();
    const existing = items.findIndex((i) => i.mcpId === item.mcpId);
    if (existing >= 0) {
      items[existing] = { ...items[existing], ...item, updatedAt: new Date().toISOString() };
    } else {
      items.push({ ...item, installedAt: new Date().toISOString() });
    }
    writeRegistry(items);
    return items;
  }

  function uninstall(mcpId) {
    const items = readRegistry().filter((i) => i.mcpId !== mcpId);
    writeRegistry(items);
    return items;
  }

  return { listInstalled, install, uninstall };
}
