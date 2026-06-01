# punchout-simulator — Project Decisions & Starter Specification

> Handoff document for Claude Code. Captures every decision made while designing
> the tool, so implementation can start without re-deriving the rationale.
>
> Note on terminology: the product is **`punchout-simulator`**. The word
> *"punchback"* in this document refers to the cXML cart-return step
> (`PunchOutOrderMessage`), a protocol term — not the product.

---

## 1. What punchout-simulator is

A developer tool for testing **cXML PunchOut** integrations by acting as a
**virtual counterparty**. It plays the missing side of the conversation so you
can exercise a PunchOut integration end-to-end without finding a cooperative
real partner to send/receive test traffic.

It is **role-neutral and runs in two modes** (mirror images of each other):

- **Mode A — Virtual Buyer** *(primary, phase 1)*: the tool acts as the
  procurement system. A **supplier/seller** points it at their own catalog
  (often `localhost`/staging) to verify their PunchOut system without needing a
  real Ariba/Coupa tenant to send requests at them. The same mode also lets a
  buyer-side developer test against real suppliers.
- **Mode B — Virtual Supplier / mock catalog** *(phase 2)*: the tool acts as the
  supplier, receiving a real buyer system's requests, serving a mock catalog,
  and returning a punchback + accepting an OrderRequest. This lets a buyer-side
  developer test their own outbound generation without asking a vendor for a
  test catalog.

The two modes are deliberately symmetric: each supplies the counterparty the
other side normally lacks. The mock-supplier half (Mode B) was already proven as
a concept in an earlier throwaway harness, so it is a known-feasible extension.

Form factor: a web app (SPA) with a thin backend, launched with a single command
(`npx punchout-simulator`) on a dev machine or in a container.

Protocol scope: **cXML only** (no EDI/X12 — confirmed; orders arrive as cXML
end-to-end). OCI possibly later (see section 13).

---

## 2. Name, hosting & publishing

**Name: `punchout-simulator`** — deliberately descriptive rather than a brandable
coined word. Rationale:
- No custom domain is purchased (not monetized; public OSS), so the name does not
  need to be a short brand — it can describe what the tool does.
- Discoverability: the high-value keyword **`punchout`** is first, so npm/GitHub
  search for "punchout" surfaces the tool. This is the main discoverability lever
  in this niche.
- **Role-neutral**: "simulator" covers both modes (buyer and supplier), unlike a
  buyer-only name.
- npm name verified **free**.

**Hosting: GitHub** (chosen over GitLab). Publishing/security is a wash — both
support npm trusted publishing + provenance — so the deciding factor is OSS
discoverability and contributor reach, where GitHub dominates for developer
tools.

Repo under the maintainer's **personal namespace**, not a vanity org:
**`github.com/slawomir-szostak/punchout-simulator`**. This promotes the author's
profile (stars/issues/PRs/followers accrue to the account) and is the normal
pattern for a solo-maintained OSS tool.

**Publishing:** package `punchout-simulator`, run via `npx punchout-simulator`.
- Use **trusted publishing via OIDC from GitHub Actions** — no long-lived npm
  tokens (recommended after recent npm supply-chain attacks; long-lived tokens
  are being phased out).
- This auto-generates **provenance**, cryptographically linking the published
  package to the public repo — which in turn points back at the author's profile
  (provenance badge doubles as profile promotion). Requires public repo + public
  package.
- `package.json` fields to set (also serve profile promotion): `author`,
  `repository` (→ the repo), `homepage` (→ the repo, since there is no domain).
  Optional later: GitHub Pages at `slawomir-szostak.github.io/punchout-simulator`
  for a simple landing page, no domain needed.

(The npm package name is independent of the repo path; `npx punchout-simulator`
resolves from the npm registry regardless of where the source is hosted.)

---

## 3. Domain: the full PunchOut flow

The complete roundtrip (roles named buyer/supplier; the tool plays one of them
depending on mode):

1. **PunchOutSetupRequest** — buyer → supplier, **server-to-server**.
2. **PunchOutSetupResponse** — supplier → buyer; contains `StartPage/URL`.
3. **Browse** — the browser opens `StartPage` (the supplier catalog).
4. **PunchOutOrderMessage / "punchback"** — the cart returns via a
   **browser-driven auto-submit form POST** to the buyer's `BrowserFormPost/URL`.
5. **OrderRequest** — buyer → supplier, **server-to-server**, optionally
   `multipart/related` with attachments.
6. **OrderResponse / Status** — the supplier's reply.

Session correlation: via `BuyerCookie`.

In **Mode A** the tool is the buyer (steps 1, 5 outbound; 2, 4, 6 inbound).
In **Mode B** the tool is the supplier (steps 1, 5 inbound; 2, 4, 6 outbound).

---

## 4. The two modes & their network asymmetry

What matters per mode is *what is under test* and *what you scrutinize*:

- **Mode A (Virtual Buyer)** — the System Under Test (SUT) is the **supplier's**
  system, frequently your own (local/dev). You scrutinize the supplier's output:
  is the `PunchOutSetupResponse` valid, is the punchback well-formed and
  complete, does the order endpoint ingest the `OrderRequest` (incl. multipart
  attachments) correctly. For a seller this makes the tool as much a **cXML
  linter for their own output** as a transport driver.
- **Mode B (Virtual Supplier)** — the SUT is the **buyer's** system. You
  scrutinize the buyer's outbound generation: is the inbound `SetupRequest`
  valid, are credentials correct, does the buyer correctly consume the punchback
  and emit a valid `OrderRequest`.

**Network asymmetry (state this so it does not surprise anyone):**

- **Mode A rarely needs a tunnel.** The punchback is a browser auto-submit from
  the *user's own browser*, so it reaches the tool's `localhost` callback even
  when the supplier catalog is remote — as long as the user shops in the same
  browser. SetupRequest/OrderRequest are server-to-server *outbound* from the
  tool, so no inbound reachability is required.
- **Mode B may need the tool publicly reachable.** A real buyer system sends
  `SetupRequest`/`OrderRequest` **server-to-server, inbound** to the tool. If
  that buyer system is remote/cloud, the tool must be reachable from outside →
  ngrok/cloudflared or a public URL/deploy.

---

## 5. Critical architectural constraint (do NOT skip)

**A pure SPA with no backend cannot do this** — and this is even more true with
two modes:

- **CORS** — supplier endpoints will not send headers allowing the browser to
  cross-origin POST cXML and read the response. SetupRequest and OrderRequest
  **must** go server-to-server (where CORS does not apply).
- **Inbound POSTs require a server.** In Mode A the punchback is an inbound POST
  to the `BrowserFormPost` URL. In Mode B the SetupRequest and OrderRequest are
  inbound POSTs. A pure SPA has nothing to receive any of these.
- Shared secrets should not live in the browser.
- Assembling/inspecting/validating `multipart/related` is far simpler
  server-side.

The SPA is served from the backend (single origin) → this removes CORS between
the SPA and its own API and leaves a single port to expose.

---

## 6. Stack (full TypeScript)

| Layer | Choice | Notes |
|---|---|---|
| Backend | **Hono** (`@hono/node-server`) | few dependencies → fast `npx`; `streamSSE` for the live log; `serveStatic` for the SPA. Heavier alternative: Fastify. |
| Frontend | **React + Vite** | safest "well-known" default. |
| cXML editor | **Monaco** (`@monaco-editor/react`) | the VS Code editor engine; XML highlighting + validation + "edit before send". |
| Real-time | **SSE** (native `EventSource`) | log traffic is server→client only; WebSocket would be overkill. |
| XML parsing | **fast-xml-parser** | for inbound documents and the punchback. |
| cXML building | template literals / thin builder | full control over the exact shape (attributes, ordering, `xml:lang`). |
| cXML validation | DTD/schema check + field-level rules | first-class feature, see section 8. |
| multipart/related | hand-assembled (`Buffer` + boundary) | a dozen lines, no library needed. |
| Backend bundler | **tsup** (esbuild) | fast, clean `bin` output. |
| Runtime | **Node 20 LTS** | maximum `npx` portability. |

---

## 7. Storage (layered — final decision)

Three separate mechanisms chosen by access pattern, with **zero native
dependencies in the core** (key for `npx`):

- **Connection configs → lowdb / a single `config.json`.**
  Mutable, tiny. lowdb is a JSON document store (**not** relational), ideal here.
  With TS, type `db.data`.

  The collection is **`connections`** (role-neutral, not `suppliers`). Each
  connection has a **`mode`** and is designed so Mode B slots in without a
  rewrite:
  - common: `id`, `name`, `mode` (`virtual-buyer` | `virtual-supplier`),
    `from` / `to` / `sender` (each `{domain, identity}`), `sharedSecret`,
    `deploymentMode` (`test`|`production`), `authStyle`
    (`SharedSecret`|`MAC`).
  - `virtual-buyer`: counterparty is a supplier system → `punchoutUrl`,
    `orderUrl` (the supplier's endpoints the tool calls). The tool presents the
    buyer identity (`from`/`sender`).
  - `virtual-supplier` *(phase 2)*: counterparty is a buyer system → the tool
    *exposes* its own punchout/order endpoints and serves a mock catalog
    (`catalog`: list of items with part IDs, prices, UoM, UNSPSC). The tool
    presents the supplier identity and validates the incoming `sharedSecret`.

- **Request/response log → JSONL, append-only, partitioned per session:
  `data/sessions/<sessionId>.jsonl`** (`sessionId` = `BuyerCookie`).
  Appending one line is O(1), with no whole-file rewrite and no need to hold the
  whole dataset in memory. The filename *is* the session index. Line record:
  `{id, sessionId, connectionId, direction, docType, ts, status, headers, body,
  validation}`.
  `direction` ∈ {`out`,`in`} **relative to the tool**; `docType` ∈
  {`SetupRequest`, `SetupResponse`, `PunchOutOrderMessage`, `OrderRequest`,
  `OrderResponse`}; `validation` = the result from section 8.

- **Attachments → separate files `data/attachments/<hash>`**, referenced in the
  JSON record (hash/path + `Content-ID`). Do **NOT** inline base64 into the JSONL.

**What the core deliberately does NOT do (rejected — see section 12):**
- SQLite (`better-sqlite3`) — an optional upgrade *later*, for indexes and
  cross-cutting queries; at the cost of one native module.
- DuckDB — **not** as the primary store. Only, if ever, as a read-only analytics
  layer over JSONL/SQLite (OLAP vs OLTP); its tens-of-MB native binaries would
  hurt `npx`.

Live log to the SPA: the server is the sole writer, so it emits the SSE event at
the same moment it appends the line — no file "watching" needed.

---

## 8. Validation & linting (CORE feature)

For a seller, the tool is as much a "did my catalog emit correct cXML?" linter
as a transport driver — so validation is **first-class, bidirectional**, run on
every document (inbound and outbound), with results stored on the log record and
surfaced prominently per message in the SPA (errors + warnings list).

General checks (all documents):
- Well-formedness + cXML **DTD/schema** validation.
- `payloadID` present; `timestamp` present.
- Credential checks: `From`/`To`/`Sender` domains + identities consistent with
  the connection; `SharedSecret` present/correct where applicable.

Document-specific field checks:
- **PunchOutSetupResponse**: `Status` present and `200`;
  `PunchOutSetupResponse/StartPage/URL` present and a valid URL.
- **PunchOutOrderMessage (punchback)**: `BuyerCookie` present and matching the
  session; `PunchOutOrderMessageHeader` with `Total`/`Money`+`currency`; each
  `ItemIn` has the `quantity` attr, `ItemID/SupplierPartID`, and `ItemDetail`
  with `UnitPrice/Money`+`currency`, `Description`, `UnitOfMeasure`,
  `Classification`(`domain`); **Total consistency** (sum of line totals).
- **OrderRequest**: `OrderRequestHeader` `orderID`/`orderDate`/`Total`;
  `ShipTo`/`BillTo`; each `ItemOut` with `ItemID`, `UnitPrice`, quantity;
  **attachment `cid:` resolution** (see section 11).
- **OrderResponse / generic Response**: `Status` code present.

---

## 9. Project structure & build

**A single npm package** (not a monorepo):

```
punchout-simulator/
├─ package.json          # "bin": { "punchout-simulator": "dist/server/cli.js" }
├─ src/
│  ├─ web/               # React + Vite (SPA)
│  └─ server/            # Hono + CLI (cli.ts -> dist/server/cli.js)
├─ dist/                 # published in the tarball
│  ├─ web/               # vite build
│  └─ server/            # tsup bundle
└─ Dockerfile
```

Build (`npm run build`): `vite build` → `dist/web`; `tsup` → `dist/server`.
Both `dist/` dirs ship in the npm tarball — **the user never builds anything**,
`npx` just downloads and runs.

CLI (`cli.ts`): boot Hono → serve `dist/web` → open the browser (`open` package).
Flags: `--port` (default e.g. 8080), `--data-dir` (default `./data` or a dir
under `$HOME`). A shorter bin alias may be added later if `punchout-simulator` is
tedious to type.

---

## 10. Endpoints

**Tool's own API + Mode A (phase 1):**
- `GET/POST/PUT/DELETE /api/connections` — CRUD for connection configs
  (see section 7 for fields, incl. `mode`).
- `POST /api/connections/:id/setup` — *(virtual-buyer)* send the (possibly
  edited) SetupRequest, capture + validate the response, log both, return
  `StartPage/URL`.
- `POST /api/connections/:id/order` — *(virtual-buyer)* send the OrderRequest
  (multipart if there are attachments), capture + validate the response, log.
- `POST /punchout/return` — *(virtual-buyer)* **callback** receiving the
  punchback auto-submit; parse + validate, correlate by `BuyerCookie`, expose
  the cart to the SPA.
- `GET /api/stream` — **SSE** live log of new messages.
- SPA static assets served from the same server (single origin / single port).

**Mode B — the tool acts as supplier (phase 2):**
- `POST /sim/:id/punchout` — receive the buyer's `SetupRequest`, validate
  credentials, return a `PunchOutSetupResponse` whose `StartPage` →
  `/sim/:id/catalog?session=...`.
- `GET /sim/:id/catalog` — serve the mock catalog UI (shopping).
- `POST /sim/:id/checkout` — build the `PunchOutOrderMessage`, auto-submit it to
  the buyer's `BrowserFormPost`.
- `POST /sim/:id/order` — receive the buyer's `OrderRequest`, validate (incl.
  multipart attachments), return an `OrderResponse` `Status`.

---

## 11. cXML implementation details (the fiddly bits — don't lose these)

- **`<Attachment>` is a child of `<Comments>`**, and `<Comments>` appears at
  **two levels**: in `OrderRequestHeader` (attachment for the whole order) and in
  each `ItemOut` (per line item). **Scan both.**
- **multipart/related**: part 1 = the cXML document; parts 2..n = files, each
  with a `Content-ID` header. In the XML:
  `<Attachment><URL>cid:XXX</URL></Attachment>`, where `XXX` must match exactly
  one `Content-ID`.
- **The receiver branches on `Content-Type` BEFORE touching the XML.** If
  `multipart/*` → unpack the envelope, build a `Content-ID → part` map, and only
  then, for each `<Attachment>/<URL>`, strip the `cid:` prefix and link it.
- **Normalize `Content-ID`**: strip the angle brackets `< >`, watch for domain
  suffixes — a common source of "missing" attachments despite valid XML.
- **`<URL>` may be `cid:`** (file inside the envelope) **or a plain `https://`**
  (fetch separately). Handle both variants.
- **The punchback arrives** either as a `cxml-urlencoded` form field (Ariba
  style) **or** as a raw cXML body. Handle both.
- **`PunchOutOrderMessage` does NOT contain `SharedSecret`** (it travels via the
  user's browser). Credentials live in the `Sender` of the SetupRequest/
  OrderRequest.
- **`From`/`To` swap roles** between the SetupRequest and the punchback.
- `payloadID` has the form `...@host`; `BuyerCookie` correlates the session.

**Dangling-`cid` attachment test (CORE, not optional):** a mode that
deliberately mismatches `Attachment cid` ↔ `Content-ID` to verify the receiver
detects the missing attachment. This is the original motivating use case
(testing a system's multipart/attachment ingestion) — in Mode A it exercises the
supplier's order endpoint.

---

## 12. Distribution

Three flavors, all "up in 30 seconds":
- `npx punchout-simulator` — no install.
- `npm i -g punchout-simulator` — persistent.
- **Docker**: multi-stage (build from source) or simply — an image with
  `RUN npm i -g punchout-simulator` +
  `CMD ["punchout-simulator","--port","8080","--data-dir","/data"]`;
  run: `docker run -p 8080:8080 -v ./data:/data punchout-simulator`.

For **Mode B against a remote buyer system**, expose the tool publicly
(ngrok/cloudflared or a deployed instance) — see section 4.

---

## 13. Scope — what is deliberately REJECTED (so we don't revisit it)

- **Pure SPA with no backend** — won't work (CORS + inbound POSTs in both modes).
- **Postgres / any separate DB server** — an unnecessary second process; we stick
  to files/embedded storage.
- **DuckDB as the primary store** — it's OLAP; our workload (continuous appends +
  lookups by session) is OLTP. Plus heavy native binaries hurt `npx`.
- **WebSocket for the log** — use SSE instead.
- **Python / FastAPI** — dropped in favor of full TS + `npx`.
- **EDI/X12** — out of scope; the integration is pure cXML.
- **Custom domain** — not purchased; discoverability comes from the descriptive
  package name + GitHub presence.

---

## 14. Phasing & future

**Phase 1 (v1):** Mode A (Virtual Buyer) + the full bidirectional validation of
section 8 + the dangling-`cid` attachment test. Data model is built
role-neutrally (`connections` + `mode`) from day one so Mode B slots in.

**Phase 2:** Mode B (Virtual Supplier / mock catalog) — endpoints in section 10,
plus the public-reachability note in section 4.

**Later / nice-to-have:**
- **Buyer platform/relay detection** from headers (e.g. recognizing hubs such as
  TrueCommerce): a `From` vs `Sender` mismatch = a relay; `UserAgent` in
  `Sender`; the host in `payloadID`; the domain/TLS cert/IP at the transport
  layer. A "what am I actually talking to" analysis.
- **Analytics via DuckDB** over the collected JSONL/SQLite (success rate per
  connection, latency distribution, attachment-drop frequency) — e.g. a separate
  `punchout-simulator analyze` command.
- **OCI (Open Catalog Interface)** as a second protocol alongside cXML.
