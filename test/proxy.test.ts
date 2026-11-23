import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { detectProxy, mergeNoProxy, redactProxyUrl, setupProxy } from "../src/server/proxy.js";

describe("mergeNoProxy", () => {
  it("always includes loopback hosts", () => {
    expect(mergeNoProxy(undefined)).toBe("localhost,127.0.0.1,::1");
  });
  it("preserves existing entries and appends loopback", () => {
    expect(mergeNoProxy("example.com, .internal")).toBe("example.com,.internal,localhost,127.0.0.1,::1");
  });
  it("does not duplicate loopback (case-insensitive)", () => {
    expect(mergeNoProxy("LOCALHOST,127.0.0.1")).toBe("LOCALHOST,127.0.0.1,::1");
  });
});

describe("redactProxyUrl", () => {
  it("strips embedded credentials", () => {
    expect(redactProxyUrl("http://user:pass@proxy.corp:8080")).toBe("http://proxy.corp:8080/");
  });
  it("leaves a credential-free URL intact", () => {
    expect(redactProxyUrl("http://proxy.corp:8080")).toBe("http://proxy.corp:8080");
  });
  it("returns non-URLs unchanged", () => {
    expect(redactProxyUrl("not a url")).toBe("not a url");
  });
});

describe("detectProxy", () => {
  it("is disabled with no proxy env", () => {
    const s = detectProxy({});
    expect(s.enabled).toBe(false);
    expect(s.noProxy).toContain("localhost");
  });
  it("reads HTTPS_PROXY and merges loopback into NO_PROXY", () => {
    const s = detectProxy({ HTTPS_PROXY: "http://proxy.corp:8080", NO_PROXY: "example.com" });
    expect(s.enabled).toBe(true);
    expect(s.httpsProxy).toBe("http://proxy.corp:8080");
    expect(s.noProxy).toBe("example.com,localhost,127.0.0.1,::1");
  });
  it("accepts lower-case variable names", () => {
    const s = detectProxy({ http_proxy: "http://p:3128" });
    expect(s.enabled).toBe(true);
    expect(s.httpProxy).toBe("http://p:3128");
  });
});

describe("setupProxy", () => {
  let saved: ReturnType<typeof getGlobalDispatcher>;
  beforeEach(() => { saved = getGlobalDispatcher(); });
  afterEach(() => { setGlobalDispatcher(saved); }); // don't leak a proxy dispatcher to other tests

  it("does nothing and returns null when no proxy is configured", () => {
    const logs: string[] = [];
    expect(setupProxy({}, (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(0);
  });

  it("installs the dispatcher, sets loopback NO_PROXY, and logs a redacted line", () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: "http://user:secret@proxy.corp:8080" };
    const logs: string[] = [];
    const s = setupProxy(env, (m) => logs.push(m));
    expect(s?.enabled).toBe(true);
    expect(env.NO_PROXY).toContain("localhost");
    expect(logs.join("\n")).toContain("proxy.corp:8080");
    expect(logs.join("\n")).not.toContain("secret"); // credentials redacted
  });
});

// The dispatcher setupProxy installs and the fetch sendCxml uses must be the
// same undici. With Node's built-in fetch they were only the same by accident
// of versions: on Node 26 the proxy was reported as in effect and then ignored.
describe("an outbound call really goes through the configured proxy", () => {
  it("asks the proxy for the supplier's host instead of resolving it itself", async () => {
    const { createServer } = await import("node:http");
    const { Agent } = await import("undici");
    const { sendCxml } = await import("../src/server/http.js");
    const asked: string[] = [];
    const proxy = createServer();
    // undici tunnels through a proxy with CONNECT, for http targets too.
    proxy.on("connect", (req, socket) => {
      asked.push(`${req.method} ${req.url}`);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const port = (proxy.address() as { port: number }).port;
    const env = process.env;
    const names = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
    const before = names.map((n) => [n, env[n]] as const);
    try {
      for (const n of names) delete env[n];
      env.HTTP_PROXY = `http://127.0.0.1:${port}`;
      setupProxy(env, () => {});
      // .invalid never resolves: only the proxy can have been asked for it.
      const res = await sendCxml("http://supplier.invalid/punchout", "<cXML/>");
      expect(asked).toEqual(["CONNECT supplier.invalid:80"]);
      expect(res.error ?? "").not.toContain("ENOTFOUND");
    } finally {
      for (const [n, v] of before) v == null ? delete env[n] : (env[n] = v);
      setGlobalDispatcher(new Agent());
      proxy.close();
    }
  });
});
