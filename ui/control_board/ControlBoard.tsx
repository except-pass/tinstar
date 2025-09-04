import React, { useState, useRef, useCallback } from 'react';
import './ControlBoard.css';

interface ControlBoardProps {
  sessionId: string;
  session?: {
    id: string;
    name: string;
    project: string;
    status?: string;
  } | null;
  onSaveChanges?: () => void;
  onMergeWorktree?: () => void;
  onTerminate?: () => void;
}

interface ControlBoardError {
  message: string;
  timestamp: number;
}

export const ControlBoard: React.FC<ControlBoardProps> = ({ 
  sessionId, 
  session, 
  onSaveChanges, 
  onMergeWorktree, 
  onTerminate 
}) => {
  const [error, setError] = useState<ControlBoardError | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const controlBoardRef = useRef<HTMLDivElement>(null);

  const showError = (message: string) => {
    setError({ message, timestamp: Date.now() });
    setTimeout(() => {
      setError(prev => prev && prev.timestamp <= Date.now() ? null : prev);
    }, 5000);
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
      showError('Use a terminal in your IDE and type `tinstar session attach <session id>`.  The session id can be either the name or the first few characters of the "Selected Agent" UUID.');
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

  // Resize handling (both horizontal and vertical)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!controlBoardRef.current) return;

    e.preventDefault();
    e.stopPropagation();
    
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = controlBoardRef.current.offsetWidth;
    const startHeight = controlBoardRef.current.offsetHeight;
    
    setIsResizing(true);
    document.body.style.cursor = 'nw-resize';
    document.body.style.userSelect = 'none';
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!controlBoardRef.current) return;
      
      // Adjust both width and height
      const newWidth = startWidth + (e.clientX - startX);
      const newHeight = startHeight + (e.clientY - startY);
      
      // Set minimum and maximum dimensions
      const minWidth = 220; // enough for 4 notification buttons
      const maxWidth = 500;
      const minHeight = 250; // enough to show all content
      const maxHeight = 1400; // allow tall board
      
      const constrainedWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));
      const constrainedHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));
      
      controlBoardRef.current.style.width = `${constrainedWidth}px`;
      controlBoardRef.current.style.height = `${constrainedHeight}px`;
    };
    
    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
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
        <div className="control-board-actions">
          <div className="control-board-primary-actions">
            <button 
              className="control-button pause-button" 
              onClick={handlePause}
              title="Send escape key (Ctrl+C equivalent) to pause the currently running agent command"
            >
              ⏸️ Pause
            </button>
            
            <button 
              className="control-button save-button" 
              onClick={onSaveChanges}
              disabled={!session || !onSaveChanges}
              title="Create a git commit with all staged and unstaged files in the current worktree"
            >
              💾 Save
            </button>
            
            <button 
              className="control-button merge-button" 
              onClick={onMergeWorktree}
              disabled={!session || !onMergeWorktree}
              title="Merge the current worktree changes back to the main branch"
            >
              ↪️ Merge
            </button>
            
            <button 
              className="control-button terminate-button danger" 
              onClick={onTerminate}
              disabled={!session || !onTerminate}
              title="Terminate the current session and clean up resources"
            >
              ❌ Exit
            </button>
          </div>
          
          <div className="control-board-secondary-actions">
            <button 
              className="control-button attach-button" 
              onClick={handleAttach}
              title="Instructions for attaching to the tmux session directly via terminal"
            >
              🔗 Attach
            </button>
          </div>
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