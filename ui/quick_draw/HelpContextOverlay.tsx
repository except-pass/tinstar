import React, { useEffect, useState, useCallback } from 'react';
import { quickDrawRegistry } from './QuickDrawRegistry';
import './HelpContextOverlay.css';

interface HelpHint {
  key: string
  description: string
  targetElement: HTMLElement
  position: { x: number, y: number }
}

interface HelpContextOverlayProps {
  namespace: string
  onClose: () => void
}

export const HelpContextOverlay: React.FC<HelpContextOverlayProps> = ({
  namespace,
  onClose
}) => {
  const [helpHints, setHelpHints] = useState<HelpHint[]>([]);

  // Generate help hints for the current namespace
  const generateHelpHints = useCallback((namespace: string): HelpHint[] => {
    const actions = quickDrawRegistry.getActions(namespace);
    const hints: HelpHint[] = [];

    actions.forEach(action => {
      if (!action.targetSelector) return;

      const element = document.querySelector(action.targetSelector) as HTMLElement;
      if (!element) return;

      const rect = element.getBoundingClientRect();
      hints.push({
        key: action.key,
        description: action.description,
        targetElement: element,
        position: { 
          x: rect.right + 8, 
          y: rect.top + (rect.height / 2) - 12
        }
      });
    });

    return hints;
  }, []);

  // Update help hints when namespace changes or on window resize
  const updateHelpHints = useCallback(() => {
    const hints = generateHelpHints(namespace);
    setHelpHints(hints);
  }, [namespace, generateHelpHints]);

  // Initial generation and resize handling
  useEffect(() => {
    updateHelpHints();

    const handleResize = () => {
      updateHelpHints();
    };

    // Debounce resize events
    let resizeTimeout: number;
    const debouncedHandleResize = () => {
      window.clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(handleResize, 100);
    };

    window.addEventListener('resize', debouncedHandleResize);
    return () => {
      window.removeEventListener('resize', debouncedHandleResize);
      window.clearTimeout(resizeTimeout);
    };
  }, [updateHelpHints]);

  // Handle click outside to close
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      // Allow clicks on help hints themselves
      const target = event.target as HTMLElement;
      if (target.closest('.help-hint')) {
        return;
      }
      onClose();
    };

    // Add a small delay to prevent immediate closing
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClick);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClick);
    };
  }, [onClose]);

  return (
    <div className="help-context-overlay">
      {/* Translucent background */}
      <div className="overlay-background" />
      
      {/* Help hints positioned over actionable elements */}
      {helpHints.map((hint, index) => (
        <div
          key={`${hint.key}-${index}`}
          className="help-hint"
          style={{
            left: `${hint.position.x}px`,
            top: `${hint.position.y}px`
          }}
        >
          <div className="help-hint-key">
            [{hint.key}]
          </div>
          <div className="help-hint-description">
            {hint.description}
          </div>
        </div>
      ))}
      
      {/* Instructions */}
      <div className="overlay-instructions">
        <div className="instructions-content">
          <span className="namespace-name">
            {quickDrawRegistry.getNamespace(namespace)?.name} namespace active
          </span>
          <span className="instruction-text">
            Press a key to perform an action, or ESC to cancel
          </span>
        </div>
      </div>
    </div>
  );
};