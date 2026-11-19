# Changelog

Every release of punchout-simulator, newest first. Each entry is the text of the
corresponding [GitHub Release](https://github.com/slawomir-szostak/punchout-simulator/releases).
Versions follow [Semantic Versioning](https://semver.org); while the project is
pre-1.0, new features may arrive in patch releases.

## v0.13.2 — Fix: a crafted body could stall the server

*Released 2026-11-19*

Patch release. Fixes a way to stall the server that v0.13.1 introduced.

v0.13.1 taught the tool to describe a reply that is not cXML — to say "this is an HTML page" and quote what it says. The code that did so ran its pattern matching over the whole body, and one of those patterns is not linear in the worst case: a body made of unclosed `<script` tags made it rescan the rest of the input for each one. 256 KB of that took about ten seconds, and the time grew with the square of the size. The same code runs on documents arriving at the open `/sim` and `/punchout` endpoints, which accept up to 24 MB without authentication, so a single crafted request could keep the single-process server busy for a very long time. The rate limit does not help against one request.

### Changes
- Only the first 8 KB of a body are examined when describing it. That is ample for a page title and a 300-character excerpt, and the cost no longer depends on the size of the body: the same input now takes a few milliseconds.

If you run v0.13.1 exposed (a non-loopback `--host` or `--public-url`), upgrade. A plain localhost run is reachable only from your own machine, but upgrading is still recommended.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.13.1...v0.13.2

## v0.13.1 — Say what the supplier actually answered

*Released 2026-11-19*

Patch release. When a supplier answers with something that is not cXML, the tool now says what it got.

A supplier endpoint that fails before its cXML layer — a wrong URL, a gateway that refuses the request, a proxy that wants credentials — does not answer with cXML. It answers with a web server's error page or a line of plain text. The tool ran that through its XML check and reported the check's first complaint: `XML is not well-formed: char 'P' is not expected`, under the label "Unknown". That was the letter P of "Page not found". Nothing showed the text itself, the HTTP status, or the URL that had been called, so there was no way to tell a mistyped URL from a rejected login.

### Changes
- **The reply is identified and quoted.** Plain text, an HTML page (its title and visible text), JSON, an empty body, or XML whose root is not `<cXML>` — the message says which, and shows what it says: *This is plain text, not cXML (HTTP 404, Content-Type text/plain). It says: “Page not found”*.
- **The HTTP status is explained** with what it usually means in this situation and what to check: 401/403, 404 (with the URL the tool posted to), 405, 407 (a proxy wanting credentials), 415, redirects (with the target), 5xx, and a 200 that returns a web page.
- **It is shown where you look first.** The step header reads `HTTP 404 · no cXML reply` instead of `Status —`, and the supplier-response panel carries the explanation. The validation is labelled with the document that was expected (`SetupResponse`), not "Unknown".
- **Genuine XML errors give their position** — line and column — and the start of the document.
- **Fix:** the order step was marked as done when the supplier answered an OrderRequest with an error page. It now needs an actual cXML answer.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.13.0...v0.13.1

## v0.13.0 — Tax, shipping and accounting, per buyer, supplier and pair

*Released 2026-11-19*

Minor release. Adds tax, shipping and accounting to orders and returned carts, configurable per buyer, per supplier, and per buyer–supplier pair.

Real orders carry more than items. Buyers send tax, a shipping charge, and the accounting codes that say who pays; suppliers quote tax and shipping with the cart. Until now the tool sent and understood none of it, so the part of an integration where the numbers most often go wrong could not be tested. The rule those numbers follow is the one the cXML Reference Guide states for the order and the returned cart alike: the `Total` is the cost of the items, "excluding any tax and shipping". A `Total` with the charges added in is a classic integration mistake, and the validator now names it.

### What a buyer adds to its orders
- **Tax** — a rate and a category (`sales`, `vat`, `gst`, …), sent as a `Tax` in the order header with one `TaxDetail` (category, rate, taxable amount). Optionally also a `Tax` on every line; the line taxes add up to the header tax.
- **Shipping** — a flat amount in the order header. It is only sent there: the standard forbids it at both levels.
- **Accounting** — segments such as *Cost Center / 4711 / Marketing*, sent as a `Distribution` on every line with a `Charge` equal to the line amount.
- With no tax or shipping set, an order carries what the supplier quoted with the cart.

### What the mock supplier quotes
- A tax rate and a shipping amount, returned in the cart header beside a goods-only `Total`. The session's cart panel shows goods total, shipping, tax and the amount to pay.

### Per buyer–supplier pair
- Charges are usually agreed customer by customer — one buyer wants tax in the cart it gets back, another wants none. The buyer and supplier settings are defaults; each **connection** can override them for its pair, separately for orders and for returned carts: follow the party's settings, send none, or send its own figures.

### Validation
- `Tax` and `Shipping` must carry an amount and a description, and a `TaxDetail` its category.
- The tax arithmetic: rate × taxable amount, details against the tax total, line taxes against the header tax.
- The `Total` against the sum of the lines — for orders too, not only returned carts — with a specific message when it equals lines plus tax and shipping. Blanket orders are exempt.
- `Shipping` at one level only; charges in the document's currency.
- Each `Distribution`: an accounting name, at least one segment with an id, and charges that add up to the line amount.

### Good to know
- Tax is charged on the goods total, not on shipping, and there is one rate per party.
- A mixed-currency order gets neither tax nor shipping, since there is no single `Total` to charge against.
- An order whose `Total` does not match its lines now gets a warning; previously only returned carts were checked.
- All of this is valid for every DTD version a buyer profile declares (1.2.008 to 1.2.045) and for the current 1.2.072.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.12.0...v0.13.0

## v0.12.0 — Built against the cXML standard: change orders, cancelled sessions, operationAllowed

*Released 2026-11-19*

Minor release. Brings the tool in line with the cXML standard and adds the parts of the PunchOut exchange it was missing: change and cancel orders, cancelled sessions, `operationAllowed`, and several credentials per party.

Until now the cXML handling was written from experience of what procurement platforms send. For this release it was rebuilt against the published standard — the cXML 1.2.072 DTD and the cXML Reference Guide — and the first thing that turned up was that the tool's own documents were not valid cXML. Phone numbers lacked the country and area code elements the DTD requires. Item-level attachment comments sat inside `ItemDetail` instead of after it. Responses carried a `Header` the DTD does not allow. The children of `PunchOutSetupRequest` were in the wrong order. Timestamps ended in `Z`, which the Reference Guide forbids. And two attributes were sent to buyer profiles whose declared DTD version does not define them. All of that is fixed: every document the tool builds now validates against the real DTD, for each DTD version a buyer profile declares (1.2.008 to 1.2.045) and for the current one.

### Change and cancel orders
- After a supplier accepts an order, **Change order…** and **Cancel order…** build the follow-up the standard defines: the same `orderID`, `type="update"` or `type="delete"`, the next `orderVersion`, and a `DocumentReference` to the previous OrderRequest. The document opens in the editor before sending.
- The mock supplier follows the chain: it answers a change with "updated to version 2" and a cancellation with "cancelled", under the order number it first acknowledged. It rejects an update or delete without a `DocumentReference`, and warns about a stale reference, a version that does not rise, or an order it has never seen.

### Cancelled sessions and empty carts
- The mock catalog has a **Cancel** button: an empty PunchOutOrderMessage with `Status 204`.
- A returned cart is read the way the Reference Guide prescribes. Empty after `create`: cancelled, nothing added. Empty after `edit`: the items are deleted. Empty with `Status 204` after `edit`: nothing changes. After `inspect`: whatever came back is ignored. The session's cart panel says which case applies.

### `operationAllowed`
- Each supplier has a setting for the `operationAllowed` its carts are returned with, so you can check that a buyer system respects "this cart may not be edited".
- The New session dialog warns when you start an `edit` or `inspect` from a cart whose supplier did not allow it. You can still start it, to see how the supplier reacts.

### Several credentials per party
- `From`, `To` and `Sender` may each carry more than one `Credential` (for example a NetworkID and a DUNS). All are read. One in a domain the connection knows must match; unknown domains are left alone; two different identities in one domain are an error. Previously only the first credential was read, so a match on the second was reported as a mismatch.

### Validation
- New checks: date-time format of `timestamp` and `orderDate`, DOCTYPE, `xml:lang`, `operationAllowed`, the setup `operation`, order `type` / `DocumentReference` / `orderVersion`, and a `SharedSecret` travelling in a punchback.
- Severity now follows one rule. **Error:** the DTD requires it. **Warning:** the Reference Guide says "must" or "should", but a receiver can usually still process the document. **Info:** deprecated or simply worth knowing.

### Behaviour changes
- **Inspect returns no items.** The mock supplier used to echo the inspected items back; the standard says a supplier should return none.
- **The mock supplier's default `operationAllowed` is now `edit`** (it was `create`), since it does reopen carts.
- **The mock supplier's responses no longer have a `Header`.**
- **More orders can be rejected.** The mock supplier rejects an order on any validation error, and there are new errors: an unparseable `timestamp` or `orderDate`, a `Description` or `Name` without `xml:lang`, an invalid order `type`, an update or delete without a `DocumentReference`.
- **Timestamps** are written in local time with a UTC offset (`2026-01-01T10:00:00+01:00`) instead of UTC with `Z`.

### For contributors
- `test/dtd-conformance.test.ts` validates every built document against the real DTD with `xmllint`. It runs only when `CXML_DTD` points at a local copy of the DTD, which is not redistributed here.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.10...v0.12.0

## v0.11.10 — Virtual supplier: carts can't be redirected, sessions can't collide

*Released 2026-11-18*

Patch release. Closes the three remaining low-priority items from the security review, all in virtual-supplier mode.

The mock catalog took the cart's return address from its own link. That address is put there by the tool, but nothing stopped someone from handing a user a link with a different one — the catalog would then post the cart to any site. Session logs were named after the BuyerCookie with unsafe characters replaced by `_`, so `a/b`, `a b` and `a_b` were one file and a buyer could write into another session's log. And the OrderResponse tells the sender whether its SharedSecret was right, with nothing limiting how fast an exposed instance could be asked.

### Changes
- **Cart return URL comes from the session, not the link.** The catalog returns the cart only to the `BrowserFormPost` URL of the SetupRequest that opened the session, read back from the session log. The buyer identity in the punchback comes from the same place. The StartPage URL now carries only the BuyerCookie.
- **One log file per BuyerCookie.** A cookie with characters that aren't safe in a file name is stored as `<sanitized>~<hash>.jsonl`. Cookies made only of safe characters keep their file names, and logs written by earlier versions stay readable.
- **Wrong SharedSecrets are throttled when exposed.** A client that keeps sending OrderRequests with a wrong secret gets `429` after 30 in a minute, the same way wrong API tokens are handled. The comparison is constant-time. Plain localhost runs are not throttled — sending a bad secret repeatedly is a legitimate test there.

### Behaviour change
A checkout (`POST /sim/<id>/checkout`) for a BuyerCookie the supplier never received a SetupRequest for is now refused with `400`, as is one whose SetupRequest named no http(s) `BrowserFormPost` URL. Previously it rendered a return form with an empty target. If a script of yours posts to checkout directly, send the SetupRequest first; the `formpost`, `bd` and `bi` fields are no longer read.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.9...v0.11.10

## v0.11.9 — Token throttle: close two ways around it

*Released 2026-11-18*

Patch release. Completes the failed-token throttle introduced in v0.11.7 and reworked in v0.11.8.

v0.11.8 removed the global cap so that a stranger could no longer lock the operator out of an exposed instance. That left two ways to get more guesses than intended. A client on IPv6 usually controls a whole /64 and could take a fresh address for every attempt, so it was never counted twice. And with no overall bound, a guesser spread over many addresses got the full 30 attempts from each. Neither lets anyone in or exposes data; they weakened a speed bump that only matters when the operator has chosen a short token.

### Changes
- **IPv6 clients are counted by their /64**, so rotating addresses inside one network no longer resets the count.
- **An overall budget that cannot lock you out:** once 300 wrong tokens have arrived in a minute, every client that has itself sent a wrong token is refused until the minute is up. A client with no failures is never affected, so a working session carries on.
- **Counters are no longer reset** when the table of tracked clients fills.

If you open the UI without the token while someone has exhausted the overall budget, you are refused until the minute ends — then the `?token=` URL works as usual. Plain localhost runs have no token and are unaffected.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.8...v0.11.9

## v0.11.8 — Fix: token throttle could lock the operator out

*Released 2026-11-18*

Patch release. Fixes a flaw in the failed-token throttle introduced in v0.11.7.

v0.11.7 started throttling wrong `/api` tokens on exposed instances, but did it in a way an outsider could turn against the operator. There was a global cap: 300 wrong tokens a minute, from anyone, and every client was refused until the minute ended — including the operator holding the correct token. And clients were told apart by the first `X-Forwarded-For` value, which the sender chooses, so a guesser could rotate it to dodge the per-client limit or forge the operator's address to lock them out. No data was exposed and nobody could get in this way; the effect was that anyone able to reach an exposed port could keep you out of the admin UI. Plain localhost runs have no token and were not affected.

### Changes
- **No global cap.** The limit is per client only: 30 wrong tokens a minute, then `429` until the minute is up.
- **Client identity can't be forged.** A client is identified by its socket address. `X-Forwarded-For` is believed only when the connection comes from the same machine (a local tunnel agent such as ngrok or cloudflared), and then only its last hop — the one the agent appended.

Clients that share one address (a shared NAT, or everything reaching a Docker container) still share the 30-a-minute allowance.

If you run v0.11.7 exposed, upgrade.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.7...v0.11.8

## v0.11.7 — Defence in depth: script lockdown for the UI, throttled token guessing

*Released 2026-11-18*

Patch release. Adds the safety nets that were missing around an already-hardened core.

v0.11.6 fixed what was wrong; this release adds what was absent. The UI had no Content-Security-Policy beyond a framing rule, so an escaping bug like the one in 0.11.1 would have run attacker-supplied script immediately. Nothing limited how fast someone could guess the `/api` token on an exposed instance, and the README's own Docker example used `POS_TOKEN=mysecret`. Nothing watched dependencies between releases, which is how three advisories had quietly accumulated. And there was no stated way to report a vulnerability.

### Changes
- **Content-Security-Policy for the UI:** scripts may load only from the tool itself, so text arriving in cXML or an imported configuration cannot run as script even if it were ever rendered unescaped. The mock catalog and punchback receipt pages (`/sim`, `/punchout`) are not covered — buyer platforms embed them and they still use inline script.
- **Failed-token throttle:** wrong `/api` tokens are limited to 30 per client and 300 overall per minute, then answered with `429` until the minute is up. A client over the limit is refused even with the right token, so the limit genuinely bounds the guess rate.
- **Weak-token warning:** startup warns when a configured `--token` / `POS_TOKEN` is shorter than 16 characters. The Docker example now relies on the generated token instead of `mysecret`.
- **Docs:** the README and operations guide state that the tool speaks plain HTTP and that an exposed instance needs a tunnel or TLS proxy in front.
- **`SECURITY.md`:** how to report a vulnerability privately, and what is in and out of scope.
- **Dependency watch (repo only):** Dependabot for npm and GitHub Actions, plus a CI job that fails on advisories in shipped dependencies and runs weekly.

No functional changes to flows or validation. If you script against an exposed instance, note the new `429` after repeated wrong tokens.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.6...v0.11.7

## v0.11.6 — Security maintenance: patched dependencies, no secrets in logs

*Released 2026-11-18*

Patch release. Clears every open dependency advisory and closes two ways a secret could end up in a log.

A follow-up security pass over the whole project found nothing exploitable in the default localhost run, but several loose ends. `npm audit` reported three moderate advisories, one of them about Hono skipping wildcard middleware — the mechanism that carries this tool's `/api` token, Host and CSRF checks. When the tool ran exposed, the API token was printed to stdout (and so to `docker logs`) on every live-log and download request, because those carry it as `?token=`. And a `SharedSecret` whose tag had whitespace or an attribute (`<SharedSecret xml:lang="en">`) was valid cXML but slipped past the log redaction — relevant in virtual-supplier mode, where a real buyer system's secret arrives in your logs.

### Changes
- **Dependencies:** hono patched within 4.x, `@hono/node-server` 1.x → 2.1.9, `fast-xml-parser` 4.x → 5.12.1. `npm audit` is clean. Node 20 remains supported.
- **API token masked in the request log:** `?token=…` is printed as `?token=***`.
- **SharedSecret redaction** now matches the tag with whitespace or attributes, not only the literal `<SharedSecret>`.
- **Docker:** the image moves from end-of-life Node 20 to `node:24-slim`. The README now includes the `docker build` step it was missing (the image is not published to a registry), and CI builds the image on every push.
- **Release pipeline:** the publish job installs dependencies with `--ignore-scripts` and pins its actions to commit SHAs, so nothing third-party runs with the npm publish credential.

No functional changes — flows, validation and the UI behave exactly as in v0.11.5.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.5...v0.11.6

## v0.11.5 — duplicate anything

*Released 2026-10-22*

Patch release. Adds a Duplicate button to every editor: buyers, suppliers, connections, product lists and buyer profiles.

Trying out a variant for one client used to mean re-typing a whole buyer or connection by hand: identities, addresses, profile, credentials. Now you open the original, click **Duplicate**, change what's different and click **Create**.

### Changes
- **Duplicate opens an unsaved draft** named "X (copy)", "X (copy 2)", … with the name pre-selected. The draft shows in the sidebar, and nothing is saved until you click Create. **Discard**, or picking another row, drops it.
- **Built-in profiles and product lists** duplicate into ordinary copies you can edit, the intended way to tailor them for a client.
- **Connection copies keep the shared secret.** The server copies it from the original connection, so it never travels to the browser. This works only while the supplier is unchanged, because the secret belongs to that supplier. If you pick another supplier, the option is disabled with an explanation. A secret you type in yourself always wins.
- **Same-identity warning on buyer copies.** While a copy still has the original's identity, the editor warns that the mock supplier (Mode B) can't tell the two apart if both connect to the same supplier.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.4...v0.11.5

## v0.11.4 — deleting sessions frees their attachments

*Released 2026-10-22*

Patch release. Fixes the new disk budget being impossible to clear from the UI when it filled up with attachments.

0.11.3 added a disk budget (`--max-data-mb`) for session logs and attachments: once it's reached, the inbound `/sim` and `/punchout` endpoints answer `507` until you delete old sessions. But attachments are stored once per unique content and shared between sessions, and they were never removed — so if the budget filled up with attachments, deleting sessions freed almost nothing and the inbound endpoints stayed blocked.

### Changes
- Deleting a session now also deletes attachments that no remaining session references. Attachments still used by another session are kept.
- The `507` message says so: delete old sessions in the UI (their attachments go with them), or raise `--max-data-mb`.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.3...v0.11.4

## v0.11.3 — security update

*Released 2026-10-22*

Patch release. Fixes a stored XSS introduced with config import in 0.11.1, and hardens everything reachable without a login. **Upgrade if you're on 0.11.1 or 0.11.2**, especially if you import config files from other people.

A security review of the whole tool found one serious problem and several smaller ones. The serious one: config import accepted any id, and the mock catalog page put the supplier id into its HTML unescaped. A config file crafted by someone else could therefore run script on the simulator's own origin as soon as you opened that supplier's catalog — with access to the API token and the API, including exporting your shared secrets. The rest are about the inbound endpoints (`/sim`, `/punchout`), which stay open by design: on a plain localhost run any web page in your browser can post to them, and nothing limited how much they could write to disk.

### Fixed
- **Stored XSS via imported ids.** Imports only accept ids made of letters, digits, `.`, `_` and `-` (max 64 characters); the catalog page escapes the id; the UI URL-encodes ids in API paths.
- **Dependencies:** `hono` 4.13 and `@hono/node-server` 1.19.17 (path traversal in static file serving on Windows; memory exhaustion via deeply nested form fields on the open routes), `undici` 6.29 (several fixes; still Node 20-compatible), `nanoid` 5.1.16.

### Hardening
- **Disk budget:** session logs and attachments are capped by `--max-data-mb` (default 2048). Once reached, inbound `/sim` and `/punchout` writes answer `507` until you delete old sessions; reads keep working.
- **Rate limit always on:** the open surface is now also limited on localhost (a looser, global cap), not only when exposed.
- **Supplier responses capped at 25 MB** instead of being read into memory whole.
- **The UI and API can't be framed by other sites** (`X-Frame-Options`, CSP `frame-ancestors`), plus `nosniff` and `no-referrer`. Mock catalogs stay embeddable.
- The API token is no longer accepted from a cookie (nothing set one, and a cookie would travel with cross-site requests).

Cross-site requests to the API were already rejected since 0.11.1.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.2...v0.11.3

## v0.11.2 — published without a stored token

*Released 2026-10-22*

Patch release. No changes to the tool itself; this release moves publishing to npm trusted publishing.

npm is restricting long-lived tokens that bypass 2FA, which is how this package has been published so far. The first attempt to switch (v0.11.0) failed: npm's token exchange answered "package not found" even though the trusted-publisher entry matched, and 0.11.1 went out on the old token instead. Re-creating the trusted publisher on npmjs.com fixed the exchange, so this release is published by the GitHub workflow itself — no stored npm token involved — with provenance as before.

### Changes
- The publish workflow authenticates via npm trusted publishing (GitHub OIDC) instead of the `NPM_TOKEN` secret.
- A manual `oidc-check` job (`gh workflow run publish.yml`) performs the same token exchange without publishing, to diagnose auth problems in seconds instead of on a failed release.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.11.1...v0.11.2

## v0.11.1 — take your setup with you, safely

*Released 2026-10-22*

Patch release on top of 0.11.0, which never reached npm. Adds export and import of the whole configuration, and closes a cross-site request hole in the local API.

Building a realistic setup — buyers with addresses, suppliers with their endpoints, connections, tuned platform profiles, product lists — takes a while, and until now it lived only in one `config.json` inside the data directory. Moving it to another machine, handing it to a colleague, or keeping a known-good copy meant copying that file by hand. Now it's one click each way.

While reviewing the import we found that the local API, which has no token on a plain localhost run, also accepted state-changing requests sent from *other websites* open in the same browser: a page could fire a simple form-style POST at `localhost` without any browser prompt. That was true for every create/update/delete endpoint, and an import made it worse — it could re-point a connection somewhere else while keeping its stored shared secret. Both are fixed.

### Export / import
- **Configure → Export / import…** downloads buyers, suppliers, connections, buyer profiles and product lists as one JSON file, and loads such a file back. Sessions and logs are not included.
- Import either **merges** (entries with the same id are overwritten, everything else is kept) or **replaces** the whole configuration (with a confirm click). The dialog shows what the file contains before anything is written.
- Shared secrets stay out of the export unless you tick *Include shared secrets* (they'd be plain text in the file). On import, a blank secret keeps the one already stored — but only while the connection still points at the same buyer, supplier, identities and supplier URLs.
- Files from older versions are migrated on import; files from a newer version, malformed files, and files whose connections point at missing buyers or suppliers are rejected without changing anything. A merge never resets your edits to built-in profiles the file doesn't include.
- API: `GET /api/config/export[?secrets=1]` · `POST /api/config/import?mode=merge|replace`.

### Security
- Non-GET `/api/*` requests that the browser marks as cross-site (`Sec-Fetch-Site`, or a foreign `Origin`) are rejected with 403. The UI (same-origin) and non-browser clients such as `curl` are unaffected.

### Release pipeline
- Publishing is back on the `NPM_TOKEN` secret: the switch to npm trusted publishing failed on its first run (v0.11.0), so 0.11.0 was never published to npm.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.10.1...v0.11.1

## v0.11.0

*Released 2026-10-22*

> **Not published to npm** — the publish run failed (trusted-publishing auth). Superseded by [v0.11.1](https://github.com/slawomir-szostak/punchout-simulator/releases/tag/v0.11.1), which contains this and a security fix.

### v0.11.0 — take your setup with you

Minor release. Adds export and import of the whole configuration.

Building a realistic setup — buyers with addresses, suppliers with their endpoints, connections, tuned platform profiles, product lists — takes a while, and until now it lived only in one `config.json` inside the data directory. Moving it to another machine, handing it to a colleague, or keeping a known-good copy before experimenting meant copying that file by hand. Now it's one click each way, from the UI.

### Changes
- **Configure → Export / import…** downloads buyers, suppliers, connections, buyer profiles and product lists as one JSON file, and loads such a file back. Sessions and logs are not included.
- Import either **merges** (entries with the same id are overwritten, everything else is kept) or **replaces** the whole configuration (with a confirm click). The dialog shows what the file contains before anything is written.
- Shared secrets stay out of the export unless you tick *Include shared secrets* — the API never returns them otherwise, and the file would hold them as plain text. On import, a blank secret keeps the one already stored for that connection, so a secret-less export round-trips without losing anything.
- Files from older versions are migrated on import; files from a newer version, malformed files, and files whose connections point at missing buyers or suppliers are rejected without changing anything.
- A merge never resets your edits to built-in profiles the file doesn't include.
- API: `GET /api/config/export[?secrets=1]` · `POST /api/config/import?mode=merge|replace`.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.10.1...v0.11.0

## v0.10.1 — the embedded catalog can punch back to localhost

*Released 2026-10-15*

Patch release. Fixes the cart submit being blocked in iframe mode when the simulator runs on localhost.

When you shopped in the embedded catalog and clicked submit, Chrome stopped the punchback with "The connection is blocked because it was initiated by a public page to connect to devices or servers on your local network". That's Chrome's Local Network Access: a public supplier page inside a frame may not reach `localhost` unless the parent page delegates the permission, and the simulator's iframe didn't. New-tab mode was unaffected. Now the frame delegates it, so Chrome asks once and remembers your answer for that supplier.

### Changes
- The catalog iframe delegates Local Network Access via `allow="local-network-access; local-network; loopback-network"`. Chrome has shipped the permission under several names, and it ignores the ones it doesn't know.
- The iframe hints cover the new error: allow the prompt, or set *Local network access* to Allow in the supplier site's settings. Managed browsers may still block it by policy.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.10.0...v0.10.1

## v0.10.0 — the session page tells you what to do next

*Released 2026-09-24*

Minor release. A usability pass over the session workspace, plus the supplier's real answer shown after an order.

Until now the session page treated everything as equally important: fifteen lines of SetupRequest XML at the top, two full-width green validation bars per exchange, and the one thing you actually needed next — opening the catalog — as a small text link below them. Sending an OrderRequest ended in a green check mark even when the supplier's response carried an order number or a rejection reason. This release reworks the page around the flow: which step you're on, what the counterparty said, and what to do next.

### Session flow
- **Step states.** The active step is highlighted, finished steps get a green ✓, later steps recede. Each step header shows its outcome (`HTTP 200 · Status 200`, `2 items · USD 59.00`, a pulsing "waiting for the punchback…").
- **Next action first.** After a successful setup a highlighted row offers **Open catalog** (new tab) and **Open embedded (iframe)** as buttons, with the StartPage URL copyable beneath; Send demotes to "Re-send". Once the cart lands the page scrolls to it.
- **cXML behind a digest.** Editors fold behind a one-line summary (`operation create · from DUNS/… · to DUNS/… · DTD 1.2.014 · agent Coupa Procurement`; `orderID · items · total` for orders) with an *Edit cXML* toggle. The OrderRequest editor opens when built and folds after a successful send.
- **Validation as chips.** `Validation [valid] SetupRequest [valid] SetupResponse` on one line; full issue panels only for documents that have issues.
- **Supplier response panel.** The `<Status>` body — where suppliers put order numbers and rejection reasons — is parsed and shown under step 3 (and under step 1 when a setup is refused). Reattached sessions recover it from the log.
- **Message log beside the steps** on wide screens (sticky column), so request/response pairs appear as you click. Mode-B rows show the supplier's name instead of its id.

### Sessions list & navigation
- Session cards show `operation · phase · time` (catalog open, cart received, order accepted…) and the truncated BuyerCookie, instead of repeating the connection name.
- **▶ New session** on a virtual-buyer connection opens the dialog with that connection pre-selected.
- In the loopback demo the mock supplier now files the inbound OrderRequest under the buyer's own session (correlated by orderID), so one flow is one session; external buyers still get their own inbound session.
- Nav labels match their headings (Product lists, Buyer profiles); the header's Delete is a quiet control; the narrow sidebar stacks its button and wraps long titles.

### Mock supplier
- Acknowledges like an order desk: `OK. Order number SO-8OLC1MFF received for PO PO-FGiNdLil.` on success, `Bad Request. Order rejected (PO …): <first validation error>` on rejection.

### Embedded catalog
- The overlay header no longer wraps and its troubleshooting hint reads as three short questions (blank frame? logged out? page navigated away?).

### Fixes
- `/api/cart/:id` returns `200` with `null` for a session without a cart, removing a console 404 on every session open.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.9.1...v0.10.0

## v0.9.1 — every message shows where it went

*Released 2026-09-24*

Patch release. Adds the endpoint URL to every logged message.

Until now a message's detail view told you *what* was sent and *when*, but not *where* — with several suppliers configured (or a supplier whose punchout and order endpoints differ), confirming which address a SetupRequest or OrderRequest actually hit meant going back to the supplier's configuration and trusting it matched. The log now records the endpoint of each exchange at the moment it happens.

### Changes
- Each log record carries `url`: for Mode A the URL the request was POSTed to; for Mode B the URL the buyer hit (as the buyer addressed it, tunnel host included); for the punchback its `BrowserFormPost` target. The matching response record repeats the request's URL.
- The message detail modal shows the full URL under the meta row (`→ …` for outbound, `← …` for inbound).
- Session log rows show the endpoint's host next to the connection name, so suppliers are distinguishable at a glance.
- Records logged before this release simply have no URL and render as before.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.9.0...v0.9.1

## v0.9.0 — catalog embedded in an iframe

*Released 2026-09-24*

Minor release. Adds an **open embedded (iframe)** option next to the existing "open catalog in new tab" link on a Mode A session.

Several procurement systems (Coupa, Ariba Guided Buying) present the supplier's punchout catalog inside an iframe rather than a new tab, and a catalog that works fine in a tab can fail there in ways a new-tab test never shows: the supplier sends `X-Frame-Options` / CSP `frame-ancestors` and the frame stays blank; the session cookie lacks `SameSite=None; Secure` (or the browser blocks third-party cookies) and the user is logged out mid-shop; or the punchback form targets `_top` and navigates the buyer UI away. This release lets you reproduce that environment against a real supplier from the simulator.

### Changes
- New **open embedded (iframe)** link on the SetupResponse result. It opens the StartPage in an unsandboxed iframe overlay covering most of the screen (Esc / ✕ closes), so the catalog behaves as it would inside a real procurement frame.
- The overlay closes itself once the cart lands over the live stream, which works for all punchback transports (`cxml-urlencoded`, `cxml-base64`, raw) without cross-window messaging.
- A hint under the frame maps the three failure symptoms (blank frame, logged out inside, whole page navigated away) to their cause.
- The `/punchout/return` receipt notices when it is framed and drops the "close this tab" wording (`window.close()` is a no-op there anyway).

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.8.4...v0.9.0

## v0.8.4 — source sessions scoped to the chosen connection

*Released 2026-07-16*

Patch release. Fixes the New-session dialog offering sessions from *other* connections as edit/inspect sources.

When starting an **edit** or **inspect** session, the "Source session" list showed every session the tool had ever logged, regardless of the connection picked in step 1 — so with a few suppliers configured you had to eyeball which entries actually belonged to the connection you were about to drive, and nothing stopped you from picking a cart that came from a different supplier entirely. The list is now scoped to the selected connection, and switching the connection resets a stale source pick instead of carrying it over.

### Changes
- The Source session list in the New-session dialog only shows sessions belonging to the connection selected in step 1 (within that scope, sessions without a returned cart are still listed but disabled, as before).
- Changing the connection clears the source-session selection, so a pick from the previously selected connection can't linger into the send.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.8.3...v0.8.4

## v0.8.3 — proxy visibility & code-review hardening

*Released 2026-06-10*

Patch release. Makes the corporate-proxy situation visible at a glance, and ships the full remediation of a three-axis (architecture / security / UX) code review of the 0.8.2 codebase.

0.8.1 taught the tool to honour `HTTP(S)_PROXY`, but on a typical corporate machine the proxy lives in the OS settings or a PAC script and the env vars are empty — so outbound cXML still black-holed while every browser worked fine. The tool now checks the OS-level configuration at startup and tells you exactly what it found and what to set, instead of leaving you to diff your environment against Postman's.

### Proxy diagnostics
- The startup banner always states the proxy situation: the env proxy in use (credentials redacted), an explicit "none — connecting directly", or the important case — a system proxy found in the Windows registry, macOS network settings, GNOME or KDE (manual, PAC, or WPAD) that outbound cXML will **not** use, with a ready-to-paste `HTTPS_PROXY=` suggestion.
- The same status shows in the web UI header (an amber "system proxy ignored" badge with the details), since the terminal banner is invisible when the tool runs in the background.
- Expected boot refusals print a clean one-liner instead of a stack trace.

### Reliability & data safety
- `config.json` now carries a `schemaVersion` with ordered, version-gated migrations and a downgrade guard — data written by a newer build is refused instead of silently losing fields. Every legacy shape is pinned by fixture tests.
- Owner-only file permissions are re-applied after every config write (lowdb's temp-file-and-rename was silently dropping them).
- The session list no longer re-reads every JSONL log on each live-stream event (incremental summary cache; correctness guarded by per-file size checks).
- Mode-A carts and the session→connection mapping survive a server restart (re-derived from the on-disk log).
- Multipart parsing anchors the boundary to line starts and strips exactly one framing CRLF — inbound binary attachments ending in newline bytes are no longer truncated (stored file, sha256 and logged size were all wrong before).
- Malformed JSON request bodies return 400 instead of being treated as an empty request — previously a garbage body could mint a session and send a zero-item OrderRequest to the configured supplier.
- The live stream resyncs sessions and carts on every reconnect, so the session log is no longer silently incomplete after laptop sleep or a server restart — and Mode A no longer strands at "Waiting for a cart" on a missed event.
- The SPA is served from an absolute path — fixes UI 404s on Windows installs where the npm prefix and the working directory sit on different drives.

### Security
- DNS-rebinding guard: `/api/*` only answers requests whose `Host` header names a host the server actually serves on; the API token compare is constant-time.
- When the tool is exposed, the intentionally-open `/sim` + `/punchout` surface is rate-limited (per-client and global buckets, 429 with `Retry-After`); plain localhost runs are exempt.
- Attachment downloads get `nosniff` + forced download; a supplier-provided StartPage renders as a link only for http(s) URLs.

### Web UI & CLI polish
- Failed deletes show the server's reason next to the button instead of failing silently.
- Transport errors surface the real cause (`ECONNREFUSED`, `ENOTFOUND`, TLS) and map timeouts to a corporate-proxy hint.
- Form labels are wired to their controls across all editors, and the New-session dialog got the same focus trap and focus restore as the message-detail modal.
- Response DTOs are shared between the server and the SPA, so a server-side rename breaks the build instead of the UI at runtime.
- CLI: `--version`, errors on unknown flags and bad ports, a friendly "port already in use" message, and the resolved data directory in the banner. Copy buttons work on plain-HTTP LAN origins; loading a product preset asks before replacing hand-entered rows.

Test suite: 134 → 193 tests.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.8.2...v0.8.3

## v0.8.2 — Fix Node 20 startup crash (undici pin)

*Released 2026-06-09*

Patch release. Fixes the tool crashing on import under **Node 20**, the minimum version declared in `engines`.

The proxy support added in v0.8.1 pulled in **undici 8**, which silently requires **Node ≥ 22.19**. On Node 20 — supported per `engines: ">=20"` and exercised by the CI matrix — importing undici 8 (via the proxy layer) threw at load time, so the server failed to start and the Node 20 CI job failed.

### Changes
- Pin **undici to `^6`** (`6.26.0`), which supports **Node ≥ 18.17** and covers all of 20.x. It still exports `EnvHttpProxyAgent` (since 6.13) and `setGlobalDispatcher`, so the corporate-proxy behaviour from v0.8.1 is **unchanged**.

No functional changes — proxy support, validation, and the UI all behave exactly as in v0.8.1.

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.8.1...v0.8.2

## v0.8.1 — Corporate proxy support for outbound cXML

*Released 2026-06-09*

Patch release. Fixes outbound `SetupRequest`/`OrderRequest` hanging on a corporate network.

  Node's `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` by default, so on a locked-down network (commonly Windows) a server-to-server call to a real
  supplier was silently black-holed — hanging until the 30s timeout and showing **`HTTP 0` / "operation was aborted"**, even though the same endpoint worked
  in Postman (which uses the system proxy).
  
  ### Changes
  - The tool now honours the standard **`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`** environment variables for outbound cXML (via undici's
  `EnvHttpProxyAgent`). Works on **Windows and Linux**.
  - **Loopback always bypasses the proxy** (`localhost`/`127.0.0.1`/`::1` are added to `NO_PROXY`), so the built-in mock supplier and localhost endpoints
  keep working even with a proxy set.
  - Startup logs the active proxy with credentials redacted.
  - README documents setup with Windows (PowerShell) and Linux examples, plus the caveat that a Windows *system* proxy must be set explicitly via 
  `HTTPS_PROXY`.

  Usage:
  ```powershell
  $env:HTTPS_PROXY="http://proxy.corp:8080"; npx punchout-simulator

  Full Changelog: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.8.0...v0.8.1

## v0.8.0 — Copy/Prettify on every code field, PDF flow export, cleaner log

*Released 2026-06-08*

### Code fields & message log
  - Every cXML field now has a **Copy** + **Prettify** toolbar — consistently across the flow steps (1/2/3) and the message-detail modal. Prettify formats
  the XML safely (only reflows whitespace between tags, never element text), so it's fine on editable edit-before-send fields too.

  ### Export flow to PDF (test evidence)
  - New **Export PDF** button in the session header (live, historical, and inbound sessions). Native print-to-PDF — a self-contained report with each step's
  direction, timestamp, HTTP status, **validation result**, and formatted cXML. Page size is **A4 or Letter, chosen from your browser locale**. Ideal for
  capturing test evidence.

  ### Log fixes
  - Re-sending an **unchanged** `PunchOutSetupRequest` now shows as its own log row (previously it was collapsed away while the `SetupResponse` still
  appeared). The log only merges the same-exchange buyer/supplier duplicates, not separate re-sends. The same dedup is applied to the PDF export, so printed
  evidence matches the on-screen log.
  - Fixed a stray NUL byte in the log dedup key.
  
  ### UX
  - The Buyer editor now notes that ShipTo/Contact appear in the `PunchOutSetupRequest` only when the buyer's **profile** enables it (otherwise they're sent
  in the `OrderRequest`).

  **Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.7.1...v0.8.0

## v0.7.1 — Real-world Jaggaer profiles (JAGGAER + SciQuest)

*Released 2026-06-08*

Patch release. Jaggaer is observed in the wild emitting **two** different cXML `UserAgent` strings — the modern `JAGGAER` and the legacy `SciQuest`
  (pre-2017 brand) — both on **DTD `1.2.011`** (confirmed on real OrderRequests). The built-in buyer profiles now reflect that reality.

  ### Changes
  - **`Jaggaer`** profile: `UserAgent: JAGGAER`, DTD `1.2.011` (previously a placeholder name/agent on `1.2.021`).
  - **`Jaggaer (SciQuest)`** profile (new): `UserAgent: SciQuest`, DTD `1.2.011` — identical otherwise, so you can reproduce either real tenant exactly in
  Mode A.
  - Existing installs are migrated automatically: an untouched built-in Jaggaer profile is refreshed to the observed values; user-edited profiles are left
  alone.

  **Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.7.0...v0.7.1

## v0.7.0 — Mode-B mock supplier honours edit / inspect

*Released 2026-06-04*

The virtual supplier now *acts on* an incoming `edit`/`inspect` PunchOut setup instead of always serving a fresh catalog — so you can exercise the full
  edit round-trip against the built-in mock supplier, not just the buyer-side document.

  ### Highlights
  
  **edit / inspect in the mock supplier.**
  - **edit** — catalog quantities are **pre-filled** from the carried `ItemOut` items (matched by `SupplierPartID` + `SupplierPartAuxiliaryID`); buyer items
  the catalog doesn't list appear as extra editable **"from cart"** rows, so an edit round-trips faithfully. A banner shows the pre-loaded count.
  - **inspect** — the carried item(s) render **read-only** and are returned unchanged on checkout.
  - **create** — unchanged.

  The pre-load is re-derived from the latest inbound `PunchOutSetupRequest` in the session log, so the catalog and the checkout always agree without any new
  server state.

  **Session identification.**
  - The full session id (`pos-…`) now shows in the **New-session source dropdown** and on the **session list**, so sessions stay identifiable when name and
  date collide.
  - Every session is listed as an edit/inspect source; sessions without a returned cart are shown **disabled** (`— no cart yet`) instead of silently filtered
  out.

  **Docs.** The Operations guide and PunchOut business primer were updated to reflect the new behaviour (the old "mock supplier ignores `ItemOut`" caveat is
  gone).

  ### Verification
  `tsc --noEmit` clean · **111/111 tests** passing (added parser + Mode-B edit/inspect integration coverage).

  **Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.6.1...v0.7.0

## v0.6.1 — Docs on GitHub Pages

*Released 2026-06-03*

Patch release: the documentation reports (Architecture, PunchOut business primer,
  Operations & usage guide) are now published to GitHub Pages and render as proper
  pages with diagrams. README links point at the rendered pages instead of raw
  in-repo HTML. No functional changes.

  **Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.6.0...v0.6.1

## v0.6.0 — First-class Sessions, edit/inspect operations & full docs

*Released 2026-06-03*

This release reworks session management into a proper workspace, adds the `edit`/`inspect` PunchOut operations, and ships three in-depth documentation
  reports.

  ### Highlights
  
  **Sessions are now a first-class workspace.**
  - New **Run / Configure** navigation: do PunchOut work in the **Sessions** tab, configure entities (Connections, Buyers, Suppliers, Products, Buyer
  Profiles) separately.
  - **Per-session message log** replaces the global firehose — parallel conversations no longer interleave.
  - **Resume** a historical Mode-A session (the flow state is reconstructed from the session log).
  - **Delete** a session and its log, with a path-containment guard so only files inside the sessions directory can be removed.

  **create / edit / inspect operations.**
  - The `PunchOutSetupRequest` now carries an `operation` attribute. `edit`/`inspect` include the prior cart items as `ItemOut` blocks, sourced from a chosen
  session.
  - *Note:* the built-in Mode-B mock supplier still serves a fresh catalog (it ignores incoming `ItemOut`), so against the simulator `edit`/`inspect`
  exercise the buyer-side document; cart pre-load needs a real supplier in Mode A. See the new Operations guide.

  **Cart view.**
  - Reordered columns (Description · SupplierPartID · Aux ID · Classification · UoM · Qty · Unit price), with right-aligned numeric columns.

  **Reliability.**
  - `/sim/:id/checkout` now **requires a `BuyerCookie`** — cookie-less checkouts are rejected (`400`) and create no session, fixing a phantom-session flood.

  **Documentation.**
  - Three self-contained HTML reports in [`docs/`](docs/): an **Architecture reference** (components, data model, Mode A/B sequence diagrams), a **PunchOut 
  business primer**, and an **Operations & usage guide**.

  ### Verification
  
  `tsc --noEmit` clean · **107/107 tests** passing.
  
  **Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.5.2...v0.6.0

## punchout-simulator v0.5.2

*Released 2026-06-03*

### Added
  - **Validate before send.** A **Validate** button next to each *Send* (SetupRequest, OrderRequest) lints the current — possibly hand-edited — cXML against
  its document rules, using the connection's expected credentials, **without sending anything**. The result shows inline in a "Pre-send validation" panel and
  clears when you edit the document. (`POST /api/connections/:id/validate`)
  - **Mock catalog follows the app theme.** The Mode-B catalog page now matches the app's light/dark mode (via a `?theme=` link param, with `localStorage` /
  OS-preference fallbacks) instead of being always dark.

  **Full changelog:** v0.5.1...v0.5.2

## punchout-simulator v0.5.1

*Released 2026-06-03*

### Fixed
  - **Response validation no longer reports missing credentials.** cXML responses (`SetupResponse`, `OrderResponse`) carry no `<Header>` with From/To/Sender
  by spec — those belong on requests and the punchback. The validator was emitting three spurious `missing-credential` warnings on every response; the
  credential check is now scoped to header-bearing document types. `payloadID`/`timestamp` checks still apply to all documents.

  **Full changelog:** v0.5.0...v0.5.1

## punchout-simulator v0.5.0

*Released 2026-06-03*

Ship-to / bill-to addresses and an end-user contact become first-class and configurable, with platform-aware emission. Before this, the OrderRequest
  emitted empty ShipTo/BillTo (hardcoded Country US) with no way to set them but hand-editing the cXML, and Contact wasn't supported at all.

  ### Addresses & Contact
  - **Buyer** now holds default **ShipTo** / **BillTo** addresses and an end-user **Contact** (name, email, phone). They pre-fill the OrderRequest (still
  fully editable as cXML) and, when the profile enables it, are carried in the **PunchOutSetupRequest** (Ariba-style).
  - Each address supports a full **PostalAddress** and/or an **`addressID`** (+ `addressIDDomain`) reference.

  ### Profile-driven emission (platform differences)
  - **`addressMode`** — `full` (PostalAddress), `id-only` (just `addressID`), or `both`.
  - **`shipToInSetup` / `contactInSetup`** — carry ShipTo/Contact already in the SetupRequest.
  - Presets: Ariba = `both` + ShipTo-in-setup; Coupa = `both`; SAP = `id-only` (plant codes); Jaggaer/Oracle/Workday = `full`. Existing profiles are
  auto-migrated on startup.

  ### Smart address editor
  - **Country** is an ISO-3166 picker (sets the ISO code **and** name); chosen first because it drives the rest.
  - **State / province** is a dropdown for the US and Canada, free text elsewhere.
  - **Postal code** gets a lenient, **non-blocking** per-country format hint.

  ### Validation
  - An emitted `ShipTo`/`BillTo` with neither an `addressID` nor a Street/City is now flagged; `Contact` must carry a `@role`.

  ### Housekeeping
  - Removed the internal `PUNCHOUT_SIMULATOR_SPEC.md` from the repo.

  **Full changelog:** v0.4.0...v0.5.0

## punchout-simulator v0.4.0

*Released 2026-06-03*

A catalog-focused release: product lists become a first-class, reusable entity, catalog items
  gain the fields real catalogs use, and you can bulk-load a catalog from CSV. Plus a cleaner
  Live Log and currency-correctness checks.
  
  ### Product Lists (new entity)
  - Reusable, named **Product Lists** managed in a new **Products** tab, assignable to one or
  more Suppliers. A supplier serves the **union** of its assigned lists as its Mode-B catalog.
  - The old inline per-supplier catalog is replaced by list assignment; existing inline catalogs
  are **auto-migrated** into a generated list on startup.
  - A built-in **Sample assortment** (~21 office/industrial items) ships out of the box and is
  loadable as a preset.

  ### Richer catalog items
  - **`SupplierPartAuxiliaryID`** on catalog items (flows into `ItemIn`/`ItemOut`).
  - **Multiple / custom-domain `Classification`** per item (e.g. `UNSPSC` + `eCl@ss`), replacing
  the single hardcoded UNSPSC.
  - Per-product **`allowFractional`** toggle — the Mode-B catalog accepts fractional quantities
  (e.g. `1.5` m) for opted-in items; others stay whole-number.

  ### CSV import
  - Import a real catalog into a product list from **CSV** (client-side; header row, free column
  order, generous aliases). Downloadable template included. Columns: `SupplierPartID`*, 
  `SupplierPartAuxiliaryID`, `Description`, `UnitPrice`, `Currency`, `UoM`, `UNSPSC` (or 
  `Classifications` as `UNSPSC:..;eCl@ss:..`), `ManufacturerPartID`, `ManufacturerName`, 
  `AllowFractional`.
  
  ### Currency correctness
  - A cXML `Total` is a single `Money`. Mixed-currency carts now emit `Total` `0` instead of a 
  meaningless cross-currency sum, and validation raises a **`mixed-currency`** error.
  - New per-Supplier **`allowMixedCurrency`** flag downgrades that to a non-blocking warning for 
  suppliers that genuinely handle multi-currency orders.

  ### Live Log
  - Compact **2-line** rows, **24-hour** timestamps, and **de-duplication** of the same wire 
  message logged from both simulated actors (the self-test loop).

  ### Docs
  - README updated for the data model (five entities), product lists, CSV import, and currency 
  handling.

  **Full changelog:** v0.3.1...v0.4.0

## v0.3.1

*Released 2026-06-03*

UI/UX polish and accessibility improvements on top of v0.3.0.

  ### ✨ Improvements
  - **App version shown in the header** — read from the running process via `/api/runtime`.
  - **First-run onboarding** — an empty-state on the Connections view explains Mode A/B and walks
  through the Buyer → Supplier → Connection setup with progress ticks and context-aware actions.

  ### ♿ Accessibility
  - **Full keyboard tab navigation** — a shared, ARIA-compliant tab component
  (`role=tablist`/`tab`, `aria-selected`, roving tabindex, Arrow/Home/End keys) now drives the
  section tabs, Flow/Settings, and the cXML/Raw toggle.
  - **Confirmation on destructive deletes** — buyer/supplier/profile/connection deletes are now a
  two-step inline confirm.
  - **Initial-load error banner** — a dismissible `role=alert` banner when the server is
  unreachable or the API token is required.

  **Full changelog:**
  https://github.com/slawomir-szostak/punchout-simulator/compare/v0.3.0...v0.3.1

## v0.3.0

*Released 2026-06-02*

Procurement-platform **Profiles**, a **light/dark theme**, a **raw multipart view**, and a full
  **pre-release security + accessibility hardening pass**.

  ### ✨ Features
  - **Per-Buyer procurement-platform Profiles** (Ariba / Coupa / Jaggaer / Oracle / SAP / Workday
  / Generic, loadable as presets). A profile drives how that buyer's cXML is emitted:
  **per-document-type DTD versions**, `UserAgent`, setup `operation`, attachment encoding
  default, cart-return transport, and `Extrinsic` templates.
  - **Raw (multipart) message view** with one-click **Copy** — see the full wire envelope
  (headers, boundaries, `Content-ID`, cXML + attachment parts), reconstructed on demand.
  - **Per-connection attachment encoding** — send `OrderRequest` attachments as `binary` or
  `base64` (`Content-Transfer-Encoding`).
  - **Light/dark theme toggle** — persisted, OS-preference aware, with the Monaco editor
  following along.

  ### 🔒 Security
  - **`/api` bound to `127.0.0.1` by default.** When the tool is **exposed** (a non-loopback
  `--public-url` or `--host`), `/api/*` now **requires a token** (auto-generated, or
  `--token`/`POS_TOKEN`), surfaced as a `?token=` URL. The inbound buyer surface (`/sim`,
  `/punchout`) stays open for Mode B.
  - **Shared secrets** are now **redacted from all logs / the live stream / the raw view** and
  are **write-only over the API** (masked on read).
  - **Cart-return XSS** fixed; **outbound SSRF guards** (http(s)-only, reject credentials-in-URL,
  no transparent cross-host redirects).
  - **XXE / entity-expansion** documents rejected; **24 MB request body limit**; **SSE connection
  cap**; data-dir/config/logs perms tightened to `0700/0600`; **Docker image runs as non-root**;
  source map dropped from the npm tarball.

  ### ♿ Accessibility & UX
  - Message-detail is now a proper **dialog** (focus trap, `Esc` to close, focus restore);
  **keyboard-navigable** sidebar rows and tabs; light-theme **contrast** fixes;
  sidebar/profile-editor layout fixes.

  ### 🐛 Fixes
  - **Dev:** Vite proxy scoped to route namespaces (a bare `/api` prefix was hijacking the SPA's
  own `/api.ts` module and blanking the app under `npm run dev`).
  - Added an SVG favicon.

  ### 📚 Docs
  - New "How procurement platforms differ in PunchOut requests" analysis; README updated for the
  profiles model, the theme, and the exposure/auth posture.

  > **⚠ Upgrade note:** the server now binds **loopback by default** and **requires a token when
  exposed**. Front it with ngrok/cloudflared via `--public-url` (token auto-generated). **Docker
  users:** the container binds `0.0.0.0` and therefore needs a token — set `-e POS_TOKEN=…` or 
  read the printed `?token=` URL.
  
  **Full changelog:** 
  https://github.com/slawomir-szostak/punchout-simulator/compare/v0.2.0...v0.3.0

## v0.2.0 — Normalized Buyer / Supplier / Connection model

*Released 2026-06-02*

This release reworks the core data model so that endpoints and identities live where they
  conceptually belong, instead of being flattened onto each connection.

  ### Highlights
  
  - **First-class `Buyer` and `Supplier` entities.** Each is reusable and holds only what's
  intrinsic to it:
    - **Buyer** — its own cXML identity (the `From` credential).
    - **Supplier** — its cXML identity (`To`) plus its **endpoints** (PunchOut URL, Order URL)
  and an optional mock catalog. Endpoints are defined once on the supplier, never per
  relationship.
  - **`Connection` is now just the Buyer↔Supplier edge.** It holds only pair-specific data:
  `mode`, the `sharedSecret` ("password") this buyer uses at this supplier, an optional per-pair
  **Sender identity override** (defaults to the buyer's identity), `authStyle`, and
  `deploymentMode`.
  - **New UI navigation:** Connections / Buyers / Suppliers, with dedicated editors. Creating a
  connection now means picking a buyer + supplier and setting the pair credentials.
  - **Mock supplier endpoints are keyed by supplier id** (`/sim/<supplierId>/…`), so a supplier's
  PunchOut/Order URL is set in exactly one place and reused by every connection that targets it.

  ### Also in this line
  
  - The OrderRequest is built into an editable Monaco view before sending — tweak `<Comments>`,
  addresses, attachment refs, anything.
  - Attachments can be scoped **per line item** (not just the whole order).
  - Flow state is a **persistent per-connection session**: switching tabs no longer resets an
  in-progress order, and the OrderRequest can be **edited and re-sent (retry)** after a supplier
  rejection.

  ### Breaking changes
  
  - The config/REST shape changed: new `/api/buyers` and `/api/suppliers` endpoints; connections
  now reference `buyerId` + `supplierId` instead of embedding
  `from`/`to`/`sender`/`punchoutUrl`/`orderUrl`.
  
  ### Migration
  
  - **Automatic.** On first launch, an existing `config.json` in the old flat format is split
  into Buyer / Supplier / Connection records (de-duplicating parties by identity, preserving
  connection ids, shared secrets, and the sender). No manual steps.
  
  ### Verified
  
  - 42 unit + integration tests, plus a headless-browser end-to-end run of the full flow (setup →
  catalog → punchback → editable order → send → retry).

  Install: `npx punchout-simulator`

## v0.1.5

*Released 2026-06-02*

No release notes were written for this version.

## v0.1.4

*Released 2026-06-02*

No release notes were written for this version.

## v0.1.3

*Released 2026-06-02*

No release notes were written for this version.

## v0.1.2

*Released 2026-06-02*

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/compare/v0.1.1...v0.1.2

## v0.1.1

*Released 2026-06-02*

**Full Changelog**: https://github.com/slawomir-szostak/punchout-simulator/commits/v0.1.1
