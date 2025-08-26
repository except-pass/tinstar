"""
HTTP API endpoints for the Tinstar editor system.
"""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from ..session.models import SessionEditorRequest
from ..session.editors import EditorManager
from ..config import get_config

router = APIRouter(prefix="/api/editor", tags=["editor"])


@router.post("/open")
async def open_file_in_editor(request: SessionEditorRequest):
    """Open file in configured editor without requiring a session."""
    try:
        config = get_config()
        editor_manager = EditorManager()
        editor_type = config.get("editor", "cursor")
        
        # For generic editor opening, we'll use the current working directory
        # or a default project directory
        import os
        worktree_path = os.getcwd()
        
        success = await editor_manager.open_file(
            editor_type,
            worktree_path,
            request.file_path,
            request.line_number
        )
        
        if success:
            editor = editor_manager.get_editor(editor_type)
            command = editor.get_open_command(
                worktree_path,
                request.file_path,
                request.line_number
            )
            
            return {
                "success": True,
                "command": command,
                "message": "File opened successfully"
            }
        else:
            raise HTTPException(status_code=500, detail="Failed to open file in editor")
            
    except HTTPException:
        raise
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"Validation error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")
