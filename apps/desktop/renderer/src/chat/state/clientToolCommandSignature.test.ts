import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildClientToolCommandSignature } from './clientToolCommandSignature.ts';

/**
 * M3·G —— "一直允许"命令签名。
 * 关键：aone-kit 到 tool-id 粒度（同 tool-id 不同 args 同签名），换 tool-id 不同签名。
 */
const call = (capabilityId: string, argumentsPreview: unknown) =>
  ({ capabilityId, argumentsPreview, toolCallId: 't' }) as any;

describe('buildClientToolCommandSignature（G·一直允许）', () => {
  it('aone-kit call-tool：到 tool-id 粒度，忽略易变 args', () => {
    const s1 = buildClientToolCommandSignature(
      call('local.shell.exec', {
        command: "aone-kit call-tool ata::article-comprehensive-page-query '{\"a\":1}'",
      })
    );
    const s2 = buildClientToolCommandSignature(
      call('local.shell.exec', {
        command: "aone-kit call-tool ata::article-comprehensive-page-query '{\"a\":2}'",
      })
    );
    assert.equal(s1, s2); // 同 tool-id 不同 args → 同签名
    assert.match(s1, /ata::article-comprehensive-page-query/);
  });

  it('换 tool-id（尤其写操作）→ 不同签名', () => {
    const read = buildClientToolCommandSignature(
      call('local.shell.exec', { command: 'aone-kit call-tool ata::user-self {}' })
    );
    const write = buildClientToolCommandSignature(
      call('local.shell.exec', { command: 'aone-kit call-tool ata::article-draft-create {}' })
    );
    assert.notEqual(read, write);
  });

  it('a1 与 aone-kit 同规则', () => {
    const s = buildClientToolCommandSignature(
      call('local.shell.exec', { command: 'a1 call-tool ata::user-self {}' })
    );
    assert.match(s, /a1 call-tool ata::user-self/);
  });

  it('一般 shell：程序 + 子命令，去路径', () => {
    const s = buildClientToolCommandSignature(
      call('local.shell.exec', { command: '/usr/bin/git status --short' })
    );
    assert.match(s, /git status/);
    assert.doesNotMatch(s, /usr\/bin/);
  });

  it('无可识别命令 → 退化为 capabilityId', () => {
    assert.equal(
      buildClientToolCommandSignature(call('local.shell.exec', {})),
      'local.shell.exec'
    );
  });
});
