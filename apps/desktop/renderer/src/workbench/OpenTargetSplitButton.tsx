import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PeerIcon } from '../ui/icons/PeerIcon';
import { resolveEditorIconDataUrl } from './editorBrandIcons';
import type { OpenTargetAction, OpenTargetMenuItem } from './openTargetMenu';

interface OpenTargetSplitButtonProps {
  readonly isZh: boolean;
  readonly defaultEditorName: string | null;
  readonly defaultEditorIconDataUrl?: string | null;
  readonly items: readonly OpenTargetMenuItem[];
  readonly disabled?: boolean;
  readonly onAction: (action: OpenTargetAction) => void;
}

function EditorAppIcon({
  editorId,
  iconDataUrl,
  label,
}: {
  readonly editorId?: string | null;
  readonly iconDataUrl: string | null | undefined;
  readonly label: string;
}) {
  const src = resolveEditorIconDataUrl(editorId, iconDataUrl);
  if (!src) return null;
  return <img className="workbench-open-app-icon" src={src} alt="" aria-hidden="true" title={label} />;
}

function itemLabel(item: Exclude<OpenTargetMenuItem, { kind: 'separator' }>): string {
  return item.label;
}

export function OpenTargetSplitButton({
  isZh,
  defaultEditorName,
  defaultEditorIconDataUrl = null,
  items,
  disabled = false,
  onAction,
}: OpenTargetSplitButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const defaultEditor = items.find((item) => item.kind === 'editor' && item.selected);
  const defaultEditorId = defaultEditor && defaultEditor.kind === 'editor' ? defaultEditor.id : null;
  const defaultIcon =
    defaultEditor && defaultEditor.kind === 'editor'
      ? defaultEditor.iconDataUrl
      : defaultEditorIconDataUrl;
  const canOpenFile = Boolean(defaultEditorId);
  const openLabel = isZh ? '打开' : 'Open';
  const menuLabel = isZh ? '选择打开方式' : 'Choose how to open';

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [close, open]);

  const run = (action: OpenTargetAction) => {
    close();
    onAction(action);
  };

  return (
    <div ref={rootRef} className={`workbench-open-split${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="workbench-open-split-main"
        disabled={disabled || !canOpenFile}
        title={
          defaultEditorName
            ? isZh
              ? `用 ${defaultEditorName} 打开`
              : `Open with ${defaultEditorName}`
            : isZh
              ? '未检测到可用编辑器'
              : 'No editor available'
        }
        onClick={() => {
          if (!defaultEditorId) return;
          run({ kind: 'open-file', editorId: defaultEditorId });
        }}
      >
        <EditorAppIcon
          editorId={defaultEditorId}
          iconDataUrl={defaultIcon}
          label={defaultEditorName || openLabel}
        />
        <span>{openLabel}</span>
      </button>
      <button
        type="button"
        className="workbench-open-split-caret"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={menuLabel}
        title={menuLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <PeerIcon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div id={menuId} className="workbench-open-split-menu" role="menu" aria-label={menuLabel}>
          {items.map((item, index) => {
            if (item.kind === 'separator') {
              return <div key={`sep-${index}`} className="workbench-open-split-sep" role="separator" />;
            }
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={`workbench-open-split-item${item.kind === 'editor' && item.selected ? ' is-selected' : ''}`}
                onClick={() => run(item.action)}
              >
                {item.kind === 'editor' ? (
                  <EditorAppIcon editorId={item.id} iconDataUrl={item.iconDataUrl} label={item.label} />
                ) : null}
                <span>{itemLabel(item)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
