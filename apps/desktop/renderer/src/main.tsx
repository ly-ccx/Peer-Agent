import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppearanceProvider } from './appearance/AppearanceProvider';
import { AppErrorBoundary } from './app/components/AppErrorBoundary';
import { ConfirmProvider } from './app/components/ConfirmProvider';
import { App } from './App';
import './styles.css';

// macOS 真毛玻璃标记：仅在渲染层 bootstrap 正常执行到这里时打上，
// 供 base.css 放开 html/body/#root 的实色兜底，让窗口 vibrancy 从侧栏/Chrome 透出。
// bootstrap 抛错则标记不存在 → 实色兜底防"整窗白屏/露黑"。非 macOS 不打标，保持实色回退。
if (/Macintosh|Mac OS X/.test(navigator.userAgent)) {
  document.documentElement.dataset.vibrancy = 'true';
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AppearanceProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </AppearanceProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
