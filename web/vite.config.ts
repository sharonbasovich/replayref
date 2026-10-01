import { defineConfig } from "vite";

// Same-origin proxy so the browser never hits CORS against the local
// nitro devnode. /rpc is forwarded to 127.0.0.1:8547 in dev AND preview.
const proxy = {
  "/rpc": {
    target: "http://127.0.0.1:8547",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/rpc/, ""),
  },
};

export default defineConfig({
  server: { proxy },
  preview: { proxy },
});
