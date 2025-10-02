import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SessionTimeFilter } from "@/app/projects/[projectId]/sessions/[sessionId]/store/sessionTimeFilterAtom";

const timeFilterOptions: Array<{
  value: SessionTimeFilter;
  label: string;
}> = [
  { value: "1h", label: "Last Hour" },
  { value: "6h", label: "Last 6 Hours" },
  { value: "1d", label: "Last Day" },
  { value: "3d", label: "Last 3 Days" },
  { value: "1w", label: "Last Week" },
  { value: "1m", label: "Last Month" },
  { value: "all", label: "All Time" },
];

interface TimeFilterSelectProps {
  value: SessionTimeFilter;
  onValueChange: (value: SessionTimeFilter) => void;
  className?: string;
}

export function TimeFilterSelect({ value, onValueChange, className }: TimeFilterSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {timeFilterOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}