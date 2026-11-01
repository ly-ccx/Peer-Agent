import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRoutingMenuOption } from '@peer-agent/protocol';
import { enabledModelCount, findSelectionModel, selectionGroupsFromMenuGroups, selectionGroupsFromRoutingModels } from './modelSelection.ts';

test('identical model labels keep distinct configured identities and provider groups', () => {
  const base: ModelRoutingMenuOption = { id: 'one', label: 'same-model', providerName: 'Service', groupId: 'first',
    model: 'same-model', authMethod: 'api_key', available: true, supportsVision: true,
    supportsTools: false, supportsStructured: false, contextTokens: 8192 };
  const groups = selectionGroupsFromRoutingModels([base, { ...base, id: 'two', groupId: 'second', available: false }], true);
  assert.equal(groups.length, 2);
  assert.equal(findSelectionModel(groups, 'one')?.group.id, 'first');
  assert.equal(findSelectionModel(groups, 'two')?.group.id, 'second');
  assert.equal(findSelectionModel(groups, 'two')?.model.disabled, true);
  assert.equal(findSelectionModel(groups, 'missing'), null);
  assert.equal(enabledModelCount(groups), 1);
});

test('owner restrictions and special choices survive adaptation without selecting a default', () => {
  const groups = selectionGroupsFromMenuGroups([
    { id: 'defaults', label: 'Defaults', items: [{ id: 'inherit', label: 'Inherit' }] },
    { id: 'denied', label: 'Restricted', disabled: true, items: [{ id: 'retained', label: 'Saved model' }] },
    { id: 'service', label: 'Service', items: [{ id: 'vision-only', label: 'Vision required', disabled: true }] },
  ]);
  assert.equal(findSelectionModel(groups, 'retained')?.model.label, 'Saved model');
  assert.equal(findSelectionModel(groups, 'vision-only')?.model.disabled, true);
  assert.equal(findSelectionModel(groups, '')?.model.id, undefined);
  assert.equal(enabledModelCount(groups), 1);
});
