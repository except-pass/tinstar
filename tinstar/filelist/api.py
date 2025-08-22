"""HTTP API endpoints for filelist functionality."""

import json
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .service import FileListService, FileStats, DirectoryNode


router = APIRouter(prefix='/filelist', tags=['filelist'])


class FileTreeRequest(BaseModel):
    """Request model for file tree endpoint."""
    open_dirs: List[str]


class FileTreeResponse(BaseModel):
    """Response model for file tree endpoint."""
    tree: Dict[str, Any]


def serialize_node(node: DirectoryNode) -> Dict[str, Any]:
    """Serialize a DirectoryNode to JSON-compatible dict."""
    children = []
    for child in node.children:
        if isinstance(child, FileStats):
            children.append({
                'type': 'file',
                'path': child.path,
                'size': child.size,
                'modified': child.modified.isoformat(),
                'stats': child.stats
            })
        elif isinstance(child, DirectoryNode):
            children.append({
                'type': 'directory',
                **serialize_node(child)
            })
    
    return {
        'path': node.path,
        'children': children,
        'stats': node.stats
    }


@router.post('/{project_name}/tree')
def get_file_tree(project_name: str, request: FileTreeRequest) -> FileTreeResponse:
    """Get directory tree with file statistics.
    
    Args:
        project_name: Name of the project
        request: Request body containing open_dirs list
        
    Returns:
        Directory tree with statistics
        
    Raises:
        HTTPException: For various error conditions
    """
    try:
        # TODO: Get project path from projects database
        # For now, assume projects are stored in a known location
        # This would need to be integrated with the projects service
        project_path = Path(f"/tmp/test_projects/{project_name}")  # Placeholder
        
        if not project_path.exists():
            raise HTTPException(status_code=404, detail=f'Project not found: {project_name}')
        
        # Create service and get tree
        service = FileListService()
        tree = service.get_tree(project_path, request.open_dirs)
        
        # Serialize and return
        return FileTreeResponse(tree=serialize_node(tree))
        
    except ValueError as e:
        # Invalid paths or other validation errors
        raise HTTPException(status_code=400, detail=str(e))
    
    except FileNotFoundError as e:
        # Project path doesn't exist
        raise HTTPException(status_code=404, detail=str(e))
    
    except Exception as e:
        # Internal server error
        raise HTTPException(status_code=500, detail=f'Internal server error: {str(e)}')