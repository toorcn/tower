import { defineConfig } from 'vite';
export default defineConfig({ server: { port: 5173, strictPort: true, proxy: { '/v1': { target: 'http://127.0.0.1:4317', ws: true } } } });
