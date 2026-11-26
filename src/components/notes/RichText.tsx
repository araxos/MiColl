import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronUp,
  Copy,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Palette,
  Strikethrough,
  Underline,
} from "lucide-react";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useInk } from "@/components/notes/ink";
import { CopyField, insertCopyField } from "@/components/notes/CopyField";

/** The formatting bar folded away (remembered for all notes). */
const BAR_KEY = "micoll.notesBarClosed";
function readBarClosed(): boolean {
  try {
    return localStorage.getItem(BAR_KEY) === "1";
  } catch {
    return false;
  }
}

/** A plain note of before as the editor's document: one paragraph per line. */
function fromPlain(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

function startDoc(text: string, rich: string | null): JSONContent {
  if (rich) {
    try {
      return JSON.parse(rich) as JSONContent;
    } catch {
      /* broken: the plain words then */
    }
  }
  return fromPlain(text);
}

const SIZES: { label: string; value: string | null }[] = [
  { label: "Small", value: "0.85em" },
  { label: "Normal", value: null },
  { label: "Large", value: "1.25em" },
  { label: "Huge", value: "1.6em" },
];

/** Readable on every theme's dark background. null = the text's own colour. */
const COLORS: (string | null)[] = [null, "#fca5a5", "#fdba74", "#fde047", "#86efac", "#7dd3fc", "#c4b5fd", "#f9a8d4", "#a1a1aa"];

/**
 * The note's text with its formatting (TipTap). onChange gets its plain words (for the
 * search and the word count) and the document as JSON.
 */
export function RichText({
  text,
  rich,
  editable = true,
  placeholder,
  onChange,
  onReady,
  extraTools,
}: {
  text: string;
  rich: string | null;
  editable?: boolean;
  placeholder?: string;
  onChange?: (text: string, rich: string) => void;
  onReady?: (editor: Editor) => void;
  /** more buttons at the end of the bar */
  extraTools?: (editor: Editor) => React.ReactNode;
}) {
  const t = useT();
  const dlg = useDialogTheme();
  const ink = useInk();
  const [barClosed, setBarClosed] = useState(readBarClosed);
  const toggleBar = () =>
    setBarClosed((c) => {
      try {
        localStorage.setItem(BAR_KEY, c ? "0" : "1");
      } catch {
        /* just not remembered */
      }
      return !c;
    });
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const editor = useEditor({
    editable,
    // the bar shows what's on where the cursor is
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false, code: false, codeBlock: false }),
      TextStyle,
      Color,
      FontSize,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      CopyField,
    ],
    content: startDoc(text, rich),
    editorProps: { attributes: { class: "notes-prose", spellcheck: "false" } },
    onUpdate: ({ editor }) => changeRef.current?.(editor.getText({ blockSeparator: "\n" }), JSON.stringify(editor.getJSON())),
  });
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  useEffect(() => {
    if (editor) readyRef.current?.(editor);
  }, [editor]);

  if (!editor) return <div className="flex-1" />;
  return (
    <>
      {editable && (
        // the arrow under the bar folds it away, and back
        <div className="relative z-10 shrink-0">
          {!barClosed && <Toolbar editor={editor} extra={extraTools?.(editor)} />}
          <button
            type="button"
            title={barClosed ? t("Show the formatting bar") : t("Hide the formatting bar")}
            aria-label={barClosed ? t("Show the formatting bar") : t("Hide the formatting bar")}
            aria-expanded={!barClosed}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleBar}
            className={cn(
              "absolute left-1/2 top-full flex h-4 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center hover:text-zinc-50",
              ink.soft,
              dlg.control,
            )}
          >
            {barClosed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 cursor-text overflow-y-auto px-4 py-3" onMouseDown={(e) => {
        // a click below the text puts the cursor at its end
        if (editable && e.target === e.currentTarget) {
          e.preventDefault();
          editor.commands.focus("end");
        }
      }}>
        <EditorContent editor={editor} />
      </div>
    </>
  );
}

function Toolbar({ editor, extra }: { editor: Editor; extra?: React.ReactNode }) {
  const t = useT();
  const dlg = useDialogTheme();
  const ink = useInk();
  const chain = () => editor.chain().focus();
  const level = ([1, 2, 3] as const).find((l) => editor.isActive("heading", { level: l }));
  const size = (editor.getAttributes("textStyle").fontSize as string | undefined) ?? null;
  const color = (editor.getAttributes("textStyle").color as string | undefined) ?? null;
  const Btn = ({ on, label, onClick, children }: { on?: boolean; label: string; onClick: () => void; children: React.ReactNode }) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      // the editor keeps its selection
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs transition-colors",
        on ? cn(dlg.accentText, "bg-white/10") : cn(ink.soft, "micoll-hover hover:text-zinc-50"),
      )}
    >
      {children}
    </button>
  );
  const Sep = () => <span className={cn("mx-1 h-5 w-px shrink-0 border-l", dlg.divider)} />;
  return (
    <div className={cn("flex flex-wrap items-center gap-0.5 border-b px-3 py-1.5", dlg.divider)}>
      <Pop
        label={t("Text style")}
        face={<span className="min-w-[4.5rem] text-left">{level ? `${t("Heading")} ${level}` : t("Text")}</span>}
      >
        {(close) => (
          <>
            <PopRow on={!level} onClick={() => (chain().setParagraph().run(), close())}>
              {t("Text")}
            </PopRow>
            {([1, 2, 3] as const).map((l) => (
              <PopRow key={l} on={level === l} onClick={() => (chain().toggleHeading({ level: l }).run(), close())}>
                <span className={l === 1 ? "text-lg font-bold" : l === 2 ? "text-base font-semibold" : "text-sm font-semibold"}>
                  {t("Heading")} {l}
                </span>
              </PopRow>
            ))}
          </>
        )}
      </Pop>
      <Pop label={t("Size")} face={<span className="min-w-[3.5rem] text-left">{t(SIZES.find((s) => s.value === size)?.label ?? "Normal")}</span>}>
        {(close) =>
          SIZES.map((s) => (
            <PopRow
              key={s.label}
              on={s.value === size}
              onClick={() => (s.value ? chain().setFontSize(s.value).run() : chain().unsetFontSize().run(), close())}
            >
              <span style={{ fontSize: s.value ?? undefined }}>{t(s.label)}</span>
            </PopRow>
          ))
        }
      </Pop>
      <Sep />
      <Btn on={editor.isActive("bold")} label={t("Bold (Ctrl+B)")} onClick={() => chain().toggleBold().run()}>
        <Bold className="h-4 w-4" />
      </Btn>
      <Btn on={editor.isActive("italic")} label={t("Italic (Ctrl+I)")} onClick={() => chain().toggleItalic().run()}>
        <Italic className="h-4 w-4" />
      </Btn>
      <Btn on={editor.isActive("underline")} label={t("Underline (Ctrl+U)")} onClick={() => chain().toggleUnderline().run()}>
        <Underline className="h-4 w-4" />
      </Btn>
      <Btn on={editor.isActive("strike")} label={t("Strikethrough")} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough className="h-4 w-4" />
      </Btn>
      <Pop
        label={t("Colour")}
        face={
          <>
            <Palette className="h-4 w-4" />
            <span className="h-1.5 w-3 rounded-full" style={{ background: color ?? "currentColor" }} />
          </>
        }
      >
        {(close) => (
          <div className="grid grid-cols-3 gap-1.5 p-1">
            {COLORS.map((c) => (
              <button
                key={c ?? "none"}
                type="button"
                title={c ? c : t("Normal")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (c ? chain().setColor(c).run() : chain().unsetColor().run(), close())}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-bold",
                  c === color ? "border-white" : "border-white/15",
                )}
                style={{ background: c ?? "transparent", color: c ? "#111" : undefined }}
              >
                {c ? "" : "A"}
              </button>
            ))}
          </div>
        )}
      </Pop>
      <Sep />
      <Btn on={editor.isActive({ textAlign: "left" })} label={t("Align left")} onClick={() => chain().setTextAlign("left").run()}>
        <AlignLeft className="h-4 w-4" />
      </Btn>
      <Btn on={editor.isActive({ textAlign: "center" })} label={t("Centre")} onClick={() => chain().setTextAlign("center").run()}>
        <AlignCenter className="h-4 w-4" />
      </Btn>
      <Btn on={editor.isActive({ textAlign: "right" })} label={t("Align right")} onClick={() => chain().setTextAlign("right").run()}>
        <AlignRight className="h-4 w-4" />
      </Btn>
      <Sep />
      <Btn on={editor.isActive("bulletList")} label={t("Bulleted list")} onClick={() => chain().toggleBulletList().run()}>
        <List className="h-4 w-4" />
      </Btn>
      <Btn on={editor.isActive("orderedList")} label={t("Numbered list")} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered className="h-4 w-4" />
      </Btn>
      <Btn on={editor.isActive("taskList")} label={t("Checklist")} onClick={() => chain().toggleTaskList().run()}>
        <ListChecks className="h-4 w-4" />
      </Btn>
      <Sep />
      <Btn label={t("Copy field: a box whose text is copied with one click")} onClick={() => insertCopyField(editor)}>
        <Copy className="h-4 w-4" />
        <span className="hidden xl:inline">{t("Copy field")}</span>
      </Btn>
      {extra && (
        <>
          <Sep />
          {extra}
        </>
      )}
    </div>
  );
}

/** A bar button that opens a small list under it. */
function Pop({ label, face, children }: { label: string; face: React.ReactNode; children: (close: () => void) => React.ReactNode }) {
  const dlg = useDialogTheme();
  const ink = useInk();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex h-7 items-center gap-1 rounded-md px-1.5 text-xs micoll-hover hover:text-zinc-50", open ? "text-zinc-50" : ink.soft)}
      >
        {face}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && <div className={cn("absolute left-0 top-full z-30 mt-1 min-w-[9rem] p-1", dlg.menu)}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

function PopRow({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  const dlg = useDialogTheme();
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn("flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm text-zinc-100", dlg.menuRow, on && dlg.accentText)}
    >
      {children}
    </button>
  );
}
