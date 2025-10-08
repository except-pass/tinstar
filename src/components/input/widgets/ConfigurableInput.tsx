import { forwardRef, useState } from "react";
import { BaseInput, type BaseInputRef } from "../BaseInput";
import { type InputPresetKey, InputPresets, useInputConfig } from "../config";
import type { InputConfig } from "../types";

export interface ConfigurableInputProps {
  projectId: string;
  onSubmit: (message: string) => Promise<void>;
  preset?: InputPresetKey;
  configOverrides?: Partial<InputConfig>;
  isPending?: boolean;
  error?: Error | null;
  containerClassName?: string;
  buttonSize?: "sm" | "default" | "lg";
  clearOnSubmit?: boolean;
}

/**
 * A configurable input that uses presets and the global configuration system.
 * This is the recommended way to create input widgets for most use cases.
 */
export const ConfigurableInput = forwardRef<
  BaseInputRef,
  ConfigurableInputProps
>(
  (
    {
      projectId,
      onSubmit,
      preset,
      configOverrides = {},
      isPending = false,
      error,
      containerClassName = "",
      buttonSize = "lg",
      clearOnSubmit = true,
    },
    ref,
  ) => {
    const [value, setValue] = useState("");
    const { createConfig } = useInputConfig();

    // Build final configuration from preset and overrides
    const presetConfig = preset ? InputPresets[preset] : {};
    const finalConfig = createConfig({
      ...presetConfig,
      ...configOverrides,
    });

    const handleSubmit = async (message: string) => {
      await onSubmit(message);
      if (clearOnSubmit) {
        setValue("");
      }
    };

    return (
      <BaseInput
        ref={ref}
        projectId={projectId}
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        config={finalConfig}
        isPending={isPending}
        error={error}
        containerClassName={containerClassName}
        buttonSize={buttonSize}
      />
    );
  },
);

ConfigurableInput.displayName = "ConfigurableInput";
