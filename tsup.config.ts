import { defineConfig } from "tsup";

// Bundles the server (Hono + CLI) into dist/server. The web SPA is built
// separately by Vite into dist/web and shipped alongside in the npm tarball.
//
// Every runtime package is INLINED into the bundle (noExternal), so the
// published package has no dependencies at all: `npx punchout-simulator`
// installs exactly the files in the tarball and resolves nothing else at
// install time. What is inlined is listed, with its licence, in
// dist/THIRD-PARTY-LICENSES.txt (scripts/third-party.mjs, from the metafile).
export default defineConfig({
  entry: {
    cli: "src/server/cli.ts",
  },
  outDir: "dist/server",
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: false,
  // No source map in the published tarball — end users never use it and it just
  // adds weight (matches the SPA build, which also ships without one).
  sourcemap: false,
  clean: true,
  noExternal: [/.*/],
  metafile: true,
  banner: {
    // Some inlined packages are CommonJS and `require()` Node built-ins, which
    // an ES module can only do through createRequire.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});
