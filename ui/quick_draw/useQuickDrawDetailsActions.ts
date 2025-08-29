import { useEffect } from 'react';
import { quickDrawRegistry } from './QuickDrawRegistry';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

interface DetailsActionsProps {
  todos: TodoItem[];
  onTodoSelect?: (index: number) => void;
  onSave?: () => void;
  onFocusPrompt?: () => void;
  onPause?: () => void;
  onNotification?: (number: string) => void;
  onScrollToBottom?: () => void;
  onScrollToTop?: () => void;
  sessionId: string;
}

export const useQuickDrawDetailsActions = ({
  todos,
  onTodoSelect,
  onSave,
  onFocusPrompt,
  onPause,
  onNotification,
  onScrollToBottom,
  onScrollToTop,
  sessionId
}: DetailsActionsProps) => {
  
  // Register details namespace and actions
  useEffect(() => {
    // Register the details namespace
    quickDrawRegistry.registerNamespace('d', 'Details', 'Interact with details pane, notifications, and controls');
    
    // Register notification actions (1,2,3,4) - activate notifications
    ['1', '2', '3', '4'].forEach(num => {
      quickDrawRegistry.registerAction('d', num, {
        namespace: 'd',
        key: num,
        action: async () => {
          if (onNotification) {
            onNotification(num);
          } else {
            // Fallback to direct API call if callback not provided
            try {
              await fetch(`/api/sessions/${sessionId}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: num })
              });
            } catch (err) {
              console.error(`Failed to send notification ${num}:`, err);
            }
          }
        },
        description: `Activate notification ${num}`,
        targetSelector: `.notification-button:nth-child(${num})`
      });
    });
    
    // Register pause action
    quickDrawRegistry.registerAction('d', 'p', {
      namespace: 'd',
      key: 'p',
      action: async () => {
        if (onPause) {
          onPause();
        } else {
          // Fallback to direct API call if callback not provided
          try {
            await fetch(`/api/sessions/${sessionId}/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: '\x1b' }) // Escape key
            });
          } catch (err) {
            console.error('Failed to pause session:', err);
          }
        }
      },
      description: 'Pause session',
      targetSelector: '.pause-button'
    });
    
    // Register scroll to bottom action
    quickDrawRegistry.registerAction('d', 'd', {
      namespace: 'd',
      key: 'd',
      action: () => {
        if (onScrollToBottom) {
          onScrollToBottom();
        } else {
          // Fallback to direct terminal scrolling
          const terminalEl = document.querySelector('.terminal-output') as HTMLElement;
          if (terminalEl) {
            terminalEl.scrollTop = terminalEl.scrollHeight;
          }
        }
      },
      description: 'Scroll terminal to bottom',
      targetSelector: '.terminal-output'
    });
    
    // Register scroll to top action  
    quickDrawRegistry.registerAction('d', 'u', {
      namespace: 'd',
      key: 'u',
      action: () => {
        if (onScrollToTop) {
          onScrollToTop();
        } else {
          // Fallback to direct terminal scrolling
          const terminalEl = document.querySelector('.terminal-output') as HTMLElement;
          if (terminalEl) {
            terminalEl.scrollTop = 0;
          }
        }
      },
      description: 'Scroll terminal to top',
      targetSelector: '.terminal-output'
    });
    
    // Register save action
    if (onSave) {
      quickDrawRegistry.registerAction('d', 's', {
        namespace: 'd',
        key: 's',
        action: onSave,
        description: 'Save changes',
        targetSelector: '[data-testid="save-button"]'
      });
    }
    
    // Register focus prompt action (moved to 'f' key)
    if (onFocusPrompt) {
      quickDrawRegistry.registerAction('d', 'f', {
        namespace: 'd',
        key: 'f',
        action: onFocusPrompt,
        description: 'Focus prompt input',
        targetSelector: '.command-input textarea'
      });
    }
    
    // Cleanup function to remove actions when todos change
    return () => {
      // Clear all 'd' namespace actions
      const namespace = quickDrawRegistry['actions']?.['d'];
      if (namespace) {
        Object.keys(namespace).forEach(key => {
          delete namespace[key];
        });
      }
    };
  }, [todos, onTodoSelect, onSave, onFocusPrompt, onPause, onNotification, onScrollToBottom, onScrollToTop, sessionId]);
};