import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMacAppIconFile,
  planMacAppIconRead,
  resolveMacAppIconFile,
  resolveMacAppIconPath,
} from './mac-app-icon.mjs';

test('resolveMacAppIconFile reads CFBundleIconFile and appends .icns', () => {
  const plist = `<?xml version="1.0"?>
<plist><dict>
  <key>CFBundleIconFile</key>
  <string>Code</string>
</dict></plist>`;
  assert.equal(resolveMacAppIconFile(plist), 'Code.icns');
});

test('resolveMacAppIconFile keeps an existing .icns suffix', () => {
  const plist = `<key>CFBundleIconFile</key><string>AppIcon.icns</string>`;
  assert.equal(resolveMacAppIconFile(plist), 'AppIcon.icns');
});

test('resolveMacAppIconFile falls back to CFBundleIconName', () => {
  const plist = `<key>CFBundleIconName</key><string>Zed</string>`;
  assert.equal(resolveMacAppIconFile(plist), 'Zed.icns');
});

test('resolveMacAppIconPath joins Resources and requires the file to exist', () => {
  const files = new Set([
    '/Applications/Visual Studio Code.app/Contents/Info.plist',
    '/Applications/Visual Studio Code.app/Contents/Resources/Code.icns',
  ]);
  const path = resolveMacAppIconPath('/Applications/Visual Studio Code.app', {
    exists: (candidate) => files.has(candidate),
    readFile: () => `<key>CFBundleIconFile</key><string>Code</string>`,
  });
  assert.equal(path, '/Applications/Visual Studio Code.app/Contents/Resources/Code.icns');
});

test('resolveMacAppIconPath returns null when the icns is missing', () => {
  const path = resolveMacAppIconPath('/Applications/Ghost.app', {
    exists: (candidate) => candidate.endsWith('Info.plist'),
    readFile: () => `<key>CFBundleIconFile</key><string>Missing</string>`,
  });
  assert.equal(path, null);
});

test('resolveMacAppIconPath returns an already-resolved icon file as-is', () => {
  const icns = '/Applications/Visual Studio Code.app/Contents/Resources/Code.icns';
  const path = resolveMacAppIconPath(icns, {
    exists: (candidate) => candidate === icns,
    readFile: () => {
      throw new Error('should not parse Info.plist for an icon file');
    },
  });
  assert.equal(path, icns);
});

test('planMacAppIconRead loads resolved icon files instead of getFileIcon', () => {
  const icns = '/Applications/Cursor.app/Contents/Resources/Cursor.icns';
  assert.equal(isMacAppIconFile(icns), true);
  assert.deepEqual(
    planMacAppIconRead(icns, { exists: (candidate) => candidate === icns }),
    { kind: 'file', path: icns },
  );
  assert.deepEqual(
    planMacAppIconRead(icns, { exists: () => false }),
    { kind: 'none' },
  );
});

test('planMacAppIconRead only uses getFileIcon for app bundles', () => {
  assert.deepEqual(
    planMacAppIconRead('/Applications/Zed.app', { exists: () => false }),
    { kind: 'file-icon', path: '/Applications/Zed.app' },
  );
});
