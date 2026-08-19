import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildOpenTargetMenu, resolveDefaultEditorId } from './openTargetMenu.ts';

const VSCODE = { id: 'vscode', name: 'Visual Studio Code', iconDataUrl: 'data:image/png;base64,vscode' };
const ZED = { id: 'zed', name: 'Zed', iconDataUrl: 'data:image/png;base64,zed' };

describe('resolveDefaultEditorId', () => {
  it('keeps a stored editor that is still installed', () => {
    assert.equal(resolveDefaultEditorId([VSCODE, ZED], 'zed'), 'zed');
  });

  it('falls back to the first candidate when the stored editor is gone', () => {
    assert.equal(resolveDefaultEditorId([ZED], 'vscode'), 'zed');
  });

  it('returns null when this machine has no editors', () => {
    assert.equal(resolveDefaultEditorId([], 'vscode'), null);
  });
});

describe('buildOpenTargetMenu', () => {
  it('lists installed editors, marks the default, and appends folder + Finder entries', () => {
    const menu = buildOpenTargetMenu({
      editors: [VSCODE, ZED],
      defaultEditorId: 'zed',
      isZh: true,
    });

    assert.equal(menu.defaultEditorId, 'zed');
    assert.equal(menu.defaultEditorName, 'Zed');
    assert.equal(menu.defaultEditorIconDataUrl, 'data:image/png;base64,zed');
    assert.deepEqual(
      menu.items.map((item) => item.kind === 'separator' ? '---' : `${item.kind}:${item.id}`),
      ['editor:vscode', 'editor:zed', '---', 'folder:open-parent', '---', 'reveal:reveal'],
    );

    const selected = menu.items.find((item) => item.kind === 'editor' && item.selected);
    assert.equal(selected && selected.kind === 'editor' ? selected.id : null, 'zed');
    assert.equal(selected && selected.kind === 'editor' ? selected.iconDataUrl : null, 'data:image/png;base64,zed');

    const folder = menu.items.find((item) => item.kind === 'folder');
    assert.deepEqual(folder && folder.kind === 'folder' ? folder.action : null, {
      kind: 'open-parent',
      editorId: 'zed',
    });
    assert.equal(folder && folder.kind === 'folder' ? folder.label : null, '用编辑器打开所在文件夹');

    const reveal = menu.items.find((item) => item.kind === 'reveal');
    assert.equal(reveal && reveal.kind === 'reveal' ? reveal.label : null, '在 Finder 中显示');
  });

  it('still offers Reveal in Finder when no editor is installed', () => {
    const menu = buildOpenTargetMenu({ editors: [], defaultEditorId: null, isZh: false });

    assert.equal(menu.defaultEditorId, null);
    assert.deepEqual(
      menu.items.map((item) => item.kind === 'separator' ? '---' : `${item.kind}:${item.id}`),
      ['reveal:reveal'],
    );
    assert.equal(menu.items[0]?.kind === 'reveal' ? menu.items[0].label : null, 'Reveal in Finder');
  });

  it('does not offer open-parent when there is no usable editor', () => {
    const menu = buildOpenTargetMenu({ editors: [], defaultEditorId: 'ghost', isZh: true });
    assert.equal(menu.items.some((item) => item.kind === 'folder'), false);
  });
});
