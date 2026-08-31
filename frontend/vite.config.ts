import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies /api to FastAPI so the session cookie is same-origin.
// VITE_API_TARGET points it at a scratch backend when inspecting behaviour
// against a throwaway database.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": process.env.VITE_API_TARGET ?? "http://localhost:8000",
    },
  },
});
