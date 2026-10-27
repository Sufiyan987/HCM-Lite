import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyRequest, request) => {
            proxyRequest.setHeader("X-Hcm-Public-Host", request.headers.host || "");
          });
        },
      },
    },
  },
});
