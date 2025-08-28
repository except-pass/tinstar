import React, { useState, useEffect } from 'react';
import { Session, SessionStatus, EventStatus } from './types';
import { getSessionStatus, getStatusIcon, getStatusEmoji } from './utils';
import { useEvents } from './hooks/useEvents';

interface SmallAgentWidgetProps {
  session: Session;
  onAgentClick?: (sessionId: string) => void;
  isSelected?: boolean;
}

export const SmallAgentWidget: React.FC<SmallAgentWidgetProps> = ({
  session,
  onAgentClick,
  isSelected = false,
}) => {
  const { getEventStatus } = useEvents();
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>({
    id: session.id,
    needsAttention: false,
    statusText: 'Loading...',
    statusColor: 'gray'
  });

  // Update status based on events
  useEffect(() => {
    const updateStatus = async () => {
      try {
        // Prefer terminal name for accuracy when available
        const termName = (session as any).name || '';
        const eventStatus: EventStatus = await getEventStatus(termName || session.id, !!termName);
        const status = getSessionStatus(session, eventStatus);
        setSessionStatus(status);
      } catch (err) {
        // When we can't get event status, show "No data" instead of fallback
        const status = getSessionStatus(session, null);
        setSessionStatus(status);
      }
    };

    updateStatus();
  }, [session.id, session.last_activity, getEventStatus]);

  const handleAgentClick = () => {
    if (onAgentClick) {
      onAgentClick(session.id);
    }
  };

  const statusEmoji = getStatusEmoji(sessionStatus.statusColor);

  return (
    <div className={`small-agent-widget ${isSelected ? 'selected' : ''}`} data-testid={`agent-${session.id}`}>
      <div 
        className="agent-info"
        onClick={handleAgentClick}
        title={`${session.name} - Last activity: ${new Date(session.last_activity).toLocaleString()}`}
      >
        <div className="agent-header">
          <span className="agent-name">{session.name}</span>
        </div>
        <div className="status-indicator">
          <span className="status-emoji">{statusEmoji}</span>
          <span className="status-text">{sessionStatus.statusText}</span>
        </div>
      </div>
    </div>
  );
};