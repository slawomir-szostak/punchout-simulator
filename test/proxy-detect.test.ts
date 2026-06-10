import { describe, expect, it } from "vitest";
import {
  detectSystemProxy,
  parseGnome,
  parseKioslaverc,
  parseScutil,
  parseWindowsRegistry,
  proxyBannerLines,
  proxyStatus,
  suggestEnvValue,
} from "../src/server/proxy-detect.js";
import { detectProxy } from "../src/server/proxy.js";

// Fixtures mirror real command output / file shapes per platform.

const REG_MANUAL = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    MigrateProxy    REG_DWORD    0x1
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    proxy.corp.example:8080
    AutoDetect    REG_DWORD    0x0
`;

const REG_PAC = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable    REG_DWORD    0x0
    AutoConfigURL    REG_SZ    http://wpad.corp.example/wpad.dat
    AutoDetect    REG_DWORD    0x1
`;

const REG_NONE = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    old-proxy:3128
`;

describe("parseWindowsRegistry", () => {
  it("reads an enabled manual proxy", () => {
    const i = parseWindowsRegistry(REG_MANUAL)!;
    expect(i.server).toBe("proxy.corp.example:8080");
    expect(i.pacUrl).toBeUndefined();
    expect(i.autoDetect).toBeUndefined();
  });
  it("reads PAC + WPAD with manual proxy disabled", () => {
    const i = parseWindowsRegistry(REG_PAC)!;
    expect(i.server).toBeUndefined();
    expect(i.pacUrl).toBe("http://wpad.corp.example/wpad.dat");
    expect(i.autoDetect).toBe(true);
  });
  it("ignores a leftover ProxyServer when ProxyEnable is 0", () => {
    expect(parseWindowsRegistry(REG_NONE)).toBeNull();
  });
});

const SCUTIL_MANUAL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 3128
  HTTPProxy : proxy.mac.example
  HTTPSEnable : 1
  HTTPSPort : 3129
  HTTPSProxy : sproxy.mac.example
}`;

const SCUTIL_PAC = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://pac.mac.example/proxy.pac
  ProxyAutoDiscoveryEnable : 1
}`;

describe("parseScutil", () => {
  it("prefers the HTTPS proxy and joins host:port", () => {
    expect(parseScutil(SCUTIL_MANUAL)!.server).toBe("sproxy.mac.example:3129");
  });
  it("reads PAC + auto-discovery", () => {
    const i = parseScutil(SCUTIL_PAC)!;
    expect(i.pacUrl).toBe("http://pac.mac.example/proxy.pac");
    expect(i.autoDetect).toBe(true);
  });
  it("returns null when everything is off", () => {
    expect(parseScutil("<dictionary> {\n  HTTPEnable : 0\n}")).toBeNull();
  });
});

describe("parseGnome", () => {
  const gs = (vals: Record<string, string>) => (schema: string, key: string) => vals[`${schema} ${key}`] ?? null;
  it("manual mode reads https host/port with http fallback", () => {
    const i = parseGnome(
      gs({
        "org.gnome.system.proxy mode": "'manual'",
        "org.gnome.system.proxy.https host": "''",
        "org.gnome.system.proxy.https port": "0",
        "org.gnome.system.proxy.http host": "'proxy.gnome.example'",
        "org.gnome.system.proxy.http port": "3128",
      }),
    )!;
    expect(i.server).toBe("proxy.gnome.example:3128");
  });
  it("auto mode reports the PAC url", () => {
    const i = parseGnome(
      gs({
        "org.gnome.system.proxy mode": "'auto'",
        "org.gnome.system.proxy autoconfig-url": "'http://pac.gnome.example/p.pac'",
      }),
    )!;
    expect(i.pacUrl).toBe("http://pac.gnome.example/p.pac");
  });
  it("none mode → null; gsettings missing → null", () => {
    expect(parseGnome(gs({ "org.gnome.system.proxy mode": "'none'" }))).toBeNull();
    expect(parseGnome(() => null)).toBeNull();
  });
});

describe("parseKioslaverc", () => {
  it("manual proxy (KDE 'host port' form)", () => {
    const i = parseKioslaverc(`[General]\nfoo=1\n[Proxy Settings]\nProxyType=1\nhttpsProxy=proxy.kde.example 8080\n`)!;
    expect(i.server).toBe("proxy.kde.example:8080");
  });
  it("PAC script and WPAD types", () => {
    expect(parseKioslaverc(`[Proxy Settings]\nProxyType=2\nProxy Config Script=http://pac.kde.example/p.pac\n`)!.pacUrl)
      .toBe("http://pac.kde.example/p.pac");
    expect(parseKioslaverc(`[Proxy Settings]\nProxyType=3\n`)!.autoDetect).toBe(true);
  });
  it("type 0 (none) and missing section → null", () => {
    expect(parseKioslaverc(`[Proxy Settings]\nProxyType=0\nhttpsProxy=stale 1\n`)).toBeNull();
    expect(parseKioslaverc("")).toBeNull();
  });
});

describe("detectSystemProxy orchestration", () => {
  it("win32 → reg query, parsed", () => {
    const i = detectSystemProxy("win32", (cmd) => (cmd === "reg" ? REG_MANUAL : null))!;
    expect(i.server).toBe("proxy.corp.example:8080");
  });
  it("linux falls back from gsettings to kioslaverc", () => {
    const i = detectSystemProxy(
      "linux",
      () => null, // no gsettings
      () => `[Proxy Settings]\nProxyType=1\nhttpsProxy=proxy.kde.example 8080\n`,
    )!;
    expect(i.server).toBe("proxy.kde.example:8080");
  });
  it("command failure → null (never throws)", () => {
    expect(detectSystemProxy("darwin", () => null)).toBeNull();
  });
});

describe("suggestEnvValue", () => {
  it("prefixes a bare host:port with http://", () => {
    expect(suggestEnvValue("proxy:8080")).toBe("http://proxy:8080");
  });
  it("picks the https entry from a per-protocol Windows list", () => {
    expect(suggestEnvValue("http=h1:80;https=h2:443;ftp=h3:21")).toBe("http://h2:443");
  });
  it("keeps an explicit scheme", () => {
    expect(suggestEnvValue("socks5://p:1080")).toBe("socks5://p:1080");
  });
});

describe("proxyStatus (served over /api/runtime)", () => {
  it("env mode carries the redacted via + NO_PROXY", () => {
    const s = proxyStatus(detectProxy({ HTTPS_PROXY: "http://u:pw@proxy.corp:8080" }), null);
    expect(s.mode).toBe("env");
    expect(s.via).toContain("proxy.corp:8080");
    expect(s.via).not.toContain("pw");
    expect(s.noProxy).toContain("localhost");
  });
  it("nothing anywhere → mode none", () => {
    expect(proxyStatus(null, null)).toEqual({ mode: "none" });
  });
  it("system-ignored carries source, redacted server, and a ready suggestion", () => {
    const s = proxyStatus(null, { source: "Windows registry (Internet Settings)", server: "https=h2:443;http=h1:80" });
    expect(s.mode).toBe("system-ignored");
    expect(s.suggestion).toBe("http://h2:443");
  });
  it("PAC-only system proxy has no suggestion", () => {
    const s = proxyStatus(null, { source: "GNOME settings", pacUrl: "http://pac/x.pac" });
    expect(s.pacUrl).toBe("http://pac/x.pac");
    expect(s.suggestion).toBeUndefined();
  });
});

describe("proxyBannerLines", () => {
  it("env proxy in effect → single redacted 'via' line", () => {
    const env = detectProxy({ HTTPS_PROXY: "http://user:secret@proxy.corp:8080" });
    const lines = proxyBannerLines(env, null);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("proxy.corp:8080");
    expect(lines[0]).not.toContain("secret");
  });
  it("nothing anywhere → explicit 'none' line", () => {
    const lines = proxyBannerLines(null, null);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/none — no HTTP\(S\)_PROXY env vars, no system proxy detected/);
  });
  it("system proxy without env vars → warning + concrete HTTPS_PROXY suggestion", () => {
    const lines = proxyBannerLines(null, { source: "Windows registry (Internet Settings)", server: "proxy.corp:8080" });
    const text = lines.join("\n");
    expect(text).toContain("⚠");
    expect(text).toContain("manual proxy:  proxy.corp:8080");
    expect(text).toContain("will NOT use");
    expect(text).toContain("HTTPS_PROXY=http://proxy.corp:8080");
  });
  it("PAC-only system proxy → points at the PAC instead of suggesting a value", () => {
    const text = proxyBannerLines(null, { source: "GNOME settings", pacUrl: "http://pac/x.pac" }).join("\n");
    expect(text).toContain("PAC script:    http://pac/x.pac");
    expect(text).toContain("hides inside the PAC/WPAD config");
    expect(text).not.toContain("restart with");
  });
});
