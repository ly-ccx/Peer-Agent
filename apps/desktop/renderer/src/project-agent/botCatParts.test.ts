import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_HEADS,
  BOT_AVATAR_NECKS,
  BOT_AVATAR_SHAPES,
} from '@peer-agent/protocol';
import {
  CAT_COATS,
  CAT_PALETTES,
  botAvatarDisplayColor,
  createRandomCatParts,
  resolveCatAvatarConfig,
  resolveCatPalette,
} from './botCatParts.ts';

test('8 个主题色映射到柔和穿搭色板与亮暗底盘且覆盖旧版色值', () => {
  assert.equal(CAT_PALETTES.length, BOT_AVATAR_COLORS.length);
  for (const color of BOT_AVATAR_COLORS) {
    const palette = resolveCatPalette(color);
    assert.equal(palette.id, color);
    assert.notEqual(palette.bgLight, palette.bgDark);
    assert.notEqual(palette.outfit, palette.outfitDark);
  }
  assert.equal(botAvatarDisplayColor('#0891b2'), '#55bac7');
  assert.equal(resolveCatPalette('#0891b2').id, '#55bac7');
});

test('8 种毛色完整覆盖协议 shape 且缺省部件回落到精选搭配与开启柔彩底盘', () => {
  assert.equal(CAT_COATS.length, BOT_AVATAR_SHAPES.length);
  const shapes = new Set(CAT_COATS.map((coat) => coat.shape));
  for (const shape of BOT_AVATAR_SHAPES) {
    assert.equal(shapes.has(shape), true);
    const resolved = resolveCatAvatarConfig(
      { kind: 'generated', shape, color: '#55bac7', variant: 0 },
      `ws-${shape}`,
    );
    assert.equal(resolved.shape, shape);
    assert.equal(resolved.color, '#55bac7');
    assert.equal(resolved.backdrop, true);
    assert.equal(BOT_AVATAR_HEADS.includes(resolved.head), true);
    assert.equal(BOT_AVATAR_NECKS.includes(resolved.neck), true);
  }
});

test('自定义 head、neck 与 backdrop 显式值优先于默认造型', () => {
  const resolved = resolveCatAvatarConfig(
    {
      kind: 'generated',
      shape: 'diamond',
      color: '#f36d63',
      variant: 3,
      head: 'headphones',
      neck: 'cape',
      backdrop: false,
    },
    'ws-custom',
  );
  assert.equal(resolved.coat.id, 'tuxedo');
  assert.equal(resolved.head, 'headphones');
  assert.equal(resolved.neck, 'cape');
  assert.equal(resolved.color, '#f36d63');
  assert.equal(resolved.palette.id, '#f36d63');
  assert.equal(resolved.backdrop, false);
});

test('随机混搭总是切换毛色、配色、头饰与领饰并保留底盘开关', () => {
  const current = resolveCatAvatarConfig(
    {
      kind: 'generated',
      shape: 'diamond',
      color: '#55bac7',
      variant: 1,
      head: 'none',
      neck: 'bowtie',
      backdrop: false,
    },
    'ws-shuffle',
  );
  const next = createRandomCatParts(current, () => 0.37);
  assert.notEqual(next.shape, current.shape);
  assert.notEqual(next.color, current.color);
  assert.notEqual(next.head, current.head);
  assert.notEqual(next.neck, current.neck);
  assert.equal(next.backdrop, false);
});
