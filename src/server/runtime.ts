// Runtime configuration set once at boot by the CLI. The public URL is what the
// outside world (the user's browser, a remote buyer system in Mode B) uses to
// reach this tool — defaults to http://localhost:<port> but can be overridden
// with --public-url when fronting the tool with ngrok/cloudflared (spec
// sections 4 and 12).

interface Runtime {
  port: number;
  publicUrl: string;
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

export function getPublicUrl(): string {
  return runtime.publicUrl.replace(/\/$/, "");
}

/** The tool's own punchback callback URL (Mode A). */
export function browserFormPostUrl(): string {
  return `${getPublicUrl()}/punchout/return`;
}
