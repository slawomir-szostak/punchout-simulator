import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useStream } from "./hooks/useStream";
import { toggleTheme, useTheme } from "./hooks/useTheme";
import {
  emptySession,
  type Buyer,
  type Cart,
  type Connection,
  type ConnectionWithParties,
  type FlowSession,
  type LogRecord,
  type Profile,
  type Supplier,
} from "./types";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { BuyerEditor, SupplierEditor } from "./components/PartyEditors";
import { ProfileEditor } from "./components/ProfileEditor";
import { BuyerFlow } from "./components/BuyerFlow";
import { LiveLog } from "./components/LiveLog";
import { MessageDetail } from "./components/MessageDetail";

type View = "connections" | "buyers" | "suppliers" | "profiles";
type Panel = "flow" | "edit" | "new";
const NEW = "__new__";

export function App() {
  const [view, setView] = useState<View>("connections");
  const [connections, setConnections] = useState<ConnectionWithParties[]>([]);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);

  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("flow");
  const [selectedBuyerId, setSelectedBuyerId] = useState<string | null>(null);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  const [carts, setCarts] = useState<Record<string, Cart>>({});
  const [sessions, setSessions] = useState<Record<string, FlowSession>>({});
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
    setSelectedConnId((cur) => cur ?? list[0]?.id ?? null);
    return list;
  }, []);
  const reloadBuyers = useCallback(async () => setBuyers(await api.buyers.list()), []);
  const reloadSuppliers = useCallback(async () => setSuppliers(await api.suppliers.list()), []);
  const reloadProfiles = useCallback(async () => setProfiles(await api.profiles.list()), []);

  useEffect(() => {
    Promise.all([
      reloadConnections(),
      reloadBuyers(),
      reloadSuppliers(),
      reloadProfiles(),
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
  }, [reloadConnections, reloadBuyers, reloadSuppliers, reloadProfiles]);

  useStream({
    onLog: (record) => setRecords((rs) => [...rs, record]),
    onCart: (_conn, cart) => setCarts((c) => ({ ...c, [cart.sessionId]: cart })),
  });

  useEffect(() => {
    const cookie = selectedConnId ? sessions[selectedConnId]?.buyerCookie : undefined;
    if (!cookie || carts[cookie]) return;
    api.getCart(cookie).then((cart) => cart && setCarts((c) => ({ ...c, [cookie]: cart }))).catch(() => {});
  }, [selectedConnId, sessions, carts]);

  const patchSession = useCallback((id: string, patch: Partial<FlowSession>) => {
    setSessions((s) => ({ ...s, [id]: { ...(s[id] ?? emptySession()), ...patch } }));
  }, []);
  const newSession = useCallback((id: string) => setSessions((s) => ({ ...s, [id]: emptySession() })), []);

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
    setPanel("flow");
  };
  const deleteConnection = async (id: string) => {
    await api.deleteConnection(id);
    const list = await reloadConnections();
    setSelectedConnId(list[0]?.id ?? null);
    setPanel("flow");
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
  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? null;

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
          <div className="viewtabs">
            {(["connections", "buyers", "suppliers", "profiles"] as View[]).map((v) => (
              <button
                key={v}
                className={view === v ? "viewtab active" : "viewtab"}
                aria-current={view === v ? "page" : undefined}
                onClick={() => setView(v)}
              >
                {v}
              </button>
            ))}
          </div>

          {view === "connections" && (
            <>
              <div className="sidebar-head">
                <span>Connections</span>
                <button className="btn-secondary" onClick={() => { setPanel("new"); setSelectedConnId(null); }}>+ New</button>
              </div>
              <ul className="conn-list">
                {connections.map((c) => {
                  const select = () => { setSelectedConnId(c.id); setPanel("flow"); };
                  return (
                  <li key={c.id} className={c.id === selectedConnId && panel !== "new" ? "active" : ""}
                      role="button" tabIndex={0}
                      aria-current={c.id === selectedConnId && panel !== "new" ? "true" : undefined}
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
          {view === "profiles" && (
            <EntityList title="Profiles" items={profiles} selectedId={selectedProfileId}
              onSelect={setSelectedProfileId} onNew={() => setSelectedProfileId(NEW)}
              subtitle={(p) => p.platform ?? "custom"} />
          )}
        </aside>

        <main className="main">
          {view === "connections" && (
            <>
              {panel === "new" && (<><h2>New connection</h2>
                <ConnectionEditor connection={null} buyers={buyers} suppliers={suppliers} onSave={saveConnection} /></>)}

              {panel !== "new" && selectedConn && (
                <>
                  <div className="main-head">
                    <h2>{selectedConn.name}</h2>
                    <div className="tabs">
                      <button className={panel === "flow" ? "tab active" : "tab"} aria-current={panel === "flow" ? "page" : undefined} onClick={() => setPanel("flow")}>Flow</button>
                      <button className={panel === "edit" ? "tab active" : "tab"} aria-current={panel === "edit" ? "page" : undefined} onClick={() => setPanel("edit")}>Settings</button>
                    </div>
                  </div>

                  {panel === "edit" && (
                    <ConnectionEditor connection={selectedConn} buyers={buyers} suppliers={suppliers}
                      onSave={saveConnection} onDelete={deleteConnection} />
                  )}
                  {panel === "flow" && selectedConn.mode === "virtual-buyer" && (
                    <BuyerFlow connection={selectedConn}
                      session={sessions[selectedConn.id] ?? emptySession()}
                      cart={sessions[selectedConn.id]?.buyerCookie ? carts[sessions[selectedConn.id].buyerCookie] ?? null : null}
                      onChange={(patch) => patchSession(selectedConn.id, patch)}
                      onNewSession={() => newSession(selectedConn.id)} />
                  )}
                  {panel === "flow" && selectedConn.mode === "virtual-supplier" && (
                    <SupplierPanel supplier={selectedConn.supplier} publicUrl={publicUrl} />
                  )}
                </>
              )}
              {panel !== "new" && !selectedConn && <p className="hint">No connection selected. Create one to get started.</p>}
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
                <SupplierEditor supplier={selectedSupplierId === NEW ? null : selectedSupplier} onSave={saveSupplier} onDelete={deleteSupplier} />
              ) : <p className="hint">Select a supplier or create one.</p>}
            </>
          )}

          {view === "profiles" && (
            <>
              <h2>{selectedProfileId === NEW ? "New profile" : selectedProfile?.name ?? "Profiles"}</h2>
              {selectedProfileId ? (
                <ProfileEditor profile={selectedProfileId === NEW ? null : selectedProfile} onSave={saveProfile} onDelete={deleteProfile} />
              ) : <p className="hint">Select a profile or create one. Built-in presets (Ariba, Coupa, …) are listed here.</p>}
            </>
          )}
        </main>

        <section className="logpane">
          <div className="logpane-head">Live log</div>
          <LiveLog records={records} connections={connections} onSelect={setDetail} />
        </section>
      </div>

      {detail && <MessageDetail record={detail} onClose={() => setDetail(null)} />}
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
        // sun (click → light)
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // moon (click → dark)
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

function SupplierPanel({ supplier, publicUrl }: { supplier?: Supplier; publicUrl: string }) {
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
        <tr><td>Catalog (preview)</td><td><a href={`${base}/catalog`} target="_blank" rel="noreferrer">{base}/catalog ↗</a></td></tr>
      </tbody></table>
      <p className="hint">The built-in demo buyer is wired to the demo supplier, so the full roundtrip runs from the Demo connection.</p>
    </div>
  );
}
