import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.TUNADESK_API ?? "http://127.0.0.1:4545";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/mcp": { target },
      "/llms.txt": { target },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
