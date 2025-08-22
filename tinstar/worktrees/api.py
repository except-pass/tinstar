"""
HTTP API endpoints for the Tinstar worktrees system.
"""
from typing import List

from fastapi import APIRouter, HTTPException, Query
from pydantic import ValidationError

from .models import (
    Worktree,
    WorktreeCreateRequest,
    WorktreeDeleteRequest,
    WorktreeListRequest,
    WorktreeResponse
)
from .service import WorktreeService

router = APIRouter(prefix="/api/worktrees", tags=["worktrees"])


@router.get("", response_model=WorktreeResponse)
async def list_worktrees(project: str = Query(..., description="Project name")):
    """List all worktrees for a project."""
    try:
        service = WorktreeService()
        worktrees = service.list_worktrees(project)
        return WorktreeResponse(
            success=True,
            worktrees=worktrees
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("", response_model=WorktreeResponse)
async def create_worktree(request: WorktreeCreateRequest):
    """Create a new worktree."""
    try:
        service = WorktreeService()
        worktree = service.create_worktree(request)
        return WorktreeResponse(
            success=True,
            message=f"Worktree '{request.name}' created successfully",
            worktree=worktree
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


@router.delete("/{name}", response_model=WorktreeResponse)
async def delete_worktree(
    name: str,
    project: str = Query(..., description="Project name"),
    force: bool = Query(False, description="Force deletion even with uncommitted changes")
):
    """Delete a worktree."""
    try:
        request = WorktreeDeleteRequest(project=project, name=name, force=force)
        service = WorktreeService()
        deleted = service.delete_worktree(request)
        
        if deleted:
            return WorktreeResponse(
                success=True,
                message=f"Worktree '{name}' deleted successfully"
            )
        else:
            raise HTTPException(status_code=404, detail="Worktree not found")
            
    except ValueError as e:
        if "not found" in str(e).lower():
            raise HTTPException(status_code=404, detail=str(e))
        elif "uncommitted changes" in str(e).lower():
            raise HTTPException(status_code=400, detail=str(e))
        else:
            raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # If git removal fails but database removal succeeds, still return success
        if "Git worktree removal failed" in str(e):
            return WorktreeResponse(
                success=True,
                message=f"Worktree '{name}' removed from database (git removal failed)"
            )
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")