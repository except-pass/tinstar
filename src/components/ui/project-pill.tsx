import { cn } from "@/lib/utils";

const colors = [
  "bg-red-100 text-red-800",
  "bg-blue-100 text-blue-800",
  "bg-green-100 text-green-800",
  "bg-yellow-100 text-yellow-800",
  "bg-purple-100 text-purple-800",
  "bg-pink-100 text-pink-800",
  "bg-indigo-100 text-indigo-800",
  "bg-orange-100 text-orange-800",
  "bg-teal-100 text-teal-800",
  "bg-cyan-100 text-cyan-800",
];

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

function getProjectColor(projectId: string): string {
  const hash = hashCode(projectId);
  const index = hash % colors.length;
  const color = colors[index];
  const defaultColor = colors[0] ?? "bg-slate-100 text-slate-800";
  return color ?? defaultColor;
}

interface ProjectPillProps {
  projectId: string;
  projectName?: string;
  className?: string;
  size?: "xs" | "sm" | "md";
}

export function ProjectPill({
  projectId,
  projectName,
  className,
  size = "sm",
}: ProjectPillProps) {
  const colorClass = getProjectColor(projectId);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-medium",
        size === "xs"
          ? "px-1.5 py-0.5 text-xs"
          : size === "sm"
            ? "px-2 py-1 text-xs"
            : "px-3 py-1 text-sm",
        colorClass,
        className,
      )}
    >
      {projectName ?? projectId}
    </span>
  );
}
