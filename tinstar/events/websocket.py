"""
WebSocket manager for real-time event broadcasting.
"""
import json
import logging
from typing import Any, List

from fastapi import WebSocket
from pydantic import BaseModel

from .models import WebSocketMessage


logger = logging.getLogger(__name__)


class WebSocketManager:
    """Manages WebSocket connections for real-time event broadcasting."""
    
    def __init__(self):
        self.active_connections: List[WebSocket] = []
    
    async def connect(self, websocket: WebSocket):
        """Accept a new WebSocket connection."""
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket connected. Total connections: {len(self.active_connections)}")
    
    async def disconnect(self, websocket: WebSocket):
        """Remove a WebSocket connection."""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"WebSocket disconnected. Total connections: {len(self.active_connections)}")
    
    async def send_personal_message(self, message: str, websocket: WebSocket):
        """Send a message to a specific WebSocket."""
        try:
            await websocket.send_text(message)
        except Exception as e:
            logger.warning(f"Failed to send personal message: {e}")
            await self.disconnect(websocket)
    
    async def broadcast(self, event_type: str, data: Any):
        """Broadcast a message to all connected WebSockets."""
        if not self.active_connections:
            return
        
        try:
            # Create WebSocket message
            message = WebSocketMessage(type=event_type, data=data)
            message_text = message.model_dump_json()
            
            # Send to all connections
            disconnected = []
            for connection in self.active_connections:
                try:
                    await connection.send_text(message_text)
                except Exception as e:
                    logger.warning(f"Failed to send broadcast message: {e}")
                    disconnected.append(connection)
            
            # Remove disconnected clients
            for connection in disconnected:
                await self.disconnect(connection)
                
        except Exception as e:
            logger.error(f"Error during broadcast: {e}")
    
    def get_connection_count(self) -> int:
        """Get the number of active connections."""
        return len(self.active_connections)


# Global manager instance for reuse across modules
websocket_manager = WebSocketManager()