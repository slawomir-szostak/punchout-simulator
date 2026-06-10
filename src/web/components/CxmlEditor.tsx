import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { useTheme } from "../hooks/useTheme";
import { formatXml } from "../xml-format";

interface Props {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: number | string;
  /** Monaco language id; defaults to "xml". Use "plaintext" for raw wire dumps. */
  language?: string;
}

// Monaco-backed cXML editor (XML highlighting + edit-before-send). Read-only
// mode is used for displaying captured documents in the log. Every instance
// carries a Copy + Prettify toolbar so the same affordances exist on every code
// field. Prettify is offered only for XML; for read-only fields it reformats the
// displayed copy locally (without mutating the source), for editable fields it
// rewrites the content through onChange.
export function CxmlEditor({ value, onChange, readOnly, height = 320, language = "xml" }: Props) {
  const theme = useTheme();
  const editable = !!onChange && !readOnly;
  const isXml = language === "xml";

  // Local override lets a read-only field show a prettified copy without
  // changing the source `value`. Reset whenever the source changes.
  const [override, setOverride] = useState<string | null>(null);
  useEffect(() => setOverride(null), [value]);
  const shown = override ?? value;

  const [copied, setCopied] = useState(false);
  const flashCopied = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const copy = () => {
    // navigator.clipboard is undefined on insecure origins (e.g. LAN access over
    // plain http://192.168.x.x). Fall back to the legacy execCommand path so the
    // Copy button still works there instead of silently doing nothing.
    if (navigator.clipboard) {
      navigator.clipboard.writeText(shown).then(flashCopied).catch(legacyCopy);
    } else {
      legacyCopy();
    }
  };
  const legacyCopy = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = shown;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      flashCopied();
    } catch {
      /* clipboard genuinely unavailable; nothing more we can do */
    }
  };

  const prettify = () => {
    const formatted = formatXml(shown);
    if (editable) onChange?.(formatted);
    else setOverride(formatted);
  };

  return (
    <div className="editor-shell">
      <div className="editor-toolbar">
        {isXml && (
          <button type="button" className="editor-tool" onClick={prettify} title="Format the XML (indent)">
            Prettify
          </button>
        )}
        <button type="button" className="editor-tool" onClick={copy} title="Copy to clipboard">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <Editor
        height={height}
        language={language}
        theme={theme === "light" ? "vs" : "vs-dark"}
        value={shown}
        onChange={(v) => onChange?.(v ?? "")}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 12,
          wordWrap: "on",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          lineNumbers: "on",
          renderWhitespace: "none",
        }}
      />
    </div>
  );
}
