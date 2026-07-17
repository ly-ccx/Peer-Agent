import { useId, useLayoutEffect, useRef } from 'react';

const SUPPORT_GAP = 11;
/** Deep ink for light theme wordmark. */
const INK_BLACK = '#1a1d21';
/** Cool light ink for dark theme wordmark. */
const INK_LIGHT = '#d7dde8';

type ThemeMode = 'light' | 'dark';

function readThemeMode(): ThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
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

  const shineGradientId = `brand-startup-shine-${id}`;
  const edgeBlurId = `brand-startup-edge-${id}`;
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
            <linearGradient id={shineGradientId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#9ecbe0" stopOpacity="0" />
              <stop offset=".22" stopColor="#9ecbe0" stopOpacity=".9" />
              <stop offset=".5" stopColor="#ffffff" stopOpacity="1" />
              <stop offset=".78" stopColor="#9ecbe0" stopOpacity=".9" />
              <stop offset="1" stopColor="#9ecbe0" stopOpacity="0" />
            </linearGradient>
            <filter id={edgeBlurId} x="-10%" y="-100%" width="120%" height="300%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
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
          <rect
            className="brand-startup-loader__liquid-edge"
            x="180"
            y="118"
            width="640"
            height="12"
            rx="6"
            fill={`url(#${shineGradientId})`}
            filter={`url(#${edgeBlurId})`}
          />
          <line ref={supportLineRef} className="brand-startup-loader__support" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
