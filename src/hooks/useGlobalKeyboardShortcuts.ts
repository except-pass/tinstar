import { useCallback, useEffect } from "react";

export interface KeyboardShortcutHandlers {
  onNavigateUp?: () => void;
  onNavigateDown?: () => void;
  onCreateNew?: () => void;
  onOpenEditor?: () => void;
  onFocusInput?: () => void;
  onBlurInput?: () => void;
}

export const useGlobalKeyboardShortcuts = (handlers: KeyboardShortcutHandlers) => {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Check if user is typing in inputs/textareas
    const target = e.target as HTMLElement;
    const isTyping = target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.contentEditable === 'true' ||
                    target.isContentEditable;

    // Handle ESC key specially - it should work when typing to blur the input
    if (e.key === 'Escape' && isTyping) {
      e.preventDefault();
      handlers.onBlurInput?.();
      return;
    }

    // Don't trigger other shortcuts when user is typing
    if (isTyping) {
      return;
    }

    // Don't trigger if any modifier keys are pressed (except for specific cases)
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'j':
        e.preventDefault();
        handlers.onNavigateDown?.();
        break;
      case 'k':
        e.preventDefault();
        handlers.onNavigateUp?.();
        break;
      case 'arrowdown':
        e.preventDefault();
        handlers.onNavigateDown?.();
        break;
      case 'arrowup':
        e.preventDefault();
        handlers.onNavigateUp?.();
        break;
      case 'c':
        e.preventDefault();
        handlers.onCreateNew?.();
        break;
      case 'o':
        e.preventDefault();
        handlers.onOpenEditor?.();
        break;
      case 'f':
        e.preventDefault();
        handlers.onFocusInput?.();
        break;
    }
  }, [handlers]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
};