import type { InputConfig } from "../types";

/**
 * Predefined input configurations for common use cases
 */
export const InputPresets = {
  /**
   * Configuration for plan mode - focused on planning and discussion
   */
  PLAN_MODE: {
    placeholder: "Suggest changes to the plan...",
    buttonText: "Send",
    minHeight: "min-h-[100px]",
  } as Partial<InputConfig>,

  /**
   * Configuration for code mode - focused on development
   */
  CODE_MODE: {
    placeholder:
      "Type your message... (Start with / for commands, Ctrl+Enter to send)",
    buttonText: "Send",
    minHeight: "min-h-[100px]",
  } as Partial<InputConfig>,

  /**
   * Configuration for new session creation
   */
  NEW_SESSION: {
    placeholder: "Describe what you want to build...",
    buttonText: "Start Session",
    minHeight: "min-h-[200px]",
  } as Partial<InputConfig>,

  /**
   * Configuration for quick commands or short messages
   */
  COMPACT: {
    placeholder: "Quick message...",
    buttonText: "Send",
    minHeight: "min-h-[60px]",
    maxLength: 500,
  } as Partial<InputConfig>,

  /**
   * Configuration for detailed documentation or long-form content
   */
  LONG_FORM: {
    placeholder: "Write detailed content...",
    buttonText: "Submit",
    minHeight: "min-h-[300px]",
    maxLength: 10000,
  } as Partial<InputConfig>,
} as const;

export type InputPresetKey = keyof typeof InputPresets;
