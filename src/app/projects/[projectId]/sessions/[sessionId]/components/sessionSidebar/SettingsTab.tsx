"use client";

import type { FC } from "react";
import { EditorSettings } from "@/components/EditorSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { SettingsControls } from "@/components/SettingsControls";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfig } from "@/app/hooks/useConfig";
import { useQueryClient } from "@tanstack/react-query";
import { configQueryConfig } from "@/app/hooks/useConfig";
import { useCallback } from "react";

export const SettingsTab: FC<{
  openingProjectId: string;
}> = ({ openingProjectId }) => {
  const { config, updateConfig, isUpdating } = useConfig();
  const queryClient = useQueryClient();

  const onConfigChanged = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: configQueryConfig.queryKey,
    });
  }, [queryClient]);

  const handleSendKeyChange = (key: "enter" | "shift" | "ctrl" | "cmd") => {
    const currentKeys = config?.sendKeys || ["ctrl", "cmd"];
    const newKeys = currentKeys.includes(key)
      ? currentKeys.filter(k => k !== key)
      : [...currentKeys, key];
    
    const newConfig = {
      ...config,
      sendKeys: newKeys,
    };
    
    // Update config - optimistic update handled by mutation
    updateConfig(newConfig);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-sidebar-border p-4">
        <h2 className="font-semibold text-lg">Settings</h2>
        <p className="text-xs text-sidebar-foreground/70">
          Display and behavior preferences
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Session Display Settings */}
        <div className="space-y-4">
          <h3 className="font-medium text-sm text-sidebar-foreground">
            Session Display
          </h3>

          <SettingsControls openingProjectId={openingProjectId} />
        </div>

        {/* Editor Integration Settings */}
        <div className="space-y-4">
          <h3 className="font-medium text-sm text-sidebar-foreground">
            Editor Integration
          </h3>

          <EditorSettings />
        </div>

        {/* Input Settings */}
        <div className="space-y-4">
          <h3 className="font-medium text-sm text-sidebar-foreground">
            Input Settings
          </h3>

          <div className="space-y-4">
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Choose which key combinations send messages:
              </p>
              
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="send-key-enter"
                    checked={config?.sendKeys?.includes("enter")}
                    disabled={isUpdating}
                    onCheckedChange={() => handleSendKeyChange("enter")}
                  />
                  <label
                    htmlFor="send-key-enter"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Enter
                  </label>
                  {isUpdating && <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />}
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="send-key-shift"
                    checked={config?.sendKeys?.includes("shift")}
                    disabled={isUpdating}
                    onCheckedChange={() => handleSendKeyChange("shift")}
                  />
                  <label
                    htmlFor="send-key-shift"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Shift+Enter
                  </label>
                  {isUpdating && <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />}
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="send-key-ctrl"
                    checked={config?.sendKeys?.includes("ctrl")}
                    disabled={isUpdating}
                    onCheckedChange={() => handleSendKeyChange("ctrl")}
                  />
                  <label
                    htmlFor="send-key-ctrl"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Ctrl+Enter
                  </label>
                  {isUpdating && <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />}
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="send-key-cmd"
                    checked={config?.sendKeys?.includes("cmd")}
                    disabled={isUpdating}
                    onCheckedChange={() => handleSendKeyChange("cmd")}
                  />
                  <label
                    htmlFor="send-key-cmd"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Cmd+Enter (Mac)
                  </label>
                  {isUpdating && <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Notification Settings */}
        <div className="space-y-4">
          <h3 className="font-medium text-sm text-sidebar-foreground">
            Notifications
          </h3>

          <NotificationSettings />
        </div>
      </div>
    </div>
  );
};
