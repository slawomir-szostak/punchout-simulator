import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The published package installs nothing but itself: every runtime package is
// built into dist/server/cli.js (tsup noExternal), so `npx punchout-simulator`
// resolves no dependency at install time. A package added under "dependencies"
// would quietly undo that.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("the published package", () => {
  it("declares no runtime dependencies of any kind", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
      expect(pkg[field], field).toBeUndefined();
    }
  });

  it("runs no script on install", () => {
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) expect(pkg.scripts?.[hook], hook).toBeUndefined();
  });

  it("ships only the build output", () => {
    expect(pkg.files).toEqual(["dist"]);
  });

  it("builds the list of bundled packages and their licences with the server", () => {
    expect(pkg.scripts["build:server"]).toContain("scripts/third-party.mjs");
  });
});
