import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html'), app: resolve(import.meta.dirname, 'app.html'), docs: resolve(import.meta.dirname, 'docs.html'), getStarted: resolve(import.meta.dirname, 'get-started.html'), logsHome: resolve(import.meta.dirname, 'logs-home.html') } } },
});
