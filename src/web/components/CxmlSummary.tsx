// One-line digest of a cXML document shown in place of the full editor, so a
// session opens on what matters (who → whom, which operation) instead of 15
// lines of XML most runs never edit. Regex on the raw text is enough here: the
// facts are display-only and the document is always the tool's own output.
const attr = (xml: string, re: RegExp): string | undefined => re.exec(xml)?.[1];

const credential = (xml: string, tag: "From" | "To"): string | undefined => {
  const m = new RegExp(`<${tag}>[\\s\\S]*?<Credential[^>]*domain="([^"]*)"[\\s\\S]*?<Identity>([^<]*)<`).exec(xml);
  return m ? `${m[1]}/${m[2]}` : undefined;
};

export function summarizeCxml(xml: string): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  const push = (label: string, value?: string) => value && facts.push({ label, value });
  if (/<PunchOutSetupRequest/.test(xml)) {
    push("operation", attr(xml, /<PunchOutSetupRequest[^>]*operation="([^"]+)"/));
  } else if (/<OrderRequest/.test(xml)) {
    push("orderID", attr(xml, /<OrderRequestHeader[^>]*orderID="([^"]+)"/));
    const items = (xml.match(/<ItemOut[\s>]/g) ?? []).length;
    push("items", items ? String(items) : undefined);
    const total = /<Total>\s*<Money[^>]*currency="([^"]+)"[^>]*>([^<]+)</.exec(xml);
    push("total", total ? `${total[1]} ${total[2]}` : undefined);
  }
  push("from", credential(xml, "From"));
  push("to", credential(xml, "To"));
  push("DTD", attr(xml, /cXML\/(\d+\.\d+\.\d+)\/cXML\.dtd/));
  push("agent", attr(xml, /<UserAgent>([^<]+)</));
  return facts;
}

interface Props {
  xml: string;
  open: boolean;
  onToggle: () => void;
  /** Wording for the toggle when the document is editable vs. read-only. */
  verb?: "Edit" | "Show";
}

export function CxmlSummary({ xml, open, onToggle, verb = "Edit" }: Props) {
  const facts = summarizeCxml(xml);
  return (
    <div className="cxml-summary">
      {facts.length === 0 ? (
        <span className="hint">cXML document</span>
      ) : (
        facts.map((f) => (
          <span key={f.label} className="cxml-fact">
            <span className="cxml-fact-label">{f.label}</span> <code>{f.value}</code>
          </span>
        ))
      )}
      <button className="btn-link" onClick={onToggle} aria-expanded={open}>
        {open ? "Hide cXML ▴" : `${verb} cXML ▾`}
      </button>
    </div>
  );
}
