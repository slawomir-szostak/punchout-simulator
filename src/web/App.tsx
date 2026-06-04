import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useStream } from "./hooks/useStream";
import { toggleTheme, useTheme } from "./hooks/useTheme";
import {
  emptySession,
  type Buyer,
  type Cart,
  type CartItem,
  type Connection,
  type ConnectionWithParties,
  type FlowSession,
  type LogRecord,
  type ProductList,
  type Profile,
  type SessionSummary,
  type Supplier,
} from "./types";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { BuyerEditor, ConfirmButton, SupplierEditor } from "./components/PartyEditors";
import { ProfileEditor } from "./components/ProfileEditor";
import { ProductListEditor } from "./components/ProductListEditor";
import { BuyerFlow } from "./components/BuyerFlow";
import { LiveLog } from "./components/LiveLog";
import { SessionList, type SessionRow } from "./components/SessionList";
import { NewSessionDialog, type NewSessionChoice } from "./components/NewSessionDialog";
import { MessageDetail } from "./components/MessageDetail";

type View = "sessions" | "connections" | "buyers" | "suppliers" | "products" | "profiles";
type Panel = "edit" | "new";
const NEW = "__new__";

/** A Mode-A session the user is actively driving (client-side flow state). */
interface Flow {
  connectionId: string;
  operation: string;
  sourceItems?: CartItem[];
  session: FlowSession;
}

const RUN_TABS: View[] = ["sessions"];
const CONFIG_TABS: View[] = ["connections", "buyers", "suppliers", "products", "profiles"];
const TAB_LABEL: Record<View, string> = {
  sessions: "Sessions",
  connections: "Connections",
  buyers: "Buyers",
  suppliers: "Suppliers",
  products: "Products",
  profiles: "Buyer Profiles",
};

export function App() {
  const [view, setView] = useState<View>("sessions");
  const [connections, setConnections] = useState<ConnectionWithParties[]>([]);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [productLists, setProductLists] = useState<ProductList[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);

  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("edit");
  const [selectedBuyerId, setSelectedBuyerId] = useState<string | null>(null);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [selectedProductListId, setSelectedProductListId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  // Sessions
  const [flows, setFlows] = useState<Record<string, Flow>>({});
  const [sessionSummaries, setSessionSummaries] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const flowSeq = useRef(0);
  const [loadedSessions, setLoadedSessions] = useState<Set<string>>(new Set());

  const [carts, setCarts] = useState<Record<string, Cart>>({});
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [detail, setDetail] = useState<LogRecord | null>(null);
  const [publicUrl, setPublicUrl] = useState<string>("");
  const [callbackUrl, setCallbackUrl] = useState<string>("");
  const [version, setVersion] = useState<string>("");
  const [bootError, setBootError] = useState<string | null>(null);

  const selectedConn = useMemo(
    () => connections.find((c) => c.id === selectedConnId) ?? null,
    [connections, selectedConnId],
  );

  const reloadConnections = useCallback(async () => {
    const list = await api.listConnections();
    setConnections(list);
    return list;
  }, []);
  const reloadBuyers = useCallback(async () => setBuyers(await api.buyers.list()), []);
  const reloadSuppliers = useCallback(async () => setSuppliers(await api.suppliers.list()), []);
  const reloadProductLists = useCallback(async () => setProductLists(await api.productLists.list()), []);
  const reloadProfiles = useCallback(async () => setProfiles(await api.profiles.list()), []);
  const reloadSessions = useCallback(async () => {
    try { setSessionSummaries(await api.listSessions()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    Promise.all([
      reloadConnections(),
      reloadBuyers(),
      reloadSuppliers(),
      reloadProductLists(),
      reloadProfiles(),
      reloadSessions(),
      api.runtime().then((r) => {
        setPublicUrl(r.publicUrl);
        setCallbackUrl(r.callbackUrl);
        setVersion(r.version ?? "");
      }),
    ])
      .then(() => setBootError(null))
      .catch((e) =>
        setBootError(
          e instanceof Error && /401|unauthor/i.test(e.message)
            ? "Could not load: the API requires a token (open the printed ?token= URL)."
            : "Could not reach the server. Is it still running?",
        ),
      );
    api.recent(200).then(setRecords).catch(() => {});
  }, [reloadConnections, reloadBuyers, reloadSuppliers, reloadProductLists, reloadProfiles, reloadSessions]);

  useStream({
    onLog: (record) => {
      setRecords((rs) => [...rs, record]);
      reloadSessions(); // new sessions / status changes surface in the list live
    },
    onCart: (_conn, cart) => setCarts((c) => ({ ...c, [cart.sessionId]: cart })),
  });

  // --- derived session selection ---
  const activeFlow = selectedSessionId ? flows[selectedSessionId] ?? null : null;
  const flowConn = activeFlow ? connections.find((c) => c.id === activeFlow.connectionId) ?? null : null;
  const serverSel = !activeFlow && selectedSessionId
    ? sessionSummaries.find((s) => s.sessionId === selectedSessionId) ?? null
    : null;
  const logSid = activeFlow ? activeFlow.session.buyerCookie : serverSel?.sessionId;
  const sessionRecords = logSid ? records.filter((r) => r.sessionId === logSid) : [];

  // Load a session's full history (beyond the recent window) when it's selected.
  useEffect(() => {
    if (!logSid || loadedSessions.has(logSid)) return;
    api.getSession(logSid).then((recs) => {
      setRecords((rs) => {
        const have = new Set(rs.map((r) => r.id));
        const add = recs.filter((r) => !have.has(r.id));
        return add.length ? [...rs, ...add] : rs;
      });
      setLoadedSessions((s) => new Set(s).add(logSid));
    }).catch(() => {});
  }, [logSid, loadedSessions]);

  // Lazily load the active flow's cart.
  useEffect(() => {
    const cookie = activeFlow?.session.buyerCookie;
    if (!cookie || carts[cookie]) return;
    api.getCart(cookie).then((cart) => cart && setCarts((c) => ({ ...c, [cookie]: cart }))).catch(() => {});
  }, [activeFlow?.session.buyerCookie, carts]);

  const patchFlowSession = useCallback((key: string, patch: Partial<FlowSession>) => {
    setFlows((f) => (f[key] ? { ...f, [key]: { ...f[key], session: { ...f[key].session, ...patch } } } : f));
  }, []);

  const deleteSession = async (id: string) => {
    const flow = flows[id];
    const sid = flow ? flow.session.buyerCookie : id; // server file is keyed by BuyerCookie
    if (sid) await api.deleteSession(sid).catch(() => {}); // ignore if there's no server file yet
    if (flow) setFlows((f) => { const n = { ...f }; delete n[id]; return n; });
    if (sid) {
      setRecords((rs) => rs.filter((r) => r.sessionId !== sid));
      setLoadedSessions((s) => { const n = new Set(s); n.delete(sid); return n; });
    }
    if (selectedSessionId === id) setSelectedSessionId(null);
    reloadSessions();
  };

  // Resume a historical Mode-A session: reconstruct its flow state from the log
  // records (setup XML + StartPage, order if any) and attach it as a live flow
  // bound to the same BuyerCookie, so the user can continue driving it.
  const resumeSession = async (sid: string, connectionId: string, operation: string) => {
    const recs = await api.getSession(sid).catch(() => [] as LogRecord[]);
    const find = (d: string, dir: string) => recs.find((r) => r.docType === d && r.direction === dir);
    const m = (re: RegExp, s?: string) => (s ? re.exec(s)?.[1] : undefined);
    const setupReq = find("SetupRequest", "out");
    const setupResp = find("SetupResponse", "in");
    const orderReq = find("OrderRequest", "out");
    const orderResp = find("OrderResponse", "in");
    const session: FlowSession = {
      ...emptySession(),
      buyerCookie: sid,
      setupXml: setupReq?.body ?? "",
      setupResult: setupReq && setupResp ? {
        buyerCookie: sid,
        httpStatus: setupResp.status ?? 200,
        startPage: m(/<StartPage>[\s\S]*?<URL>([\s\S]*?)<\/URL>/, setupResp.body),
        statusCode: m(/<Status[^>]*\bcode="([^"]+)"/, setupResp.body),
        request: setupReq,
        response: setupResp,
      } : null,
      orderXml: orderReq?.body ?? "",
      orderResult: orderReq && orderResp ? {
        httpStatus: orderResp.status ?? 200,
        statusCode: m(/<Status[^>]*\bcode="([^"]+)"/, orderResp.body),
        statusText: m(/<Status[^>]*\btext="([^"]+)"/, orderResp.body),
        request: orderReq,
        response: orderResp,
      } : null,
    };
    const key = `flow-${++flowSeq.current}`;
    setFlows((f) => ({ ...f, [key]: { connectionId, operation, session } }));
    setSelectedSessionId(key);
  };

  const startSession = (choice: NewSessionChoice) => {
    const key = `flow-${++flowSeq.current}`;
    setFlows((f) => ({ ...f, [key]: { connectionId: choice.connectionId, operation: choice.operation, sourceItems: choice.items, session: emptySession() } }));
    setSelectedSessionId(key);
    setShowNewSession(false);
    setView("sessions");
  };

  // --- connection handlers ---
  const saveConnection = async (data: Partial<Connection>) => {
    if (panel === "new" || !selectedConn) {
      const created = await api.createConnection(data);
      await reloadConnections();
      setSelectedConnId(created.id);
    } else {
      await api.updateConnection(selectedConn.id, data);
      await reloadConnections();
    }
    setPanel("edit");
  };
  const deleteConnection = async (id: string) => {
    await api.deleteConnection(id);
    const list = await reloadConnections();
    setSelectedConnId(list[0]?.id ?? null);
    setPanel("edit");
  };

  // --- buyer handlers ---
  const saveBuyer = async (data: Partial<Buyer>) => {
    if (selectedBuyerId === NEW || !selectedBuyerId) {
      const created = await api.buyers.create(data);
      await reloadBuyers();
      setSelectedBuyerId(created.id);
    } else {
      await api.buyers.update(selectedBuyerId, data);
      await reloadBuyers();
    }
  };
  const deleteBuyer = async (id: string) => {
    await api.buyers.remove(id);
    await reloadBuyers();
    setSelectedBuyerId(null);
  };

  // --- supplier handlers ---
  const saveSupplier = async (data: Partial<Supplier>) => {
    if (selectedSupplierId === NEW || !selectedSupplierId) {
      const created = await api.suppliers.create(data);
      await reloadSuppliers();
      setSelectedSupplierId(created.id);
    } else {
      await api.suppliers.update(selectedSupplierId, data);
      await reloadSuppliers();
    }
  };
  const deleteSupplier = async (id: string) => {
    await api.suppliers.remove(id);
    await reloadSuppliers();
    setSelectedSupplierId(null);
  };

  // --- product-list handlers ---
  const saveProductList = async (data: Partial<ProductList>) => {
    if (selectedProductListId === NEW || !selectedProductListId) {
      const created = await api.productLists.create(data);
      await reloadProductLists();
      setSelectedProductListId(created.id);
    } else {
      await api.productLists.update(selectedProductListId, data);
      await reloadProductLists();
    }
  };
  const deleteProductList = async (id: string) => {
    await api.productLists.remove(id);
    await reloadProductLists();
    setSelectedProductListId(null);
  };

  // --- profile handlers ---
  const saveProfile = async (data: Partial<Profile>) => {
    if (selectedProfileId === NEW || !selectedProfileId) {
      const created = await api.profiles.create(data);
      await reloadProfiles();
      setSelectedProfileId(created.id);
    } else {
      await api.profiles.update(selectedProfileId, data);
      await reloadProfiles();
    }
  };
  const deleteProfile = async (id: string) => {
    await api.profiles.remove(id);
    await reloadProfiles();
    setSelectedProfileId(null);
  };

  const selectedBuyer = buyers.find((b) => b.id === selectedBuyerId) ?? null;
  const selectedSupplier = suppliers.find((s) => s.id === selectedSupplierId) ?? null;
  const selectedProductList = productLists.find((p) => p.id === selectedProductListId) ?? null;
  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? null;

  // --- session list rows: active client flows first, then server-only sessions ---
  const flowCookies = new Set(Object.values(flows).map((f) => f.session.buyerCookie).filter(Boolean));
  const sessionRows: SessionRow[] = [
    ...Object.entries(flows).map(([key, f]): SessionRow => {
      const conn = connections.find((c) => c.id === f.connectionId);
      const cookie = f.session.buyerCookie;
      const summary = cookie ? sessionSummaries.find((s) => s.sessionId === cookie) : undefined;
      return {
        id: key,
        title: conn?.name ?? f.connectionId,
        subtitle: `${conn?.buyer?.name ?? "?"} → ${conn?.supplier?.name ?? "?"}${cookie ? ` · ${cookie.slice(0, 16)}…` : ""}`,
        operation: f.operation,
        hasErrors: summary?.hasErrors,
        draft: !cookie,
        count: summary?.count,
      };
    }),
    ...sessionSummaries
      .filter((s) => !flowCookies.has(s.sessionId))
      .map((s): SessionRow => ({
        id: s.sessionId,
        title: s.connectionName ?? (s.inbound ? `${s.supplierName ?? "Supplier"} · inbound` : s.sessionId),
        subtitle: [
          s.buyerName && s.supplierName ? `${s.buyerName} → ${s.supplierName}` : null,
          s.lastTs ? new Date(s.lastTs).toLocaleTimeString([], { hour12: false }) : null,
          s.sessionId,
        ]
          .filter(Boolean)
          .join(" · "),
        operation: s.operation,
        hasErrors: s.hasErrors,
        inbound: s.inbound,
        count: s.count,
      })),
  ];

  const hasBuyerConn = connections.some((c) => c.mode === "virtual-buyer");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span> punchout-simulator
          {version && <span className="brand-version">v{version}</span>}
        </div>
        <div className="topbar-right">
          <span className="topbar-meta">callback: <code>{callbackUrl || "…"}</code></span>
          <ThemeToggle />
        </div>
      </header>

      {bootError && (
        <div className="app-banner" role="alert">
          <span>{bootError}</span>
          <button className="btn-link" onClick={() => setBootError(null)}>dismiss ✕</button>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <nav className="viewnav" aria-label="Sections">
            <div className="viewnav-group">Run</div>
            {RUN_TABS.map((v) => (
              <button key={v} className={`viewtab ${view === v ? "active" : ""}`} aria-current={view === v ? "page" : undefined} onClick={() => setView(v)}>{TAB_LABEL[v]}</button>
            ))}
            <div className="viewnav-group">Configure</div>
            {CONFIG_TABS.map((v) => (
              <button key={v} className={`viewtab ${view === v ? "active" : ""}`} aria-current={view === v ? "page" : undefined} onClick={() => setView(v)}>{TAB_LABEL[v]}</button>
            ))}
          </nav>

          {view === "sessions" && (
            <SessionList rows={sessionRows} selectedId={selectedSessionId} onSelect={setSelectedSessionId} onNew={() => setShowNewSession(true)} />
          )}

          {view === "connections" && (
            <>
              <div className="sidebar-head">
                <span>Connections</span>
                <button className="btn-secondary" onClick={() => { setPanel("new"); setSelectedConnId(null); }}>+ New</button>
              </div>
              <ul className="conn-list">
                {connections.map((c) => {
                  const select = () => { setSelectedConnId(c.id); setPanel("edit"); };
                  const active = c.id === selectedConnId && panel !== "new";
                  return (
                    <li key={c.id} className={active ? "active" : ""} role="button" tabIndex={0}
                        aria-current={active ? "true" : undefined}
                        onClick={select}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } }}>
                      <span className={`mode-dot mode-${c.mode}`} />
                      <div className="conn-name">{c.name}</div>
                      <div className="conn-mode">{c.buyer?.name} → {c.supplier?.name}</div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {view === "buyers" && (
            <EntityList title="Buyers" items={buyers} selectedId={selectedBuyerId}
              onSelect={setSelectedBuyerId} onNew={() => setSelectedBuyerId(NEW)}
              subtitle={(b) => `${b.identity.domain}/${b.identity.identity}`} />
          )}
          {view === "suppliers" && (
            <EntityList title="Suppliers" items={suppliers} selectedId={selectedSupplierId}
              onSelect={setSelectedSupplierId} onNew={() => setSelectedSupplierId(NEW)}
              subtitle={(s) => `${s.identity.domain}/${s.identity.identity}`} />
          )}
          {view === "products" && (
            <EntityList title="Product lists" items={productLists} selectedId={selectedProductListId}
              onSelect={setSelectedProductListId} onNew={() => setSelectedProductListId(NEW)}
              subtitle={(p) => `${p.items.length} items`} />
          )}
          {view === "profiles" && (
            <EntityList title="Buyer profiles" items={profiles} selectedId={selectedProfileId}
              onSelect={setSelectedProfileId} onNew={() => setSelectedProfileId(NEW)}
              subtitle={(p) => p.platform ?? "custom"} />
          )}
        </aside>

        <main className="main">
          {view === "sessions" && (
            <>
              {activeFlow && flowConn && (
                <>
                  <div className="main-head">
                    <h2>{flowConn.name} <span className="hint">— {flowConn.buyer?.name} → {flowConn.supplier?.name}</span></h2>
                    <ConfirmButton onConfirm={() => deleteSession(selectedSessionId!)} label="Delete session" confirmLabel="Confirm delete?" />
                  </div>
                  <BuyerFlow
                    connection={flowConn}
                    session={activeFlow.session}
                    cart={activeFlow.session.buyerCookie ? carts[activeFlow.session.buyerCookie] ?? null : null}
                    operation={activeFlow.operation}
                    sourceItems={activeFlow.sourceItems}
                    onChange={(patch) => patchFlowSession(selectedSessionId!, patch)}
                  />
                  <SessionLog records={sessionRecords} connections={connections} onSelect={setDetail} />
                </>
              )}
              {serverSel && (
                <>
                  <div className="main-head">
                    <h2>
                      {serverSel.connectionName ?? (serverSel.inbound ? `${serverSel.supplierName ?? "Supplier"} · inbound` : "Session")}
                      {serverSel.operation && serverSel.operation !== "create" && <span className="badge badge-warn" style={{ marginLeft: ".5rem" }}>{serverSel.operation}</span>}
                    </h2>
                    <ConfirmButton onConfirm={() => deleteSession(selectedSessionId!)} label="Delete session" confirmLabel="Confirm delete?" />
                  </div>
                  {(() => {
                    const resumable = !serverSel.inbound
                      ? connections.find((c) => c.id === serverSel.connectionId && c.mode === "virtual-buyer")
                      : undefined;
                    return (
                      <>
                        <p className="hint">
                          {serverSel.inbound
                            ? "Initiated by an external buyer against this tool's Mode-B endpoint. Read-only log."
                            : "From an earlier run."}
                          {" "}Session: <code>{serverSel.sessionId}</code>
                        </p>
                        {resumable && (
                          <div className="step-actions" style={{ marginTop: 0, marginBottom: ".6rem" }}>
                            <button className="btn-primary" onClick={() => resumeSession(serverSel.sessionId, resumable.id, serverSel.operation ?? "create")}>
                              Continue this session →
                            </button>
                            <span className="hint">Reattach as a live flow to send more requests on this BuyerCookie.</span>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  <SessionLog records={sessionRecords} connections={connections} onSelect={setDetail} />
                </>
              )}
              {!selectedSessionId && (
                <SessionsEmpty hasBuyerConn={hasBuyerConn} onNew={() => setShowNewSession(true)} onConfigure={() => setView("connections")} />
              )}
            </>
          )}

          {view === "connections" && (
            <>
              {panel === "new" && (<><h2>New connection</h2>
                <ConnectionEditor connection={null} buyers={buyers} suppliers={suppliers} onSave={saveConnection} /></>)}

              {panel !== "new" && selectedConn && (
                <>
                  <div className="main-head"><h2>{selectedConn.name}</h2></div>
                  <ConnectionEditor connection={selectedConn} buyers={buyers} suppliers={suppliers}
                    onSave={saveConnection} onDelete={deleteConnection} />
                  {selectedConn.mode === "virtual-supplier" && <SupplierPanel supplier={selectedConn.supplier} publicUrl={publicUrl} />}
                </>
              )}
              {panel !== "new" && !selectedConn && connections.length === 0 && (
                <Onboarding
                  hasBuyers={buyers.length > 0}
                  hasSuppliers={suppliers.length > 0}
                  onNewConnection={() => { setPanel("new"); setSelectedConnId(null); }}
                  onAddBuyer={() => { setView("buyers"); setSelectedBuyerId(NEW); }}
                  onAddSupplier={() => { setView("suppliers"); setSelectedSupplierId(NEW); }}
                />
              )}
              {panel !== "new" && !selectedConn && connections.length > 0 && (
                <p className="hint">Pick a connection to edit, or run it from the Sessions tab.</p>
              )}
            </>
          )}

          {view === "buyers" && (
            <>
              <h2>{selectedBuyerId === NEW ? "New buyer" : selectedBuyer?.name ?? "Buyers"}</h2>
              {selectedBuyerId ? (
                <BuyerEditor buyer={selectedBuyerId === NEW ? null : selectedBuyer} profiles={profiles} onSave={saveBuyer} onDelete={deleteBuyer} />
              ) : <p className="hint">Select a buyer or create one.</p>}
            </>
          )}

          {view === "suppliers" && (
            <>
              <h2>{selectedSupplierId === NEW ? "New supplier" : selectedSupplier?.name ?? "Suppliers"}</h2>
              {selectedSupplierId ? (
                <SupplierEditor supplier={selectedSupplierId === NEW ? null : selectedSupplier} productLists={productLists} onSave={saveSupplier} onDelete={deleteSupplier} />
              ) : <p className="hint">Select a supplier or create one.</p>}
            </>
          )}

          {view === "products" && (
            <>
              <h2>{selectedProductListId === NEW ? "New product list" : selectedProductList?.name ?? "Product lists"}</h2>
              {selectedProductListId ? (
                <ProductListEditor list={selectedProductListId === NEW ? null : selectedProductList} onSave={saveProductList} onDelete={deleteProductList} />
              ) : <p className="hint">Select a product list or create one. A built-in sample list is included; assign lists to a Supplier to serve them as its catalog.</p>}
            </>
          )}

          {view === "profiles" && (
            <>
              <h2>{selectedProfileId === NEW ? "New buyer profile" : selectedProfile?.name ?? "Buyer profiles"}</h2>
              {selectedProfileId ? (
                <ProfileEditor profile={selectedProfileId === NEW ? null : selectedProfile} onSave={saveProfile} onDelete={deleteProfile} />
              ) : <p className="hint">Select a buyer profile or create one. Built-in presets (Ariba, Coupa, …) are listed here. Assign a profile to a Buyer to control how its cXML is emitted.</p>}
            </>
          )}
        </main>
      </div>

      {showNewSession && (
        <NewSessionDialog connections={connections} sessions={sessionSummaries} onCancel={() => setShowNewSession(false)} onCreate={startSession} />
      )}
      {detail && <MessageDetail record={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function SessionLog({ records, connections, onSelect }: { records: LogRecord[]; connections: Connection[]; onSelect: (r: LogRecord) => void }) {
  return (
    <section className="session-log">
      <div className="logpane-head">Messages ({records.length})</div>
      <LiveLog records={records} connections={connections} onSelect={onSelect} />
    </section>
  );
}

function SessionsEmpty({ hasBuyerConn, onNew, onConfigure }: { hasBuyerConn: boolean; onNew: () => void; onConfigure: () => void }) {
  return (
    <div className="onboarding">
      <h2>Sessions</h2>
      <p>A session is one PunchOut conversation (a <code>BuyerCookie</code>): SetupRequest → catalog → cart → OrderRequest. Each session keeps its own message log.</p>
      {hasBuyerConn ? (
        <>
          <p>Start one to drive a supplier (Mode A), or pick an existing session on the left. Sessions started by an external buyer against a Mode-B endpoint appear here automatically.</p>
          <div className="form-actions"><button className="btn-primary" onClick={onNew}>+ New session</button></div>
        </>
      ) : (
        <>
          <p>You need a <strong>virtual-buyer</strong> connection to start a session.</p>
          <div className="form-actions"><button className="btn-secondary" onClick={onConfigure}>Go to Connections</button></div>
        </>
      )}
    </div>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="theme-toggle"
      onClick={toggleTheme}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

function EntityList<T extends { id: string; name: string }>({
  title, items, selectedId, onSelect, onNew, subtitle,
}: {
  title: string; items: T[]; selectedId: string | null;
  onSelect: (id: string) => void; onNew: () => void; subtitle: (it: T) => string;
}) {
  return (
    <>
      <div className="sidebar-head">
        <span>{title}</span>
        <button className="btn-secondary" onClick={onNew}>+ New</button>
      </div>
      <ul className="conn-list">
        {items.map((it) => (
          <li
            key={it.id}
            className={`entity-row ${it.id === selectedId ? "active" : ""}`}
            role="button"
            tabIndex={0}
            aria-current={it.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(it.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(it.id); } }}
          >
            <div className="conn-name">{it.name}</div>
            <div className="conn-mode">{subtitle(it)}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

function Onboarding({
  hasBuyers,
  hasSuppliers,
  onNewConnection,
  onAddBuyer,
  onAddSupplier,
}: {
  hasBuyers: boolean;
  hasSuppliers: boolean;
  onNewConnection: () => void;
  onAddBuyer: () => void;
  onAddSupplier: () => void;
}) {
  const ready = hasBuyers && hasSuppliers;
  return (
    <div className="onboarding">
      <h2>Welcome to punchout-simulator</h2>
      <p>
        It plays the missing side of a cXML PunchOut conversation so you can exercise an
        integration end-to-end. It runs in two modes:
      </p>
      <ul>
        <li><strong>Virtual Buyer (Mode A)</strong> — the tool acts as the procurement system and drives a real supplier's catalog.</li>
        <li><strong>Virtual Supplier (Mode B)</strong> — the tool serves a mock catalog and accepts a real buyer's requests.</li>
      </ul>
      <p>Set it up in three steps:</p>
      <ol className="onboarding-steps">
        <li className={hasBuyers ? "done" : ""}><strong>Buyer</strong> — holds its cXML <code>From</code> identity.</li>
        <li className={hasSuppliers ? "done" : ""}><strong>Supplier</strong> — holds its <code>To</code> identity, endpoints, and the product lists it serves as its mock catalog.</li>
        <li><strong>Connection</strong> — pairs a Buyer with a Supplier and picks the mode. Then run it from the Sessions tab.</li>
      </ol>
      <div className="form-actions">
        <button className="btn-primary" onClick={onNewConnection} disabled={!ready}>+ New connection</button>
        {!hasBuyers && <button className="btn-secondary" onClick={onAddBuyer}>Add a Buyer</button>}
        {!hasSuppliers && <button className="btn-secondary" onClick={onAddSupplier}>Add a Supplier</button>}
      </div>
      {!ready && <p className="hint">Create at least one Buyer and one Supplier first, then pair them in a connection.</p>}
    </div>
  );
}

function SupplierPanel({ supplier, publicUrl }: { supplier?: Supplier; publicUrl: string }) {
  const theme = useTheme();
  if (!supplier) return <p className="hint">Supplier not found.</p>;
  const base = `${publicUrl}/sim/${supplier.id}`;
  return (
    <div className="supplier-panel">
      <p className="hint">
        This connection runs in <strong>virtual-supplier</strong> mode: the tool serves
        <strong> {supplier.name}</strong>'s mock catalog. A real buyer system points at these endpoints
        (they're intrinsic to the supplier):
      </p>
      <table className="kv"><tbody>
        <tr><td>PunchOut setup</td><td><code>{base}/punchout</code></td></tr>
        <tr><td>Order</td><td><code>{base}/order</code></td></tr>
        <tr><td>Catalog (preview)</td><td><a href={`${base}/catalog?theme=${theme}`} target="_blank" rel="noreferrer">{base}/catalog ↗</a></td></tr>
      </tbody></table>
      <p className="hint">Incoming requests appear as sessions in the Sessions tab.</p>
    </div>
  );
}
