import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Session, Project, ProjectGroup, CreateSessionRequest } from './types';
import { SmallAgentWidget } from './SmallAgentWidget';
import { useSessions } from './hooks/useSessions';
import { useProjects } from './hooks/useProjects';
import { ProjectBucket } from './ProjectBucket';
import { useEvents } from './hooks/useEvents';
import { groupSessionsByProject } from './utils';
import './AgentPane.css';
import '../project_pane/ProjectPane.css';
import { ProjectSettingsDialog } from '../project_pane/ProjectSettingsDialog';
import type { Project as FullProject, ProjectResponse as FullProjectResponse } from '../project_pane/types';
import { useQuickDrawActions } from '../quick_draw/useQuickDrawActions';

interface AgentPaneProps {
  onAgentClick?: (sessionId: string) => void;
  selectedAgentId?: string;
}

export const AgentPane: React.FC<AgentPaneProps> = ({
  onAgentClick,
  selectedAgentId,
}) => {
  const { sessions, loading: sessionsLoading, error: sessionsError, fetchSessions, createSession } = useSessions();
  const { projects, loading: projectsLoading, error: projectsError, fetchProjects } = useProjects();
  const { connectWebSocket, disconnectWebSocket, isWebSocketConnected } = useEvents();
  
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
  const [newAgentProject, setNewAgentProject] = useState('');
  const [newAgentPrompt, setNewAgentPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsProject, setSettingsProject] = useState<FullProject | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const projectSelectRef = useRef<HTMLSelectElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Update project groups when sessions or projects change
  useEffect(() => {
    if (projects.length > 0) {
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

  // Focus prompt textarea when dialog opens
  useEffect(() => {
    if (showNewAgentDialog && promptRef.current) {
      promptRef.current.focus();
    }
  }, [showNewAgentDialog]);

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

  const handleOpenProjectSettings = async (projectName: string) => {
    try {
      const res = await fetch(`/api/projects/${projectName}`);
      if (!res.ok) throw new Error('Failed to load project');
      const data: FullProjectResponse = await res.json();
      if (data && data.project) {
        setSettingsProject(data.project);
      }
    } catch (e) {
      console.error('Failed to open project settings', e);
    }
  };

  const handleDeleteProject = async (projectName: string) => {
    try {
      await fetch(`/api/projects/${projectName}`, { method: 'DELETE' });
      await fetchProjects();
      await fetchSessions();
    } catch (e) {
      console.error('Failed to delete project', e);
    }
  };

  const handleNewAgentForProject = (projectName: string) => {
    setShowNewAgentDialog(true);
    setNewAgentProject(projectName);
  };

  const handleNewAgentClick = () => {
    // Auto-select project if there's only one
    if (projects.length === 1) {
      setNewAgentProject(projects[0].name);
    }
    setShowNewAgentDialog(true);
  };

  // Setup QuickDraw actions for agent selection
  const allAgents = sessions.map(session => ({ id: session.id, name: session.name }));
  useQuickDrawActions({
    agents: allAgents,
    onAgentClick,
    onNewAgent: handleNewAgentClick
  });

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
          <ProjectBucket
            key={group.projectName}
            project={{ name: group.projectName, path: '', created_at: '', unignore_paths: [] }}
            backgroundColor={group.backgroundColor}
            sessions={group.sessions}
            selectedAgentId={selectedAgentId}
            onAgentClick={onAgentClick}
            onOpenSettings={handleOpenProjectSettings}
            onDeleteProject={handleDeleteProject}
            onNewAgent={handleNewAgentForProject}
          />
        ))}

        {projectGroups.length === 0 && !loading && (
          <div className="empty-state">
            No active agents. Create one below to get started.
          </div>
        )}
      </div>

      <div className="new-agent-section">
        <button 
          className="new-project-button"
          onClick={async () => {
            try {
              // Directory picker via input trick
              const input = document.createElement('input');
              input.type = 'file';
              // @ts-ignore
              input.webkitdirectory = true;
              input.multiple = false;
              input.onchange = async (event) => {
                const target = event.target as HTMLInputElement;
                const files = target.files;
                if (files && files.length > 0) {
                  const firstFile = files[0];
                  const pathParts = (firstFile as any).webkitRelativePath?.split('/') || [];
                  const directoryName = pathParts[0] || 'project';
                  const fullPath = (firstFile as any).path ?
                    (firstFile as any).path.replace('/' + (firstFile as any).webkitRelativePath, '') + '/' + directoryName :
                    directoryName;
                  await fetch('/api/projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: fullPath })
                  });
                  await fetchProjects();
                }
              };
              input.click();
            } catch (e) {
              console.error('Failed to create project', e);
            }
          }}
          disabled={creating}
        >
          + New Project
        </button>
        <button 
          className="new-agent-button"
          onClick={handleNewAgentClick}
          disabled={creating}
          data-testid="new-agent-button"
        >
          + New Agent
        </button>
      </div>

      {showNewAgentDialog && (
        <div className="new-agent-dialog">
          <div className="dialog-overlay" onClick={() => setShowNewAgentDialog(false)} />
          <div 
            ref={dialogRef}
            className="dialog-content"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && newAgentProject.trim() && !creating) {
                e.preventDefault();
                handleNewAgent();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setShowNewAgentDialog(false);
              }
            }}
            tabIndex={0}
          >
            <h4>Create New Agent</h4>
            <div className="form-group">
              <label htmlFor="project-select">Project:</label>
              <select
                ref={projectSelectRef}
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
                ref={promptRef}
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

      {settingsProject && (
        <ProjectSettingsDialog
          project={settingsProject}
          onClose={() => setSettingsProject(null)}
          onSave={async () => {
            try {
              setSettingsSaving(true);
              await fetchProjects();
            } finally {
              setSettingsSaving(false);
              setSettingsProject(null);
            }
          }}
          saving={settingsSaving}
        />
      )}
    </div>
  );
};