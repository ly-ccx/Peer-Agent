import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { interactiveRecoveryText } from './interactiveRecoveryText.ts';
test('recovery copies the raw interrupted input with control labels while retaining effective values separately', async () => {
  const content = await validateDraft({ title: 'Trial', textFallback: 'Unverified trial.',
    program: '$name="Original"\n$x=2\nroot=Col([Input("name","Trial name",$name),NumberInput("x","Divisor",$x,0,10,1)])' });
  const state = { values: content.initialValues, inputDrafts: { $name: '中断输入', $x: '-' } };
  assert.equal(interactiveRecoveryText(content, state, false), 'Trial name: 中断输入\nDivisor: -');
  assert.equal(state.values.$name, 'Original'); assert.equal(state.values.$x, 2);
});
