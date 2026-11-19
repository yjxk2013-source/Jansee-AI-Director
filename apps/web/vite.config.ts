import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  esbuild: {
    drop: command === "build" ? ["console", "debugger"] : [],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4100",
        changeOrigin: true,
      },
      "/health": {
        target: "http://127.0.0.1:4100",
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: false,
    target: "es2022",
    emptyOutDir: true,
    cssMinify: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-qrcode": ["qrcode"],
        },
      },
    },
  },
}));
