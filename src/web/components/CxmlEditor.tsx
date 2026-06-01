import Editor from "@monaco-editor/react";

interface Props {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: number | string;
}

// Monaco-backed cXML editor (XML highlighting + edit-before-send). Read-only
// mode is used for displaying captured documents in the log.
export function CxmlEditor({ value, onChange, readOnly, height = 320 }: Props) {
  return (
    <div className="editor-shell">
      <Editor
        height={height}
        defaultLanguage="xml"
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
