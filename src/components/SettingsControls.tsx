"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type FC, useCallback, useId } from "react";
import type { ModelType } from "@/server/service/claude-code/types";
import type { Config } from "@/server/config/config";
import { configQueryConfig, useConfig } from "@/app/hooks/useConfig";
import { Checkbox } from "@/components/ui/checkbox";
import { ModelSelector } from "@/components/ui/model-selector";
import { projectQueryConfig } from "../app/projects/[projectId]/hooks/useProject";

interface SettingsControlsProps {
  openingProjectId: string;
  showLabels?: boolean;
  showDescriptions?: boolean;
  className?: string;
}

export const SettingsControls: FC<SettingsControlsProps> = ({
  openingProjectId,
  showLabels = true,
  showDescriptions = true,
  className = "",
}: SettingsControlsProps) => {
  const checkboxId = useId();
  const { config, updateConfig } = useConfig();
  const queryClient = useQueryClient();

  const onConfigChanged = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: configQueryConfig.queryKey,
    });
    await queryClient.invalidateQueries({
      queryKey: ["projects"],
    });
    void queryClient.invalidateQueries({
      queryKey: projectQueryConfig(openingProjectId).queryKey,
    });
  }, [queryClient, openingProjectId]);

  const handleHideNoUserMessageChange = () => {
    const newConfig = {
      ...config,
      hideNoUserMessageSession: !config?.hideNoUserMessageSession,
    };
    
    // Update config - optimistic update handled by mutation
    updateConfig(newConfig);
    // Only invalidate project queries since these settings affect project display
    onConfigChanged();
  };

  const handleUnifySameTitleChange = () => {
    const newConfig = {
      ...config,
      unifySameTitleSession: !config?.unifySameTitleSession,
    };
    
    // Update config - optimistic update handled by mutation
    updateConfig(newConfig);
    // Only invalidate project queries since these settings affect project display
    onConfigChanged();
  };

  const handleDefaultPlanModeChange = async () => {
    const newConfig = {
      ...config,
      defaultPlanMode: !config?.defaultPlanMode,
    };
    updateConfig(newConfig);
    await onConfigChanged();
  };

  const handleDefaultModelChange = (model: string | undefined) => {
    const resolvedModel: ModelType = (model ?? "default") as ModelType;
    const newConfig: Config = {
      ...(config as Config),
      defaultModel: resolvedModel,
    };
    updateConfig(newConfig);
    // Don't await - let it save in background for faster UI response
    onConfigChanged().catch(console.error);
  };
  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex items-center space-x-2">
        <Checkbox
          id={checkboxId}
          checked={config?.hideNoUserMessageSession}
          onCheckedChange={handleHideNoUserMessageChange}
        />
        {showLabels && (
          <label
            htmlFor={checkboxId}
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Hide sessions without user messages
          </label>
        )}
      </div>
      {showDescriptions && (
        <p className="text-xs text-muted-foreground mt-1 ml-6">
          Only show sessions that contain user commands or messages
        </p>
      )}

      <div className="flex items-center space-x-2">
        <Checkbox
          id={`${checkboxId}-unify`}
          checked={config?.unifySameTitleSession}
          onCheckedChange={handleUnifySameTitleChange}
        />
        {showLabels && (
          <label
            htmlFor={`${checkboxId}-unify`}
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Unify sessions with same title
          </label>
        )}
      </div>
      {showDescriptions && (
        <p className="text-xs text-muted-foreground mt-1 ml-6">
          Show only the latest session when multiple sessions have the same
          title
        </p>
      )}

      <div className="flex items-center space-x-2">
        <Checkbox
          id={`${checkboxId}-planmode`}
          checked={config?.defaultPlanMode}
          onCheckedChange={handleDefaultPlanModeChange}
        />
        {showLabels && (
          <label
            htmlFor={`${checkboxId}-planmode`}
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Default to plan mode for new sessions
          </label>
        )}
      </div>
      {showDescriptions && (
        <p className="text-xs text-muted-foreground mt-1 ml-6">
          Start new conversations in plan mode where Claude plans changes before
          executing
        </p>
      )}

      <div className="space-y-2">
        {showLabels && (
          <label className="text-sm font-medium">Current Model Option</label>
        )}
        <ModelSelector
          model={config?.defaultModel}
          onModelChange={handleDefaultModelChange}
          size="sm"
        />
      </div>
    </div>
  );
};
