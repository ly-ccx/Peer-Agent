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
