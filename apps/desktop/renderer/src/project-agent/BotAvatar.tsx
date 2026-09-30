import type { BotAvatar as BotAvatarModel } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { clientApi } from '../clientApi';

interface BotAvatarProps {
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly workspaceId: string;
}

export function BotAvatar({ avatar, label, workspaceId }: BotAvatarProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (avatar.kind !== 'image') {
      setDataUrl(null);
      return undefined;
    }
    let cancelled = false;
    setDataUrl(null);
    void clientApi.projectAgentReadAvatar({ workspaceId }).then((result) => {
      if (!cancelled) setDataUrl(result.ok ? result.dataUrl : null);
    }).catch(() => {
      if (!cancelled) setDataUrl(null);
    });
    return () => { cancelled = true; };
  }, [avatar, workspaceId]);

  const initial = Array.from(label.trim())[0]?.toLocaleUpperCase() || 'P';
  if (avatar.kind === 'image') {
    return (
      <span
        className="bot-avatar bot-avatar-image"
        role="img"
        aria-label={label}
        data-avatar-kind="image"
      >
        {dataUrl ? <img src={dataUrl} alt="" /> : <span aria-hidden="true">{initial}</span>}
      </span>
    );
  }
  return (
    <span
      className="bot-avatar bot-avatar-generated"
      style={{ ['--bot-avatar-accent' as string]: avatar.color }}
      role="img"
      aria-label={label}
      data-avatar-kind="generated"
      data-avatar-shape={avatar.shape}
    >
      <span aria-hidden="true">{initial}</span>
    </span>
  );
}
