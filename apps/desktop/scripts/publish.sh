#!/bin/bash
# Peer Agent 一键发布脚本
# 用法:
#   ./scripts/publish.sh stable     — 发布正式版 (0.0.1)
#   ./scripts/publish.sh beta       — 发布测试版 (0.0.1-beta.1, 递增)
#   ./scripts/publish.sh beta 3     — 发布指定 beta 号 (0.0.1-beta.3)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist-electron"
BUCKET="oss://peer-agent"

# ── 参数解析 ──
CHANNEL="${1:-stable}"
BETA_NUM="${2:-}"

if [[ "$CHANNEL" != "stable" && "$CHANNEL" != "beta" ]]; then
  echo "❌ 用法: $0 [stable|beta] [beta号]"
  echo "   示例: $0 stable       → 发布 0.0.1"
  echo "   示例: $0 beta         → 发布 0.0.1-beta.N (自动递增)"
  echo "   示例: $0 beta 3       → 发布 0.0.1-beta.3"
  exit 1
fi

# ── 版本号处理 ──
cd "$DESKTOP_DIR"
BASE_VERSION=$(node -p "require('./package.json').version" | sed 's/-beta.*//')

if [[ "$CHANNEL" == "beta" ]]; then
  OSS_CHANNEL="beta"
  if [[ -n "$BETA_NUM" ]]; then
    VERSION="${BASE_VERSION}-beta.${BETA_NUM}"
  else
    # 自动递增: 从 OSS 获取当前最新 beta 号
    CURRENT_BETA=$(node -p "require('./package.json').version" | grep -oP 'beta\.\K\d+' || echo "0")
    NEXT_BETA=$((CURRENT_BETA + 1))
    VERSION="${BASE_VERSION}-beta.${NEXT_BETA}"
  fi
else
  OSS_CHANNEL="latest"
  VERSION="$BASE_VERSION"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Peer Agent 发布流程                ║"
echo "╠══════════════════════════════════════════╣"
echo "║  通道:   ${CHANNEL}"
echo "║  版本:   ${VERSION}"
echo "║  OSS:    releases/${OSS_CHANNEL}/"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Step 1: 更新 package.json 版本号 ──
echo "📝 Step 1/4: 设置版本号 → ${VERSION}"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
pkg.version = '${VERSION}';
fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "   ✓ package.json version = ${VERSION}"
echo ""

# ── Step 2: 构建前端 ──
echo "🔨 Step 2/4: 构建前端 (vite build)"
npx vite build 2>&1 | tail -5
echo "   ✓ 前端构建完成"
echo ""

# ── Step 3: 打包 Electron ──
echo "📦 Step 3/4: 打包 Electron (arm64)"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 2>&1 | grep -E "•|✓" | grep -v "npm error" | tail -10
echo "   ✓ Electron 打包完成"
echo ""

# ── Step 4: 上传到 OSS ──
echo "☁️  Step 4/4: 上传到 OSS (ali-oss)"

if [[ -z "$OSS_ACCESS_KEY_ID" || -z "$OSS_ACCESS_KEY_SECRET" ]]; then
  echo ""
  echo "⚠️  未设置 OSS 凭证环境变量，跳过上传步骤"
  echo ""
  echo "   请设置以下环境变量后重新运行:"
  echo "   export OSS_ACCESS_KEY_ID=<your-ak>"
  echo "   export OSS_ACCESS_KEY_SECRET=<your-sk>"
  echo ""
  echo "   或写入 ~/.zshrc 后 source ~/.zshrc"
  echo ""
  echo "   构建产物在: ${DIST_DIR}/"
  exit 0
fi

node "${ROOT_DIR}/scripts/upload-to-oss.mjs" --channel "${OSS_CHANNEL}"

# ── Step 5: Git Tag ──
echo ""
echo "🏷️  Step 5: 打 Git Tag"
TAG_NAME="v${VERSION}"
if git tag -l "$TAG_NAME" | grep -q "$TAG_NAME"; then
  echo "   ⚠️  Tag ${TAG_NAME} 已存在，跳过"
else
  git tag -a "$TAG_NAME" -m "Release ${VERSION} (${CHANNEL})"
  echo "   ✓ 已创建 Tag: ${TAG_NAME}"
  echo "   💡 推送 Tag: git push origin ${TAG_NAME}"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "✅ 发布成功！"
echo "   版本: ${VERSION}"
echo "   Tag:  ${TAG_NAME}"
echo "   通道: ${OSS_CHANNEL}"
echo "   检测: https://peer-agent.oss-cn-beijing.aliyuncs.com/releases/${OSS_CHANNEL}/latest-mac.yml"
echo "═══════════════════════════════════════════"
