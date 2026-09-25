import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createI18n } from '@peer-agent/i18n';

describe('downloaded update install copy', () => {
  it('uses a concise Chinese install label', () => {
    assert.equal(createI18n('zh-CN').t('updater.badge.install'), '安装');
  });

  it('uses a concise English install label', () => {
    assert.equal(createI18n('en-US').t('updater.badge.install'), 'Install');
  });
});
