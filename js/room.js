let pendingMembers = [];
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("id");
const token = localStorage.getItem("token");
const currentUser = JSON.parse(localStorage.getItem("user"));

if (!token || !roomId) window.location.href = "rooms.html";

const socket = io("http://localhost:3000", { auth: { token } });
let currentRole = "listener";
let isMuted = false;
let localStream = null;
let peers = {};
const pcConfig = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

async function loadOldMessages() {
    const res = await fetch(`http://localhost:3000/api/rooms/messages/${roomId}`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    const msgs = await res.json();
    msgs.forEach((msg) => renderMessage(msg));
}

function attachRemoteAudio(userId, stream) {
    const existing = document.getElementById(`audio-${userId}`);
    if (existing) existing.remove();

    const audio = document.createElement("audio");
    audio.id = `audio-${userId}`;
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.playsInline = true;
    document.body.appendChild(audio);
}

function cleanupPeer(userId) {
    const pc = peers[userId];
    if (pc) {
        pc.close();
        delete peers[userId];
    }

    const audio = document.getElementById(`audio-${userId}`);
    if (audio) audio.remove();
}

function ensurePeer(targetId) {
    if (targetId === currentUser.id) return null;
    if (peers[targetId]) return peers[targetId];

    const pc = new RTCPeerConnection(pcConfig);
    peers[targetId] = pc;

    pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        socket.emit("room:signal", {
            to: targetId,
            signal: e.candidate
        });
    };

    pc.ontrack = (event) => {
        attachRemoteAudio(targetId, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
        if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
            cleanupPeer(targetId);
        }
    };

    if (localStream) {
        localStream.getTracks().forEach((track) => {
            pc.addTrack(track, localStream);
        });
    }

    return pc;
}

async function createPeer(targetId) {
    if (!localStream) return;
    if (targetId === currentUser.id) return;

    const pc = ensurePeer(targetId);
    if (!pc) return;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit("room:signal", {
        to: targetId,
        signal: offer
    });
}

function connectToMembers() {
    if (!localStream) return;

    pendingMembers.forEach((member) => {
        if (member.user_id !== currentUser.id && !peers[member.user_id]) {
            createPeer(member.user_id);
        }
    });
}

document.getElementById("leaveBtn").onclick = () => {
    socket.emit("room:leave", { roomId });
    window.location.href = "rooms.html";
};

socket.emit("room:join", { roomId });
loadOldMessages();

socket.on("room:force_mute", () => {
    if (localStream) {
        localStream.getAudioTracks()[0].enabled = false;
        isMuted = true;
        document.getElementById("muteBtn").textContent = "Unmute";
    }
});

socket.on("room:mic_accepted", () => {
    startStreaming();
});

socket.on("room:update_state", (state) => {
    const { members, owner } = state;
    document.getElementById("roomName").textContent = "Audio Room";
    document.getElementById("ownerAvatar").src = owner.avatar
        ? `http://localhost:3000/uploads/${owner.avatar}`
        : "https://via.placeholder.com/45";

    const viewers = members.filter((member) => member.is_online).length;
    document.getElementById("viewers").textContent = viewers;

    renderMics(members);

    const me = members.find((member) => member.user_id == currentUser.id);
    if (me) {
        currentRole = me.role;
        updateControls();

        if (currentRole === "owner") {
            document.getElementById("leaveBtn").textContent = "Close Room";
            document.getElementById("ownerPanel").style.display = "block";
        }
    }

    if (localStream) {
        members.forEach((member) => {
            if (member.user_id !== currentUser.id && !peers[member.user_id]) {
                createPeer(member.user_id);
            }
        });
    }
});

socket.on("room:members_list", (members) => {
    pendingMembers = members;
    connectToMembers();
});

function renderMics(members) {
    const grid = document.getElementById("micGrid");
    grid.innerHTML = "";

    const maxMics = 10;
    const speakers = members.filter((member) => ["owner", "speaker"].includes(member.role));

    for (let i = 0; i < maxMics; i += 1) {
        const user = speakers[i];
        const slot = document.createElement("div");
        slot.className = "mic-slot";

        if (user) {
            const avatar = user.avatar
                ? `http://localhost:3000/uploads/${user.avatar}`
                : "https://via.placeholder.com/85";

            slot.innerHTML = `
<div class="mic-circle active">
    <img src="${avatar}">
    ${user.role === "owner" ? '<span class="mic-badge">OWNER</span>' : ""}
    ${currentRole === "owner" && user.user_id !== currentUser.id
        ? `<span onclick="muteUser(${user.user_id})" class="mute-btn">🔇</span>`
        : ""}
</div>
<div class="mic-name">${user.name}</div>
`;
        } else {
            slot.innerHTML = '<div class="mic-circle empty-mic"></div><div class="mic-name">Empty</div>';
        }

        grid.appendChild(slot);
    }
}

function updateControls() {
    const joinBtn = document.getElementById("joinMicBtn");
    const muteBtn = document.getElementById("muteBtn");

    if (["owner", "speaker"].includes(currentRole)) {
        joinBtn.style.display = "none";
        muteBtn.style.display = "block";
        startStreaming();
    } else {
        joinBtn.style.display = "block";
        muteBtn.style.display = "none";
    }
}

function requestMic() {
    socket.emit("room:request_mic", { roomId });
    document.getElementById("joinMicBtn").disabled = true;
    document.getElementById("joinMicBtn").textContent = "Pending...";
}

socket.on("room:queue_update", (queue) => {
    const list = document.getElementById("queueList");
    list.innerHTML = queue.map((item) => `
        <div class="queue-item">
            <img style="width:10;height:10;border-raduis:50" src="${item.avatar ? `http://localhost:3000/uploads/${item.avatar}` : "https://via.placeholder.com/30"}" class="queue-avatar">
            <span style="font-size: 0.75rem; font-weight: 700;">${item.name}</span>
            <div class="queue-actions">
                <button class="q-btn q-accept" onclick="acceptMic(${item.user_id})">✓</button>
                <button class="q-btn" style="background:#475569; color:white;" onclick="rejectMic(${item.user_id})">✕</button>
            </div>
        </div>
    `).join("");
});

function acceptMic(targetUserId) {
    socket.emit("room:accept_request", { roomId, targetUserId });
}

function rejectMic(targetUserId) {
    socket.emit("room:reject_request", { roomId, targetUserId });
}

function sendMsg() {
    const input = document.getElementById("chatInput");
    if (!input.value.trim()) return;

    socket.emit("room:send_message", { roomId, message: input.value });
    input.value = "";
}

function renderMessage(msg) {
    const container = document.getElementById("messages");
    const div = document.createElement("div");

    div.className = "msg";

    const avatar = msg.avatar
        ? `http://localhost:3000/uploads/${msg.avatar}`
        : "https://via.placeholder.com/30";

    div.innerHTML = `
        <img src="${avatar}" class="msg-avatar" loading="lazy">
        <div class="msg-content">
            <span class="msg-name">${msg.name || msg.fromUserName}</span>
            <div class="msg-text">${msg.content || msg.message}</div>
        </div>
    `;

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

socket.on("room:new_message", renderMessage);

async function startStreaming() {
    if (localStream) return;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        socket.emit("room:get_members_for_webrtc", { roomId });
        connectToMembers();
    } catch (err) {
        console.error("Mic access denied", err);
    }
}

function toggleMute() {
    isMuted = !isMuted;

    if (localStream) {
        localStream.getAudioTracks()[0].enabled = !isMuted;
    }

    document.getElementById("muteBtn").textContent = isMuted ? "Unmute" : "Mute";
    document.getElementById("muteBtn").style.background = isMuted ? "#10b981" : "var(--accent)";
}

socket.on("room:signal", async ({ from, signal }) => {
    if (from === currentUser.id) return;

    const pc = ensurePeer(from);
    if (!pc) return;

    if (signal.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("room:signal", {
            to: from,
            signal: answer
        });
        return;
    }

    if (signal.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        return;
    }

    try {
        await pc.addIceCandidate(new RTCIceCandidate(signal));
    } catch (err) {
        console.error("ICE candidate error", err);
    }
});

socket.on("room:error", (msg) => {
    alert(msg);
    if (msg === "Room is full") window.location.href = "rooms.html";
});

socket.on("room:close", () => {
    alert("The room has been closed by the owner.");
    window.location.href = "rooms.html";
});

socket.on("room:removed_from_mic", () => {
    currentRole = "listener";

    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }

    Object.keys(peers).forEach((peerUserId) => cleanupPeer(peerUserId));
    updateControls();
});

window.onbeforeunload = () => {
    socket.emit("room:leave", { roomId });
};

function kickUser(targetUserId) {
    if (currentRole !== "owner") return;
    socket.emit("room:remove_speaker", { roomId, targetUserId });
}

function muteUser(targetUserId) {
    if (currentRole !== "owner") return;
    if (targetUserId === currentUser.id) return;

    socket.emit("room:mute_user", { targetUserId });
}
