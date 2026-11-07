import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", ws: true },
      // The matchmaking page (/play.html) talks to the public site on its own port.
      "/mm-api": { target: "http://127.0.0.1:8090", rewrite: (p) => p.replace(/^\/mm-api/, "/api") },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      // Two pages: the panel, and the matchmaking page the public site serves.
      input: { main: "index.html", play: "play.html" },
    },
  },
});
