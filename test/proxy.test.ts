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
