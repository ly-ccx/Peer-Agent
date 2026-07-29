import type { ChatAttachment } from './types';

// 附件接收（intake）的纯逻辑与上限常量：判定文本类文件、把 File 读成 dataURL / 文本。
// 从 ChatSurface.tsx 下沉而来，行为保持不变。
//
// 说明：readAsDataUrl / readAsText 依赖浏览器 FileReader（运行时由 renderer 提供），
// 属于「读取本地用户选中的文件内容」的事实采集，结果作为 user/factual context 进入消息，
// 不会被提升为 system 指令。这里只做读取，不做任何提示词拼装。

/** 单条消息最多可携带的附件数量。 */
export const MAX_ATTACHMENTS = 8;
/** 图片附件的最大字节数（8 MiB）。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 文本类附件的最大字节数（512 KiB）。 */
export const MAX_TEXT_FILE_BYTES = 512 * 1024;

/** 文本类文件的扩展名白名单（小写，含点）。 */
export const TEXT_LIKE_EXTENSIONS: readonly string[] = [
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.xml', '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go',
  '.rs', '.c', '.cpp', '.h', '.hpp', '.sh', '.zsh', '.sql', '.log',
];

/** 判定文件是否为「文本类」：MIME 以 text/ 开头，或扩展名命中白名单。 */
export function isTextLikeFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const lower = file.name.toLowerCase();
  return TEXT_LIKE_EXTENSIONS.some((suffix) => lower.endsWith(suffix));
}

/** 把文件读成 base64 dataURL（用于图片附件）。 */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** 把文件读成纯文本（用于文本类附件）。 */
export function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsText(file);
  });
}

export interface AttachmentIntakeResult {
  readonly attachments: ChatAttachment[];
  readonly error: string | null;
}

/**
 * 把用户选择的文件转换为消息附件。主输入框与历史消息编辑器共享此入口，
 * 保证数量、大小、类型和错误提示规则一致。
 */
export async function intakeAttachments(
  files: FileList | File[] | null | undefined,
  existingCount: number,
  isZh: boolean,
  createId: () => string = () => `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): Promise<AttachmentIntakeResult> {
  const incoming = Array.from(files ?? []);
  const attachments: ChatAttachment[] = [];
  let error: string | null = null;

  for (const file of incoming) {
    if (existingCount + attachments.length >= MAX_ATTACHMENTS) {
      error = isZh
        ? `最多只能添加 ${MAX_ATTACHMENTS} 个附件`
        : `You can attach up to ${MAX_ATTACHMENTS} files`;
      break;
    }
    try {
      if (file.type.startsWith('image/')) {
        if (file.size > MAX_IMAGE_BYTES) {
          error = isZh ? `${file.name} 超过 8MB，未添加` : `${file.name} is larger than 8MB and was not attached`;
          continue;
        }
        attachments.push({
          id: createId(),
          name: file.name || 'image',
          mimeType: file.type || 'image/png',
          size: file.size,
          kind: 'image',
          dataUrl: await readAsDataUrl(file),
        });
      } else if (isTextLikeFile(file)) {
        if (file.size > MAX_TEXT_FILE_BYTES) {
          error = isZh ? `${file.name} 超过 512KB，未添加` : `${file.name} is larger than 512KB and was not attached`;
          continue;
        }
        attachments.push({
          id: createId(),
          name: file.name || 'file.txt',
          mimeType: file.type || 'text/plain',
          size: file.size,
          kind: 'text',
          text: await readAsText(file),
        });
      } else {
        attachments.push({
          id: createId(),
          name: file.name || 'file',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          kind: 'unsupported',
        });
        error = isZh
          ? `${file.name || '文件'} 的内容不会随消息内联发送，已附带文件信息（名称/类型/大小），Agent 可在需要时自行读取本地文件`
          : `${file.name || 'File'} content is not inlined into the message; file info (name/type/size) was attached, and the agent can read the local file when needed`;
      }
    } catch (cause) {
      error = cause instanceof Error
        ? cause.message
        : (isZh ? '读取附件失败' : 'Failed to read attachment');
    }
  }

  return { attachments, error };
}
