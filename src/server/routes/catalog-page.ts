import { escapeXml } from "../cxml/build.js";

// The mock supplier's catalog page: a small webshop the person testing a
// PunchOut integration shops in. It is plain server-rendered HTML with one
// inline script — it has to work inside a buyer platform's iframe, on a
// different origin than the app, and with no assets to load (the tool runs
// offline), so there are no external fonts, images or libraries.
//
// The form is the state. Every product keeps a real <input name="q_N"> (and
// carried-over items "qx_N"), exactly what /checkout reads; the script only
// makes them pleasant to use (steppers, search, a live cart). Without script the
// inputs still work and the cart can still be returned.

/** One line of the page: a catalog product, or an item carried in from the buyer's cart. */
export interface CatalogRow {
  /** Form field name (q_N / qx_N). Absent on a read-only (inspect) line. */
  field?: string;
  description: string;
  partId: string;
  auxId?: string;
  manufacturer?: string;
  uom: string;
  currency: string;
  price: number;
  /** "UNSPSC 31161500" etc., already joined for display. */
  classification?: string;
  quantity: number;
  fractional: boolean;
  /** Marks a line that is not part of this catalog, e.g. "from cart". */
  tag?: string;
  /** True for the product the buyer punched out to (SelectedItem), exactly. */
  focused?: boolean;
}

/**
 * Where the buyer asked the catalog to open (PunchOutSetupRequest/SelectedItem).
 * A supplier decides what an item ID stands for; this catalog reads it as
 *  - `product` — it is exactly one of the catalog's part numbers: show that product;
 *  - `aisle`   — it matches several products (a common prefix, a maker, a
 *                classification code): show those;
 *  - `none`    — nothing matches: say so and show the whole store.
 */
export interface CatalogFocus {
  level: "product" | "aisle" | "none";
  /** The SelectedItem's ID as the buyer sent it (part, plus auxiliary ID if any). */
  label: string;
  /** What the search box starts with (empty for `none`). */
  term: string;
  /** How many products are shown for it. */
  matches: number;
}

export interface CatalogPageOptions {
  supplierName: string;
  /** Where the form posts: the supplier's /checkout URL. */
  checkoutUrl: string;
  cookie: string;
  /** create | edit | inspect */
  operation: string;
  /** False when the page was opened without a PunchOut session: nothing can be returned. */
  hasSession: boolean;
  /** How the buyer identified itself, e.g. "DUNS 123456789". */
  buyerLabel?: string;
  rows: CatalogRow[];
  /** Where to open, when the buyer named a SelectedItem. */
  focus?: CatalogFocus;
  /** Charges this supplier adds for this buyer, so the cart can preview them. */
  quote?: { taxRatePercent?: number; taxLabel?: string; shippingAmount?: number; shippingLabel?: string };
}

const e = escapeXml;

/**
 * A value as a JavaScript literal that is safe inside an inline <script>.
 * JSON.stringify alone is not: "</script>" would end the script element, and
 * U+2028 / U+2029 end a line in older engines. Each is written as a \uXXXX
 * escape, which JavaScript reads back as the same character.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
const money = (n: number): string => n.toFixed(2);

/** The text a product is searched by — the same on the page and on the server. */
export const rowSearchText = (r: Pick<CatalogRow, "description" | "partId" | "auxId" | "manufacturer" | "classification">): string =>
  [r.description, r.partId, r.auxId, r.manufacturer, r.classification].filter(Boolean).join(" ").toLowerCase();

/** True when every word of `term` occurs in the product's search text (the page's search rule). */
export const rowMatches = (r: Parameters<typeof rowSearchText>[0], term: string): boolean => {
  const text = rowSearchText(r);
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => text.includes(w));
};

function row(r: CatalogRow, index: number): string {
  const search = rowSearchText(r);
  const facts = [
    r.manufacturer ? `<span>${e(r.manufacturer)}</span>` : "",
    r.classification ? `<span>${e(r.classification)}</span>` : "",
    r.tag ? `<span class="tag">${e(r.tag)}</span>` : "",
  ].join("");
  const quantity = r.field
    ? `<div class="stepper">
          <button type="button" class="step" data-step="-1" aria-label="One less ${e(r.description)}">&minus;</button>
          <input type="number" name="${e(r.field)}" value="${e(r.quantity)}" min="0" step="${r.fractional ? "any" : "1"}" inputmode="${r.fractional ? "decimal" : "numeric"}" aria-label="Quantity of ${e(r.description)}">
          <button type="button" class="step" data-step="1" aria-label="One more ${e(r.description)}">+</button>
        </div>`
    : `<div class="fixed-qty"><span>${e(r.quantity)}</span> ${e(r.uom)}</div>`;
  return `<li class="product${r.quantity > 0 ? " in-cart" : ""}"${r.focused ? ' data-focus="1"' : ""} data-index="${index}" data-search="${e(search)}" data-price="${e(r.price)}" data-currency="${e(r.currency)}" data-name="${e(r.description)}" data-part="${e(r.partId)}">
        <div class="bin">
          <span class="part">${e(r.partId)}</span>${r.auxId ? `<span class="aux">${e(r.auxId)}</span>` : ""}
        </div>
        <div class="about">
          <h2>${e(r.description)}</h2>
          <p class="facts">${facts}</p>
        </div>
        <div class="price"><span class="amount">${e(money(r.price))}</span><span class="unit">${e(r.currency)} per ${e(r.uom)}</span></div>
        ${quantity}
      </li>`;
}

export function catalogPage(o: CatalogPageOptions): string {
  const inspect = o.operation === "inspect";
  const edit = o.operation === "edit";
  const count = o.rows.length;
  const notice = !o.hasSession
    ? `<p class="notice plain">Preview. This page was opened without a PunchOut session, so there is no buyer to return a cart to. Start from a PunchOutSetupResponse to shop for real.</p>`
    : inspect
      ? `<p class="notice">Inspect. The buyer asked to look at ${count === 1 ? "this item" : `these ${count} items`}. Nothing can be changed here, and no items are sent back.</p>`
      : edit
        ? `<p class="notice">Edit. The buyer's cart is loaded below. Change the quantities, then return the cart.</p>`
        : "";
  // Level 2 PunchOut: the buyer named the item it punched out from.
  const focus = inspect ? undefined : o.focus;
  const showAll = `<button type="button" class="linkish" id="show-all">Show the whole catalog</button>`;
  const focusNotice = !focus
    ? ""
    : focus.level === "product"
      ? `<p class="notice" id="focus-notice">The buyer punched out to <strong>${e(focus.label)}</strong>. Showing that product. ${showAll}</p>`
      : focus.level === "aisle"
        ? `<p class="notice" id="focus-notice">The buyer punched out to <strong>${e(focus.label)}</strong>. Showing the ${focus.matches} products that match. ${showAll}</p>`
        : `<p class="notice plain">The buyer punched out to <strong>${e(focus.label)}</strong>, which this catalog does not have. Showing the whole catalog.</p>`;
  const returnLabel = inspect ? "Return to buyer" : "Return cart to buyer";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(o.supplierName)} — catalog</title>
<script>
  // Match the main app's theme. The app appends ?theme= to the catalog link
  // (works even when the SPA is on a different origin, e.g. the Vite dev server);
  // otherwise fall back to a same-origin 'pos-theme' in localStorage, then the OS
  // preference. Set before paint to avoid a flash.
  (function () {
    try {
      var q = new URLSearchParams(location.search).get("theme");
      var t = (q === "light" || q === "dark") ? q : localStorage.getItem("pos-theme");
      if (t !== "light" && t !== "dark") {
        t = (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
      }
      document.documentElement.dataset.theme = t;
    } catch (e) {}
  })();
</script>
<style>
  /* A trade counter, not a boutique: petrol ink, floor-marking yellow, part
     numbers set like bin labels in the DIN-style face each system ships. */
  :root{
    --paper:#0d1c1f;--surface:#132a2e;--raised:#19363b;--ink:#e8f0ef;--muted:#93a9aa;--rule:#27464b;
    --petrol:#7fd0d3;--signal:#ffc61a;--on-signal:#10292d;--danger:#ff8a70;
    --label:"DIN Alternate","Bahnschrift","DIN Condensed","Roboto Condensed","Arial Narrow",system-ui,sans-serif;
    --body:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  }
  :root[data-theme="light"]{
    --paper:#e9eeed;--surface:#ffffff;--raised:#f4f7f6;--ink:#10292d;--muted:#56696b;--rule:#cfd9d8;
    --petrol:#0f4c53;--signal:#ffc61a;--on-signal:#10292d;--danger:#b3331a;
  }
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 var(--body)}
  button,input,select{font:inherit;color:inherit}
  :focus-visible{outline:3px solid var(--signal);outline-offset:2px}

  .shop{max-width:1180px;margin:0 auto;padding:0 20px 120px}
  header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:28px 0 18px;border-bottom:4px solid var(--signal)}
  header.top h1{margin:0;font:700 30px/1.05 var(--label);letter-spacing:.01em}
  header.top p{margin:0;color:var(--muted);font-size:13px;text-align:right}
  header.top p strong{color:var(--ink);font-weight:600}

  .notice{margin:16px 0 0;padding:11px 14px;background:var(--signal);color:var(--on-signal);font-weight:600;border-radius:3px}
  .notice.plain{background:var(--raised);color:var(--ink);font-weight:400;border:1px solid var(--rule)}
  .notice .linkish{color:inherit;font-weight:600;margin-left:6px}
  .notice .linkish:hover{color:inherit;text-decoration-thickness:2px}

  .layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:24px;align-items:start;margin-top:18px}
  .tools{display:flex;gap:10px;align-items:center;margin-bottom:10px}
  .search{flex:1;position:relative}
  .search input{width:100%;height:46px;padding:0 14px 0 42px;background:var(--surface);border:2px solid var(--rule);border-radius:3px;font-size:16px}
  .search input:focus{border-color:var(--petrol);outline:none}
  .search svg{position:absolute;left:13px;top:13px;width:20px;height:20px;stroke:var(--muted);fill:none;stroke-width:2;stroke-linecap:round}
  .tools select{height:46px;padding:0 10px;background:var(--surface);border:2px solid var(--rule);border-radius:3px}
  .count{margin:0 0 8px;color:var(--muted);font-size:13px}

  ul.products{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--rule);border-radius:3px}
  .product{display:grid;grid-template-columns:150px minmax(0,1fr) auto auto;gap:16px;align-items:center;padding:14px 16px;border-top:1px solid var(--rule);border-left:5px solid transparent}
  .product:first-child{border-top:0}
  .product.in-cart{border-left-color:var(--signal);background:var(--raised)}
  .bin{font-family:var(--label);border:1px solid var(--rule);border-left:5px solid var(--petrol);padding:6px 9px;background:var(--paper);min-width:0}
  .bin .part{display:block;font-size:17px;font-weight:700;line-height:1.15;overflow-wrap:anywhere}
  .bin .aux{display:block;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
  .about h2{margin:0;font-size:16px;font-weight:600;line-height:1.3}
  .facts{margin:3px 0 0;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:2px 14px}
  .facts .tag{background:var(--signal);color:var(--on-signal);padding:0 6px;border-radius:2px;font-weight:600}
  .price{text-align:right;white-space:nowrap}
  .price .amount{display:block;font:700 20px/1.1 var(--label);font-variant-numeric:tabular-nums}
  .price .unit{display:block;font-size:12px;color:var(--muted)}

  /* The control people actually use: finger-sized, and the number can be typed. */
  .stepper{display:flex;align-items:stretch;height:44px;border:2px solid var(--rule);border-radius:3px;background:var(--surface);overflow:hidden}
  .product.in-cart .stepper,.line .stepper{border-color:var(--petrol)}
  .stepper .step{width:44px;border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer}
  .stepper .step:hover{background:var(--signal);color:var(--on-signal)}
  .stepper input{width:58px;border:0;border-left:1px solid var(--rule);border-right:1px solid var(--rule);background:transparent;text-align:center;font:700 17px var(--label);font-variant-numeric:tabular-nums;-moz-appearance:textfield;appearance:textfield}
  .stepper input::-webkit-outer-spin-button,.stepper input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
  .stepper input:focus{outline:none;background:var(--raised)}
  .fixed-qty{font-family:var(--label);color:var(--muted);white-space:nowrap}
  .fixed-qty span{font-size:20px;font-weight:700;color:var(--ink)}
  .none{padding:28px 16px;color:var(--muted)}

  aside.cart{position:sticky;top:16px;background:var(--surface);border:1px solid var(--rule);border-top:4px solid var(--petrol);border-radius:3px;padding:16px}
  .cart h2{margin:0 0 4px;font:700 20px/1.2 var(--label)}
  .cart .empty{color:var(--muted);margin:8px 0 14px}
  ul.lines{list-style:none;margin:10px 0 0;padding:0;max-height:42vh;overflow:auto}
  .line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:10px 0;border-top:1px solid var(--rule)}
  .line .what{font-weight:600;font-size:14px;line-height:1.3}
  .line .ref{font-family:var(--label);color:var(--muted);font-size:13px}
  .line .sum{font:700 15px var(--label);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
  .line .controls{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .line .stepper{height:36px}
  .line .stepper .step{width:34px;font-size:19px}
  .line .stepper input{width:48px;font-size:15px}
  .linkish{border:0;background:none;padding:4px 0;color:var(--muted);text-decoration:underline;cursor:pointer}
  .linkish:hover{color:var(--danger)}
  dl.totals{margin:12px 0 0;padding-top:10px;border-top:2px solid var(--ink);display:grid;grid-template-columns:1fr auto;gap:4px 12px}
  dl.totals dt{color:var(--muted)}
  dl.totals dd{margin:0;text-align:right;font-family:var(--label);font-variant-numeric:tabular-nums}
  dl.totals .grand{font-size:19px;font-weight:700;color:var(--ink)}
  .small{font-size:12px;color:var(--muted);margin:8px 0 0}
  .actions{display:grid;gap:8px;margin-top:14px}
  .primary{height:50px;border:0;border-radius:3px;background:var(--signal);color:var(--on-signal);font:700 17px var(--label);letter-spacing:.01em;cursor:pointer}
  .primary:hover{filter:brightness(1.06)}
  .secondary{height:42px;border:2px solid var(--rule);border-radius:3px;background:transparent;cursor:pointer}
  .secondary:hover{border-color:var(--danger);color:var(--danger)}
  button[disabled]{opacity:.45;cursor:not-allowed}
  footer.fine{margin-top:22px;color:var(--muted);font-size:12px}

  /* Narrow (phones, and most procurement iframes): the cart docks to the bottom. */
  .dock{display:none}
  @media (max-width:860px){
    .layout{grid-template-columns:minmax(0,1fr)}
    aside.cart{position:static}
    .tools{flex-wrap:wrap}
    .search{flex:1 1 100%}
    .tools select{flex:1}
    .product{grid-template-columns:minmax(0,1fr) auto;gap:10px 12px}
    .bin{grid-column:1/-1;display:flex;gap:10px;align-items:baseline}
    .about{grid-column:1/-1}
    .price{text-align:left}
    .dock{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:5;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:var(--surface);border-top:4px solid var(--signal)}
    .dock strong{font:700 18px var(--label);font-variant-numeric:tabular-nums}
    .dock span{display:block;font-size:12px;color:var(--muted)}
    .dock a{display:inline-flex;align-items:center;height:44px;padding:0 16px;border-radius:3px;background:var(--signal);color:var(--on-signal);font:700 16px var(--label);text-decoration:none}
  }
  @media (prefers-reduced-motion:no-preference){.product{transition:background-color .15s}}
</style></head><body>
<form class="shop" method="post" action="${e(o.checkoutUrl)}" id="shop">
  <input type="hidden" name="cookie" value="${e(o.cookie)}">
  <header class="top">
    <h1>${e(o.supplierName)}</h1>
    <p>${o.buyerLabel ? `Shopping for <strong>${e(o.buyerLabel)}</strong><br>` : ""}Prices exclude tax and shipping</p>
  </header>
  ${notice}
  ${focusNotice}
  <div class="layout">
    <section aria-label="Products">
      ${
        inspect
          ? ""
          : `<div class="tools">
        <label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input type="search" id="search" value="${e(focus && focus.level !== "none" ? focus.term : "")}" placeholder="Search ${count} products by name, part number or maker" aria-label="Search products" autocomplete="off"></label>
        <select id="sort" aria-label="Sort products">
          <option value="index">Catalog order</option>
          <option value="name">Name A to Z</option>
          <option value="price">Price, low to high</option>
          <option value="cart">In cart first</option>
        </select>
      </div>
      <p class="count" id="count" aria-live="polite">${count} products</p>`
      }
      <ul class="products" id="products">
      ${o.rows.map(row).join("\n      ")}
      </ul>
      <p class="none" id="none" hidden>Nothing matches that search. Try a part number, or fewer words.</p>
    </section>

    <aside class="cart" id="cart" aria-label="Cart">
      <h2 id="cart-title">${inspect ? "Under inspection" : "Your cart"}</h2>
      <p class="empty" id="cart-empty">${
        inspect
          ? `${count} item${count === 1 ? "" : "s"}, shown as the buyer sent ${count === 1 ? "it" : "them"}.`
          : "Set a quantity on any product to put it in the cart."
      }</p>
      <ul class="lines" id="lines"></ul>
      <dl class="totals" id="totals" hidden></dl>
      <p class="small" id="totals-note" hidden></p>
      <div class="actions">
        <button type="submit" class="primary"${o.hasSession ? "" : " disabled"}>${returnLabel}</button>
        <button type="submit" class="secondary" name="action" value="cancel" formnovalidate${o.hasSession ? "" : " disabled"} title="Go back without a cart: the buyer gets an empty cart with Status 204">Cancel</button>
      </div>
    </aside>
  </div>
  <footer class="fine">A test catalog served by punchout-simulator, standing in for ${e(o.supplierName)}.</footer>
</form>
${inspect ? "" : `<div class="dock" id="dock"><div><strong id="dock-total">0 items</strong><span id="dock-sub"></span></div><a href="#cart">View cart</a></div>`}
<script>
(function () {
  var quote = ${scriptJson(o.quote ?? {})};
  var list = document.getElementById("products");
  var products = Array.prototype.slice.call(list.querySelectorAll(".product"));
  var lines = document.getElementById("lines");
  var totals = document.getElementById("totals");
  var note = document.getElementById("totals-note");
  var empty = document.getElementById("cart-empty");
  var title = document.getElementById("cart-title");
  var readOnly = ${inspect ? "true" : "false"};
  if (readOnly) return;

  function inputOf(p) { return p.querySelector("input[type=number]"); }
  function qtyOf(p) { var n = parseFloat(inputOf(p).value); return isFinite(n) && n > 0 ? n : 0; }
  function fmt(n) { return n.toFixed(2); }
  function trim(n) { return String(Math.round(n * 1000) / 1000); }
  function el(tag, cls, text) { var x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }

  function setQty(p, n) {
    var input = inputOf(p);
    n = Math.max(0, n);
    if (input.step !== "any") n = Math.floor(n);
    input.value = trim(n);
    render();
  }

  function stepper(p) {
    var box = el("div", "stepper");
    var less = el("button", "step", "\\u2212"); less.type = "button"; less.setAttribute("aria-label", "One less " + p.dataset.name);
    var more = el("button", "step", "+"); more.type = "button"; more.setAttribute("aria-label", "One more " + p.dataset.name);
    var field = el("input"); field.type = "number"; field.min = "0"; field.step = inputOf(p).step; field.value = trim(qtyOf(p));
    field.setAttribute("aria-label", "Quantity of " + p.dataset.name);
    less.addEventListener("click", function () { setQty(p, qtyOf(p) - 1); });
    more.addEventListener("click", function () { setQty(p, qtyOf(p) + 1); });
    field.addEventListener("change", function () { setQty(p, parseFloat(field.value) || 0); });
    field.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); field.blur(); } });
    box.appendChild(less); box.appendChild(field); box.appendChild(more);
    return box;
  }

  function render() {
    var chosen = products.filter(function (p) { return qtyOf(p) > 0; });
    products.forEach(function (p) { p.classList.toggle("in-cart", qtyOf(p) > 0); });
    lines.textContent = "";
    var byCurrency = {}, units = 0;
    chosen.forEach(function (p) {
      var q = qtyOf(p), price = parseFloat(p.dataset.price) || 0, cur = p.dataset.currency;
      byCurrency[cur] = (byCurrency[cur] || 0) + q * price;
      units += q;
      var li = el("li", "line");
      var what = el("div"); what.appendChild(el("div", "what", p.dataset.name)); what.appendChild(el("div", "ref", p.dataset.part));
      li.appendChild(what);
      li.appendChild(el("div", "sum", cur + " " + fmt(q * price)));
      var controls = el("div", "controls");
      controls.appendChild(stepper(p));
      var remove = el("button", "linkish", "Remove"); remove.type = "button";
      remove.addEventListener("click", function () { setQty(p, 0); });
      controls.appendChild(remove);
      li.appendChild(controls);
      lines.appendChild(li);
    });

    var currencies = Object.keys(byCurrency);
    title.textContent = chosen.length ? "Your cart, " + chosen.length + (chosen.length === 1 ? " line" : " lines") : "Your cart";
    empty.hidden = chosen.length > 0;
    totals.hidden = chosen.length === 0;
    totals.textContent = "";
    note.hidden = true;
    function total(label, value, cls) { var dt = el("dt", cls, label), dd = el("dd", cls, value); totals.appendChild(dt); totals.appendChild(dd); }
    var dockText = "";
    if (currencies.length === 1) {
      var cur = currencies[0], goods = byCurrency[cur], due = goods;
      var hasCharges = quote.shippingAmount != null || quote.taxRatePercent != null;
      total(hasCharges ? "Goods" : "Total", cur + " " + fmt(goods), hasCharges ? "" : "grand");
      if (quote.shippingAmount != null) { total(quote.shippingLabel || "Shipping", cur + " " + fmt(quote.shippingAmount)); due += quote.shippingAmount; }
      if (quote.taxRatePercent != null) {
        var tax = Math.round(goods * quote.taxRatePercent) / 100;
        total((quote.taxLabel || "Tax") + " (" + quote.taxRatePercent + "%)", cur + " " + fmt(tax)); due += tax;
      }
      if (hasCharges) total("To pay", cur + " " + fmt(due), "grand");
      dockText = cur + " " + fmt(due);
    } else if (currencies.length > 1) {
      currencies.forEach(function (c) { total("Goods in " + c, c + " " + fmt(byCurrency[c])); });
      note.textContent = "This cart mixes currencies, so it has no single total and no tax or shipping is added.";
      note.hidden = false;
      dockText = currencies.length + " currencies";
    }
    var dock = document.getElementById("dock-total");
    if (dock) {
      dock.textContent = chosen.length ? dockText : "Cart is empty";
      document.getElementById("dock-sub").textContent = chosen.length ? chosen.length + (chosen.length === 1 ? " line, " : " lines, ") + trim(units) + " units" : "";
    }
    if (document.getElementById("sort") && document.getElementById("sort").value === "cart") sort();
  }

  // Steppers and typed quantities on the product rows.
  list.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest(".step") : null;
    if (!b) return;
    var p = b.closest(".product");
    setQty(p, qtyOf(p) + Number(b.dataset.step));
  });
  list.addEventListener("input", function (ev) { if (ev.target.matches && ev.target.matches("input[type=number]")) render(); });
  // Enter in a quantity field must not submit the form and return the cart by accident.
  list.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target.matches && ev.target.matches("input[type=number]")) { ev.preventDefault(); ev.target.blur(); }
  });

  var search = document.getElementById("search");
  var count = document.getElementById("count");
  var none = document.getElementById("none");
  // A product-level punchout opens on exactly that product: while the search
  // box still holds the buyer's item ID, only the matching part is shown, not
  // everything that happens to contain the same text.
  var focusTerm = ${scriptJson(focus && focus.level === "product" ? focus.term : "")};
  function filter() {
    var words = search.value.toLowerCase().split(/\\s+/).filter(Boolean), shown = 0;
    var exact = focusTerm !== "" && search.value === focusTerm;
    products.forEach(function (p) {
      var hit = exact ? p.dataset.focus === "1" : words.every(function (w) { return p.dataset.search.indexOf(w) !== -1; });
      p.hidden = !hit;
      if (hit) shown++;
    });
    count.textContent = words.length ? shown + " of " + products.length + " products" : products.length + " products";
    none.hidden = shown > 0;
    list.hidden = shown === 0;
  }
  search.addEventListener("input", filter);
  search.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") ev.preventDefault();
    if (ev.key === "Escape") { search.value = ""; filter(); }
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) { ev.preventDefault(); search.focus(); }
  });

  var sortBy = document.getElementById("sort");
  function sort() {
    var by = sortBy.value;
    var key = function (p) {
      if (by === "name") return p.dataset.name.toLowerCase();
      if (by === "price") return parseFloat(p.dataset.price) || 0;
      if (by === "cart") return (qtyOf(p) > 0 ? 0 : 1) * 100000 + Number(p.dataset.index);
      return Number(p.dataset.index);
    };
    products.slice().sort(function (a, b) { var x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; }).forEach(function (p) { list.appendChild(p); });
  }
  sortBy.addEventListener("change", sort);

  var showAll = document.getElementById("show-all");
  if (showAll) {
    showAll.addEventListener("click", function () {
      search.value = "";
      filter();
      document.getElementById("focus-notice").hidden = true;
      search.focus();
    });
  }
  if (search.value) filter();

  render();
})();
</script>
</body></html>`;
}
