import { useT, useTf } from "@/lib/i18n";

/** Max names before it gets too long. */
const SHOWN = 10;

/** The creators a MiSD run will touch, listed in the confirmation so you can check them. */
export function SdQueuedCreators({ names }: { names: string[] }) {
  const t = useT();
  const tf = useTf();
  if (names.length === 0) return null;
  const shown = names.slice(0, SHOWN);
  const rest = names.length - shown.length;
  return (
    <p className="mt-3 text-sm text-zinc-400">
      <span className="text-zinc-500">{t("Affected creators")}: </span>
      <span className="text-zinc-300">{shown.join(", ")}</span>
      {rest > 0 && <span className="text-zinc-500"> {tf("and {n} more", { n: rest })}</span>}
    </p>
  );
}
