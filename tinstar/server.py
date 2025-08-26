"""
Main server for the Tinstar system.
"""
import logging
import uvicorn
from fastapi import FastAPI

from .events.api import create_events_router
from .worktrees.api import router as worktrees_router
from .session.api import router as sessions_router
from .filelist.api import router as filelist_router
from .projects.api import router as projects_router
from .editor.api import router as editor_router


def create_tinstar_app() -> FastAPI:
    """Create the main Tinstar FastAPI application."""
    app = FastAPI(
        title="Tinstar API",
        version="1.0.0",
        description="Development environment management API"
    )
    
    # Include all routers
    events_router = create_events_router()
    app.include_router(events_router)
    app.include_router(worktrees_router)
    app.include_router(sessions_router)
    app.include_router(filelist_router)
    app.include_router(projects_router)
    app.include_router(editor_router)
    
    # Health check
    @app.get("/api/health")
    async def health_check():
        """Main health check endpoint."""
        return {"status": "healthy", "service": "tinstar"}
    
    return app


def run_server(host: str = None, port: int = None, debug: bool = False):
    """Run the main Tinstar server."""
    from .config import get_config
    
    # Configure logging
    if debug:
        logging.basicConfig(level=logging.DEBUG)
        logging.getLogger("tinstar").setLevel(logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)
    
    config = get_config()
    host = host or config.get_server_host()
    port = port or config.get_server_port()
    
    if debug:
        # Use import string for reload mode
        uvicorn.run("tinstar.server:create_tinstar_app", 
                   host=host, port=port, reload=True, factory=True, log_level="debug")
    else:
        # Use app object for production
        app = create_tinstar_app()
        uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run_server(debug=True)