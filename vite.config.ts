import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "AI Воркбенч",
        short_name: "Воркбенч",
        description: "Персональний AI-воркбенч: агенти на Claude API зі спільним контекстом",
        lang: "uk",
        start_url: "/?source=pwa",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#1F3864",
        background_color: "#E8EDF1",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        navigateFallback: "/index.html",
        // Інваріант: відповіді API ніколи не кешуються Service Worker-ом.
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
  server: {
    // `npm run dev:ui`: API береться з `vercel dev` (за замовчуванням порт 3000).
    proxy: { "/api": { target: process.env.API_ORIGIN ?? "http://localhost:3000", changeOrigin: true } },
  },
  build: { target: "es2022" },
});
