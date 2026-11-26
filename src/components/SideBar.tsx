import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutDashboard, NotebookPen, Settings, Wallpaper } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppLogo } from "@/components/AppLogo";
import { useT } from "@/lib/i18n";
import { useReturnToDashboard } from "@/lib/nav";
import { scrollPageToTop } from "@/lib/pageScroll";
import { setSidebarText, useSidebar, useSidebarText } from "@/lib/sidebar";
import { isTauri } from "@/lib/tauri";
import { toggleOnClass, useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * The bar on the left of every page: the logo (hides it), the app's main pages and the
 * bar's own settings at the bottom. With the mouse on the page buttons it opens over the
 * page with their names (if they're on); the top bar stays uncovered. The theme looks are
 * in index.css (.side-*).
 */
export function SideBar() {
  return useSidebar() ? <Rail /> : null;
}

function Rail() {
  const text = useSidebarText();
  return (
    <nav
      data-text={text || undefined}
      className="side-rail relative z-40 flex w-12 shrink-0 flex-col"
    >
      <div
        {...(isTauri() ? { "data-tauri-drag-region": true } : {})}
        // the logo at the same spot as in the top bar (its border included)
        className="flex h-[52px] shrink-0 items-center pb-px pl-2"
      >
        <AppLogo />
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="side-panel absolute inset-y-0 left-0 w-12 overflow-hidden pl-1.5 pr-[5px] pt-3">
          <PageList />
          <SideSettings />
        </div>
      </div>
    </nav>
  );
}

/** The gear at the bar's bottom: a small panel next to it with the bar's own settings. */
function SideSettings() {
  const t = useT();
  const text = useSidebarText();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        title={t("Sidebar settings")}
        aria-label={t("Sidebar settings")}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className="side-item side-gear absolute bottom-2 left-1.5 flex h-9 w-9 items-center justify-center rounded-lg"
      >
        <Settings className="h-[18px] w-[18px]" />
      </button>
      {open &&
        createPortal(
          <>
            {/* click-away layer */}
            <div
              className="fixed inset-0 z-[70]"
              onClick={() => setOpen(false)}
              onContextMenu={(e) => {
                e.preventDefault();
                setOpen(false);
              }}
            />
            <div className="side-pop fixed bottom-2 left-14 z-[71] min-w-[13rem] p-1.5">
              <SettingRow label={t("Hide text")} checked={!text} onChange={(v) => setSidebarText(!v)} />
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

function SettingRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const accent = useAccent();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!checked)}
      className="side-pop-row flex w-full items-center justify-between gap-6 whitespace-nowrap px-2.5 py-2 text-left text-sm font-medium"
    >
      {label}
      <span
        data-on={checked || undefined}
        className={cn(
          "micoll-switch relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          checked ? toggleOnClass(accent) : "bg-zinc-700",
        )}
      >
        <span
          className={cn(
            "micoll-switch-knob inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

/**
 * The logo in the top bar while the bar is hidden: under the mouse the page buttons slide
 * down below it.
 */
export function LogoMenu() {
  const ref = useRef<HTMLElement | null>(null);
  const text = useSidebarText();
  // Off until the mouse was somewhere else: it's still on the logo after the click that
  // hid the bar, and on the list after a pick.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (armed) return;
    const onMove = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setArmed(true);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [armed]);

  return (
    <nav
      ref={ref}
      data-armed={armed || undefined}
      data-text={text || undefined}
      className="side-peek relative shrink-0"
    >
      <AppLogo />
      <div className="side-drop-clip absolute">
        <div className="side-drop w-11 overflow-hidden p-[3px]">
          <PageList onPick={() => setArmed(false)} />
        </div>
      </div>
    </nav>
  );
}

/** The main pages as buttons, the panel around them opens with the mouse on the list. */
function PageList({ onPick }: { onPick?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const returnToDashboard = useReturnToDashboard();
  const { pathname } = useLocation();
  const onWallpapers = pathname.startsWith("/wallpapers");
  const onNotes = pathname.startsWith("/notes");
  // the pages next to the dashboard; Dashboard from one of them goes back to where it was
  const aside = onWallpapers || onNotes;

  // creators, wishlist, settings… all hang under the dashboard
  const pages = [
    { path: "/", Icon: LayoutDashboard, title: t("Dashboard"), here: !aside },
    { path: "/wallpapers", Icon: Wallpaper, title: t("Wallpaper Hub"), here: onWallpapers },
    { path: "/notes", Icon: NotebookPen, title: t("Notes"), here: onNotes },
  ];

  return (
    <div className="side-list flex flex-col gap-1.5">
      {pages.map(({ path, Icon, title, here }) => (
        <button
          key={path}
          type="button"
          data-current={here || undefined}
          aria-current={here ? "page" : undefined}
          aria-label={title}
          // a click leaves no focus here (a key would then act on the button)
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onPick?.();
            if (pathname === path) scrollPageToTop();
            else if (path === "/" && aside) returnToDashboard();
            else navigate(path);
          }}
          className="side-item relative flex h-9 w-full shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap rounded-lg px-2 text-left text-sm font-medium"
        >
          <Icon className="h-[18px] w-[18px] shrink-0" />
          <span className="side-label">{title}</span>
        </button>
      ))}
    </div>
  );
}
