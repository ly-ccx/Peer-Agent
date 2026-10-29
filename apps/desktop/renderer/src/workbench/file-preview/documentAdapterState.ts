import { detectFileKind, extension } from './fileTypes.ts';
export type DocumentAdapter = 'markdown' | 'json' | 'raster' | 'source';
export function documentAdapter(path: string): DocumentAdapter {
  const kind = detectFileKind(path);
  return kind === 'markdown' ? 'markdown' : kind === 'json' ? 'json' : kind === 'image' ? 'raster' : 'source';
}
export function documentAdapterNotice(path: string, isZh: boolean): string | null {
  const ext = extension(path);
  if (['html', 'htm', 'svg'].includes(ext)) return isZh ? '此文件按只读源码显示，不执行脚本或加载内嵌资源。'
    : 'Shown as read-only source. Scripts and embedded resources are not executed or loaded.';
  if (['pdf', 'docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls', 'odt', 'ods'].includes(ext)) return isZh ? '此格式尚无正文适配器；可读取的文本仅按源码显示。'
    : 'No document adapter is available for this format. Readable text is shown only as source.';
  return null;
}
export function adapterModeUnavailable(path: string, mode: 'preview' | 'source' | 'diff'): boolean {
  return mode === 'preview' && documentAdapter(path) === 'source' || mode === 'source' && documentAdapter(path) === 'raster';
}
