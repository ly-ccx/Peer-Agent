import { detectFileKind, extension } from './fileTypes.ts';
const PACKAGED_DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls', 'odt', 'ods']);
export type DocumentAdapter = 'markdown' | 'json' | 'raster' | 'source';
export function documentAdapter(path: string): DocumentAdapter {
  const kind = detectFileKind(path);
  return kind === 'markdown' ? 'markdown' : kind === 'json' ? 'json' : kind === 'image' ? 'raster' : 'source';
}
export function isPackagedDocument(path: string): boolean {
  return PACKAGED_DOCUMENT_EXTENSIONS.has(extension(path));
}
export function documentAdapterNotice(path: string, isZh: boolean): string | null {
  const ext = extension(path);
  if (['html', 'htm', 'svg'].includes(ext)) return isZh ? '此文件按只读源码显示，不执行脚本或加载内嵌资源。'
    : 'Shown as read-only source. Scripts and embedded resources are not executed or loaded.';
  if (isPackagedDocument(path)) return isZh ? '此格式不能在这里预览正文。'
    : 'This format cannot be previewed here.';
  return null;
}
export function adapterModeUnavailable(path: string, mode: 'preview' | 'source' | 'diff'): boolean {
  return mode === 'preview' && documentAdapter(path) === 'source' || mode === 'source' && documentAdapter(path) === 'raster';
}
