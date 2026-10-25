import asyncio
import os
import time
import uuid
from typing import Dict, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="SyncStream Backend")

# Разрешаем запросы с любых источников (включая GitHub Pages)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ClientSession:
    def __init__(self, ws: WebSocket, nickname: str):
        self.ws = ws
        self.nickname = nickname
        self.client_id = str(uuid.uuid4())[:8]

class RoomState:
    def __init__(self, room_id: str, host_id: str):
        self.room_id = room_id
        self.host_id = host_id
        self.clients: Dict[str, ClientSession] = {}
        self.host_only_control: bool = False
        self.video_type: Optional[str] = None
        self.video_url: Optional[str] = None
        self.is_playing: bool = False
        self.current_time: float = 0.0
        self.last_updated_at: float = time.time()
        self.playback_rate: float = 1.0

    def get_calculated_time(self) -> float:
        if not self.is_playing:
            return self.current_time
        elapsed = time.time() - self.last_updated_at
        return self.current_time + (elapsed * self.playback_rate)

    def to_dict(self) -> dict:
        return {
            "roomId": self.room_id,
            "hostId": self.host_id,
            "hostOnlyControl": self.host_only_control,
            "videoType": self.video_type,
            "videoUrl": self.video_url,
            "isPlaying": self.is_playing,
            "currentTime": self.get_calculated_time(),
            "playbackRate": self.playback_rate,
            "serverTime": time.time(),
            "clientCount": len(self.clients),
            "users": [
                {"id": cid, "nickname": c.nickname, "isHost": cid == self.host_id}
                for cid, c in self.clients.items()
            ],
        }

class RoomHub:
    def __init__(self):
        self.rooms: Dict[str, RoomState] = {}
        self.lock = asyncio.Lock()

    async def get_or_create_room(self, room_id: str, first_client_id: str) -> RoomState:
        async with self.lock:
            if room_id not in self.rooms:
                self.rooms[room_id] = RoomState(room_id=room_id, host_id=first_client_id)
            return self.rooms[room_id]

    async def remove_client(self, room_id: str, client_id: str):
        async with self.lock:
            if room_id not in self.rooms:
                return
            room = self.rooms[room_id]
            room.clients.pop(client_id, None)
            if not room.clients:
                del self.rooms[room_id]
                return
            if room.host_id == client_id:
                room.host_id = next(iter(room.clients.keys()))

hub = RoomHub()

@app.get("/health")
async def health_check():
    return {"status": "ok", "rooms": len(hub.rooms)}

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await websocket.accept()
    try:
        init_payload = await websocket.receive_json()
        nickname = init_payload.get("nickname") or f"Guest_{str(uuid.uuid4())[:4]}"
    except Exception:
        await websocket.close()
        return

    temp_id = str(uuid.uuid4())[:8]
    room = await hub.get_or_create_room(room_id, temp_id)
    session = ClientSession(websocket, nickname)
    room.clients[session.client_id] = session

    await broadcast(room, {
        "type": "USER_JOINED",
        "userId": session.client_id,
        "nickname": session.nickname,
        "room": room.to_dict(),
    })

    try:
        while True:
            data = await websocket.receive_json()
            event_type = data.get("type")

            if event_type == "PING":
                await websocket.send_json({
                    "type": "PONG",
                    "clientPingTime": data.get("time"),
                    "serverTime": time.time()
                })
                continue

            can_control = (not room.host_only_control) or (room.host_id == session.client_id)

            if event_type == "LOAD_SOURCE" and can_control:
                room.video_type = data.get("videoType")
                room.video_url = data.get("videoUrl")
                room.current_time = 0.0
                room.is_playing = False
                room.last_updated_at = time.time()
                await broadcast(room, {"type": "SOURCE_CHANGED", "room": room.to_dict()})

            elif event_type == "SYNC_ACTION" and can_control:
                action = data.get("action")
                target_time = float(data.get("time", 0.0))
                room.current_time = target_time
                room.last_updated_at = time.time()

                if action == "PLAY":
                    room.is_playing = True
                elif action == "PAUSE":
                    room.is_playing = False

                await broadcast(room, {
                    "type": "SYNC_EVENT",
                    "action": action,
                    "initiatorId": session.client_id,
                    "room": room.to_dict(),
                })

            elif event_type == "SET_HOST_ONLY" and room.host_id == session.client_id:
                room.host_only_control = bool(data.get("enabled"))
                await broadcast(room, {
                    "type": "HOST_CONTROL_TOGGLED",
                    "hostOnlyControl": room.host_only_control,
                    "room": room.to_dict()
                })

            elif event_type == "CHAT_MESSAGE":
                raw_text = str(data.get("text", "")).strip()
                if raw_text:
                    await broadcast(room, {
                        "type": "NEW_MESSAGE",
                        "senderId": session.client_id,
                        "senderNick": session.nickname,
                        "text": raw_text[:500],
                        "timestamp": time.time(),
                    })

    except WebSocketDisconnect:
        await hub.remove_client(room_id, session.client_id)
        if room_id in hub.rooms:
            await broadcast(hub.rooms[room_id], {
                "type": "USER_LEFT",
                "userId": session.client_id,
                "nickname": session.nickname,
                "room": hub.rooms[room_id].to_dict(),
            })

async def broadcast(room: RoomState, message: dict):
    disconnected = []
    for client_id, session in list(room.clients.items()):
        try:
            await session.ws.send_json(message)
        except Exception:
            disconnected.append(client_id)
    for client_id in disconnected:
        await hub.remove_client(room.room_id, client_id)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port)