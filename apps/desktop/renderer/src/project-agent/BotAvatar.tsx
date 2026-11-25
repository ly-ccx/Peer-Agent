import { motionAllowed } from '../app/state/motionEnvironment';
import type { BotAvatar as BotAvatarModel, BotAvatarHead, BotAvatarNeck } from '@peer-agent/protocol';
import { useEffect, useId, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { clientApi } from '../clientApi';
import {
  botAvatarDisplayColor,
  resolveCatAvatarConfig,
  type CatCoatSpec,
  type CatPalette,
} from './botCatParts';
import { ExecutorIcon, type ExecutorKind } from './ExecutorIcon';
import { useAvatarMotion } from './state/useAvatarMotion';
import { botAvatarMotion, type BotAvatarMood } from './state/botAvatarState';

export { botAvatarDisplayColor };

export interface BotAvatarProps {
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly workspaceId: string;
  readonly mood?: BotAvatarMood;
  readonly animate?: boolean;
  readonly interactive?: boolean;
  readonly executorKind?: ExecutorKind;
  readonly showExecutorBadge?: boolean;
}

const CAT_HEAD_PATH =
  'M15.8 31.4 C15.0 25.4 16.4 18.6 19.3 18.2 C22.2 17.8 25.4 21.6 27.2 23.6 C30.0 23.0 34.2 23.0 37.0 23.6 C38.8 21.6 42.0 17.8 44.9 18.2 C47.8 18.6 49.0 25.4 48.2 31.4 C49.4 33.8 49.8 36.4 49.4 39.2 C48.4 46.0 41.6 50.2 32.0 50.2 C22.4 50.2 15.6 46.0 14.6 39.2 C14.2 36.4 14.6 33.8 15.8 31.4 Z';
const SOFT_SHOULDERS_PATH =
  'M20.4 47.4 C22.6 53.8 26.8 56.2 32.0 56.2 C37.2 56.2 41.4 53.8 43.6 47.4 C40.0 49.4 36.2 50.2 32.0 50.2 C27.8 50.2 24.0 49.4 20.4 47.4 Z';
const LEFT_INNER_EAR = 'M19.0 21.2 C18.3 23.2 18.8 25.4 20.4 26.1 C21.9 25.4 22.5 23.3 21.2 21.4 Z';
const RIGHT_INNER_EAR = 'M45.0 21.2 C45.7 23.2 45.2 25.4 43.6 26.1 C42.1 25.4 41.5 23.3 42.8 21.4 Z';

function renderCoatMarkings(coat: CatCoatSpec): ReactNode {
  switch (coat.id) {
    case 'midnight':
      return (
        <>
          <path d={LEFT_INNER_EAR} fill={coat.earIn} />
          <path d={RIGHT_INNER_EAR} fill={coat.earIn} />
          <ellipse cx="30.4" cy="47.2" rx="9.0" ry="4.6" fill="#F4ECE0" />
        </>
      );
    case 'tuxedo':
      return (
        <>
          <path d="M12 15 L52 15 L52 32 C44.5 31.0 38.0 27.6 31.6 28.6 C25.2 29.6 20.5 27.0 13 26.2 Z" fill="#323136" />
          <path d="M34.5 25 C38.0 29.4 43.2 33.4 49.5 34.4 L52 21 Z" fill="#323136" />
          <path d="M19.2 21.4 C18.5 23.2 18.9 25.0 20.3 25.7 C21.7 25.0 22.2 23.2 21.1 21.5 Z" fill="#52505A" opacity="0.65" />
          <path d="M44.8 21.4 C45.5 23.2 45.1 25.0 43.7 25.7 C42.3 25.0 41.8 23.2 42.9 21.5 Z" fill="#52505A" opacity="0.65" />
        </>
      );
    case 'calico':
      return (
        <>
          <path d="M11 15 L31 15 C32.2 22.8 28.8 30.6 21.6 32.5 C17.0 33.7 13.0 31.8 10 28.5 Z" fill="#E18B49" />
          <path d="M36.5 15 L54 15 L53 35.2 C47.5 34.6 42.0 32.0 39.2 27.0 C37.2 23.2 36.6 19.0 36.5 15 Z" fill="#3B3635" />
          <ellipse cx="45.2" cy="42.0" rx="6.0" ry="4.5" fill="#E69A5A" opacity="0.9" />
        </>
      );
    case 'ginger':
      return (
        <>
          <path d={LEFT_INNER_EAR} fill={coat.earIn} />
          <path d={RIGHT_INNER_EAR} fill={coat.earIn} />
          <path d="M29.4 23.2 L30.6 28.0 M32.8 23.0 L32.4 28.5 M35.8 23.4 L34.6 28.0" stroke="#C87A35" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
          <ellipse cx="30.6" cy="44.8" rx="13.6" ry="7.4" fill="#FCF3E4" />
        </>
      );
    case 'siamese':
      return (
        <>
          <path d="M12 15 L27.2 15 L25.2 28.4 C20.5 28.8 16.0 27.6 12 24.8 Z" fill="#6D5042" />
          <path d="M36.8 15 L52 15 L52 25.2 C48.0 27.8 43.5 28.8 38.8 28.4 Z" fill="#6D5042" />
          <ellipse cx="29.4" cy="37.4" rx="10.2" ry="7.2" fill="#B5917A" opacity="0.46" />
        </>
      );
    case 'blue':
      return (
        <>
          <path d={LEFT_INNER_EAR} fill={coat.earIn} />
          <path d={RIGHT_INNER_EAR} fill={coat.earIn} />
          <ellipse cx="30.6" cy="46.8" rx="10.4" ry="5.0" fill="#E8EDF2" />
        </>
      );
    case 'cream':
      return (
        <>
          <path d={LEFT_INNER_EAR} fill={coat.earIn} />
          <path d={RIGHT_INNER_EAR} fill={coat.earIn} />
        </>
      );
    case 'tabby':
      return (
        <>
          <path d="M13 15 L51 15 L51 28.5 C43 27.0 37.0 25.0 32.0 26.8 C27.0 25.0 21.0 27.0 13 28.5 Z" fill="#8E745E" />
          <ellipse cx="30.4" cy="45.2" rx="12.2" ry="6.4" fill="#F5EDE0" />
        </>
      );
  }
}

function renderHeadBehind(head: BotAvatarHead, palette: CatPalette): ReactNode {
  switch (head) {
    case 'vermeer':
      return <path d="M40.5 25.0 C49.5 28.0 53.0 38.0 49.6 49.2 C46.0 50.2 42.4 47.8 41.0 43.8 Z" fill={palette.outfitSoft} />;
    case 'straw':
      return <ellipse cx="32.2" cy="23.5" rx="21.0" ry="6.2" transform="rotate(-6 32.2 23.5)" fill="#EBB852" />;
    case 'headphones':
      return (
        <path
          d="M13.5 35.5 C12.5 21.5 20.5 14.2 32.0 14.2 C43.5 14.2 51.5 21.5 50.5 35.5"
          fill="none"
          stroke={palette.outfitDark}
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      );
    default:
      return null;
  }
}

function renderHeadFront(head: BotAvatarHead, palette: CatPalette, clipId: string): ReactNode {
  switch (head) {
    case 'beret':
      return (
        <>
          <path d="M20.2 24.4 C21.8 15.2 35.0 12.8 43.6 18.6 C45.8 20.0 45.0 23.6 41.2 24.4 C35.4 25.8 26.2 25.8 20.2 24.4 Z" fill={palette.outfit} />
          <path d="M22.2 23.6 C27.5 24.8 35.5 24.6 41.8 23.2" fill="none" stroke={palette.outfitDark} strokeWidth="1.3" strokeLinecap="round" opacity="0.65" />
          <path d="M33.2 15.6 C33.5 13.4 35.0 12.6 36.2 13.2" fill="none" stroke={palette.outfitDark} strokeWidth="1.8" strokeLinecap="round" />
        </>
      );
    case 'glasses':
      return (
        <>
          <g stroke="#C9A258" strokeWidth="1.2" strokeOpacity="0.92" fill="#FFFFFF" fillOpacity="0.12">
            <ellipse cx="24.7" cy="36.4" rx="5.1" ry="4.2" />
            <ellipse cx="33.9" cy="36.4" rx="5.1" ry="4.2" />
            <path d="M29.8 36.2 H28.8" fill="none" />
          </g>
          <path d="M21.6 34.4 Q22.7 33.5 23.9 33.7" fill="none" stroke="#FFFFFF" strokeWidth="0.85" strokeLinecap="round" opacity="0.55" />
          <path d="M30.8 34.4 Q31.9 33.5 33.1 33.7" fill="none" stroke="#FFFFFF" strokeWidth="0.85" strokeLinecap="round" opacity="0.55" />
        </>
      );
    case 'beanie':
      return (
        <>
          <path d="M18.6 25.8 C19.8 15.8 25.4 13.2 32.0 13.2 C38.6 13.2 44.2 15.8 45.4 25.8 C40.5 23.6 36.2 23.0 32.0 23.0 C27.8 23.0 23.5 23.6 18.6 25.8 Z" fill={palette.outfit} />
          <path d="M17.8 24.8 C23.8 22.6 40.2 22.6 46.2 24.8 L45.8 27.8 C39.8 25.6 24.2 25.6 18.2 27.8 Z" fill={palette.outfitDark} />
          <circle cx="32.0" cy="12.5" r="2.6" fill={palette.outfitSoft} />
        </>
      );
    case 'vermeer':
      return (
        <>
          <g clipPath={`url(#${clipId})`}>
            <path d="M13 29.2 C20.5 21.2 34.5 20.2 47.5 28.2 C49.5 29.6 50.5 33.6 49.5 37.2 C43.0 28.6 28.5 25.6 13.5 32.6 Z" fill={palette.outfit} />
          </g>
          <circle cx="43.0" cy="43.2" r="2.3" fill="#FFFFFF" />
          <circle cx="42.4" cy="42.5" r="0.7" fill="#E6ECF5" />
        </>
      );
    case 'straw':
      return (
        <>
          <path d="M21.0 22.2 C22.2 14.8 27.2 12.6 33.2 13.0 C38.8 13.4 42.8 16.4 43.8 21.4 C37.2 19.8 27.4 20.0 21.0 22.2 Z" fill="#F2C666" />
          <path d="M20.8 21.4 C27.4 19.0 37.2 18.8 43.8 20.6 L43.4 23.0 C37.0 21.2 27.6 21.4 21.2 23.6 Z" fill={palette.outfit} />
        </>
      );
    case 'headphones':
      return (
        <>
          <rect x="10.8" y="31.5" width="4.8" height="10.2" rx="2.4" fill={palette.outfit} />
          <rect x="48.4" y="31.5" width="4.8" height="10.2" rx="2.4" fill={palette.outfit} />
          <rect x="12.0" y="33.5" width="1.2" height="6.2" rx="0.6" fill="#FFFFFF" opacity="0.35" />
          <rect x="50.8" y="33.5" width="1.2" height="6.2" rx="0.6" fill="#FFFFFF" opacity="0.35" />
        </>
      );
    case 'crown':
      return (
        <>
          <path d="M26.2 23.0 L27.6 15.8 L30.4 19.2 L32.0 14.6 L33.6 19.2 L36.4 15.8 L37.8 23.0 Z" fill="#E9B244" />
          <path d="M26.4 22.0 H37.6" stroke="#C88E26" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="32.0" cy="19.5" r="1.15" fill={palette.outfit} />
        </>
      );
    case 'none':
      return null;
  }
}

function renderNeckwear(neck: BotAvatarNeck, palette: CatPalette): ReactNode {
  switch (neck) {
    case 'bowtie':
      return (
        <>
          <path d={SOFT_SHOULDERS_PATH} fill={palette.outfitDark} />
          <path d="M27.4 49.2 L31.6 54.6 L35.8 49.2 Z" fill="#FAF6EE" />
          <path d="M27.6 49.6 L31.6 51.6 L27.6 53.6 Z M35.6 49.6 L31.6 51.6 L35.6 53.6 Z" fill={palette.outfit} />
          <circle cx="31.6" cy="51.6" r="1.4" fill={palette.outfitDark} />
        </>
      );
    case 'scarf':
      return (
        <>
          <path d={SOFT_SHOULDERS_PATH} fill={palette.outfitDark} />
          <path d="M21.0 47.4 C25.8 50.6 38.2 50.6 43.0 47.4 C43.8 50.8 41.5 53.8 38.4 54.2 C33.6 54.8 28.6 54.8 24.4 53.8 C21.8 53.2 20.2 50.2 21.0 47.4 Z" fill={palette.outfit} />
          <path d="M34.8 51.4 L38.6 50.8 L39.4 56.4 C37.6 57.0 35.8 56.8 34.8 56.0 Z" fill={palette.outfitSoft} />
        </>
      );
    case 'sweater':
      return (
        <>
          <path d={SOFT_SHOULDERS_PATH} fill={palette.outfit} />
          <path d="M26.2 49.0 Q32.0 52.8 37.8 49.0 L36.4 53.6 Q32.0 55.6 27.6 53.6 Z" fill="#FAF5EC" />
          <path d="M24.2 50.4 Q32.0 54.2 39.8 50.4" fill="none" stroke={palette.outfitDark} strokeWidth="1.2" opacity="0.45" />
        </>
      );
    case 'moon':
      return (
        <>
          <path d={SOFT_SHOULDERS_PATH} fill={palette.outfit} />
          <path d="M27.4 49.2 C29.0 53.4 30.8 55.2 32.0 55.2 C33.2 55.2 35.0 53.4 36.6 49.2 Z" fill="#F6EFE2" />
          <path d="M23.0 48.2 Q32.0 52.2 41.0 48.2" fill="none" stroke={palette.outfitDark} strokeWidth="2.4" strokeLinecap="round" />
          <path d="M31.2 51.4 A2.2 2.2 0 1 1 29.6 54.9 A1.75 1.75 0 1 0 31.2 51.4 Z" fill="#F2C75C" />
        </>
      );
    case 'sailor':
      return (
        <>
          <path d={SOFT_SHOULDERS_PATH} fill={palette.outfit} />
          <path d="M22.8 48.6 L32.0 55.4 L41.2 48.6" fill="none" stroke="#FAF6EE" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M29.4 50.6 L32.0 55.2 L34.6 50.6 Z" fill={palette.outfitSoft} />
        </>
      );
    case 'cape':
      return (
        <>
          <path d={SOFT_SHOULDERS_PATH} fill={palette.outfit} />
          <path d="M23.5 48.2 Q32.0 52.0 40.5 48.2" fill="none" stroke={palette.outfitSoft} strokeWidth="2.0" strokeLinecap="round" />
          <circle cx="32.0" cy="51.2" r="1.5" fill="#F6D06D" />
        </>
      );
  }
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
  avatar,
  label,
  workspaceId,
  mood = 'idle',
  animate = false,
  interactive = true,
  executorKind = 'peer',
  showExecutorBadge = false,
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

  const resolved = resolveCatAvatarConfig(avatar, workspaceId);
  const { coat, palette, head, neck, backdrop, shape } = resolved;
  const eyes = mood === 'error' ? (coat.id === 'midnight' ? '#F4A69E' : '#A83B32') : coat.eye;
  const eyeY = head === 'beret' || head === 'vermeer' ? 33.8 : 33.4;
  const glintOpacity = coat.id === 'midnight' ? 0.65 : 0.82;
  const style = {
    '--cat-bg-light': palette.bgLight,
    '--cat-bg-dark': palette.bgDark,
    '--cat-ring-light': palette.ringLight,
    '--cat-ring-dark': palette.ringDark,
  } as CSSProperties;

  return (
    <span
      className="bot-avatar bot-avatar-generated"
      role="img"
      aria-label={label}
      data-avatar-kind="generated"
      data-avatar-shape={shape}
      data-avatar-breed={coat.id}
      data-avatar-head={head}
      data-avatar-neck={neck}
      data-avatar-backdrop={String(backdrop)}
      data-avatar-mood={mood}
      data-avatar-sleeping={sleeping}
      style={style}
      ref={motion.ref}
      data-avatar-animated={motion.active}
      onPointerMove={!interactive || sleeping ? undefined : moveEyes}
      onPointerLeave={!interactive ? undefined : resetEyes}
    >
      <svg className="bot-avatar-portrait" viewBox="0 0 64 64" focusable="false" aria-hidden="true">
        <defs>
          <clipPath id={clipId}><path d={CAT_HEAD_PATH} /></clipPath>
        </defs>
        {backdrop ? <circle className="bot-avatar-backdrop" cx="32" cy="33" r="29" strokeWidth="1.2" /> : null}
        {renderHeadBehind(head, palette)}
        {renderNeckwear(neck, palette)}
        <ellipse cx="32.0" cy="49.4" rx="8.8" ry="2.2" fill="#1A1512" opacity="0.10" />
        <path d={CAT_HEAD_PATH} fill={coat.base} />
        <g clipPath={`url(#${clipId})`}>
          {renderCoatMarkings(coat)}
          <path d="M14 42 C20 49.5 44 49.5 50 42 L50 53 L14 53 Z" fill={coat.shade} opacity="0.34" />
          <ellipse cx="21.0" cy="40.6" rx="2.8" ry="1.4" fill={coat.blush} opacity="0.28" />
          <ellipse cx="38.2" cy="40.6" rx="2.8" ry="1.4" fill={coat.blush} opacity="0.28" />
        </g>
        {!backdrop && coat.lightRim ? <path className="bot-avatar-light-rim" d={CAT_HEAD_PATH} /> : null}
        {renderHeadFront(head, palette, clipId)}
        <g className="bot-avatar-face">
          {sleeping ? (
            <path
              d="M22.4 36.2 Q24.6 38.2 26.8 36.2 M31.3 36.2 Q33.5 38.2 35.7 36.2"
              fill="none"
              stroke={eyes}
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          ) : (
            <g>
              <rect x="23.2" y={eyeY} width="3.1" height="5.3" rx="1.55" fill={eyes} />
              <rect x="32.1" y={eyeY} width="3.1" height="5.3" rx="1.55" fill={eyes} />
              <circle cx="24.2" cy={eyeY + 1.5} r="0.62" fill="#FFFFFF" opacity={glintOpacity} />
              <circle cx="33.1" cy={eyeY + 1.5} r="0.62" fill="#FFFFFF" opacity={glintOpacity} />
            </g>
          )}
          {coat.nose ? <ellipse cx="29.2" cy={eyeY + 6.9} rx="1.3" ry="0.85" fill={coat.nose} opacity="0.85" /> : null}
        </g>
      </svg>
      {badge}
    </span>
  );
}
