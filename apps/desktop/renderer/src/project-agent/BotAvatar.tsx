import type { BotAvatar as BotAvatarModel } from '@peer-agent/protocol';

interface BotAvatarProps {
  readonly avatar: BotAvatarModel;
  readonly label: string;
}

/** 生成头像只画形状和颜色。图片头像还没有渲染进程可读的地址，先用占位，不读本地文件。 */
export function BotAvatar({ avatar, label }: BotAvatarProps) {
  if (avatar.kind === 'image') {
    return (
      <span
        className="bot-avatar bot-avatar-image"
        role="img"
        aria-label={label}
        data-avatar-kind="image"
      />
    );
  }
  return (
    <span
      className={`bot-avatar bot-avatar-${avatar.shape}`}
      style={{ background: avatar.color }}
      role="img"
      aria-label={label}
      data-avatar-kind="generated"
      data-avatar-shape={avatar.shape}
    >
      <span className="bot-avatar-eyes" aria-hidden="true">
        <i />
        <i />
      </span>
    </span>
  );
}
