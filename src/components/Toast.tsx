import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, AlertTriangle, XCircle, X, Loader2 } from "lucide-react";
import { useDialogTheme } from "@/lib/dialogTheme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** progress = a running job: no countdown, the bar shows how far it is. */
export type ToastTone = "success" | "warn" | "error" | "progress";

export interface ToastData {
  id: number;
  /** Bold title, e.g. "12 files added". */
  title: string;
  /** Optional grey line, e.g. the folder. */
  detail?: string;
  /** Optional warning line, e.g. "3 files couldn't be imported". */
  problem?: string;
  tone: ToastTone;
  /** Hide after this many ms (default 8000). Not for progress, that one stays. */
  duration?: number;
  /** progress tone: how far (0..1), null = running without a count. */
  progress?: number | null;
}

const toneStyles: Record<ToastTone, { ring: string; bar: string; Icon: typeof CheckCircle2; icon: string }> = {
  success: { ring: "border-emerald-500/40", bar: "bg-emerald-500", Icon: CheckCircle2, icon: "text-emerald-400" },
  warn: { ring: "border-amber-500/40", bar: "bg-amber-500", Icon: AlertTriangle, icon: "text-amber-400" },
  error: { ring: "border-rose-500/40", bar: "bg-rose-500", Icon: XCircle, icon: "text-rose-400" },
  // bar and icon take the theme accent (see ToastCard)
  progress: { ring: "border-brand-500/40", bar: "", Icon: Loader2, icon: "animate-spin" },
};

/** Toasts in the bottom right that hide by themselves. */
export function Toaster({ toasts, onDismiss }: { toasts: ToastData[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastData; onDismiss: (id: number) => void }) {
  const t = useT();
  const duration = toast.duration ?? 8000;
  const s = toneStyles[toast.tone];
  // theme surface, the tone color stays in the icon, border and bar
  const { toast: surface, accent, accentText } = useDialogTheme();
  const running = toast.tone === "progress";
  // countdown only runs while not hovered
  const [pct, setPct] = useState(100);
  const elapsedRef = useRef(0);
  const lastRef = useRef(0);
  const hoverRef = useRef(false);

  useEffect(() => {
    // a running job stays until it's done (the caller replaces it)
    if (running) return;
    let raf = 0;
    lastRef.current = performance.now();
    const tick = (now: number) => {
      const dt = now - lastRef.current;
      lastRef.current = now;
      if (!hoverRef.current) {
        elapsedRef.current += dt;
        const left = Math.max(0, 1 - elapsedRef.current / duration);
        setPct(left * 100);
        if (left <= 0) {
          onDismiss(toast.id);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration, onDismiss, toast.id, running]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 40, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      onMouseEnter={() => {
        hoverRef.current = true;
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
      }}
      className={cn("pointer-events-auto overflow-hidden border", s.ring, surface)}
    >
      <div className="flex items-start gap-3 p-3.5">
        <s.Icon className={cn("mt-0.5 h-5 w-5 shrink-0", s.icon, running && accentText)} />
        {/* text wraps (break-words for long paths) */}
        <div className="min-w-0 flex-1">
          <div className="break-words text-sm font-semibold text-zinc-100">{toast.title}</div>
          {toast.detail && (
            <div className="mt-0.5 break-words text-xs text-zinc-400">{toast.detail}</div>
          )}
          {toast.problem && (
            <div className="mt-0.5 break-words text-xs text-amber-300">{toast.problem}</div>
          )}
        </div>
        {/* a running job can't be closed, it goes away when it's done */}
        {!running && (
          <button
            onClick={() => onDismiss(toast.id)}
            className="-mr-1 -mt-1 rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
            title={t("Dismiss")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {running ? (
        // progress bar, a sliding piece while there's no count yet
        <div className="relative h-1.5 w-full overflow-hidden bg-white/10">
          {toast.progress == null ? (
            <div className={cn("toast-indeterminate absolute inset-y-0 w-1/3", accent)} />
          ) : (
            <div
              className={cn("h-full transition-[width] duration-300 ease-out", accent)}
              style={{ width: `${Math.max(2, Math.min(1, toast.progress) * 100)}%` }}
            />
          )}
        </div>
      ) : (
        /* countdown bar */
        <div className="h-1 w-full bg-white/10">
          <div className={`h-full ${s.bar}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </motion.div>
  );
}
