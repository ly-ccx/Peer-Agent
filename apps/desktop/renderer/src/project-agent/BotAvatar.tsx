import { motionAllowed } from '../app/state/motionEnvironment';
import { BOT_AVATAR_SHAPES, generateAvatar, type BotAvatar as BotAvatarModel } from '@peer-agent/protocol';
import { useEffect, useId, useState, type PointerEvent, type ReactNode } from 'react';
import { clientApi } from '../clientApi';
import { ExecutorIcon, type ExecutorKind } from './ExecutorIcon';
import { useAvatarMotion } from './state/useAvatarMotion';
import { botAvatarMotion, type BotAvatarMood } from './state/botAvatarState';

export interface BotAvatarProps {
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly workspaceId: string;
  readonly mood?: BotAvatarMood;
  readonly animate?: boolean;
  readonly executorKind?: ExecutorKind;
  readonly showExecutorBadge?: boolean;
}

const CAT_HEAD_PATH =
  'M15.4 30.2 C14.6 24.4 16.0 17.6 18.8 17.2 C21.8 16.8 25.0 20.6 26.8 22.6 C29.8 22.0 34.4 22.0 37.4 22.6 C39.4 20.6 42.4 16.8 45.4 17.2 C48.2 17.6 49.4 24.4 48.6 30.2 C49.8 32.8 50.2 35.4 49.8 38.2 C48.8 45.2 41.8 49.6 32.0 49.6 C22.2 49.6 15.2 45.2 14.2 38.2 C13.8 35.4 14.2 32.8 15.4 30.2 Z';
const SOFT_COLLAR_PATH =
  'M21.0 46.8 C23.0 52.8 27.2 55.2 32.0 55.2 C36.8 55.2 41.0 52.8 43.0 46.8 C39.5 48.8 35.8 49.6 32.0 49.6 C28.2 49.6 24.5 48.8 21.0 46.8 Z';
const LEFT_INNER_EAR = 'M18.8 20.2 C18.0 22.4 18.5 24.6 20.2 25.4 C21.8 24.6 22.4 22.5 21.0 20.4 Z';
const RIGHT_INNER_EAR = 'M45.2 20.2 C46.0 22.4 45.5 24.6 43.8 25.4 C42.2 24.6 41.6 22.5 43.0 20.4 Z';

const SHAPE_TO_CAT_ID = {
  circle: 'midnight',
  square: 'calico',
  pill: 'ginger-beret',
  arch: 'siamese',
  hex: 'blue-glasses',
  diamond: 'tuxedo',
  triangle: 'pearl-cat',
  star: 'tabby-scarf',
} as const satisfies Record<(typeof BOT_AVATAR_SHAPES)[number], string>;

interface CatPortrait {
  readonly collar: string;
  readonly coat: string;
  readonly innerEars?: string;
  readonly eyes: string;
  readonly eyeOffset: readonly [number, number];
  readonly nose?: string;
  readonly behind?: ReactNode;
  readonly collarDetail?: ReactNode;
  readonly markings?: ReactNode;
  readonly accessories?: ReactNode;
}

// Layer geometry follows ADR 135 §2.2.1. The profile color is reserved for chat accents.
const CATS: Readonly<Record<(typeof SHAPE_TO_CAT_ID)[keyof typeof SHAPE_TO_CAT_ID], CatPortrait>> = {
  midnight: {
    collar: '#C4553F', coat: '#353640', innerEars: '#505261',
    eyes: '#FAF2E1', eyeOffset: [-0.5, 0.2],
    collarDetail: <path d="M27.2 48.5 C28.8 52.8 30.8 54.6 32.0 54.6 C33.2 54.6 35.2 52.8 36.8 48.5 Z" fill="#F5EDE0" />,
    markings: <ellipse cx="30.2" cy="46.4" rx="9.2" ry="5.0" fill="#F4ECE0" />,
    accessories: <>
      <path d="M23.5 47.6 Q32.0 51.4 40.5 47.6" fill="none" stroke="#E5AA3B" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M31.0 50.8 A2.2 2.2 0 1 1 29.4 54.3 A1.75 1.75 0 1 0 31.0 50.8 Z" fill="#F3C85F" />
    </>,
  },
  calico: {
    collar: '#C45A43', coat: '#FBF4E7',
    eyes: '#28201B', eyeOffset: [-0.4, 0.4], nose: '#CE9482',
    collarDetail: <path d="M27.4 48.8 C29.0 52.8 30.8 54.4 32.0 54.4 C33.2 54.4 35.0 52.8 36.6 48.8 Z" fill="#F7EFE2" />,
    markings: <>
      <path d="M10 14 L30.8 14 C32.0 22.0 28.6 29.8 21.4 31.8 C16.8 33.0 13.0 31.2 10 28 Z" fill="#DF8947" />
      <path d="M36.5 14 L54 14 L53 34.5 C47.5 34.0 42.0 31.2 39.2 26.2 C37.2 22.5 36.6 18.2 36.5 14 Z" fill="#3B3633" />
      <ellipse cx="45.2" cy="41.2" rx="6.0" ry="4.6" fill="#E39759" opacity="0.88" />
    </>,
  },
  'ginger-beret': {
    collar: '#475B6C', coat: '#E6A15A', innerEars: '#F5CA98',
    eyes: '#28201B', eyeOffset: [-0.4, 0.7], nose: '#C9826C',
    collarDetail: <path d="M26 48.6 Q32 52.4 38 48.6 L36.4 53.0 Q32 54.8 27.6 53.0 Z" fill="#FBF3E4" />,
    markings: <ellipse cx="30.5" cy="44.2" rx="13.8" ry="7.4" fill="#FBF2E3" />,
    accessories: <>
      <path d="M21.0 23.6 C22.2 15.2 34.8 13.0 42.8 18.4 C44.8 19.8 44.2 23.0 40.8 23.8 C35.2 25.0 26.5 25.0 21.0 23.6 Z" fill="#5D7D67" />
      <path d="M33.2 15.5 C33.5 13.4 35.0 12.6 36.2 13.2" fill="none" stroke="#486351" strokeWidth="1.7" strokeLinecap="round" />
    </>,
  },
  siamese: {
    collar: '#4D6C8E', coat: '#F2E6D5',
    eyes: '#28201B', eyeOffset: [-0.4, 0.4], nose: '#5D4437',
    collarDetail: <path d="M23.5 47.6 Q32 52.0 40.5 47.6 L39.2 52.4 Q32 55.2 24.8 52.4 Z" fill="#6285A8" />,
    markings: <>
      <path d="M12 14 L27 14 L25 27.5 C20.5 28.0 16.0 26.8 12 24 Z" fill="#6F5344" />
      <path d="M37 14 L52 14 L52 24.5 C48.0 27.0 43.5 28.0 39 27.5 Z" fill="#6F5344" />
      <ellipse cx="29.4" cy="36.8" rx="10.0" ry="7.0" fill="#B5927B" opacity="0.48" />
    </>,
  },
  'blue-glasses': {
    collar: '#D5C4AD', coat: '#8F9EAB', innerEars: '#B5C1CB',
    eyes: '#23272B', eyeOffset: [-0.4, 0.4], nose: '#6E7B87',
    collarDetail: <path d="M27.6 48.5 L32 53.5 L36.4 48.5 Z" fill="#F6F0E6" />,
    markings: <ellipse cx="30.5" cy="46.2" rx="10.2" ry="4.8" fill="#E7ECF1" />,
    accessories: <g stroke="#C59C54" strokeWidth="1.2" strokeOpacity="0.85" fill="#FFFFFF" fillOpacity="0.1">
      <ellipse cx="24.7" cy="35.8" rx="5.1" ry="4.2" />
      <ellipse cx="34.0" cy="35.8" rx="5.1" ry="4.2" />
      <path d="M29.8 35.6 H28.9" />
    </g>,
  },
  tuxedo: {
    collar: '#343235', coat: '#FAF6EE',
    eyes: '#261F1B', eyeOffset: [-0.4, 0.5], nose: '#C69083',
    collarDetail: <path d="M27.4 48.4 L31.5 54.0 L35.6 48.4 Z" fill="#FAF6EE" />,
    markings: <>
      <path d="M12 14 L52 14 L52 31 C44.5 30.0 38.0 26.8 31.8 27.8 C25.5 28.8 20.5 26.2 13 25.5 Z" fill="#343235" />
      <path d="M34.5 24 C38.0 28.5 43.2 32.8 49.5 33.8 L52 20 Z" fill="#343235" />
    </>,
    accessories: <>
      <path d="M27.8 49.0 L31.5 50.8 L27.8 52.6 Z M35.2 49.0 L31.5 50.8 L35.2 52.6 Z" fill="#BA4839" />
      <circle cx="31.5" cy="50.8" r="1.25" fill="#9E392C" />
    </>,
  },
  'pearl-cat': {
    collar: '#62798F', coat: '#FAF4E8', innerEars: '#F0D3CA',
    eyes: '#28201B', eyeOffset: [-0.6, 0.7], nose: '#D6A297',
    behind: <path d="M40.5 24.5 C49.5 27.5 53.2 37.5 49.8 48.8 C46.2 49.8 42.5 47.6 41.2 43.5 Z" fill="#E5A52E" />,
    markings: <path d="M13 28.5 C20.5 20.5 34.5 19.5 47.5 27.5 C49.5 29.0 50.5 33.0 49.5 36.5 C43.0 28.0 28.5 24.8 13.5 31.8 Z" fill="#2A62B2" />,
    accessories: <circle cx="43.0" cy="42.8" r="2.1" fill="#FFFFFF" />,
  },
  'tabby-scarf': {
    collar: '#5A4D45', coat: '#CEBCA3',
    eyes: '#28201B', eyeOffset: [-0.4, 0.4], nose: '#8D6957',
    markings: <>
      <path d="M13 14 L51 14 L51 27.5 C43 26.0 37.0 24.0 32.0 25.8 C27.0 24.0 21.0 26.0 13 27.5 Z" fill="#8E745E" />
      <ellipse cx="30.2" cy="44.6" rx="12.0" ry="6.4" fill="#F4ECDF" />
    </>,
    accessories: <>
      <path d="M21.8 46.8 C26.2 49.8 37.8 49.8 42.2 46.8 C43.0 50.0 40.8 53.0 38.0 53.4 C33.5 54.0 28.8 54.0 24.8 53.2 C22.2 52.6 21.0 49.6 21.8 46.8 Z" fill="#C4563F" />
      <path d="M34.8 50.8 L38.4 50.2 L39.2 55.6 C37.4 56.2 35.8 56.0 34.8 55.2 Z" fill="#AD4631" />
    </>,
  },
};

const LEGACY_COLORS: Readonly<Record<string, string>> = {
  '#2563eb': '#6474e5',
  '#dc2626': '#f36d63',
  '#d97706': '#f4ad45',
  '#059669': '#61b68c',
  '#7c3aed': '#a884e5',
  '#db2777': '#e774ad',
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
  event.currentTarget.style.setProperty('--bot-gaze-y', `${Math.max(-1, Math.min(1, y * 1)).toFixed(2)}px`);
}

function resetEyes(event: PointerEvent<HTMLSpanElement>) {
  event.currentTarget.style.removeProperty('--bot-gaze-x');
  event.currentTarget.style.removeProperty('--bot-gaze-y');
}

export function BotAvatar({
  avatar, label, workspaceId, mood = 'idle', animate = false, executorKind = 'peer', showExecutorBadge = false,
}: BotAvatarProps) {
  const motion = useAvatarMotion(botAvatarMotion(mood, animate));
  const clipId = `bot-cat-head-${useId()}`;
  const badge = showExecutorBadge || executorKind !== 'peer'
    ? <ExecutorIcon kind={executorKind} size={14} className="bot-avatar-executor" />
    : null;
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
      >
        <img src={dataUrl} alt="" />
        {badge}
      </span>
    );
  }
  const generated = avatar.kind === 'generated' ? avatar : generateAvatar(workspaceId);
  // Legacy profiles rotated through the renderer's shape order before variant was persisted.
  const shape = BOT_AVATAR_SHAPES.find(shape => shape === generated.shape) ?? 'circle';
  const legacyShapes = Object.keys(SHAPE_TO_CAT_ID) as Array<keyof typeof SHAPE_TO_CAT_ID>;
  const visualShape = generated.variant === undefined
    ? legacyShapes[(legacyShapes.indexOf(shape) + legacyVariant(workspaceId)) % legacyShapes.length] ?? shape
    : shape;
  const catId = SHAPE_TO_CAT_ID[visualShape];
  const cat = CATS[catId];
  const [dx, dy] = cat.eyeOffset;
  const eyes = mood === 'error' ? (catId === 'midnight' ? '#F4A69E' : '#A83B32') : cat.eyes;
  return (
    <span
      className="bot-avatar bot-avatar-generated"
      role="img"
      aria-label={label}
      data-avatar-kind="generated"
      data-avatar-shape={visualShape}
      data-avatar-breed={catId}
      data-avatar-mood={mood}
      data-avatar-sleeping={sleeping}
      ref={motion.ref}
      data-avatar-animated={motion.active}
      onPointerMove={sleeping ? undefined : moveEyes}
      onPointerLeave={resetEyes}
    >
      <svg className="bot-avatar-portrait" viewBox="0 0 64 64" focusable="false" aria-hidden="true">
        <defs><clipPath id={clipId}><path d={CAT_HEAD_PATH} /></clipPath></defs>
        {cat.behind}
        <path d={SOFT_COLLAR_PATH} fill={cat.collar} />
        {cat.collarDetail}
        <path d={CAT_HEAD_PATH} fill={cat.coat} />
        <g clipPath={`url(#${clipId})`}>
          {cat.innerEars ? <g fill={cat.innerEars}>
            <path d={LEFT_INNER_EAR} />
            <path d={RIGHT_INNER_EAR} />
          </g> : null}
          {cat.markings}
        </g>
        {cat.accessories}
        <g className="bot-avatar-face">
          {sleeping ? (
            <path d="M22.4 35.6 Q24.6 37.6 26.8 35.6 M31.3 35.6 Q33.5 37.6 35.7 35.6"
              fill="none" stroke={eyes} strokeWidth="1.8" strokeLinecap="round" />
          ) : (
            <g fill={eyes}>
              <rect x={23.6 + dx} y={32.8 + dy} width="3.0" height="5.2" rx="1.5" />
              <rect x={32.5 + dx} y={32.8 + dy} width="3.0" height="5.2" rx="1.5" />
            </g>
          )}
          {cat.nose ? <ellipse cx="29.4" cy="39.8" rx="1.3" ry="0.85" fill={cat.nose} opacity="0.85" /> : null}
        </g>
      </svg>
      {badge}
    </span>
  );
}
