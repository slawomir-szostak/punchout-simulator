// Wire @monaco-editor/react to the locally bundled monaco-editor package
// instead of fetching it from a CDN — the tool must work fully offline once
// installed via npx. The default editor worker covers XML (which has no
// dedicated language worker).
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(self as any).MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

export {};
