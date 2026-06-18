import { useCallback, useState } from 'react';

import { clientApi } from '../../clientApi';
import { isEffortLevel, type EffortLevel } from '../state/preferences';

/**
 * useEffortPreference —— 思考强度（reasoning effort）全局偏好。
 *
 * 行为与原 ChatSurface 内联逻辑逐字一致：
 * - 初值从 clientApi.initialSettings.effort 读取（settings-store 扁平 key），非法值回落 'default'。
 * - changeEffort 在本地 setState 后回写全局设置（updateSettings），跨会话/重启保持一致。
 *
 * 表达层只读取/回写这一个偏好字段，不引入新的执行真值。
 * 暴露 setEffort 供「按任务恢复 effort」等场景直接覆盖本地态（不回写设置）。
 */
export interface EffortPreference {
  effort: EffortLevel;
  setEffort: React.Dispatch<React.SetStateAction<EffortLevel>>;
  changeEffort: (level: EffortLevel) => void;
}

export function useEffortPreference(): EffortPreference {
  const [effort, setEffort] = useState<EffortLevel>(() => {
    const stored = (clientApi.initialSettings as Record<string, unknown>)?.effort;
    return isEffortLevel(stored) ? stored : 'default';
  });
  const changeEffort = useCallback((level: EffortLevel) => {
    setEffort(level);
    void clientApi.updateSettings({ effort: level });
  }, []);
  return { effort, setEffort, changeEffort };
}
