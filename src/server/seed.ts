import {
  createBuyer,
  createConnection,
  createSupplier,
  listConnections,
} from "./store/config.js";
import { getPublicUrl } from "./runtime.js";

// On first run (no connections), seed a self-contained demo: a Buyer and a
// Supplier, plus a Connection pairing them. The supplier's endpoints point at
// its own built-in mock (/sim/<supplierId>/...), so the full Mode A roundtrip
// runs immediately with no external partner.
export async function seedDemoIfEmpty(): Promise<void> {
  if (listConnections().length > 0) return;

  const buyer = await createBuyer({
    id: "demo-buyer",
    name: "Demo Buyer",
    identity: { domain: "DUNS", identity: "123456789" },
    // Exercise a non-default platform profile end-to-end (Coupa: per-doc-type
    // DTD versions, base64 attachments). Built-in profiles are seeded by initConfig.
    profileId: "coupa",
    // Default addresses + end-user contact, so the OrderRequest is populated and
    // the address feature is exercised out of the box.
    shipTo: {
      addressId: "1001", addressIdDomain: "buyerSystemID", name: "Demo Buyer HQ — Receiving",
      deliverTo: "Dock 3", street: "1 Market St", city: "San Francisco", state: "CA",
      postalCode: "94105", countryIsoCode: "US", countryName: "United States",
    },
    billTo: {
      addressId: "9001", addressIdDomain: "buyerSystemID", name: "Demo Buyer Accounts Payable",
      street: "1 Market St", city: "San Francisco", state: "CA",
      postalCode: "94105", countryIsoCode: "US", countryName: "United States",
    },
    contact: { role: "endUser", name: "Jane Buyer", email: "jane.buyer@demo.example", phone: "+1 555 0100" },
  });

  const supplier = await createSupplier({
    id: "demo-supplier",
    name: "Demo Supplier (built-in mock)",
    identity: { domain: "DUNS", identity: "987654321" },
    punchoutUrl: `${getPublicUrl()}/sim/demo-supplier/punchout`,
    orderUrl: `${getPublicUrl()}/sim/demo-supplier/order`,
    // Serve the built-in sample assortment (seeded by initConfig).
    productListIds: ["sample"],
  });

  await createConnection({
    id: "demo",
    name: "Demo Buyer → Demo Supplier",
    buyerId: buyer.id,
    supplierId: supplier.id,
    mode: "virtual-buyer",
    sharedSecret: "demo-secret",
    deploymentMode: "test",
  });
}
