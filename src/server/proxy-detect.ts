import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactProxyUrl, type ProxySettings } from "./proxy.js";

// Comprehensive startup proxy detection. setupProxy() wires the env vars —
// the only thing Node's fetch can actually honour — but on corporate machines
// the proxy usually lives in the OS settings (Windows registry / macOS network
// settings / GNOME / KDE), often as a PAC script, and the env vars are empty.
// Then outbound cXML silently black-holes while every browser works, which is
// maddening to diagnose. So at boot we also read the OS-level configuration and
// tell the user what we found: either "none anywhere, connecting directly" or
// "your system HAS a proxy that this tool will NOT use — set HTTPS_PROXY=…".
// Detection is best-effort and read-only; any failure degrades to "not detected".

export interface SystemProxyInfo {
  /** Human-readable origin of the setting, e.g. "Windows registry". */
  source: string;
  /** Manual proxy ("host:port" or a per-protocol list), when enabled. */
  server?: string;
  /** PAC auto-config script URL, when configured. */
  pacUrl?: string;
  /** OS-level "automatically detect settings" (WPAD), when on. */
  autoDetect?: boolean;
}

const hasAnything = (i: SystemProxyInfo): boolean => !!(i.server || i.pacUrl || i.autoDetect);

// --- Per-platform parsers (pure — unit-tested on captured fixtures) -----------

/** Parse `reg query "HKCU\...\Internet Settings"` output. */
export function parseWindowsRegistry(output: string): SystemProxyInfo | null {
  const value = (name: string): string | undefined =>
    new RegExp(`^\\s*${name}\\s+REG_(?:SZ|DWORD)\\s+(.+?)\\s*$`, "mi").exec(output)?.[1];
  const enabled = /0x1$/i.test(value("ProxyEnable") ?? "");
  const info: SystemProxyInfo = {
    source: "Windows registry (Internet Settings)",
    server: enabled ? value("ProxyServer") : undefined,
    pacUrl: value("AutoConfigURL"),
    autoDetect: /0x1$/i.test(value("AutoDetect") ?? "") || undefined,
  };
  return hasAnything(info) ? info : null;
}

/** Parse `scutil --proxy` output (macOS). */
export function parseScutil(output: string): SystemProxyInfo | null {
  const value = (key: string): string | undefined =>
    new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m").exec(output)?.[1];
  const hostPort = (proto: "HTTP" | "HTTPS"): string | undefined => {
    if (value(`${proto}Enable`) !== "1") return undefined;
    const host = value(`${proto}Proxy`);
    if (!host) return undefined;
    const port = value(`${proto}Port`);
    return port ? `${host}:${port}` : host;
  };
  const info: SystemProxyInfo = {
    source: "macOS network settings",
    server: hostPort("HTTPS") ?? hostPort("HTTP"),
    pacUrl: value("ProxyAutoConfigEnable") === "1" ? value("ProxyAutoConfigURLString") : undefined,
    autoDetect: value("ProxyAutoDiscoveryEnable") === "1" || undefined,
  };
  return hasAnything(info) ? info : null;
}

/** Assemble GNOME proxy info from `gsettings get org.gnome.system.proxy …` reads. */
export function parseGnome(get: (schema: string, key: string) => string | null): SystemProxyInfo | null {
  const unquote = (v: string | null): string => (v ?? "").trim().replace(/^'(.*)'$/, "$1");
  const mode = unquote(get("org.gnome.system.proxy", "mode"));
  if (mode === "auto") {
    const pac = unquote(get("org.gnome.system.proxy", "autoconfig-url"));
    return { source: "GNOME settings", pacUrl: pac || undefined, autoDetect: !pac || undefined };
  }
  if (mode !== "manual") return null;
  const hostPort = (schema: string): string | undefined => {
    const host = unquote(get(schema, "host"));
    if (!host) return undefined;
    const port = unquote(get(schema, "port"));
    return port && port !== "0" ? `${host}:${port}` : host;
  };
  const server = hostPort("org.gnome.system.proxy.https") ?? hostPort("org.gnome.system.proxy.http");
  return server ? { source: "GNOME settings", server } : null;
}

/** Parse KDE's ~/.config/kioslaverc ([Proxy Settings] section). */
export function parseKioslaverc(content: string): SystemProxyInfo | null {
  const section = /\[Proxy Settings\]([\s\S]*?)(?:\n\[|$)/.exec(content)?.[1];
  if (!section) return null;
  const value = (key: string): string | undefined =>
    new RegExp(`^${key}=(.*)$`, "m").exec(section)?.[1].trim() || undefined;
  const type = value("ProxyType") ?? "0"; // 0 none, 1 manual, 2 PAC, 3 WPAD, 4 env vars
  const source = "KDE settings (kioslaverc)";
  if (type === "1") {
    // KDE stores "host port" (space) or a URL per protocol.
    const raw = value("httpsProxy") ?? value("httpProxy");
    return raw ? { source, server: raw.replace(/\s+/, ":") } : null;
  }
  if (type === "2") return { source, pacUrl: value("Proxy Config Script") };
  if (type === "3") return { source, autoDetect: true };
  return null;
}

// --- Orchestration -------------------------------------------------------------

type Run = (cmd: string, args: string[]) => string | null;

const defaultRun: Run = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 2000, windowsHide: true });
    return r.status === 0 && r.stdout ? r.stdout : null;
  } catch {
    return null;
  }
};

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Read the OS-level proxy configuration for the current platform. Best-effort:
 *  returns null when nothing is configured or nothing could be read. */
export function detectSystemProxy(
  platform: NodeJS.Platform = process.platform,
  run: Run = defaultRun,
  readFile: (path: string) => string | null = defaultReadFile,
): SystemProxyInfo | null {
  if (platform === "win32") {
    const out = run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]);
    return out ? parseWindowsRegistry(out) : null;
  }
  if (platform === "darwin") {
    const out = run("scutil", ["--proxy"]);
    return out ? parseScutil(out) : null;
  }
  if (platform === "linux") {
    const gnome = parseGnome((schema, key) => run("gsettings", ["get", schema, key]));
    if (gnome) return gnome;
    return parseKioslaverc(readFile(join(homedir(), ".config", "kioslaverc")) ?? "");
  }
  return null;
}

// --- Banner ----------------------------------------------------------------------

/** Turn a system manual-proxy value into a concrete HTTPS_PROXY suggestion.
 *  Handles Windows' per-protocol "https=h:p;http=h:p" lists. */
export function suggestEnvValue(server: string): string {
  let pick = server;
  if (server.includes("=")) {
    const entries = new Map(
      server
        .split(";")
        .map((e) => e.split("=", 2))
        .filter((p): p is [string, string] => p.length === 2)
        .map(([k, v]) => [k.trim().toLowerCase(), v.trim()]),
    );
    pick = entries.get("https") ?? entries.get("http") ?? server;
  }
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(pick) ? pick : `http://${pick}`;
}

/**
 * The `proxy:` banner lines: what is in effect, what was merely detected, and —
 * when they disagree — how to fix it. `env` is setupProxy()'s result (null when
 * no proxy env vars were present).
 */
export function proxyBannerLines(env: ProxySettings | null, system: SystemProxyInfo | null): string[] {
  if (env?.enabled) {
    const via = redactProxyUrl(env.httpsProxy ?? env.httpProxy ?? "");
    return [`  proxy:      outbound cXML via ${via} (NO_PROXY=${env.noProxy})`];
  }
  if (!system) {
    return [`  proxy:      none — no HTTP(S)_PROXY env vars, no system proxy detected; outbound cXML connects directly`];
  }
  const lines = [`  ⚠ proxy:    no HTTP(S)_PROXY env vars, but ${system.source} has a proxy configured:`];
  if (system.server) lines.push(`                manual proxy:  ${redactProxyUrl(system.server)}`);
  if (system.pacUrl) lines.push(`                PAC script:    ${system.pacUrl}`);
  if (system.autoDetect) lines.push(`                auto-detect (WPAD): on`);
  lines.push(`              outbound cXML only honours the env vars — it will NOT use the proxy above.`);
  if (system.server) {
    lines.push(`              To route through it, restart with: HTTPS_PROXY=${suggestEnvValue(system.server)}`);
  } else {
    lines.push(`              The concrete proxy host hides inside the PAC/WPAD config — open the PAC URL`);
    lines.push(`              (or ask IT) and set HTTPS_PROXY=http://<host>:<port> accordingly.`);
  }
  return lines;
}
