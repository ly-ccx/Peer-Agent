/**
 * electron-builder afterSign hook
 *
 * 在无 Developer ID 证书时（ad-hoc 签名），重新对整个 .app 执行
 * codesign --force --deep --sign - 以确保所有 framework 组件
 * Team ID 一致，避免 macOS dyld 启动崩溃。
 */
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // 检查是否使用了真正的证书签名
  const identity = process.env.CSC_LINK || process.env.CSC_NAME || '';
  const autoDiscovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY;

  // 如果没有证书或显式禁用了自动发现，执行 ad-hoc 重签
  if (!identity && autoDiscovery === 'false') {
    console.log('  • No signing certificate found, applying ad-hoc re-sign...');
    execSync(`xattr -cr "${appPath}"`);
    execSync(`codesign --force --deep --sign - "${appPath}"`);
    console.log('  • Ad-hoc re-sign complete');
  }
};
