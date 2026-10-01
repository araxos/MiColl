import { FolderInput } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useData } from "@/store";
import { useActions } from "@/actions";
import { useT } from "@/lib/i18n";

/**
 * Import a folder from the dashboard, an icon button next to Stats / Recently updated.
 * Runs the same import as dropping a folder onto the window (actions.addRewards): move
 * notice in managed mode, review, organize, encrypt. Needs the desktop app.
 */
export function ImportFolderButton({ className }: { className?: string }) {
  const { backed } = useData();
  const { addRewards } = useActions();
  const t = useT();

  if (!backed) return null;

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => void addRewards()}
      className={className}
      title={t("Import folder")}
    >
      <FolderInput className="h-4 w-4" />
    </Button>
  );
}
