import React, { useState, useEffect, useCallback } from 'react';
import { quickDrawRegistry } from './QuickDrawRegistry';
import { HelpContextOverlay } from './HelpContextOverlay';
import './QuickDraw.css';

interface QuickDrawState {
  isActive: boolean
  activeNamespace: string | null
  showHelpContext: boolean
  helpTimeout: number | null
}

export const QuickDraw: React.FC = () => {
  const [state, setState] = useState<QuickDrawState>({
    isActive: false,
    activeNamespace: null,
    showHelpContext: false,
    helpTimeout: null
  });
  
  const [showTooltip, setShowTooltip] = useState(false);

  // Clear timeout helper
  const clearHelpTimeout = useCallback(() => {
    if (state.helpTimeout) {
      window.clearTimeout(state.helpTimeout);
    }
  }, [state.helpTimeout]);

  // Reset to inactive state
  const resetState = useCallback(() => {
    clearHelpTimeout();
    setState({
      isActive: false,
      activeNamespace: null,
      showHelpContext: false,
      helpTimeout: null
    });
  }, [clearHelpTimeout]);

  // Start help context timeout
  const startHelpTimeout = useCallback((_namespace: string) => {
    clearHelpTimeout();
    const timeout = window.setTimeout(() => {
      setState(prev => ({
        ...prev,
        showHelpContext: true,
        helpTimeout: null
      }));
    }, 2000);
    
    setState(prev => ({
      ...prev,
      helpTimeout: timeout
    }));
  }, [clearHelpTimeout]);

  // Handle namespace key press
  const handleNamespaceKey = useCallback((key: string) => {
    if (!quickDrawRegistry.hasNamespace(key)) {
      return false; // Not handled
    }

    setState(prev => ({
      ...prev,
      isActive: true,
      activeNamespace: key,
      showHelpContext: false
    }));
    
    startHelpTimeout(key);
    return true; // Handled
  }, [startHelpTimeout]);

  // Handle action key press
  const handleActionKey = useCallback((key: string) => {
    if (!state.activeNamespace) {
      return false;
    }

    const action = quickDrawRegistry.getAction(state.activeNamespace, key);
    if (!action) {
      return false;
    }

    try {
      action.action();
    } catch (error) {
      console.error('QuickDraw action failed:', error);
    }

    resetState();
    return true;
  }, [state.activeNamespace, resetState]);

  // Global keyboard event handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't interfere with form inputs or other focused elements
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Handle escape key
      if (event.key === 'Escape') {
        if (state.isActive) {
          event.preventDefault();
          resetState();
          return;
        }
      }

      // Handle namespace selection (when not active)
      if (!state.isActive) {
        const key = event.key.toLowerCase();
        if (handleNamespaceKey(key)) {
          event.preventDefault();
          return;
        }
      }

      // Handle action selection (when active namespace)
      if (state.isActive && state.activeNamespace) {
        const key = event.key.toLowerCase();
        if (handleActionKey(key)) {
          event.preventDefault();
          return;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearHelpTimeout();
    };
  }, [state.isActive, state.activeNamespace, handleNamespaceKey, handleActionKey, resetState, clearHelpTimeout]);

  // Get current namespace info
  const currentNamespace = state.activeNamespace ? quickDrawRegistry.getNamespace(state.activeNamespace) : null;

  return (
    <>
      <div className="quick-draw-container">
        {!state.isActive ? (
          // Icon with tooltip
          <div 
            className="quick-draw-icon"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
            title="Quick Draw - Keyboard shortcuts for rapid UI navigation"
          >
            ⚡🤠 Quick Draw
            {showTooltip && (
              <div className="quick-draw-tooltip">
                <div className="tooltip-header">
                  Quick Draw - Keyboard shortcuts for rapid UI navigation
                </div>
                <div className="tooltip-content">
                  Press a key to select a category, then another key to execute an action. 
                  No mouse needed - just fast, two-key combinations to get where you're going. 
                  Press the first key to get started
                </div>
                <div className="tooltip-namespaces">
                  {quickDrawRegistry.getAllNamespaces().map(ns => (
                    <div key={ns.key} className="tooltip-namespace">
                      [{ns.key}] - {ns.name}
                    </div>
                  ))}
                  <div className="tooltip-more">(More on the way)</div>
                </div>
              </div>
            )}
          </div>
        ) : (
          // Active namespace indicator
          <div className="quick-draw-active">
            {currentNamespace?.name} {state.activeNamespace}+
          </div>
        )}
      </div>

      {/* Help Context Overlay */}
      {state.showHelpContext && state.activeNamespace && (
        <HelpContextOverlay
          namespace={state.activeNamespace}
          onClose={resetState}
        />
      )}
    </>
  );
};