import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterDropdownOptions,
  resolveDropdownActiveTab,
  type DropdownOption,
  type DropdownTab,
} from './dropdownMenu.ts';

const tabs: readonly DropdownTab[] = [
  { id: 'local', label: '本地' },
  { id: 'remote', label: '远程' },
];

const isolationOn: DropdownOption = {
  value: '__composer_env_isolation_on__',
  label: 'Worktree',
  group: '下次任务',
  hint: '下次',
};
const isolationOff: DropdownOption = {
  value: '__composer_env_isolation_off__',
  label: '当前工作区',
  group: '下次任务',
  hint: '下次',
};
const localMain: DropdownOption = {
  value: 'main',
  label: 'main',
  group: '源头',
  tab: 'local',
  hint: '本地',
};
const localRelease: DropdownOption = {
  value: '0.0.10',
  label: '0.0.10',
  group: '源头',
  tab: 'local',
  hint: '本地',
};
const remoteMain: DropdownOption = {
  value: 'origin/main',
  label: 'origin/main',
  group: '远程源头',
  tab: 'remote',
  hint: '远程',
};
const remoteRelease: DropdownOption = {
  value: 'origin/0.0.10',
  label: 'origin/0.0.10',
  group: '远程源头',
  tab: 'remote',
  hint: '远程',
};

const options = [isolationOn, isolationOff, localMain, localRelease, remoteMain, remoteRelease];

test('local tab keeps isolation options and hides remote sources', () => {
  assert.deepEqual(
    filterDropdownOptions(options, '', 'local').map((option) => option.value),
    [isolationOn.value, isolationOff.value, localMain.value, localRelease.value],
  );
});

test('remote tab keeps isolation options and hides local sources', () => {
  assert.deepEqual(
    filterDropdownOptions(options, '', 'remote').map((option) => option.value),
    [isolationOn.value, isolationOff.value, remoteMain.value, remoteRelease.value],
  );
});

test('search on local tab matches local sources and isolation, not remote-only names', () => {
  assert.deepEqual(
    filterDropdownOptions(options, 'main', 'local').map((option) => option.value),
    [localMain.value],
  );
  assert.deepEqual(
    filterDropdownOptions(options, 'origin/main', 'local').map((option) => option.value),
    [],
  );
  assert.deepEqual(
    filterDropdownOptions(options, 'worktree', 'local').map((option) => option.value),
    [isolationOn.value],
  );
});

test('search on remote tab matches remote sources and isolation, not local-only names', () => {
  assert.deepEqual(
    filterDropdownOptions(options, 'main', 'remote').map((option) => option.value),
    [remoteMain.value],
  );
  assert.deepEqual(
    filterDropdownOptions(options, '0.0.10', 'remote').map((option) => option.value),
    [remoteRelease.value],
  );
  assert.deepEqual(
    filterDropdownOptions(options, '当前工作区', 'remote').map((option) => option.value),
    [isolationOff.value],
  );
});

test('opening the menu falls back to the selected source tab', () => {
  assert.equal(
    resolveDropdownActiveTab({ tabs, options, value: localRelease.value }),
    'local',
  );
  assert.equal(
    resolveDropdownActiveTab({ tabs, options, value: remoteMain.value }),
    'remote',
  );
});

test('untagged or unknown selection falls back to the first tab', () => {
  assert.equal(
    resolveDropdownActiveTab({ tabs, options, value: isolationOn.value }),
    'local',
  );
  assert.equal(
    resolveDropdownActiveTab({ tabs, options, value: 'missing' }),
    'local',
  );
});
