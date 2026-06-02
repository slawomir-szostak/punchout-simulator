import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { nanoid } from "nanoid";
import { createApp } from "./app.js";
import { initConfig } from "./store/config.js";
import { setDataDir } from "./store/paths.js";
import { setRuntime, getPublicUrl } from "./runtime.js";
import { seedDemoIfEmpty } from "./seed.js";

// CLI entry (spec section 9): boot Hono, serve the built SPA, open the browser.
// Binds loopback by default; when exposed (non-loopback --public-url or --host),
// gates /api behind a token. Flags: --port, --data-dir, --public-url, --host,
// --token, --no-open, --dev, --no-seed.

interface Flags {
  port: number;
  dataDir: string;
  publicUrl?: string;
  host?: string;
  token?: string;
  open: boolean;
  dev: boolean;
  seed: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    port: Number(process.env.PORT ?? 8080),
    dataDir: process.env.DATA_DIR ?? "./data",
    host: process.env.HOST,
    token: process.env.POS_TOKEN,
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
      case "--host":
        flags.host = next();
        break;
      case "--token":
        flags.token = next();
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// package.json sits two levels above this file in BOTH src/server/ (dev, tsx) and
// dist/server/ (built), so the same relative resolve works in either case.
function readVersion(): string | undefined {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return undefined;
  }
}

function printHelp(): void {
  console.log(`punchout-simulator — test cXML PunchOut integrations as a virtual counterparty

Usage: punchout-simulator [options]

Options:
  -p, --port <n>         Port to listen on (default 8080)
  -d, --data-dir <path>  Where to store config + logs (default ./data)
      --public-url <url> Externally reachable base URL (default http://localhost:<port>)
                         Set this when fronting the tool with ngrok/cloudflared.
      --host <addr>      Bind address (default 127.0.0.1; use 0.0.0.0 for LAN)
      --token <secret>   Require this token on /api (auto-generated when exposed
                         and not provided; or set POS_TOKEN)
      --no-open          Do not open a browser on start
      --no-seed          Do not seed the built-in demo connections on first run
      --dev              Dev mode (do not serve SPA, do not open browser)
  -h, --help             Show this help
`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const publicUrl = flags.publicUrl ?? `http://localhost:${flags.port}`;
  const bindHost = flags.host ?? "127.0.0.1";

  // "Exposed" = reachable beyond this machine: either a non-loopback public URL
  // (ngrok/cloudflared front it) or a non-loopback bind address (LAN). When
  // exposed, require a token on /api so an open admin surface isn't published.
  const exposed = !LOOPBACK.has(hostnameOf(publicUrl)) || !LOOPBACK.has(bindHost);
  const token = flags.token || (exposed ? nanoid(24) : undefined);

  setDataDir(flags.dataDir);
  setRuntime({ port: flags.port, publicUrl, token, version: readVersion() });
  await initConfig();
  if (flags.seed) await seedDemoIfEmpty();

  const webRoot = flags.dev
    ? undefined
    : fileURLToPath(new URL("../web", import.meta.url));

  const app = createApp({ webRoot, quiet: false });

  serve({ fetch: app.fetch, port: flags.port, hostname: bindHost }, (info) => {
    const local = `http://${bindHost}:${info.port}`;
    console.log(`\n  punchout-simulator listening on ${local}`);
    if (getPublicUrl() !== local) console.log(`  public URL: ${getPublicUrl()}`);
    console.log(`  data dir:   ${flags.dataDir}`);
    console.log(`  callback:   ${getPublicUrl()}/punchout/return`);

    const openUrl = token ? `${getPublicUrl()}/?token=${token}` : local;
    if (token) {
      console.log(`\n  ⚠ EXPOSED: /api requires a token. Open the UI with the token:`);
      console.log(`     ${openUrl}`);
      console.log(`     (inbound /sim and /punchout stay open for buyer traffic)`);
    }
    console.log("");

    if (flags.open) {
      import("open")
        .then((m) => m.default(token ? `http://localhost:${info.port}/?token=${token}` : local))
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
