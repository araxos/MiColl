import { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { ChevronRight, LayoutDashboard, Wallpaper } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useDialogTheme } from "@/lib/dialogTheme";
import { isPremium, useAccent } from "@/lib/theme";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The main menu behind the page name in the top bar (Dashboard, Wallpaper Hub). Bigger
 * than a right-click menu: a tile per page with its icon, name and a line on what's
 * there, the current page marked. The theme looks are in index.css (.ps-*); on pyre
 * it borrows the right-click menu's chrome plate and lit row (ctx-menu / ctx-row).
 */
export function PageSwitcher({
  x,
  y,
  current,
  onClose,
}: {
  x: number;
  y: number;
  current: "dashboard" | "wallpapers" | null;
  onClose: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { menu } = useDialogTheme();
  const accent = useAccent();
  const ruby = accent === "corruptruby";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pages = [
    {
      key: "dashboard" as const,
      path: "/",
      Icon: LayoutDashboard,
      title: t("Dashboard"),
    },
    {
      key: "wallpapers" as const,
      path: "/wallpapers",
      Icon: Wallpaper,
      title: t("Wallpaper Hub"),
    },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: -6, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
        style={{ left: x, top: y, transformOrigin: "top left" }}
        // absolute last: iridescent's menu class brings `relative`
        className={cn(
          "ps-panel w-[220px] p-1",
          menu,
          ruby && "ctx-menu",
          !isPremium(accent) && "ps-panel--tint",
          "absolute",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <span aria-hidden className="ps-line" />
        <div className="ps-head px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]">
          {t("Pages")}
        </div>
        {pages.map(({ key, path, Icon, title }) => {
          const here = key === current;
          return (
            <button
              key={key}
              type="button"
              data-current={here || undefined}
              // pyre: the right-click row's pink wash and ruby mark the current page
              data-open={(ruby && here) || undefined}
              onClick={() => {
                onClose();
                if (!here) navigate(path);
              }}
              className={cn(
                "ps-row group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                ruby && "ctx-row",
              )}
            >
              <span className="ps-tile flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
                <Icon className="h-4 w-4" />
              </span>
              <span className="ps-title min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
              {here ? (
                <span
                  aria-label={t("You are here")}
                  title={t("You are here")}
                  className="ps-dot"
                />
              ) : (
                <ChevronRight className="ps-go h-4 w-4 shrink-0" />
              )}
            </button>
          );
        })}
      </motion.div>
    </div>,
    document.body,
  );
}
