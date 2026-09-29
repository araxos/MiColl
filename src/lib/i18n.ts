/**
 * Translations.
 *
 * The key is the English text: t("Appearance") looks it up and returns the English
 * if there's no translation yet. If you change an English string, change the key
 * in the locale files too.
 *
 * The chosen language is synced with the library (see prefs.ts).
 * "system" is saved as is, so it keeps following the Windows language.
 */

import { useEffect, useState } from "react";
import { queuePrefsSync } from "@/lib/prefs";
import { DICTIONARIES, type Dict } from "@/locales";

/** A language option. "system" is only a choice, never the result. */
export type LangKey =
  | "system"
  | "en"
  | "de"
  | "es"
  | "fr"
  | "pt-BR"
  | "it"
  | "pl"
  | "ru"
  | "ja"
  | "zh-Hans";

/** A language that actually gets shown (system resolved). */
export type ResolvedLang = Exclude<LangKey, "system">;

export interface LanguageDef {
  key: ResolvedLang;
  /** The name in the language itself. */
  native: string;
  /** English name, shown below it. */
  english: string;
  /**
   * Language tags for matching the system language, longest first ("pt" also matches
   * pt-BR).
   */
  tags: string[];
}

/**
 * Available languages. No right-to-left languages yet (would need a lot of layout work).
 */
export const LANGUAGES: LanguageDef[] = [
  { key: "en", native: "English", english: "English", tags: ["en"] },
  { key: "de", native: "Deutsch", english: "German", tags: ["de"] },
  { key: "es", native: "Español", english: "Spanish", tags: ["es"] },
  { key: "fr", native: "Français", english: "French", tags: ["fr"] },
  { key: "pt-BR", native: "Português (Brasil)", english: "Portuguese (Brazil)", tags: ["pt-BR", "pt"] },
  { key: "it", native: "Italiano", english: "Italian", tags: ["it"] },
  { key: "pl", native: "Polski", english: "Polish", tags: ["pl"] },
  { key: "ru", native: "Русский", english: "Russian", tags: ["ru"] },
  { key: "ja", native: "日本語", english: "Japanese", tags: ["ja"] },
  { key: "zh-Hans", native: "中文（简体）", english: "Chinese (Simplified)", tags: ["zh-Hans", "zh-CN", "zh"] },
];

const STORAGE_KEY = "micoll.language";
const FALLBACK: ResolvedLang = "en";

const isLang = (v: string | null): v is LangKey =>
  v === "system" || LANGUAGES.some((l) => l.key === v);

/** The saved choice (can be "system"). */
export function getLanguage(): LangKey {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLang(v) ? v : "system";
  } catch {
    return "system";
  }
}

/** Which of our languages the computer wants, if any. */
export function systemLanguage(): ResolvedLang | null {
  const wanted = (navigator.languages?.length ? navigator.languages : [navigator.language]).filter(
    Boolean,
  );
  for (const want of wanted) {
    const lower = want.toLowerCase();
    // longest tag first so "pt-BR" wins over "pt"
    for (const l of LANGUAGES) {
      for (const tag of l.tags) {
        if (lower === tag.toLowerCase() || lower.startsWith(tag.toLowerCase() + "-")) return l.key;
      }
    }
  }
  return null;
}

/** The language that's shown right now. */
export function resolveLanguage(choice: LangKey = getLanguage()): ResolvedLang {
  if (choice !== "system") return choice;
  return systemLanguage() ?? FALLBACK;
}

const listeners = new Set<() => void>();

export function setLanguage(choice: LangKey): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* ignore */
  }
  applyDocumentLang();
  queuePrefsSync();
  listeners.forEach((l) => l());
}

/** Keep <html lang> correct (screen readers, spell check). */
export function applyDocumentLang(): void {
  try {
    document.documentElement.lang = resolveLanguage();
  } catch {
    /* ignore */
  }
}

/* ---- Looking a string up ------------------------------------------------ */

function dictFor(lang: ResolvedLang): Dict {
  return DICTIONARIES[lang] ?? {};
}

/**
 * Translate one English string. Returns the English if there's no translation.
 * Not a hook, use useT() in components so they re-render on a language change.
 */
export function t(text: string): string {
  return dictFor(resolveLanguage())[text] ?? text;
}

/**
 * Fill in values, e.g. tf("{n} hidden", { n: 4 }).
 * Named placeholders so translators can move them around.
 */
export function format(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** t + format in one call. */
export function tf(text: string, vars: Record<string, string | number>): string {
  return format(t(text), vars);
}

/**
 * Translate a counted string ("1 month" / "3 months").
 * tp("{n} months", 3) looks up "{n} months#other" etc. using Intl.PluralRules.
 * {n} is filled in automatically. English plurals are in locales/en.ts.
 */
const RULES = new Map<string, Intl.PluralRules>();

export function tp(text: string, count: number, vars: Record<string, string | number> = {}): string {
  const lang = resolveLanguage();
  let rules = RULES.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(lang);
    RULES.set(lang, rules);
  }
  const dict = dictFor(lang);
  const cat = rules.select(count);
  const raw = dict[`${text}#${cat}`] ?? dict[`${text}#other`] ?? dict[text] ?? text;
  return format(raw, { n: count, ...vars });
}

/** Subscribe to the language. */
export function useLanguage(): LangKey {
  const [choice, setChoice] = useState(getLanguage);
  useEffect(() => {
    const l = () => setChoice(getLanguage());
    l();
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return choice;
}

/** t that re-renders the component when the language changes. */
export function useT(): (text: string) => string {
  const choice = useLanguage();
  const lang = resolveLanguage(choice);
  const dict = dictFor(lang);
  return (text: string) => dict[text] ?? text;
}

/** useT for counted strings. */
export function useTp(): (
  text: string,
  count: number,
  vars?: Record<string, string | number>,
) => string {
  // we only need the subscription, tp reads the language itself
  useLanguage();
  return tp;
}

/** useT for strings with values. */
export function useTf(): (text: string, vars: Record<string, string | number>) => string {
  const t = useT();
  return (text, vars) => format(t(text), vars);
}

/** Short month names in the current language, from Intl.DateTimeFormat. */
const MONTHS_SHORT = new Map<string, string[]>();

export function monthsShort(): string[] {
  const lang = resolveLanguage();
  let out = MONTHS_SHORT.get(lang);
  if (!out) {
    const fmt = new Intl.DateTimeFormat(lang, { month: "short" });
    // middle of the month so time zones can't change the month
    out = Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2000, i, 15))));
    MONTHS_SHORT.set(lang, out);
  }
  return out;
}

/** monthsShort, updates on language change. */
export function useMonthsShort(): string[] {
  useLanguage();
  return monthsShort();
}
