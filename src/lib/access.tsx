import { Check, CircleDollarSign, Droplet, Gift, X } from "lucide-react";
import type { MenuItem } from "@/components/ContextMenu";

/**
 * How the user got a reward: free, paid or leaked. The user's own mark, on a reward or
 * a whole month (its rewards without their own mark get the month's).
 */
export type Access = "free" | "paid" | "leaked";
export const ACCESS_KINDS: Access[] = ["free", "paid", "leaked"];

// "Free (access)": plain "Free" is the crop editor's (German "Frei"); English shows the
// key without the note
export const accessLabel = (a: Access, t: (s: string) => string) =>
  a === "free" ? t("Free (access)").replace(/ \(access\)$/, "") : a === "paid" ? t("Paid") : t("Leaked");

export function AccessIcon({ access, className = "h-3 w-3" }: { access: Access; className?: string }) {
  if (access === "free") return <Gift className={`${className} text-amber-300`} />;
  if (access === "paid") return <CircleDollarSign className={`${className} text-emerald-300`} />;
  return <Droplet className={`${className} text-rose-300`} />;
}

/** The submenu: the three marks (the current one checked) and "No mark" when one is set. */
export function accessMenu(
  current: string | null | undefined,
  t: (s: string) => string,
  pick: (a: Access | null) => void,
): MenuItem[] {
  return [
    ...ACCESS_KINDS.map((a) => ({
      label: accessLabel(a, t),
      icon: current === a ? <Check className="h-4 w-4" /> : <AccessIcon access={a} className="h-4 w-4" />,
      onClick: () => pick(a),
    })),
    ...(current
      ? [
          {
            label: t("No mark"),
            icon: <X className="h-4 w-4" />,
            onClick: () => pick(null),
          },
        ]
      : []),
  ];
}
