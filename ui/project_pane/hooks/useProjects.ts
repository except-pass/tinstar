import { useState, useEffect, useCallback } from 'react';
import { Project, ProjectResponse, CreateProjectRequest, UpdateProjectRequest } from '../types';

interface UseProjectsReturn {
  projects: Project[];
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  createProject: (request: CreateProjectRequest) => Promise<Project>;
  updateProject: (name: string, request: UpdateProjectRequest) => Promise<Project>;
  deleteProject: (name: string) => Promise<boolean>;
  clearError: () => void;
}

export const useProjects = (): UseProjectsReturn => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch('/api/projects');
      if (!response.ok) {
        throw new Error(`Failed to fetch projects: ${response.statusText}`);
      }
      
      const data: ProjectResponse = await response.json();
      if (data.success && data.projects) {
        setProjects(data.projects);
      } else {
        throw new Error(data.message || 'Failed to load projects');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const createProject = useCallback(async (request: CreateProjectRequest): Promise<Project> => {
    try {
      setError(null);
      
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to create project');
      }
      
      const data: ProjectResponse = await response.json();
      if (data.success && data.project) {
        // Add to local state
        setProjects(prev => [...prev, data.project!]);
        return data.project;
      } else {
        throw new Error(data.message || 'Failed to create project');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
      throw err;
    }
  }, []);

  const updateProject = useCallback(async (name: string, request: UpdateProjectRequest): Promise<Project> => {
    try {
      setError(null);
      
      const response = await fetch(`/api/projects/${name}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to update project');
      }
      
      const data: ProjectResponse = await response.json();
      if (data.success && data.project) {
        // Update in local state
        setProjects(prev => 
          prev.map(p => p.name === name ? data.project! : p)
        );
        return data.project;
      } else {
        throw new Error(data.message || 'Failed to update project');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project');
      throw err;
    }
  }, []);

  const deleteProject = useCallback(async (name: string): Promise<boolean> => {
    try {
      setError(null);
      
      const response = await fetch(`/api/projects/${name}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to delete project');
      }
      
      const data: ProjectResponse = await response.json();
      if (data.success) {
        // Remove from local state
        setProjects(prev => prev.filter(p => p.name !== name));
        return true;
      } else {
        throw new Error(data.message || 'Failed to delete project');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project');
      throw err;
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Load projects on mount
  useEffect(() => {
    fetchProjects().catch(() => {
      // Error is already set in fetchProjects
    });
  }, [fetchProjects]);

  return {
    projects,
    loading,
    error,
    fetchProjects,
    createProject,
    updateProject,
    deleteProject,
    clearError,
  };
};