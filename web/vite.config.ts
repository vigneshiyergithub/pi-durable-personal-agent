import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, /api and /health go to the agent (npm run dev at the repo root, port 3000).
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
	server: { proxy: { "/api": "http://localhost:3000", "/health": "http://localhost:3000" } },
});
