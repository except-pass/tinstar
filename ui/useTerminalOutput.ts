import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { eventBus } from './eventBus';

export const useTerminalOutput = (
  sessionId: string,
  containerRef: React.RefObject<HTMLDivElement>
) => {
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal();
    term.open(containerRef.current);
    termRef.current = term;
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, [containerRef]);

  useEffect(() => {
    eventBus.connect();
    const unsubData = eventBus.subscribe('terminal_data', (payload: any) => {
      if (payload.sessionId === sessionId && termRef.current) {
        const bytes = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
        termRef.current.write(bytes);
      }
    });
    const unsubClear = eventBus.subscribe('terminal_cleared', (payload: any) => {
      if (payload.sessionId === sessionId && termRef.current) {
        termRef.current.reset();
      }
    });
    return () => {
      unsubData();
      unsubClear();
    };
  }, [sessionId]);

  return termRef;
};
