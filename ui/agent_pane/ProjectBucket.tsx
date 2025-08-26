import React from 'react';
import { Session, Project } from './types';
import { SmallAgentWidget } from './SmallAgentWidget';

interface ProjectBucketProps {
  project: Project;
  backgroundColor: string;
  sessions: Session[];
  selectedAgentId?: string;
  onAgentClick?: (sessionId: string) => void;
  onOpenSettings?: (projectName: string) => void;
  onDeleteProject?: (projectName: string) => void;
  onNewAgent?: (projectName: string) => void;
}

export const ProjectBucket: React.FC<ProjectBucketProps> = ({
  project,
  backgroundColor,
  sessions,
  selectedAgentId,
  onAgentClick,
  onOpenSettings,
  onDeleteProject,
  onNewAgent,
}) => {
  return (
    <div className="project-bucket" style={{ backgroundColor }}>
      <div className="project-bucket__header">
        <span className="project-bucket__name">{project.name}</span>
        <div className="project-bucket__controls">
          <button
            onClick={() => onOpenSettings && onOpenSettings(project.name)}
            className="project-bucket__button project-bucket__settings"
            title="Project settings"
          >
            ⚙
          </button>
          <button
            onClick={() => onDeleteProject && onDeleteProject(project.name)}
            className="project-bucket__button project-bucket__close"
            title="Close project"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="project-bucket__agents">
        {sessions.map((session) => (
          <SmallAgentWidget
            key={session.id}
            session={session}
            onAgentClick={onAgentClick}
            isSelected={selectedAgentId === session.id}
          />)
        )}
      </div>

      <div className="project-bucket__footer">
        <button
          className="project-bucket__new-agent"
          onClick={() => onNewAgent && onNewAgent(project.name)}
        >
          + New Agent
        </button>
      </div>
    </div>
  );
};


