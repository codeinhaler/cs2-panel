// Bundle Monaco locally instead of loading it from a CDN, so the editor works
// even if the server has no internet access.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === "json" ? new JsonWorker() : new EditorWorker();
  },
};

loader.config({ monaco });

// Source-engine .cfg files: `command value // comment`.
monaco.languages.register({ id: "cs2cfg", extensions: [".cfg"] });
monaco.languages.setMonarchTokensProvider("cs2cfg", {
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/"[^"]*"/, "string"],
      [/^\s*[A-Za-z_][\w.]*/, "keyword"],
      [/-?\d+(\.\d+)?\b/, "number"],
      [/;/, "delimiter"],
    ],
  },
});
monaco.languages.setLanguageConfiguration("cs2cfg", { comments: { lineComment: "//" } });

export function languageFor(path: string): string {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".ini") || path.endsWith(".toml")) return "ini";
  if (path.endsWith(".cfg")) return "cs2cfg";
  return "plaintext";
}

export { monaco };
