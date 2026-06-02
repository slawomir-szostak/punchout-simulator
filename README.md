# punchout-simulator

A developer tool for testing **cXML PunchOut** integrations by acting as a
**virtual counterparty**. It plays the missing side of the conversation, so you
can exercise a PunchOut integration end-to-end without finding a cooperative
real partner to send/receive test traffic.

It is role-neutral and runs in two modes (mirror images of each other):

- **Mode A — Virtual Buyer** *(primary)*: the tool acts as the procurement
  system. Point it at a supplier's catalog (often `localhost`/staging) to verify
  their PunchOut system without needing a real Ariba/Coupa tenant. Also lets a
  buyer-side developer test against real suppliers.
- **Mode B — Virtual Supplier / mock catalog**: the tool acts as the supplier —
  receiving a real buyer's requests, serving a mock catalog, returning a
  punchback and accepting an OrderRequest. Lets a buyer-side developer test their
  outbound generation without asking a vendor for a test catalog.

Protocol scope: **cXML only**.

---

## Quick start

```bash
npx punchout-simulator
```

That's it — no install, no build. It boots a local server, opens your browser,
and seeds a **built-in demo**: a virtual buyer wired to a built-in mock supplier,
so you can run the entire roundtrip immediately:

1. Open the **Demo Buyer → Demo Supplier** connection.
2. **Send SetupRequest** → the mock supplier replies with a StartPage.
3. **Open the catalog**, set quantities, **return the cart** — the punchback
   lands back in the app live.
4. **Build the OrderRequest**, edit the cXML if you want (tweak `<Comments>`,
   addresses, attachment refs), optionally attach files at the **order or item
   level**, optionally flip on the **dangling-`cid` test**, then **send it** and
   inspect the supplier's response.
5. If validation fails, **edit and re-send** — the flow session and cart persist.

Every document — inbound and outbound — is validated and logged.

### Other ways to run

```bash
npm i -g punchout-simulator && punchout-simulator   # persistent install
```

```bash
# Docker
docker run -p 8080:8080 -v "$PWD/data:/data" punchout-simulator
```

### CLI options

```
-p, --port <n>         Port to listen on (default 8080)
-d, --data-dir <path>  Where to store config + logs (default ./data)
    --public-url <url> Externally reachable base URL (default http://localhost:<port>)
                       Set this when fronting the tool with ngrok/cloudflared.
    --no-open          Do not open a browser on start
    --no-seed          Do not seed the built-in demo buyer/supplier/connection on first run
    --dev              Dev mode (do not serve the SPA, do not open a browser)
-h, --help             Show help
```

---

## What it checks (validation / linting)

Validation is a **first-class, bidirectional** feature — it runs on every
document in both directions, and results are surfaced per message in the UI
(errors, warnings and info). For a seller, the tool is as much a *"did my catalog
emit correct cXML?"* linter as a transport driver.

General checks: well-formedness, `payloadID`/`timestamp` presence, and
`From`/`To`/`Sender` credentials + `SharedSecret` consistency with the
connection's buyer/supplier identities.

Document-specific:

| Document | Checks |
|---|---|
| **PunchOutSetupResponse** | `Status` present & `200`; valid `StartPage/URL` |
| **PunchOutOrderMessage** (punchback) | `BuyerCookie` matches the session; header `Total`/`Money`+currency; each `ItemIn` has quantity, `SupplierPartID`, `UnitPrice`+currency, `Description`, `UnitOfMeasure`, `Classification`@domain; **Total consistency** (sum of line totals) |
| **OrderRequest** | `orderID`/`orderDate`/`Total`; `ShipTo`/`BillTo`; each `ItemOut`; **attachment `cid:` resolution** (see below) |
| **OrderResponse** | `Status` code present / not an error |

> Note: full cXML DTD validation would require a native validating XML parser,
> which would hurt `npx` portability. Instead the tool does well-formedness plus
> the thorough field-level rules above — the high-value half of the linter.

### The dangling-`cid` attachment test

`multipart/related` is the fiddly part of cXML order ingestion. The tool can send
an OrderRequest whose `<Attachment><URL>cid:XXX</URL></Attachment>` references a
`Content-ID` that is **deliberately absent** from the envelope, to verify the
receiver detects the missing attachment. `<Comments>` (and therefore
`<Attachment>`) is scanned at **both** levels: `OrderRequestHeader` and each
`ItemOut`.

### Editing the OrderRequest, attachments & retry

- The OrderRequest is built from the returned cart into an editable Monaco view.
  **Edit it before sending** — `<Comments>`, addresses, attachment references,
  anything; the exact document you see is what gets sent.
- **Attachments are scoped per item or per order**, so the `cid` reference lands
  in the right `ItemOut/Comments` or `OrderRequestHeader/Comments`.
- The flow is a **persistent per-connection session**: switching between the
  Flow and Settings tabs (or connections) keeps your in-progress order, and you
  can **edit and re-send** after a supplier rejection. "New session" starts a
  fresh `BuyerCookie`.

---

## Network reachability

- **Mode A rarely needs a tunnel.** The punchback is a browser auto-submit from
  *your own browser*, so it reaches the tool's `localhost` callback even when the
  supplier catalog is remote. SetupRequest/OrderRequest are server-to-server
  *outbound* from the tool.
- **Mode B may need the tool publicly reachable.** A real buyer system sends
  SetupRequest/OrderRequest *inbound* to the tool. If that system is remote, run
  behind ngrok/cloudflared and pass `--public-url <https://...>`.

---

## Architecture

A single npm package, full TypeScript, single origin (the SPA is served by the
backend, so there is no CORS between them).

| Layer | Choice |
|---|---|
| Backend | [Hono](https://hono.dev) + `@hono/node-server` (SSE live log, static SPA) |
| Frontend | React + Vite, [Monaco](https://microsoft.github.io/monaco-editor/) for cXML edit-before-send |
| Real-time | Server-Sent Events |
| XML parsing | `fast-xml-parser` |
| cXML building | template literals (full control over shape/ordering/`xml:lang`) |
| multipart/related | hand-assembled (`Buffer` + boundary) |
| Storage | `lowdb` (`config.json`) for buyers/suppliers/connections · append-only JSONL per session for logs · separate files for attachments |

```
src/
├─ web/      React + Vite SPA
└─ server/   Hono app, routes, cXML engine, storage, CLI
   └─ cxml/  build · parse · validate · multipart · types
```

### Data model

The config is normalized into three entities:

- **Buyer** — a reusable party holding its own cXML identity (the `From` credential).
- **Supplier** — a reusable party holding its cXML identity (`To`) plus its **endpoints** (PunchOut URL, Order URL) and an optional mock catalog. Endpoints are intrinsic to the supplier — defined once, not per relationship.
- **Connection** — the edge pairing one Buyer with one Supplier. It holds only what is specific to that pair: which side the tool simulates (`mode`), the `sharedSecret`, an optional per-pair Sender identity override (defaults to the buyer's identity), `authStyle`, and `deploymentMode`.

At send time: `From` = buyer identity, `To` = supplier identity, `Sender` = the connection's override (or the buyer), and the request targets the supplier's endpoints. The mock-supplier endpoints are keyed by supplier id (`/sim/<supplierId>/…`).

### Endpoints

- `*/api/buyers`, `*/api/suppliers` — CRUD for the reusable parties
- `*/api/connections` — CRUD for connection edges (reference a buyer + supplier)
- `GET /api/connections/:id/setup/preview` · `POST …/setup` — preview / send the SetupRequest
- `POST /api/connections/:id/order/preview` · `POST …/order` — preview / send the OrderRequest (multipart if attachments)
- `POST /punchout/return` — callback receiving the punchback auto-submit
- `GET /api/stream` — SSE live log
- `/sim/:supplierId/*` — Mode B mock supplier (punchout · catalog · checkout · order)

---

## Development

```bash
npm install
npm run dev        # Vite dev server + backend with proxy
npm run build      # vite build -> dist/web ; tsup -> dist/server
npm test           # vitest (unit + integration roundtrip)
npm run typecheck
node scripts/smoke.mjs       # full roundtrip over HTTP (server must be running)
node scripts/verify-ui.mjs   # headless-browser end-to-end (needs `npx playwright install chromium`)
```

---

## License

MIT © Slawomir Szostak
