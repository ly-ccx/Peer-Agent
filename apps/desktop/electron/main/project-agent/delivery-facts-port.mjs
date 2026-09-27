/**
 * 桌面把全局档位、本机器人覆盖和安静时段接到回复送达。
 * 工具调用时再读当前端口，所以不必先于 Local Tool Host 安装。
 */
let current = null;

export function installDeliveryFacts(port) {
  current = port && typeof port.read === 'function' ? port : null;
}

export function liveDeliveryFacts() {
  return {
    read: (view) => (current ? current.read(view) : null),
  };
}
