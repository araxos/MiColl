/**
 * Setting: remove the creator's name from imported reward names.
 * Files often come as "Creator - Reward" or "[Creator] - [Reward]". Since MiColl
 * already files them under the creator, the name is removed:
 * "[Nora] - [March set]" -> "[March set]".
 * Off by default because it changes the original name.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";

const STORAGE_KEY = "micoll.stripCreator";

export function getStripCreator(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setStripCreator(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Subscribe to the setting. */
export function useStripCreator(): boolean {
  const [on, setOn] = useState(getStripCreator);
  useEffect(() => {
    const l = () => setOn(getStripCreator());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}

/* ---- the rewrite ------------------------------------------------------- */

/** Brackets around names (opener -> closer), including the CJK ones. */
const BRACKETS: Record<string, string> = {
  "[": "]",
  "(": ")",
  "{": "}",
  "【": "】",
  "「": "」",
  "『": "』",
  "《": "》",
  "〈": "〉",
  "（": "）",
};

/** Characters that join creator and title. No space, a two-word name is one name. */
const SEPARATOR = /[-–—_|~:·・+]/;

/**
 * Index of the matching closing bracket, counts nesting ([[alias]name] is one group).
 * -1 if it's never closed.
 */
function matchingClose(title: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < title.length; i++) {
    if (title[i] === open) depth++;
    else if (title[i] === close && --depth === 0) return i;
  }
  return -1;
}

type Piece =
  | { kind: "text"; text: string }
  | { kind: "sep"; text: string }
  | { kind: "bracket"; text: string; inner: string };

/**
 * Split the title into bracket groups, separators and plain text.
 * This way "[Nora and friends]" stays whole instead of losing "Nora" from the middle.
 */
function pieces(title: string): Piece[] {
  const out: Piece[] = [];
  let run = "";
  const flush = () => {
    if (run) out.push({ kind: "text", text: run });
    run = "";
  };
  for (let i = 0; i < title.length; i++) {
    const c = title[i];
    const closer = BRACKETS[c];
    if (closer) {
      const end = matchingClose(title, i, c, closer);
      if (end > i) {
        flush();
        out.push({ kind: "bracket", text: title.slice(i, end + 1), inner: title.slice(i + 1, end) });
        i = end;
        continue;
      }
    }
    if (SEPARATOR.test(c)) {
      flush();
      out.push({ kind: "sep", text: c });
      continue;
    }
    run += c;
  }
  flush();
  return out;
}

const blank = (p: Piece) => p.kind === "text" && p.text.trim() === "";

/** Everything around handles that isn't part of them (separators, joiners, brackets). */
const FILLER = /[\s_.\-–—|~:·・+\[\](){}【】「」『』《》〈〉（）]+/g;

/**
 * Is text only made of the creator's handles? One or several, any order,
 * with or without separators: Nora, Nora_Nori, NoriNora, [Nori] Nora, [[Nori]Nora].
 */
function onlyHandles(text: string, handles: string[]): boolean {
  const s = text.toLowerCase().replace(FILLER, "");
  if (!s) return false;
  // can s be split into handles from front to back? (ok[i] = first i chars can)
  const ok = new Array<boolean>(s.length + 1).fill(false);
  ok[0] = true;
  for (let i = 0; i < s.length; i++) {
    if (!ok[i]) continue;
    for (const h of handles) if (h && s.startsWith(h, i)) ok[i + h.length] = true;
  }
  return ok[s.length];
}

/**
 * Remove the creator from title: every piece that's only their name/aliases,
 * with its brackets and the separator next to it.
 * Pieces with other text stay. Returns the title unchanged if nothing matches
 * or if nothing would be left (a folder called just "[Nora]").
 */
export function stripHandles(title: string, handles: string[]): string {
  // normalize the same way as the text
  const hs = [...new Set(handles.map((h) => h.toLowerCase().replace(FILLER, "")).filter(Boolean))];
  if (hs.length === 0) return title;
  const parts = pieces(title);
  const hits = parts
    .map((p, i) =>
      p.kind !== "sep" && onlyHandles(p.kind === "bracket" ? p.inner : p.text, hs) ? i : -1,
    )
    .filter((i) => i >= 0);
  if (hits.length === 0) return title;

  const drop = new Set<number>(hits);
  for (const hit of hits) {
    // also remove the separator after it (or before it if there's none after)
    let j = hit + 1;
    while (j < parts.length && blank(parts[j])) j++;
    if (j < parts.length && parts[j].kind === "sep") {
      drop.add(j);
      continue;
    }
    let k = hit - 1;
    while (k >= 0 && blank(parts[k])) k--;
    if (k >= 0 && parts[k].kind === "sep") drop.add(k);
  }

  const out = parts
    .filter((_, i) => !drop.has(i))
    .map((p) => p.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  // never return an empty name or only punctuation
  return out && /[^\s\-–—_|~:·・+]/.test(out) ? out : title;
}
