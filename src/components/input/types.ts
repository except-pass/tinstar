export interface CursorPosition {
  relative: { top: number; left: number };
  absolute: { top: number; left: number };
}

export interface TriggerMatch {
  type: string;
  trigger: string;
  position: number;
  query: string;
  fullMatch: string;
}

export interface TriggerPlugin {
  readonly name: string;
  readonly triggers: string[];
  
  /**
   * Detect if input matches this trigger
   */
  detect(input: string, cursorPosition: number): TriggerMatch | null;
  
  /**
   * Handle trigger activation
   */
  onTrigger(match: TriggerMatch, context: TriggerContext): void;
  
  /**
   * Handle trigger deactivation
   */
  onDeactivate?(): void;
  
  /**
   * Handle keyboard events when trigger is active
   */
  onKeyDown?(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
}

export interface TriggerContext {
  projectId: string;
  input: string;
  cursorPosition: CursorPosition;
  setValue: (value: string) => void;
  focus: () => void;
  blur: () => void;
}

export interface CompletionPlugin {
  readonly name: string;
  
  /**
   * Render completion UI
   */
  render(props: {
    projectId: string;
    input: string;
    match: TriggerMatch;
    cursorPosition: CursorPosition;
    onSelect: (value: string) => void;
    onClose: () => void;
  }): React.ReactNode;
  
  /**
   * Handle keyboard events for completion
   */
  onKeyDown?(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
}

export interface InputConfig {
  placeholder: string;
  buttonText: string;
  minHeight?: string;
  maxLength?: number;
  sendKeys?: ("enter" | "shift" | "ctrl" | "cmd")[];
  triggers?: TriggerPlugin[];
  completions?: CompletionPlugin[];
  disabled?: boolean;
}

export interface BaseInputProps {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  config: InputConfig;
  isPending?: boolean;
  error?: Error | null;
  containerClassName?: string;
  buttonSize?: "sm" | "default" | "lg";
}

export interface BaseInputRef {
  focus: () => void;
  blur: () => void;
  getElement: () => HTMLTextAreaElement | null;
}