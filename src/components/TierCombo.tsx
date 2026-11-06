import { NameCombo } from "@/components/NameCombo";
import { useTf } from "@/lib/i18n";
import { tierLabel } from "@/lib/tier";

/** Tier field of the import review: free text with the creator's tiers below it. */
export function TierCombo(props: {
  value: string;
  onCommit: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  title?: string;
  className?: string;
  /** Focus it when it appears (opened by the tier icon). */
  autoFocus?: boolean;
  /** The field lost the focus, with what it holds now. */
  onLeave?: (v: string) => void;
}) {
  const tf = useTf();
  return <NameCombo {...props} maxLength={40} label={(s) => tierLabel(s, tf)} />;
}
