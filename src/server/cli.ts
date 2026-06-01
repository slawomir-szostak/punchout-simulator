import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { initConfig } from "./store/config.js";
import { setDataDir } from "./store/paths.js";
import { setRuntime, getPublicUrl } from "./runtime.js";
import { seedDemoIfEmpty } from "./seed.js";

// CLI entry (spec section 9): boot Hono, serve the built SPA, open the browser.
// Flags: --port, --data-dir, --public-url, --no-open, --dev, --no-seed.

interface Flags {
  port: number;
  dataDir: string;
  publicUrl?: string;
  open: boolean;
  dev: boolean;
  seed: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    port: Number(process.env.PORT ?? 8080),
    dataDir: process.env.DATA_DIR ?? "./data",
    open: true,
    dev: false,
    seed: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--port":
      case "-p":
        flags.port = Number(next());
        break;
      case "--data-dir":
      case "-d":
        flags.dataDir = next();
        break;
      case "--public-url":
        flags.publicUrl = next();
        break;
      case "--no-open":
        flags.open = false;
        break;
      case "--dev":
        flags.dev = true;
        flags.open = false;
        break;
      case "--no-seed":
        flags.seed = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return flags;
}

function printHelp(): void {
  console.log(`punchout-simulator — test cXML PunchOut integrations as a virtual counterparty

Usage: punchout-simulator [options]

Options:
  -p, --port <n>         Port to listen on (default 8080)
  -d, --data-dir <path>  Where to store config + logs (default ./data)
      --public-url <url> Externally reachable base URL (default http://localhost:<port>)
                         Set this when fronting the tool with ngrok/cloudflared.
      --no-open          Do not open a browser on start
      --no-seed          Do not seed the built-in demo connections on first run
      --dev              Dev mode (do not serve SPA, do not open browser)
  -h, --help             Show this help
`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const publicUrl = flags.publicUrl ?? `http://localhost:${flags.port}`;

  setDataDir(flags.dataDir);
  setRuntime({ port: flags.port, publicUrl });
  await initConfig();
  if (flags.seed) await seedDemoIfEmpty();

  const webRoot = flags.dev
    ? undefined
    : fileURLToPath(new URL("../web", import.meta.url));

  const app = createApp({ webRoot, quiet: false });

  serve({ fetch: app.fetch, port: flags.port }, (info) => {
    const url = `http://localhost:${info.port}`;
    console.log(`\n  punchout-simulator listening on ${url}`);
    if (getPublicUrl() !== url) console.log(`  public URL: ${getPublicUrl()}`);
    console.log(`  data dir:   ${flags.dataDir}`);
    console.log(`  callback:   ${getPublicUrl()}/punchout/return\n`);

    if (flags.open) {
      import("open")
        .then((m) => m.default(url))
        .catch(() => {
          /* opening a browser is best-effort */
        });
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
