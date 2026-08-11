/**
 * 整卡从右向左粒子粉碎引擎（与 scratch demo 同构）。
 * 纯 DOM/Canvas 能力，不依赖 React。
 */

export const PARTICLE_SHATTER_SWEEP_MS = 360;
export const PARTICLE_SHATTER_MAX_MS = 1700;
export const PARTICLE_SHATTER_GRAVITY = 0.09;

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
    random = defaultRandom,
  } = options;

  const { data, width: sw, height: sh } = imageData;
  const scaleX = cssWidth / Math.max(1, sw);
  const scaleY = cssHeight / Math.max(1, sh);
  const gapPx = Math.max(2, Math.round(gapCss / Math.max(scaleX, 1e-6)));
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

/**
 * 当真实 DOM 截图失败时，用卡片色块兜底，保证仍有从右向左粉碎反馈。
 */
export function createFallbackCardImageData(
  cssWidth: number,
  cssHeight: number,
  dpr = 1,
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

  const w = cssWidth;
  const h = cssHeight;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#181f29';
  roundRectPath(ctx, 0.5, 0.5, w - 1, h - 1, 16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.stroke();

  // 右侧亮块模拟操作按钮，左侧偏暗，强化“从右开始碎”的层次
  ctx.fillStyle = '#f2f4f7';
  roundRectPath(ctx, w - 96, h / 2 - 14, 78, 28, 999);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRectPath(ctx, w - 176, h / 2 - 14, 68, 28, 999);
  ctx.fill();
  ctx.fillStyle = 'rgba(62,122,107,0.35)';
  roundRectPath(ctx, 16, 16, 42, 22, 999);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
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
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${cssWidth}" height="${cssHeight}">
  <foreignObject x="0" y="0" width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:${cssWidth}px;height:${cssHeight}px;margin:0;padding:0;">
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
      p.rot += p.vr;

      const fade = 1 - t / p.maxLife;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, p.a * fade);
      ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
      const s = p.size * (0.85 + fade * 0.25);
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.restore();
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
