import { defineConfig } from "tsup";

// Bundles the server (Hono + CLI) into dist/server. The web SPA is built
// separately by Vite into dist/web and shipped alongside in the npm tarball.
//
// Runtime dependencies are kept EXTERNAL (the default): they are declared in
// package.json "dependencies", so `npx`/`npm i -g` resolves them normally.
// We deliberately keep that dependency set small (see spec section 6) rather
// than inlining packages like `open` that ship platform-specific shim files
// which do not survive bundling.
export default defineConfig({
  entry: {
    cli: "src/server/cli.ts",
  },
  outDir: "dist/server",
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
