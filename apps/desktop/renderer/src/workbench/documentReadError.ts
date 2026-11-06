export function documentReadError(status: string | undefined, zh: boolean): string {
  const labels: Record<string, readonly [string, string]> = {
    not_git_repo: ['此来源不是 Git 仓库，无法读取历史版本。', 'This source is not a Git repository. Historical reading is unavailable.'],
    invalid_ref: ['历史版本需要完整的提交 SHA，不接受分支名或短 SHA。', 'A historical version requires a full commit SHA, not a branch or short SHA.'],
    revision_unavailable: ['此历史提交当前不可用，未使用当前文件替代。', 'This historical commit is unavailable. The current file was not substituted.'],
    unsupported_entry: ['此历史对象是符号链接或子模块，不支持作为普通文件预览。', 'This historical entry is a symlink or submodule and cannot be previewed as a regular file.'],
    version_unavailable: ['当前读取服务不能核对内容版本，请更新本机服务后重试。', 'The local reader cannot confirm content versions. Update it and retry.'],
    version_changed: ['文件已更新，尚未加载当前版本。', 'The file has changed. The current version has not been loaded.'],
    source_changed: ['文件来源已变化，请关闭此标签后从原允许来源重新打开。', 'The file source changed. Close this tab and reopen it from an allowed source.'],
    not_found: ['未能按此引用定位文件，请检查来源和完整路径。', 'The reference could not locate the file. Check its source and complete path.'],
    permission_denied: ['当前没有读取权限。', 'Reading this resource is not permitted.'],
    scope_denied: ['目标超出当前已确认的来源范围。', 'The target is outside the confirmed source scope.'],
    workspace_unavailable: ['项目或知识库来源当前不可用。', 'The project or knowledge source is unavailable.'],
    ambiguous_path: ['有多个匹配来源，请明确选择文件位置。', 'Multiple sources match. Choose an explicit location.'],
    relative_base_required: ['这个相对路径需要明确来源，请选择位置。', 'This relative path needs an explicit source. Choose a location.'],
    not_file: ['这是目录，请从工作区的目录入口浏览。', 'This is a directory. Open it from Files.'],
    too_large: ['内容超出预览限额，未作为完整正文加载。', 'This resource exceeds the preview limit and was not loaded as complete content.'],
    binary: ['此二进制格式暂不支持正文预览。', 'Text preview is unavailable for this binary format.'],
    invalid_path: ['引用路径无效。', 'The reference path is invalid.'],
    unsupported_type: ['此格式暂不支持图片预览。', 'Image preview is unavailable for this format.'],
  };
  return labels[status ?? '']?.[zh ? 0 : 1] ?? (zh ? '读取失败，可重试。' : 'Reading failed. You can retry.');
}
