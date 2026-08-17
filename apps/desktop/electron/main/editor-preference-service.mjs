/**
 * 「默认打开程序」的记忆与解析。
 *
 * 存储落在 settings.json 的 `preferredEditor` 命名空间（{ editorId }），走既有
 * settings-store 的浅合并写，不新开存储文件。
 *
 * 该模块存在的意义不是包一层 get/set，而是收口一个真实问题：**记住的编辑器可能已经
 * 被卸载**。resolve() 保证「返回的 editorId 一定是本机当前可用的」，否则回退到候选表
 * 首项；候选为空时返回 null，让上层退回系统默认程序。
 */

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export const PREFERRED_EDITOR_SETTINGS_KEY = 'preferredEditor';

/**
 * @param {object} deps
 * @param {() => Record<string, unknown>} deps.getSettings 读取整份设置。
 * @param {(partial: Record<string, unknown>) => unknown} deps.mergeSettings 浅合并写入。
 * @param {() => readonly { id: string, name: string }[]} deps.detectEditors 本机已安装编辑器。
 */
export function createEditorPreferenceService({ getSettings, mergeSettings, detectEditors } = {}) {
  const read = assertFunction(getSettings, 'getSettings');
  const merge = assertFunction(mergeSettings, 'mergeSettings');
  const detect = assertFunction(detectEditors, 'detectEditors');

  /** 持久化的原始值；可能指向已卸载的编辑器。 */
  function storedEditorId() {
    const settings = read();
    const namespace = isRecord(settings) ? settings[PREFERRED_EDITOR_SETTINGS_KEY] : null;
    if (!isRecord(namespace)) return null;
    const { editorId } = namespace;
    return typeof editorId === 'string' && editorId.length > 0 ? editorId : null;
  }

  return Object.freeze({
    /**
     * 当前可用的候选 + 实际生效的默认值。
     * @returns {{ editors: readonly object[], defaultEditorId: string | null, stored: string | null, stale: boolean }}
     */
    resolve() {
      const editors = detect();
      const stored = storedEditorId();
      const available = stored ? editors.some((editor) => editor.id === stored) : false;
      // 记住的编辑器不可用时不要把坏 id 交给上层，直接回退候选首项。
      const defaultEditorId = available ? stored : (editors[0]?.id ?? null);
      return Object.freeze({
        editors,
        defaultEditorId,
        stored,
        stale: Boolean(stored) && !available,
      });
    },

    /** 记住用户选择；只接受本机真实可用的 editorId。 */
    setDefault(editorId) {
      if (!editorId || typeof editorId !== 'string') {
        return { ok: false, reason: 'invalid_editor' };
      }
      if (!detect().some((editor) => editor.id === editorId)) {
        return { ok: false, reason: 'editor_not_found' };
      }
      merge({ [PREFERRED_EDITOR_SETTINGS_KEY]: { editorId } });
      return { ok: true, editorId };
    },

    /** 忘记选择，回到「候选首项」。 */
    clearDefault() {
      merge({ [PREFERRED_EDITOR_SETTINGS_KEY]: {} });
      return { ok: true };
    },
  });
}
