// Headless-browser walk through one full session against a running server.
//   node scripts/verify-ui.mjs [baseUrl]
// Drives the real SPA: new session -> SetupRequest -> shop in the embedded
// catalog (iframe) -> cart returns over SSE -> OrderRequest -> PDF export.
// Fails on any console error, page error or Content-Security-Policy violation,
// so it doubles as the check that the app still runs under its own CSP.
//
// Needs a Chromium: `npx playwright-core install chromium`, or set
// CHROMIUM_PATH to an existing Chrome/Chromium binary.
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://localhost:8099";
const problems = [];
let failed = false;
const pass = (m) => console.log("PASS  " + m);
const fail = (m) => {
  console.log("FAIL  " + m);
  failed = true;
};
const step = async (label, fn) => {
  try {
    await fn();
    pass(label);
  } catch (e) {
    fail(`${label} — ${String(e.message).split("\n")[0]}`);
  }
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
// Report CSP violations through the console so they are collected with the rest.
await ctx.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) =>
    console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"}`),
  );
});
const watch = (p, name) => {
  p.on("console", (m) => {
    if (m.type() === "error") problems.push(`[${name}] ${m.text()}`);
  });
  p.on("pageerror", (e) => problems.push(`[${name}] pageerror: ${e.message}`));
};
const page = await ctx.newPage();
watch(page, "app");

try {
  // Not networkidle: the SSE live-log stream keeps a connection open forever.
  const res = await page.goto(BASE, { waitUntil: "domcontentloaded" });

  await step("app shell renders under a script-src 'self' policy", async () => {
    const csp = res.headers()["content-security-policy"] ?? "";
    if (!/script-src 'self'(;|$)/.test(csp)) throw new Error(`unexpected CSP: ${csp || "(none)"}`);
    await page.getByText("punchout-simulator").first().waitFor({ timeout: 10000 });
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    if (theme !== "dark" && theme !== "light") throw new Error("theme bootstrap did not run");
  });

  await step("start a session on the demo connection", async () => {
    await page.getByRole("button", { name: /New session/i }).first().click();
    await page.getByRole("button", { name: "Start session" }).click();
    await page.getByRole("button", { name: /Send SetupRequest/ }).waitFor({ timeout: 10000 });
  });

  await step("Monaco editor mounts with its worker", async () => {
    await page.getByText(/Edit cXML|Show cXML/).first().click();
    await page.locator(".monaco-editor .view-line").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);
    if (page.workers().length === 0) throw new Error("no editor worker started");
  });

  await step("send the SetupRequest", async () => {
    await page.getByRole("button", { name: /Send SetupRequest/ }).click();
    await page.getByText(/open embedded/i).first().waitFor({ timeout: 10000 });
  });

  await step("shop in the embedded catalog; the cart returns over SSE", async () => {
    await page.getByText(/open embedded/i).first().click();
    const frame = page.frameLocator("iframe.catalog-frame-body");
    await frame.locator('input[name="q_0"]').fill("2", { timeout: 10000 });
    await frame.getByRole("button", { name: /Return cart/ }).click();
    await page.getByRole("button", { name: /Build OrderRequest/ }).waitFor({ timeout: 15000 });
  });

  await step("build and send the OrderRequest", async () => {
    await page.getByRole("button", { name: /Build OrderRequest/ }).click();
    await page.getByRole("button", { name: /Send OrderRequest/ }).click();
    await page.getByText(/Order number SO-/).first().waitFor({ timeout: 10000 });
  });

  await step("PDF export opens a report and asks the browser to print it", async () => {
    const [report] = await Promise.all([
      ctx.waitForEvent("page"),
      page.getByTitle("Export this flow as a PDF (print)").first().click(),
    ]);
    watch(report, "pdf");
    // Stand in for the print dialog, which would block a headless run.
    await report.evaluate(() => {
      window.print = () => {
        document.title = "PRINT-CALLED";
      };
    });
    await report.waitForFunction(() => document.title === "PRINT-CALLED", null, { timeout: 5000 });
    if ((await report.locator("pre").count()) < 3) throw new Error("report is missing message bodies");
  });

  if (problems.length > 0) {
    fail(`console errors / CSP violations:\n      ${problems.join("\n      ")}`);
  } else {
    pass("no console errors or CSP violations");
  }
} finally {
  await browser.close();
}

if (failed) {
  console.log("\nUI VERIFY FAILED");
  process.exit(1);
}
console.log("\nUI VERIFY OK — a full session works in a real browser");
