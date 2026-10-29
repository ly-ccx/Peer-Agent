/**
 * 桌面把全局「使用记忆」和本项目记忆开关接到上下文与记忆工具。
 * 工具调用和回合装配时再读，所以不必先于 Local Tool Host 安装。
 */
let current = null;

export function installMemoryGate(port) {
  current = port && typeof port.enabled === 'function' ? port : null;
  const installed = current;
  return () => { if (current === installed) current = null; };
}

export function liveMemoryGate() {
  return {
    enabled: (workspaceId) => (current ? current.enabled(workspaceId) !== false : true),
  };
}

export function memoryUseEnabled({ settings, profile } = {}) {
  if (settings?.memory?.enabled === false) return false;
  if (profile?.memoryEnabled === false) return false;
  return true;
}
