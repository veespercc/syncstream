/**
 * SyncStream Frontend Engine
 * Universal Media Sync (HLS, HTML5 Video, YouTube, Embed)
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
  activeType: null, // "hls" | "direct" | "youtube" | "iframe" | null
  ytPlayer: null,
  ytReady: false,
  hlsInstance: null,
  isApplyingRemote: false,
  driftThreshold: 1.5,
  hostOnlyControl: false,
};

// DOM узлы
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
const btnEmptySelect = document.getElementById("btn-empty-select");

const nativeVideo = document.getElementById("native-video");
const ytContainer = document.getElementById("youtube-player");
const embedIframe = document.getElementById("embed-iframe");
const playerEmpty = document.getElementById("player-empty");

const btnPlayPause = document.getElementById("btn-play-pause");
const iconPlay = document.getElementById("icon-play");
const iconPause = document.getElementById("icon-pause");
const timelineSlider = document.getElementById("timeline-slider");
const timecode = document.getElementById("timecode");
const btnFullscreen = document.getElementById("btn-fullscreen");

const tabChat = document.getElementById("tab-chat");
const tabUsers = document.getElementById("tab-users");
const paneChat = document.getElementById("pane-chat");
const paneUsers = document.getElementById("pane-users");
const chatStream = document.getElementById("chat-stream");
const chatInputForm = document.getElementById("chat-input-form");
const chatMessageField = document.getElementById("chat-message-field");
const userDirectory = document.getElementById("user-directory");
const userCount = document.getElementById("user-count");
const checkHostLock = document.getElementById("check-host-lock");

const dialogSource = document.getElementById("dialog-source");
const inputVideoSource = document.getElementById("input-video-source");
const btnDialogAbort = document.getElementById("btn-dialog-abort");
const btnDialogApply = document.getElementById("btn-dialog-apply");
const btnDialogClose = document.getElementById("btn-dialog-close");

const btnToggleChatOverlay = document.getElementById("btn-toggle-chat-overlay");
const panelContainer = document.getElementById("panel-container");

window.addEventListener("DOMContentLoaded", () => {
  initIdentity();
  initRouting();
  bindUserInterface();
  bindMediaPipeline();
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

/* ==========================================================================
   1. ИДЕНТИФИКАЦИЯ И РОУТИНГ
   ========================================================================== */

function generateIdentity() {
  return `User_${Math.floor(1000 + Math.random() * 9000)}`;
}

function initIdentity() {
  const stored = localStorage.getItem("syncstream_nick");
  STATE.nickname = stored || generateIdentity();
  inputNickname.value = STATE.nickname;
}

btnDice.addEventListener("click", () => {
  STATE.nickname = generateIdentity();
  inputNickname.value = STATE.nickname;
  localStorage.setItem("syncstream_nick", STATE.nickname);
});

inputNickname.addEventListener("change", () => {
  const clean = inputNickname.value.trim();
  STATE.nickname = clean || generateIdentity();
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
  const randomRoomId = `room-${Math.random().toString(36).substring(2, 7)}`;
  enterRoom(randomRoomId);
});

btnJoinRoom.addEventListener("click", () => {
  const targetId = inputRoomId.value.trim();
  if (targetId) {
    enterRoom(targetId);
  } else {
    showToast("Укажите код комнаты");
    inputRoomId.focus();
  }
});

function enterRoom(roomId) {
  STATE.roomId = roomId;

  if (window.location.hash !== `#${roomId}`) {
    window.location.hash = `#${roomId}`;
  }

  elLobby.setAttribute("hidden", "");
  elRoom.removeAttribute("hidden");
  labelRoomId.textContent = roomId.toUpperCase();

  initiateWebSocket(roomId);
}

/* ==========================================================================
   2. WEBSOCKET SYNC ENGINE
   ========================================================================== */

function initiateWebSocket(roomId) {
  if (STATE.ws) {
    STATE.ws.onclose = null;
    STATE.ws.close();
  }

  const isLocal = BACKEND_HOST.includes("localhost") || BACKEND_HOST.includes("127.0.0.1");
  const protocol = isLocal ? "ws:" : "wss:";
  const wsUrl = `${protocol}//${BACKEND_HOST}/ws/${roomId}`;

  setSyncState("syncing");
  labelPing.textContent = "Connecting...";

  STATE.ws = new WebSocket(wsUrl);

  STATE.ws.onopen = () => {
    STATE.reconnectAttempts = 0;
    setSyncState("in-sync");
    STATE.ws.send(JSON.stringify({ nickname: STATE.nickname }));
    startHeartbeatMonitor();
  };

  STATE.ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      dispatchRemoteEvent(payload);
    } catch (err) {
      console.error("Payload parse failure:", err);
    }
  };

  STATE.ws.onclose = () => {
    stopHeartbeatMonitor();
    setSyncState("error");
    scheduleAutoReconnect();
  };

  STATE.ws.onerror = () => {
    STATE.ws.close();
  };
}

function scheduleAutoReconnect() {
  STATE.reconnectAttempts++;
  const backoff = Math.min(1000 * Math.pow(1.5, STATE.reconnectAttempts), 10000);
  labelPing.textContent = "Reconnecting...";
  setTimeout(() => {
    if (!elRoom.hasAttribute("hidden")) {
      initiateWebSocket(STATE.roomId);
    }
  }, backoff);
}

function startHeartbeatMonitor() {
  stopHeartbeatMonitor();
  STATE.pingInterval = setInterval(() => {
    if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
      STATE.ws.send(JSON.stringify({ type: "PING", time: performance.now() }));
    }
  }, 3000);
}

function stopHeartbeatMonitor() {
  if (STATE.pingInterval) clearInterval(STATE.pingInterval);
}

function dispatchRemoteEvent(msg) {
  switch (msg.type) {
    case "PONG": {
      const latency = Math.round(performance.now() - msg.clientPingTime);
      labelPing.textContent = `${latency} ms`;
      break;
    }
    case "USER_JOINED":
    case "USER_LEFT":
      renderUserDirectory(msg.room);
      break;
    case "SOURCE_CHANGED":
      mountUniversalSource(msg.room.videoType, msg.room.videoUrl);
      break;
    case "SYNC_EVENT":
      executeRemoteSync(msg);
      break;
    case "HOST_CONTROL_TOGGLED":
      STATE.hostOnlyControl = msg.hostOnlyControl;
      checkHostLock.checked = STATE.hostOnlyControl;
      break;
    case "NEW_MESSAGE":
      renderMessageRow(msg);
      break;
  }
}

function broadcastSync(action, time) {
  if (STATE.isApplyingRemote) return;
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: "SYNC_ACTION",
      action: action,
      time: time,
    }));
  }
}

function executeRemoteSync(payload) {
  const { action, room } = payload;
  const serverTime = room.currentTime;

  STATE.isApplyingRemote = true;

  const localTime = readCurrentPlaybackTime();
  const variance = Math.abs(localTime - serverTime);

  if (variance > STATE.driftThreshold || action === "SEEK") {
    seekPlaybackTo(serverTime);
  }

  if (action === "PLAY") {
    triggerPlaybackStart();
    updatePlaybackIcon(true);
  } else if (action === "PAUSE") {
    triggerPlaybackPause();
    updatePlaybackIcon(false);
  }

  setTimeout(() => {
    STATE.isApplyingRemote = false;
  }, 120);
}

function setSyncState(status) {
  syncStatusIndicator.className = `status-dot ${status}`;
}

/* ==========================================================================
   3. УНИВЕРСАЛЬНЫЙ МЕДИА-ДВИЖОК (HLS, MP4, YouTube, Iframe)
   ========================================================================== */

function detectMediaType(rawInput) {
  const clean = rawInput.trim();

  if (clean.includes("youtube.com") || clean.includes("youtu.be")) {
    return "youtube";
  }

  if (clean.includes(".m3u8")) {
    return "hls";
  }

  const directExtensions = [".mp4", ".webm", ".ogg", ".mov", ".m4v"];
  if (directExtensions.some(ext => clean.toLowerCase().includes(ext))) {
    return "direct";
  }

  return "iframe";
}

function parseYouTubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
  return match ? match[1] : url;
}

function cleanEmbedUrl(input) {
  const iframeMatch = input.match(/src=["'](.*?)["']/);
  return iframeMatch ? iframeMatch[1] : input;
}

function mountUniversalSource(type, rawUrl) {
  if (!rawUrl) return;

  playerEmpty.style.display = "none";
  terminateActiveEngines();
  STATE.activeType = type;

  if (type === "youtube") {
    ytContainer.classList.add("active");
    loadYouTubeInstance(parseYouTubeId(rawUrl));
  } else if (type === "hls") {
    nativeVideo.classList.add("active");
    loadHlsStream(rawUrl);
  } else if (type === "direct") {
    nativeVideo.classList.add("active");
    nativeVideo.src = rawUrl;
    nativeVideo.load();
  } else if (type === "iframe") {
    embedIframe.classList.add("active");
    embedIframe.src = cleanEmbedUrl(rawUrl);
  }
}

function loadHlsStream(url) {
  if (window.Hls && window.Hls.isSupported()) {
    STATE.hlsInstance = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
    });
    STATE.hlsInstance.loadSource(url);
    STATE.hlsInstance.attachMedia(nativeVideo);
  } else if (nativeVideo.canPlayType("application/vnd.apple.mpegurl")) {
    nativeVideo.src = url;
  } else {
    showToast("HLS не поддерживается в данном браузере");
  }
}

function loadYouTubeInstance(videoId) {
  if (!STATE.ytReady) {
    setTimeout(() => loadYouTubeInstance(videoId), 200);
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
      onStateChange: (e) => {
        if (STATE.isApplyingRemote) return;
        if (e.data === YT.PlayerState.PLAYING) {
          broadcastSync("PLAY", STATE.ytPlayer.getCurrentTime());
          updatePlaybackIcon(true);
        } else if (e.data === YT.PlayerState.PAUSED) {
          broadcastSync("PAUSE", STATE.ytPlayer.getCurrentTime());
          updatePlaybackIcon(false);
        }
      },
    },
  });
}

function terminateActiveEngines() {
  if (STATE.hlsInstance) {
    STATE.hlsInstance.destroy();
    STATE.hlsInstance = null;
  }

  if (STATE.ytPlayer && typeof STATE.ytPlayer.destroy === "function") {
    STATE.ytPlayer.destroy();
    STATE.ytPlayer = null;
  }

  nativeVideo.pause();
  nativeVideo.removeAttribute("src");
  nativeVideo.load();

  embedIframe.src = "about:blank";

  nativeVideo.classList.remove("active");
  ytContainer.classList.remove("active");
  embedIframe.classList.remove("active");

  STATE.activeType = null;
}

function bindMediaPipeline() {
  nativeVideo.addEventListener("play", () => {
    if (!STATE.isApplyingRemote) {
      broadcastSync("PLAY", nativeVideo.currentTime);
      updatePlaybackIcon(true);
    }
  });

  nativeVideo.addEventListener("pause", () => {
    if (!STATE.isApplyingRemote) {
      broadcastSync("PAUSE", nativeVideo.currentTime);
      updatePlaybackIcon(false);
    }
  });

  nativeVideo.addEventListener("timeupdate", refreshTimelinePosition);
  setInterval(refreshTimelinePosition, 500);
}

function readCurrentPlaybackTime() {
  if (STATE.activeType === "direct" || STATE.activeType === "hls") {
    return nativeVideo.currentTime || 0;
  }
  if (STATE.activeType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.getCurrentTime) {
    return STATE.ytPlayer.getCurrentTime() || 0;
  }
  return 0;
}

function readTotalDuration() {
  if (STATE.activeType === "direct" || STATE.activeType === "hls") {
    return nativeVideo.duration || 0;
  }
  if (STATE.activeType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.getDuration) {
    return STATE.ytPlayer.getDuration() || 0;
  }
  return 0;
}

function seekPlaybackTo(seconds) {
  if (STATE.activeType === "direct" || STATE.activeType === "hls") {
    nativeVideo.currentTime = seconds;
  } else if (STATE.activeType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.seekTo) {
    STATE.ytPlayer.seekTo(seconds, true);
  }
}

function triggerPlaybackStart() {
  if (STATE.activeType === "direct" || STATE.activeType === "hls") {
    nativeVideo.play().catch(() => {});
  } else if (STATE.activeType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.playVideo) {
    STATE.ytPlayer.playVideo();
  }
}

function triggerPlaybackPause() {
  if (STATE.activeType === "direct" || STATE.activeType === "hls") {
    nativeVideo.pause();
  } else if (STATE.activeType === "youtube" && STATE.ytPlayer && STATE.ytPlayer.pauseVideo) {
    STATE.ytPlayer.pauseVideo();
  }
}

function updatePlaybackIcon(isPlaying) {
  iconPlay.hidden = isPlaying;
  iconPause.hidden = !isPlaying;
}

/* ==========================================================================
   4. ТАЙМЛАЙН И ТРАНСПОРТ
   ========================================================================== */

function formatDigitalTime(seconds) {
  if (isNaN(seconds) || !isFinite(seconds)) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m < 10 ? `0${m}` : m}:${s < 10 ? `0${s}` : s}`;
}

function refreshTimelinePosition() {
  const current = readCurrentPlaybackTime();
  const total = readTotalDuration();

  timecode.textContent = `${formatDigitalTime(current)} / ${formatDigitalTime(total)}`;

  if (total > 0) {
    timelineSlider.value = (current / total) * 100;
  } else {
    timelineSlider.value = 0;
  }
}

timelineSlider.addEventListener("input", () => {
  const total = readTotalDuration();
  if (total > 0) {
    const target = (timelineSlider.value / 100) * total;
    seekPlaybackTo(target);
    broadcastSync("SEEK", target);
  }
});

btnPlayPause.addEventListener("click", () => {
  const isPlaying = !iconPlay.hidden;
  if (isPlaying) {
    triggerPlaybackStart();
    broadcastSync("PLAY", readCurrentPlaybackTime());
  } else {
    triggerPlaybackPause();
    broadcastSync("PAUSE", readCurrentPlaybackTime());
  }
});

btnFullscreen.addEventListener("click", () => {
  const target = document.getElementById("player-viewport");
  if (!document.fullscreenElement) {
    target.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

/* ==========================================================================
   5. ЧАТ И ЗАЩИТА XSS
   ========================================================================== */

function sanitizeText(raw) {
  const container = document.createElement("div");
  container.textContent = raw;
  return container.innerHTML;
}

chatInputForm.addEventListener("submit", () => {
  const text = chatMessageField.value.trim();
  if (!text || !STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;

  STATE.ws.send(JSON.stringify({
    type: "CHAT_MESSAGE",
    text: text,
  }));

  chatMessageField.value = "";
});

function renderMessageRow(msg) {
  const isSelf = msg.senderNick === STATE.nickname;
  const timeFormatted = new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const row = document.createElement("div");
  row.className = "chat-entry";
  row.innerHTML = `
    <div class="chat-entry-head">
      <span class="chat-author ${isSelf ? "self" : ""}">${sanitizeText(msg.senderNick)}</span>
      <span class="chat-timestamp">${timeFormatted}</span>
    </div>
    <div class="chat-text">${sanitizeText(msg.text)}</div>
  `;

  chatStream.appendChild(row);
  chatStream.scrollTop = chatStream.scrollHeight;
}

/* ==========================================================================
   6. СПИСОК УЧАСТНИКОВ И ПРАВА ХОСТА
   ========================================================================== */

function renderUserDirectory(room) {
  userCount.textContent = room.clientCount;
  userDirectory.innerHTML = "";

  const selfRecord = room.users.find(u => u.nickname === STATE.nickname);
  STATE.isHost = Boolean(selfRecord && selfRecord.id === room.hostId);

  checkHostLock.disabled = !STATE.isHost;

  room.users.forEach((u) => {
    const li = document.createElement("li");
    li.className = "user-record";
    li.innerHTML = `
      <span>${sanitizeText(u.nickname)}</span>
      ${u.isHost ? '<span class="role-tag-host">Host</span>' : ""}
    `;
    userDirectory.appendChild(li);
  });
}

checkHostLock.addEventListener("change", () => {
  if (STATE.isHost && STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: "SET_HOST_ONLY",
      enabled: checkHostLock.checked,
    }));
  }
});

/* ==========================================================================
   7. ДИАЛОГ СМЕНЫ ИСТОЧНИКА
   ========================================================================== */

function launchSourceDialog() {
  dialogSource.showModal();
  inputVideoSource.focus();
}

btnOpenSource.addEventListener("click", launchSourceDialog);
btnEmptySelect.addEventListener("click", launchSourceDialog);

btnDialogClose.addEventListener("click", () => dialogSource.close());
btnDialogAbort.addEventListener("click", () => dialogSource.close());

btnDialogApply.addEventListener("click", () => {
  const inputVal = inputVideoSource.value.trim();
  if (!inputVal) return;

  const detectedType = detectMediaType(inputVal);

  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: "LOAD_SOURCE",
      videoType: detectedType,
      videoUrl: inputVal,
    }));
  }

  dialogSource.close();
  inputVideoSource.value = "";
});

/* ==========================================================================
   8. ПАНЕЛИ, ШАРИНГ И ТОСТЫ
   ========================================================================== */

function bindUserInterface() {
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
    } catch (e) {
      showToast("Не удалось скопировать");
    }
  });

  btnToggleChatOverlay.addEventListener("click", () => {
    panelContainer.classList.toggle("drawer-open");
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 839) {
      panelContainer.classList.remove("drawer-open");
    }
  });
}

function showToast(message) {
  const shelf = document.getElementById("toast-shelf");
  const el = document.createElement("div");
  el.className = "toast-item";
  el.textContent = message;
  shelf.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 2400);
}