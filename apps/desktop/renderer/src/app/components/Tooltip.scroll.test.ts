import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = () => readFile(new URL('./Tooltip.tsx', import.meta.url), 'utf8');

test('scroll/resize repositions open tooltip instead of hiding it', async () => {
  const source = await readSource();

  // 定位逻辑抽成 updatePosition，打开后 layout 与滚动/resize 共用。
  assert.match(source, /const updatePosition = useCallback\(\(\) => \{/);
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*if \(!open\) return;\s*updatePosition\(\);/s);
  assert.match(source, /const onScrollOrResize = \(\) => updatePosition\(\);/);
  assert.match(source, /window\.addEventListener\('scroll', onScrollOrResize, true\);/);
  assert.match(source, /window\.addEventListener\('resize', onScrollOrResize\);/);

  // 聊天流式自动滚动会冒泡 window scroll；不能在 scroll/resize 上直接 hide。
  assert.doesNotMatch(
    source,
    /const onScrollOrResize = \(\) => hide\(\);/,
  );
  assert.doesNotMatch(
    source,
    /addEventListener\('scroll'[\s\S]{0,120}hide\(\)/,
  );
});
