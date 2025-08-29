import React from 'react';
import { quickDrawRegistry } from './QuickDrawRegistry';
import './QuickDrawHelpOverlay.css';

interface QuickDrawHelpOverlayProps {
  onClose: () => void;
}

export const QuickDrawHelpOverlay: React.FC<QuickDrawHelpOverlayProps> = ({ onClose }) => {
  const namespaces = quickDrawRegistry.getAllNamespaces();

  // Group namespaces for table display
  const getNamespaceActions = (namespaceKey: string) => {
    return quickDrawRegistry.getActions(namespaceKey);
  };

  // Handle click outside to close
  React.useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.help-overlay-content')) {
        return;
      }
      onClose();
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClick);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClick);
    };
  }, [onClose]);

  // Handle ESC key to close
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="quickdraw-help-overlay">
      <div className="help-overlay-background" />
      <div className="help-overlay-content">
        <div className="help-overlay-header">
          <h2>⚡ Quick Draw Help</h2>
          <p>Keyboard shortcuts for rapid UI navigation. Press a namespace key, then an action key.</p>
        </div>
        
        <div className="help-overlay-table">
          {namespaces.map(namespace => {
            const actions = getNamespaceActions(namespace.key);
            return (
              <div key={namespace.key} className="namespace-column">
                <div className="namespace-header">
                  <span className="namespace-key">[{namespace.key}]</span>
                  <span className="namespace-name">{namespace.name}</span>
                </div>
                <div className="namespace-description">{namespace.description}</div>
                <div className="namespace-actions">
                  {actions.map(action => (
                    <div key={action.key} className="action-item">
                      <span className="action-key">{action.key}</span>
                      <span className="action-description">{action.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        
        <div className="help-overlay-footer">
          <p>Press <kbd>ESC</kbd> to close this help, or click outside</p>
        </div>
      </div>
    </div>
  );
};