import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: [
      '89b1-103-87-57-22.ngrok-free.app',
      '.ngrok-free.app',
    ],
  },
});
