/** Presentation ownership for modal panels and their portalled menus. No business state. */
export interface InteractionLayer {
  readonly roots: () => readonly HTMLElement[];
  readonly trigger: HTMLElement | null;
  readonly modal: boolean;
  readonly passive?: boolean;
  readonly parent?: () => InteractionLayer | null;
}

export function createInteractionLayers() {
  const entries: InteractionLayer[] = [];
  const direct = (layer: InteractionLayer, target: Node | null) => !!target && layer.roots().some(root => root.contains(target));
  function parent(layer: InteractionLayer): InteractionLayer | undefined {
    const explicit = layer.parent?.();
    if (explicit && explicit !== layer && entries.includes(explicit)) return explicit;
    return entries.filter(item => item !== layer && direct(item, layer.trigger)).sort((a, b) =>
      a.roots().some(root => b.roots().some(other => root.contains(other))) ? 1 : -1)[0];
  }
  function owns(owner: InteractionLayer, child: InteractionLayer) {
    const seen = new Set<InteractionLayer>();
    for (let current = parent(child); current && !seen.has(current); current = parent(current)) {
      if (current === owner) return true;
      seen.add(current);
    }
    return false;
  }
  function ordered() {
    return [...entries].sort((a, b) => owns(a, b) ? -1 : owns(b, a) ? 1 : entries.indexOf(a) - entries.indexOf(b));
  }
  return {
    add(layer: InteractionLayer) { entries.push(layer); return () => { const index = entries.indexOf(layer); if (index >= 0) entries.splice(index, 1); }; },
    top: () => ordered().at(-1),
    topInteractive: () => ordered().filter(item => !item.passive).at(-1),
    modal: () => ordered().filter(item => item.modal).at(-1),
    contains(layer: InteractionLayer, target: Node | null) { return direct(layer, target) || entries.some(child => owns(layer, child) && direct(child, target)); },
    roots(layer: InteractionLayer) { return entries.filter(item => item === layer || owns(layer, item)).flatMap(item => item.roots()); },
    layerFor(root: HTMLElement | null) { return entries.find(item => item.roots().includes(root!)); },
  };
}

export const interactionLayers = createInteractionLayers();
const inertBefore = new Map<HTMLElement, boolean>();
let observer: MutationObserver | null = null;

/** Native inert also hides background controls from accessibility navigation. */
export function synchronizeModalBoundary() {
  const modal = interactionLayers.modal();
  const allowed = modal ? interactionLayers.roots(modal) : [];
  const blocked = new Set<HTMLElement>();
  if (modal) for (const child of document.body.children) {
    if (!(child instanceof HTMLElement) || ['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName)) continue;
    if (!allowed.some(root => child.contains(root))) blocked.add(child);
  }
  for (const [node, hadInert] of inertBefore) if (!blocked.has(node)) {
    node.toggleAttribute('inert', hadInert); inertBefore.delete(node);
  }
  for (const node of blocked) {
    if (!inertBefore.has(node)) inertBefore.set(node, node.hasAttribute('inert'));
    node.setAttribute('inert', '');
  }
  if (modal && !observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(synchronizeModalBoundary);
    observer.observe(document.body, { childList: true });
  } else if (!modal) { observer?.disconnect(); observer = null; }
}

/** An outside pointer may dismiss one layer even if React unmounts it synchronously. */
const pointerOwners = new WeakMap<Event, InteractionLayer | undefined>();
export function ownsLayerPointer(layer: InteractionLayer, event: Event) {
  if (!pointerOwners.has(event)) pointerOwners.set(event, interactionLayers.topInteractive());
  return pointerOwners.get(event) === layer;
}
