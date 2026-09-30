import { generateAvatar, type BotAvatar as BotAvatarModel } from '@peer-agent/protocol';
import { useEffect, useState, type PointerEvent } from 'react';
import { clientApi } from '../clientApi';
import type { BotAvatarMood } from './state/botAvatarState';

interface BotAvatarProps {
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly workspaceId: string;
  readonly mood?: BotAvatarMood;
}

const BODIES: Readonly<Record<string, string>> = {
  circle: 'M24 6C34 5 42 12 42 23c0 12-8 19-19 19C13 42 6 35 6 25 6 15 13 7 24 6Z',
  square: 'M13 7c7-3 16-2 23 1 5 2 7 8 7 16 0 10-3 16-10 19-7 3-17 2-23-2C6 38 5 32 5 23 5 15 7 10 13 7Z',
  triangle: 'M23 5c5 1 7 7 10 12 4 6 10 12 9 18-1 7-9 10-18 10-11 0-18-3-19-10-1-6 5-13 9-19 3-5 5-10 9-11Z',
  diamond: 'M23 4c5-1 9 5 12 10 4 5 9 8 9 13 0 5-5 9-10 12-5 4-9 7-14 5-5-1-7-6-11-11-4-4-6-8-4-13 2-5 7-7 10-10 3-3 5-5 8-6Z',
  hex: 'M18 5c5-2 10-1 14 2 5 2 9 6 10 12 2 5 1 11-3 16-3 5-9 8-15 8-6 1-12-2-16-7-4-5-5-11-3-17 2-6 7-11 13-14Z',
  pill: 'M18 5c8-2 17 0 21 7 4 6 3 15 0 22-3 7-8 11-16 11-8 0-15-4-17-11-2-6-1-16 2-22 2-4 5-6 10-7Z',
  star: 'M21 5c4-3 9-1 12 4 5-1 9 3 9 8 4 4 3 9-1 13 2 6-2 11-8 12-4 4-9 4-13 1-6 2-11-1-12-6-5-3-5-9-2-13-2-5 0-10 5-12 2-5 6-7 10-7Z',
  arch: 'M23 5c9 0 16 5 18 14 2 7 3 15-1 21-2 3-6 4-10 1-4-3-8-3-12 0-4 3-8 2-10-2-4-6-3-14-1-21C9 10 15 5 23 5Z',
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

const DETAILS = [
  'M12 10c-3-4-2-7 1-8 3 1 4 4 3 8',
  'M34 10c2-5 5-6 7-4 0 4-2 6-5 8',
  'M18 7c-1-5 1-7 4-7 2 2 2 4 1 7',
  'M27 7c0-5 3-7 6-6 2 4 0 6-3 8',
  'M9 18c-5-1-7-4-6-7 4-1 6 1 8 4',
  'M39 18c5-1 7-4 6-7-4-1-6 1-8 4',
  'M14 7c-3-4-2-7 1-8 3 1 4 4 3 8M32 7c2-4 5-5 7-3 0 3-2 5-5 7',
  'M21 6c-2-5 0-8 3-8 3 1 4 4 3 8',
] as const;

function legacyVariant(workspaceId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < workspaceId.length; index += 1) {
    hash ^= workspaceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 8) % 32;
}

function moveEyes(event: PointerEvent<HTMLSpanElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
  const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  event.currentTarget.style.setProperty('--bot-gaze-x', `${Math.max(-1, Math.min(1, x)).toFixed(2)}px`);
  event.currentTarget.style.setProperty('--bot-gaze-y', `${Math.max(-1, Math.min(1, y)).toFixed(2)}px`);
}

function resetEyes(event: PointerEvent<HTMLSpanElement>) {
  event.currentTarget.style.removeProperty('--bot-gaze-x');
  event.currentTarget.style.removeProperty('--bot-gaze-y');
}

export function BotAvatar({ avatar, label, workspaceId, mood = 'idle' }: BotAvatarProps) {
  const [imageData, setImageData] = useState<{ key: string; dataUrl: string } | null>(null);
  const imageKey = avatar.kind === 'image' ? `${workspaceId}:${avatar.ref}` : '';
  const dataUrl = imageData?.key === imageKey ? imageData.dataUrl : null;
  useEffect(() => {
    if (avatar.kind !== 'image') {
      setImageData(null);
      return undefined;
    }
    let cancelled = false;
    setImageData(null);
    void clientApi.projectAgentReadAvatar({ workspaceId }).then((result) => {
      if (!cancelled) setImageData(result.ok ? { key: imageKey, dataUrl: result.dataUrl } : null);
    }).catch(() => {
      if (!cancelled) setImageData(null);
    });
    return () => { cancelled = true; };
  }, [avatar, imageKey, workspaceId]);

  if (avatar.kind === 'image' && dataUrl) {
    return (
      <span
        className="bot-avatar bot-avatar-image"
        role="img"
        aria-label={label}
        data-avatar-kind="image"
        data-avatar-mood={mood}
        onPointerMove={moveEyes}
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
  const eyeY = 22 + Math.floor(variant / 8) % 3;
  const eyeSpread = 5 + variant % 3;
  return (
    <span
      className="bot-avatar bot-avatar-generated"
      style={{ ['--bot-avatar-accent' as string]: botAvatarDisplayColor(generated.color) }}
      role="img"
      aria-label={label}
      data-avatar-kind="generated"
      data-avatar-shape={visualShape}
      data-avatar-mood={mood}
      onPointerMove={moveEyes}
      onPointerLeave={resetEyes}
    >
      <svg viewBox="0 0 48 48" focusable="false" aria-hidden="true">
        <path className="bot-avatar-detail" d={DETAILS[variant % DETAILS.length]} />
        <path className="bot-avatar-body" d={BODIES[visualShape] || BODIES.circle} />
        <path className="bot-avatar-highlight" d="M12 17c2-5 5-7 10-8" />
        <g className="bot-avatar-face">
          <ellipse className="bot-avatar-eye" cx={24 - eyeSpread} cy={eyeY} rx="1.9" ry="2.6" />
          <ellipse className="bot-avatar-eye" cx={24 + eyeSpread} cy={eyeY} rx="1.9" ry="2.6" />
          {variant % 2 === 0
            ? <path className="bot-avatar-mouth" d={`M22 ${eyeY + 7}q2 2 4 0`} />
            : <circle className="bot-avatar-mouth-dot" cx="24" cy={eyeY + 6} r="0.9" />}
        </g>
        <circle className="bot-avatar-thought" cx="39" cy="6" r="2" />
      </svg>
    </span>
  );
}
