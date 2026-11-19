---
title: punchout-simulator — Operations & Usage Guide
subtitle: Sessions, operations, profiles, product lists, addresses, attachments, and validation
version: v1.2 — October 2026
lang: en
toc_title: Contents
footer: "punchout-simulator · operations guide · October 2026"
---

## Getting started

Run the tool with no installation:

```bash
npx punchout-simulator
```

It binds to loopback, seeds a demo Buyer, Supplier, Connection and a sample
product list on first run, and opens the browser. Useful flags:

| Flag | Purpose |
|---|---|
| `--port`, `-p` | HTTP port (default `8080`). |
| `--data-dir`, `-d` | Where `config.json` and `sessions/` live (default `./data`). |
| `--public-url` | Expose on a non-loopback URL; this **enables token auth** on `/api`. |
| `--host` | Bind host (also enables token auth when non-loopback). |
| `--token` | Set the API token explicitly (otherwise generated when exposed). Use 16+ random characters; a shorter one triggers a startup warning. |
| `--max-data-mb` | Disk budget for session logs + attachments (default `2048`). See [Data and storage](#data-and-storage). |
| `--no-open` | Don't open the browser. |
| `--no-seed` | Don't seed demo data. |

> [!NOTE]
> When you expose the tool (`--public-url` or a non-loopback `--host`), `/api` is
> gated behind a token, but `/sim` and `/punchout` stay open so a real buyer
> system can reach the Mode-B catalog and the Mode-A callback. That open surface
> is rate-limited and bounded by the disk budget — on localhost too, because any
> web page open in your browser can post to `localhost`.

> [!WARNING]
> The tool serves plain HTTP. With `--host 0.0.0.0` on a LAN, the API token and
> the shared secrets inside cXML documents cross the network unencrypted. Beyond
> a trusted network, put TLS in front — a tunnel (ngrok/cloudflared, passed as
> `--public-url`) or a reverse proxy with a certificate. Wrong tokens are
> throttled (30 a minute per client, 300 overall, then `429` for clients that
> have sent a wrong one), which slows guessing but does not make a short token
> safe.

### Running in Docker

No image is published to a registry; build one from a clone of the repository:

```bash
docker build -t punchout-simulator .
docker run -p 127.0.0.1:8080:8080 -v "$PWD/data:/data" punchout-simulator
docker logs <container>   # → http://localhost:8080/?token=…
```

Inside the container the tool binds `0.0.0.0`, so it treats itself as exposed
and **always requires the API token**, even when you publish the port only on
`127.0.0.1` as above. A token is generated on each start and printed in the
logs; pass `-e POS_TOKEN="$(openssl rand -hex 24)"` to keep one across restarts.
Configuration and logs live in the `/data` volume.

### Environment variables

Every flag default can also come from the environment, which is convenient for
services and CI:

| Variable | Purpose |
|---|---|
| `PORT`, `DATA_DIR`, `HOST` | Defaults for `--port` / `--data-dir` / `--host`. |
| `POS_TOKEN` | Sets the `/api` token (same as `--token`). |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Outbound proxy for server-to-server cXML — see [Corporate proxies](#corporate-proxies). Lower-case variants are accepted too. |

## The workspace

The SPA is split into two areas in the left navigation:

- **Run** — the **Sessions** tab, where you do PunchOut work.
- **Configure** — **Connections**, **Buyers**, **Suppliers**, **Product lists**, and
  **Buyer profiles**, where you set up the entities a session uses, plus
  **Export / import…** to save or load the whole configuration (see
  [Exporting and importing configuration](#exporting-and-importing-configuration)).

Configure the entities once; spend your time in **Sessions**.

## Configuring entities

### Buyers and Suppliers

A **Buyer** is the procurement-platform side: a credential identity, an optional
**Buyer profile**, and optional default **ship-to / bill-to addresses** and an
**end-user contact**. A **Supplier** is the catalog side: a credential identity,
its `punchoutUrl` / `orderUrl` endpoints, the **product lists** it serves in
Mode B, and an `allowMixedCurrency` flag.

> [!TIP]
> Endpoints belong to the Supplier, not the Connection — they are the same for
> every buyer that talks to that supplier. Pair-specific data (shared secret,
> deployment mode) lives on the Connection.

### Connections

A **Connection** binds one Buyer to one Supplier and is the thing a session runs
against. It fixes:

- **Mode** — `A` (virtual buyer drives the real supplier) or `B` (virtual
  supplier serves a mock catalog to the real buyer).
- **Shared secret** and optional **sender identity** override.
- **Deployment mode** and **attachment encoding** (`binary` or `base64`) for
  `OrderRequest` attachments.

### Buyer profiles

A **Buyer profile** captures procurement-platform quirks so a buyer emits
platform-shaped documents: cXML version, **address mode** (`id-only` / `full` /
`both`), whether ship-to and contact appear in the setup request
(`shipToInSetup` / `contactInSetup`), and extrinsics. Built-in presets ship for
the major platforms — **Duplicate** one to tailor it (see
[Duplicating an entity](#duplicating-an-entity)):

| Preset | Notable behaviour |
|---|---|
| **Generic cXML** | The tool's historical default (DTD `1.2.045`, binary attachments, full addresses). |
| **SAP Ariba** | `base64` attachments; sends ShipTo already in the SetupRequest (`shipToInSetup`). |
| **Coupa** | Per-document DTD versions (default `1.2.014`, `PunchOutOrderMessage` `1.2.023`); `base64` attachments. |
| **Jaggaer** / **Jaggaer (SciQuest)** | Two variants for the two `UserAgent` strings observed in the wild (`JAGGAER` and legacy `SciQuest`); DTD `1.2.011` confirmed on real OrderRequests. |
| **Oracle iProcurement** | DTD `1.2.008`, binary attachments. |
| **SAP SRM / Business Network** | Models the cXML/Business-Network side (real SAP SRM speaks OCI); `base64` attachments, base64 cart return, `id-only` addresses. |
| **Workday** | DTD `1.2.045`, `base64` attachments. |

### Product lists

A **product list** is a reusable, named set of catalog items served by Mode-B
suppliers. The served catalog is the union of a supplier's assigned lists.
Items carry rich fields:

- `description`, `supplierPartId`, optional `supplierPartAuxiliaryId`
- one or more **classifications** (`domain` + `value`, e.g. UNSPSC)
- `uom`, `unitPriceAmount`, `currency`
- `allowFractional` — when set, the catalog accepts fractional quantities (e.g.
  `1.5`); otherwise quantities are floored to whole numbers.

You can load the built-in sample assortment as a preset, or import items from
CSV (header aliases, decimal-comma tolerant). A list that is referenced by a
supplier cannot be deleted (the API returns `409`).

### Duplicating an entity

To try a variant — say, the same buyer on a different platform profile, or a
second connection for a client — you don't have to type the setup again. Open
the buyer, supplier, connection, product list or buyer profile and click
**Duplicate**:

- The editor opens an **unsaved draft** with every field copied, named
  `X (copy)` (then `X (copy 2)`, …) with the name pre-selected. The draft also
  shows in the sidebar list.
- Nothing is saved until you click **Create**. **Discard** returns to the
  original; picking another row or **+ New** drops the draft.
- Built-in profiles and the sample product list duplicate into ordinary,
  editable copies — that is the way to tailor them.
- A **connection** copy can keep the original's **shared secret**: the
  *Copy the shared secret from …* box is ticked by default and the server copies
  the secret itself, so it never travels to the browser. This only works while
  the supplier is unchanged — the secret belongs to that supplier — so picking
  another supplier disables the box. A secret you type in yourself wins.
- A **buyer** copy warns while it still has the original's identity: if both
  are connected to the same supplier, the mock supplier (Mode B) can't tell
  them apart. Give the copy its own identity, or point it at another supplier.

## Running a session

A **session** is one PunchOut conversation. Start one from the **Sessions** tab
with **New session**, which asks for:

1. a **Connection** (which fixes the mode), and
2. an **operation** — `create`, `edit`, or `inspect`.

For `edit` and `inspect` you also pick a **source session** to take prior cart
items from (and `inspect` can be narrowed to a single item).

```plantuml
@startuml new-session
!theme plain
title Starting a session

start
:Sessions tab -> New session;
:Pick a Connection;
if (operation?) then (create)
  :empty cart;
else (edit / inspect)
  :pick source session;
  :load its cart items;
  if (inspect) then (narrow)
    :optionally pick one item;
  endif
endif
:Session opens in the chosen mode;
stop
@enduml
```

*Fig. 1: The New-session dialog picks a connection, an operation, and (for edit/inspect) a source cart.*

Each session has its **own message log** — every request and response in that
conversation, viewable as raw cXML. This replaced the old global firehose, so
parallel sessions no longer interleave.

Every cXML editor and viewer field carries a small **Copy + Prettify** toolbar:
**Copy** puts the field's content on the clipboard, and **Prettify** re-indents
the XML locally — on read-only fields the formatting is display-only and never
mutates the logged document.

### Mode A walk-through (virtual buyer)

1. **New session** on a Mode-A connection, operation `create`.
2. The setup request is built and shown in Monaco. Click **Validate** to check
   it before sending.
3. **Send** the `PunchOutSetupRequest`. The real supplier returns a
   `PunchOutSetupResponse` with a **StartPage** link.
4. **Open the StartPage** — in a new tab, or **embedded** in the tool (see
   below) — and shop on the real supplier's site. On checkout the supplier posts
   the cart back to the tool's `/punchout` callback; it appears in the session
   as a `PunchOutOrderMessage`.
5. Build and **Send the OrderRequest** (optionally with attachments). The
   supplier replies with an `OrderResponse`.

### Shopping in the embedded catalog

Some procurement systems (Coupa, Ariba Guided Buying) show the supplier's
catalog inside a frame in their own page rather than in a new tab. **Open
embedded** does the same: the StartPage loads in an iframe overlay on top of the
session, and the overlay closes by itself a moment after the cart comes back.

```plantuml
@startuml embedded-catalog
!theme plain
title Mode A — shopping in the embedded catalog (iframe)

actor Operator as Op
participant "SPA\n(session view)" as SPA
participant "Catalog iframe\n(supplier's pages)" as Frame
participant "Real supplier" as Sup
participant "/punchout/return" as Cb
participant "SSE stream" as SSE

Op -> SPA : open embedded
SPA -> Frame : load the StartPage in an overlay iframe\n(not sandboxed; local-network access delegated)
Frame -> Sup : GET StartPage
note right of Sup
  Fails here if the supplier forbids framing
  (X-Frame-Options / CSP frame-ancestors) or
  depends on third-party cookies.
end note
Op -> Frame : shop, check out
Sup -> Frame : page that auto-submits the punchback
Frame -> Cb : POST PunchOutOrderMessage
note right of Frame
  A form targeting _top would navigate
  the whole buyer UI away instead.
end note
Cb -> Frame : receipt page (knows it is framed)
Cb -> SSE : cart event
SSE -> SPA : cart arrived
SPA -> SPA : close the overlay after a moment,\nshow the cart in the session
@enduml
```

*Fig. 2: The embedded run — the supplier's pages live in a frame, and the cart still returns through the normal callback.*

Use it to find problems a new-tab run never shows:

- **The catalog refuses to load.** The supplier sends `X-Frame-Options` or a
  CSP `frame-ancestors` rule that forbids framing.
- **The session is lost inside the frame.** The supplier depends on cookies that
  browsers treat as third-party when framed.
- **The whole tool navigates away on checkout.** The supplier's punchback form
  targets `_top` instead of the frame.
- **The cart never arrives.** With the tool on `localhost` and the supplier on a
  public address, Chrome's Local Network Access rules apply to the punchback.
  The frame delegates that permission, but a managed browser may still block it
  by policy (`chrome://policy`).

### Mode B walk-through (virtual supplier)

1. Configure a Mode-B connection and assign the supplier one or more product
   lists.
2. Point the **real procurement platform** at the tool's supplier endpoint
   (`/sim/:supplierId/...`).
3. The platform sends a `PunchOutSetupRequest`; the tool replies with a StartPage
   that opens the **themed mock catalog**.
4. The user shops and checks out; the tool builds a `PunchOutOrderMessage` and
   auto-POSTs it to the platform's `BrowserFormPost` URL.

> [!IMPORTANT]
> A checkout against `/sim/:id/checkout` **requires a session opened by a
> `PunchOutSetupRequest`**. Always reach the catalog by opening the StartPage
> from a real `PunchOutSetupResponse`. The cart is returned to the
> `BrowserFormPost` URL that setup named — the tool reads it back from the
> session log, not from the link — so a checkout without a cookie, or for a
> cookie with no setup on record, is rejected (`400`) and never logged as a
> session.

## Operations explained

The operation you choose sets the `operation` attribute on the outbound
`PunchOutSetupRequest` and what it carries:

| Operation | Outbound document | When to use |
|---|---|---|
| **create** | Empty `PunchOutSetupRequest`, no `ItemOut`. | A fresh shopping trip. |
| **edit** | `operation="edit"` + the source cart's items as `ItemOut`. | Revise items already chosen from this supplier. |
| **inspect** | `operation="inspect"` + the item(s) to view as `ItemOut`. | Re-check a previously selected item's spec/price. |

### What "edit" actually does — both ends

`edit` is, first, about the **outbound** document. The buyer-side
`PunchOutSetupRequest` you send declares `operation="edit"` and includes the
prior cart items as `ItemOut` blocks. A *real* supplier honours this by
pre-loading its cart to that state so the user can adjust it.

The **Mode-B mock supplier now honours it too.** When it receives an
`operation="edit"` request, it reads the carried `ItemOut` items (from the
session's setup request) and pre-loads the catalog:

- Items the buyer already had that exist in the supplier's catalog show with
  their **quantities pre-filled** — change them and return the revised cart.
- Items the buyer had that the catalog doesn't list appear as **extra "from
  cart" rows** so the edit round-trips faithfully.

For **`inspect`**, the mock supplier shows the carried item(s) **read-only** and
returns **no items** on checkout. That is what the standard asks of a supplier:
the buyer must ignore the item list of an inspect session, so the tool keeps the
items exactly as it sent them.

### How a returned cart is read

A punchback always ends the shopping session, but what it means for the
requisition depends on the operation it answers and on whether it carries
`Status 204`. The session's cart panel says which case applies:

| Session | Punchback | Meaning |
|---|---|---|
| any | items | The returned items are the cart. |
| `create` | no items | Cancelled — nothing is added. |
| `edit` | no items | The items the session carried are **deleted** from the requisition. |
| `edit` | no items, `Status 204` | Cancelled **without change** — the requisition keeps its items. |
| `inspect` | anything | Ignored — the items stay as they were sent. |

To produce these from the mock catalog: **Cancel** returns an empty cart with
`Status 204`; setting every quantity to zero and returning the cart gives an
empty cart without it.

### What may be done with a cart later (`operationAllowed`)

Every returned cart carries `operationAllowed`, the supplier's statement of what
the buyer may do with it afterwards: `create` allows no reopening, `inspect` a
read-only one, `edit` both. The cart panel shows the value the supplier sent.

- **Testing a supplier (Mode A):** when you start an `edit` or `inspect` session
  from a cart whose `operationAllowed` forbids it, the New session dialog warns
  you. You can still start it, to see how the supplier reacts to a request a
  real procurement system would not make.
- **Testing a buyer (Mode B):** each supplier has a *Carts may later be* setting
  (default `edit`). Lower it, then check that the buyer system stops offering
  edit or inspect for carts from that supplier. If it sends one anyway, the
  inbound SetupRequest is flagged.

> [!NOTE]
> The pre-load is derived from the latest inbound `PunchOutSetupRequest` in the
> session log, so the catalog and the checkout always agree without extra state.
> Catalog matching is by `SupplierPartID` (plus `SupplierPartAuxiliaryID` when
> present); items the supplier doesn't carry pricing for keep the values the
> buyer sent.

## Validation

Every outbound document can be validated **before sending** with the
**Validate** button next to **Send**. Validation is bidirectional and
field-level; it surfaces typed **errors** and **warnings**:

| Check | Behaviour |
|---|---|
| Credentials | Verified only on header-bearing documents (SetupRequest / OrderRequest / PunchOutOrderMessage) — responses are exempt. |
| Single currency | Mixed currencies in one cart are an **error** (and the total emits `0`), unless the supplier's `allowMixedCurrency` is set, which downgrades it to a **warning**. |
| Address completeness | Incomplete ship-to / bill-to (per the buyer profile's address mode) is flagged. |
| Operation / items coherence | `edit`/`inspect` with no items, or `create` with unexpected items, is flagged. |
| Dates | `timestamp` and `orderDate` must be ISO 8601 with a numeric UTC offset (`2026-01-01T10:00:00+01:00`). Not a date is an **error**; no time zone, or the `Z` designator cXML doesn't allow, a **warning**. |
| DOCTYPE | A missing declaration, or one that doesn't name a cXML DTD, is a **warning**; a version other than the buyer profile's is noted. |
| `xml:lang` | Required on `Description` and `Name` (**error** when missing); recommended on `Comments`, `Status` and the root. |
| Several credentials | A party may send more than one (e.g. NetworkID and DUNS). One in a domain the connection knows must match; unknown domains are left alone; two identities in one domain are an **error**. |
| `operationAllowed` | Must be present on a punchback and be `create`, `inspect` or `edit`. |
| Change orders | `type` must be `new`, `update` or `delete`; an `update`/`delete` needs a `DocumentReference` (**error**) to the most recent OrderRequest for that order, and a rising `orderVersion`. |

The rules follow the cXML 1.2.072 DTD and the cXML Reference Guide. An **error**
is something the DTD requires; a **warning** is a "must" or "should" from the
Guide that a receiver can usually still process; **info** is deprecated or
simply worth knowing. The mock supplier rejects an order only on errors.

> [!TIP]
> Validate is advisory — you can still send. Use it to catch obvious mismatches
> before involving the real system, so a failure is unambiguous.

## Addresses and contact

A buyer carries optional default **ship-to**, **bill-to**, and an **end-user
contact**. The address editor enforces real-world structure:

- **Country first** — chosen from the ISO 3166-1 list, which sets both the ISO
  code and the country name.
- **State / province** — a dropdown for US/CA, free text elsewhere.
- **Postal code** — format-validated per country where a pattern is known.

How addresses appear on the wire is **profile-driven** via the address mode
(`id-only`, `full`, or `both`) and the `shipToInSetup` / `contactInSetup` flags.
Order requests default to the buyer's addresses.

## Attachments

`OrderRequest` can carry attachments. The tool assembles a `multipart/related`
body by hand; the **attachment encoding** (`binary` or `base64`) is set per
Connection. Many real Ariba/Coupa receivers expect `base64`; `binary` is more
compact and valid over HTTP. Attachments are stored content-addressed and
referenced from the session log rather than inlined.

Each attachment is **scoped to the order or to one item**, which decides where
its `cid:` reference lands: in `OrderRequestHeader/Comments` or in that
`ItemOut/Comments`.

**The dangling-`cid` test.** Tick *Dangling-cid test* before building the order
and the OrderRequest references a `Content-ID` that is deliberately missing from
the envelope. A correct receiver rejects it; one that answers `200` is not
checking that referenced attachments actually arrived. The tool flags the
dangling reference in its own validation as well, so you can see both sides.

**Seeing what went over the wire.** Every logged message has a **cXML / Raw**
toggle. *Raw* shows the headers and, for an order with attachments, the whole
`multipart/related` envelope — boundaries, part headers, `Content-ID`s and each
part. It is rebuilt on demand from the document and the stored attachments.

### Changing or cancelling an order

After the supplier accepts an order, two buttons appear under its response:

- **Change order…** builds an OrderRequest with `type="update"`,
- **Cancel order…** one with `type="delete"`.

Both keep the order's `orderID`, raise `orderVersion` by one, and add a
`DocumentReference` holding the `payloadID` of the previous OrderRequest — the
original for the first change, the change order for the one after. The document
opens in the editor, so for a change you can alter quantities or lines before
you send it. A cancellation still lists the items: the DTD requires at least one
`ItemOut` in every OrderRequest.

The mock supplier follows the chain. It answers a change with *"Order number …
updated to version 2"* and a cancellation with *"… cancelled"*, under the order
number it first acknowledged. It rejects an update or delete that has no
`DocumentReference`, and warns when the reference points at an older document
than the latest one it holds, when the version doesn't rise, or when it has no
earlier order to change.

> [!NOTE]
> A buyer profile on DTD 1.2.008 gets change orders without `orderVersion`: that
> attribute only exists from 1.2.009.

## Managing sessions

- **Per-session log** — select a session to see only its messages.
- **Resume** — a historical Mode-A session can be resumed; the tool reconstructs
  the flow state (StartPage, last status) from the session's records.
- **Export PDF** — capture the whole flow as test evidence: every exchanged
  message with its validation result, HTTP status, timestamps, and attachment
  list. The export opens a print-ready report and hands it to the browser's
  native "Save as PDF" (no PDF library involved); the paper size follows your
  locale (Letter in the US/CA region, A4 elsewhere).
- **Delete** — remove a session and its log. Attachments that no remaining
  session references are deleted with it (attachments are stored once per
  content and can be shared, so ones still in use stay). Deletion is
  path-guarded so only files inside the data directory can be removed.

> [!NOTE]
> If a flood of empty sessions ever appears, the cause is almost always
> cookie-less `/sim/:id/checkout` calls. Current builds reject these with `400`
> and create no session; opening the catalog from a real StartPage is required.

## Exposing the tool safely

By default nothing outside your machine can reach the tool. The moment you let
something else in — a colleague, a real buyer system, a container — the picture
changes:

```plantuml
@startuml exposure-modes
!theme plain
title Four ways to run it — who can reach what

rectangle "1. Localhost (default)" as M1 {
  actor "You" as U1
  node "punchout-simulator\n127.0.0.1:8080" as T1
  U1 -right-> T1 : http · no token needed
}

rectangle "2. LAN  (--host 0.0.0.0)" as M2 {
  actor "Colleague /\nbuyer system" as U2
  node "punchout-simulator\n0.0.0.0:8080" as T2
  U2 -right-> T2 : **plain http** on the network\n/api needs the token\n/sim, /punchout open
}

rectangle "3. Tunnel  (--public-url https://…)" as M3 {
  actor "Buyer system\non the internet" as U3
  cloud "Tunnel provider\n(ngrok / cloudflared)" as C3
  node "Tunnel agent\n(this machine)" as A3
  node "punchout-simulator\n127.0.0.1:8080" as T3
  U3 -right-> C3 : https
  C3 -right-> A3 : encrypted
  A3 -right-> T3 : http on loopback\n/api needs the token
}

rectangle "4. Docker" as M4 {
  actor "You" as U4
  node "Host port\n-p 127.0.0.1:8080:8080" as P4
  node "Container\n0.0.0.0:8080" as T4
  U4 -right-> P4 : http
  P4 -right-> T4 : /api always needs the token\n(the container counts as exposed)
}

M1 -[hidden]down- M2
M2 -[hidden]down- M3
M3 -[hidden]down- M4
@enduml
```

*Fig. 3: What each way of running the tool makes reachable, and where the token and encryption come in.*

Before exposing it:

- **Prefer a tunnel to a LAN bind.** A tunnel gives you HTTPS; `--host 0.0.0.0`
  sends the token and every shared secret across the network in plain HTTP.
- **Let the tool generate the token**, or set one of at least 16 random
  characters. Wrong tokens are throttled, but that only slows guessing.
- **Treat API access as secret access.** Anyone with the token can read the
  shared secrets through the SetupRequest preview or an export.
- **Remember what stays open.** `/sim/*` and `/punchout/return` accept
  unauthenticated cXML by design. They are bounded by a rate limit, the disk
  budget and — for wrong shared secrets on orders — a per-client throttle.
- **Don't leave it running.** It is a test tool; stop it, or close the tunnel,
  when the test is over.

To report a security problem, see
[SECURITY.md](https://github.com/slawomir-szostak/punchout-simulator/blob/main/SECURITY.md).

## Data and storage

Everything lives under the data directory:

- `config.json` — the normalized entities (buyers, suppliers, connections,
  profiles, product lists). Migrations run automatically at boot.
- `sessions/<sessionId>.jsonl` — one append-only log per conversation. A
  BuyerCookie containing characters that aren't safe in a file name is stored as
  `<sanitized>~<hash>.jsonl`, so two different cookies never share a log.
- `attachments/<sha256>` — attachment blobs, content-addressed and referenced
  from records; removed once no session references them.

**Disk budget.** Session logs and attachments together are capped by
`--max-data-mb` (default 2048 MB). Once the cap is reached, inbound writes on
`/sim` and `/punchout` answer `507 Insufficient Storage`. Catalog pages still
load and requests you send from the UI still go out, but a Mode-A cart return
arrives on `/punchout/return`, so it is refused too. Delete old sessions in the
UI to free space (their attachments go with them), or raise the cap.

To start clean, stop the tool and delete the data directory (or point
`--data-dir` somewhere fresh). To archive a conversation, copy its `.jsonl` file;
to back up or move the configuration, use
[export](#exporting-and-importing-configuration).

## Exporting and importing configuration

**Configure → Export / import…** saves the whole configuration — buyers,
suppliers, connections, buyer profiles, and product lists — as one JSON file, and
loads such a file back. Use it to back up a setup before experimenting, move it to
another machine, or hand it to a colleague. Sessions and logs are not included.

**Export.** *Download config* saves `punchout-simulator-config-<date>.json`.
Shared secrets are **left out** (blank) unless you tick *Include shared secrets*
— they would sit in the file as plain text, so leave it off for a file you share.

**Import.** Choose the mode, then the file. The dialog first shows what the file
contains (counts per entity, export date); nothing is written until you confirm.

| Mode | Effect |
|---|---|
| **Merge** (default) | Entries in the file are added; ones with the same id overwrite the current ones; everything else is kept. Built-in profiles you edited are not reset by a file that doesn't include them. |
| **Replace** | The current configuration is discarded and replaced by the file's (a second click confirms). Built-in profiles and the sample product list are re-added if the file lacks them. |

A **blank shared secret** in the file keeps the secret already stored for that
connection — but only while the connection still pairs the same buyer and
supplier, with unchanged identities and supplier URLs. Otherwise it stays blank,
so a file can't redirect a stored secret to a different endpoint. After the
import, the dialog says how many connections have no secret; set those in
**Connections**.

Files from **older versions** are migrated on import. The import is rejected,
with nothing changed, when the file:

- is not valid JSON, or not a punchout-simulator configuration;
- comes from a **newer** version of the tool;
- has rows without an id, duplicate ids, or ids outside letters, digits, `.`,
  `_`, `-` (max 64 characters);
- has connections pointing at buyers or suppliers that don't exist.

> [!TIP]
> The same operations are available over the API for scripting:
> `GET /api/config/export[?secrets=1]` and
> `POST /api/config/import?mode=merge|replace` with the file as the JSON body.

## Corporate proxies

On a locked-down corporate network (commonly Windows), direct outbound
connections are often black-holed: every browser works (it uses the OS proxy),
but a server-to-server `PunchOutSetupRequest` hangs and dies as
"HTTP 0 / operation aborted". Node's `fetch` does **not** honour proxy
environment variables on its own — unlike curl or Postman — so the tool wires
them in explicitly.

### Routing outbound cXML through a proxy

Set the standard variables before starting the tool:

```bash
HTTPS_PROXY=http://proxy.corp.example:8080 npx punchout-simulator
```

- `HTTP_PROXY` / `HTTPS_PROXY` (upper- or lower-case) route the outbound
  Mode-A traffic (SetupRequest, OrderRequest).
- `NO_PROXY` lists hosts that bypass the proxy. Loopback
  (`localhost`, `127.0.0.1`, `::1`) is **always added automatically**, so the
  tool's own self-calls and any localhost supplier never go through the proxy.
- Credentials in a proxy URL (`http://user:pass@host:port`) are **redacted**
  everywhere the URL is displayed or logged.

### Knowing what is in effect

The startup banner always prints a `proxy:` line with one of three findings:

| Banner | Meaning |
|---|---|
| `proxy: outbound cXML via …` | A proxy env var is set and in effect (with the merged `NO_PROXY`). |
| `proxy: none — … connects directly` | No env vars **and** no OS-level proxy detected. |
| `⚠ proxy: … <source> has a proxy configured` | No env vars, but the OS **does** have a proxy that outbound cXML will **not** use — with a ready-to-paste `HTTPS_PROXY=` suggestion when the concrete host is known. |

For the third case the tool reads the OS-level configuration (best-effort,
read-only): the Windows registry, macOS network settings (`scutil`), GNOME
settings, and KDE's `kioslaverc` — including PAC scripts and WPAD auto-detect.
A PAC/WPAD setup hides the concrete proxy host inside the script, so the banner
points you at the PAC URL (or IT) to find the value for `HTTPS_PROXY`.

The same status appears as a **proxy badge in the app header**, so it stays
visible when the banner has scrolled away or the tool runs as a service.

> [!TIP]
> If Mode-A sends time out on a corporate machine while the browser reaches the
> supplier fine, check the proxy badge first — "system-ignored" means the fix is
> one `HTTPS_PROXY` env var away.
