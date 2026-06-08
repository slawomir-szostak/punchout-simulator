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
  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(shown).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
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
