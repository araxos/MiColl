import { useEffect, useReducer, useRef, useState } from "react";
import { Node, NodeViewWrapper, ReactNodeViewRenderer, mergeAttributes, type Editor, type NodeViewProps } from "@tiptap/react";
import { Check, Copy, SquareDashedMousePointer } from "lucide-react";
import { invoke } from "@/lib/tauri";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A copy field in a note: the copy symbol and a small box. A click on the symbol copies
 * what's in the box (nothing when it's empty). Shown while it's typed in, hidden (•••)
 * after. Its words are left out of the note's plain text: the search and the list never
 * show them. The copy stays out of Windows' clipboard history and is cleared after 60 s
 * (notes.rs, notes_copy).
 */
export const CopyField = Node.create({
  name: "copyField",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { value: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-copy-field]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-copy-field": "" })];
  },
  renderText() {
    return "";
  },
  addNodeView() {
    return ReactNodeViewRenderer(CopyFieldView, {
      // the box takes its own keys and clicks, the editor stays out of them
      stopEvent: ({ event }) => event.target instanceof HTMLInputElement,
    });
  },
});

/** Puts a new, empty copy field where the cursor is, ready to type in. */
export function insertCopyField(editor: Editor) {
  editor.chain().focus().insertContent({ type: "copyField", attrs: { value: "" } }).run();
  const at = editor.state.selection.from - 1;
  requestAnimationFrame(() => {
    const dom = editor.view.nodeDOM(at) as HTMLElement | null;
    dom?.querySelector("input")?.focus();
  });
}

function CopyFieldView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const t = useT();
  const value = (node.attrs.value as string) ?? "";
  // (the box only types while the note can be written in)
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    editor.on("update", redraw);
    return () => {
      editor.off("update", redraw);
    };
  }, [editor]);
  const [typing, setTyping] = useState(false);
  const [said, setSaid] = useState<"copied" | "empty" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = (s: "copied" | "empty") => {
    setSaid(s);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), 1600);
  };
  const copy = async () => {
    if (!value) return say("empty");
    try {
      await invoke("notes_copy", { text: value });
      say("copied");
    } catch {
      /* the clipboard was busy: try again */
    }
  };
  // out of the box to the right of it (Enter, Tab, arrow at its end)
  const leave = () => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos == null) return;
    editor.chain().focus().setTextSelection(pos + node.nodeSize).run();
  };
  const width = value ? `${Math.min(Math.max(value.length, 6), 40) + 2}ch` : "15ch";
  return (
    <NodeViewWrapper as="span" className="copy-field" data-said={said ?? undefined} contentEditable={false}>
      <button
        type="button"
        className="copy-field-btn"
        title={said === "copied" ? t("Copied") : said === "empty" ? t("Nothing to copy") : t("Copy (cleared from the clipboard after 60 seconds)")}
        aria-label={t("Copy")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void copy()}
      >
        {said === "copied" ? <Check className="h-3.5 w-3.5" /> : said === "empty" ? <SquareDashedMousePointer className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <input
        className={cn("copy-field-box", !typing && value && "copy-field-hidden")}
        type={typing || !value ? "text" : "password"}
        value={value}
        readOnly={!editor.isEditable}
        placeholder={t("Text to copy")}
        spellCheck={false}
        autoComplete="off"
        style={{ width }}
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        onChange={(e) => updateAttributes({ value: e.target.value })}
        onKeyDown={(e) => {
          const end = e.currentTarget.selectionStart === value.length;
          if (e.key === "Enter" || e.key === "Tab" || (e.key === "ArrowRight" && end)) {
            e.preventDefault();
            leave();
          }
        }}
      />
      {said && <span className="copy-field-said">{said === "copied" ? t("Copied") : t("Nothing to copy")}</span>}
    </NodeViewWrapper>
  );
}
