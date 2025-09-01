"""
HTTP API endpoints for the Tinstar events system.
"""
import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
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


def create_events_router(service: Optional[EventIngestionService] = None) -> APIRouter:
    """Factory function to create the events APIRouter."""
    router = APIRouter(prefix="/api/events", tags=["events"])
    ingestion_service = service or EventIngestionService()
    websocket_manager = WebSocketManager()
    
    # Register WebSocket callback
    ingestion_service.add_websocket_callback(websocket_manager.broadcast)
    
    # Event ingestion endpoints
    @router.post("/pre_tool_use", response_model=EventResponse)
    async def pre_tool_use(raw_data: Dict[str, Any]):
        """Handle PreToolUse hook events."""
        return ingestion_service.ingest_event(raw_data)
    
    @router.post("/post_tool_use", response_model=EventResponse)
    async def post_tool_use(raw_data: Dict[str, Any]):
        """Handle PostToolUse hook events."""
        return ingestion_service.ingest_event(raw_data)
    
    @router.post("/todowrite", response_model=EventResponse)
    async def todowrite(raw_data: Dict[str, Any]):
        """Handle TodoWrite tool events."""
        return ingestion_service.ingest_event(raw_data)
    
    @router.post("/notification", response_model=EventResponse)
    async def notification(raw_data: Dict[str, Any]):
        """Handle Notification hook events."""
        return ingestion_service.ingest_event(raw_data)
    
    @router.post("/stop", response_model=EventResponse)
    async def stop(raw_data: Dict[str, Any]):
        """Handle Stop hook events."""
        return ingestion_service.ingest_event(raw_data)
    
    @router.post("/subagent_stop", response_model=EventResponse)
    async def subagent_stop(raw_data: Dict[str, Any]):
        """Handle SubagentStop hook events."""
        return ingestion_service.ingest_event(raw_data)
    
    @router.post("/user_prompt", response_model=EventResponse)
    async def user_prompt(raw_data: Dict[str, Any]):
        """Handle UserPrompt hook events."""
        return ingestion_service.ingest_event(raw_data)
    
    # Query endpoints
    @router.get("/todos")
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
            return ingestion_service.query_todos(filter_params)
        except ValidationError as e:
            raise HTTPException(status_code=422, detail=str(e))
    
    @router.get("/files")
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
            return ingestion_service.query_files(filter_params)
        except ValidationError as e:
            raise HTTPException(status_code=422, detail=str(e))
    
    @router.get("")
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
            return ingestion_service.query_events(filter_params)
        except ValidationError as e:
            raise HTTPException(status_code=422, detail=str(e))
    
    @router.post("/clear")
    async def clear_events():
        """Clear all events from database."""
        return ingestion_service.clear_events()
    
    # WebSocket endpoint
    @router.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        """WebSocket endpoint for real-time event streaming."""
        await websocket_manager.connect(websocket)
        try:
            while True:
                # Keep connection alive and handle any incoming messages
                data = await websocket.receive_text()
                # Echo back for connection testing
                await websocket.send_text(f"Echo: {data}")
        except WebSocketDisconnect:
            await websocket_manager.disconnect(websocket)
    
    # Transcript reading endpoint
    @router.get("/transcript")
    async def read_transcript(
        transcript_path: str = Query(..., description="Path to the transcript file"),
        timestamp: str = Query(..., description="Timestamp to find the corresponding prompt")
    ):
        """Read transcript content and extract prompt for a specific timestamp."""
        try:
            if not os.path.exists(transcript_path):
                raise HTTPException(status_code=404, detail="Transcript file not found")
            
            # Parse the target timestamp - handle various formats
            timestamp_clean = timestamp.replace('Z', '+00:00').replace(' ', '+')
            if not timestamp_clean.endswith('+00:00') and '+' not in timestamp_clean[-6:]:
                timestamp_clean += '+00:00'
            target_time = datetime.fromisoformat(timestamp_clean)
            
            # Read the transcript file and find the user prompt near the timestamp
            with open(transcript_path, 'r', encoding='utf-8') as f:
                found_prompt = None
                best_match_time_diff = float('inf')
                
                for line in f:
                    try:
                        entry = json.loads(line.strip())
                        
                        # Look for user type entries with message content
                        if entry.get('type') == 'user' and 'message' in entry:
                            entry_time = datetime.fromisoformat(entry['timestamp'].replace('Z', '+00:00'))
                            time_diff = abs((entry_time - target_time).total_seconds())
                            
                            # Find the closest user prompt to our target timestamp
                            if time_diff < best_match_time_diff:
                                best_match_time_diff = time_diff
                                message = entry['message']
                                
                                # Extract content from the message
                                if isinstance(message, dict) and 'content' in message:
                                    content = message['content']
                                    # If content is a string, use it directly
                                    if isinstance(content, str):
                                        found_prompt = content
                                    # If content is a list (like tool calls), try to find text content
                                    elif isinstance(content, list):
                                        for item in content:
                                            if isinstance(item, dict) and item.get('type') == 'text':
                                                found_prompt = item.get('text', '')
                                                break
                                elif isinstance(message, str):
                                    found_prompt = message
                                    
                    except (json.JSONDecodeError, KeyError, ValueError) as e:
                        # Skip malformed lines
                        continue
                
                if found_prompt:
                    return {"content": found_prompt, "time_diff_seconds": best_match_time_diff}
                else:
                    return {"content": None, "error": "No user prompt found near the specified timestamp"}
                    
        except Exception as e:
            logger.error(f"Error reading transcript {transcript_path}: {e}")
            raise HTTPException(status_code=500, detail=f"Error reading transcript: {str(e)}")

    # Health check
    @router.get("/health")
    async def health_check():
        """Health check endpoint."""
        return {"status": "healthy", "service": "tinstar-events"}
    
    return router