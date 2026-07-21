import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute package root for packages/npm-cli. */
export function packageRoot(fromUrl = import.meta.url) {
  // lib/paths.mjs → package root is parent of lib/
  return join(dirname(fileURLToPath(fromUrl)), '..');
}

/** Directory that holds peer + peer-credential-helper after postinstall. */
export function vendorDir(root = packageRoot()) {
  return join(root, 'vendor');
}

export function peerBinaryPath(root = packageRoot()) {
  return join(vendorDir(root), process.platform === 'win32' ? 'peer.exe' : 'peer');
}

export function helperBinaryPath(root = packageRoot()) {
  return join(
    vendorDir(root),
    process.platform === 'win32' ? 'peer-credential-helper.exe' : 'peer-credential-helper',
  );
}
