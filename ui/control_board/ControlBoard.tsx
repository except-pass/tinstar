import React, { useState, useRef, useCallback } from 'react';
import './ControlBoard.css';

interface ControlBoardProps {
  sessionId: string;
}

interface ControlBoardError {
  message: string;
  timestamp: number;
}

export const ControlBoard: React.FC<ControlBoardProps> = ({ sessionId }) => {
  const [error, setError] = useState<ControlBoardError | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const controlBoardRef = useRef<HTMLDivElement>(null);

  const showError = (message: string) => {
    setError({ message, timestamp: Date.now() });
    setTimeout(() => {
      setError(prev => prev && prev.timestamp <= Date.now() ? null : prev);
    }, 5000);
  };

  const handleStop = async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) {
        let message = 'Failed to stop session';
        try {
          const errorData = await res.json();
          message = errorData.detail || errorData.message || message;
        } catch {
          const txt = await res.text();
          if (txt) message = txt;
        }
        throw new Error(message);
      }
    } catch (err: any) {
      showError(err.message);
    }
  };

  const handlePause = async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '\x1b' }) // Escape key
      });
      if (!res.ok) {
        throw new Error('Failed to pause session');
      }
    } catch (err: any) {
      showError(err.message);
    }
  };

  const handleAttach = async () => {
    try {
      // Since attach requires tmux, we'll show instructions to the user
      showError('Use "tmux attach -t <session_name>" in terminal to attach to this session');
    } catch (err: any) {
      showError(err.message);
    }
  };

  const handleNotification = async (number: string) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: number })
      });
      if (!res.ok) {
        throw new Error(`Failed to send notification ${number}`);
      }
    } catch (err: any) {
      showError(err.message);
    }
  };

  // Resize handling
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!controlBoardRef.current) return;
    
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = controlBoardRef.current.offsetWidth;
    const startHeight = controlBoardRef.current.offsetHeight;
    
    setIsResizing(true);
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!controlBoardRef.current) return;
      
      const newWidth = startWidth + (e.clientX - startX);
      const newHeight = startHeight + (e.clientY - startY);
      
      // Set minimum dimensions
      const minWidth = 200;
      const minHeight = 120;
      
      controlBoardRef.current.style.width = `${Math.max(newWidth, minWidth)}px`;
      controlBoardRef.current.style.height = `${Math.max(newHeight, minHeight)}px`;
    };
    
    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  return (
    <div ref={controlBoardRef} className={`control-board ${isResizing ? 'resizing' : ''}`}>
      <div className="control-board-header">
        <h4>Session Controls</h4>
      </div>
      
      {error && (
        <div className="control-board-error">
          {error.message}
        </div>
      )}
      
      <div className="control-board-content">
        <div className="control-board-main-actions">
          <button 
            className="control-button stop-button" 
            onClick={handleStop}
            title="Stop the session"
          >
            Stop
          </button>
          
          <button 
            className="control-button pause-button" 
            onClick={handlePause}
            title="Send escape key to pause agent"
          >
            Pause
          </button>
          
          <button 
            className="control-button attach-button" 
            onClick={handleAttach}
            title="Attach to tmux session"
          >
            Attach
          </button>
        </div>
        
        <div className="control-board-notifications">
          <span className="notifications-label">Notifications:</span>
          <div className="notification-buttons">
            {['1', '2', '3', '4'].map(num => (
              <button
                key={num}
                className="control-button notification-button"
                onClick={() => handleNotification(num)}
                title={`Send notification response ${num}`}
              >
                {num}
              </button>
            ))}
          </div>
        </div>
      </div>
      
      <div 
        className="control-board-resize-handle"
        onMouseDown={handleMouseDown}
        title="Drag to resize"
      />
    </div>
  );
};

export default ControlBoard;