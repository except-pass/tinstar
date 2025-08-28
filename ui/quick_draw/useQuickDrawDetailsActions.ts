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
}

export const useQuickDrawDetailsActions = ({
  todos,
  onTodoSelect,
  onSave,
  onFocusPrompt
}: DetailsActionsProps) => {
  
  // Register details namespace and actions
  useEffect(() => {
    // Register the details namespace
    quickDrawRegistry.registerNamespace('d', 'Details', 'Interact with details pane, todos, and prompt');
    
    // Register todo selection actions (1,2,3,4) - only for first 4 todos
    const todoKeys = ['1', '2', '3', '4'];
    
    todos.forEach((todo, index) => {
      if (index < todoKeys.length) {
        const key = todoKeys[index];
        const todoDescription = todo.content.length > 30 
          ? `${todo.content.substring(0, 30)}...` 
          : todo.content;
        
        quickDrawRegistry.registerAction('d', key, {
          namespace: 'd',
          key,
          action: () => {
            if (onTodoSelect) {
              onTodoSelect(index);
            }
          },
          description: `Select todo: ${todoDescription}`,
          targetSelector: `[data-testid="todo-item-${index}"]`
        });
      }
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
    
    // Register focus prompt action
    if (onFocusPrompt) {
      quickDrawRegistry.registerAction('d', 'p', {
        namespace: 'd',
        key: 'p',
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
  }, [todos, onTodoSelect, onSave, onFocusPrompt]);
};