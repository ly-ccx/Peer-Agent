/**
 * 记忆页改完条目后，让已经打开的记忆索引按存储重建。
 */
let current = null;

export function installMemoryIndex(port) {
  current = port && typeof port.rebuild === 'function' ? port : null;
}

export function liveMemoryIndex() {
  return {
    rebuild() {
      try {
        current?.rebuild();
      } catch {
        // 索引可以下次打开时重建，不挡住记忆页。
      }
    },
  };
}
