import type { ReactNode } from 'react';
import { getFileVisualKind, type FileVisualKind } from '../views/filesTreePresentation';

const ICON_PROPS = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function pathsForKind(kind: FileVisualKind): ReactNode {
  switch (kind) {
    case 'markdown':
      return <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M6.3 13v-3l1.45 1.8L9.2 10v3m1.55-3 1.5 3 1.5-3m-3 2h3" /></>;
    case 'code':
      return <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M8.4 10 6.8 11.6l1.6 1.6m3.2-3.2 1.6 1.6-1.6 1.6" /></>;
    case 'style':
      return <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M7 10.2c1.7-1 4.3-1 6 0m-5.3 2c1.25-.7 3.35-.7 4.6 0M9 14.2c.55-.3 1.45-.3 2 0" /></>;
    case 'config':
      return <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M7 10h6M7 13h6M9 9v2m3 1v2" /></>;
    case 'image':
      return <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M6.5 14l2.3-2.7 1.65 1.65 1.3-1.35 1.75 2.4M7.5 8.8h.01" /></>;
    case 'archive':
      return <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M8.5 5.1h2M8.5 7.2h2m-2 2.1h2m-2 2.1h2v3h-2z" /></>;
    case 'git':
      return <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4M8 9.2v4.9m0-3.6 3.5 2v-3M8 9.2h.01m0 4.9h.01m3.5-4.9h.01" /></>;
    default:
      return <><path d="M4 2.75h7l4 4v10.5H4z" /><path d="M11 2.75v4h4" /></>;
  }
}

export function FileKindIcon({ name }: { readonly name: string }) {
  const kind = getFileVisualKind(name, false);
  return (
    <svg {...ICON_PROPS} className="workbench-tree-icon workbench-tree-file-icon" data-kind={kind}>
      {pathsForKind(kind)}
    </svg>
  );
}
