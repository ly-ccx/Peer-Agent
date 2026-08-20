import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectRendererOs } from './osPlatform.ts';

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PeerAgent Electron/41.7.1 Chrome/142.0.0.0 Safari/537.36';
const WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) PeerAgent Electron/41.7.1 Chrome/142.0.0.0 Safari/537.36';
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) PeerAgent Electron/41.7.1 Chrome/142.0.0.0 Safari/537.36';

describe('detectRendererOs', () => {
  it('macOS UA 判为 darwin（保留交通灯预留）', () => {
    assert.equal(detectRendererOs(MAC_UA), 'darwin');
  });

  it('Windows UA 判为 other（收掉交通灯预留）', () => {
    assert.equal(detectRendererOs(WIN_UA), 'other');
  });

  it('Linux UA 判为 other（收掉交通灯预留）', () => {
    assert.equal(detectRendererOs(LINUX_UA), 'other');
  });

  it('空 UA 不误判为 darwin', () => {
    assert.equal(detectRendererOs(''), 'other');
  });
});
