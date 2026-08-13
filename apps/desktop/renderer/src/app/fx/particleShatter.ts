/**
 * 整卡从右向左粒子粉碎引擎（与 scratch demo 同构）。
 * 纯 DOM/Canvas 能力，不依赖 React。
 */

export const PARTICLE_SHATTER_SWEEP_MS = 360;
export const PARTICLE_SHATTER_MAX_MS = 1700;
export const PARTICLE_SHATTER_GRAVITY = 0.09;
/** 大图/超高抽屉采样硬上限，超出后自动加大间距。 */
export const PARTICLE_SHATTER_MAX_PARTICLES = 2400;

export type ShatterParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  r: number;
  g: number;
  b: number;
  a: number;
  delay: number;
  maxLife: number;
  rot: number;
  vr: number;
  drag: number;
};

export type SampleParticlesOptions = {
  readonly gapCss?: number;
  readonly sweepMs?: number;
  readonly alphaThreshold?: number;
  readonly originX?: number;
  readonly originY?: number;
  /** 粒子数量硬上限；超出后加大采样间距。 */
  readonly maxParticles?: number;
  /** 可注入的随机源，便于单测。 */
  readonly random?: () => number;
};

export type RunParticleShatterOptions = {
  readonly canvas: HTMLCanvasElement;
  readonly particles: readonly ShatterParticle[];
  readonly gravity?: number;
  readonly maxDurationMs?: number;
  readonly now?: () => number;
  readonly requestFrame?: (cb: FrameRequestCallback) => number;
  readonly cancelFrame?: (id: number) => void;
  readonly onDone?: () => void;
};

export type ParticleShatterHandle = {
  readonly stop: () => void;
};

function defaultRandom(): number {
  return Math.random();
}

/**
 * 从 ImageData 栅格采样粒子，delay 按 X 从右到左递增。
 */
export function sampleParticlesFromImageData(
  imageData: ImageData,
  cssWidth: number,
  cssHeight: number,
  options: SampleParticlesOptions = {},
): ShatterParticle[] {
  const {
    gapCss = 2.6,
    sweepMs = PARTICLE_SHATTER_SWEEP_MS,
    alphaThreshold = 14,
    originX = 0,
    originY = 0,
    maxParticles = PARTICLE_SHATTER_MAX_PARTICLES,
    random = defaultRandom,
  } = options;

  const { data, width: sw, height: sh } = imageData;
  const scaleX = cssWidth / Math.max(1, sw);
  const scaleY = cssHeight / Math.max(1, sh);
  const requestedGapPx = Math.max(2, Math.round(gapCss / Math.max(scaleX, 1e-6)));
  const estimatedCells = Math.ceil(sw / requestedGapPx) * Math.ceil(sh / requestedGapPx);
  const densityScale = estimatedCells > maxParticles
    ? Math.sqrt(estimatedCells / Math.max(1, maxParticles))
    : 1;
  const gapPx = Math.max(requestedGapPx, Math.ceil(requestedGapPx * densityScale));
  const particles: ShatterParticle[] = [];

  for (let py = 0; py < sh; py += gapPx) {
    for (let px = 0; px < sw; px += gapPx) {
      const i = (py * sw + px) * 4;
      const alpha = data[i + 3] ?? 0;
      if (alpha < alphaThreshold) continue;

      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const lx = px * scaleX;
      const ly = py * scaleY;
      const nx = lx / Math.max(1, cssWidth);
      const delay = (1 - nx) * sweepMs + random() * 50;
      const speed = 1.15 + random() * 2.1;
      const angle = -Math.PI / 2 + (random() - 0.5) * 1.7 + (nx - 0.5) * 0.4;

      particles.push({
        x: originX + lx,
        y: originY + ly,
        vx: Math.cos(angle) * speed * (0.4 + nx * 1.05) + (random() - 0.5) * 1.1,
        vy: Math.sin(angle) * speed * 0.9 - random() * 1.6,
        size: gapCss * (0.8 + random() * 0.55),
        r,
        g,
        b,
        a: alpha / 255,
        delay,
        maxLife: 780 + random() * 480,
        rot: random() * Math.PI,
        vr: (random() - 0.5) * 0.28,
        drag: 0.984 - random() * 0.02,
      });
    }
  }

  return particles;
}

/** 读取当前主题根属性（html data-*），供 foreignObject 截图复用。 */
export function readDocumentThemeAttrs(): {
  theme: string;
  themeMode: string;
  palette: string;
} {
  if (typeof document === 'undefined') {
    return { theme: 'light', themeMode: 'system', palette: 'frost' };
  }
  const root = document.documentElement;
  return {
    theme: root.getAttribute('data-theme') || root.dataset.theme || 'light',
    themeMode:
      root.getAttribute('data-theme-mode') || root.dataset.themeMode || 'system',
    palette: root.getAttribute('data-palette') || root.dataset.palette || 'frost',
  };
}

/** 从计算样式读取 CSS 变量颜色；失败时回退。 */
export function readThemeCssColor(
  varName: string,
  fallback: string,
  element?: Element | null,
): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback;
  }
  try {
    const target = element ?? document.documentElement;
    const value = getComputedStyle(target).getPropertyValue(varName).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/**
 * 当真实 DOM 截图失败时，用当前主题 token 画卡片色块兜底。
 * 不再写死深色，避免浅色模式下碎出黑噪点。
 */
export function createFallbackCardImageData(
  cssWidth: number,
  cssHeight: number,
  dpr = 1,
  colors?: {
    card?: string;
    border?: string;
    primaryBtn?: string;
    ghostBtn?: string;
    tag?: string;
    textSoft?: string;
  },
): { imageData: ImageData; pixelWidth: number; pixelHeight: number } {
  const pixelWidth = Math.max(1, Math.ceil(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.ceil(cssHeight * dpr));
  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return {
      imageData: new ImageData(pixelWidth, pixelHeight),
      pixelWidth,
      pixelHeight,
    };
  }

  // 优先读当前主题 token；浅色默认贴近 Frost paper，深色默认贴近 surface-0。
  const theme = readDocumentThemeAttrs().theme;
  const isDark = theme === 'dark';
  const card =
    colors?.card ??
    readThemeCssColor('--za-surface-0', isDark ? '#1E232C' : '#F7F9FC');
  const border =
    colors?.border ??
    readThemeCssColor(
      '--za-line',
      isDark ? 'rgba(255,255,255,0.08)' : 'rgba(26,29,33,0.10)',
    );
  const primaryBtn =
    colors?.primaryBtn ??
    readThemeCssColor('--za-text', isDark ? '#F2F4F7' : '#1A1D21');
  const ghostBtn =
    colors?.ghostBtn ??
    (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(26,29,33,0.06)');
  const tag = colors?.tag ?? 'rgba(62,122,107,0.35)';
  const textSoft =
    colors?.textSoft ??
    (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(26,29,33,0.10)');

  const w = cssWidth;
  const h = cssHeight;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = card;
  roundRectPath(ctx, 0.5, 0.5, w - 1, h - 1, 16);
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.stroke();

  // 右侧块模拟操作按钮，左侧偏软，强化“从右开始碎”的层次
  ctx.fillStyle = primaryBtn;
  roundRectPath(ctx, w - 96, h / 2 - 14, 78, 28, 999);
  ctx.fill();
  ctx.fillStyle = ghostBtn;
  roundRectPath(ctx, w - 176, h / 2 - 14, 68, 28, 999);
  ctx.fill();
  ctx.fillStyle = tag;
  roundRectPath(ctx, 16, 16, 42, 22, 999);
  ctx.fill();
  ctx.fillStyle = textSoft;
  roundRectPath(ctx, 100, 20, Math.max(40, w * 0.35), 14, 6);
  ctx.fill();
  roundRectPath(ctx, 100, 42, Math.max(30, w * 0.22), 12, 999);
  ctx.fill();

  return {
    imageData: ctx.getImageData(0, 0, pixelWidth, pixelHeight),
    pixelWidth,
    pixelHeight,
  };
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function collectDocumentCssText(): string {
  const parts: string[] = [];
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const rules = sheet.cssRules;
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          parts.push(rule.cssText);
        }
      } catch {
        // 跨域 stylesheet 会抛 SecurityError，忽略即可
      }
    }
  } catch {
    // ignore
  }
  return parts.join('\n');
}

/**
 * 克隆时裁掉不可见滚动内容，避免超高正文被整页编进 SVG。
 */
function clipCloneToVisibleViewport(source: HTMLElement, clone: HTMLElement): void {
  const sourceNodes = [source, ...Array.from(source.querySelectorAll<HTMLElement>('*'))];
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))];
  const count = Math.min(sourceNodes.length, cloneNodes.length);

  for (let i = 0; i < count; i += 1) {
    const live = sourceNodes[i];
    const cloned = cloneNodes[i];
    if (!live || !cloned) continue;

    const style = window.getComputedStyle(live);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const scrollsY = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden')
      && live.scrollHeight > live.clientHeight + 1;
    const scrollsX = (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden')
      && live.scrollWidth > live.clientWidth + 1;
    if (!scrollsY && !scrollsX) continue;

    cloned.style.overflow = 'hidden';
    if (scrollsY) {
      cloned.style.height = `${Math.max(1, live.clientHeight)}px`;
      cloned.style.maxHeight = `${Math.max(1, live.clientHeight)}px`;
    }
    if (scrollsX) {
      cloned.style.width = `${Math.max(1, live.clientWidth)}px`;
      cloned.style.maxWidth = `${Math.max(1, live.clientWidth)}px`;
    }

    if (cloned.scrollTo) {
      cloned.scrollTo(live.scrollLeft, live.scrollTop);
    } else {
      cloned.scrollLeft = live.scrollLeft;
      cloned.scrollTop = live.scrollTop;
    }
  }
}

/**
 * 尝试用 SVG foreignObject 截取元素像素；失败返回 null。
 */
export async function captureElementImageData(
  element: HTMLElement,
): Promise<{ imageData: ImageData; cssWidth: number; cssHeight: number } | null> {
  const rect = element.getBoundingClientRect();
  const cssWidth = Math.max(1, rect.width);
  const cssHeight = Math.max(1, rect.height);
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);

  try {
    const clone = element.cloneNode(true) as HTMLElement;
    clipCloneToVisibleViewport(element, clone);
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    clone.style.margin = '0';
    clone.style.width = `${cssWidth}px`;
    clone.style.height = `${cssHeight}px`;
    clone.style.maxWidth = `${cssWidth}px`;
    clone.style.boxSizing = 'border-box';
    clone.style.transform = 'none';
    clone.style.animation = 'none';
    // 父级可能已加上 is-shattering（visibility:hidden）；截图克隆强制可见。
    clone.style.visibility = 'visible';
    clone.style.opacity = '1';
    clone.classList.remove('is-shattering');

    const cssText = collectDocumentCssText();
    const serialized = new XMLSerializer().serializeToString(clone);
    // foreignObject 脱离真实 document，[data-theme]/[data-palette] 选择器需在包装层重放。
    const themeAttrs = readDocumentThemeAttrs();
    const themeAttrText = [
      themeAttrs.theme ? `data-theme="${themeAttrs.theme}"` : '',
      themeAttrs.themeMode ? `data-theme-mode="${themeAttrs.themeMode}"` : '',
      themeAttrs.palette ? `data-palette="${themeAttrs.palette}"` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${cssWidth}" height="${cssHeight}">
  <foreignObject x="0" y="0" width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" ${themeAttrText} style="width:${cssWidth}px;height:${cssHeight}px;margin:0;padding:0;">
      <style>${cssText.replace(/<\//g, '<\\/')}</style>
      ${serialized}
    </div>
  </foreignObject>
</svg>`;

    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const image = new Image();
    image.decoding = 'async';
    // 同域 data URL 不需要 crossOrigin，但显式设置更稳
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('particle shatter image load failed'));
      image.src = url;
    });

    const pixelWidth = Math.max(1, Math.ceil(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.ceil(cssHeight * dpr));
    const canvas = document.createElement('canvas');
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.drawImage(image, 0, 0, cssWidth, cssHeight);
    return {
      imageData: ctx.getImageData(0, 0, pixelWidth, pixelHeight),
      cssWidth,
      cssHeight,
    };
  } catch {
    return null;
  }
}

export async function sampleElementParticles(
  element: HTMLElement,
  options: SampleParticlesOptions = {},
): Promise<ShatterParticle[]> {
  const rect = element.getBoundingClientRect();
  const cssWidth = Math.max(1, rect.width);
  const cssHeight = Math.max(1, rect.height);
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);

  const captured = await captureElementImageData(element);
  if (captured) {
    return sampleParticlesFromImageData(captured.imageData, captured.cssWidth, captured.cssHeight, options);
  }

  const fallback = createFallbackCardImageData(cssWidth, cssHeight, dpr);
  return sampleParticlesFromImageData(fallback.imageData, cssWidth, cssHeight, options);
}

export function resizeShatterCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  padX: number,
  padY: number,
): { width: number; height: number; dpr: number } {
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  const width = Math.max(1, cssWidth + padX * 2);
  const height = Math.max(1, cssHeight + padY * 2);
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height, dpr };
}

/**
 * 播放粒子动画。返回 stop handle。
 */
export function runParticleShatter(options: RunParticleShatterOptions): ParticleShatterHandle {
  const {
    canvas,
    particles: initial,
    gravity = PARTICLE_SHATTER_GRAVITY,
    maxDurationMs = PARTICLE_SHATTER_MAX_MS,
    now = () => performance.now(),
    requestFrame = (cb) => requestAnimationFrame(cb),
    cancelFrame = (id) => cancelAnimationFrame(id),
    onDone,
  } = options;

  const ctx = canvas.getContext('2d');
  const particles = initial.map((p) => ({ ...p }));
  let frameId = 0;
  let stopped = false;
  const start = now();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelFrame(frameId);
    if (ctx) {
      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      ctx.clearRect(0, 0, width, height);
    }
  };

  if (!ctx || particles.length === 0) {
    onDone?.();
    return { stop };
  }

  const frame = (timestamp: number) => {
    if (stopped) return;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    ctx.clearRect(0, 0, width, height);

    let alive = 0;
    for (const p of particles) {
      const t = timestamp - start - p.delay;
      if (t < 0) {
        ctx.globalAlpha = p.a;
        ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
        ctx.fillRect(p.x, p.y, p.size, p.size);
        alive += 1;
        continue;
      }
      if (t > p.maxLife) continue;
      alive += 1;
      p.vy += gravity;
      p.vx *= p.drag;
      p.vy *= 0.995;
      p.x += p.vx;
      p.y += p.vy;

      const fade = 1 - t / p.maxLife;
      const s = p.size * (0.85 + fade * 0.25);
      ctx.globalAlpha = Math.max(0, p.a * fade);
      ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }

    if (alive > 0 && timestamp - start < maxDurationMs) {
      frameId = requestFrame(frame);
      return;
    }

    ctx.clearRect(0, 0, width, height);
    stopped = true;
    onDone?.();
  };

  frameId = requestFrame(frame);
  return { stop };
}
