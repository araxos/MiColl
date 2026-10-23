import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { useDialogTheme } from "@/lib/dialogTheme";
import { useAccent } from "@/lib/theme";
import { resolveLanguage, useLanguage, useT, useTf, useTp } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ChangeEntry } from "@/lib/updater";

/** **bold** spans of one line as React nodes (the notes are plain text, no HTML). */
function inlineBold(line: string) {
  return line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i} className="font-semibold text-zinc-100">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

/**
 * The release notes as written on GitHub: "- " lines become a list, "#" lines a small
 * heading (older releases have them), **bold** is bold, other lines stay paragraphs.
 */
export function ReleaseNotes({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const blocks: Array<{ kind: "list" | "text" | "head"; lines: string[] }> = [];
  for (const line of lines) {
    const kind = /^#{1,6}\s+/.test(line) ? "head" : /^[-*]\s+/.test(line) ? "list" : "text";
    const clean = line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "");
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && kind !== "head") last.lines.push(clean);
    else blocks.push({ kind, lines: [clean] });
  }
  return (
    <div className="space-y-2">
      {blocks.map((b, i) =>
        b.kind === "list" ? (
          <ul key={i} className="list-disc space-y-1.5 pl-4 marker:text-zinc-500">
            {b.lines.map((l, j) => (
              <li key={j}>{inlineBold(l)}</li>
            ))}
          </ul>
        ) : b.kind === "head" ? (
          <p key={i} className="pt-1 font-semibold text-zinc-100">
            {inlineBold(b.lines[0])}
          </p>
        ) : (
          b.lines.map((l, j) => <p key={`${i}-${j}`}>{inlineBold(l)}</p>)
        ),
      )}
    </div>
  );
}

/**
 * Everything since the installed version, when an update skips several: the bigger
 * updates (x.y.0, e.g. the phone app in 0.4.0) first and open, then the smaller ones
 * newest first, folded (the newest one open when there's no bigger update).
 */
export function UpdateChanges({ changes }: { changes: ChangeEntry[] }) {
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const dlg = useDialogTheme();
  const lang = resolveLanguage(useLanguage());
  const cyber = useAccent() === "cyberpunk";
  const big = changes.filter((c) => c.big);
  const small = changes.filter((c) => !c.big);
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(big.length === 0 && small.length > 0 ? [small[0].version] : []),
  );
  const toggle = (v: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(v)) n.delete(v);
      else n.add(v);
      return n;
    });
  const when = (iso?: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
  };
  const round = cyber ? "rounded-none" : "rounded-lg";

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">{tp("{n} updates since your version", changes.length)}</p>

      {big.map((c) => (
        <section key={c.version} className={cn("border p-3", round, dlg.soft)}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Sparkles className={cn("h-4 w-4 shrink-0", dlg.accentText)} />
            <span className="font-semibold text-zinc-100">{tf("Version {version}", { version: c.version })}</span>
            <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", dlg.controlOn)}>
              {t("Big update")}
            </span>
            {c.date && <span className="ml-auto text-[11px] text-zinc-500">{when(c.date)}</span>}
          </div>
          <ReleaseNotes text={c.notes} />
        </section>
      ))}

      {small.length > 0 && (
        <div>
          {big.length > 0 && (
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              {t("Smaller updates")}
            </h3>
          )}
          <div className={cn("border", round, dlg.soft)}>
            {small.map((c) => {
              const isOpen = open.has(c.version);
              return (
                <div key={c.version} className={cn("border-t first:border-t-0", dlg.divider)}>
                  <button
                    onClick={() => toggle(c.version)}
                    aria-expanded={isOpen}
                    className={cn("flex w-full items-center gap-2 px-3 py-2 text-left", dlg.menuRow)}
                  >
                    <ChevronRight
                      className={cn("h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform", isOpen && "rotate-90")}
                    />
                    <span className="font-medium text-zinc-200">{tf("Version {version}", { version: c.version })}</span>
                    {c.date && <span className="ml-auto text-[11px] text-zinc-500">{when(c.date)}</span>}
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 pl-8">
                      <ReleaseNotes text={c.notes} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
