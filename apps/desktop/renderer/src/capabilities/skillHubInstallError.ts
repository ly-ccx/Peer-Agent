/**
 * SkillHub 安装错误码 → 弹窗可读文案。
 *
 * 主进程 `skillhub-verified-installer.mjs` 抛出稳定错误码（如 skillhub_package_md5_mismatch）。
 * Electron IPC 可能包一层 `Error: code` 或 `Error invoking remote method ...: Error: code`，
 * 所以格式化前先抽底层 code，再映射成人话，并附带 code 便于排查。
 */

const ERROR_MESSAGES: Record<string, string> = {
  workspace_required: '当前没有打开工作区，无法安装到工作区',
  skillhub_marketplace_not_available: 'SkillHub 市场服务不可用，请重启应用后重试',
  skillhub_signature_required: '该版本缺少 SkillHub 平台签名，无法验证安装包',
  skillhub_signature_payload_invalid: '签名载荷无效，无法完成安全校验',
  skillhub_hash_version_unsupported: '内容哈希版本不受支持，请更新客户端后再试',
  skillhub_signature_key_unknown: '签名公钥未知，无法信任该安装包',
  skillhub_signature_key_invalid: '签名公钥无效（算法或格式不符合要求）',
  skillhub_signature_key_untrusted: '签名公钥不受信任或已停用',
  skillhub_signature_issuer_invalid: '签名发行方不是 skillhub.cn，已拒绝安装',
  skillhub_signature_invalid: 'Ed25519 签名校验失败，安装包可能被篡改',
  skillhub_signature_identity_mismatch: '签名身份与所选技能不一致',
  skillhub_signature_content_hash_mismatch: '签名中的内容哈希与声明不一致',
  skillhub_package_md5_mismatch: '安装包 ZIP 的 MD5 与签名记录不一致（下载损坏或发布端不同步）',
  skillhub_file_count_mismatch: '安装包文件数与签名记录不一致',
  skillhub_content_hash_mismatch: '安装包内容哈希校验失败（包内文件与签名不匹配）',
  skillhub_zip_invalid: '安装包不是有效的 ZIP',
  skillhub_zip_size_invalid: '安装包体积无效或超过限制',
  skillhub_zip_path_unsafe: '安装包含有不安全路径，已拒绝解压',
  skillhub_zip_symlink_rejected: '安装包含有符号链接，已拒绝安装',
  skillhub_zip_duplicate_path: '安装包存在重复路径，已拒绝安装',
  skillhub_zip_expansion_limit: '安装包解压体积或文件数超过安全上限',
  skillhub_zip_missing_skill: '安装包根目录缺少 SKILL.md',
  skillhub_install_failed: '校验通过后写入本地 Skill 失败',
  skill_install_unreadable: '安装包已写入，但 SKILL.md 无法解析（如 description 含未加引号冒号），未加入已安装列表',
  install_failed: '安装失败，请稍后重试',
  zip_path_escape: '安装包路径越界，已拒绝写入',
};

const KNOWN_CODES = Object.keys(ERROR_MESSAGES).sort((a, b) => b.length - a.length);

/** 从 Error.message / IPC 包装串中抽出稳定错误码。 */
export function extractSkillHubInstallErrorCode(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  // 常见形态：code / Error: code / ... Error: code
  const trailing = text.match(/(?:^|[\s:])([a-z][a-z0-9_]{2,})$/i);
  if (trailing?.[1] && ERROR_MESSAGES[trailing[1]]) return trailing[1];

  for (const code of KNOWN_CODES) {
    if (text === code || text.includes(code)) return code;
  }

  // 未知但像错误码的 snake_case
  const snake = text.match(/\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/i);
  return snake?.[1] ?? null;
}

export function describeSkillHubInstallErrorCode(code: string | null | undefined): string {
  if (!code) return '安装失败，请稍后重试';
  return ERROR_MESSAGES[code] ?? `安装失败（${code}）`;
}

/**
 * 弹窗展示文案：人话 + 底层错误码。
 * 例：安装包 ZIP 的 MD5 与签名记录不一致…（skillhub_package_md5_mismatch）
 */
export function formatSkillHubInstallError(raw: unknown): string {
  const text = raw == null ? '' : String(raw).trim();
  const code = extractSkillHubInstallErrorCode(text || raw);
  if (!code) {
    return text ? `安装失败：${text}` : '安装失败，请稍后重试';
  }
  const human = describeSkillHubInstallErrorCode(code);
  // 人话本身已含 code 时（未知码回退）不再重复
  if (human.includes(`（${code}）`)) return human;
  return `${human}（${code}）`;
}
