import { cn } from "@/lib/utils";
import { Badge } from "./badge";

interface WorktreeBadgeProps {
  className?: string;
  isDirty?: boolean;
  isOrphaned?: boolean;
}

export function WorktreeBadge({
  className,
  isDirty,
  isOrphaned,
}: WorktreeBadgeProps) {
  if (isOrphaned) {
    return (
      <Badge
        variant="secondary"
        className={cn(
          className,
          "bg-gray-50/60 border-gray-400/60 text-gray-700 cursor-default select-none",
        )}
        title="Worktree directory has been removed. Git operations and new messages are disabled for this session."
      >
        ⛓️‍💥 Tree Removed
      </Badge>
    );
  }

  const title = isDirty
    ? "Worktree has uncommitted changes"
    : "Worktree is clean";

  return (
    <Badge
      variant="secondary"
      className={cn(
        className,
        "cursor-default select-none",
        isDirty && "bg-red-50/60 border-red-300/60 text-red-700",
      )}
      title={title}
    >
      🌱 Worktree
    </Badge>
  );
}
