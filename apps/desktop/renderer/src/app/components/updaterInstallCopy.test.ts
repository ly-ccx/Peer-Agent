import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createI18n } from '@peer-agent/i18n';

const installCopyKeys = [
  'updater.badge.openInstaller',
  'updater.toast.openInstaller',
  'updater.modal.openInstaller',
] as const;

describe('downloaded update install copy', () => {
  it('uses concise Chinese install labels and matching guidance', () => {
    const i18n = createI18n('zh-CN');

    for (const key of installCopyKeys) {
      assert.equal(i18n.t(key), '安装');
    }
    assert.match(i18n.t('updater.modal.openInstallerHint'), /点击「安装」/);
    assert.doesNotMatch(i18n.t('updater.modal.openInstallerHint'), /打开安装包/);
  });

  it('uses concise English install labels and matching guidance', () => {
    const i18n = createI18n('en-US');

    for (const key of installCopyKeys) {
      assert.equal(i18n.t(key), 'Install');
    }
    assert.match(i18n.t('updater.modal.openInstallerHint'), /clicking “Install”/);
    assert.doesNotMatch(i18n.t('updater.modal.openInstallerHint'), /Open installer/);
  });
});
