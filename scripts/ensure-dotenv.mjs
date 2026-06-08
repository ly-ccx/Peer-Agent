import { existsSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 首次 dev 启动时确保仓库根存在 .env：缺失则从 .env.example 复制一份，
 * 让新 clone / 重装环境无需手动 cp 就能跑起来并完成登录。
 *
 * - 幂等：已有 .env 直接跳过，绝不覆盖用户已有配置
 * - 缺 .env.example：只告警，不阻塞 dev 启动
 * - dev-only：由根 package.json 的 dev 脚本显式调用（pnpm 默认不跑 pre 钩子，
 *   故不依赖 predev），生产打包不经过 dev 脚本，天然不触发
 *
 * 创建位置与 main 进程 loadLocalEnv 读取的仓库根 .env 一致（apps/desktop/
 * electron/main/env-loader.mjs 按 workspaceRoot 解析）。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(repoRoot, '.env');
const examplePath = resolve(repoRoot, '.env.example');

if (existsSync(envPath)) {
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.warn('[ensure-dotenv] 未找到 .env.example，跳过自动创建 .env');
  process.exit(0);
}

copyFileSync(examplePath, envPath);
console.log(
  '\n[ensure-dotenv] 首次启动：已从 .env.example 创建 .env' +
    '（默认指向生产 Cloud Gateway + BUC PKCE 登录）。\n' +
    '  · 连预发：客户端「开发者模式」页（Cmd/Ctrl+Shift+D）切换，或编辑根目录 .env\n' +
    '  · 桌面端走 PKCE，切勿配置 client_secret\n'
);
