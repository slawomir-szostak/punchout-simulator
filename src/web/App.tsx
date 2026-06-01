import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useStream } from "./hooks/useStream";
import type { Cart, Connection, LogRecord } from "./types";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { BuyerFlow } from "./components/BuyerFlow";
import { LiveLog } from "./components/LiveLog";
import { MessageDetail } from "./components/MessageDetail";

type Panel = "flow" | "edit" | "new";

export function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("flow");
  const [carts, setCarts] = useState<Record<string, Cart>>({});
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [detail, setDetail] = useState<LogRecord | null>(null);
  const [callbackUrl, setCallbackUrl] = useState<string>("");
  const [publicUrl, setPublicUrl] = useState<string>("");

  const selected = useMemo(
    () => connections.find((c) => c.id === selectedId) ?? null,
    [connections, selectedId],
  );

  const reloadConnections = useCallback(async () => {
    const list = await api.listConnections();
    setConnections(list);
    setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    return list;
  }, []);

  useEffect(() => {
    reloadConnections();
    api.recent(200).then(setRecords).catch(() => {});
    api.runtime().then((r) => {
      setCallbackUrl(r.callbackUrl);
      setPublicUrl(r.publicUrl);
    });
  }, [reloadConnections]);

  useStream({
    onLog: (record) => setRecords((rs) => [...rs, record]),
    onCart: (_conn, cart) => setCarts((c) => ({ ...c, [cart.sessionId]: cart })),
  });

  const saveConnection = async (data: Partial<Connection>) => {
    if (panel === "new" || !selected) {
      const created = await api.createConnection(data);
      await reloadConnections();
      setSelectedId(created.id);
    } else {
      await api.updateConnection(selected.id, data);
      await reloadConnections();
    }
    setPanel("flow");
  };

  const deleteConnection = async (id: string) => {
    await api.deleteConnection(id);
    const list = await reloadConnections();
    setSelectedId(list[0]?.id ?? null);
    setPanel("flow");
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span> punchout-simulator
        </div>
        <div className="topbar-meta">
          callback: <code>{callbackUrl || "…"}</code>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-head">
            <span>Connections</span>
            <button
              className="btn-secondary"
              onClick={() => {
                setPanel("new");
                setSelectedId(null);
              }}
            >
              + New
            </button>
          </div>
          <ul className="conn-list">
            {connections.map((c) => (
              <li
                key={c.id}
                className={c.id === selectedId && panel !== "new" ? "active" : ""}
                onClick={() => {
                  setSelectedId(c.id);
                  setPanel("flow");
                }}
              >
                <span className={`mode-dot mode-${c.mode}`} />
                <div className="conn-name">{c.name}</div>
                <div className="conn-mode">{c.mode}</div>
              </li>
            ))}
          </ul>
        </aside>

        <main className="main">
          {panel === "new" && (
            <>
              <h2>New connection</h2>
              <ConnectionEditor connection={null} onSave={saveConnection} />
            </>
          )}

          {panel !== "new" && selected && (
            <>
              <div className="main-head">
                <h2>{selected.name}</h2>
                <div className="tabs">
                  <button className={panel === "flow" ? "tab active" : "tab"} onClick={() => setPanel("flow")}>
                    Flow
                  </button>
                  <button className={panel === "edit" ? "tab active" : "tab"} onClick={() => setPanel("edit")}>
                    Settings
                  </button>
                </div>
              </div>

              {panel === "edit" && (
                <ConnectionEditor connection={selected} onSave={saveConnection} onDelete={deleteConnection} />
              )}

              {panel === "flow" && selected.mode === "virtual-buyer" && (
                <BuyerFlow connection={selected} carts={carts} />
              )}

              {panel === "flow" && selected.mode === "virtual-supplier" && (
                <SupplierPanel connection={selected} publicUrl={publicUrl} />
              )}
            </>
          )}

          {panel !== "new" && !selected && (
            <p className="hint">No connection selected. Create one to get started.</p>
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

function SupplierPanel({ connection, publicUrl }: { connection: Connection; publicUrl: string }) {
  const base = `${publicUrl}/sim/${connection.id}`;
  return (
    <div className="supplier-panel">
      <p className="hint">
        This connection acts as a <strong>virtual supplier</strong> (mock catalog). Point a real buyer
        system — or a virtual-buyer connection — at these endpoints:
      </p>
      <table className="kv">
        <tbody>
          <tr>
            <td>PunchOut setup</td>
            <td><code>{base}/punchout</code></td>
          </tr>
          <tr>
            <td>Order</td>
            <td><code>{base}/order</code></td>
          </tr>
          <tr>
            <td>Catalog (preview)</td>
            <td>
              <a href={`${base}/catalog`} target="_blank" rel="noreferrer">
                {base}/catalog ↗
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="hint">
        The built-in demo buyer is already wired to the built-in demo supplier, so you can run the full
        roundtrip immediately from the <em>Demo Buyer</em> connection.
      </p>
    </div>
  );
}
