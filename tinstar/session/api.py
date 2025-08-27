"""
HTTP API endpoints for the Tinstar session management system.
"""
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import ValidationError

from .models import (
    Session,
    SessionCreateRequest,
    SessionEditorRequest,
    SessionPeekRequest,
    SessionRespondRequest,
    SessionResponse,
    SessionSendRequest
)
from .service import SessionService

router = APIRouter(prefix="/api/sessions", tags=["sessions"])




@router.get("", response_model=SessionResponse)
async def list_sessions(project: Optional[str] = Query(None, description="Filter by project name")):
    """List all active sessions."""
    try:
        service = SessionService()
        sessions = service.list_sessions(project=project)
        return SessionResponse(
            success=True,
            sessions=sessions
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("", response_model=SessionResponse)
async def create_session(request: SessionCreateRequest):
    """Create a new session."""
    try:
        service = SessionService()
        session = await service.create_session(
            project=request.project,
            initial_prompt=request.initial_prompt,
            agent_type=request.agent_type or "claude"
        )
        return SessionResponse(
            success=True,
            message=f"Session '{session.name}' created successfully",
            session=session
        )
    except ValueError as e:
        if "not found" in str(e).lower():
            raise HTTPException(status_code=404, detail=str(e))
        elif "already exists" in str(e).lower():
            raise HTTPException(status_code=409, detail=str(e))
        else:
            raise HTTPException(status_code=400, detail=str(e))
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"Validation error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(session_id: str):
    """Get session details by ID."""
    try:
        service = SessionService()
        session = service.get_session(session_id)
        
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        
        return SessionResponse(
            success=True,
            session=session
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.delete("/{session_id}", response_model=SessionResponse)
async def terminate_session(session_id: str):
    """Terminate a session and cleanup resources."""
    try:
        service = SessionService()
        success, worktree_error = await service.terminate_session(session_id)
        if success:
            msg = "Session terminated successfully"
            if worktree_error:
                msg += f" (worktree cleanup error: {worktree_error})"
            return SessionResponse(success=True, message=msg)
        else:
            raise HTTPException(status_code=404, detail="Session not found")
            
    except HTTPException:
        raise
    except ValueError as e:
        # Surface worktree/session errors directly to client
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Bubble up worktree removal errors
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.get("/{session_id}/peek")
async def peek_session(
    session_id: str,
    lines: int = Query(50, ge=1, le=1000, description="Number of lines to return")
):
    """Get recent terminal output from session."""
    try:
        service = SessionService()
        # First, verify the session exists
        session = service.get_session(session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        # Then attempt to capture output
        peek_result = await service.peek_session(session_id, lines)

        # If no output available yet, return an empty peek payload instead of 404
        if not peek_result:
            empty_peek = {
                "session_id": session_id,
                "lines": [],
                "timestamp": datetime.now().isoformat(),
                "line_count": 0
            }
            return {"peek": empty_peek}

        return {"peek": peek_result}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("/{session_id}/send", response_model=SessionResponse)
async def send_to_session(session_id: str, request: SessionSendRequest):
    """Send text input to session terminal."""
    try:
        service = SessionService()
        success = await service.send_to_session(session_id, request.text)
        
        if success:
            return SessionResponse(
                success=True,
                message="Text sent successfully"
            )
        else:
            raise HTTPException(status_code=404, detail="Session not found")
            
    except HTTPException:
        raise
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"Validation error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("/{session_id}/editor")
async def open_in_editor(session_id: str, request: SessionEditorRequest):
    """Open file in configured editor."""
    try:
        service = SessionService()
        success = await service.open_in_editor(
            session_id,
            request.file_path,
            request.line_number
        )
        
        if success:
            # Get session to build command info
            session = service.get_session(session_id)
            if session:
                from .editors import EditorManager
                editor_manager = EditorManager()
                editor = editor_manager.get_editor(service.config.get("editor", "cursor"))
                command = editor.get_open_command(
                    session.worktree_path,
                    request.file_path,
                    request.line_number
                )
                
                return {
                    "success": True,
                    "command": command,
                    "message": "File opened successfully"
                }
            else:
                return {"success": True, "message": "File opened successfully"}
        else:
            raise HTTPException(status_code=404, detail="Session not found or file could not be opened")
            
    except HTTPException:
        raise
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"Validation error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("/{session_id}/respond")
async def respond_to_notification(session_id: str, request: SessionRespondRequest):
    """Respond to agent notification."""
    try:
        service = SessionService()
        success = await service.respond_to_notification(session_id, request.response)
        
        return {
            "success": success,
            "delivered": success,
            "message": "Response delivered successfully" if success else "Failed to deliver response"
        }
        
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"Validation error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.get("/{session_id}/health")
async def check_session_health(session_id: str):
    """Check session and agent health."""
    try:
        service = SessionService()
        healthy = await service.health_check(session_id)
        
        return {
            "session_id": session_id,
            "healthy": healthy,
            "status": "healthy" if healthy else "unhealthy"
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("/{session_id}/merge")
async def create_merge_session(session_id: str):
    """Create a new tmux session in project dir to merge the worktree."""
    try:
        service = SessionService()
        session = service.get_session(session_id)
        
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        
        # Get project service to get project path
        from ..projects.service import ProjectService
        project_service = ProjectService()
        project = project_service.get_project(session.project)
        
        if not project:
            raise HTTPException(status_code=404, detail=f"Project '{session.project}' not found")
        
        # Create unique tmux session name for merge
        merge_session_name = f"merge-{session.project}-{session_id[:8]}"
        
        # Get worktree branch name - it's prefixed with 'worktree/'
        worktree_branch = f"worktree/{session.worktree_name}"
        
        import subprocess
        
        # Run the merge directly and capture output, then clean up
        merge_cmd = ["git", "merge", worktree_branch]
        
        # Run merge in project directory
        merge_result = subprocess.run(
            merge_cmd, 
            cwd=project.path,
            capture_output=True, 
            text=True
        )
        
        if merge_result.returncode == 0:
            return {
                "success": True,
                "message": f"Successfully merged worktree '{worktree_branch}' into main branch",
                "details": merge_result.stdout,
                "command": f"git merge {worktree_branch}"
            }
        else:
            raise HTTPException(
                status_code=400, 
                detail=f"Merge failed: {merge_result.stderr or merge_result.stdout}"
            )
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


# Health check for the sessions API
@router.get("/health")
async def health_check():
    """Sessions API health check."""
    return {"status": "healthy", "service": "sessions"}