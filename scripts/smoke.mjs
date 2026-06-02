// End-to-end smoke test: drives the full Mode A roundtrip against the built-in
// mock supplier (demo-buyer -> demo-supplier loopback). Run with the server up:
//   node scripts/smoke.mjs [baseUrl]
const BASE = process.argv[2] ?? "http://localhost:8099";

const j = (r) => r.json();
const ok = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

async function main() {
  // 1. connections seeded
  const conns = await fetch(`${BASE}/api/connections`).then(j);
  ok("demo connection seeded", conns.length === 1);

  // 2. SetupRequest -> SetupResponse
  const setup = await fetch(`${BASE}/api/connections/demo/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then(j);
  ok("setup statusCode 200", setup.statusCode === "200");
  ok("setup request valid", setup.request.validation.ok);
  ok("setup response valid (no errors)", setup.response.validation.ok);
  ok("startPage present", !!setup.startPage);

  const cookie = setup.buyerCookie;
  const startPage = new URL(setup.startPage);
  const formpost = startPage.searchParams.get("formpost");

  // 3. Browse the catalog page
  const catalogHtml = await fetch(setup.startPage).then((r) => r.text());
  ok("catalog page served", catalogHtml.includes("mock catalog") || catalogHtml.includes("virtual supplier"));

  // 4. Checkout -> auto-submit punchback HTML
  const form = new URLSearchParams();
  form.set("cookie", cookie);
  form.set("formpost", formpost);
  form.set("bd","DUNS"); form.set("bi","123456789"); form.set("q_0", "2");
  form.set("q_1", "1");
  const checkoutHtml = await fetch(`${BASE}/sim/demo-supplier/checkout`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  }).then((r) => r.text());
  ok("checkout returns auto-submit form", checkoutHtml.includes("cxml-urlencoded"));

  // Extract the cXML the browser would auto-submit and POST it to the callback.
  const m = /name="cxml-urlencoded" value="([\s\S]*?)">/.exec(checkoutHtml);
  ok("punchback cXML extracted", !!m);
  const punchbackXml = decodeHtml(m[1]);

  const ret = await fetch(`${BASE}/punchout/return`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ "cxml-urlencoded": punchbackXml }).toString(),
  }).then((r) => r.text());
  ok("callback returns receipt page", ret.includes("Cart returned"));

  // 5. Fetch the parsed cart the SPA would show
  const cart = await fetch(`${BASE}/api/cart/${encodeURIComponent(cookie)}`).then(j);
  ok("cart has 2 line items", cart.items?.length === 2);
  ok("cart total computed", cart.total?.amount > 0);
  const expectedTotal = 12.5 * 2 + 34.0 * 1;
  ok(`cart total = ${expectedTotal}`, Math.abs((cart.total?.amount ?? 0) - expectedTotal) < 0.01);

  // 6. OrderRequest (no attachments) -> OrderResponse 200
  const order = await fetch(`${BASE}/api/connections/demo/order`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: cookie, items: cart.items, currency: cart.total.currency }),
  }).then(j);
  ok("order statusCode 200", order.statusCode === "200");
  ok("order request valid", order.request.validation.ok);
  ok("order response valid", order.response.validation.ok);

  // 7. OrderRequest WITH attachment (happy path) -> resolves cid
  const orderAtt = await fetch(`${BASE}/api/connections/demo/order`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: cookie,
      items: cart.items,
      currency: cart.total.currency,
      attachments: [
        { contentId: "spec-sheet", filename: "spec.txt", contentType: "text/plain", dataBase64: Buffer.from("hello attachment").toString("base64"), scope: "order" },
      ],
    }),
  }).then(j);
  ok("order+attachment request valid (cid resolves)", orderAtt.request.validation.ok);
  ok("order+attachment response 200", orderAtt.statusCode === "200");

  // 8. Dangling-cid test: receiver MUST detect the missing attachment
  const dangling = await fetch(`${BASE}/api/connections/demo/order`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: cookie,
      items: cart.items,
      currency: cart.total.currency,
      danglingCid: true,
      attachments: [
        { contentId: "spec-sheet", filename: "spec.txt", contentType: "text/plain", dataBase64: Buffer.from("hello attachment").toString("base64"), scope: "order" },
      ],
    }),
  }).then(j);
  const buyerDetected = dangling.request.validation.issues.some((i) => i.code === "dangling-cid");
  ok("dangling-cid detected on outbound build", buyerDetected);
  ok("supplier rejects dangling-cid order (status 400)", dangling.statusCode === "400");

  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK — full Mode A roundtrip works");
}

function decodeHtml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
