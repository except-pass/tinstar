import { ChevronRight } from "lucide-react";
import type { FC, PropsWithChildren } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

type SystemLevel = "info" | "warning" | "error" | "debug";

interface SystemConversationContentProps extends PropsWithChildren {
  level?: SystemLevel;
}

export const SystemConversationContent: FC<SystemConversationContentProps> = ({
  children,
  level = "info",
}) => {
  const getLevelIcon = (level: SystemLevel): string => {
    switch (level) {
      case "warning":
        return "⚠️";
      case "error":
        return "❌";
      case "debug":
        return "🐛";
      default:
        return "ℹ️";
    }
  };

  const getLevelStyles = (level: SystemLevel) => {
    switch (level) {
      case "warning":
        return {
          trigger: "hover:bg-orange-50 dark:hover:bg-orange-950/20",
          content:
            "bg-orange-50 border-orange-200 dark:bg-orange-950/20 dark:border-orange-800",
          title: "text-orange-700 dark:text-orange-300",
        };
      case "error":
        return {
          trigger: "hover:bg-red-50 dark:hover:bg-red-950/20",
          content:
            "bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-800",
          title: "text-red-700 dark:text-red-300",
        };
      case "debug":
        return {
          trigger: "hover:bg-purple-50 dark:hover:bg-purple-950/20",
          content:
            "bg-purple-50 border-purple-200 dark:bg-purple-950/20 dark:border-purple-800",
          title: "text-purple-700 dark:text-purple-300",
        };
      default:
        return {
          trigger: "hover:bg-muted/50",
          content: "bg-background border",
          title: "text-muted-foreground",
        };
    }
  };

  const styles = getLevelStyles(level);
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <div
          className={`flex items-center justify-between cursor-pointer ${styles.trigger} rounded p-2 -mx-2`}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm">{getLevelIcon(level)}</span>
            <h4 className={`text-xs font-medium ${styles.title}`}>
              System Message {level !== "info" && `(${level})`}
            </h4>
          </div>
          <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={`${styles.content} rounded p-3 mt-2`}>
          <pre className="text-xs overflow-x-auto">{children}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
