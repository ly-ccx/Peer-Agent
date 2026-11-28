import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dialog = readFileSync(new URL('./ModelSettingsDialog.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../styles/llm-settings.css', import.meta.url), 'utf8');

function ruleBody(className: string) {
  const match = css.match(new RegExp(`^\\.${className}\\s*\\{([^}]+)\\}`, 'm'));
  assert.ok(match, `Expected CSS rule for .${className}`);
  return match[1];
}

test('model settings scrolls a separate body while the fieldset owns the saving state', () => {
  assert.match(dialog, /<\/header>\s*<div className="llm-model-settings-body">\s*<fieldset className="llm-model-settings-fields ui-form-fields" disabled=\{saving\}>/);
  assert.match(dialog, /<\/fieldset>\s*<\/div>\s*<footer className="llm-dialog-footer">/);

  const body = ruleBody('llm-model-settings-body');
  assert.match(body, /\bflex:\s*1\s*;/);
  assert.match(body, /\bmin-height:\s*0\s*;/);
  assert.match(body, /\boverflow-y:\s*auto\s*;/);

  const fields = ruleBody('llm-model-settings-fields');
  assert.match(fields, /\bdisplay:\s*grid\s*;/);
  assert.match(fields, /\bpadding:\s*0\s*;/);
});

test('model settings header and footer do not shrink with the scrolling body', () => {
  assert.match(css, /\.llm-model-settings-dialog > \.llm-dialog-header,\s*\.llm-model-settings-dialog > \.llm-dialog-footer\s*\{[^}]*\bflex-shrink:\s*0\s*;/);
});
