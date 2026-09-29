/**
 * Every dictionary MiColl ships, keyed by language.
 *
 * English's file holds only plural forms: every other string *is* the key (see
 * lib/i18n.ts) and falls through untouched. A counted string can't — see en.ts.
 *
 * All of them are imported eagerly. Ten dictionaries this size are smaller than one
 * of the app's icons, and lazy-loading them would mean the first paint after a
 * language change flashes English.
 */

/** English source string → its translation. */
export type Dict = Record<string, string>;

import { dict as en } from "./en";
import { dict as de } from "./de";
import { dict as es } from "./es";
import { dict as fr } from "./fr";
import { dict as ptBR } from "./pt-BR";
import { dict as it } from "./it";
import { dict as pl } from "./pl";
import { dict as ru } from "./ru";
import { dict as ja } from "./ja";
import { dict as zhHans } from "./zh-Hans";

export const DICTIONARIES: Record<string, Dict> = {
  en,
  de: de,
  es: es,
  fr: fr,
  "pt-BR": ptBR,
  it: it,
  pl: pl,
  ru: ru,
  ja: ja,
  "zh-Hans": zhHans,
};
