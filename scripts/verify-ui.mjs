// Headless-browser verification of the full UI flow against a running server.
//   node scripts/verify-ui.mjs [baseUrl]
// Drives: select Demo Buyer -> send SetupRequest -> shop on the catalog ->
// cart returns via SSE -> send OrderRequest. Fails on console/page errors.
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:8099";
const errors = [];
const fail = (m) => {
  console.log("FAIL  " + m);
  process.exitCode = 1;
};
const pass = (m) => console.log("PASS  " + m);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

try {
  // Not networkidle: the SSE live-log stream keeps the connection open forever.
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // App shell renders
  await page.getByText("punchout-simulator").first().waitFor({ timeout: 10000 });
  pass("app shell rendered");

  // Select the demo buyer connection
  await page.getByText("Demo Buyer", { exact: false }).first().click();
  await page.getByRole("heading", { name: "SetupRequest" }).waitFor({ timeout: 10000 });
  pass("buyer flow opened");

  // Monaco mounted
  await page.locator(".monaco-editor").first().waitFor({ timeout: 15000 });
  pass("Monaco editor mounted");

  // Send SetupRequest
  await page.getByRole("button", { name: /Send SetupRequest/ }).click();
  const startLink = page.getByRole("link", { name: /open catalog/ });
  await startLink.waitFor({ timeout: 10000 });
  const startPage = await startLink.getAttribute("href");
  pass("SetupRequest sent, StartPage returned");

  // Validation panels appear (either an issue list or the "no issues" line)
  await page.locator(".validation-panel").first().waitFor({ timeout: 5000 });
  pass("validation panels shown");

  // Shop on the catalog in a second tab and return the cart
  const shop = await ctx.newPage();
  await shop.goto(startPage, { waitUntil: "load" });
  await shop.locator('input[name="q_0"]').fill("2");
  await shop.locator('input[name="q_1"]').fill("1");
  await shop.getByRole("button", { name: /Return cart/ }).click();
  await shop.getByText(/Cart returned/).waitFor({ timeout: 10000 });
  pass("catalog checkout + punchback auto-submit");

  // Cart appears in the app via SSE
  await page.locator(".cart-table tbody tr").first().waitFor({ timeout: 10000 });
  const rows = await page.locator(".cart-table tbody tr").count();
  rows === 2 ? pass("cart rendered live (2 items)") : fail(`cart rows = ${rows}`);

  // Session persists across Flow/Settings tab switches
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText(/Shared Secret/).first().waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Flow" }).click();
  const rowsAfter = await page.locator(".cart-table tbody tr").count();
  rowsAfter === 2 ? pass("session survives Flow/Settings switch (cart still there)") : fail(`cart lost on tab switch: ${rowsAfter}`);

  // Build the OrderRequest (editable), then send it
  await page.getByRole("button", { name: /Build OrderRequest/ }).click();
  await page.getByText(/This exact document is what gets sent/).waitFor({ timeout: 8000 });
  pass("OrderRequest built and editable before send");

  await page.getByRole("button", { name: /Send OrderRequest/ }).click();
  await page.getByText(/Status 200/).waitFor({ timeout: 10000 });
  pass("OrderRequest sent, supplier returned Status 200");

  // Retry path: the editor stays and the button becomes Re-send
  await page.getByRole("button", { name: /Re-send OrderRequest/ }).waitFor({ timeout: 5000 });
  pass("retry available (Re-send OrderRequest)");

  // Live log populated
  const logRows = await page.locator(".log-row").count();
  logRows >= 4 ? pass(`live log populated (${logRows} rows)`) : fail(`log rows = ${logRows}`);

  // Open a message detail modal
  await page.locator(".log-row").first().click();
  await page.locator(".modal").waitFor({ timeout: 5000 });
  pass("message detail modal opens");

  await page.screenshot({ path: "/tmp/pos-ui.png", fullPage: true });
  pass("screenshot saved to /tmp/pos-ui.png");
} catch (e) {
  fail("exception: " + (e instanceof Error ? e.message : String(e)));
}

if (errors.length) {
  const benign = errors.filter((e) => !/favicon|the server responded with a status of 404/i.test(e));
  if (benign.length) {
    console.log("\nConsole errors:");
    benign.forEach((e) => console.log("  - " + e));
    fail(`${benign.length} console error(s)`);
  }
}

await browser.close();
console.log(process.exitCode ? "\nUI VERIFY FAILED" : "\nUI VERIFY OK — full flow works in a real browser");
