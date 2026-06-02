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
  });

  const supplier = await createSupplier({
    id: "demo-supplier",
    name: "Demo Supplier (built-in mock)",
    identity: { domain: "DUNS", identity: "987654321" },
    punchoutUrl: `${getPublicUrl()}/sim/demo-supplier/punchout`,
    orderUrl: `${getPublicUrl()}/sim/demo-supplier/order`,
    catalog: [],
  });

  await createConnection({
    id: "demo",
    name: "Demo Buyer → Demo Supplier",
    buyerId: buyer.id,
    supplierId: supplier.id,
    mode: "virtual-buyer",
    sharedSecret: "demo-secret",
    deploymentMode: "test",
    authStyle: "SharedSecret",
  });
}
