import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { HISTORY_CHANGED_EVENT, useActions } from "@/actions";
import { useT, useTp } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import { useData } from "@/store";

/** A reward that got something from the phone (bridge.rs ArrivedPlace). */
interface Place {
  artistId: number;
  periodId: number;
  rewardId: number;
  creator: string;
  period: string;
  reward: string;
  files: number;
  versions: number;
}

interface PhoneUpload {
  files: number;
  versions: number;
  places: Place[];
}

/** Arrivals this close after each other go into the same toast. */
const SAME_BATCH_MS = 60_000;

/**
 * Pictures and versions the phone app sent (bridge.rs): the bridge has already read
 * the creators in, here the library reloads and ONE toast says what came and where,
 * with a button to that reward. More arrivals replace it with the new totals.
 * Also warns when the bridge shut a device out for guessing pairing keys.
 */
export function PhoneUploads() {
  const t = useT();
  const tp = useTp();
  const navigate = useNavigate();
  const { refresh } = useData();
  const { showToast, dismissToast } = useActions();
  // the running batch: totals, the rewards (newest last) and its toast
  const batch = useRef<{ at: number; toast: number; files: number; versions: number; places: Place[] } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void listen<PhoneUpload>("phone-upload", (e) => {
      void refresh();
      // it's in the history now
      window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT));

      const now = Date.now();
      const prev = batch.current && now - batch.current.at < SAME_BATCH_MS ? batch.current : null;
      const files = (prev?.files ?? 0) + e.payload.files;
      const versions = (prev?.versions ?? 0) + e.payload.versions;
      const places = [...(prev?.places ?? [])];
      for (const p of e.payload.places) {
        const i = places.findIndex((x) => x.rewardId === p.rewardId);
        const merged = i >= 0 ? { ...p, files: places[i].files + p.files, versions: places[i].versions + p.versions } : p;
        if (i >= 0) places.splice(i, 1);
        places.push(merged);
      }
      if (prev) dismissToast(prev.toast);

      const latest = places[places.length - 1];
      const where = latest ? `${latest.creator} › ${latest.period} › ${latest.reward}` : "";
      const detail = [
        where + (places.length > 1 ? ` ${tp("and {n} more rewards", places.length - 1)}` : ""),
        files > 0 && versions > 0 ? tp("{n} edited versions", versions) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const toast = showToast({
        tone: "success",
        title:
          files > 0
            ? tp("{n} files from your phone", files)
            : tp("{n} edited versions from your phone", versions),
        detail: detail || undefined,
        duration: 12_000,
        action: latest
          ? {
              label: places.length > 1 ? t("Go to latest reward") : t("Go to reward"),
              onClick: () => navigate(`/artist/${latest.artistId}/month/${latest.periodId}`),
            }
          : undefined,
      });
      batch.current = { at: now, toast, files, versions, places };
    }).then((u) => {
      if (alive) off = u;
      else u();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [refresh, showToast, dismissToast, navigate, t, tp]);

  // a device on the network tried too many wrong pairing keys
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void listen<{ ip: string; minutes: number }>("phone-bridge-blocked", (e) => {
      showToast({
        tone: "warn",
        title: t("A device was shut out of MiColl Mobile"),
        detail: t("{ip} tried many wrong pairing keys and can't connect for {n} minutes. If that wasn't your phone, make a new pairing key in Settings.")
          .replace("{ip}", e.payload.ip)
          .replace("{n}", String(e.payload.minutes)),
        duration: 20_000,
      });
    }).then((u) => {
      if (alive) off = u;
      else u();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [showToast, t]);

  return null;
}
