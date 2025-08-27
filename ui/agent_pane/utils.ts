import { Session, Project, ProjectGroup, SessionStatus, EventStatus, PROJECT_COLORS } from './types';

export const groupSessionsByProject = (
  sessions: Session[], 
  projects: Project[]
): ProjectGroup[] => {
  const sessionMap = new Map<string, Session[]>();
  
  // Group sessions by project
  sessions.forEach(session => {
    if (!sessionMap.has(session.project)) {
      sessionMap.set(session.project, []);
    }
    sessionMap.get(session.project)!.push(session);
  });
  
  // Create project groups with consistent color assignment
  // Colors assigned based on project creation order, same as project pane
  const sortedProjects = projects.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const projectColorMap = new Map<string, number>();
  
  sortedProjects.forEach((project, index) => {
    projectColorMap.set(project.name, index % PROJECT_COLORS.length);
  });
  
  // Return all projects, even those without active sessions
  return sortedProjects.map(project => ({
    projectName: project.name,
    sessions: sessionMap.get(project.name) || [],
    colorIndex: projectColorMap.get(project.name) || 0,
    backgroundColor: PROJECT_COLORS[projectColorMap.get(project.name) || 0]
  }));
};

export const getSessionStatus = (session: Session, eventStatus: EventStatus | null): SessionStatus => {
  // Check if we have no event data at all
  if (!eventStatus) {
    return { 
      id: session.id,
      needsAttention: false, 
      statusText: 'No data', 
      statusColor: 'empty' 
    };
  }

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

export const getStatusIcon = (statusColor: 'green' | 'yellow' | 'gray' | 'empty'): string => {
  switch (statusColor) {
    case 'green': return '⚡';
    case 'yellow': return '⚠️';
    case 'gray': return '⚫';
    case 'empty': return '⚪';
    default: return '⚫';
  }
};

export const getStatusEmoji = (statusColor: 'green' | 'yellow' | 'gray' | 'empty'): string => {
  switch (statusColor) {
    case 'green': return '🟢';
    case 'yellow': return '🟡';
    case 'gray': return '⚫';
    case 'empty': return '⚪';
    default: return '⚫';
  }
};