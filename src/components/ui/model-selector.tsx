<<<<<<< HEAD
import { Brain, Sparkles } from "lucide-react";
=======
import { Brain, Sparkles, Zap } from "lucide-react";
>>>>>>> 997b9b1342a932b1d2e9cae68dd27a83466fc2fe
import type { FC } from "react";
import { cn } from "@/lib/utils";
import type { ModelType } from "@/server/service/claude-code/types";
import { Badge } from "./badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
<<<<<<< HEAD
=======
  SelectValue,
>>>>>>> 997b9b1342a932b1d2e9cae68dd27a83466fc2fe
} from "./select";

export interface ModelSelectorProps {
  model?: string;
  onModelChange?: (model: string | undefined) => void;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md" | "lg";
}

const models: Array<{
  value: ModelType;
  label: string;
  icon: React.ElementType;
  description: string;
}> = [
  {
    value: "default",
    label: "Default",
    icon: Brain,
    description: "Recommended model based on account type",
  },
  {
    value: "sonnet",
    label: "Sonnet",
    icon: Brain,
    description: "Latest Sonnet model for daily coding tasks",
  },
  {
    value: "opus",
    label: "Opus",
    icon: Sparkles,
    description: "Most capable model for complex reasoning",
  },
  {
    value: "opusplan",
    label: "Opus Plan",
    icon: Sparkles,
    description: "Opus for planning, Sonnet for execution",
  },
];

export const ModelSelector: FC<ModelSelectorProps> = ({
  model,
  onModelChange,
  disabled = false,
  className,
  size = "md",
}) => {
  const sizeClasses = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-base",
  };

  return (
    <div className={cn("space-y-2", className)}>
      <label className={cn("font-medium text-foreground", sizeClasses[size])}>
        Model
      </label>
      <Select
        value={model || "default"}
        onValueChange={(value) => onModelChange?.(value)}
        disabled={disabled}
      >
        <SelectTrigger className={cn("w-full", sizeClasses[size])}>
          <div className="flex items-center gap-2 w-full">
            {(() => {
              const selectedModel = models.find(m => m.value === (model || "default"));
              if (selectedModel) {
                const Icon = selectedModel.icon;
                return (
                  <>
                    <Icon className="h-4 w-4" />
                    <span>{selectedModel.label}</span>
                  </>
                );
              }
              return <span>Select model</span>;
            })()}
          </div>
        </SelectTrigger>
        <SelectContent>
          {models.map((modelOption) => {
            const Icon = modelOption.icon;
            return (
              <SelectItem key={modelOption.value} value={modelOption.value}>
                <div className="flex items-center gap-2 w-full">
                  <Icon className="h-4 w-4" />
                  <div className="flex flex-col flex-1">
                    <span className="font-medium">{modelOption.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {modelOption.description}
                    </span>
                  </div>
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
};

export interface ModelBadgeProps {
  model?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export const ModelBadge: FC<ModelBadgeProps> = ({
  model,
  className,
}) => {
  const modelInfo = models.find((m) => m.value === model);

  if (!modelInfo) {
    return (
      <Badge variant="outline" className={cn("gap-1", className)}>
        <Brain className="h-3 w-3" />
        Default
      </Badge>
    );
  }

  const Icon = modelInfo.icon;
  const modelName = modelInfo.label;

  return (
    <Badge variant="secondary" className={cn("gap-1 select-none", className)}>
      <Icon className="h-3 w-3" />
      {modelName}
    </Badge>
  );
};
