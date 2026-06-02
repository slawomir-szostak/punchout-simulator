import Editor from "@monaco-editor/react";

interface Props {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: number | string;
  /** Monaco language id; defaults to "xml". Use "plaintext" for raw wire dumps. */
  language?: string;
}

// Monaco-backed cXML editor (XML highlighting + edit-before-send). Read-only
// mode is used for displaying captured documents in the log.
export function CxmlEditor({ value, onChange, readOnly, height = 320, language = "xml" }: Props) {
  return (
    <div className="editor-shell">
      <Editor
        height={height}
        language={language}
        theme="vs-dark"
        value={value}
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
