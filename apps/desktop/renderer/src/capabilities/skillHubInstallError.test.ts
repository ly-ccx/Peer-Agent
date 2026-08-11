import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeSkillHubInstallErrorCode,
  extractSkillHubInstallErrorCode,
  formatSkillHubInstallError,
} from './skillHubInstallError.ts';

describe('skillHubInstallError', () => {
  it('extracts bare and IPC-wrapped error codes', () => {
    assert.equal(extractSkillHubInstallErrorCode('skillhub_package_md5_mismatch'), 'skillhub_package_md5_mismatch');
    assert.equal(
      extractSkillHubInstallErrorCode('Error: skillhub_content_hash_mismatch'),
      'skillhub_content_hash_mismatch',
    );
    assert.equal(
      extractSkillHubInstallErrorCode(
        'Error invoking remote method \'skills:skillhub:install\': Error: skillhub_signature_invalid',
      ),
      'skillhub_signature_invalid',
    );
    assert.equal(extractSkillHubInstallErrorCode('workspace_required'), 'workspace_required');
  });

  it('maps known codes to readable Chinese messages', () => {
    assert.match(
      describeSkillHubInstallErrorCode('skillhub_package_md5_mismatch'),
      /MD5/,
    );
    assert.match(
      describeSkillHubInstallErrorCode('skillhub_signature_invalid'),
      /签名/,
    );
    assert.match(
      describeSkillHubInstallErrorCode('workspace_required'),
      /工作区/,
    );
  });

  it('formats install dialog text with human message and code', () => {
    assert.equal(
      formatSkillHubInstallError('skillhub_package_md5_mismatch'),
      '安装包 ZIP 的 MD5 与签名记录不一致（下载损坏或发布端不同步）（skillhub_package_md5_mismatch）',
    );
    assert.equal(
      formatSkillHubInstallError('Error: skillhub_content_hash_mismatch'),
      '安装包内容哈希校验失败（包内文件与签名不匹配）（skillhub_content_hash_mismatch）',
    );
    assert.match(formatSkillHubInstallError('some_unknown_code'), /some_unknown_code/);
  });
});
