import { forwardRef, useState } from "react";
import { useConfig } from "@/app/hooks/useConfig";
import { BaseInput, type BaseInputRef } from "../BaseInput";
import { FileCompletionPlugin } from "../completions";
import { FileCompletionTrigger, useSlashCommandTrigger } from "../triggers";
import type { InputConfig } from "../types";

export interface NewSessionInputProps {
  projectId: string;
  onSubmit: (message: string) => Promise<void>;
  isPending?: boolean;
  error?: Error | null;
  planMode?: boolean;
  createWorktree?: boolean;
  buttonText?: string;
  containerClassName?: string;
  disabled?: boolean;
  buttonSize?: "sm" | "default" | "lg";
}

export const NewSessionInput = forwardRef<BaseInputRef, NewSessionInputProps>(
  (
    {
      projectId,
      onSubmit,
      isPending = false,
      error,
      planMode = true,
      createWorktree = false,
      buttonText,
      containerClassName = "",
      disabled = false,
      buttonSize = "lg",
    },
    ref,
  ) => {
    const [value, setValue] = useState("");
    const { config } = useConfig();
    const slashCommandTrigger = useSlashCommandTrigger();

    const getPlaceholder = () => {
      return planMode
        ? "Describe what you want to build... (Claude will plan before coding)"
        : "Type your message here... (Claude will start coding immediately)";
    };

    const getButtonText = () => {
      if (buttonText) return buttonText;
      
      if (isPending && createWorktree) {
        return "Creating Worktree...";
      }
      
      if (createWorktree) {
        return `Start ${planMode ? "Planning" : "Coding"} in Worktree`;
      }
      
      return `Start ${planMode ? "Planning" : "Coding"}`;
    };

    const inputConfig: InputConfig = {
      placeholder: getPlaceholder(),
      buttonText: getButtonText(),
      minHeight: "min-h-[200px]",
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

NewSessionInput.displayName = "NewSessionInput";