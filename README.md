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

> **New to PunchOut, or want the full picture?** Read the in-depth reports at
> [**slawomir-szostak.github.io/punchout-simulator**](https://slawomir-szostak.github.io/punchout-simulator/):
> the [PunchOut business primer](https://slawomir-szostak.github.io/punchout-simulator/punchout-business-primer_en.html),
> the [Architecture reference](https://slawomir-szostak.github.io/punchout-simulator/architecture_en.html),
> and the [Operations & usage guide](https://slawomir-szostak.github.io/punchout-simulator/operations-guide_en.html).
> (Markdown sources live in [`docs/`](docs/).)

---

## Quick start

```bash
npx punchout-simulator
```

That's it — no install, no build. It boots a local server, opens your browser,
and seeds a **built-in demo**: a virtual buyer wired to a built-in mock supplier,
so you can run the entire roundtrip immediately:

1. On the **Sessions** tab, click **+ New session**, pick the **Demo Buyer → Demo
   Supplier** connection and the **create** operation.
2. **Send SetupRequest** → the mock supplier replies with a StartPage.
3. **Open the catalog**, set quantities, **return the cart** — the punchback
   lands back in the app live.
4. **Build the OrderRequest**, edit the cXML if you want (tweak `<Comments>`,
   addresses, attachment refs), optionally attach files at the **order or item
   level**, optionally flip on the **dangling-`cid` test**, then **send it** and
   inspect the supplier's response. (A **Validate** button lints the cXML before
   you send.)
5. If validation fails, **edit and re-send** — the session keeps its log and cart.

Every document — inbound and outbound — is validated and logged.

### Other ways to run

```bash
npm i -g punchout-simulator && punchout-simulator   # persistent install
```

```bash
# Docker (binds 0.0.0.0 inside the container ⇒ counts as "exposed" ⇒ /api needs a
# token). Set your own, or read the auto-generated ?token= URL from the logs:
docker run -p 127.0.0.1:8080:8080 -e POS_TOKEN=mysecret -v "$PWD/data:/data" punchout-simulator
# then open http://localhost:8080/?token=mysecret
```

### CLI options

```
-p, --port <n>         Port to listen on (default 8080)
-d, --data-dir <path>  Where to store config + logs (default ./data)
    --public-url <url> Externally reachable base URL (default http://localhost:<port>)
                       Set this when fronting the tool with ngrok/cloudflared.
    --host <addr>      Bind address (default 127.0.0.1; use 0.0.0.0 to expose on the LAN)
    --token <secret>   Require this token on /api (auto-generated when exposed; or set POS_TOKEN)
    --no-open          Do not open a browser on start
    --no-seed          Do not seed the built-in demo buyer/supplier/connection on first run
    --dev              Dev mode (do not serve the SPA, do not open a browser)
-h, --help             Show help
```

### Exposure & the admin API

The control plane (`/api/*` — config CRUD, logs, the live stream) is **bound to
`127.0.0.1` by default** and is unauthenticated only for that loopback case. The
moment the tool is **exposed** — a non-loopback `--public-url` (ngrok/cloudflared)
or `--host 0.0.0.0` — it **requires a token** on `/api/*`: one is auto-generated
(or pass `--token`/`POS_TOKEN`) and printed as a `…/?token=…` URL to open the UI
with. The **inbound buyer surface stays open** (`/sim/*`, `/punchout/return`) so a
real buyer system can still reach Mode B. Shared secrets are **write-only** over
the API (masked on read) and **redacted from all logs**.

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
| **PunchOutOrderMessage** (punchback) | `BuyerCookie` matches the session; header `Total`/`Money`+currency; each `ItemIn` has quantity, `SupplierPartID`, `UnitPrice`+currency, `Description`, `UnitOfMeasure`, `Classification`@domain; **single currency** (mixed-currency is an error unless the supplier allows it); **Total consistency** (sum of line totals) |
| **OrderRequest** | `orderID`/`orderDate`/`Total`; `ShipTo`/`BillTo` present **and complete** (an `addressID` or a postal Street/City — an empty block is flagged); `Contact@role`; each `ItemOut`; **single currency** (as above); **attachment `cid:` resolution** (see below) |
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
- **Transfer encoding is a per-connection setting** (`attachmentEncoding`):
  `binary` writes the raw bytes into each MIME part (valid over HTTP and more
  compact), while `base64` is the `Content-Transfer-Encoding` most real
  Ariba/Coupa receivers expect. Switch it in the connection editor to exercise
  either ingestion path; the built-in mock supplier (Mode B) decodes whichever
  it receives. Defaults to `binary`.
- The flow is a **persistent per-connection session**: switching between the
  Flow and Settings tabs (or connections) keeps your in-progress order, and you
  can **edit and re-send** after a supplier rejection. "New session" starts a
  fresh `BuyerCookie`.
- Every logged message has a **cXML / Raw toggle**. "Raw" shows the full wire
  message — headers plus, for an order with attachments, the reassembled
  `multipart/related` envelope (boundaries, part headers, `Content-ID`, the cXML
  and each attachment part) — with a one-click **Copy**. The raw body is
  reconstructed on demand from the document + the attachments on disk, so the
  log stays free of inlined base64.

---

## Sessions

A **session** is one PunchOut conversation, keyed by its `BuyerCookie`:
SetupRequest → catalog → cart → OrderRequest → OrderResponse. The **Sessions** tab
(under **Run**, separate from the **Configure** sections) is the workspace:

- A live **session list** — Mode-A sessions you start *and* Mode-B sessions an
  external buyer initiates against the tool's endpoints (those show as **inbound**).
- A per-session **message log** (each session keeps its own; no global firehose).
- **+ New session** picks a connection and the SetupRequest **operation**:
  - **create** — a fresh, empty cart (the default).
  - **edit** — reopen a previous session's returned cart for modification; its
    items are sent as `ItemOut` inside the SetupRequest (`operation="edit"`).
  - **inspect** — view a previously ordered item read-only (`operation="inspect"`),
    carrying that item (or the whole source cart) as `ItemOut`.

The built-in **mock supplier honours these on the receiving side too**: an
`edit` pre-fills the catalog quantities from the carried `ItemOut` (items it
doesn't list appear as extra "from cart" rows), and an `inspect` shows the
item(s) read-only and returns them unchanged — so the full round-trip is
exercisable end-to-end against the built-in mock.

Connections/Buyers/Suppliers/Products/Profiles remain under **Configure** — you set
them up there, then run them from **Sessions**.

---

## Network reachability

- **Mode A rarely needs a tunnel.** The punchback is a browser auto-submit from
  *your own browser*, so it reaches the tool's `localhost` callback even when the
  supplier catalog is remote. SetupRequest/OrderRequest are server-to-server
  *outbound* from the tool.
- **Mode B may need the tool publicly reachable.** A real buyer system sends
  SetupRequest/OrderRequest *inbound* to the tool. If that system is remote, run
  behind ngrok/cloudflared and pass `--public-url <https://...>`.
- **Behind a corporate proxy?** Node's `fetch` ignores the system proxy by
  default, so on a locked-down network an outbound SetupRequest/OrderRequest can
  hang until it times out and shows **`HTTP 0` / "operation was aborted"** even
  though the endpoint works in Postman. The tool honours the standard
  `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` environment variables — set them and
  it routes outbound cXML through the proxy (loopback/`localhost` always bypasses
  it, so the built-in mock still works). Works on Windows and Linux:

  ```bash
  # Linux/macOS
  HTTPS_PROXY=http://proxy.corp:8080 npx punchout-simulator
  ```
  ```powershell
  # Windows PowerShell
  $env:HTTPS_PROXY="http://proxy.corp:8080"; npx punchout-simulator
  ```

  > Note: a Windows *system* proxy (set in Windows/Edge settings, or via a PAC
  > file) is not an environment variable — set `HTTPS_PROXY` explicitly to the
  > proxy URL your IT uses.

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
| Storage | `lowdb` (`config.json`) for buyers/suppliers/connections/product-lists/profiles · append-only JSONL per session for logs · separate files for attachments |

```
src/
├─ web/      React + Vite SPA
└─ server/   Hono app, routes, cXML engine, storage, CLI
   └─ cxml/  build · parse · validate · multipart · types
```

For a deeper treatment — component breakdown, the full data model, and Mode A /
Mode B sequence diagrams — see the
[**Architecture reference**](https://slawomir-szostak.github.io/punchout-simulator/architecture_en.html).
Alongside it: a [**PunchOut business primer**](https://slawomir-szostak.github.io/punchout-simulator/punchout-business-primer_en.html)
(the business process and where this tool fits) and an
[**Operations & usage guide**](https://slawomir-szostak.github.io/punchout-simulator/operations-guide_en.html)
(sessions, operations, profiles, product lists, validation). These render at
[slawomir-szostak.github.io/punchout-simulator](https://slawomir-szostak.github.io/punchout-simulator/);
their canonical Markdown sources live in [`docs/`](docs/).

### Data model

The config is normalized into five entities:

- **Buyer** — a reusable party holding its own cXML identity (the `From` credential), an optional **platform profile** reference (see below), and optional default **ShipTo / BillTo addresses** and an end-user **Contact** (see below).
- **Supplier** — a reusable party holding its cXML identity (`To`) plus its **endpoints** (PunchOut URL, Order URL) and the **product lists** it serves as its Mode-B catalog. Endpoints are intrinsic to the supplier — defined once, not per relationship. An optional `allowMixedCurrency` flag relaxes the multi-currency check for this supplier (see below).
- **Connection** — the edge pairing one Buyer with one Supplier. It holds only what is specific to that pair: which side the tool simulates (`mode`), the `sharedSecret`, an optional per-pair Sender identity override (defaults to the buyer's identity), `deploymentMode`, and `attachmentEncoding`.
- **Product List** — a reusable, named set of catalog products. Assigned to one or more Suppliers; each supplier serves the **union** of its lists as its mock catalog. See below.
- **Profile** — a reusable **procurement-platform profile** (Ariba/Coupa/Jaggaer/…) referenced by a Buyer. See below.

At send time: `From` = buyer identity, `To` = supplier identity, `Sender` = the connection's override (or the buyer), and the request targets the supplier's endpoints. The mock-supplier endpoints are keyed by supplier id (`/sim/<supplierId>/…`).

### Product lists (Mode-B catalogs)

A **Product List** is a named set of catalog items, edited on its own and assigned to one or
more Suppliers from the **Products** tab. In Mode B a supplier serves the union of its assigned
lists; a supplier with no lists falls back to a small built-in demo catalog. A built-in
**Sample assortment** (~20 office/industrial items) ships out of the box and can be **loaded
into the editor** as a starting point. You can also **import a CSV** (a header row, any column
order; `SupplierPartID` required) to bulk-load a real catalog — a template is downloadable from
the editor. Recognized columns: `SupplierPartID`, `SupplierPartAuxiliaryID`, `Description`,
`UnitPrice`, `Currency`, `UoM`, `UNSPSC` (or a `Classifications` column as
`UNSPSC:31161500;eCl@ss:27-06`), `ManufacturerPartID`, `ManufacturerName`, `AllowFractional`.

Each product carries a `SupplierPartID`, an optional `SupplierPartAuxiliaryID`, description, unit
price + currency, unit of measure, manufacturer info, and **one or more `Classification`** entries
(each with its own `domain`, e.g. `UNSPSC` plus a supplier scheme like `eCl@ss`). A product may opt
into **fractional order quantities** (e.g. `1.5` m of cable) via its `allowFractional` flag — the
Mode-B catalog then accepts decimals for that item; all other items stay whole-number. These fields
flow through to the punchback (`ItemIn`) and the resulting OrderRequest (`ItemOut`).

**Currency.** A cXML `Total` is a single `Money`, so a document is expected to be single-currency.
If a cart/order spans more than one currency the mock supplier emits `Total` `0` (rather than a
meaningless cross-currency sum) and validation raises a `mixed-currency` **error**. A supplier that
genuinely handles multi-currency orders can set **`allowMixedCurrency`**, which downgrades that to a
non-blocking **warning** (the per-line `Money` currencies are always preserved either way).

### Addresses & contact

A **Buyer** holds default **ShipTo** / **BillTo** addresses and an end-user **Contact** (name, email,
phone). They pre-fill the OrderRequest (which stays fully editable as cXML before sending) and, when the
buyer's profile enables it, are also carried in the **PunchOutSetupRequest** (Ariba-style). Each address
supports a postal block and/or an `addressID` (+ `addressIDDomain`) reference; the **profile's
`addressMode`** decides which is emitted (`full` / `id-only` / `both`) — matching how platforms differ
(Jaggaer/Workday send full postal, SAP is plant-code/`addressID`-centric, Ariba sends both and includes
ShipTo in setup). An emitted `ShipTo`/`BillTo` with neither an `addressID` nor a Street/City is flagged.

### Simulating different procurement platforms (Buyer profiles)

Real procurement systems emit cXML differently. A **Profile** captures a platform's
emission behavior and is assigned to a Buyer, so you can drive a supplier as if it were
Ariba, Coupa, Jaggaer, Oracle, SAP, or Workday:

| Profile field | Effect on the documents the buyer emits |
|---|---|
| `dtdVersions` | The `<!DOCTYPE … cXML/<version>/cXML.dtd>` **per document type** (e.g. Coupa: SetupRequest `1.2.014`, PunchOutOrderMessage `1.2.023`). |
| `userAgent` | The `<UserAgent>` in the Sender. |
| `setupOperation` | `PunchOutSetupRequest@operation` (`create`/`edit`/`inspect`). |
| `attachmentEncoding` | Default `Content-Transfer-Encoding` for OrderRequest attachments (`binary`/`base64`). |
| `cartReturnTransport` | How the punchback is returned in Mode B: `cxml-urlencoded`, `cxml-base64`, or `raw`. |
| `extrinsics` | `<Extrinsic>` templates injected into the setup/order documents (values may use `${buyerCookie}` / `${orderId}`). |
| `addressMode` | How `ShipTo`/`BillTo`/`Contact` are emitted: `full` (PostalAddress), `id-only` (just `addressID`), or `both`. |
| `shipToInSetup` / `contactInSetup` | Carry the buyer's `ShipTo` / `Contact` already in the **PunchOutSetupRequest** (Ariba-style), so the supplier can price/personalize per ship-to. |

Built-in presets (Ariba, Coupa, Jaggaer, Oracle, SAP, Workday, Generic) ship out of the box
and can be **loaded into the editor** as a starting point, then customized. A Profile holds
the *defaults*; a Connection's own `attachmentEncoding` overrides it per pair. A Buyer with no
profile uses the **Generic** defaults (`1.2.045` / `punchout-simulator` / binary /
cxml-urlencoded) — i.e. the tool's original behavior.

> Authentication is **SharedSecret** only. (MAC / `CredentialMac` — used by network-routed
> Ariba/SAP flows — is intentionally out of scope for now.)
>
> SAP SRM in reality speaks **OCI** (form parameters), which this cXML-only tool cannot emit;
> the SAP profile models the cXML/Business-Network side (base64 attachments + cart return).

### Endpoints

- `*/api/buyers`, `*/api/suppliers` — CRUD for the reusable parties
- `*/api/profiles` — CRUD for procurement-platform profiles · `GET /api/profile-presets` — the built-in preset library
- `*/api/product-lists` — CRUD for product lists · `GET /api/product-list-presets` — the built-in sample library
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
