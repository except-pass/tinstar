"""
Standalone server for the Tinstar events system.
"""
import uvicorn
from .api import create_events_app


def run_events_server(host: str = "0.0.0.0", port: int = 8000, debug: bool = False):
    """Run the events server."""
    app = create_events_app()
    uvicorn.run(app, host=host, port=port, debug=debug)


if __name__ == "__main__":
    run_events_server(debug=True)