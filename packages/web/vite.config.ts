import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const examplesDir = resolve(__dirname, '../../examples');

/**
 * /examples lives outside the web package, so Vite does not watch it: a scenario file added or removed while the dev
 * server runs would not appear until a restart. Watch the folder and reload the demo list when it changes.
 */
function watchExamples(): Plugin {
  return {
    name: 'load-sim:watch-examples',
    configureServer(server) {
      server.watcher.add(examplesDir);
      const onChange = (file: string) => {
        if (!file.startsWith(examplesDir) || !/\.ya?ml$/.test(file)) return;
        const mods = server.moduleGraph.getModulesByFile(resolve(__dirname, 'src/examples.ts'));
        mods?.forEach((m) => server.moduleGraph.invalidateModule(m));
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}

export default defineConfig({
  plugins: [react(), watchExamples()],
  base: './',
  worker: { format: 'es' },
  server: { fs: { allow: ['../..'] } },
});
