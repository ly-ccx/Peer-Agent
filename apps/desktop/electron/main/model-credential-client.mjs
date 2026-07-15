import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CredentialHelperClient,
  createSubprocessCredentialTransport,
} from '@peer-agent/credential-helper';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../../../..');

export function createDesktopModelCredentialClient({ dataHome }) {
  return new CredentialHelperClient(createSubprocessCredentialTransport({
    dataHome,
    resourcesPath: typeof process.resourcesPath === 'string'
      ? process.resourcesPath
      : undefined,
    executablePath: process.execPath,
    repositoryRoot: REPOSITORY_ROOT,
    buildProfile: process.env.NODE_ENV === 'production' ? 'release' : 'debug',
  }));
}
