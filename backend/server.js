"use strict";

const path   = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express      = require("express");
const http         = require("http");
const cors         = require("cors");
const helmet       = require("helmet");
const rateLimit    = require("express-rate-limit");
const multer       = require("multer");
const { Server }   = require("socket.io");
const fs           = require("fs");
const { regexTrollCheck, checkTrolling } = require("./utils/aiHandler");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT)          || 3000;
const NODE_ENV        = process.env.NODE_ENV                || "development";
const MAX_MSG_LENGTH  = parseInt(process.env.MAX_MSG_LENGTH) || 1000;
const SOCKET_MSG_RATE = parseInt(process.env.SOCKET_MSG_RATE) || 30;
const HTTP_RATE_LIMIT = parseInt(process.env.HTTP_RATE_LIMIT) || 100;
const UPLOAD_DIR      = path.join(__dirname, process.env.UPLOAD_DIR || "uploads");

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5500")
    .split(",").map((o) => o.trim()).concat(["null"]);

// ── Ensure upload directory exists ────────────────────────────────────────────
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── App setup ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({
    origin: (origin, cb) => {
        if (!origin && NODE_ENV !== "production") return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin "${origin}" not allowed.`));
    },
    methods: ["GET", "POST"],
    credentials: true,
}));

app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: HTTP_RATE_LIMIT,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." },
}));

app.use(express.json({ limit: "10kb" }));  // only JSON bodies capped; files go through multer

// ── Static: serve uploaded files ──────────────────────────────────────────────
// Files accessible at http://localhost:3000/uploads/<filename>
app.use("/uploads", express.static(UPLOAD_DIR, {
    setHeaders: (res, filePath) => {
        // Force download-safe Content-Disposition for non-media types
        const ext = path.extname(filePath).toLowerCase();
        const safeExts = [".jpg",".jpeg",".png",".gif",".webp",".mp4",".webm",".ogg",".mov",".m4v"];
        if (!safeExts.includes(ext)) res.setHeader("Content-Disposition", "attachment");
    },
}));

// ── Multer: disk storage, no size limit ───────────────────────────────────────
const ALLOWED_MIME = [
    "image/jpeg","image/png","image/gif","image/webp","image/bmp","image/svg+xml",
    "video/mp4","video/webm","video/ogg","video/quicktime","video/x-msvideo","video/x-matroska","video/x-m4v",
];

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename:    (_req, file, cb) => {
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        cb(null, unique + path.extname(file.originalname).toLowerCase());
    },
});

const upload = multer({
    storage,
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
        cb(new Error(`File type "${file.mimetype}" not allowed.`));
    },
    // No limits.fileSize — files go to local disk, size only limited by available disk space
});

// ── Upload endpoint ───────────────────────────────────────────────────────────
app.post("/upload", upload.single("media"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file received." });

    const isVideo = req.file.mimetype.startsWith("video/");
    res.json({
        fileUrl:      `/uploads/${req.file.filename}`,
        originalName: req.file.originalname,
        size:         req.file.size,
        type:         isVideo ? "video" : "image",
    });
});

// ── Upload error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError || err.message.includes("not allowed")) {
        return res.status(400).json({ error: err.message });
    }
    if (NODE_ENV !== "production") console.error(err);
    res.status(500).json({ error: "Internal server error" });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
    cors: { origin: ALLOWED_ORIGINS, methods: ["GET","POST"], credentials: true },
    maxHttpBufferSize: 1 * 1024 * 1024,  // 1 MB cap for socket payloads (text only now)
    pingTimeout: 20000, pingInterval: 25000,
});

// ── JSON-file persistence ─────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "data", "messages.json");
if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]");

const getMessages = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8") || "[]"); } catch { return []; } };
const saveMsg     = (m)  => { const a = getMessages(); a.push(m); fs.writeFileSync(DATA_FILE, JSON.stringify(a, null, 2)); };
const deleteById  = (id) => { const a = getMessages().filter((m) => m.id !== id); fs.writeFileSync(DATA_FILE, JSON.stringify(a, null, 2)); };

// ── In-memory state ───────────────────────────────────────────────────────────
const users = {};  // socketId → { username, room }

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitizeText(s) { return typeof s === "string" ? s.replace(/<[^>]*>/g, "").trim() : ""; }
function sanitizeName(s) { return typeof s === "string" ? s.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 40) : ""; }

/** Return sorted list of usernames currently in a room */
function getRoomMembers(room) {
    return [...new Set(
        Object.values(users)
            .filter((u) => u.room === room)
            .map((u) => u.username)
    )].sort();
}

/** Broadcast updated member list to everyone in a room */
function broadcastMembers(room) {
    io.to(room).emit("roomMembers", getRoomMembers(room));
}

// Per-socket flood guard
function makeRateLimiter(max) {
    const map = new Map();
    return (id) => {
        const now = Date.now();
        const r   = map.get(id) || { n: 0, reset: now + 60_000 };
        if (now > r.reset) { r.n = 0; r.reset = now + 60_000; }
        r.n++;
        map.set(id, r);
        return r.n <= max;
    };
}
const msgAllowed = makeRateLimiter(SOCKET_MSG_RATE);

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET EVENTS
// ─────────────────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
    const origin = socket.handshake.headers.origin;
    if (NODE_ENV === "production" && !ALLOWED_ORIGINS.includes(origin)) {
        socket.disconnect(true); return;
    }
    console.log(`[+] ${socket.id}`);

    // ── joinRoom ──────────────────────────────────────────────────────────────
    socket.on("joinRoom", ({ username, room } = {}) => {
        const u = sanitizeName(username);
        const r = sanitizeName(room);
        if (!u || !r) return;

        socket.join(r);
        users[socket.id] = { username: u, room: r };

        // Send history
        const history = getMessages().filter((m) => m.room === r);
        socket.emit("chatHistory", history);

        // Notify room
        socket.to(r).emit("systemMessage", `${u} joined the room.`);

        // Broadcast updated member list to everyone (including the new joiner)
        broadcastMembers(r);

        console.log(`[Join] ${u} → #${r} (${getRoomMembers(r).length} members)`);
    });

    // ── sendMessage ───────────────────────────────────────────────────────────
    socket.on("sendMessage", async (data = {}) => {
        if (!msgAllowed(socket.id)) {
            socket.emit("systemMessage", "⏱️ Slow down! You're sending too fast.");
            return;
        }
        const user = users[socket.id];
        if (!user) return;

        const { room } = user;
        const text      = data.text     ? sanitizeText(data.text).slice(0, MAX_MSG_LENGTH) : null;
        const mediaUrl  = data.mediaUrl || null;   // server-relative path from /upload
        const mediaType = data.mediaType || null;  // 'image' | 'video'

        if (!text && !mediaUrl) return;

        // OTP guard
        const otpRegex = /\b\d{6}\b/;
        if (text && otpRegex.test(text) && !data.isConfirmedOTP) {
            socket.emit("privacyAlert", { message: text, mediaUrl, mediaType }); return;
        }

        // Layer 1 — regex instant block
        if (text) {
            const { blocked } = regexTrollCheck(text);
            if (blocked) {
                socket.emit("systemMessage", "⚠️ Message blocked by content filter. Please be respectful.");
                return;
            }
        }

        // Broadcast immediately
        const msgId  = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const msgObj = { id: msgId, username: user.username, room, text, mediaUrl, mediaType, timestamp: new Date() };

        io.to(room).emit("receiveMessage", msgObj);
        saveMsg(msgObj);

    // Layer 2 — Gemini async post-check (text only)
        if (text) {
            checkTrolling(text).then((ai) => {
                if (ai.isTroll) {
                    io.to(room).emit("deleteMessage", { msgId });
                    deleteById(msgId);
                    socket.emit("systemMessage", `🤖 AI Moderator removed your message. ${ai.response}`);
                }
            }).catch((e) => console.error("Gemini:", e.message));
        }
    });

    // ── addComment ────────────────────────────────────────────────────────────
    socket.on("addComment", ({ msgId, text }) => {
        if (!msgAllowed(socket.id)) return;
        const user = users[socket.id];
        if (!user || !msgId || !text) return;

        const safeText = sanitizeText(text).slice(0, 500);
        if (!safeText) return;

        // Add comment to JSON and broadcast
        const msgs = getMessages();
        const targetMsg = msgs.find((m) => m.id === msgId);
        if (targetMsg) {
            if (!targetMsg.comments) targetMsg.comments = [];
            targetMsg.comments.push({ username: user.username, text: safeText, timestamp: new Date() });
            fs.writeFileSync(DATA_FILE, JSON.stringify(msgs, null, 2));
            io.to(user.room).emit("updateComments", { msgId, comments: targetMsg.comments });
        }
    });

    // ── privateMessage ────────────────────────────────────────────────────────
    socket.on("privateMessage", ({ targetUsername, text, mediaUrl, mediaType } = {}) => {
        if (!msgAllowed(socket.id)) return;
        const sender   = users[socket.id]?.username;
        const safeText = sanitizeText(text || "").slice(0, MAX_MSG_LENGTH);
        
        if (!safeText && !mediaUrl) return;

        const targetId = Object.keys(users).find(
            (id) => users[id].username === sanitizeName(targetUsername)
        );
        if (targetId) {
            io.to(targetId).emit("receivePrivateMessage", { sender, text: safeText, mediaUrl, mediaType });
            socket.emit("receivePrivateMessage", { sender: `You → ${targetUsername}`, text: safeText, mediaUrl, mediaType });
        } else {
            socket.emit("systemMessage", `"${sanitizeName(targetUsername)}" is not online.`);
        }
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
            socket.to(user.room).emit("systemMessage", `${user.username} left the room.`);
            broadcastMembers(user.room);  // update member list for remaining users
        }
        console.log(`[-] ${socket.id} (${reason})`);
    });

    socket.on("error", (e) => console.error(`[SocketErr] ${socket.id}:`, e.message));
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
    status: "ok", env: NODE_ENV,
    uptime: Math.round(process.uptime()),
    uploads: fs.readdirSync(UPLOAD_DIR).length + " files",
}));

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║  ✅  SecureChat backend — http://localhost:${PORT}    ║`);
    console.log(`║  📁  Uploads → ${UPLOAD_DIR.slice(-30).padEnd(33)}║`);
    console.log(`║  🌍  Mode: ${NODE_ENV.padEnd(39)}║`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
});
