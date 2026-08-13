import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.OPERATOR_API_PROXY_TARGET || 'http://127.0.0.1:4174';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': apiTarget,
    },
  },
});
