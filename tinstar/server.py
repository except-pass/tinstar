"""
Main server for the Tinstar system.
"""
import uvicorn
from fastapi import FastAPI

from .events.api import create_events_app
from .worktrees.api import router as worktrees_router


def create_tinstar_app() -> FastAPI:
    """Create the main Tinstar FastAPI application."""
    app = FastAPI(
        title="Tinstar API",
        version="1.0.0",
        description="Development environment management API"
    )
    
    # Include events API
    events_app = create_events_app()
    app.mount("/events", events_app)
    
    # Include worktrees router
    app.include_router(worktrees_router)
    
    # Health check
    @app.get("/api/health")
    async def health_check():
        """Main health check endpoint."""
        return {"status": "healthy", "service": "tinstar"}
    
    return app


def run_server(host: str = "0.0.0.0", port: int = 8000, debug: bool = False):
    """Run the main Tinstar server."""
    app = create_tinstar_app()
    uvicorn.run(app, host=host, port=port, debug=debug)


if __name__ == "__main__":
    run_server(debug=True)