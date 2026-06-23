#!/bin/bash
# Peer Agent 发布入口（tag 驱动）
#
# 本脚本只负责：计算版本 → 回写版本事实源 → 提交 → 打 tag → 推送 tag。
# 真正的跨平台构建与发布到 GitHub Releases 由 .github/workflows/release.yml
# 在 CI 中完成（推送 tag 即触发）。本机不再出包、不再上传 OSS。
#
# 用法:
#   ./scripts/publish.sh stable        — 发布正式版（取 VERSION，如 v0.0.1）
#   ./scripts/publish.sh beta          — 发布测试版（自动递增 beta 号，如 v0.0.1-beta.N）
#   ./scripts/publish.sh beta 3        — 发布指定 beta 号（v0.0.1-beta.3）
#
# 通道分流（与 workflow / electron-builder 一致）：
#   纯 vX.Y.Z      → latest 通道（正式 Release）
#   vX.Y.Z-beta.N  → beta 通道（prerelease）
#
# 选项:
#   DRY_RUN=1 ./scripts/publish.sh beta   — 只演练，不提交/不打 tag/不推送

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

CHANNEL="${1:-stable}"
BETA_NUM="${2:-}"
DRY_RUN="${DRY_RUN:-0}"

if [[ "$CHANNEL" != "stable" && "$CHANNEL" != "beta" ]]; then
  echo "❌ 用法: $0 [stable|beta] [beta号]"
  echo "   示例: $0 stable    → 发布 vX.Y.Z"
  echo "   示例: $0 beta      → 发布 vX.Y.Z-beta.N（自动递增）"
  echo "   示例: $0 beta 3    → 发布 vX.Y.Z-beta.3"
  exit 1
fi

cd "$ROOT_DIR"

# ── 基线版本来自 VERSION（唯一事实源），去掉任何预发布后缀 ──
BASE_VERSION="$(sed 's/-.*//' < "${ROOT_DIR}/VERSION" | tr -d '[:space:]')"

if [[ "$CHANNEL" == "beta" ]]; then
  if [[ -n "$BETA_NUM" ]]; then
    NEXT_BETA="$BETA_NUM"
  else
    # 自动递增：扫描已存在的 git tag，取当前 base 下最大的 beta 号 +1
    LAST_BETA="$(git tag -l "v${BASE_VERSION}-beta.*" \
      | sed -E "s/.*-beta\.([0-9]+)$/\1/" \
      | sort -n | tail -1)"
    NEXT_BETA=$(( ${LAST_BETA:-0} + 1 ))
  fi
  VERSION="${BASE_VERSION}-beta.${NEXT_BETA}"
else
  VERSION="$BASE_VERSION"
fi

TAG_NAME="v${VERSION}"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Peer Agent 发布（tag 驱动）         ║"
echo "╠══════════════════════════════════════════╣"
echo "║  通道:   ${CHANNEL}"
echo "║  版本:   ${VERSION}"
echo "║  Tag:    ${TAG_NAME}"
echo "║  DryRun: ${DRY_RUN}"
echo "╚══════════════════════════════════════════╝"
echo ""

if git tag -l "$TAG_NAME" | grep -qx "$TAG_NAME"; then
  echo "❌ Tag ${TAG_NAME} 已存在。请换一个 beta 号或先删除旧 tag。"
  exit 1
fi

# ── 发布前 gate：本版本的发布说明必须已提前写好 ──
# 发布说明由人工（可借助 LLM）提前写入 release-notes/v<版本>.md，
# CI 的 release job 会用它作为 GitHub Release 正文（body_path）。
# 文件缺失或为空则拒绝发布，避免再次出现“更新内容只有一句话”的问题。
RELEASE_NOTES_FILE="${ROOT_DIR}/release-notes/${TAG_NAME}.md"
if [[ ! -f "$RELEASE_NOTES_FILE" ]] || [[ -z "$(tr -d '[:space:]' < "$RELEASE_NOTES_FILE")" ]]; then
  echo "❌ 缺少本版本的发布说明：release-notes/${TAG_NAME}.md（不存在或为空）。"
  echo ""
  echo "   请先创建并填写该文件，再重新发布："
  echo "     cp release-notes/TEMPLATE.md release-notes/${TAG_NAME}.md"
  echo "     # 编辑 release-notes/${TAG_NAME}.md，写入本版本的更新内容（Markdown）"
  echo ""
  echo "   该文件将作为 GitHub Release 的正文，并在桌面端「发现新版本」弹窗中展示。"
  exit 1
fi
echo "📄 发布说明: release-notes/${TAG_NAME}.md ✓"

# ── Step 1: 回写版本事实源（VERSION / package.json / Cargo.toml / Cargo.lock）──
echo "📝 Step 1/4: stamp 版本 → ${VERSION}"
node "${ROOT_DIR}/scripts/stamp-version.mjs" "${VERSION}"

# ── Step 2: 校验一致性 ──
echo ""
echo "🔎 Step 2/4: 校验版本一致性"
node "${ROOT_DIR}/scripts/check-version.mjs"

if [[ "$DRY_RUN" == "1" ]]; then
  echo ""
  echo "🧪 DRY_RUN=1：到此为止。已修改工作区版本文件，但不提交/不打 tag/不推送。"
  echo "   可执行 'git checkout -- .' 还原。"
  exit 0
fi

# ── Step 3: 提交版本变更 + 打 tag ──
echo ""
echo "🏷️  Step 3/4: 提交并打 tag"
git add -A
git commit -m "release: ${VERSION}" || echo "   （无版本文件变更，跳过 commit）"
git tag -a "$TAG_NAME" -m "Release ${VERSION} (${CHANNEL})"
echo "   ✓ 已创建 Tag: ${TAG_NAME}"

# ── Step 4: 推送 commit 与 tag（触发 CI 发布）──
echo ""
echo "🚀 Step 4/4: 推送（将触发 GitHub Actions 发布）"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$CURRENT_BRANCH"
git push origin "$TAG_NAME"

echo ""
echo "═══════════════════════════════════════════"
echo "✅ 已推送 Tag ${TAG_NAME}，CI 将自动构建并发布到 GitHub Releases。"
echo "   通道:   ${CHANNEL}"
echo "   进度:   https://github.com/yinLiangDream/Peer-Agent/actions"
echo "   发布物: https://github.com/yinLiangDream/Peer-Agent/releases"
echo "═══════════════════════════════════════════"
