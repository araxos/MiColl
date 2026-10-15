/**
 * The optional error log, webview side (Rust side: src-tauri/src/applog.rs).
 * Off by default. When on, console errors/warnings, uncaught errors and error toasts
 * are written to the log file next to the database. Turning it off deletes the files.
 */
import { useEffect, useState } from "react";
import { invoke, isTauri } from "@/lib/tauri";

const SETTING_KEY = "log_enabled";

let on = false;
const listeners = new Set<() => void>();

/** Write one line (no-op while the log is off). */
export function logLine(level: "error" | "warn" | "info", message: string): void {
  if (!on || !isTauri() || !allowed(message)) return;
  void invoke("log_write", { level, message }).catch(() => {});
}

// a loop that logs on every frame must not fill the disk: at most 30 lines per 10 s,
// and the same message twice in a row only once
let windowStart = 0;
let inWindow = 0;
let last = "";
function allowed(message: string): boolean {
  if (message === last) return false;
  last = message;
  const now = Date.now();
  if (now - windowStart > 10_000) {
    windowStart = now;
    inWindow = 0;
  }
  return ++inWindow <= 30;
}

function describe(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

let installed = false;

/** Read the saved switch and hook into the console and the global error events. */
export async function initAppLog(): Promise<void> {
  if (!isTauri() || installed) return;
  installed = true;
  try {
    on = (await invoke<string | null>("get_setting", { key: SETTING_KEY })) === "true";
  } catch {
    on = false;
  }
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      logLine(level, args.map(describe).join(" "));
    };
  }
  window.addEventListener("error", (e) => {
    logLine("error", `Uncaught: ${e.error ? describe(e.error) : e.message}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logLine("error", `Unhandled promise rejection: ${describe(e.reason)}`);
  });
}

export function logEnabled(): boolean {
  return on;
}

/** Turn the log on or off (off deletes the log files). */
export async function setLogEnabled(next: boolean): Promise<void> {
  await invoke("log_set_enabled", { on: next });
  on = next;
  listeners.forEach((l) => l());
}

/** The switch, kept in sync between the settings row and the feedback form. */
export function useLogEnabled(): boolean {
  const [v, setV] = useState(on);
  useEffect(() => {
    const l = () => setV(on);
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}

/** The newest lines for the feedback form, user folder hidden ("" = nothing yet). */
export function recentLog(): Promise<string> {
  return invoke<string>("log_recent");
}

export function openLogFolder(): Promise<void> {
  return invoke("open_log_folder");
}
