import React, { useState, useEffect, useCallback } from 'react';
import { Session, Project, ProjectGroup, CreateSessionRequest } from './types';
import { SmallAgentWidget } from './SmallAgentWidget';
import { useSessions } from './hooks/useSessions';
import { useProjects } from './hooks/useProjects';
import { useEvents } from './hooks/useEvents';
import { groupSessionsByProject } from './utils';
import './AgentPane.css';

interface AgentPaneProps {
  onAgentClick?: (sessionId: string) => void;
  selectedAgentId?: string;
}

export const AgentPane: React.FC<AgentPaneProps> = ({
  onAgentClick,
  selectedAgentId,
}) => {
  const { sessions, loading: sessionsLoading, error: sessionsError, fetchSessions, createSession } = useSessions();
  const { projects, loading: projectsLoading, error: projectsError } = useProjects();
  const { connectWebSocket, disconnectWebSocket, isWebSocketConnected } = useEvents();
  
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
  const [newAgentProject, setNewAgentProject] = useState('');
  const [newAgentPrompt, setNewAgentPrompt] = useState('');
  const [creating, setCreating] = useState(false);

  // Update project groups when sessions or projects change
  useEffect(() => {
    if (sessions.length > 0 && projects.length > 0) {
      const groups = groupSessionsByProject(sessions, projects);
      setProjectGroups(groups);
    } else {
      setProjectGroups([]);
    }
  }, [sessions, projects]);

  // Connect to WebSocket for real-time updates
  useEffect(() => {
    connectWebSocket();
    return () => {
      disconnectWebSocket();
    };
  }, [connectWebSocket, disconnectWebSocket]);

  // Handle WebSocket events for real-time updates
  const handleWebSocketEvent = useCallback((eventData: any) => {
    console.log('Received event:', eventData);
    // Refresh sessions when we get relevant events
    if (eventData.type === 'notification' || eventData.type === 'Stop') {
      fetchSessions().catch(console.error);
    }
  }, [fetchSessions]);

  // Set up WebSocket event handler
  const { connectWebSocket: connectWithHandler } = useEvents(handleWebSocketEvent);
  
  useEffect(() => {
    connectWithHandler();
  }, [connectWithHandler]);

  // Auto-refresh sessions periodically
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSessions().catch(console.error);
    }, 10000); // Refresh every 10 seconds

    return () => clearInterval(interval);
  }, [fetchSessions]);

  const handleNewAgent = async () => {
    if (!newAgentProject.trim()) {
      return;
    }

    try {
      setCreating(true);
      const request: CreateSessionRequest = {
        project: newAgentProject.trim(),
        initial_prompt: newAgentPrompt.trim() || undefined,
        agent_type: 'claude'
      };
      
      await createSession(request);
      setShowNewAgentDialog(false);
      setNewAgentProject('');
      setNewAgentPrompt('');
    } catch (err) {
      console.error('Failed to create session:', err);
    } finally {
      setCreating(false);
    }
  };


  const loading = sessionsLoading || projectsLoading;
  const error = sessionsError || projectsError;

  return (
    <div className="agent-pane">
      <div className="agent-pane-header">
        <h3>Agents</h3>
        <div className="header-indicators">
          {loading && <div className="loading-indicator" title="Refreshing agents...">⟳</div>}
          {isWebSocketConnected && <div className="websocket-indicator" title="Real-time updates connected">🟢</div>}
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => {
            fetchSessions().catch(console.error);
          }}>
            Retry
          </button>
        </div>
      )}

      <div className="agent-groups">
        {projectGroups.map(group => (
            <div 
              key={group.projectName} 
              className="project-group"
              style={{ backgroundColor: group.backgroundColor }}
            >
              <div className="project-header">
                <span className="project-name">{group.projectName}</span>
              </div>
              <div className="project-agents">
                {group.sessions.map(session => (
                  <SmallAgentWidget
                    key={session.id}
                    session={session}
                    onAgentClick={onAgentClick}
                    isSelected={selectedAgentId === session.id}
                  />
                ))}
              </div>
            </div>
          ))}
          
        {projectGroups.length === 0 && !loading && (
          <div className="empty-state">
            No active agents. Create one below to get started.
          </div>
        )}
      </div>

      <div className="new-agent-section">
        <button 
          className="new-agent-button"
          onClick={() => setShowNewAgentDialog(true)}
          disabled={creating}
        >
          + New Agent
        </button>
      </div>

      {showNewAgentDialog && (
        <div className="new-agent-dialog">
          <div className="dialog-overlay" onClick={() => setShowNewAgentDialog(false)} />
          <div className="dialog-content">
            <h4>Create New Agent</h4>
            <div className="form-group">
              <label htmlFor="project-select">Project:</label>
              <select
                id="project-select"
                value={newAgentProject}
                onChange={(e) => setNewAgentProject(e.target.value)}
                disabled={creating}
              >
                <option value="">Select a project...</option>
                {projects.map(project => (
                  <option key={project.name} value={project.name}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="initial-prompt">Initial Prompt (optional):</label>
              <textarea
                id="initial-prompt"
                value={newAgentPrompt}
                onChange={(e) => setNewAgentPrompt(e.target.value)}
                placeholder="Enter an initial prompt for the agent..."
                rows={3}
                disabled={creating}
              />
            </div>
            <div className="dialog-actions">
              <button 
                onClick={() => setShowNewAgentDialog(false)}
                disabled={creating}
              >
                Cancel
              </button>
              <button 
                onClick={handleNewAgent}
                disabled={!newAgentProject.trim() || creating}
                className="primary"
              >
                {creating ? 'Creating...' : 'Create Agent'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};