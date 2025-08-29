import { Event, Commit, TimelineEvent } from './types';

export const mapEventType = (hookEventName: string): TimelineEvent['type'] => {
  switch (hookEventName.toLowerCase()) {
    case 'user_prompt':
      return 'prompt';
    case 'notification':
      return 'notification';
    case 'stop':
      return 'stop';
    case 'pre_tool_use':
    case 'post_tool_use':
      return 'tool';
    case 'todowrite':
      return 'todo';
    default:
      return 'tool';
  }
};

export const getEventIcon = (event: Event | { type: 'commit' }): TimelineEvent['icon'] => {
  if ('type' in event && event.type === 'commit') {
    return '💾';
  }
  
  const eventData = event as Event;
  const type = mapEventType(eventData.hook_event_name);
  
  switch (type) {
    case 'prompt':
      return '💬';
    case 'notification':
      return '🟠';
    case 'stop':
      return '🛑';
    case 'tool':
      return '🔧';
    case 'todo':
      return '✅';
    case 'commit':
      return '💾';
    default:
      return '🔧';
  }
};

export const generateEventId = (event: Event | Commit, index: number): string => {
  if ('hash' in event) {
    return `commit-${event.hash}-${index}`;
  }
  return `event-${event.session_id}-${event.timestamp}-${index}`;
};

export const isToolEvent = (event: Event): boolean => {
  return event.hook_event_name === 'pre_tool_use' || event.hook_event_name === 'post_tool_use';
};

export const groupConsecutiveToolUses = (events: Event[]): Array<Event & { toolCount?: number }> => {
  if (events.length === 0) return [];
  
  const grouped: Array<Event & { toolCount?: number }> = [];
  let currentGroup: Event[] = [];
  
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    
    if (isToolEvent(event)) {
      currentGroup.push(event);
    } else {
      if (currentGroup.length > 0) {
        const representativeEvent = currentGroup[0];
        grouped.push({
          ...representativeEvent,
          toolCount: currentGroup.length > 1 ? currentGroup.length : undefined
        });
        currentGroup = [];
      }
      grouped.push(event);
    }
  }
  
  if (currentGroup.length > 0) {
    const representativeEvent = currentGroup[0];
    grouped.push({
      ...representativeEvent,
      toolCount: currentGroup.length > 1 ? currentGroup.length : undefined
    });
  }
  
  return grouped;
};

export const isActiveNotification = (event: Event, allEvents: Event[]): boolean => {
  if (event.hook_event_name !== 'notification') return false;
  
  const eventTime = new Date(event.timestamp);
  const laterStopEvents = allEvents.filter(e => 
    e.hook_event_name === 'stop' && new Date(e.timestamp) > eventTime
  );
  
  return laterStopEvents.length === 0;
};

export const processEvents = (events: Event[], commits: Commit[]): TimelineEvent[] => {
  const groupedEvents = groupConsecutiveToolUses(events);
  
  const eventTimelines: TimelineEvent[] = groupedEvents.map((event, index) => ({
    id: generateEventId(event, index),
    type: mapEventType(event.hook_event_name),
    timestamp: new Date(event.timestamp),
    icon: getEventIcon(event),
    count: event.toolCount,
    selected: false,
    active: event.hook_event_name === 'notification' && isActiveNotification(event, events),
    data: event
  }));
  
  const commitTimelines: TimelineEvent[] = commits.map((commit, index) => ({
    id: generateEventId(commit, index),
    type: 'commit' as const,
    timestamp: new Date(commit.timestamp),
    icon: '💾' as const,
    selected: false,
    data: commit
  }));
  
  const allTimelines = [...eventTimelines, ...commitTimelines];
  
  allTimelines.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  
  return allTimelines;
};