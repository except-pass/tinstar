import { AlertCircleIcon, LoaderIcon, SendIcon } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  BaseInputProps,
  BaseInputRef,
  CursorPosition,
  TriggerContext,
  TriggerMatch,
  TriggerPlugin,
} from "./types";

export const BaseInput = forwardRef<BaseInputRef, BaseInputProps>(
  (
    {
      projectId,
      value,
      onChange,
      onSubmit,
      config,
      isPending = false,
      error,
      containerClassName = "",
      buttonSize = "lg",
    },
    ref,
  ) => {
    const [cursorPosition, setCursorPosition] = useState<CursorPosition>({
      relative: { top: 0, left: 0 },
      absolute: { top: 0, left: 0 },
    });
    const [activeTrigger, setActiveTrigger] = useState<{
      plugin: TriggerPlugin;
      match: TriggerMatch;
    } | null>(null);

    const containerRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const helpId = useId();

    // Expose methods through ref
    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          textareaRef.current?.focus();
        },
        blur: () => {
          textareaRef.current?.blur();
        },
        getElement: () => textareaRef.current,
      }),
      [],
    );

    const getCursorPosition = useCallback((): CursorPosition | undefined => {
      const textarea = textareaRef.current;
      const container = containerRef.current;
      if (!textarea || !container) return undefined;

      const cursorPos = textarea.selectionStart;
      const textBeforeCursor = textarea.value.substring(0, cursorPos);
      const textAfterCursor = textarea.value.substring(cursorPos);

      const pre = document.createTextNode(textBeforeCursor);
      const post = document.createTextNode(textAfterCursor);
      const caret = document.createElement("span");
      caret.innerHTML = "&nbsp;";

      const mirrored = document.createElement("div");
      mirrored.innerHTML = "";
      mirrored.append(pre, caret, post);

      const textareaStyles = window.getComputedStyle(textarea);
      for (const property of [
        "border",
        "boxSizing",
        "fontFamily",
        "fontSize",
        "fontWeight",
        "letterSpacing",
        "lineHeight",
        "padding",
        "textDecoration",
        "textIndent",
        "textTransform",
        "whiteSpace",
        "wordSpacing",
        "wordWrap",
      ] as const) {
        mirrored.style[property] = textareaStyles[property];
      }

      mirrored.style.visibility = "hidden";
      container.prepend(mirrored);

      const caretRect = caret.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      container.removeChild(mirrored);

      return {
        relative: {
          top: caretRect.top - containerRect.top - textarea.scrollTop,
          left: caretRect.left - containerRect.left - textarea.scrollLeft,
        },
        absolute: {
          top: caretRect.top - textarea.scrollTop,
          left: caretRect.left - textarea.scrollLeft,
        },
      };
    }, []);

    const detectTriggers = useCallback(
      (input: string, cursorPos: number) => {
        if (!config.triggers) return null;

        for (const plugin of config.triggers) {
          const match = plugin.detect(input, cursorPos);
          if (match) {
            return { plugin, match };
          }
        }
        return null;
      },
      [config.triggers],
    );

    const handleSubmit = async () => {
      if (!value.trim()) return;
      await onSubmit(value.trim());
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Let active trigger handle key events first
      if (activeTrigger?.plugin.onKeyDown?.(e)) {
        return;
      }

      // Handle send keys
      const shouldSend =
        e.key === "Enter" &&
        ((config.sendKeys?.includes("enter") &&
          !e.shiftKey &&
          !e.ctrlKey &&
          !e.metaKey) ||
          (config.sendKeys?.includes("shift") && e.shiftKey) ||
          (config.sendKeys?.includes("ctrl") && e.ctrlKey) ||
          (config.sendKeys?.includes("cmd") && e.metaKey));

      if (shouldSend) {
        e.preventDefault();
        handleSubmit();
      }
    };

    const handleChange = (newValue: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorPos = textarea.selectionStart;

      // Detect triggers
      const detected = detectTriggers(newValue, cursorPos);

      if (detected) {
        // New trigger detected
        if (
          !activeTrigger ||
          activeTrigger.match.type !== detected.match.type
        ) {
          // Deactivate previous trigger
          activeTrigger?.plugin.onDeactivate?.();

          // Activate new trigger
          const position = getCursorPosition();
          if (position) {
            setCursorPosition(position);
            const context: TriggerContext = {
              projectId,
              input: newValue,
              cursorPosition: position,
              setValue: onChange,
              focus: () => textareaRef.current?.focus(),
              blur: () => textareaRef.current?.blur(),
            };

            detected.plugin.onTrigger(detected.match, context);
            setActiveTrigger(detected);
          }
        }
      } else if (activeTrigger) {
        // No trigger detected, deactivate current one
        activeTrigger.plugin.onDeactivate?.();
        setActiveTrigger(null);
      }

      // Update cursor position for completions
      const position = getCursorPosition();
      if (position) {
        setCursorPosition(position);
      }

      onChange(newValue);
    };

    return (
      <div className={containerClassName}>
        {error && (
          <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md mb-4">
            <AlertCircleIcon className="w-4 h-4" />
            <span>Failed to send message. Please try again.</span>
          </div>
        )}

        <div className="space-y-3">
          <div className="relative" ref={containerRef}>
            <Textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={config.placeholder}
              className={`${config.minHeight || "min-h-[100px]"} resize-none`}
              disabled={isPending || config.disabled}
              maxLength={config.maxLength || 4000}
              aria-label="Message input"
              aria-describedby={helpId}
            />

            {/* Render active completions */}
            {activeTrigger &&
              config.completions?.map((completion) => (
                <div key={completion.name} className="absolute inset-0">
                  {completion.render({
                    projectId,
                    input: value,
                    match: activeTrigger.match,
                    cursorPosition,
                    onSelect: (selectedValue) => {
                      onChange(selectedValue);
                      setActiveTrigger(null);
                    },
                    onClose: () => {
                      activeTrigger.plugin.onDeactivate?.();
                      setActiveTrigger(null);
                    },
                  })}
                </div>
              ))}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground" id={helpId}>
              {value.length}/{config.maxLength || 4000} characters • {(() => {
                const combinations = [];
                if (config.sendKeys?.includes("enter"))
                  combinations.push("Enter");
                if (config.sendKeys?.includes("shift"))
                  combinations.push("Shift+Enter");
                if (config.sendKeys?.includes("ctrl"))
                  combinations.push("Ctrl+Enter");
                if (
                  config.sendKeys?.includes("cmd") &&
                  navigator.platform.includes("Mac")
                )
                  combinations.push("Cmd+Enter");
                return combinations.length > 0
                  ? `${combinations.join("/")} to send`
                  : "No send keys configured";
              })()}
            </span>

            <Button
              onClick={handleSubmit}
              disabled={!value.trim() || isPending || config.disabled}
              size={buttonSize}
              className="gap-2"
            >
              {isPending ? (
                <>
                  <LoaderIcon className="w-4 h-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <SendIcon className="w-4 h-4" />
                  {config.buttonText}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    );
  },
);

BaseInput.displayName = "BaseInput";

export type { BaseInputRef };
