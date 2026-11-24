import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { ThemeCheck } from "@/components/ThemeCheck";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { Platform } from "@/types";

/**
 * A creator's platforms as tabs hanging from the top bar, while the platform row itself
 * is scrolled out of view (index.css .hang-tab, a shape per theme). Layout's overlay.
 */
export function PlatformHangTabs({
  show,
  platforms,
  activeId,
  onPick,
  onMenu,
  onAdd,
  picker,
  right,
  ...drop
}: {
  show: boolean;
  platforms: Platform[];
  activeId?: string;
  onPick: (p: Platform) => void;
  onMenu: (e: React.MouseEvent, p: Platform) => void;
  /** "+ Platform", not set in the browser version. */
  onAdd?: () => void;
  /** Its open menu, placed under the "+" tab. */
  picker?: React.ReactNode;
  /** Keep this free on the right (the Details panel). */
  right?: string;
  /** data-drop-*: files dropped on the tabs land like on the page under them. */
  [drop: `data-${string}`]: string | undefined;
}) {
  const t = useT();
  const addRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [addLeft, setAddLeft] = useState(0);
  const open = !!picker;
  // the menu sits under its tab (outside the row, which clips)
  useEffect(() => {
    if (open && addRef.current && rowRef.current)
      setAddLeft(addRef.current.offsetLeft - rowRef.current.scrollLeft);
  }, [open]);
  // the open platform stays in view when there are more than fit
  useEffect(() => {
    if (!show) return;
    rowRef.current
      ?.querySelector<HTMLElement>("[aria-current]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [show, activeId]);

  return (
    <div {...drop} className="hang-tabs" style={right ? { right } : undefined}>
      <div className="hang-tabs-clip">
        <div
          ref={rowRef}
          className="hang-tabs-row"
          data-show={show || undefined}
          inert={!show}
          onWheel={(e) => {
            e.currentTarget.scrollLeft += e.deltaY;
          }}
        >
          {platforms.map((p) => {
            const active = p.id === activeId;
            return (
              <button
                key={p.id}
                onClick={() => onPick(p)}
                onContextMenu={(e) => onMenu(e, p)}
                aria-current={active ? "page" : undefined}
                className={cn("hang-tab", active && "hang-tab--on")}
              >
                <span className="truncate">{p.name}</span>
                {p.verified && <ThemeCheck className="h-3.5 w-3.5" label={t("Has verified periods")} />}
              </button>
            );
          })}
          {onAdd && (
            <button
              ref={addRef}
              onClick={onAdd}
              title={t("Add a platform to this creator")}
              className="hang-tab hang-tab--add"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("Platform")}
            </button>
          )}
        </div>
      </div>
      {picker && (
        <div className="pointer-events-auto absolute" style={{ left: addLeft, top: "var(--hang-h)" }}>
          {picker}
        </div>
      )}
    </div>
  );
}
