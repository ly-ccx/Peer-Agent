/** One observer and one environment subscription for all mounted avatars. */
export function createAvatarMotionRegistry<Node>(environment: {
  observe: (update: (node: Node, visible: boolean) => void) => { observe: (node: Node) => void; unobserve: (node: Node) => void; disconnect: () => void };
  allowed: () => boolean;
  subscribe: (update: () => void) => () => void;
}) {
  const entries = new Map<Node, { visible: boolean; last: boolean; update: (active: boolean) => void }>();
  let observer: ReturnType<typeof environment.observe> | null = null, stop: (() => void) | null = null;
  const refresh = () => {
    const allowed = environment.allowed();
    for (const entry of entries.values()) {
      const active = allowed && entry.visible;
      if (active !== entry.last) { entry.last = active; entry.update(active); }
    }
  };
  return {
    observe(node: Node, update: (active: boolean) => void) {
      entries.set(node, { visible: false, last: false, update }); update(false);
      if (!observer) {
        observer = environment.observe((node, visible) => { const entry = entries.get(node); if (entry) { entry.visible = visible; refresh(); } });
        stop = environment.subscribe(refresh);
      }
      observer.observe(node);
      return () => {
        observer?.unobserve(node); entries.delete(node);
        if (!entries.size) { observer?.disconnect(); observer = null; stop?.(); stop = null; }
      };
    },
  };
}
