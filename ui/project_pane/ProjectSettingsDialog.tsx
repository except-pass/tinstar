import React, { useState, useEffect } from 'react';
import { Project, ProjectSettingsState, UpdateProjectRequest, ProjectResponse, pathsToText, textToPaths } from './types';

interface ProjectSettingsDialogProps {
  project: Project;
  onClose: () => void;
  onSave: () => Promise<void>;
  saving: boolean;
}

export const ProjectSettingsDialog: React.FC<ProjectSettingsDialogProps> = ({
  project,
  onClose,
  onSave,
  saving,
}) => {
  const [state, setState] = useState<ProjectSettingsState>({
    unignorePaths: '',
    originalPaths: [],
    saving: false,
    error: null,
  });

  // Initialize dialog with current project settings
  useEffect(() => {
    const pathsText = pathsToText(project.unignore_paths);
    setState(prev => ({
      ...prev,
      unignorePaths: pathsText,
      originalPaths: [...project.unignore_paths],
    }));
  }, [project]);

  const handleTextAreaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setState(prev => ({ ...prev, unignorePaths: event.target.value, error: null }));
  };

  const handleSave = async () => {
    setState(prev => ({ ...prev, saving: true, error: null }));
    
    try {
      // Convert text to paths array
      const newPaths = textToPaths(state.unignorePaths);
      
      const updateRequest: UpdateProjectRequest = {
        unignore_paths: newPaths,
      };

      const response = await fetch(`/api/projects/${project.name}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updateRequest),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `Failed to update project: ${response.statusText}`);
      }

      const data: ProjectResponse = await response.json();
      if (!data.success) {
        throw new Error(data.message || 'Failed to update project settings');
      }

      // Call parent's save handler to refresh project list
      await onSave();
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to save settings',
        saving: false,
      }));
    }
  };

  const handleCancel = () => {
    // Reset to original values
    setState(prev => ({
      ...prev,
      unignorePaths: pathsToText(prev.originalPaths),
      error: null,
    }));
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      handleCancel();
    }
  };

  return (
    <div className="project-settings-dialog__overlay" onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="project-settings-dialog">
        <div className="project-settings-dialog__header">
          <h3>Project Settings</h3>
          <button
            onClick={handleCancel}
            className="project-settings-dialog__close"
            disabled={state.saving || saving}
          >
            ✕
          </button>
        </div>

        <div className="project-settings-dialog__content">
          <div className="project-settings-dialog__field">
            <label className="project-settings-dialog__label">
              Project Name
            </label>
            <input
              type="text"
              value={project.name}
              readOnly
              className="project-settings-dialog__input project-settings-dialog__input--readonly"
            />
          </div>

          <div className="project-settings-dialog__field">
            <label className="project-settings-dialog__label">
              Unignore Paths
              <span className="project-settings-dialog__hint">
                (one path per line, relative to project root)
              </span>
            </label>
            <textarea
              value={state.unignorePaths}
              onChange={handleTextAreaChange}
              className="project-settings-dialog__textarea"
              rows={8}
              placeholder="src/config.json&#10;.env.local&#10;docs/secrets.md"
              disabled={state.saving || saving}
            />
          </div>

          {state.error && (
            <div className="project-settings-dialog__error">
              {state.error}
            </div>
          )}
        </div>

        <div className="project-settings-dialog__actions">
          <button
            onClick={handleCancel}
            className="project-settings-dialog__button project-settings-dialog__button--cancel"
            disabled={state.saving || saving}
          >
            Cancel
          </button>
          
          <button
            onClick={handleSave}
            className="project-settings-dialog__button project-settings-dialog__button--save"
            disabled={state.saving || saving}
          >
            {state.saving || saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};