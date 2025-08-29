import { useState, useEffect, useCallback, useRef } from 'react';
import { Event, Commit } from './types';

interface UseTimelineEventsReturn {
  events: Event[];
  commits: Commit[];
  loading: boolean;
  error: string | null;
  wsConnected: boolean;
}

export const useTimelineEvents = (sessionId: string, sessionName?: string): UseTimelineEventsReturn => {
  const [events, setEvents] = useState<Event[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const websocketRef = useRef<WebSocket | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const query = sessionName
        ? `/api/events?tinstar_term_name=${encodeURIComponent(sessionName)}`
        : `/api/events?session_id=${encodeURIComponent(sessionId)}`;
      const response = await fetch(query);
      if (!response.ok) {
        throw new Error(`Failed to fetch events: ${response.statusText}`);
      }
      
      const eventsData: Event[] = await response.json();
      setEvents(eventsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch events');
    } finally {
      setLoading(false);
    }
  }, [sessionId, sessionName]);

  const fetchCommits = useCallback(async () => {
    try {
      const response = await fetch(`/api/worktrees/commits?session_id=${encodeURIComponent(sessionId)}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }
      
      const commitsData: Commit[] = await response.json();
      setCommits(commitsData);
    } catch (err) {
      console.warn('Failed to fetch commits:', err);
      setCommits([]);
    }
  }, [sessionId, sessionName]);

  const connectWebSocket = useCallback(() => {
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/events/ws`;
      
      websocketRef.current = new WebSocket(wsUrl);
      
      websocketRef.current.onopen = () => {
        console.log('Timeline WebSocket connected');
        setWsConnected(true);
        setError(null);
      };
      
      websocketRef.current.onmessage = (event) => {
        try {
          const newEvent = JSON.parse(event.data);
          if (sessionName ? newEvent.tinstar_term_name === sessionName : newEvent.session_id === sessionId) {
            setEvents(prev => [...prev, newEvent]);
          }
        } catch (err) {
          console.warn('Failed to parse WebSocket message:', err);
        }
      };
      
      websocketRef.current.onerror = (error) => {
        console.error('Timeline WebSocket error:', error);
        setWsConnected(false);
      };
      
      websocketRef.current.onclose = () => {
        console.log('Timeline WebSocket disconnected');
        setWsConnected(false);
      };
    } catch (err) {
      setError('Failed to connect to WebSocket');
      setWsConnected(false);
    }
  }, [sessionId, sessionName]);

  const disconnectWebSocket = useCallback(() => {
    if (websocketRef.current) {
      websocketRef.current.close();
      websocketRef.current = null;
      setWsConnected(false);
    }
  }, []);

  useEffect(() => {
    if (sessionId) {
      fetchEvents();
      fetchCommits();
      connectWebSocket();
    }
    
    return () => {
      disconnectWebSocket();
    };
  }, [sessionId, fetchEvents, fetchCommits, connectWebSocket, disconnectWebSocket]);

  return {
    events,
    commits,
    loading,
    error,
    wsConnected,
  };
};