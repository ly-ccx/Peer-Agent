import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const readPage = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = async () => {
  const [overview, overlay] = await Promise.all([
    readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8'),
    readFile(new URL('../../styles/task-artifact-preview-overlay.css', import.meta.url), 'utf8'),
  ]);
  return `${overview}\n${overlay}`;
};

test('验收卡展示卡片级主要产物，并只打开聚合器保留的 openPath', async () => {
  const source = await readPage();
  assert.match(source, /function ArtifactList\(/);
  assert.match(source, /projectTaskOverviewArtifacts\(item\)/);
  assert.match(source, /void clientApi\.openPath\(artifact\.openPath!\)/);
  assert.match(source, /\{artifact\.actionLabel\}/);
  assert.match(source, /<ArtifactList item=\{item\} \/>/);
  assert.doesNotMatch(source, /clientApi\.openPath\(artifact\.ref\)/);
  assert.doesNotMatch(source, /task-artifacts-step-title/);
});

test('产物行内直接显示增删行数，不必悬停预览', async () => {
  const source = await readPage();
  // 行内徽标必须落在 ArtifactList 的产物按钮里，而不是只存在于 hover 预览。
  const listStart = source.indexOf('function ArtifactList(');
  assert.ok(listStart > 0, 'ArtifactList must exist');
  const listSource = source.slice(listStart);
  assert.match(listSource, /className="task-artifact-stat"/);
  assert.match(listSource, /task-artifact-stat-add">\+\{artifact\.preview\.additions\}/);
  assert.match(listSource, /artifact\.preview\.deletions > 0/);
  assert.match(listSource, /task-artifact-stat-del">−\{artifact\.preview\.deletions\}/);
  assert.match(listSource, /artifact\.preview\?\.kind === 'code'/);
  // 分组标题仍按类型分，行内不再重复「代码/文件」类型词。
  assert.match(listSource, /<span>\{group\.label\}<\/span>/);
  assert.doesNotMatch(listSource, /ARTIFACT_KIND_LABELS/);
  // 行首是文件名，不再用 CSS 伪图标占位。
  assert.match(listSource, /className="task-artifact-name"/);
  assert.doesNotMatch(listSource, /task-artifact-icon/);

  const styles = await readStyles();
  assert.match(styles, /\.task-artifact-stat-add\s*\{[^}]*--za-diff-add-fg/s);
  assert.match(styles, /\.task-artifact-stat-del\s*\{[^}]*--za-diff-del-fg/s);
  assert.match(styles, /\.task-artifact-preview-additions[\s\S]*?color:\s*var\(--za-diff-add-fg\)/s);
  assert.match(styles, /\.task-artifact-preview-deletions[\s\S]*?color:\s*var\(--za-diff-del-fg\)/s);
  assert.doesNotMatch(
    styles,
    /\.task-artifact-stat-add\s*\{[^}]*(?:--za-success|#238636)/s,
  );
  assert.doesNotMatch(
    styles,
    /\.task-artifact-stat-del\s*\{[^}]*(?:#cf222e)/s,
  );
  // 长文件名要截断，避免撑破卡片挤掉徽标与操作文案。
  assert.match(styles, /\.task-artifact-name\s*\{[^}]*truncate/s);
  // 行距收成列表，不再用伪图标占位。
  assert.match(styles, /\.task-artifacts-list\s*\{[^}]*space-y-0\.5/s);
  assert.doesNotMatch(styles, /\.task-artifact-icon\s*\{/);
});

test('主要产物默认折叠，摘要显示类型统计，展开后按类型分组', async () => {
  const source = await readPage();
  assert.match(source, /<details className="task-artifacts">/);
  assert.doesNotMatch(source, /<details className="task-artifacts" open/);
  assert.match(source, /<summary className="task-artifacts-summary"/);
  assert.match(source, /<span>主要产物<\/span>/);
  assert.match(source, /\{projection\.summary\}/);
  assert.match(source, /projection\.groups\.map/);
  assert.match(source, /仅显示前 \{projection\.visibleTotal\} 项主要产物/);
  const summaryEnd = source.indexOf('</summary>', source.indexOf('className="task-artifacts-summary"'));
  const contentStart = source.indexOf('className="task-artifacts-content"');
  assert.ok(summaryEnd > 0 && contentStart > summaryEnd, 'artifact content must render after the collapsed summary');
});

test('代码和图片产物使用受控 preview 渲染 hover 内容，而不是读取 openPath 或 ref', async () => {
  const source = await readPage();
  assert.match(source, /function ArtifactHoverPreview\(/);
  assert.match(source, /buildDiffLines\(preview\.diffLines\.join\('\\n'\)\)/);
  assert.match(source, /task-artifact-diff-gutter/);
  assert.match(source, /\{line\.oldNo \?\? ''\}/);
  assert.match(source, /\{line\.newNo \?\? ''\}/);
  assert.match(source, /\+\{preview\.additions\}/);
  assert.match(source, /−\{preview\.deletions\}/);
  assert.match(source, /src=\{preview\.dataUrl\}/);
  assert.match(source, /createPortal\(/);
  assert.match(source, /document\.body/);
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /addEventListener\('scroll', updatePosition, true\)/);
  assert.match(source, /onFocus=\{/);
  assert.match(source, /onBlur=\{/);
  assert.match(source, /zIndex:\s*2147483000/);
  assert.match(source, /position:\s*'fixed'/);
  const styles = await readStyles();
  assert.match(source, /ARTIFACT_PREVIEW_CHROME_STYLE/);
  assert.match(styles, /\n\.task-artifact-preview-portal\s*\{[^}]*position:\s*fixed/s);
  assert.match(styles, /\n\.task-artifact-preview-portal\s*\{[^}]*box-shadow:\s*var\(--glass-modal-shadow/s);
  assert.match(styles, /\.task-artifact-preview-portal::before\s*\{[^}]*backdrop-filter:/s);
  assert.match(styles, /\.task-artifact-preview-portal \.task-artifact-preview\s*\{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.task-artifact-preview-portal \.task-artifact-diff\s*\{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\n\.task-artifact-preview-portal--code\s*\{[^}]*width:\s*34rem/s);
  assert.match(styles, /\n\.task-artifact-preview-portal--image\s*\{[^}]*width:\s*24rem/s);
  assert.match(styles, /\.task-artifact-preview\s*\{[^}]*width:\s*100%/s);
  assert.match(source, /availablePreviewSize\(/);
  assert.doesNotMatch(styles, /100vw/);
  assert.doesNotMatch(styles, /task-artifact-shell:(?:hover|focus-within)\s+\.task-artifact-preview/);
  assert.doesNotMatch(source, /src=\{artifact\.(?:openPath|ref)\}/);
  assert.doesNotMatch(source, /from ['"]node:fs/);
});

test('产物列表具有类型样式、折叠摘要和主要产物上限提示', async () => {
  const styles = await readStyles();
  for (const selector of [
    '.task-artifacts',
    '.task-artifacts-summary',
    '.task-artifacts-content',
    '.task-artifacts::details-content',
    '.task-artifacts[open]::details-content',
    '.task-artifacts[open] .task-artifacts-chevron',
    '.task-artifact-preview--code',
    '.task-artifact-preview--image img',
    '.task-artifact-diff-line--added',
    '.task-artifact-diff-line--deleted',
    '.task-artifact-diff-gutter',
    '.task-artifacts-limit-note',
  ]) {
    assert.ok(styles.includes(selector), `missing ${selector}`);
  }
  assert.match(styles, /\.task-artifacts-chevron\s*\{[^}]*transform:\s*scaleY\(1\) translateY\(-25%\) rotate\(45deg\)/s);
  assert.match(styles, /\.task-artifacts\[open\] \.task-artifacts-chevron\s*\{[^}]*transform:\s*scaleY\(-1\) translateY\(-25%\) rotate\(45deg\)/s);
  assert.ok(styles.includes('scaleY(1) translateY(-25%) rotate(45deg)'));
  assert.ok(styles.includes('scaleY(-1) translateY(-25%) rotate(45deg)'));
  assert.ok(styles.includes('interpolate-size: allow-keywords'));
  assert.ok(styles.includes('::details-content'));
  assert.match(
    styles,
    /\.task-artifacts::details-content\s*\{[^}]*height:\s*0;[^}]*transition:[^}]*height var\(--za-motion-medium\) var\(--za-ease-out\)/s,
  );
  assert.match(styles, /\.task-artifacts\[open\]::details-content\s*\{[^}]*height:\s*auto/s);
  assert.match(
    styles,
    /\.task-artifacts-chevron\s*\{[^}]*transition:\s*transform var\(--za-motion-medium\) var\(--za-ease-out\)/s,
  );
  assert.doesNotMatch(styles, /-rotate-135/);
});
