import { useId, useLayoutEffect, useRef } from 'react';

const SUPPORT_GAP = 11;
/** Deep ink for light theme wordmark. */
const INK_BLACK = '#1a1d21';
/** Cool light ink for dark theme wordmark. */
const INK_LIGHT = '#d7dde8';
/** Sidebar brand marks — prewarm during startup so left-top logo is ready after transition. */
const SIDEBAR_LOGO_SRCS = ['./logo-light.png', './logo-dark.png'] as const;

type ThemeMode = 'light' | 'dark';

function readThemeMode(): ThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function preloadSidebarLogos(): void {
  if (typeof Image === 'undefined') return;
  for (const src of SIDEBAR_LOGO_SRCS) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
  }
}

/**
 * Pure branded wordmark startup loader.
 * No canvas fluid / ink-wash sim — only theme-aware wordmark + support line.
 */
export function BrandStartupLoader() {
  const id = useId().replace(/:/g, '');
  const textRef = useRef<SVGTextElement | null>(null);
  const inkTextRef = useRef<SVGTextElement | null>(null);
  const supportLineRef = useRef<SVGLineElement | null>(null);

  // Second warm-up while the transition page is visible (HTML preload is the first).
  useLayoutEffect(() => {
    preloadSidebarLogos();
  }, []);

  useLayoutEffect(() => {
    const text = textRef.current;
    const support = supportLineRef.current;
    if (!text || !support) return;

    const positionSupportLine = () => {
      const box = text.getBBox();
      const y = box.y + box.height + SUPPORT_GAP;
      support.setAttribute('x1', String(box.x + box.width * 0.18));
      support.setAttribute('x2', String(box.x + box.width * 0.82));
      support.setAttribute('y1', String(y));
      support.setAttribute('y2', String(y));
    };

    positionSupportLine();
    window.addEventListener('resize', positionSupportLine);
    return () => window.removeEventListener('resize', positionSupportLine);
  }, []);

  // Keep wordmark fill in sync with data-theme (deep ink / cool light ink).
  useLayoutEffect(() => {
    const inkText = inkTextRef.current;
    if (!inkText) return;

    const syncWordmark = () => {
      inkText.setAttribute('fill', readThemeMode() === 'dark' ? INK_LIGHT : INK_BLACK);
    };

    syncWordmark();
    const observer = new MutationObserver(syncWordmark);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  const fillMaskId = `brand-startup-loader__fill-mask-${id}`;
  const initialFill = readThemeMode() === 'dark' ? INK_LIGHT : INK_BLACK;

  return (
    <div className="brand-startup-loader" role="status" aria-label="Peer Agent is starting">
      <div className="brand-startup-loader__brand" role="img" aria-label="Peer Agent">
        <svg
          className="brand-startup-loader__lockup"
          viewBox="0 0 1000 220"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          <defs>
            <mask id={fillMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="220">
              <rect
                className="brand-startup-loader__fill-mask"
                x="0"
                y="0"
                width="1000"
                height="220"
                fill="#fff"
              />
            </mask>
          </defs>

          <text
            ref={textRef}
            className="brand-startup-loader__wordmark brand-startup-loader__wordmark--ghost"
            x="500"
            y="150"
          >
            Peer Agent
          </text>
          <text
            ref={inkTextRef}
            className="brand-startup-loader__wordmark brand-startup-loader__wordmark--ink"
            x="500"
            y="150"
            fill={initialFill}
            mask={`url(#${fillMaskId})`}
          >
            Peer Agent
          </text>
          <line ref={supportLineRef} className="brand-startup-loader__support" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
