/**
 * 文件预览头部「打开 ▾」菜单的纯数据模型。
 *
 * 探测 / 默认值 / 真正拉起都在主进程；这里只负责把「本机已装编辑器 + 记住的默认值」
 * 编成稳定的菜单项，方便单测，也避免把分支写进 DocumentView。
 */

export interface InstalledEditor {
  readonly id: string;
  readonly name: string;
  readonly bundleId?: string | null;
  readonly iconDataUrl?: string | null;
}

export type OpenTargetAction =
  | { readonly kind: 'open-file'; readonly editorId: string }
  | { readonly kind: 'open-parent'; readonly editorId: string }
  | { readonly kind: 'reveal' };

export type OpenTargetMenuItem =
  | {
      readonly kind: 'editor';
      readonly id: string;
      readonly label: string;
      readonly selected: boolean;
      readonly iconDataUrl: string | null;
      readonly action: Extract<OpenTargetAction, { kind: 'open-file' }>;
    }
  | { readonly kind: 'separator' }
  | {
      readonly kind: 'folder';
      readonly id: 'open-parent';
      readonly label: string;
      readonly action: Extract<OpenTargetAction, { kind: 'open-parent' }>;
    }
  | {
      readonly kind: 'reveal';
      readonly id: 'reveal';
      readonly label: string;
      readonly action: Extract<OpenTargetAction, { kind: 'reveal' }>;
    };

export interface OpenTargetMenuModel {
  readonly defaultEditorId: string | null;
  readonly defaultEditorName: string | null;
  readonly defaultEditorIconDataUrl: string | null;
  readonly items: readonly OpenTargetMenuItem[];
}

export function resolveDefaultEditorId(
  editors: readonly InstalledEditor[],
  defaultEditorId: string | null,
): string | null {
  if (defaultEditorId && editors.some((editor) => editor.id === defaultEditorId)) {
    return defaultEditorId;
  }
  return editors[0]?.id ?? null;
}

export function buildOpenTargetMenu({
  editors,
  defaultEditorId,
  isZh,
}: {
  readonly editors: readonly InstalledEditor[];
  readonly defaultEditorId: string | null;
  readonly isZh: boolean;
}): OpenTargetMenuModel {
  const resolvedId = resolveDefaultEditorId(editors, defaultEditorId);
  const resolved = editors.find((editor) => editor.id === resolvedId) ?? null;

  const items: OpenTargetMenuItem[] = editors.map((editor) => ({
    kind: 'editor',
    id: editor.id,
    label: editor.name,
    selected: editor.id === resolvedId,
    iconDataUrl: editor.iconDataUrl ?? null,
    action: { kind: 'open-file', editorId: editor.id },
  }));

  if (resolvedId) {
    if (items.length > 0) items.push({ kind: 'separator' });
    items.push({
      kind: 'folder',
      id: 'open-parent',
      label: isZh ? '用编辑器打开所在文件夹' : 'Open containing folder in editor',
      action: { kind: 'open-parent', editorId: resolvedId },
    });
  }

  if (items.length > 0) items.push({ kind: 'separator' });
  items.push({
    kind: 'reveal',
    id: 'reveal',
    label: isZh ? '在 Finder 中显示' : 'Reveal in Finder',
    action: { kind: 'reveal' },
  });

  return Object.freeze({
    defaultEditorId: resolvedId,
    defaultEditorName: resolved?.name ?? null,
    defaultEditorIconDataUrl: resolved?.iconDataUrl ?? null,
    items: Object.freeze(items),
  });
}
