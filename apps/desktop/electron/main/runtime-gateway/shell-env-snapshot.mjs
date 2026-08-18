import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Shell 环境快照（对齐 Claude Code ShellSnapshot 机制）。
 *
 * 问题：electron GUI 启动的 process.env.PATH 不含用户 .zshrc/.bashrc 注入的路径
 * （如 .qoderwork/bin 的 a1 shim），裸 sh -c 的子进程找不到已登录的 CLI。
 *
 * 方案：启动时用用户的 $SHELL 以 login+interactive 模式 source 一次 shell 配置，
 * 捕获完整环境（PATH / aliases / functions / env vars）→ 存快照文件；
 * 后续每条 shell 命令 `source <snapshot> && eval '<command>'`，
 * 不再每次 spawn login shell（避免开销和 TTY 副作用）。
 *
 * 快照丢失时 fallback：spawn 加 -l flag（login shell，与 Claude Code 一致）。
 */

const SNAPSHOT_TIMEOUT_MS = 10_000;
// 兜底 user-bin 列表：即使 .zshrc 在子壳里没执行到 PATH hook，
// 这些常见路径也会被显式 prepend，保证 a1 / pnpm / cargo 等 CLI 可被发现。
const FALLBACK_USER_BINS = [
  '$HOME/.local/bin',
  '$HOME/.qoderwork/bin',
  '$HOME/bin',
  '$HOME/.cargo/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
];
let snapshotFilePath = null;
let snapshotReady = false;

function getConfigFile(shellPath) {
  if (shellPath.includes('zsh')) return '~/.zshrc';
  if (shellPath.includes('bash')) {
    return existsSync(join(process.env.HOME || '', '.bashrc'))
      ? '~/.bashrc'
      : '~/.profile';
  }
  return '~/.profile';
}

/**
 * 启动时调用一次。source 用户 shell 配置 → 导出 env/aliases/functions → 存快照。
 * 返回快照文件路径（成功）或 null（失败，后续 fallback 到 login shell）。
 */
export async function createShellEnvSnapshot() {
  const userShell = process.env.SHELL || '/bin/zsh';
  const configFile = getConfigFile(userShell);
  const snapshotDir = join(tmpdir(), 'peer-agent-shell');
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });
  const filePath = join(snapshotDir, `env-snapshot-${process.pid}.sh`);

  const errFile = join(snapshotDir, `source-${process.pid}.err`);
  const fallbackPrepend = FALLBACK_USER_BINS.join(':');
  const script = `
    # Source user config (stdin /dev/null 防止交互提示阻塞；stderr 落盘便于事后排查)
    [ -f ${configFile} ] && source ${configFile} < /dev/null 2>>"${errFile}"
  
    # 显式兜底：把常见 user-bin 路径前置到 PATH，即使 .zshrc 没注入也能 work
    export PATH="${fallbackPrepend}:$PATH"
  
    # Create snapshot file
    SNAPSHOT_FILE="${filePath}"
    echo "# peer-agent shell env snapshot" >| "$SNAPSHOT_FILE"
  
    # Export key env vars (PATH is the critical one — contains .zshrc additions)
    # 白名单扩充：A1_*/BUC_*/AONE_*/ALIBABA_*/QODERWORK_*/XDG_* 用于内网 CLI 登录态
    env | while IFS='=' read -r key value; do
      case "$key" in
        PATH|HOME|USER|SHELL|TERM|LANG|LC_*|EDITOR|VISUAL|PAGER|SSH_AUTH_SOCK|GPG_TTY|NVM_DIR|GOPATH|CARGO_HOME|RUSTUP_HOME|JAVA_HOME|ANDROID_HOME|PYENV_ROOT|A1_*|BUC_*|AONE_*|ALIBABA_*|QODERWORK_*|XDG_*)
          echo "export $key=\\"$value\\"" >> "$SNAPSHOT_FILE"
          ;;
      esac
    done
  
    # 导出 shell functions 的尝试已回滚：zsh 'typeset -f' 会把 oh-my-zsh / p10k 等
    # 含 zsh 专属语法的函数体写入快照，sh (bash POSIX) source 时会触发语法错误 abort，
    # 导致 sh 子进程在 eval <cmd> 之前就直接 exit 2、全无输出。a1 是独立二进制，
    # 不需要 zsh function；如果未来确实有用户用 function 包装 CLI，再单独白名单。

    # Export aliases (shell-specific)
    if [ -n "$ZSH_VERSION" ]; then
      alias | sed 's/^/alias /' >> "$SNAPSHOT_FILE" 2>/dev/null
    else
      alias -p >> "$SNAPSHOT_FILE" 2>/dev/null || true
    fi
  `;

  return new Promise((resolve) => {
    const child = execFile(userShell, ['-ilc', script], {
      timeout: SNAPSHOT_TIMEOUT_MS,
      env: { ...process.env },
    }, (error) => {
      if (error) {
        console.warn('[shell-env-snapshot] 快照创建失败，后续 fallback 到 login shell:', error.message);
        snapshotReady = false;
        resolve(null);
        return;
      }
      if (existsSync(filePath)) {
        snapshotFilePath = filePath;
        snapshotReady = true;
        resolve(filePath);
      } else {
        console.warn('[shell-env-snapshot] 快照文件未生成');
        snapshotReady = false;
        resolve(null);
      }
    });
  });
}

/**
 * 返回 spawn 参数：有快照 → source 快照 + eval 命令；无快照 → fallback -l。
 */
export function buildShellSpawnArgs(command) {
  const userShell = process.env.SHELL || '/bin/zsh';
  if (snapshotReady && snapshotFilePath) {
    const wrappedCommand = `source "${snapshotFilePath}" 2>/dev/null || true; eval ${shellQuote(command)}`;
    return { shell: 'sh', args: ['-c', wrappedCommand] };
  }
  // Fallback：无快照 → login shell（与 Claude Code 一致）
  return { shell: userShell, args: ['-lc', command] };
}

/**
 * 进程退出时清理快照文件。
 */
export function buildShellSessionBootstrap() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const pathPrefix = [
    join(homeDir, '.local/bin'),
    join(homeDir, '.qoderwork/bin'),
    join(homeDir, 'bin'),
    join(homeDir, '.cargo/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter(Boolean).join(':');
  const source = snapshotReady && snapshotFilePath
    ? `source "${snapshotFilePath}" 2>/dev/null || true\n`
    : '';
  return `${source}export PATH="${pathPrefix}:$PATH"\n`;
}

export function cleanupSnapshot() {
  if (snapshotFilePath && existsSync(snapshotFilePath)) {
    try { unlinkSync(snapshotFilePath); } catch { /* ignore */ }
  }
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
