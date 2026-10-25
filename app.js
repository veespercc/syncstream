/**
 * SyncStream Client Core
 */

const BACKEND_HOST = "syncstream-backend-6x4q.onrender.com";

const STATE = {
  nickname: "",
  roomId: "",
  userId: "",
  isHost: false,
  ws: null,
  reconnectAttempts: 0,
  pingInterval: null,
  activePlayerType: null,
  ytPlayer: null,
  ytReady: false,
  isApplyingRemote: false,
  driftThreshold: 1.5,
  hostOnlyControl: false,
  rtt: 0,
};

// DOM References
const elLobby = document.getElementById("view-lobby");
const elRoom = document.getElementById("view-room");
const inputNickname = document.getElementById("input-nickname");
const btnDice = document.getElementById("btn-dice");
const btnCreateRoom = document.getElementById("btn-create-room");
const inputRoomId = document.getElementById("input-room-id");
const btnJoinRoom = document.getElementById("btn-join-room");

const labelRoomId = document.getElementById("label-room-id");
const labelPing = document.getElementById("label-ping");
const syncStatusIndicator = document.getElementById("sync-status-indicator");
const btnCopyLink = document.getElementById("btn-copy-link");
const btnOpenSource = document.getElementById("btn-open-source");
const btnPlaceholderAdd = document.getElementById("btn-placeholder-add");

const nativeVideo = document.getElementById("native-video");
const ytContainer = document.getElementById("youtube-player");
const playerPlaceholder = document.getElementById("player-placeholder");

const btnPlayPause = document.getElementById("btn-play-pause");
const iconPlay = document.getElementById("icon-play");
const iconPause = document.getElementById("icon-pause");
const timelineRange = document.getElementById("timeline-range");
const timecode = document.getElementById("timecode");
const btnFullscreen = document.getElementById("btn-fullscreen");

const tabChat = document.getElementById("tab-chat");
const tabUsers = document.getElementById("tab-users");
const paneChat = document.getElementById("pane-chat");
const paneUsers = document.getElementById("pane-users");
const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const userList = document.getElementById("user-list");
const userCount = document.getElementById("user-count");
const checkHostOnly = document.getElementById("check-host-only");

const dialogSource = document.getElementById("dialog-source");
const inputVideoUrl = document.getElementById("input-video-url");
const btnDialogCancel = document.getElementById("btn-dialog-cancel");
const btnDialogConfirm = document.getElementById("btn-dialog-confirm");
const btnCloseDialog = document.getElementById("btn-close-dialog");

const btnToggleChatMode = document.getElementById("btn-toggle-chat-mode");
const interactivePanel = document.getElementById("interactive-panel");

window.addEventListener("DOMContentLoaded", () => {
  initNickname();
  initRouting();
  setupUIEvents();
  initNativeVideoEvents();
});

window.addEventListener("hashchange", () => {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash && hash !== STATE.roomId) {
    enterRoom(hash);
  }
});

window.onYouTubeIframeAPIReady = () => {
  STATE.ytReady = true;
};

/* ================= 1. ИДЕНТИФИКАЦИЯ И РОУТИНГ ================= */

function getRandomNickname() {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `User_${num}`;
}

function initNickname() {
  const saved = localStorage.getItem("syncstream_nick");
  STATE.nickname = saved || getRandomNickname();
  inputNickname.value = STATE.nickname;
}

btnDice.addEventListener("click", () => {
  STATE.nickname = getRandomNickname();
  inputNickname.value = STATE.nickname;
  localStorage.setItem("syncstream_nick", STATE.nickname);
});

inputNickname.addEventListener("change", () => {
  const val = inputNickname.value.trim();
  STATE.nickname = val || getRandomNickname();
  inputNickname.value = STATE.nickname;
  localStorage.setItem("syncstream_nick", STATE.nickname);
});

function initRouting() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash.length > 2) {
    enterRoom(hash);
  }
}

btnCreateRoom.addEventListener("click", () => {
  const newRoomId = `room-${Math.random().toString(36).substring(2, 7)}`;
  enterRoom(newRoomId);
});

btnJoinRoom.addEventListener("click", () => {
  const rid = inputRoomId.value.trim();
  if (rid) {
    enterRoom(rid);
  } else {
    showToast("Введите код комнаты (например: room-xyz)");
    inputRoomId.focus();
  }
});

function enterRoom(roomId) {
  STATE.roomId = roomId;

  if (window.location.hash !== `#${roomId}`) {
    window.location.hash = `#${roomId}`;
  }

  // Принудительное переключение экранов
  elLobby.setAttribute("hidden", "");
  elRoom.removeAttribute("hidden");
  labelRoomId.textContent = roomId.toUpperCase();

  connectWebSocket(roomId);
}

/* ================= 2. WEBSOCKET SYNC ENGINE ================= */

function connectWebSocket(roomId) {
  if (STATE.ws) {
    STATE.ws.onclose = null;
    STATE.ws.close();
  }

  const isLocal = BACKEND_HOST.includes("localhost") || BACKEND_HOST.includes("127.0.0.1");
  const protocol = isLocal ? "ws:" : "wss:";
  const wsUrl = `${protocol}//${BACKEND_HOST}/ws/${roomId}`;

  updateSyncIndicator("syncing");
  labelPing.textContent = "Connecting...";

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

function scheduleReconnect() {
  STATE.reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(1.5, STATE.reconnectAttempts), 10000);
  labelPing.textContent = "Reconnecting...";
  setTimeout(() => {
    if (!elRoom.hasAttribute("hidden")) {
      connectWebSocket(STATE.roomId);
    }
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  STATE.pingInterval = setInterval(() => {
    if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
      STATE.ws.send(JSON.stringify({ type: "PING", time: performance.now() }));
    }
  }, 3000);
}

function stopHeartbeat() {
  if (STATE.pingInterval) clearInterval(STATE.pingInterval);
}

function handleServerEvent(msg) {
  switch (msg.type) {
    case "PONG": {
      const rtt = Math.round(performance.now() - msg.clientPingTime);
      STATE.rtt = rtt;
      labelPing.textContent = `${rtt} ms`;
      break;
    }
    case "USER_JOINED":
    case "USER_LEFT":
      renderUsers(msg.room);
      break;
    case "SOURCE_CHANGED":
      applySource(msg.room.videoType, msg.room.videoUrl);
      break;
    case "SYNC_EVENT":
      handleSyncAction(msg);
      break;
    case "HOST_CONTROL_TOGGLED":
      STATE.hostOnlyControl = msg.hostOnlyControl;
      checkHostOnly.checked = STATE.hostOnlyControl;
      break;
    case "NEW_MESSAGE":
      renderChatMessage(msg);
      break;
  }
}

function sendSyncAction(action, time) {
  if (STATE.isApplyingRemote) return;
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: "SYNC_ACTION",
      action: action,
      time: time
    }));
  }
}

function handleSyncAction(payload) {
  const { action, room } = payload;
  const targetTime = room.currentTime;

  STATE.isApplyingRemote = true;

  const currentLocalTime = getActivePlayerCurrentTime();
  const timeDiff = Math.abs(currentLocalTime - targetTime);

  if (timeDiff > STATE.driftThreshold || action === "SEEK") {
    seekActivePlayer(targetTime);
  }

  if (action === "PLAY") {
    playActivePlayer();
    setPlayPauseIcon(true);
  } else if (action === "PAUSE") {
    pauseActivePlayer();
    setPlayPauseIcon(false);
  }

  setTimeout(() => {
    STATE.isApplyingRemote = false;
  }, 100);
}

function updateSyncIndicator(status) {
  syncStatusIndicator.className = "status-indicator " + status;
}

/* ================= 3. МЕДИАПЛЕЕРЫ ================= */

function applySource(type, url) {
  if (!url) return;

  playerPlaceholder.style.display = "none";
  destroyPlayers();

  if (type === "youtube") {
    STATE.activePlayerType = "youtube";
    ytContainer.classList.add("active");
    nativeVideo.classList.remove("active");
    loadYouTubeVideo(extractYouTubeId(url));
  } else {
    STATE.activePlayerType = "native";
    nativeVideo.classList.add("active");
    ytContainer.classList.remove("active");
    nativeVideo.src = url;
    nativeVideo.load();
  }
}

function extractYouTubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
  return match ? match[1] : url;
}

function loadYouTubeVideo(videoId) {
  if (!STATE.ytReady) {
    setTimeout(() => loadYouTubeVideo(videoId), 200);
    return;
  }

  STATE.ytPlayer = new YT.Player("youtube-player", {
    videoId: videoId,
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
    },
    events: {
      onStateChange: (event) => {
        if (STATE.isApplyingRemote) return;
        if (event.data === YT.PlayerState.PLAYING) {
          sendSyncAction("PLAY", STATE.ytPlayer.getCurrentTime());
          setPlayPauseIcon(true);
        } else if (event.data === YT.PlayerState.PAUSED) {
          sendSyncAction("PAUSE", STATE.ytPlayer.getCurrentTime());
          setPlayPauseIcon(false);
        }
      }
    }
  });
}

function destroyPlayers() {
  if (STATE.ytPlayer && typeof STATE.ytPlayer.destroy === "function") {
    STATE.ytPlayer.destroy();
    STATE.ytPlayer = null;
  }
  nativeVideo.pause();
  nativeVideo.removeAttribute("src");
  nativeVideo.load();
  STATE.activePlayerType = null;
}

function initNativeVideoEvents() {
  nativeVideo.addEventListener("play", () => {
    if (!STATE.isApplyingRemote) {
      sendSyncAction("PLAY", nativeVideo.currentTime);
      setPlayPauseIcon(true);
    }
  });

  nativeVideo.addEventListener("pause", () => {
    if (!STATE.isApplyingRemote) {
      sendSyncAction("PAUSE", nativeVideo.currentTime);
      setPlayPauseIcon(false);
    }
  });

  nativeVideo.addEventListener("timeupdate", updateTimelineProgress);
  setInterval(updateTimelineProgress, 500);
}

function getActivePlayerCurrentTime() {
  if (STATE.activePlayerType === "native") {
    return nativeVideo.currentTime || 0;
  }
  if (STATE.activePlayerType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.getCurrentTime) {
    return STATE.ytPlayer.getCurrentTime() || 0;
  }
  return 0;
}

function getActivePlayerDuration() {
  if (STATE.activePlayerType === "native") {
    return nativeVideo.duration || 0;
  }
  if (STATE.activePlayerType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.getDuration) {
    return STATE.ytPlayer.getDuration() || 0;
  }
  return 0;
}

function seekActivePlayer(seconds) {
  if (STATE.activePlayerType === "native") {
    nativeVideo.currentTime = seconds;
  } else if (STATE.activePlayerType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.seekTo) {
    STATE.ytPlayer.seekTo(seconds, true);
  }
}

function playActivePlayer() {
  if (STATE.activePlayerType === "native") {
    nativeVideo.play().catch(() => {});
  } else if (STATE.activePlayerType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.playVideo) {
    STATE.ytPlayer.playVideo();
  }
}

function pauseActivePlayer() {
  if (STATE.activePlayerType === "native") {
    nativeVideo.pause();
  } else if (STATE.activePlayerType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.pauseVideo) {
    STATE.ytPlayer.pauseVideo();
  }
}

function setPlayPauseIcon(isPlaying) {
  iconPlay.hidden = isPlaying;
  iconPause.hidden = !isPlaying;
}

/* ================= 4. ТАЙМЛАЙН И КОНТРОЛЫ ================= */

function formatTime(totalSec) {
  if (isNaN(totalSec) || !isFinite(totalSec)) return "00:00";
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m < 10 ? "0" + m : m}:${s < 10 ? "0" + s : s}`;
}

function updateTimelineProgress() {
  const current = getActivePlayerCurrentTime();
  const dur = getActivePlayerDuration();

  timecode.textContent = `${formatTime(current)} / ${formatTime(dur)}`;

  if (dur > 0) {
    timelineRange.value = (current / dur) * 100;
  } else {
    timelineRange.value = 0;
  }
}

timelineRange.addEventListener("input", () => {
  const dur = getActivePlayerDuration();
  if (dur > 0) {
    const target = (timelineRange.value / 100) * dur;
    seekActivePlayer(target);
    sendSyncAction("SEEK", target);
  }
});

btnPlayPause.addEventListener("click", () => {
  const isPlaying = !iconPlay.hidden;
  if (isPlaying) {
    playActivePlayer();
    sendSyncAction("PLAY", getActivePlayerCurrentTime());
  } else {
    pauseActivePlayer();
    sendSyncAction("PAUSE", getActivePlayerCurrentTime());
  }
});

btnFullscreen.addEventListener("click", () => {
  const wrapper = document.getElementById("player-wrapper");
  if (!document.fullscreenElement) {
    wrapper.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

/* ================= 5. ЧАТ ================= */

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

chatForm.addEventListener("submit", () => {
  const val = chatInput.value.trim();
  if (!val || !STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;

  STATE.ws.send(JSON.stringify({
    type: "CHAT_MESSAGE",
    text: val
  }));

  chatInput.value = "";
});

function renderChatMessage(msg) {
  const isSelf = msg.senderNick === STATE.nickname;
  const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const msgDiv = document.createElement("div");
  msgDiv.className = "chat-msg";
  msgDiv.innerHTML = `
    <div class="msg-header">
      <span class="msg-author ${isSelf ? "is-self" : ""}">${escapeHtml(msg.senderNick)}</span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-body">${escapeHtml(msg.text)}</div>
  `;

  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/* ================= 6. УЧАСТНИКИ ================= */

function renderUsers(room) {
  userCount.textContent = room.clientCount;
  userList.innerHTML = "";

  const selfId = room.users.find(u => u.nickname === STATE.nickname)?.id;
  STATE.isHost = (selfId === room.hostId);

  checkHostOnly.disabled = !STATE.isHost;

  room.users.forEach(user => {
    const li = document.createElement("li");
    li.className = "user-item";
    li.innerHTML = `
      <span>${escapeHtml(user.nickname)}</span>
      ${user.isHost ? '<span class="badge-host">Host</span>' : ""}
    `;
    userList.appendChild(li);
  });
}

checkHostOnly.addEventListener("change", () => {
  if (STATE.isHost && STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: "SET_HOST_ONLY",
      enabled: checkHostOnly.checked
    }));
  }
});

/* ================= 7. ИСТОЧНИК ВИДЕО ================= */

function openSourceDialog() {
  dialogSource.showModal();
  inputVideoUrl.focus();
}

btnOpenSource.addEventListener("click", openSourceDialog);
btnPlaceholderAdd.addEventListener("click", openSourceDialog);

btnCloseDialog.addEventListener("click", () => dialogSource.close());
btnDialogCancel.addEventListener("click", () => dialogSource.close());

btnDialogConfirm.addEventListener("click", () => {
  const url = inputVideoUrl.value.trim();
  if (!url) return;

  const isYt = /youtu\.?be/.test(url);
  const type = isYt ? "youtube" : "direct";

  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: "LOAD_SOURCE",
      videoType: type,
      videoUrl: url
    }));
  }

  dialogSource.close();
  inputVideoUrl.value = "";
});

/* ================= 8. ТАБЫ И ШАРИНГ ================= */

tabChat.addEventListener("click", () => {
  tabChat.classList.add("active");
  tabUsers.classList.remove("active");
  paneChat.removeAttribute("hidden");
  paneUsers.setAttribute("hidden", "");
});

tabUsers.addEventListener("click", () => {
  tabUsers.classList.add("active");
  tabChat.classList.remove("active");
  paneUsers.removeAttribute("hidden");
  paneChat.setAttribute("hidden", "");
});

btnCopyLink.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast("Ссылка скопирована в буфер");
  } catch (err) {
    showToast("Ошибка копирования ссылки");
  }
});

btnToggleChatMode.addEventListener("click", () => {
  interactivePanel.classList.toggle("open");
});

function showToast(text) {
  const container = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  container.appendChild(t);
  setTimeout(() => {
    t.remove();
  }, 2500);
}

function setupUIEvents() {
  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) {
      interactivePanel.classList.remove("open");
    }
  });
}