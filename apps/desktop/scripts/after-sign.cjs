/**
 * electron-builder afterSign hook
 *
 * 保留有效的 Developer ID 签名；没有显式证书且 bundle 尚未形成有效资源封印时，
 * 对完整 .app 执行 ad-hoc 深度签名，确保 Framework 与额外原生二进制使用一致身份。
 * 如果配置了显式证书却得到无效 bundle，必须失败，禁止静默降级为 ad-hoc。
 */
const { spawnSync } = require('child_process');
const path = require('path');

function run(runner, command, args, options = {}) {
  const result = runner(command, args, {
    stdio: options.stdio ?? 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}

function hasExplicitSigningIdentity(env) {
  return Boolean(env.CSC_LINK || env.CSC_NAME);
}

function hasCertificateSignature(runner, appPath) {
  const result = runner(
    'codesign',
    ['-dv', '--verbose=4', appPath],
    { encoding: 'utf8', stdio: 'pipe', windowsHide: true },
  );
  if (result.error) throw result.error;
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return /(?:^|\n)Authority=/m.test(details)
    || /(?:^|\n)TeamIdentifier=(?!not set(?:\n|$))\S+/m.test(details);
}

function verifyBundle(runner, appPath) {
  const result = runner(
    'codesign',
    ['--verify', '--deep', '--strict', appPath],
    { stdio: 'ignore', windowsHide: true },
  );
  if (result.error) throw result.error;
  return result.status === 0;
}

function ensureMacBundleSigned({ appPath, env = process.env, runner = spawnSync }) {
  if (verifyBundle(runner, appPath)) {
    return 'already-valid';
  }

  if (hasExplicitSigningIdentity(env) || hasCertificateSignature(runner, appPath)) {
    throw new Error(
      `The signed macOS bundle is invalid and cannot be downgraded to ad-hoc: ${appPath}`,
    );
  }

  console.log('  • No valid signing certificate found, applying ad-hoc re-sign...');
  run(runner, 'xattr', ['-cr', appPath]);
  run(runner, 'codesign', ['--force', '--deep', '--sign', '-', appPath]);
  if (!verifyBundle(runner, appPath)) {
    throw new Error(`The ad-hoc macOS bundle signature is invalid: ${appPath}`);
  }
  console.log('  • Ad-hoc re-sign complete');
  return 'ad-hoc-signed';
}

exports.ensureMacBundleSigned = ensureMacBundleSigned;

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  ensureMacBundleSigned({ appPath });
};
