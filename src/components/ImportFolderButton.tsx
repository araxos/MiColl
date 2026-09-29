import { useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "framer-motion";
import { FolderInput } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { ImportReviewTree } from "@/components/ImportReviewTree";
import { useData } from "@/store";
import { useActions } from "@/actions";
import * as api from "@/api/library";
import { useT, useTf, useTp } from "@/lib/i18n";

/**
 * Import a folder from the dashboard. Picks a folder, analyzes it (artist / platform /
 * year / month), opens the review and then imports (moves it into the managed collection
 * if that's on). Needs the desktop app.
 */
export function ImportFolderButton({ className }: { className?: string }) {
  const { refresh, backed } = useData();
  const { showToast } = useActions();
  const [review, setReview] = useState<api.ImportPlan | null>(null);
  const t = useT();
  const tf = useTf();
  const tp = useTp();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("Choose a creator or library folder to import"),
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const plan = await api.analyzeImport(picked);
      setSource(picked);
      setReview(plan);
    } catch (e) {
      showToast({ tone: "error", title: t("Couldn’t analyze that folder"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (
    rewards: api.ResolvedReward[],
    opts: { styles: api.StyleChoice[]; openAsCards: boolean },
  ) => {
    setBusy(true);
    try {
      const s = await api.commitImport(rewards, source, opts.styles, opts.openAsCards);
      // managed mode: move the new content into the collection and remove the old folder
      const [managed, root] = await Promise.all([
        api.getSetting("managed_enabled"),
        api.getSetting("collection_root"),
      ]);
      const intoCollection = managed === "true" && !!root;
      // show organize problems (same as in actions.tsx)
      let orgTrouble: string | undefined;
      if (intoCollection) {
        const org = await api.organizeCollection();
        await api.clearRoots();
        if (org.failed > 0 || org.errors.length > 0) {
          orgTrouble = org.errors.slice(0, 2).join(" · ");
        }
      }
      setReview(null);
      await refresh();
      showToast({
        tone: s.needsReview > 0 || orgTrouble ? "warn" : "success",
        title: tf("Imported {n}", { n: tp("{n} rewards", s.rewards) }),
        detail: intoCollection
          ? t("Moved into your collection.")
          : tf("across {n}.", { n: tp("{n} creators", s.artists) }),
        problem:
          [
            s.needsReview > 0 ? tf("{n} still need a platform", { n: s.needsReview }) : null,
            orgTrouble,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      });
    } catch (e) {
      showToast({ tone: "error", title: t("Import failed"), detail: `${e}` });
    } finally {
      setBusy(false);
    }
  };

  if (!backed) return null;

  return (
    <>
      <Button
        variant="outline"
        onClick={choose}
        disabled={busy}
        className={className}
        title={t(
          "Import a creator or library folder — auto-detects platform / year / month, then lets you review",
        )}
      >
        <FolderInput className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
        {busy && !review ? t("Scanning…") : t("Import folder")}
      </Button>

      {/* portal to <body>, otherwise the header's blur/transform would trap the fixed
          overlay */}
      {createPortal(
        <AnimatePresence>
          {review && (
            <ImportReviewTree
              plan={review}
              busy={busy}
              sourcePath={source}
              allowCombine={false}
              onConfirm={doImport}
              onCancel={() => setReview(null)}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
