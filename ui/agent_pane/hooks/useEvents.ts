import { useState, useCallback, useEffect, useRef } from 'react';
import { Event, EventStatus } from '../types';

interface UseEventsReturn {
  getEventStatus: (termNameOrSessionId: string, useTermName?: boolean) => Promise<EventStatus>;
  eventsLoading: boolean;
  eventsError: string | null;
  connectWebSocket: () => void;
  disconnectWebSocket: () => void;
  isWebSocketConnected: boolean;
}

export const useEvents = (onEventReceived?: (event: any) => void): UseEventsReturn => {
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
  const websocketRef = useRef<WebSocket | null>(null);

  const getEventStatus = useCallback(async (termNameOrSessionId: string, useTermName: boolean = true): Promise<EventStatus> => {
    try {
      setEventsLoading(true);
      setEventsError(null);
      
      const query = useTermName 
        ? `/api/events?tinstar_term_name=${encodeURIComponent(termNameOrSessionId)}`
        : `/api/events?session_id=${encodeURIComponent(termNameOrSessionId)}`;
      const response = await fetch(query);
      if (!response.ok) {
        throw new Error(`Failed to fetch events: ${response.statusText}`);
      }
      
      const events: Event[] = await response.json();
      // Events are returned ascending by timestamp; use the last item as most recent
      const hasNotifyEvent = events.some(e => e.hook_event_name === 'Notification');
      const hasStopEvent = events.some(e => e.hook_event_name === 'Stop');
      const lastEventTime = events.length > 0 ? new Date(events[events.length - 1].timestamp) : new Date(0);
      
      return { hasNotifyEvent, hasStopEvent, lastEventTime };
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : 'Failed to fetch events');
      throw err;
    } finally {
      setEventsLoading(false);
    }
  }, []);

  const connectWebSocket = useCallback(() => {
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/events/ws`;
      
      websocketRef.current = new WebSocket(wsUrl);
      
      websocketRef.current.onopen = () => {
        console.log('WebSocket connected to events stream');
        setIsWebSocketConnected(true);
        setEventsError(null);
      };
      
      websocketRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (onEventReceived) {
            onEventReceived(data);
          }
        } catch (err) {
          console.warn('Failed to parse WebSocket message:', err);
        }
      };
      
      websocketRef.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setEventsError('WebSocket connection error');
        setIsWebSocketConnected(false);
      };
      
      websocketRef.current.onclose = () => {
        console.log('WebSocket disconnected');
        setIsWebSocketConnected(false);
      };
    } catch (err) {
      setEventsError('Failed to connect to WebSocket');
      setIsWebSocketConnected(false);
    }
  }, [onEventReceived]);

  const disconnectWebSocket = useCallback(() => {
    if (websocketRef.current) {
      websocketRef.current.close();
      websocketRef.current = null;
      setIsWebSocketConnected(false);
    }
  }, []);

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      disconnectWebSocket();
    };
  }, [disconnectWebSocket]);

  return {
    getEventStatus,
    eventsLoading,
    eventsError,
    connectWebSocket,
    disconnectWebSocket,
    isWebSocketConnected,
  };
};