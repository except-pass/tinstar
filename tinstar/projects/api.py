"""HTTP API endpoints for projects functionality."""

from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from .models import (
    Project,
    CreateProjectRequest,
    UpdateProjectRequest,
    ProjectResponse
)
from .service import ProjectService, ProjectValidationError

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=ProjectResponse)
async def list_projects():
    """List all projects."""
    try:
        service = ProjectService()
        projects = service.list_projects()
        return ProjectResponse(
            success=True,
            projects=projects
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.get("/{name}", response_model=ProjectResponse)
async def get_project(name: str):
    """Get project by name."""
    try:
        service = ProjectService()
        project = service.get_project(name)
        
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        
        return ProjectResponse(
            success=True,
            project=project
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("", response_model=ProjectResponse)
async def create_project(request: CreateProjectRequest):
    """Create a new project."""
    try:
        service = ProjectService()
        project = service.create_project(request)
        return ProjectResponse(
            success=True,
            message=f"Project '{project.name}' created successfully",
            project=project
        )
    except ProjectValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"Validation error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.put("/{name}", response_model=ProjectResponse)
async def update_project(name: str, request: UpdateProjectRequest):
    """Update project settings."""
    try:
        service = ProjectService()
        project = service.update_project(name, request)
        
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        
        return ProjectResponse(
            success=True,
            message=f"Project '{name}' updated successfully",
            project=project
        )
    except ProjectValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"Validation error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.delete("/{name}", response_model=ProjectResponse)
async def delete_project(name: str):
    """Delete a project."""
    try:
        service = ProjectService()
        success = service.delete_project(name)
        
        if success:
            return ProjectResponse(
                success=True,
                message=f"Project '{name}' deleted successfully"
            )
        else:
            raise HTTPException(status_code=404, detail="Project not found")
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.get("/health")
async def health_check():
    """Projects API health check."""
    return {"status": "healthy", "service": "projects"}