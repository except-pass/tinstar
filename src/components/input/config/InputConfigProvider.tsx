import React, {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import { useConfig } from "@/app/hooks/useConfig";
import { FileCompletionPlugin } from "../completions";
import { FileCompletionTrigger, useSlashCommandTrigger } from "../triggers";
import type { CompletionPlugin, InputConfig, TriggerPlugin } from "../types";

export interface GlobalInputConfig {
  defaultSendKeys: ("enter" | "shift" | "ctrl" | "cmd")[];
  defaultMaxLength: number;
  defaultTriggers: TriggerPlugin[];
  defaultCompletions: CompletionPlugin[];
}

export interface InputConfigContextValue {
  globalConfig: GlobalInputConfig;
  createConfig: (overrides?: Partial<InputConfig>) => InputConfig;
}

const InputConfigContext = createContext<InputConfigContextValue | null>(null);

export const useInputConfig = (): InputConfigContextValue => {
  const context = useContext(InputConfigContext);
  if (!context) {
    throw new Error("useInputConfig must be used within InputConfigProvider");
  }
  return context;
};

export const InputConfigProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const { config } = useConfig();
  const slashCommandTrigger = useSlashCommandTrigger();

  const globalConfig: GlobalInputConfig = useMemo(
    () => ({
      defaultSendKeys: config?.sendKeys || ["ctrl", "cmd"],
      defaultMaxLength: 4000,
      defaultTriggers: [slashCommandTrigger, new FileCompletionTrigger()],
      defaultCompletions: [new FileCompletionPlugin()],
    }),
    [config?.sendKeys, slashCommandTrigger],
  );

  const createConfig = useMemo(
    () =>
      (overrides: Partial<InputConfig> = {}): InputConfig => ({
        placeholder: overrides.placeholder || "Type your message...",
        buttonText: overrides.buttonText || "Send",
        minHeight: overrides.minHeight || "min-h-[100px]",
        maxLength: overrides.maxLength || globalConfig.defaultMaxLength,
        sendKeys: overrides.sendKeys || globalConfig.defaultSendKeys,
        triggers: overrides.triggers || globalConfig.defaultTriggers,
        completions: overrides.completions || globalConfig.defaultCompletions,
        disabled: overrides.disabled || false,
      }),
    [globalConfig],
  );

  const value: InputConfigContextValue = useMemo(
    () => ({
      globalConfig,
      createConfig,
    }),
    [globalConfig, createConfig],
  );

  return (
    <InputConfigContext.Provider value={value}>
      {children}
    </InputConfigContext.Provider>
  );
};
