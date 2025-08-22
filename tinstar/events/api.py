"""
HTTP API endpoints for the Tinstar events system.
"""
import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .models import Event, EventFilter, EventResponse, WebSocketMessage
from .service import EventIngestionService
from .websocket import WebSocketManager


logger = logging.getLogger(__name__)


class EventsAPI:
    """FastAPI application for events HTTP endpoints."""
    
    def __init__(self, service: Optional[EventIngestionService] = None):
        self.service = service or EventIngestionService()
        self.websocket_manager = WebSocketManager()
        self.app = FastAPI(title="Tinstar Events API", version="1.0.0")
        
        # Register WebSocket callback
        self.service.add_websocket_callback(self.websocket_manager.broadcast)
        
        # Register routes
        self._register_routes()
    
    def _register_routes(self):
        """Register all API routes."""
        
        # Event ingestion endpoints
        @self.app.post("/api/events/pre_tool_use", response_model=EventResponse)
        async def pre_tool_use(raw_data: Dict[str, Any]):
            """Handle PreToolUse hook events."""
            return self.service.ingest_event(raw_data)
        
        @self.app.post("/api/events/post_tool_use", response_model=EventResponse)
        async def post_tool_use(raw_data: Dict[str, Any]):
            """Handle PostToolUse hook events."""
            return self.service.ingest_event(raw_data)
        
        @self.app.post("/api/events/todowrite", response_model=EventResponse)
        async def todowrite(raw_data: Dict[str, Any]):
            """Handle TodoWrite tool events."""
            return self.service.ingest_event(raw_data)
        
        @self.app.post("/api/events/notification", response_model=EventResponse)
        async def notification(raw_data: Dict[str, Any]):
            """Handle Notification hook events."""
            return self.service.ingest_event(raw_data)
        
        @self.app.post("/api/events/stop", response_model=EventResponse)
        async def stop(raw_data: Dict[str, Any]):
            """Handle Stop hook events."""
            return self.service.ingest_event(raw_data)
        
        @self.app.post("/api/events/subagent_stop", response_model=EventResponse)
        async def subagent_stop(raw_data: Dict[str, Any]):
            """Handle SubagentStop hook events."""
            return self.service.ingest_event(raw_data)
        
        @self.app.post("/api/events/user_prompt", response_model=EventResponse)
        async def user_prompt(raw_data: Dict[str, Any]):
            """Handle UserPrompt hook events."""
            return self.service.ingest_event(raw_data)
        
        # Query endpoints
        @self.app.get("/api/events/todos")
        async def get_todos(
            session_id: Optional[str] = Query(None),
            start_time: Optional[str] = Query(None),
            end_time: Optional[str] = Query(None),
            tinstar_term_name: Optional[str] = Query(None)
        ):
            """Query todo events with filtering."""
            try:
                filter_params = EventFilter(
                    session_id=session_id,
                    start_time=start_time,
                    end_time=end_time,
                    tinstar_term_name=tinstar_term_name
                )
                return self.service.query_todos(filter_params)
            except ValidationError as e:
                raise HTTPException(status_code=422, detail=str(e))
        
        @self.app.get("/api/events/files")
        async def get_files(
            session_id: Optional[str] = Query(None),
            start_time: Optional[str] = Query(None),
            end_time: Optional[str] = Query(None),
            tinstar_term_name: Optional[str] = Query(None)
        ):
            """Query file events with filtering."""
            try:
                filter_params = EventFilter(
                    session_id=session_id,
                    start_time=start_time,
                    end_time=end_time,
                    tinstar_term_name=tinstar_term_name
                )
                return self.service.query_files(filter_params)
            except ValidationError as e:
                raise HTTPException(status_code=422, detail=str(e))
        
        @self.app.get("/api/events")
        async def get_events(
            session_id: Optional[str] = Query(None),
            start_time: Optional[str] = Query(None),
            end_time: Optional[str] = Query(None),
            tinstar_term_name: Optional[str] = Query(None),
            type: Optional[str] = Query(None, alias="type")
        ):
            """Query events with filtering."""
            try:
                filter_params = EventFilter(
                    session_id=session_id,
                    start_time=start_time,
                    end_time=end_time,
                    tinstar_term_name=tinstar_term_name,
                    event_type=type
                )
                return self.service.query_events(filter_params)
            except ValidationError as e:
                raise HTTPException(status_code=422, detail=str(e))
        
        @self.app.post("/api/events/clear")
        async def clear_events():
            """Clear all events from database."""
            return self.service.clear_events()
        
        # WebSocket endpoint
        @self.app.websocket("/api/events/ws")
        async def websocket_endpoint(websocket: WebSocket):
            """WebSocket endpoint for real-time event streaming."""
            await self.websocket_manager.connect(websocket)
            try:
                while True:
                    # Keep connection alive and handle any incoming messages
                    data = await websocket.receive_text()
                    # Echo back for connection testing
                    await websocket.send_text(f"Echo: {data}")
            except WebSocketDisconnect:
                await self.websocket_manager.disconnect(websocket)
        
        # Health check
        @self.app.get("/api/events/health")
        async def health_check():
            """Health check endpoint."""
            return {"status": "healthy", "service": "tinstar-events"}


def create_events_app(service: Optional[EventIngestionService] = None) -> FastAPI:
    """Factory function to create the events FastAPI application."""
    api = EventsAPI(service)
    return api.app