import { Event, Commit, TimelineEvent } from './types';

export const mapEventType = (hookEventName: string): TimelineEvent['type'] => {
  switch (hookEventName.toLowerCase()) {
    case 'user_prompt':
    case 'userprompt':
    case 'userpromptsubmit':
      return 'prompt';
    case 'notification':
      return 'notification';
    case 'stop':
    case 'subagent_stop':
      return 'stop';
    case 'pre_tool_use':
    case 'post_tool_use':
    case 'pretooluse':
    case 'posttooluse':
      return 'tool';
    case 'todowrite':
      return 'todo';
    default:
      return 'tool';
  }
};

export const getEventIcon = (event: Event | { type: 'commit' }, isActive?: boolean): TimelineEvent['icon'] => {
  if ('type' in event && event.type === 'commit') {
    return '💾';
  }
  
  const eventData = event as Event;
  const type = mapEventType(eventData.hook_event_name);
  
  switch (type) {
    case 'prompt':
      return '📝';
    case 'notification':
      return isActive ? '🔔' : '◽';
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
  return event.hook_event_name === 'pre_tool_use' || 
         event.hook_event_name === 'post_tool_use' ||
         event.hook_event_name === 'tool_use';
};

export const groupToolUsesByMessage = (events: Event[]): Array<Event & { toolCount?: number }> => {
  if (events.length === 0) return [];
  
  const grouped: Array<Event & { toolCount?: number }> = [];
  let skipUntil = -1;
  
  for (let i = 0; i < events.length; i++) {
    if (i <= skipUntil) continue; // Skip events that were already grouped
    
    const event = events[i];
    
    if (isToolEvent(event)) {
      // Count all tool events in this message burst
      let toolCount = 1;
      let lastToolIndex = i;
      
      // Look ahead to count tool events until next user prompt or significant time gap
      for (let j = i + 1; j < events.length; j++) {
        const nextEvent = events[j];
        
        // Stop at user prompt (new message)
        if (nextEvent.hook_event_name === 'user_prompt') {
          break;
        }
        
        // Count tool events
        if (isToolEvent(nextEvent)) {
          toolCount++;
          lastToolIndex = j;
        }
        
        // Stop if too much time has passed since the first tool
        const timeSinceFirst = new Date(nextEvent.timestamp).getTime() - new Date(event.timestamp).getTime();
        if (timeSinceFirst > 300000) { // 5 minutes
          break;
        }
      }
      
      // Add the grouped tool event
      grouped.push({
        ...event,
        toolCount: toolCount > 1 ? toolCount : undefined
      });
      
      // Skip all the tool events we just counted
      skipUntil = lastToolIndex;
    } else {
      // Non-tool event, add as-is
      grouped.push(event);
    }
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
  const groupedEvents = groupToolUsesByMessage(events);
  
  const eventTimelines: TimelineEvent[] = groupedEvents.map((event, index) => {
    const active = event.hook_event_name === 'notification' && isActiveNotification(event, events);
    return {
      id: generateEventId(event, index),
      type: mapEventType(event.hook_event_name),
      timestamp: new Date(event.timestamp),
      icon: getEventIcon(event, active),
      count: event.toolCount,
      selected: false,
      active,
      data: event
    };
  });
  
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