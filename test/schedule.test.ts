import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { buildOrderRequest, scheduleDateTime } from "../src/server/cxml/build.js";
import { orderDeliveries, parseXml } from "../src/server/cxml/parse.js";
import { validateDocument } from "../src/server/cxml/validate.js";
import { createBuyer, createConnection, initConfig } from "../src/server/store/config.js";
import { setDataDir } from "../src/server/store/paths.js";
import { setRuntime } from "../src/server/runtime.js";
import { seedDemoIfEmpty } from "../src/server/seed.js";
import { splitEvenly } from "../src/web/schedule.js";

// Delivery schedules. "ScheduleLine contains information related to delivery
// schedules for a line item": a quantity and a requested delivery date, both
// required, with the unit of measure — several of them split a line over dates.

const cred = (domain: string, identity: string) => ({ domain, identity });
const TS = "2026-01-01T10:00:00+01:00";
const item = { quantity: 5, supplierPartId: "P1", description: "Widget", uom: "EA", unitPriceAmount: 10, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] };
const order = (over: Partial<Parameters<typeof buildOrderRequest>[0]> = {}) =>
  buildOrderRequest({
    from: cred("DUNS", "123456789"), to: cred("DUNS", "987654321"), sender: cred("DUNS", "123456789"), sharedSecret: "demo-secret",
    orderId: "PO-SCH", orderDate: TS, payloadId: "p@h", timestamp: TS, currency: "USD", total: 50, items: [item],
    shipTo: { name: "HQ", street: "1 Main", city: "X" }, billTo: { name: "HQ", street: "1 Main", city: "X" }, ...over,
  });
const scheduled = (lines: { quantity: number; requestedDeliveryDate: string }[]) => order({ items: [{ ...item, scheduleLines: lines }] });
const codes = (xml: string) => validateDocument(xml).issues.map((i) => i.code);
const severityOf = (xml: string, code: string) => validateDocument(xml).issues.find((i) => i.code === code)?.severity;

describe("building", () => {
  it("turns a plain date into noon local time with an offset, and leaves a date-time alone", () => {
    expect(scheduleDateTime("2030-03-15")).toMatch(/^2030-03-15T12:00:00[+-]\d{2}:\d{2}$/);
    expect(scheduleDateTime("2030-03-15T08:30:00+01:00")).toBe("2030-03-15T08:30:00+01:00");
  });

  it("emits one ScheduleLine per delivery, numbered, with the line's unit, after Comments", () => {
    const xml = order({
      items: [{ ...item, scheduleLines: [{ quantity: 2, requestedDeliveryDate: "2030-03-01" }, { quantity: 3, requestedDeliveryDate: "2030-03-15" }] }],
      attachments: [{ contentId: "a@x", scope: { itemIndex: 1 } }],
    });
    expect(xml.match(/<ScheduleLine /g)).toHaveLength(2);
    expect(xml).toMatch(/<ScheduleLine quantity="2" requestedDeliveryDate="2030-03-01T12:00:00[+-]\d{2}:\d{2}" lineNumber="1">\s*<UnitOfMeasure>EA<\/UnitOfMeasure>/);
    expect(xml).toContain('lineNumber="2"');
    expect(xml.indexOf("</Comments>")).toBeLessThan(xml.indexOf("<ScheduleLine"));
    expect(xml.indexOf("<ScheduleLine")).toBeLessThan(xml.indexOf("</ItemOut>"));
    expect(validateDocument(xml).issues.filter((i) => i.severity !== "info")).toEqual([]);
  });

  it("leaves the schedule out for a DTD that predates ScheduleLine (1.2.025)", () => {
    const lines = [{ quantity: 5, requestedDeliveryDate: "2030-03-01" }];
    expect(order({ dtdVersion: "1.2.014", items: [{ ...item, scheduleLines: lines }] })).not.toContain("<ScheduleLine");
    expect(order({ dtdVersion: "1.2.025", items: [{ ...item, scheduleLines: lines }] })).toContain("<ScheduleLine");
  });

  it("lists an order's deliveries in date order", () => {
    const xml = order({
      items: [
        { ...item, scheduleLines: [{ quantity: 3, requestedDeliveryDate: "2030-03-15" }, { quantity: 2, requestedDeliveryDate: "2030-03-01" }] },
        { ...item, supplierPartId: "P2", scheduleLines: [{ quantity: 5, requestedDeliveryDate: "2030-03-08" }] },
      ],
      total: 100,
    });
    expect(orderDeliveries(parseXml(xml)).map((d) => `${d.part}:${d.quantity}:${d.date.slice(0, 10)}`)).toEqual(["P1:2:2030-03-01", "P2:5:2030-03-08", "P1:3:2030-03-15"]);
  });
});

describe("validation", () => {
  const good = scheduled([{ quantity: 2, requestedDeliveryDate: "2030-03-01" }, { quantity: 3, requestedDeliveryDate: "2030-03-15" }]);

  it("requires quantity, date and unit on every ScheduleLine", () => {
    expect(severityOf(good.replace(/<ScheduleLine quantity="2" /, "<ScheduleLine "), "scheduleline-missing-quantity")).toBe("error");
    expect(severityOf(good.replace(/ requestedDeliveryDate="2030-03-01[^"]*"/, ""), "scheduleline-missing-date")).toBe("error");
    expect(severityOf(good.replace(/(<ScheduleLine quantity="2"[^>]*>)\s*<UnitOfMeasure>EA<\/UnitOfMeasure>/, "$1"), "scheduleline-missing-uom")).toBe("error");
    expect(severityOf(good.replace(/requestedDeliveryDate="2030-03-01[^"]*"/, 'requestedDeliveryDate="next week"'), "scheduleline-date-format")).toBe("error");
  });

  it("warns when the deliveries do not add up to the line, or use another unit", () => {
    const short = scheduled([{ quantity: 2, requestedDeliveryDate: "2030-03-01" }, { quantity: 2, requestedDeliveryDate: "2030-03-15" }]);
    const issue = validateDocument(short).issues.find((i) => i.code === "scheduleline-quantity-mismatch");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("orders 5");
    expect(issue?.message).toContain("add up to 4");
    expect(codes(good)).not.toContain("scheduleline-quantity-mismatch");
    expect(codes(good.replace("<UnitOfMeasure>EA</UnitOfMeasure>\n        </ScheduleLine>", "<UnitOfMeasure>BX</UnitOfMeasure>\n        </ScheduleLine>"))).toContain("scheduleline-uom-differs");
  });

  it("checks the enumerated type, duplicate numbers, release info, and the declared DTD", () => {
    expect(severityOf(good.replace(/(<ScheduleLine quantity="2"[^>]*)>/, '$1 type="someday">'), "scheduleline-invalid-type")).toBe("error");
    expect(codes(good.replace(/(<ScheduleLine quantity="2"[^>]*)>/, '$1 type="forecast">'))).not.toContain("scheduleline-invalid-type");
    expect(codes(good.replace(/(<ScheduleLine quantity="3"[^>]*) lineNumber="2"/, '$1 lineNumber="1"'))).toContain("scheduleline-duplicate-number");
    const release = good.replace("<UnitOfMeasure>EA</UnitOfMeasure>\n        </ScheduleLine>", '<UnitOfMeasure>EA</UnitOfMeasure><ScheduleLineReleaseInfo commitmentCode="maybe"><UnitOfMeasure>EA</UnitOfMeasure></ScheduleLineReleaseInfo>\n        </ScheduleLine>');
    expect(codes(release)).toEqual(expect.arrayContaining(["scheduleline-invalid-commitment", "scheduleline-missing-cumulative"]));
    expect(codes(good.replace("cXML/1.2.045/", "cXML/1.2.014/"))).toContain("scheduleline-before-dtd");
    expect(codes(good)).not.toContain("scheduleline-before-dtd");
  });
});

describe("splitting a quantity into deliveries (the editor's helper)", () => {
  it("keeps whole quantities whole and puts the remainder first", () => {
    const three = splitEvenly(10, 3, "2030-01-01");
    expect(three.map((d) => d.quantity)).toEqual([4, 3, 3]);
    expect(three.map((d) => d.date)).toEqual(["2030-01-08", "2030-01-15", "2030-01-22"]);
    expect(splitEvenly(2, 4, "2030-01-01").map((d) => d.quantity)).toEqual([1, 1]); // never a zero delivery
  });
  it("divides a fractional quantity so the parts still add up", () => {
    const parts = splitEvenly(2.5, 3, "2030-01-01").map((d) => d.quantity);
    expect(parts).toHaveLength(3);
    expect(Math.round(parts.reduce((a, b) => a + b, 0) * 1000) / 1000).toBe(2.5);
  });
});

describe("over HTTP: an order with a delivery schedule", () => {
  let server: ReturnType<typeof serve>;
  let base = "";
  beforeAll(async () => {
    setDataDir(mkdtempSync(join(tmpdir(), "pos-sched-")));
    await initConfig();
    await new Promise<void>((resolve) => {
      server = serve({ fetch: createApp({ quiet: true }).fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        base = `http://127.0.0.1:${info.port}`;
        setRuntime({ port: info.port, publicUrl: base, token: undefined });
        resolve();
      });
    });
    await seedDemoIfEmpty();
  });
  afterAll(() => {
    server?.close();
  });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
  const widget = { quantity: 5, supplierPartId: "WIDGET-001", description: "Premium Steel Widget", uom: "EA", unitPriceAmount: 12.5, currency: "USD", classifications: [{ domain: "UNSPSC", value: "31161500" }] };
  const twoDeliveries = [{ quantity: 2, requestedDeliveryDate: "2030-03-01" }, { quantity: 3, requestedDeliveryDate: "2030-03-15" }];

  it("the mock supplier confirms the plan it was given", async () => {
    // A buyer on the generic profile (DTD 1.2.045, which has ScheduleLine).
    const buyer = await createBuyer({ name: "Planner", identity: cred("DUNS", "424242424"), profileId: "generic" });
    const conn = await createConnection({ name: "Planner → Demo", buyerId: buyer.id, supplierId: "demo-supplier", mode: "virtual-buyer", sharedSecret: "demo-secret", deploymentMode: "test" });
    const res = await post(`/api/connections/${conn.id}/order`, { sessionId: "sched-1", items: [{ ...widget, scheduleLines: twoDeliveries }], currency: "USD" });
    expect(res.request.body.match(/<ScheduleLine /g)).toHaveLength(2);
    expect(res.statusCode).toBe("200");
    expect(res.statusMessage).toMatch(/received for PO .*\. Delivery plan: 2 deliveries for 1 line, 2030-03-01 to 2030-03-15\.$/);
    // Nothing to say about the schedule itself (this buyer has no addresses, which is flagged separately).
    expect(res.request.validation.issues.filter((i: any) => i.code.startsWith("scheduleline"))).toEqual([]);

    // Rescheduling is a change order; cancelling leaves no plan to confirm.
    const change = await post(`/api/connections/${conn.id}/order`, { sessionId: "sched-1", orderType: "update", items: [{ ...widget, scheduleLines: [{ quantity: 5, requestedDeliveryDate: "2030-04-01" }] }], currency: "USD" });
    expect(change.statusMessage).toMatch(/updated to version 2 .* Delivery plan: 1 delivery for 1 line, on 2030-04-01\.$/);
    const cancel = await post(`/api/connections/${conn.id}/order`, { sessionId: "sched-1", orderType: "delete", items: [{ ...widget, scheduleLines: twoDeliveries }], currency: "USD" });
    expect(cancel.statusMessage).toMatch(/cancelled/);
    expect(cancel.statusMessage).not.toContain("Delivery plan");
  });

  it("says when a requested date has already passed, and drops unusable entries", async () => {
    const buyer = await createBuyer({ name: "Late Planner", identity: cred("DUNS", "434343434"), profileId: "generic" });
    const conn = await createConnection({ name: "Late → Demo", buyerId: buyer.id, supplierId: "demo-supplier", mode: "virtual-buyer", sharedSecret: "demo-secret", deploymentMode: "test" });
    const res = await post(`/api/connections/${conn.id}/order`, {
      sessionId: "sched-2",
      items: [{ ...widget, scheduleLines: [{ quantity: 2, requestedDeliveryDate: "2020-01-01" }, { quantity: 3, requestedDeliveryDate: "2030-03-15" }, { quantity: 0, requestedDeliveryDate: "2030-04-01" }, { quantity: 1, requestedDeliveryDate: "" }] }],
      currency: "USD",
    });
    expect(res.request.body.match(/<ScheduleLine /g)).toHaveLength(2);
    expect(res.statusMessage).toContain("1 of them is requested for a date already past and will ship as soon as possible.");
  });

  it("tells the buyer when its profile's DTD is too old to carry a schedule", async () => {
    // The demo buyer uses the Coupa preset, which sends orders as cXML 1.2.014.
    const preview = await post("/api/connections/demo/order/preview", { sessionId: "sched-3", items: [{ ...widget, scheduleLines: twoDeliveries }], currency: "USD" });
    expect(preview.xml).not.toContain("<ScheduleLine");
    expect(preview.notes).toHaveLength(1);
    expect(preview.notes[0]).toContain("ScheduleLine only exists from 1.2.025");
    const plain = await post("/api/connections/demo/order/preview", { sessionId: "sched-3", items: [widget], currency: "USD" });
    expect(plain.notes).toEqual([]);
  });
});
