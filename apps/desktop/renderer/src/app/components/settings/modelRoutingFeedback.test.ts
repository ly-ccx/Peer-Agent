import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createI18n } from '@peer-agent/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { createEditableResource } from '../../../ui/forms/editableResource.ts';
import type { ModelRoutingFeedback as Feedback } from './ModelRoutingFeedback';

// The desktop node:test runner strips TS but does not transform JSX.
const source = readFileSync(new URL('./ModelRoutingFeedback.tsx', import.meta.url), 'utf8');
const exports: { ModelRoutingFeedback?: typeof Feedback } = {};
runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports, require(id: string) { if (id === 'react/jsx-runtime') return jsx; throw Error(id); } });
const ModelRoutingFeedback = exports.ModelRoutingFeedback!;
const i18n = createI18n('en-US');

function render(form: Parameters<typeof Feedback>[0]['form'], details: Partial<Parameters<typeof Feedback>[0]> = {}) {
  return renderToStaticMarkup(createElement(ModelRoutingFeedback, {
    i18n, form, onReload() {}, onRetry() {}, onDiscard() {}, onRetryPreview() {}, ...details,
  }));
}

test('failed save with a dirty draft, detailed error and failed preview renders one feedback row and one action of each type', async () => {
  const detail = i18n.t('modelRouting.reasoningInvalid');
  const resource = createEditableResource('', { read: async () => 'saved', write: async () => { throw Error(detail); } });
  await resource.load();
  resource.edit('edited');
  assert.equal(await resource.save(), false);
  const form = resource.snapshot();
  assert.equal(form.dirty && form.saveError, true);

  const html = render(form, { saveDetail: detail, previewError: true });
  assert.equal((html.match(/class="ui-form-feedback\b/g) ?? []).length, 1);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  assert.equal((html.match(/<button\b/g) ?? []).length, 2);
  assert.ok(html.includes(`>${i18n.t('forms.retry')}</button>`));
  assert.ok(html.includes(`>${i18n.t('forms.discard')}</button>`));
  assert.ok(html.includes(`<span>${i18n.t('forms.saveFailed')} ${detail}</span>`));
  assert.ok(!html.includes(i18n.t('forms.pendingSelection')));
  assert.ok(!html.includes(i18n.t('forms.previewFailed')));
  assert.doesNotMatch(html, /settings-warning/);

  resource.reset();
  const discarded = render(resource.snapshot(), { saveDetail: detail, previewError: true });
  assert.ok(!discarded.includes(detail));
  assert.ok(discarded.includes(i18n.t('forms.previewFailed')));
  assert.equal((discarded.match(/<button\b/g) ?? []).length, 1);
});

test('an invalid selection is surfaced in the same row without competing with preview retry', () => {
  const form = createEditableResource('', { read: async () => '', write: async () => '' }).snapshot();
  const selectionError = i18n.t('modelRouting.poolInvalid');
  const html = render(form, { selectionError, previewError: true });
  assert.ok(html.includes(`<span>${selectionError}</span>`));
  assert.doesNotMatch(html, /<button\b|settings-warning/);
});

test('the panel uses the same feedback element before its cards without parallel warning or retry rows', () => {
  const panel = readFileSync(new URL('./ModelRoutingPanel.tsx', import.meta.url), 'utf8');
  assert.equal((panel.match(/<ModelRoutingFeedback\b/g) ?? []).length, 1);
  assert.match(panel, /\{feedback\}\s*<SettingsGroup/);
  assert.doesNotMatch(panel, /<FormFeedback\b|settings-warning|forms\.(retry|discard|pendingSelection)/);
});
