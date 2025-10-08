import { forwardRef, useState } from "react";
import { useConfig } from "@/app/hooks/useConfig";
import { BaseInput, type BaseInputRef } from "../BaseInput";
import { FileCompletionPlugin } from "../completions";
import { FileCompletionTrigger, useSlashCommandTrigger } from "../triggers";
import type { InputConfig } from "../types";

export interface CodeInputProps {
  projectId: string;
  onSubmit: (message: string) => Promise<void>;
  isPending?: boolean;
  error?: Error | null;
  placeholder?: string;
  buttonText?: string;
  minHeight?: string;
  containerClassName?: string;
  disabled?: boolean;
  buttonSize?: "sm" | "default" | "lg";
}

export const CodeInput = forwardRef<BaseInputRef, CodeInputProps>(
  (
    {
      projectId,
      onSubmit,
      isPending = false,
      error,
      placeholder = "Type your message... (Start with / for commands, Ctrl+Enter to send)",
      buttonText = "Send",
      minHeight = "min-h-[100px]",
      containerClassName = "",
      disabled = false,
      buttonSize = "lg",
    },
    ref,
  ) => {
    const [value, setValue] = useState("");
    const { config } = useConfig();
    const slashCommandTrigger = useSlashCommandTrigger();

    const inputConfig: InputConfig = {
      placeholder,
      buttonText,
      minHeight,
      sendKeys: config?.sendKeys || ["ctrl", "cmd"],
      triggers: [slashCommandTrigger, new FileCompletionTrigger()],
      completions: [new FileCompletionPlugin()],
      disabled,
    };

    const handleSubmit = async (message: string) => {
      await onSubmit(message);
      setValue(""); // Clear input after successful submission
    };

    return (
      <BaseInput
        ref={ref}
        projectId={projectId}
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        config={inputConfig}
        isPending={isPending}
        error={error}
        containerClassName={containerClassName}
        buttonSize={buttonSize}
      />
    );
  },
);

CodeInput.displayName = "CodeInput";
