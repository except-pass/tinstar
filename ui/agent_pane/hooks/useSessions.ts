import { useState, useEffect, useCallback } from 'react';
import { Session, SessionResponse, CreateSessionRequest } from '../types';

interface UseSessionsReturn {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  fetchSessions: () => Promise<void>;
  createSession: (request: CreateSessionRequest) => Promise<Session>;
  clearError: () => void;
}

export const useSessions = (): UseSessionsReturn => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch('/api/sessions');
      if (!response.ok) {
        throw new Error(`Failed to fetch sessions: ${response.statusText}`);
      }
      
      const data: SessionResponse = await response.json();
      if (data.success && data.sessions) {
        setSessions(data.sessions);
      } else {
        throw new Error(data.message || 'Failed to load sessions');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const createSession = useCallback(async (request: CreateSessionRequest): Promise<Session> => {
    try {
      setError(null);
      
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to create session');
      }
      
      const data: SessionResponse = await response.json();
      if (data.success && data.session) {
        // Add to local state
        setSessions(prev => [...prev, data.session!]);
        return data.session;
      } else {
        throw new Error(data.message || 'Failed to create session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
      throw err;
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Load sessions on mount
  useEffect(() => {
    fetchSessions().catch(() => {
      // Error is already set in fetchSessions
    });
  }, [fetchSessions]);

  return {
    sessions,
    loading,
    error,
    fetchSessions,
    createSession,
    clearError,
  };
};