"use strict";

const BACKEND_URL = "http://localhost:3000";
const socket = io(BACKEND_URL);

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser  = "";
let currentRoom  = "";
let pendingFile  = null;   // { file, type: 'image'|'video' }

// ── DOM ───────────────────────────────────────────────────────────────────────
const loginScreen    = document.getElementById("login-screen");
const chatScreen     = document.getElementById("chat-screen");
const chatBox        = document.getElementById("chat-box");
const messageInput   = document.getElementById("message-input");
const fileInput      = document.getElementById("file-input");
const dropZone       = document.getElementById("upload-drop-zone");
const previewPanel   = document.getElementById("file-preview-panel");
const uploadTrigger  = document.getElementById("upload-trigger");
const lightbox       = document.getElementById("lightbox");
const lightboxImg    = document.getElementById("lightbox-img");
const membersList    = document.getElementById("members-list");
const memberCount    = document.getElementById("member-count");

// ═══════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════
const savedUser = localStorage.getItem("sc_username");
const savedRoom = localStorage.getItem("sc_room");
if (savedUser) document.getElementById("username").value = savedUser;
if (savedRoom) document.getElementById("room").value = savedRoom;

document.getElementById("join-btn").addEventListener("click", joinRoom);
document.getElementById("username").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("room").focus(); });
document.getElementById("room").addEventListener("keydown", e => { if (e.key === "Enter") joinRoom(); });

function joinRoom() {
    const u = document.getElementById("username").value.trim();
    const r = document.getElementById("room").value.trim();
    if (!u || !r) return;

    localStorage.setItem("sc_username", u);
    localStorage.setItem("sc_room", r);

    currentUser = u;
    currentRoom = r;

    loginScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");

    document.getElementById("room-badge").textContent       = r;
    document.getElementById("user-badge").textContent       = u;
    document.getElementById("header-room-name").textContent = r;

    socket.emit("joinRoom", { username: currentUser, room: currentRoom });
}

document.getElementById("leave-btn").addEventListener("click", () => location.reload());

// ═══════════════════════════════════════════════════════════
// FILE SELECTION & PREVIEW
// ═══════════════════════════════════════════════════════════
fileInput.addEventListener("change", function () {
    if (this.files[0]) loadFile(this.files[0]);
});

// Drag & drop on chat area
const chatMain = document.querySelector(".chat-main");
chatMain.addEventListener("dragenter", e => { e.preventDefault(); if (!pendingFile) dropZone.classList.remove("hidden"); });
chatMain.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
chatMain.addEventListener("dragleave", e => { if (!chatMain.contains(e.relatedTarget)) dropZone.classList.remove("drag-over"); });
chatMain.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    dropZone.classList.add("hidden");
    const f = e.dataTransfer.files[0];
    if (f && (f.type.startsWith("image/") || f.type.startsWith("video/"))) loadFile(f);
    else if (f) showSystem("Only image and video files are supported for upload.");
});
dropZone.addEventListener("click", () => fileInput.click());

function loadFile(file) {
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) return showSystem("Unsupported file type.");

    pendingFile = { file, type: isVideo ? "video" : "image" };
    uploadTrigger.classList.add("has-file");
    dropZone.classList.add("hidden");

    // Set header
    document.getElementById("preview-type-icon").textContent     = isVideo ? "🎬" : "📷";
    document.getElementById("preview-header-label").textContent  = `${isVideo ? "Video" : "Image"} ready to send`;
    document.getElementById("preview-filename").textContent      = file.name;
    document.getElementById("preview-filesize").textContent      = formatBytes(file.size);
    document.getElementById("preview-dims").textContent          = "Reading…";

    const imgWrap = document.getElementById("img-preview-wrap");
    const vidWrap = document.getElementById("vid-preview-wrap");

    if (isImage) {
        imgWrap.classList.remove("hidden");
        vidWrap.classList.add("hidden");
        const reader = new FileReader();
        reader.onload = e => {
            document.getElementById("preview-thumb").src = e.target.result;
            // Get natural dimensions
            const tmp = new Image();
            tmp.onload = () => { document.getElementById("preview-dims").textContent = `${tmp.naturalWidth} × ${tmp.naturalHeight} px`; };
            tmp.src = e.target.result;
        };
        reader.readAsDataURL(file);
    } else {
        vidWrap.classList.remove("hidden");
        imgWrap.classList.add("hidden");
        const vid = document.getElementById("preview-video");
        vid.src = URL.createObjectURL(file);
        vid.onloadedmetadata = () => {
            const dur = vid.duration;
            document.getElementById("preview-dims").textContent =
                `${Math.round(vid.videoWidth)}×${Math.round(vid.videoHeight)} · ${formatDuration(dur)}`;
        };
    }

    previewPanel.classList.remove("hidden");
    document.getElementById("upload-progress-wrap").classList.add("hidden");
}

function clearFile() {
    pendingFile = null;
    fileInput.value = "";
    previewPanel.classList.add("hidden");
    dropZone.classList.add("hidden");
    uploadTrigger.classList.remove("has-file");

    // Clean up video object URL
    const vid = document.getElementById("preview-video");
    if (vid.src) { URL.revokeObjectURL(vid.src); vid.src = ""; }
}

document.getElementById("preview-clear-btn").addEventListener("click", clearFile);

// Image zoom lightbox
document.getElementById("preview-zoom-btn").addEventListener("click", () => {
    const thumb = document.getElementById("preview-thumb").src;
    if (thumb) openLightbox(thumb);
});

// ═══════════════════════════════════════════════════════════
// FILE UPLOAD (XMLHttpRequest for progress tracking)
// ═══════════════════════════════════════════════════════════
async function uploadFile(file) {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append("media", file);

        const xhr = new XMLHttpRequest();
        const progressWrap = document.getElementById("upload-progress-wrap");
        const progressBar  = document.getElementById("upload-progress-bar");
        const progressLbl  = document.getElementById("upload-progress-label");

        progressWrap.classList.remove("hidden");
        progressBar.style.width = "0%";
        progressLbl.textContent = "Uploading…";

        xhr.upload.addEventListener("progress", e => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = pct + "%";
                progressLbl.textContent = pct + "%";
            }
        });

        xhr.addEventListener("load", () => {
            if (xhr.status === 200) {
                progressBar.style.width = "100%";
                progressLbl.textContent = "Done!";
                try { resolve(JSON.parse(xhr.responseText)); }
                catch { reject(new Error("Bad server response")); }
            } else {
                reject(new Error(`Upload failed (${xhr.status})`));
            }
        });

        xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
        xhr.open("POST", `${BACKEND_URL}/upload`);
        xhr.send(formData);
    });
}

// ═══════════════════════════════════════════════════════════
// SEND MESSAGE
// ═══════════════════════════════════════════════════════════
document.getElementById("send-btn").addEventListener("click", () => sendMessage(false));
messageInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(false); }
});

async function sendMessage(isConfirmedOTP) {
    if (!currentRoom) return;
    const text = messageInput.value.trim();
    const hasFile = !!pendingFile;

    if (!text && !hasFile) return;

    // Disable send while uploading
    const sendBtn = document.getElementById("send-btn");
    sendBtn.disabled = true;
    messageInput.value = "";

    try {
        let mediaUrl  = null;
        let mediaType = null;

        if (hasFile) {
            const result = await uploadFile(pendingFile.file);
            mediaUrl  = result.fileUrl;
            mediaType = result.type;
        }

        socket.emit("sendMessage", {
            username: currentUser,
            room:     currentRoom,
            text:     text || null,
            mediaUrl,
            mediaType,
            isConfirmedOTP,
        });

        if (hasFile) clearFile();
    } catch (err) {
        showSystem(`❌ Upload failed: ${err.message}`);
        messageInput.value = text;  // restore text
    } finally {
        sendBtn.disabled = false;
    }
}

// ═══════════════════════════════════════════════════════════
// PRIVATE MESSAGE
// ═══════════════════════════════════════════════════════════
let pendingDMFile = null;
const dmFileInput = document.getElementById("dm-file-input");
const dmPreview = document.getElementById("dm-file-preview");
const dmPreviewName = document.getElementById("dm-preview-name");
const dmPreviewClear = document.getElementById("dm-preview-clear");

dmFileInput.addEventListener("change", function() {
    if (this.files[0]) {
        pendingDMFile = this.files[0];
        dmPreviewName.textContent = pendingDMFile.name;
        dmPreview.classList.remove("hidden");
    }
});

dmPreviewClear.addEventListener("click", () => {
    pendingDMFile = null;
    dmFileInput.value = "";
    dmPreview.classList.add("hidden");
});

document.getElementById("dm-btn").addEventListener("click", sendDM);
document.getElementById("dm-message").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDM(); }
});

async function sendDM() {
    const target = document.getElementById("dm-user").value.trim();
    const text   = document.getElementById("dm-message").value.trim();
    if (!target || (!text && !pendingDMFile)) return;

    const dmBtn = document.getElementById("dm-btn");
    dmBtn.disabled = true;
    document.getElementById("dm-message").value = "";

    try {
        let mediaUrl = null;
        let mediaType = null;
        if (pendingDMFile) {
            const result = await uploadFile(pendingDMFile);
            mediaUrl = result.fileUrl;
            mediaType = result.type;
        }

        socket.emit("privateMessage", { targetUsername: target, text, mediaUrl, mediaType });
        
        pendingDMFile = null;
        dmFileInput.value = "";
        dmPreview.classList.add("hidden");
    } catch(err) {
        showSystem(`❌ DM Upload failed: ${err.message}`);
        document.getElementById("dm-message").value = text;
    } finally {
        dmBtn.disabled = false;
    }
}

// ═══════════════════════════════════════════════════════════
// LIGHTBOX
// ═══════════════════════════════════════════════════════════
function openLightbox(src) { lightboxImg.src = src; lightbox.classList.remove("hidden"); }
function closeLightbox()   { lightbox.classList.add("hidden"); lightboxImg.src = ""; }
document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
lightbox.addEventListener("click", e => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeLightbox(); });

// ═══════════════════════════════════════════════════════════
// SOCKET EVENTS
// ═══════════════════════════════════════════════════════════
socket.on("connect", () => {
    // If the socket reconnects after a drop, re-join the room automatically
    if (currentUser && currentRoom) {
        socket.emit("joinRoom", { username: currentUser, room: currentRoom });
    }
});

socket.on("chatHistory", history => {
    chatBox.innerHTML = "";
    if (history.length === 0) {
        chatBox.innerHTML = `<div class="chat-welcome"><div class="welcome-icon">👋</div><p>Start the conversation! This room is AI-moderated.</p></div>`;
    }
    history.forEach(renderMessage);
});

socket.on("receiveMessage", msg => {
    const welcome = chatBox.querySelector(".chat-welcome");
    if (welcome) welcome.remove();
    renderMessage(msg);
});

socket.on("deleteMessage", ({ msgId }) => {
    const el     = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!el) return;
    const bubble = el.querySelector(".msg-bubble");
    if (bubble) { bubble.classList.add("deleting"); bubble.addEventListener("animationend", () => el.remove(), { once: true }); }
    else el.remove();
});

socket.on("updateComments", ({ msgId, comments }) => {
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!el) return;
    const commentsList = el.querySelector(".comments-list");
    if (commentsList) {
        commentsList.innerHTML = "";
        comments.forEach(c => {
            const cDiv = document.createElement("div");
            cDiv.style.marginBottom = "4px";
            cDiv.innerHTML = `<strong>${c.username}:</strong> <span>${c.text}</span>`;
            commentsList.appendChild(cDiv);
        });
    }
});

socket.on("systemMessage", msg => showSystem(msg));

socket.on("receivePrivateMessage", ({ sender, text, mediaUrl, mediaType }) => {
    const wrapper = document.createElement("div");
    wrapper.className = "msg-private";
    
    const senderLine = document.createElement("div");
    senderLine.style.fontWeight = "bold";
    senderLine.style.marginBottom = "4px";
    senderLine.textContent = `🔒 ${sender}:`;
    wrapper.appendChild(senderLine);
    
    if (text) {
        const span = document.createElement("div");
        span.textContent = text;
        wrapper.appendChild(span);
    }
    
    if (mediaUrl) {
        const fullUrl = `${BACKEND_URL}${mediaUrl}`;
        if (mediaType === "video") {
            const video = document.createElement("video");
            video.src = fullUrl;
            video.controls = true;
            video.className = "msg-video";
            video.style.maxWidth = "200px";
            wrapper.appendChild(video);
        } else {
            const img = document.createElement("img");
            img.src = fullUrl;
            img.className = "msg-img";
            img.style.maxWidth = "200px";
            img.addEventListener("click", () => openLightbox(fullUrl));
            wrapper.appendChild(img);
        }
    }
    
    appendMsg(wrapper);
});

socket.on("privacyAlert", ({ message, mediaUrl, mediaType }) => {
    const ok = confirm("⚠️ Security Alert\n\nYour message may contain a sensitive number (OTP).\nSend it anyway?");
    if (ok) socket.emit("sendMessage", { username: currentUser, room: currentRoom, text: message, mediaUrl, mediaType, isConfirmedOTP: true });
});

// ── Room Members ─────────────────────────────────────────────────────────────
socket.on("roomMembers", members => renderMembers(members));

function renderMembers(members) {
    memberCount.textContent = members.length;
    membersList.innerHTML = "";

    members.forEach((name, i) => {
        const isYou = name === currentUser;
        const item  = document.createElement("div");
        item.className = `member-item${isYou ? " is-you" : ""}`;

        const av = document.createElement("div");
        av.className   = `member-avatar av-${i % 8}`;
        av.textContent = name[0].toUpperCase();

        const nm = document.createElement("span");
        nm.className = "member-name";
        nm.textContent = name;
        if (isYou) {
            const tag = document.createElement("span");
            tag.className = "you-tag"; tag.textContent = "(you)";
            nm.appendChild(tag);
        }

        const dot = document.createElement("div");
        dot.className = "member-online-dot";

        item.appendChild(av);
        item.appendChild(nm);
        item.appendChild(dot);
        membersList.appendChild(item);
    });
}

// ═══════════════════════════════════════════════════════════
// RENDER MESSAGE
// ═══════════════════════════════════════════════════════════
function renderMessage(msg) {
    const isOwn = msg.username === currentUser;

    const wrapper = document.createElement("div");
    wrapper.className = `msg-wrapper ${isOwn ? "own" : "other"}`;
    if (msg.id) wrapper.dataset.msgId = msg.id;

    const ts = msg.timestamp
        ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.style.display = "flex";
    meta.style.alignItems = "center";
    meta.style.justifyContent = isOwn ? "flex-end" : "flex-start";
    meta.style.gap = "8px";

    const metaText = document.createElement("span");
    metaText.textContent = isOwn ? `You · ${ts}` : `${msg.username} · ${ts}`;
    meta.appendChild(metaText);

    // Reply button
    if (!isOwn) {
        const replyBtn = document.createElement("button");
        replyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align: middle;"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg> Reply`;
        replyBtn.style.background = "none";
        replyBtn.style.border = "none";
        replyBtn.style.color = "var(--accent)";
        replyBtn.style.cursor = "pointer";
        replyBtn.style.fontSize = "0.7rem";
        replyBtn.style.fontWeight = "600";
        replyBtn.onclick = () => {
            document.getElementById("message-input").value = `@${msg.username} `;
            document.getElementById("message-input").focus();
        };
        meta.appendChild(replyBtn);
    }

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";

    // Text
    if (msg.text) {
        const span = document.createElement("span");
        span.textContent = msg.text;
        bubble.appendChild(span);
    }

    // Media (server-stored file)
    if (msg.mediaUrl) {
        const fullUrl = `${BACKEND_URL}${msg.mediaUrl}`;

        if (msg.mediaType === "video") {
            const video = document.createElement("video");
            video.src      = fullUrl;
            video.controls = true;
            video.preload  = "metadata";
            video.className = "msg-video";
            bubble.appendChild(video);

        } else {
            // image (or legacy base64)
            const src = msg.mediaUrl.startsWith("/uploads/")
                ? fullUrl
                : (typeof msg.mediaUrl === "string" && msg.mediaUrl.startsWith("data:image/") ? msg.mediaUrl : null);

            if (src) {
                const img = document.createElement("img");
                img.src       = src;
                img.alt       = "image";
                img.className = "msg-img";
                img.loading   = "lazy";
                img.addEventListener("click", () => openLightbox(src));
                bubble.appendChild(img);
            }
        }
    }

    // Legacy: messages stored with 'image' field (base64)
    if (!msg.mediaUrl && msg.image && typeof msg.image === "string" && msg.image.startsWith("data:image/")) {
        const img = document.createElement("img");
        img.src = msg.image; img.alt = "image"; img.className = "msg-img"; img.loading = "lazy";
        img.addEventListener("click", () => openLightbox(msg.image));
        bubble.appendChild(img);
    }

    wrapper.appendChild(meta);
    wrapper.appendChild(bubble);

    // ── Individual Media Comments ────────────────────────────────────────────────
    if (msg.mediaUrl || msg.image) {
        const commentsSection = document.createElement("div");
        commentsSection.className = "media-comments-section";
        commentsSection.style.marginTop = "6px";
        commentsSection.style.padding = "8px 12px";
        commentsSection.style.background = "rgba(0,0,0,0.03)";
        commentsSection.style.borderRadius = "8px";
        commentsSection.style.fontSize = "0.8rem";

        const commentsList = document.createElement("div");
        commentsList.className = "comments-list";
        if (msg.comments && msg.comments.length > 0) {
            msg.comments.forEach(c => {
                const cDiv = document.createElement("div");
                cDiv.style.marginBottom = "4px";
                cDiv.innerHTML = `<strong>${c.username}:</strong> <span>${c.text}</span>`;
                commentsList.appendChild(cDiv);
            });
        }
        commentsSection.appendChild(commentsList);

        const commentForm = document.createElement("div");
        commentForm.style.display = "flex";
        commentForm.style.gap = "6px";
        commentForm.style.marginTop = "6px";

        const commentInput = document.createElement("input");
        commentInput.type = "text";
        commentInput.placeholder = "Write a comment...";
        commentInput.style.flex = "1";
        commentInput.style.padding = "4px 8px";
        commentInput.style.border = "1px solid var(--chat-border)";
        commentInput.style.borderRadius = "12px";
        commentInput.style.fontSize = "0.75rem";
        commentInput.style.outline = "none";
        
        const commentBtn = document.createElement("button");
        commentBtn.textContent = "Post";
        commentBtn.style.background = "var(--accent)";
        commentBtn.style.color = "#fff";
        commentBtn.style.border = "none";
        commentBtn.style.borderRadius = "12px";
        commentBtn.style.padding = "0 10px";
        commentBtn.style.cursor = "pointer";
        commentBtn.style.fontSize = "0.75rem";
        commentBtn.style.fontWeight = "bold";

        const submitComment = () => {
            const cText = commentInput.value.trim();
            if (cText && msg.id) {
                socket.emit("addComment", { msgId: msg.id, text: cText });
                commentInput.value = "";
            }
        };

        commentBtn.addEventListener("click", submitComment);
        commentInput.addEventListener("keydown", e => { if (e.key === "Enter") submitComment(); });

        commentForm.appendChild(commentInput);
        commentForm.appendChild(commentBtn);
        commentsSection.appendChild(commentForm);

        wrapper.appendChild(commentsSection);
    }

    appendMsg(wrapper);
}

function showSystem(msg) {
    const div = document.createElement("div");
    div.className   = "msg-system";
    div.textContent = msg;
    appendMsg(div);
}

function appendMsg(el) {
    chatBox.appendChild(el);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════
function formatBytes(b) {
    if (b < 1024)    return `${b} B`;
    if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b/1048576).toFixed(1)} MB`;
    return `${(b/1073741824).toFixed(2)} GB`;
}
function formatDuration(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2,"0")}`;
}
