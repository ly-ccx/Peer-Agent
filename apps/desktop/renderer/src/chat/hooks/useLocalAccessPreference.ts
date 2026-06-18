import { useCallback, useState } from 'react';
import type { LocalAccessLevel } from '@peer-agent/protocol';

import { clientApi } from '../../clientApi';
import { isLocalAccessLevel } from '../state/preferences';

/**
 * useLocalAccessPreference —— 本地访问授权级别（local access level）全局偏好。
 *
 * 行为与原 ChatSurface 内联逻辑逐字一致：
 * - 初值从 clientApi.initialSettings.localAccessLevel 读取，非法值回落 'ask_before_local'。
 * - changeLocalAccessLevel 在本地 setState 后回写全局设置，并用服务端归一化后的回执值二次校正本地态。
 *
 * 注意：这是权限相关的「偏好」表达，真正的权限闸门仍在本地执行层（主进程 PermissionGate），
 * 此处只表达用户选择，不作为权限真值来源。
 */
export interface LocalAccessPreference {
  localAccessLevel: LocalAccessLevel;
  setLocalAccessLevel: React.Dispatch<React.SetStateAction<LocalAccessLevel>>;
  changeLocalAccessLevel: (level: LocalAccessLevel) => void;
}

export function useLocalAccessPreference(): LocalAccessPreference {
  const [localAccessLevel, setLocalAccessLevel] = useState<LocalAccessLevel>(() => {
    const stored = (clientApi.initialSettings as Record<string, unknown>)?.localAccessLevel;
    return isLocalAccessLevel(stored) ? stored : 'ask_before_local';
  });
  const changeLocalAccessLevel = useCallback((level: LocalAccessLevel) => {
    setLocalAccessLevel(level);
    void clientApi.updateSettings({ localAccessLevel: level }).then((nextSettings) => {
      const normalized = (nextSettings as Record<string, unknown>)?.localAccessLevel;
      if (isLocalAccessLevel(normalized)) setLocalAccessLevel(normalized);
    });
  }, []);
  return { localAccessLevel, setLocalAccessLevel, changeLocalAccessLevel };
}
