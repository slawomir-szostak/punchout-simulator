// Runtime configuration set once at boot by the CLI. The public URL is what the
// outside world (the user's browser, a remote buyer system in Mode B) uses to
// reach this tool — defaults to http://localhost:<port> but can be overridden
// with --public-url when fronting the tool with ngrok/cloudflared (spec
// sections 4 and 12).

import type { ProxyStatus } from "./proxy-detect.js";

interface Runtime {
  port: number;
  publicUrl: string;
  /** When set, /api/* requires this token (used when the tool is exposed). */
  token?: string;
  /** The package version of the running process (set by the CLI at boot). */
  version?: string;
  /** Outbound-proxy situation detected at boot (shown in the UI header). */
  proxy?: ProxyStatus;
}

const runtime: Runtime = {
  port: 8080,
  publicUrl: "http://localhost:8080",
};

export function setRuntime(r: Partial<Runtime>): void {
  Object.assign(runtime, r);
}

export function getPort(): number {
  return runtime.port;
}

/** The API token, or undefined when none is required (plain localhost runs). */
export function getToken(): string | undefined {
  return runtime.token;
}

/** The running package version, if the CLI provided it. */
export function getVersion(): string | undefined {
  return runtime.version;
}

/** The boot-time proxy detection result, if the CLI provided it. */
export function getProxyStatus(): ProxyStatus | undefined {
  return runtime.proxy;
}

export function getPublicUrl(): string {
  return runtime.publicUrl.replace(/\/$/, "");
}

/** The tool's own punchback callback URL (Mode A). */
export function browserFormPostUrl(): string {
  return `${getPublicUrl()}/punchout/return`;
}
