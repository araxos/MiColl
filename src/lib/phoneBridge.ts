/**
 * The phone bridge switch (Settings → Phone app). While on, the MiColl phone app can
 * show the collection and download from it over the Wi-Fi (bridge.rs). It only runs
 * while MiColl is unlocked: App.tsx calls setPhoneBridgeActive.
 * Off by default and not synced with the library: a restored backup or a portable
 * copy shouldn't open the collection to the network by itself.
 */

import { useEffect, useState } from "react";
import {
  phoneBridgeNewKey,
  phoneBridgeStart,
  phoneBridgeStop,
  phoneBridgeTrustNetwork,
  type PhoneBridgeInfo,
} from "@/api/library";

const STORAGE_KEY = "micoll.phoneBridge";

export function getPhoneBridge(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

interface BridgeStatus {
  info: PhoneBridgeInfo | null;
  error: string | null;
}

let status: BridgeStatus = { info: null, error: null };
// unlocked and booted
let active = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// start/stop one after the other, a fast on/off/on must end in the last state
let chain: Promise<void> = Promise.resolve();
function apply() {
  chain = chain.then(async () => {
    const want = active && getPhoneBridge();
    try {
      if (want) {
        status = { info: await phoneBridgeStart(), error: null };
      } else if (status.info) {
        await phoneBridgeStop();
        status = { info: null, error: null };
      } else {
        status = { info: null, error: null };
      }
    } catch (e) {
      status = { info: null, error: String(e) };
    }
    notify();
  });
}

export function setPhoneBridge(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  notify();
  apply();
}

/** MiColl unlocked (true) or locked (false): the bridge follows. */
export function setPhoneBridgeActive(on: boolean): void {
  if (active === on) return;
  active = on;
  apply();
}

/** Ask again (Settings opened, the network may have changed). */
export function refreshPhoneBridge(): void {
  apply();
}

/** A new pairing key, the phones have to scan the new code. */
export async function newPhoneBridgeKey(): Promise<void> {
  const info = await phoneBridgeNewKey();
  if (status.info) status = { info, error: null };
  notify();
}

/** Answer on this public network after all (or not anymore). */
export async function trustPhoneNetwork(id: string, allow: boolean): Promise<void> {
  const info = await phoneBridgeTrustNetwork(id, allow);
  if (status.info) status = { info, error: null };
  notify();
}

/** The switch and what the bridge is doing. */
export function usePhoneBridge(): BridgeStatus & { on: boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return { ...status, on: getPhoneBridge() };
}
