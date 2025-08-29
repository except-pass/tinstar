import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TimelineProps, TimelineEvent } from './types';
import { useTimelineEvents } from './useTimelineEvents';
import { processEvents } from './utils';
import './Timeline.css';

export const Timeline: React.FC<TimelineProps> = ({
  sessionId,
  sessionName,
  onEventSelect,
  selectedEventId,
}) => {
  const { events, commits, loading, error, wsConnected } = useTimelineEvents(sessionId, sessionName);
  const [autoScroll, setAutoScroll] = useState(true);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const timelineRef = useRef<HTMLDivElement>(null);
  const userScrolling = useRef(false);

  const processedEvents = React.useMemo(() => {
    return processEvents(events, commits);
  }, [events, commits]);

  useEffect(() => {
    setTimelineEvents(processedEvents);
  }, [processedEvents]);

  const handleEventClick = useCallback((event: TimelineEvent) => {
    const updatedEvents = timelineEvents.map(e => ({
      ...e,
      selected: e.id === event.id
    }));
    setTimelineEvents(updatedEvents);
    onEventSelect(event);
  }, [timelineEvents, onEventSelect]);

  const scrollToLatest = useCallback(() => {
    if (timelineRef.current && autoScroll && !userScrolling.current) {
      timelineRef.current.scrollLeft = timelineRef.current.scrollWidth;
    }
  }, [autoScroll]);

  useEffect(() => {
    scrollToLatest();
  }, [timelineEvents, scrollToLatest]);

  useEffect(() => {
    if (selectedEventId) {
      const updatedEvents = timelineEvents.map(e => ({
        ...e,
        selected: e.id === selectedEventId
      }));
      setTimelineEvents(updatedEvents);
    }
  }, [selectedEventId, timelineEvents]);

  const handleScroll = useCallback(() => {
    userScrolling.current = true;
    setTimeout(() => {
      userScrolling.current = false;
    }, 1000);
  }, []);

  const formatTime = (timestamp: Date) => {
    return timestamp.toLocaleTimeString('en-US', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const userEvents = timelineEvents.filter(event => 
    ['prompt', 'notification', 'stop', 'commit'].includes(event.type)
  );
  const systemEvents = timelineEvents.filter(event => 
    ['tool', 'todo'].includes(event.type)
  );
  

  const getEventPosition = (event: TimelineEvent) => {
    if (timelineEvents.length === 0) return 0;
    const minTime = timelineEvents[0].timestamp.getTime();
    const maxTime = timelineEvents[timelineEvents.length - 1].timestamp.getTime();
    const range = maxTime - minTime;
    if (range === 0) return 0;
    return ((event.timestamp.getTime() - minTime) / range) * 100;
  };

  if (loading) {
    return (
      <div className="timeline-widget">
        <div className="timeline-header">
          <span className="timeline-title">Timeline</span>
          <div className="timeline-loading">Loading events...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="timeline-widget">
        <div className="timeline-header">
          <span className="timeline-title">Timeline</span>
          <div className="timeline-error">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="timeline-widget">
      <div className="timeline-header">
        <div className="timeline-title-section">
          <span className="timeline-title">Timeline</span>
          <span className="timeline-time">
            {timelineEvents.length > 0 && formatTime(timelineEvents[timelineEvents.length - 1].timestamp)}
          </span>
        </div>
        <div className="timeline-controls">
          <label className="auto-scroll-toggle">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          {wsConnected && <span className="websocket-indicator">🟢</span>}
        </div>
      </div>
      
      <div 
        className="timeline-content" 
        ref={timelineRef}
        onScroll={handleScroll}
      >
        <div className="timeline-lanes">
          <div className="timeline-lane user-lane">
            <div className="lane-label">User</div>
            <div className="lane-events">
              {userEvents.map(event => (
                <div
                  key={event.id}
                  className={`timeline-event ${event.selected ? 'selected' : ''}`}
                  style={{ left: `${getEventPosition(event)}%` }}
                  onClick={() => handleEventClick(event)}
                  title={`${event.type} - ${formatTime(event.timestamp)}`}
                >
                  <span className="event-icon">
                    {event.icon}
                    {event.count && event.count > 1 && <span className="event-count">x{event.count}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
          
          <div className="timeline-lane system-lane">
            <div className="lane-label">System</div>
            <div className="lane-events">
              {systemEvents.map(event => (
                <div
                  key={event.id}
                  className={`timeline-event ${event.selected ? 'selected' : ''}`}
                  style={{ left: `${getEventPosition(event)}%` }}
                  onClick={() => handleEventClick(event)}
                  title={`${event.type} - ${formatTime(event.timestamp)}`}
                >
                  <span className="event-icon">
                    {event.icon}
                    {event.count && event.count > 1 && <span className="event-count">x{event.count}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        
        <div className="timeline-axis">
          {timelineEvents.length > 0 && (
            <>
              <div className="time-marker start" style={{ left: '0%' }}>
                {formatTime(timelineEvents[0].timestamp)}
              </div>
              <div className="time-marker middle" style={{ left: '50%' }}>
                {formatTime(new Date((timelineEvents[0].timestamp.getTime() + timelineEvents[timelineEvents.length - 1].timestamp.getTime()) / 2))}
              </div>
              <div className="time-marker end" style={{ left: '100%' }}>
                {formatTime(timelineEvents[timelineEvents.length - 1].timestamp)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};