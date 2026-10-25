// --- КОНФИГУРАЦИЯ БЭКЕНДА ---
// Локально: "localhost:8000"
// На Render: "ваш-сервис.onrender.com"
const BACKEND_HOST = "https://syncstream-backend-6x4q.onrender.com/"; 

// Замена функции initRouting на работу с hash:
function initRouting() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash.length > 2) {
    inputRoomId.value = hash;
    enterRoom(hash);
  }
}

// Замена функции enterRoom:
function enterRoom(roomId) {
  STATE.roomId = roomId;
  window.location.hash = `#${roomId}`;

  elLobby.hidden = true;
  elRoom.hidden = false;
  labelRoomId.textContent = roomId.toUpperCase();

  connectWebSocket(roomId);
}

// Замена connectWebSocket на работу с BACKEND_HOST:
function connectWebSocket(roomId) {
  const isLocal = BACKEND_HOST.includes("localhost") || BACKEND_HOST.includes("127.0.0.1");
  const protocol = isLocal ? "ws:" : "wss:";
  const wsUrl = `${protocol}//${BACKEND_HOST}/ws/${roomId}`;

  STATE.ws = new WebSocket(wsUrl);

  STATE.ws.onopen = () => {
    STATE.reconnectAttempts = 0;
    updateSyncIndicator("in-sync");
    STATE.ws.send(JSON.stringify({ nickname: STATE.nickname }));
    startHeartbeat();
  };

  STATE.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerEvent(msg);
    } catch (err) {
      console.error("WS Parse Error:", err);
    }
  };

  STATE.ws.onclose = () => {
    stopHeartbeat();
    updateSyncIndicator("error");
    scheduleReconnect();
  };

  STATE.ws.onerror = () => {
    STATE.ws.close();
  };
}
