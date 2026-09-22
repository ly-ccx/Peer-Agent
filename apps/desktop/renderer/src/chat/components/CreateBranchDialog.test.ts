import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./CreateBranchDialog.tsx', import.meta.url), 'utf8');
const surface = readFileSync(new URL('./ChatSurface.tsx', import.meta.url), 'utf8');

test('the dialog owns a source-branch picker instead of inheriting the capsule highlight', () => {
  // Source is the dialog's own state, seeded from an explicit prop.
  assert.match(source, /const \[source, setSource\] = useState\(initialSource\);/);
  assert.match(source, /readonly initialSource: string;/);
  // And it is editable here: local/remote tabs plus search, same affordances as the capsule.
  assert.match(source, /readonly sourceOptions: readonly DropdownOption\[\];/);
  assert.match(source, /\{ id: 'local', label: isZh \? '本地' : 'Local' \}/);
  assert.match(source, /\{ id: 'remote', label: isZh \? '远程' : 'Remote' \}/);
  assert.match(source, /tabs=\{tabs\}/);
  assert.match(source, /searchable/);
  assert.match(source, /onChange=\{setSource\}/);
});

test('the chosen source is what gets reported back on confirm', () => {
  assert.match(source, /onConfirm\(\{ name: name\.trim\(\), source: trimmedSource, push, upstream \}\);/);
  assert.match(source, /readonly source: string;/);
});

test('confirm stays disabled until the source, the name and the upstream are all usable', () => {
  assert.match(source, /const sourceOk = Boolean\(trimmedSource\) && !isComposerEnvSentinel\(trimmedSource\);/);
  assert.match(source, /const nameOk = isSafeComposerBranchName\(name\);/);
  assert.match(source, /const canConfirm = sourceOk && nameOk && \(!push \|\| upstreamSpec != null\);/);
  assert.match(source, /disabled=\{!canConfirm\}/);
  // The guard is enforced in the handler too, not only via the button's disabled state.
  assert.match(source, /if \(!canConfirm\) return;/);
});

test('the dialog never renders an isolation sentinel as a branch name', () => {
  assert.match(source, /isComposerEnvSentinel/);
  assert.match(source, /请先选择源头分支/);
});

test('ChatSurface opens the dialog without passing any list-row value', () => {
  // The entry point takes no arguments at all, so the hovered row cannot reach the source.
  assert.match(surface, /const handleOpenCreateBranchDialog = useCallback\(\(\) => \{/);
  assert.match(surface, /onCreateBranch=\{handleOpenCreateBranchDialog\}/);
  assert.doesNotMatch(surface, /handleOpenCreateBranchDialog\(highlightedValue\)/);
  // And the dialog is rendered from the extracted module with the branch-only option list.
  assert.match(surface, /<CreateBranchDialog/);
  assert.match(surface, /sourceOptions=\{composerBranchOptions\}/);
  assert.match(surface, /onConfirm=\{handleCreateBoundBranch\}/);
});

test('the create-branch entry is independent of the capsule branch-switch affordance', () => {
  // Branch options for the dialog must not be gated on the capsule's own selectable flag,
  // otherwise the picker would come up empty exactly when the user wants to fork.
  assert.match(surface, /const composerBranchOptions = useMemo<readonly DropdownOption\[\]>/);
  assert.match(surface, /sourceOptions=\{composerBranchOptions\}/);
  assert.match(surface, /onCreateBranch=\{handleOpenCreateBranchDialog\}/);
  assert.doesNotMatch(surface, /\[\.\.\.isolationOptions, \.\.\.composerBranchOptions\]/);
});

test('creating a branch cannot reach git with a sentinel or an empty start point', () => {
  assert.match(surface, /const source = request\.source\.trim\(\);/);
  assert.match(surface, /if \(!source \|\| isComposerEnvSentinel\(source\)\) return;/);
  assert.match(surface, /startPoint: source,/);
});
