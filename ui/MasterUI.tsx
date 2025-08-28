import React, { useState } from 'react';
import { AgentPane } from './agent_pane';
import { ProjectPane } from './project_pane';
import { DetailsPane } from './details_pane';
import { QuickDraw } from './quick_draw/QuickDraw';
import './MasterUI.css';

interface MasterUIProps {
  // Optional props for customizing the UI
  showProjectPane?: boolean;
  showAgentPane?: boolean;
  onAgentSelect?: (sessionId: string) => void;
  onProjectSelect?: (projectName: string) => void;
}

export const MasterUI: React.FC<MasterUIProps> = ({
  showProjectPane = false,
  showAgentPane = true,
  onAgentSelect,
  onProjectSelect,
}) => {
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedProjectName, setSelectedProjectName] = useState<string>('');
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(280); // Initial width for project pane
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  const handleAgentClick = (sessionId: string) => {
    setSelectedAgentId(sessionId);
    if (onAgentSelect) {
      onAgentSelect(sessionId);
    }
  };

  // Listen for termination events from DetailsPane to auto-select top agent
  React.useEffect(() => {
    const handler: EventListener = async (evt: Event) => {
      const ce = evt as CustomEvent;
      const detail = (ce && ce.detail) || {};
      const type = detail.type;
      if (type === 'session-terminated') {
        // Refresh agent list and select the top agent if available
        try {
          setSelectedAgentId('');
          setRefreshKey((k) => k + 1);
          const res = await fetch('/api/sessions');
          if (res.ok) {
            const data = await res.json();
            if (data && data.sessions && data.sessions.length > 0) {
              const top = data.sessions[0];
              setSelectedAgentId(top.id);
              if (onAgentSelect) onAgentSelect(top.id);
            }
          }
        } catch {
          // ignore fetch errors; user can manually select
        }
      }
    };
    window.addEventListener('tinstar', handler);
    return () => window.removeEventListener('tinstar', handler);
  }, [onAgentSelect]);

  const handleProjectClick = (projectName: string) => {
    setSelectedProjectName(projectName);
    if (onProjectSelect) {
      onProjectSelect(projectName);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsResizing(true);
    e.preventDefault();
  };

  const handleMouseMove = React.useCallback((e: MouseEvent) => {
    if (!isResizing) return;
    
    const newWidth = e.clientX;
    const minWidth = 200;
    const maxWidth = 500;
    
    if (newWidth >= minWidth && newWidth <= maxWidth) {
      setLeftPaneWidth(newWidth);
    }
  }, [isResizing]);

  const handleMouseUp = React.useCallback(() => {
    setIsResizing(false);
  }, []);

  React.useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isResizing, handleMouseMove, handleMouseUp]);

  return (
    <div className="master-ui">
      {showProjectPane && (
        <div 
          className="master-ui-pane projects-pane" 
          style={{ width: leftPaneWidth }}
        >
          <ProjectPane />
        </div>
      )}
      
      {showProjectPane && showAgentPane && (
        <div 
          className={`master-ui-resizer ${isResizing ? 'resizing' : ''}`}
          onMouseDown={handleMouseDown}
        />
      )}
      
      {showAgentPane && (
        <div className="master-ui-pane agents-pane">
          <AgentPane 
            onAgentClick={handleAgentClick}
            selectedAgentId={selectedAgentId}
            key={refreshKey}
          />
        </div>
      )}
      
      <div className="master-ui-content">
        <div className="master-ui-header">
          <div className="header-left">
            <QuickDraw />
            <h1>Tinstar</h1>
          </div>
          <div className="master-ui-status">
            {selectedAgentId && (
              <div className="selected-info">
                <span className="label">Selected Agent:</span>
                <span className="value">{selectedAgentId}</span>
              </div>
            )}
            {selectedProjectName && (
              <div className="selected-info">
                <span className="label">Selected Project:</span>
                <span className="value">{selectedProjectName}</span>
              </div>
            )}
          </div>
        </div>
        
        <div className="master-ui-main">
          {selectedAgentId ? (
            <DetailsPane sessionId={selectedAgentId} />
          ) : selectedProjectName ? (
            <div className="content-section">
              <h2>Project Details</h2>
              <div className="project-details-placeholder">
                <p>Selected project: <strong>{selectedProjectName}</strong></p>
                <p>This is where project file lists, git status, or other project-specific UI would go.</p>
                
                <div className="placeholder-actions">
                  <button className="action-btn">Browse Files</button>
                  <button className="action-btn">Git Status</button>
                  <button className="action-btn">New Agent</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="content-section">
              <div className="intro-header">
                <img src="/logo.png" alt="Tinstar Logo" className="intro-logo" />
                <h2>Welcome to Tinstar</h2>
                <p className="intro-subtitle">Development environment management for Claude Code</p>
                <p className="intro-description">
                  Tinstar organizes your agents and projects, providing keyboard shortcuts for rapid navigation.
                </p>
              </div>

              <div className="getting-started">
                <h3>Getting Started</h3>
                
                <div className="intro-section">
                  <h4>Projects & Agents</h4>
                  <ul>
                    <li>Add projects to organize your development work</li>
                    <li>Create agents that automatically get isolated workspaces</li>
                    <li>Each project gets color coding for easy identification</li>
                  </ul>
                </div>

                <div className="intro-section">
                  <h4>Quick Draw Navigation</h4>
                  <ul>
                    <li>Use ⚡🤠 Quick Draw for keyboard shortcuts</li>
                    <li>Press <code>a</code> then another key to select agents</li>
                    <li>Hover the Quick Draw badge to see all available shortcuts</li>
                  </ul>
                </div>

                <div className="intro-section">
                  <h4>Key Features</h4>
                  <ul>
                    <li>Multi-project agent management</li>
                    <li>Real-time session tracking</li>
                    <li>Keyboard-driven workflow</li>
                    <li>Isolated worktrees per agent</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};