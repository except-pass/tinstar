import { Session, Project, ProjectGroup, SessionStatus, EventStatus, PROJECT_COLORS } from './types';

export const groupSessionsByProject = (
  sessions: Session[], 
  projects: Project[]
): ProjectGroup[] => {
  const projectMap = new Map<string, Session[]>();
  
  // Group sessions by project
  sessions.forEach(session => {
    if (!projectMap.has(session.project)) {
      projectMap.set(session.project, []);
    }
    projectMap.get(session.project)!.push(session);
  });
  
  // Create project groups with consistent color assignment
  // Colors assigned based on project creation order, same as project pane
  const sortedProjects = projects.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const projectColorMap = new Map<string, number>();
  
  sortedProjects.forEach((project, index) => {
    projectColorMap.set(project.name, index % PROJECT_COLORS.length);
  });
  
  return Array.from(projectMap.entries()).map(([projectName, sessions]) => ({
    projectName,
    sessions,
    colorIndex: projectColorMap.get(projectName) || 0,
    backgroundColor: PROJECT_COLORS[projectColorMap.get(projectName) || 0]
  }));
};

export const getSessionStatus = (session: Session, eventStatus: EventStatus): SessionStatus => {
  // Check for "needs attention" via notification events
  if (eventStatus.hasNotifyEvent) {
    return { 
      id: session.id,
      needsAttention: true, 
      statusText: 'Needs attention', 
      statusColor: 'yellow' 
    };
  }
  
  // Check for "idle" via Stop events or no recent activity
  if (eventStatus.hasStopEvent || 
      eventStatus.lastEventTime < new Date(Date.now() - 5 * 60 * 1000)) {
    return { 
      id: session.id,
      needsAttention: false, 
      statusText: 'Idle', 
      statusColor: 'gray' 
    };
  }
  
  return { 
    id: session.id,
    needsAttention: false, 
    statusText: 'Active', 
    statusColor: 'green' 
  };
};

export const getStatusIcon = (statusColor: 'green' | 'yellow' | 'gray'): string => {
  switch (statusColor) {
    case 'green': return '⚡';
    case 'yellow': return '⚠️';
    case 'gray': return '⚫';
    default: return '⚫';
  }
};

export const getStatusEmoji = (statusColor: 'green' | 'yellow' | 'gray'): string => {
  switch (statusColor) {
    case 'green': return '🟢';
    case 'yellow': return '🟡';
    case 'gray': return '⚫';
    default: return '⚫';
  }
};