const DIRECT_REGISTRATION_PATTERN = /ipcMain\.(handle|on)\(\s*(['"])([^'"\n]+)\2/g;
const OWNER_START_PATTERN = /owner\(\s*(['"])([^'"\n]+)\1\s*,\s*\(ipc\)\s*=>\s*\{/g;
const OWNER_REGISTRATION_PATTERN = /\bipc\.(handle|on)\(\s*(['"])([^'"\n]+)\2/g;

function transportMatches(operation, transport) {
  return operation === 'handle'
    ? transport === 'invoke'
    : transport === 'send' || transport === 'send-sync';
}

export function scanRegistrationSource(source, { file = '<source>' } = {}) {
  const registrations = [];
  for (const match of source.matchAll(DIRECT_REGISTRATION_PATTERN)) {
    registrations.push({
      file,
      operation: match[1],
      key: match[3],
      owner: null,
      kind: 'direct',
      offset: match.index,
    });
  }

  const ownerStarts = [...source.matchAll(OWNER_START_PATTERN)];
  for (let index = 0; index < ownerStarts.length; index += 1) {
    const ownerMatch = ownerStarts[index];
    const owner = ownerMatch[2];
    const start = ownerMatch.index;
    const end = ownerStarts[index + 1]?.index ?? source.length;
    const segment = source.slice(start, end);
    for (const match of segment.matchAll(OWNER_REGISTRATION_PATTERN)) {
      registrations.push({
        file,
        operation: match[1],
        key: match[3],
        owner,
        kind: 'owner',
        offset: start + match.index,
      });
    }
  }

  return registrations.sort((left, right) => left.offset - right.offset);
}

export function validateRegistrationInventory({ catalog, files }) {
  if (!catalog || typeof catalog !== 'object') throw new TypeError('catalog must be an object');
  if (!Array.isArray(files)) throw new TypeError('files must be an array');

  const registrations = files.flatMap(({ path, source }) =>
    scanRegistrationSource(source, { file: path }));
  const byKey = new Map();
  let handleCount = 0;
  let onCount = 0;
  let directCount = 0;
  let ownerCount = 0;

  for (const registration of registrations) {
    const entry = catalog[registration.key];
    if (!entry) {
      throw new Error(
        `Main registration is missing from catalog: ${registration.file} -> ${registration.key}`,
      );
    }
    if (!transportMatches(registration.operation, entry.transport)) {
      throw new Error(
        `Main registration transport mismatch for ${registration.key}: `
        + `${registration.kind === 'direct' ? 'ipcMain' : 'ipc'}.${registration.operation}`,
      );
    }
    if (registration.owner && registration.owner !== entry.owner) {
      throw new Error(
        `Main registration owner mismatch for ${registration.key}: `
        + `${registration.owner} vs ${entry.owner}`,
      );
    }
    const existing = byKey.get(registration.key);
    if (existing) {
      throw new Error(
        `Duplicate Main registration for ${registration.key}: `
        + `${existing.file} and ${registration.file}`,
      );
    }
    byKey.set(registration.key, registration);
    if (registration.operation === 'handle') handleCount += 1;
    else onCount += 1;
    if (registration.kind === 'direct') directCount += 1;
    else ownerCount += 1;
  }

  const missing = Object.entries(catalog)
    .filter(([key, entry]) => entry.transport !== 'event' && !byKey.has(key))
    .map(([key]) => key)
    .sort();
  if (missing.length > 0) {
    throw new Error(`Catalog channels lack a Main registration: ${missing.join(', ')}`);
  }

  return Object.freeze({
    registrations: Object.freeze(registrations),
    registeredKeys: new Set(byKey.keys()),
    registrationCount: registrations.length,
    handleCount,
    onCount,
    directCount,
    ownerCount,
  });
}
