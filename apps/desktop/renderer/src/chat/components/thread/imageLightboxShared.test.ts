import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * 防漂移：图片灯箱必须只有 ImageLightbox 一个实现。
 * 消息流（InlineMarkdown）与聊天附件（ChatSurface / AttachmentStrip）只能复用它，
 * 不允许任何入口再长出第二套弹窗预览（0.0.14 曾同时存在两套，能力与样式漂移）。
 */

const readSource = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const lightboxSource = readSource('./ImageLightbox.tsx');
const stripSource = readSource('./AttachmentStrip.tsx');
const inlineSource = readSource('../markdown/InlineMarkdown.tsx');
const surfaceSource = readSource('../ChatSurface.tsx');

test('shared lightbox exposes the unified component and attachment adapter', () => {
  assert.match(lightboxSource, /export function ImageLightbox\(/);
  assert.match(lightboxSource, /export function imageLightboxSourceFromAttachment\(/);
  assert.match(lightboxSource, /markdown-local-image-lightbox-panel/);
  assert.match(lightboxSource, /loadLocalImageDataUrl/);
});

test('attachment preview reuses the shared lightbox (no second implementation)', () => {
  assert.doesNotMatch(stripSource, /ImagePreviewOverlay/);
  assert.doesNotMatch(stripSource, /<Overlay/);
  assert.doesNotMatch(surfaceSource, /ImagePreviewOverlay/);
  assert.match(surfaceSource, /<ImageLightbox/);
  assert.match(surfaceSource, /imageLightboxSourceFromAttachment\(/);
});

test('message-stream images render the shared lightbox (no local copy)', () => {
  assert.match(inlineSource, /from '\.\.\/thread\/ImageLightbox'/);
  assert.match(inlineSource, /<ImageLightbox/);
  assert.doesNotMatch(inlineSource, /function LocalImageLightbox/);
  assert.doesNotMatch(inlineSource, /backdropClassName="markdown-local-image-lightbox"/);
});

test('legacy retired-overlay styles are gone from chat-surface.css', () => {
  const surfaceCss = readFileSync(new URL('../../styles/chat-surface.css', import.meta.url), 'utf8');
  assert.doesNotMatch(surfaceCss, /\.image-preview-(backdrop|card|img|caption|name|size|close|pending)\b/);
});
