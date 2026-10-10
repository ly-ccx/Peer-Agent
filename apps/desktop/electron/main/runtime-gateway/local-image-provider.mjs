import { createLocalImageProvider } from '@peer-agent/runtime-node';
import { decodeDesktopImage } from './local-image-decoder.mjs';

export function createDesktopLocalImageProvider(options = {}) {
  return createLocalImageProvider({ ...options, decodeImage: options.decodeImage || decodeDesktopImage });
}
