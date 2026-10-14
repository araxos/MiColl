import { useEffect, useRef } from "react";
import { Minus, X, Square, Columns2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/Button";
import { useActions } from "@/actions";
import { type MenuItem } from "@/components/ContextMenu";
import { useT } from "@/lib/i18n";
import { useCloseAction, toggleCloseAction } from "@/lib/closeAction";
import { useWindowButtons, toggleWindowButtons } from "@/lib/windowButtons";

/**
 * Minimize and close buttons (the window has no OS title bar).
 * Two buttons by default. Settings can merge them into one (closeAction) with the
 * other action on double click, that one waits 230ms on every click.
 * Used by the header and the lock screen (same place).
 * Callers check isTauri().
 */
export function WindowControls({ menus = true }: { menus?: boolean }) {
  const t = useT();
  const { openMenu } = useActions();
  const closeAction = useCloseAction();
  const winButtons = useWindowButtons();
  const win = () => getCurrentWindow();
  const runWin = (what: "close" | "minimize") =>
    what === "close" ? void win().close() : void win().minimize();
  const other = closeAction === "close" ? "minimize" : "close";

  const clickTimer = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(clickTimer.current ?? undefined), []);
  const winBtnClick = () => {
    if (clickTimer.current) return; // the dblclick handler takes this one
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      runWin(closeAction);
    }, 230);
  };
  const winBtnDouble = () => {
    window.clearTimeout(clickTimer.current ?? undefined);
    clickTimer.current = null;
    runWin(other);
  };

  // right-click offers the other layout (off on the lock screen)
  const ctx = (items: () => MenuItem[]) =>
    menus ? { onContextMenu: (e: React.MouseEvent) => openMenu(e, items()) } : {};

  const pairMenu = () => [
    {
      label: t("Use one window button"),
      icon: <Square className="h-4 w-4" />,
      onClick: toggleWindowButtons,
    },
    { label: t("One click for the default, double-click for the other"), info: true },
  ];

  if (winButtons === "both") {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => runWin("minimize")}
          {...ctx(pairMenu)}
          title={t("Minimize")}
          className="hover:bg-brand-500/15 hover:text-brand-200"
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => runWin("close")}
          {...ctx(pairMenu)}
          // close gets red on hover
          title={t("Close MiColl")}
          className="hover:bg-rose-500/20 hover:text-rose-200"
        >
          <X className="h-4 w-4" />
        </Button>
      </>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={winBtnClick}
      onDoubleClick={winBtnDouble}
      {...ctx(() => [
        {
          label: other === "minimize" ? t("Change default to minimize") : t("Change default to close"),
          icon: other === "minimize" ? <Minus className="h-4 w-4" /> : <X className="h-4 w-4" />,
          onClick: toggleCloseAction,
        },
        { label: other === "minimize" ? t("Double-click to minimize") : t("Double-click to close"), info: true },
        {
          label: t("Show both window buttons"),
          icon: <Columns2 className="h-4 w-4" />,
          onClick: toggleWindowButtons,
        },
      ])}
      title={
        closeAction === "close"
          ? t("Close MiColl (double-click to minimize, right-click for options)")
          : t("Minimize (double-click to close, right-click for options)")
      }
      className={
        closeAction === "close"
          ? "hover:bg-rose-500/20 hover:text-rose-200"
          : "hover:bg-brand-500/15 hover:text-brand-200"
      }
    >
      {closeAction === "close" ? <X className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
    </Button>
  );
}
