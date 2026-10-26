import asyncio
import os
import time
import uuid
from typing import Dict, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="SyncStream Core")

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
        self.video_type: Optional[str] = None  # "hls" | "direct" | "youtube" | "iframe"
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
        nickname = str(init_payload.get("nickname", "")).strip() or f"User_{str(uuid.uuid4())[:4]}"
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
                    "serverTime": time.time(),
                })
                continue

            can_control = (not room.host_only_control) or (room.host_id == session.client_id)

            if event_type == "LOAD_SOURCE" and can_control:
                raw_url = data.get("videoUrl", "")
                
                # Если вставили ссылку на страницу киносайта (а не прямой файл или ютуб)
                if not any(x in raw_url for x in ["youtu.be", "youtube.com", ".m3u8", ".mp4", ".webm"]):
                    resolved = await resolve_kinosite_url(raw_url)
                    room.video_type = resolved["type"]
                    room.video_url = resolved["url"]
                else:
                    room.video_type = data.get("videoType")
                    room.video_url = raw_url

                room.current_time = 0.0
                room.is_playing = False
                room.last_updated_at = time.time()
                await broadcast(room, {"type": "SOURCE_CHANGED", "room": room.to_dict()})

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
                    "room": room.to_dict(),
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
    dead_clients = []
    for cid, session in list(room.clients.items()):
        try:
            await session.ws.send_json(message)
        except Exception:
            dead_clients.append(cid)
    for cid in dead_clients:
        await hub.remove_client(room.room_id, cid)

import re
import httpx
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
}

async def resolve_kinosite_url(page_url: str) -> dict:
    """
    Парсит страницу киносайта, извлекая embed-ссылку плеера или прямой .m3u8
    """
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers=HEADERS) as client:
            resp = await client.get(page_url)
            html = resp.text

            # 1. Поиск прямого m3u8 прямо в исходном коде
            m3u8_match = re.search(r'(https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*)', html)
            if m3u8_match:
                return {"type": "hls", "url": m3u8_match.group(1)}

            # 2. Поиск плеера внутри тегов <iframe>
            soup = BeautifulSoup(html, "html.parser")
            for iframe in soup.find_all("iframe"):
                src = iframe.get("src") or iframe.get("data-src") or ""
                if src:
                    if src.startswith("//"):
                        src = "https:" + src
                    # Балансеры: kodik, collaps, videocdn, alloha, voidboost, lumex и др.
                    if any(balancer in src for balancer in ["kodik", "collaps", "cdn", "alloha", "embed", "player"]):
                        return {"type": "iframe", "url": src}

    except Exception as e:
        print(f"Error resolving url {page_url}: {e}")

    # Если не удалось распознать, отдаем как обычный веб-фрейм
    return {"type": "iframe", "url": page_url}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port)