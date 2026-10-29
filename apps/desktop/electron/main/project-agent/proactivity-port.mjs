/**
 * 桌面把当前机器人的主动性写口接到委托工具。
 * 工具调用时再读当前端口，所以不必先于 Local Tool Host 安装。
 */
let current = null;

export function installProjectProactivity(port) {
  current = port && typeof port.set === 'function' ? port : null;
  const installed = current;
  return () => { if (current === installed) current = null; };
}

export function liveProjectProactivity() {
  return {
    available: () => current != null,
    set: (input) => (current ? current.set(input) : Promise.resolve({ ok: false, error: 'proactivity_unavailable' })),
  };
}
