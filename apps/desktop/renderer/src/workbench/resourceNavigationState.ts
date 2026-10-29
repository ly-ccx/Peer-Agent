export type ResourceNavigator = 'files' | 'changes';
export const RESOURCE_AUXILIARY_MIN_WIDTH = 720;
export function comparisonSourceLabel(path: string, isZh: boolean) {
  return path === '.' ? (isZh ? '当前项目' : 'Current project')
    : /^(?:Peer-Knowledge|peer-knowledge)$/.test(path) ? (isZh ? '知识库' : 'Knowledge') : path;
}
export function auxiliaryNavigator(requested: ResourceNavigator | null, tab: string, width: number) {
  return (tab === 'documents' || tab === 'browser') && Number.isFinite(width) && width >= RESOURCE_AUXILIARY_MIN_WIDTH ? requested : null;
}
