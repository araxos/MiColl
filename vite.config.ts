import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // build date, shown as the release date in Settings -> Version
  // (in dev it's when the dev server started)
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Tauri settings:
  // don't clear the screen, so Rust errors stay visible
  clearScreen: false,
  // Tauri needs a fixed port, fail if it's taken
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // don't watch the Rust folder
      ignored: ["**/src-tauri/**"],
    },
  },
}));
