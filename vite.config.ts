import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by the Hono backend from dist/web (single origin). In dev
// we run Vite's dev server and proxy API + callback routes to the backend on
// port 8080 so the two halves behave as one origin during development too.
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8080";

export default defineConfig({
  root: "src/web",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    // No sourcemaps in the published SPA: they add ~16 MB that end users never
    // use, and keeping the tarball small keeps `npx` fast (spec section 6).
    sourcemap: false,
  },
  server: {
    port: 5173,
    // Anchored regexes (not bare prefixes): a bare "/api" prefix also matches the
    // SPA's own module URL "/api.ts" (src/web/api.ts), proxying it to the backend
    // and blanking the app in dev. Match only the actual route namespaces.
    proxy: {
      "^/api/": { target: BACKEND, changeOrigin: true, ws: true },
      "^/punchout/": { target: BACKEND, changeOrigin: true },
      "^/sim/": { target: BACKEND, changeOrigin: true },
    },
  },
});
