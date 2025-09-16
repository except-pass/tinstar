import { Code, Map } from "lucide-react";
import type { FC } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";

interface ModeBadgeProps {
  mode?: "plan" | "acceptEdits" | "bypassPermissions" | "default";
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
}

export const ModeBadge: FC<ModeBadgeProps> = ({
  mode,
  className,
  onClick,
  disabled,
}) => {
  if (!mode) return null;

  const isPlanMode = mode === "plan";
  const isCodeMode = mode === "acceptEdits" || mode === "bypassPermissions";

  if (!isPlanMode && !isCodeMode) return null;

  return (
    <Badge
      variant={isPlanMode ? "secondary" : "default"}
      className={cn(
        "flex items-center gap-1",
        isPlanMode
          ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800"
          : "bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-800",
        onClick &&
          !disabled &&
          "cursor-pointer hover:opacity-80 transition-opacity",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
      onClick={disabled ? undefined : onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick && !disabled ? 0 : undefined}
      title={
        onClick && !disabled
          ? `Click to switch to ${isPlanMode ? "Code" : "Plan"} Mode`
          : undefined
      }
    >
      {isPlanMode ? (
        <>
          <Map className="w-3 h-3" />
          <span>Plan Mode</span>
        </>
      ) : (
        <>
          <Code className="w-3 h-3" />
          <span>Code Mode</span>
        </>
      )}
    </Badge>
  );
};
