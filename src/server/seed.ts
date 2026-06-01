import { createConnection, listConnections } from "./store/config.js";
import { getPublicUrl } from "./runtime.js";

// On first run (empty config), seed a self-contained demo pair: a built-in
// virtual-supplier and a virtual-buyer pointed at it. This makes the full Mode A
// roundtrip runnable immediately with no external partner.
export async function seedDemoIfEmpty(): Promise<void> {
  if (listConnections().length > 0) return;

  const supplier = await createConnection({
    id: "demo-supplier",
    name: "Demo Supplier (built-in mock)",
    mode: "virtual-supplier",
    from: { domain: "DUNS", identity: "987654321" }, // supplier identity (the tool)
    to: { domain: "DUNS", identity: "123456789" }, // buyer identity (counterparty)
    sender: { domain: "DUNS", identity: "987654321" },
    sharedSecret: "demo-secret",
    deploymentMode: "test",
    authStyle: "SharedSecret",
    catalog: [],
  });

  await createConnection({
    id: "demo-buyer",
    name: "Demo Buyer → built-in supplier",
    mode: "virtual-buyer",
    from: { domain: "DUNS", identity: "123456789" }, // buyer identity (the tool)
    to: { domain: "DUNS", identity: "987654321" }, // supplier identity (counterparty)
    sender: { domain: "DUNS", identity: "123456789" },
    sharedSecret: "demo-secret",
    deploymentMode: "test",
    authStyle: "SharedSecret",
    punchoutUrl: `${getPublicUrl()}/sim/${supplier.id}/punchout`,
    orderUrl: `${getPublicUrl()}/sim/${supplier.id}/order`,
  });
}
