import type { FC } from "react";
import { cn } from "@/lib/utils";

type StatusDotProps = {
  status: "success" | "error";
  className?: string;
};

export const StatusDot: FC<StatusDotProps> = ({ status, className }) => {
  return (
    <div
      className={cn(
        "w-2 h-2 rounded-full flex-shrink-0",
        status === "success" && "bg-green-500",
        status === "error" && "bg-red-500",
        className,
      )}
    />
  );
};
