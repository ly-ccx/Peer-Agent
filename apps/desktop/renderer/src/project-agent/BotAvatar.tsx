import { motionAllowed } from '../app/state/motionEnvironment';
import { generateAvatar, type BotAvatar as BotAvatarModel } from '@peer-agent/protocol';
import { useEffect, useId, useState, type PointerEvent } from 'react';
import { clientApi } from '../clientApi';
import { useAvatarMotion } from './state/useAvatarMotion';
import { botAvatarMotion, type BotAvatarMood } from './state/botAvatarState';

interface BotAvatarProps {
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly workspaceId: string;
  readonly mood?: BotAvatarMood;
  readonly animate?: boolean;
}

/**
 * Eight precision-symmetric geometric chassis silhouettes on a 48×48 grid.
 * Preserves all protocol `BOT_AVATAR_SHAPES` names while replacing lumpy blobs
 * with clean anodized-glass hardware companion pods.
 */
const BODIES: Readonly<Record<string, string>> = {
  circle: 'M24 7.5A17.5 17.5 0 1 1 24 42.5A17.5 17.5 0 1 1 24 7.5Z',
  square: 'M16 8H32A10 10 0 0 1 42 18V32A10 10 0 0 1 32 42H16A10 10 0 0 1 6 32V18A10 10 0 0 1 16 8Z',
  pill: 'M17 11H31A13 13 0 0 1 44 24V26A13 13 0 0 1 31 39H17A13 13 0 0 1 4 26V24A13 13 0 0 1 17 11Z',
  arch: 'M24 7.5C34 7.5 41.5 14.5 41.5 24.5V34C41.5 38.7 37.7 42.5 33 42.5H15C10.3 42.5 6.5 38.7 6.5 34V24.5C6.5 14.5 14 7.5 24 7.5Z',
  hex: 'M20.5 8.5H27.5C30 8.5 32.3 9.7 33.7 11.7L40.3 21.1C41.7 23.1 41.7 26.9 40.3 28.9L33.7 38.3C32.3 40.3 30 41.5 27.5 41.5H20.5C18 41.5 15.7 40.3 14.3 38.3L7.7 28.9C6.3 26.9 6.3 23.1 7.7 21.1L14.3 11.7C15.7 9.7 18 8.5 20.5 8.5Z',
  diamond: 'M24 7.5C27.2 7.5 30 9.1 32.2 11.3L39.2 18.3C42.2 21.3 42.2 28.7 39.2 31.7L32.2 38.7C30 40.9 27.2 42.5 24 42.5C20.8 42.5 18 40.9 15.8 38.7L8.8 31.7C5.8 28.7 5.8 21.3 8.8 18.3L15.8 11.3C18 9.1 20.8 7.5 24 7.5Z',
  triangle: 'M24 7.5C31.5 7.5 37.8 14 40.5 23C42.6 30.2 41.2 36.4 37 39.8C33.8 42.2 29.2 42.5 24 42.5C18.8 42.5 14.2 42.2 11 39.8C6.8 36.4 5.4 30.2 7.5 23C10.2 14 16.5 7.5 24 7.5Z',
  star: 'M24 7.5C29.5 7.5 33.5 9.2 36.2 12C39 14.8 41.5 19.2 41.5 25C41.5 30.8 39 35.2 36.2 38C33.5 40.8 29.5 42.5 24 42.5C18.5 42.5 14.5 40.8 11.8 38C9 35.2 6.5 30.8 6.5 25C6.5 19.2 9 14.8 11.8 12C14.5 9.2 18.5 7.5 24 7.5Z',
};
const SHAPES = Object.keys(BODIES);

const LEGACY_COLORS: Readonly<Record<string, string>> = {
  '#2563eb': '#6474e5',
  '#dc2626': '#f36d63',
  '#d97706': '#f4ad45',
  '#059669': '#61b68c',
  '#7c3aed': '#a884e5',
  '#db2777': '#a884e5',
  '#0891b2': '#55bac7',
  '#4b5563': '#a8a59f',
};

export function botAvatarDisplayColor(color: string): string {
  return LEGACY_COLORS[color.toLowerCase()] || color;
}

function legacyVariant(workspaceId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < workspaceId.length; index += 1) {
    hash ^= workspaceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 8) % 32;
}

function moveEyes(event: PointerEvent<HTMLSpanElement>) {
  if (!motionAllowed()) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
  const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  event.currentTarget.style.setProperty('--bot-gaze-x', `${Math.max(-1.4, Math.min(1.4, x * 1.4)).toFixed(2)}px`);
  event.currentTarget.style.setProperty('--bot-gaze-y', `${Math.max(-1, Math.min(1, y)).toFixed(2)}px`);
}

function resetEyes(event: PointerEvent<HTMLSpanElement>) {
  event.currentTarget.style.removeProperty('--bot-gaze-x');
  event.currentTarget.style.removeProperty('--bot-gaze-y');
}

function HardwareAccent({ kind }: { readonly kind: number }) {
  if (kind === 0) {
    // Minimal single antenna pin + luminous orb
    return (
      <g className="bot-avatar-hardware" aria-hidden="true">
        <path className="bot-avatar-stem" d="M24 8.5V4.8" />
        <circle className="bot-avatar-orb" cx="24" cy="3.8" r="2.1" />
      </g>
    );
  }
  if (kind === 1) {
    // Flush symmetric side ear-pods
    return (
      <g className="bot-avatar-hardware" aria-hidden="true">
        <rect className="bot-avatar-pod" x="3.2" y="19.5" width="3.4" height="10" rx="1.7" />
        <rect className="bot-avatar-pod" x="41.4" y="19.5" width="3.4" height="10" rx="1.7" />
      </g>
    );
  }
  if (kind === 2) {
    // Delicate twin micro-sensors
    return (
      <g className="bot-avatar-hardware" aria-hidden="true">
        <path className="bot-avatar-stem" d="M18.2 9.4L16.8 5.6M29.8 9.4L31.2 5.6" />
        <circle className="bot-avatar-orb" cx="16.5" cy="4.9" r="1.5" />
        <circle className="bot-avatar-orb" cx="31.5" cy="4.9" r="1.5" />
      </g>
    );
  }
  // Pure minimalist monolith chassis
  return null;
}

export function BotAvatar({ avatar, label, workspaceId, mood = 'idle', animate = false }: BotAvatarProps) {
  const motion = useAvatarMotion(botAvatarMotion(mood, animate));
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const bodyGradId = `bot-body-${rawId}`;
  const visorGradId = `bot-visor-${rawId}`;
  const sleeping = animate && mood === 'idle';
  const [imageData, setImageData] = useState<{ key: string; dataUrl: string } | null>(null);
  const imageKey = avatar.kind === 'image' ? `${workspaceId}:${avatar.ref}` : '';
  const dataUrl = imageData?.key === imageKey ? imageData.dataUrl : null;
  useEffect(() => {
    if (!imageKey) return undefined;
    let cancelled = false;
    // 档案对象每次保存都会换新引用。键没变就不要先清空，否则照片会闪成生成头像再载回来。
    void clientApi.projectAgentReadAvatar({ workspaceId }).then((result) => {
      if (!cancelled && result.ok) setImageData({ key: imageKey, dataUrl: result.dataUrl });
    }).catch(() => {
      if (!cancelled) setImageData(null);
    });
    return () => { cancelled = true; };
  }, [imageKey, workspaceId]);

  if (avatar.kind === 'image' && dataUrl) {
    return (
      <span
        className="bot-avatar bot-avatar-image"
        role="img"
        aria-label={label}
        data-avatar-kind="image"
        data-avatar-mood={mood}
        data-avatar-sleeping={sleeping}
        ref={motion.ref}
        data-avatar-animated={motion.active}
        onPointerMove={sleeping ? undefined : moveEyes}
        onPointerLeave={resetEyes}
      >
        <img src={dataUrl} alt="" />
      </span>
    );
  }
  const generated = avatar.kind === 'generated' ? avatar : generateAvatar(workspaceId);
  const variant = Number.isInteger(generated.variant) ? Math.abs(generated.variant!) % 32 : legacyVariant(workspaceId);
  const shapeIndex = SHAPES.indexOf(generated.shape);
  const visualShape = generated.variant === undefined
    ? SHAPES[(Math.max(0, shapeIndex) + variant) % SHAPES.length]
    : generated.shape;
  const accentKind = variant % 4;
  const eyeStyle = Math.floor(variant / 4) % 3;
  const bodyPath = BODIES[visualShape] || BODIES.square;
  return (
    <span
      className="bot-avatar bot-avatar-generated"
      style={{ ['--bot-avatar-accent' as string]: botAvatarDisplayColor(generated.color) }}
      role="img"
      aria-label={label}
      data-avatar-kind="generated"
      data-avatar-shape={visualShape}
      data-avatar-mood={mood}
      data-avatar-sleeping={sleeping}
      ref={motion.ref}
      data-avatar-animated={motion.active}
      onPointerMove={sleeping ? undefined : moveEyes}
      onPointerLeave={resetEyes}
    >
      <svg viewBox="0 0 48 48" focusable="false" aria-hidden="true">
        <defs>
          <linearGradient id={bodyGradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="bot-avatar-stop-top" />
            <stop offset="52%" className="bot-avatar-stop-mid" />
            <stop offset="100%" className="bot-avatar-stop-bottom" />
          </linearGradient>
          <linearGradient id={visorGradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#121722" />
            <stop offset="100%" stopColor="#222b3c" />
          </linearGradient>
        </defs>
        <HardwareAccent kind={accentKind} />
        <path className="bot-avatar-body" d={bodyPath} fill={`url(#${bodyGradId})`} />
        <path className="bot-avatar-highlight" d="M14.5 12.2C17.4 10.6 20.6 9.8 24 9.8C27.4 9.8 30.6 10.6 33.5 12.2" />
        <rect className="bot-avatar-visor" x="11.5" y="17.2" width="25" height="15.2" rx="7.6" fill={`url(#${visorGradId})`} />
        <path className="bot-avatar-visor-glint" d="M16.5 19.6H31.5" />
        <g className="bot-avatar-face">
          {sleeping ? (
            <path className="bot-avatar-sleep-eye" d="M16.4 25.1q2.4 2.2 4.8 0M26.8 25.1q2.4 2.2 4.8 0" />
          ) : eyeStyle === 1 ? (
            <path className="bot-avatar-eye-arc" d="M16.4 25.6q2.4-3.1 4.8 0M26.8 25.6q2.4-3.1 4.8 0" />
          ) : eyeStyle === 2 ? (
            <>
              <circle className="bot-avatar-eye" cx="19" cy="24.8" r="2.35" />
              <circle className="bot-avatar-eye" cx="29" cy="24.8" r="2.35" />
            </>
          ) : (
            <>
              <rect className="bot-avatar-eye" x="17.3" y="21.7" width="3.3" height="6.2" rx="1.65" />
              <rect className="bot-avatar-eye" x="27.4" y="21.7" width="3.3" height="6.2" rx="1.65" />
            </>
          )}
        </g>
        <circle className="bot-avatar-thought" cx="39.5" cy="7.5" r="2.3" />
      </svg>
    </span>
  );
}
