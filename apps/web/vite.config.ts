import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API_TARGET lets a second dev server point at another API instance
// (e.g. one started on a different port for testing).
const API_TARGET = process.env.API_TARGET ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      "/api": API_TARGET,
    },
  },
});
