import React, { useState, useEffect } from 'react';
import { Project, ProjectPaneState, CreateProjectRequest, ProjectResponse } from './types';
import { ProjectWidget } from './ProjectWidget';
import './ProjectPane.css';

interface ProjectPaneProps {
  className?: string;
}

export const ProjectPane: React.FC<ProjectPaneProps> = ({ className }) => {
  const [state, setState] = useState<ProjectPaneState>({
    projects: [],
    loading: false,
    error: null,
  });

  const fetchProjects = async () => {
    try {
      setState(prev => ({ ...prev, loading: true, error: null }));
      
      const response = await fetch('/api/projects');
      if (!response.ok) {
        throw new Error(`Failed to fetch projects: ${response.statusText}`);
      }
      
      const data: ProjectResponse = await response.json();
      if (data.success && data.projects) {
        setState(prev => ({ ...prev, projects: data.projects || [], loading: false }));
      } else {
        throw new Error(data.message || 'Failed to load projects');
      }
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load projects',
      }));
    }
  };

  const handleCloseProject = async (projectName: string) => {
    try {
      const response = await fetch(`/api/projects/${projectName}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `Failed to close project: ${response.statusText}`);
      }
      
      // Remove from local state
      setState(prev => ({
        ...prev,
        projects: prev.projects.filter(p => p.name !== projectName),
      }));
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to close project',
      }));
    }
  };

  const handleRefreshProject = () => {
    fetchProjects();
  };

  const handleNewProject = async () => {
    try {
      // Use browser's file dialog to select directory
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.multiple = false;
      
      input.onchange = async (event) => {
        const target = event.target as HTMLInputElement;
        const files = target.files;
        
        if (files && files.length > 0) {
          // Get directory path from first file
          const firstFile = files[0];
          const pathParts = firstFile.webkitRelativePath.split('/');
          const directoryName = pathParts[0];
          
          // For web implementation, we'll use the directory name
          // In a real desktop app, you'd get the full path
          const fullPath = firstFile.path ? 
            firstFile.path.replace('/' + firstFile.webkitRelativePath, '') + '/' + directoryName :
            directoryName;
          
          try {
            const requestData: CreateProjectRequest = {
              path: fullPath,
            };

            const response = await fetch('/api/projects', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestData),
            });
            
            if (!response.ok) {
              const errorData = await response.json();
              throw new Error(errorData.detail || 'Failed to create project');
            }
            
            // Refresh projects list
            await fetchProjects();
          } catch (err) {
            setState(prev => ({
              ...prev,
              error: err instanceof Error ? err.message : 'Failed to create project',
            }));
          }
        }
      };
      
      input.click();
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to select directory',
      }));
    }
  };

  const dismissError = () => {
    setState(prev => ({ ...prev, error: null }));
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  return (
    <div className={`project-pane ${className || ''}`}>
      <div className="project-pane-header">
        <h3>Projects</h3>
      </div>
      
      {state.loading && (
        <div className="project-pane__loading">Loading projects...</div>
      )}
      
      {state.error && (
        <div className="project-pane__error">
          <span>{state.error}</span>
          <button onClick={dismissError} className="project-pane__error-dismiss">
            ✕
          </button>
        </div>
      )}
      
      <div className="project-pane__projects">
        {state.projects.map((project, index) => (
          <ProjectWidget
            key={project.name}
            project={project}
            colorIndex={index % 8} // Cycle through 8 colors from palette
            onClose={() => handleCloseProject(project.name)}
            onRefresh={handleRefreshProject}
          />
        ))}
      </div>
      
      <button 
        className="project-pane__new-project"
        onClick={handleNewProject}
        disabled={state.loading}
      >
        + New Project
      </button>
    </div>
  );
};