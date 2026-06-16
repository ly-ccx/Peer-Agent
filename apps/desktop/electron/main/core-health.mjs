import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function getElectronApp() {
  try {
    const electron = require('electron');
    return electron && typeof electron === 'object' ? electron.app : null;
  } catch {
    return null;
  }
}

function localizeHealth(locale) {
  const zh = locale === 'zh-CN';
  return {
    missingCore: zh
      ? 'Rust health stub 尚未构建。请先执行 cargo build --workspace。'
      : 'Rust health stub has not been built yet. Run cargo build --workspace.',
    failed: zh ? '本地 health 能力执行失败。' : 'Local health capability failed.',
    success: zh ? '本地 health 能力执行完成。未读取本地文件。' : 'Local health capability completed. No local files were read.',
  };
}

function coreBinaryPath(workspaceRoot) {
  const executable = process.platform === 'win32' ? 'cu-proxy-core.exe' : 'cu-proxy-core';
  // In packaged mode, binary is in extraResources/bin/; in dev mode, target/debug/
  const electronApp = getElectronApp();
  if (electronApp?.isPackaged) {
    return path.join(process.resourcesPath, 'bin', executable);
  }
  return path.join(workspaceRoot, 'target/debug', executable);
}

export function runHealthStub({ workspaceRoot, toolCallId, locale }) {
  const binary = coreBinaryPath(workspaceRoot);
  const copy = localizeHealth(locale);

  if (!existsSync(binary)) {
    return Promise.resolve({
      toolCallId,
      status: 'failed',
      outputPreview: {
        status: 'core_binary_missing',
        expectedPath: binary,
      },
      evidence: {
        evidenceId: randomUUID(),
        toolCallId,
        summary: copy.missingCore,
        locale,
        returnedToCloud: false,
        dataLevel: 'D0_public',
        redactions: [],
        artifactRefs: [],
      },
      completedAt: new Date().toISOString(),
    });
  }

  return new Promise((resolve) => {
    const child = spawn(binary, ['health'], {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      const completedAt = new Date().toISOString();
      if (code !== 0) {
        resolve({
          toolCallId,
          status: 'failed',
          outputPreview: { code, stderr },
          evidence: {
            evidenceId: randomUUID(),
            toolCallId,
            summary: copy.failed,
            locale,
            returnedToCloud: false,
            dataLevel: 'D0_public',
            redactions: [],
            artifactRefs: [],
          },
          completedAt,
        });
        return;
      }

      let parsed = {};
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = { stdout: stdout.trim() };
      }

      resolve({
        toolCallId,
        status: 'success',
        outputPreview: parsed,
        evidence: {
          evidenceId: randomUUID(),
          toolCallId,
          summary: copy.success,
          locale,
          returnedToCloud: false,
          dataLevel: 'D0_public',
          redactions: [],
          artifactRefs: [],
        },
        completedAt,
      });
    });
  });
}
