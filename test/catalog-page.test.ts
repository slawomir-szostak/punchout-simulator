import { describe, expect, it } from "vitest";
import { catalogPage, type CatalogRow } from "../src/server/routes/catalog-page.js";

// The mock supplier's webshop page. The form is its state — every product keeps
// a real quantity input that /checkout reads — so these check the markup the
// checkout and the tests of the flows depend on, and that nothing a catalog or
// a buyer can put into it is rendered unescaped.

const product = (over: Partial<CatalogRow> = {}): CatalogRow => ({
  field: "q_0", description: "Premium Steel Widget", partId: "WIDGET-001", auxId: "WIDGET-001-STD", manufacturer: "Acme",
  uom: "EA", currency: "USD", price: 12.5, classification: "UNSPSC 31161500", quantity: 0, fractional: false, ...over,
});
const page = (over: Partial<Parameters<typeof catalogPage>[0]> = {}) =>
  catalogPage({ supplierName: "Demo Supplier", checkoutUrl: "http://localhost:8080/sim/demo/checkout", cookie: "c-1", operation: "create", hasSession: true, buyerLabel: "DUNS 123", rows: [product()], ...over });

describe("mock catalog page", () => {
  it("keeps one real quantity input per product, with the step the product allows", () => {
    const html = page({ rows: [product(), product({ field: "q_1", partId: "CABLE", fractional: true, quantity: 1.5 })] });
    expect(html).toContain('name="q_0" value="0" min="0" step="1"');
    expect(html).toContain('name="q_1" value="1.5" min="0" step="any"');
    expect(html).toContain('<input type="hidden" name="cookie" value="c-1">');
    expect(html).toContain('action="http://localhost:8080/sim/demo/checkout"');
    // Two ways out: return the cart, or cancel.
    expect(html).toContain(">Return cart to buyer</button>");
    expect(html).toContain('name="action" value="cancel"');
  });

  it("carries what the search matches on, and marks lines already in the cart", () => {
    const html = page({ operation: "edit", rows: [product({ quantity: 3 }), product({ field: "qx_0", partId: "EXTRA", tag: "from cart", quantity: 2 })] });
    expect(html).toContain('data-search="premium steel widget widget-001 widget-001-std acme unspsc 31161500"');
    expect(html).toContain('class="product in-cart"');
    expect(html).toContain("from cart");
    expect(html).toContain("Edit. The buyer's cart is loaded below.");
  });

  it("shows an inspect session without any quantity controls", () => {
    const html = page({ operation: "inspect", rows: [product({ field: undefined, quantity: 5 })] });
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('id="search"');
    expect(html).toContain(">Return to buyer</button>");
    expect(html).toContain("Inspect.");
  });

  it("cannot return a cart when opened without a PunchOut session", () => {
    const html = page({ hasSession: false, buyerLabel: undefined });
    expect(html).toContain("Preview.");
    expect(html).toMatch(/class="primary" disabled>/);
    expect(html).toMatch(/name="action" value="cancel" formnovalidate disabled/);
    expect(html).not.toContain("Shopping for");
  });

  it("passes the supplier's quote to the cart, and escapes everything it renders", () => {
    const html = page({
      supplierName: `<img src=x onerror=alert(1)>`,
      buyerLabel: `"><script>alert(2)</script>`,
      cookie: `"><script>alert(3)</script>`,
      rows: [product({ description: `<script>alert(4)</script>`, partId: `"onmouseover="alert(5)`, tag: "<b>x</b>" })],
      quote: { taxRatePercent: 23, taxLabel: "</script><script>alert(6)</script>", shippingAmount: 7.5 },
    });
    expect(html).toContain('"taxRatePercent":23');
    expect(html).toContain('"shippingAmount":7.5');
    for (let n = 1; n <= 6; n++) expect(html).not.toContain(`alert(${n})</script>`);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('"onmouseover="alert(5)"');
    expect(html).not.toContain("<b>x</b>");
    // Exactly the two scripts the page ships: the theme bootstrap and the shop.
    expect(html.match(/<script>/g)).toHaveLength(2);
  });
});
