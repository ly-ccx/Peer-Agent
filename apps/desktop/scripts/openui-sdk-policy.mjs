import { createRequire } from 'node:module';
import path from 'node:path';
import { transformWithEsbuild } from 'vite';

const sdkDirectory = path.dirname(createRequire(import.meta.url).resolve('@openuidev/react-lang'));

/** Public SDK only: remove its development bootstrap in Vite dev as well as production. */
export function peerOpenuiSdkPolicy() {
  return { name: 'peer-openui-sdk-policy', enforce: 'pre',
    async transform(code, id) {
      const file = id.split('?')[0];
      if (!path.isAbsolute(file) || !/\.[cm]?js$/.test(file)) return null;
      const relative = path.relative(sdkDirectory, file);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
      return transformWithEsbuild(code, file, { loader: 'js', minifySyntax: true,
        define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: true });
    },
  };
}
