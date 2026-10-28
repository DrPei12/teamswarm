import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

function language(path: string) {
  if (/\.[cm]?[jt]sx?$/.test(path))
    return javascript({
      typescript: /\.tsx?$/.test(path),
      jsx: /x$/.test(path),
    });
  if (/\.py$/.test(path)) return python();
  if (/\.jsonc?$/.test(path)) return json();
  if (/\.(md|mdx|markdown)$/.test(path)) return markdown();
  if (/\.(css|scss)$/.test(path)) return css();
  if (/\.html?$/.test(path)) return html();
  if (/\.(xml|svg)$/.test(path)) return xml();
  if (/\.ya?ml$/.test(path)) return StreamLanguage.define(yaml);
  if (/\.(sh|ps1)$/.test(path)) return StreamLanguage.define(shell);
  return [];
}
export default function CodeEditor({
  path,
  value,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language(path),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": path,
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              fontSize: "12px",
              backgroundColor: "var(--panel)",
              color: "var(--text)",
            },
            ".cm-scroller": {
              fontFamily: "var(--font-mono)",
              lineHeight: "1.75",
              overflow: "auto",
            },
            ".cm-content": { padding: "14px 0", caretColor: "var(--text)" },
            ".cm-gutters": {
              backgroundColor: "var(--panel)",
              color: "var(--subtle)",
              border: "none",
              paddingRight: "10px",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "var(--hover)",
            },
            "&.cm-focused": { outline: "none" },
            ".cm-cursor": { borderLeftColor: "var(--text)" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "var(--active)",
            },
            ".cm-panels": {
              backgroundColor: "var(--panel)",
              color: "var(--text)",
              fontFamily: "var(--font-ui)",
            },
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = undefined;
    };
    // A new file gets its own history. Parent draft updates must not reset it.
  }, [path]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
  }, [value]);
  return <div className="file-code-editor" ref={host} />;
}
