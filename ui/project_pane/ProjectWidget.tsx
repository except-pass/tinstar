import React, { useState } from 'react';
import { Project, ProjectWidgetState, COLOR_PALETTE } from './types';
import { FileTree } from '../filelist/FileTree';
import { ProjectSettingsDialog } from './ProjectSettingsDialog';

interface ProjectWidgetProps {
  project: Project;
  colorIndex: number;
  onClose: () => void;
  onRefresh: () => void;
}

export const ProjectWidget: React.FC<ProjectWidgetProps> = ({
  project,
  colorIndex,
  onClose,
  onRefresh,
}) => {
  const [state, setState] = useState<ProjectWidgetState>({
    refreshing: false,
    closing: false,
    showingSettings: false,
    updatingSettings: false,
  });

  const backgroundColor = COLOR_PALETTE[colorIndex % COLOR_PALETTE.length];

  const handleRefresh = async () => {
    setState(prev => ({ ...prev, refreshing: true }));
    try {
      await onRefresh();
    } finally {
      setState(prev => ({ ...prev, refreshing: false }));
    }
  };

  const handleClose = async () => {
    setState(prev => ({ ...prev, closing: true }));
    try {
      await onClose();
    } finally {
      setState(prev => ({ ...prev, closing: false }));
    }
  };

  const handleSettings = () => {
    setState(prev => ({ ...prev, showingSettings: true }));
  };

  const handleSettingsClose = () => {
    setState(prev => ({ ...prev, showingSettings: false }));
  };

  const handleSettingsSave = async () => {
    setState(prev => ({ ...prev, updatingSettings: true }));
    try {
      // After settings are saved, refresh the project list
      await onRefresh();
      setState(prev => ({ ...prev, showingSettings: false }));
    } finally {
      setState(prev => ({ ...prev, updatingSettings: false }));
    }
  };

  // Custom file open handler that doesn't require sessionId
  const handleFileOpen = async (filePath: string) => {
    try {
      // Use the generic editor API endpoint
      await fetch('/api/editor/open', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_path: filePath }),
      });
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  return (
    <>
      <div 
        className="project-widget"
        style={{ backgroundColor }}
      >
        <div className="project-widget__header">
          <span className="project-widget__name">{project.name}</span>
          
          <div className="project-widget__controls">
            <button
              onClick={handleRefresh}
              disabled={state.refreshing || state.closing}
              className="project-widget__button project-widget__refresh"
              title="Refresh file list"
            >
              {state.refreshing ? '⟳' : '↻'}
            </button>
            
            <button
              onClick={handleSettings}
              disabled={state.closing || state.refreshing}
              className="project-widget__button project-widget__settings"
              title="Project settings"
            >
              ⚙
            </button>
            
            <button
              onClick={handleClose}
              disabled={state.closing || state.refreshing}
              className="project-widget__button project-widget__close"
              title="Close project"
            >
              {state.closing ? '⟳' : '✕'}
            </button>
          </div>
        </div>
        
        <div className="project-widget__content">
          <FileTree
            projectName={project.name}
            height={300}
            onFileOpen={handleFileOpen}
          />
        </div>
      </div>
      
      {state.showingSettings && (
        <ProjectSettingsDialog
          project={project}
          onClose={handleSettingsClose}
          onSave={handleSettingsSave}
          saving={state.updatingSettings}
        />
      )}
    </>
  );
};