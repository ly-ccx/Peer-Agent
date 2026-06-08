import { useCallback, useState } from 'react';

/**
 * 退场动画 hook — React 组件删除前先跑 CSS 退场动画再真删。
 * 原理：exit(onDone) → exiting=true → CSS 退场动画 → duration 后 onDone() → 真删。
 * 纯 React + CSS，无第三方依赖。
 */
export function useExitAnimation(duration = 200) {
  const [exiting, setExiting] = useState(false);
  const exit = useCallback(
    (onDone: () => void) => {
      setExiting(true);
      setTimeout(() => {
        try {
          onDone();
        } finally {
          // 动画结束必须复位 exiting，否则脏状态会残留到组件下次复用：
          // PermissionGateStrip 是常驻组件（pending 为空时 return null，但实例不卸载、
          // hook state 保留）。exiting 不复位会让下一个待授权工具的授权条带着 .exiting
          // 渲染——一弹即隐（za-slide-down-out forwards）且 pointer-events:none 点不到，
          // 导致该工具永远无法确认、后端永久挂在 waiting_user_consent。
          setExiting(false);
        }
      }, duration);
    },
    [duration]
  );
  return { exiting, exit };
}
