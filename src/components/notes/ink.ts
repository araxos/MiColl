import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * The greys of the notes page. On Iridescent's light glass the usual zinc-400/500 can't
 * be read, there they're lighter.
 */
export function useInk() {
  const irid = useAccent() === "iridescent";
  return irid
    ? { soft: "text-zinc-100", faint: "text-zinc-200", hint: cn("placeholder:text-zinc-300") }
    : { soft: "text-zinc-400", faint: "text-zinc-500", hint: "placeholder:text-zinc-500" };
}
