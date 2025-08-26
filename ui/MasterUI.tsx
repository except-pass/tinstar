import React, { useState } from 'react';
import { AgentPane } from './agent_pane';
import { ProjectPane } from './project_pane';
import './MasterUI.css';

interface MasterUIProps {
  // Optional props for customizing the UI
  showProjectPane?: boolean;
  showAgentPane?: boolean;
  onAgentSelect?: (sessionId: string) => void;
  onProjectSelect?: (projectName: string) => void;
}

export const MasterUI: React.FC<MasterUIProps> = ({
  showProjectPane = true,
  showAgentPane = true,
  onAgentSelect,
  onProjectSelect,
}) => {
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedProjectName, setSelectedProjectName] = useState<string>('');
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(280); // Initial width for project pane
  const [isResizing, setIsResizing] = useState<boolean>(false);

  const handleAgentClick = (sessionId: string) => {
    setSelectedAgentId(sessionId);
    if (onAgentSelect) {
      onAgentSelect(sessionId);
    }
  };

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
          />
        </div>
      )}
      
      <div className="master-ui-content">
        <div className="master-ui-header">
          <h1>Tinstar</h1>
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
            <div className="content-section">
              <h2>Agent Details</h2>
              <div className="agent-details-placeholder">
                <p>Selected agent: <strong>{selectedAgentId}</strong></p>
                <p>This is where agent details, terminal output, or other agent-specific UI would go.</p>
                
                <div className="placeholder-actions">
                  <button className="action-btn">View Terminal</button>
                  <button className="action-btn">Send Command</button>
                  <button className="action-btn">Open Editor</button>
                  <button className="action-btn danger">Terminate</button>
                </div>
              </div>
            </div>
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
              <h2>Welcome to Tinstar</h2>
              <div className="welcome-content">
                <p>Select an agent from the left pane to view its details and interact with it.</p>
                <p>Or browse projects to manage your development environments.</p>
                
                <div className="welcome-features">
                  <h3>Features:</h3>
                  <ul>
                    <li><strong>Agent Management</strong>: View and control active Claude Code agents</li>
                    <li><strong>Project Organization</strong>: Manage multiple development projects</li>
                    <li><strong>Real-time Status</strong>: Live updates on agent activity</li>
                    <li><strong>Color Coding</strong>: Visual organization by project</li>
                  </ul>
                </div>
                
                <div className="quick-actions">
                  <h3>Quick Start:</h3>
                  <button className="action-btn primary">Create New Agent</button>
                  <button className="action-btn">Add Project</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};