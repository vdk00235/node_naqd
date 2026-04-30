const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: { origin: "*" }
});
const PORT = process.env.PORT || 3000;

// Security Configuration
const JWT_SECRET = "NAQD_SUPER_SECURE_JWT_2024_KEY_PROD";
const ADMIN_REGISTRATION_KEY = "NAQD_ADMIN_SECRET_2024";

// ========================
// MIDDLEWARE & STABILITY
// ========================

app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Global Request Logger
app.use((req, res, next) => {
  console.log(`[DEBUG] ${new Date().toISOString()} - ${req.method} ${req.url}`);
  const body = req.body || {};
  if (Object.keys(body).length > 0) {
    console.log("BODY:", JSON.stringify(body, null, 2));
  }
  next();
});

// Ensure upload directories exist
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use("/uploads", express.static(uploadDir));

// ========================
// DATABASE INTEGRATION
// ========================

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "naqd",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

pool.on("error", (err) => {
  console.error(">>> [DATABASE CRITICAL ERROR]:", err);
});

// ========================
// AUTH MIDDLEWARE
// ========================

const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ message: "Unauthorized: No token provided" });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(401).json({ message: "Unauthorized: Invalid or expired token" });
      }
      req.user = decoded;
      next();
    });
  } catch (err) {
    console.error("Auth Middleware Error:", err);
    return res.status(500).json({ message: "Internal Auth Error" });
  }
};

const authorizeRole = (role) => {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ message: `Forbidden: ${role} access required` });
    }
    next();
  };
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// ========================
// SOCKET.IO CORE (MERGED)
// ========================

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error("Authentication error"));
    socket.user = decoded;
    next();
  });
});
async function broadcastRoomsGlobal() {
  const [rooms] = await pool.execute("SELECT * FROM rooms");
  io.emit("rooms:update", rooms);
}
io.on("connection", (socket) => {
  const userId = socket.user?.id;
  if (!userId) return;

  console.log(`[SOCKET] User connected: ${userId} (${socket.user.name})`);
  socket.join(`user_${userId}`);

  // -------------------------
  // CHAT SYSTEM EVENTS
  // -------------------------
  socket.on("room:get_members_for_webrtc", async ({ roomId }) => {

  const [members] = await pool.execute(
    "SELECT user_id FROM room_members WHERE room_id = ? AND is_online = 1",
    [roomId]
  );

  socket.emit("room:members_list", members);
});
  socket.on("room:remove_speaker", async ({ roomId, targetUserId }) => {


    if (targetUserId == userId) return;


    const [room] = await pool.execute(
      "SELECT creared_by FROM rooms WHERE id = ?",
      [roomId]
    );

    if (!room[0] || room[0].creared_by != userId) return;

    await pool.execute(
      "UPDATE room_members SET role = 'listener' WHERE room_id = ? AND user_id = ?",
      [roomId, targetUserId]
    );

    io.to(`user_${targetUserId}`).emit("room:removed_from_mic");

    broadcastRoomState(roomId);
  });
  socket.on("room:mute_user", async ({ targetUserId }) => {

    // تحديث في DB
    await pool.execute(
      "UPDATE room_members SET is_muted = 1 WHERE user_id = ?",
      [targetUserId]
    );

    io.to(`user_${targetUserId}`).emit("room:force_mute");
  });
  function broadcastRooms() {
    pool.execute("SELECT * FROM rooms").then(([rooms]) => {
      io.emit("rooms:update", rooms);
    });
  }
  socket.on("send_message", async (data) => {
    try {
      const { receiverId, message } = data;
      if (!receiverId || !message) return;

      // 1. Save to DB


      // 2. Update chat meta
      const u1 = Math.min(userId, receiverId);
      const u2 = Math.max(userId, receiverId);
      await pool.execute(
        "UPDATE chats SET last_message_at = NOW() WHERE user1_id = ? AND user2_id = ?",
        [u1, u2]
      );

      const [result] = await pool.execute(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
        [userId, receiverId, message]
      );

      const msgData = {
        id: result.insertId,
        sender_id: userId,
        receiver_id: receiverId,
        message: message,
        createdAt: new Date()
      };

      // 3. Emit to both (MANDATORY)
      io.to(`user_${receiverId}`).emit("receive_message", msgData);
      socket.emit("receive_message", msgData);

    } catch (err) { console.error("[SOCKET CHAT ERROR]:", err); }
  });

  // -------------------------
  // AUDIO ROOM SYSTEM EVENTS
  // -------------------------
  socket.on("room:join", async ({ roomId }) => {
    try {
      socket.join(`room_${roomId}`);
      const [rooms] = await pool.execute("SELECT * FROM rooms WHERE id = ?", [roomId]);

      if (!rooms[0]) return;
      if (rooms[0].isLive === 0 && rooms[0].creared_by != userId) {
        socket.emit("room:error", "Room is not live");
        return;
      }
      const isOwner = rooms[0].creared_by == userId;
      let role = isOwner ? 'owner' : 'listener';

      await pool.execute(
        "INSERT INTO room_members (user_id, room_id, role, is_online, joined_at) VALUES (?, ?, ?, 1, NOW()) ON DUPLICATE KEY UPDATE is_online = 1",
        [userId, roomId, role]
      );

      broadcastRoomState(roomId);
      // إرسال قائمة الأعضاء لبدء WebRTC
      const [members] = await pool.execute(
        "SELECT user_id FROM room_members WHERE room_id = ? AND is_online = 1",
        [roomId]
      );

      socket.emit("room:members_list", members);
    } catch (err) { console.error("[SOCKET AUDIO JOIN ERROR]:", err); }
  });

  socket.on("room:signal", (data) => {
    io.to(`user_${data.to}`).emit("room:signal", { from: userId, signal: data.signal });
  });

  socket.on("room:request_mic", async ({ roomId }) => {
    try {
      const [pending] = await pool.execute("SELECT id FROM join_requests WHERE room_id = ? AND user_id = ? AND status = 'pending'", [roomId, userId]);
      if (pending.length > 0) return;

      await pool.execute("INSERT INTO join_requests (room_id, user_id, status, created_at) VALUES (?, ?, 'pending', NOW())", [roomId, userId]);
      const [room] = await pool.execute("SELECT creared_by FROM rooms WHERE id = ?", [roomId]);
      if (room[0]) io.to(`user_${room[0].creared_by}`).emit("room_audio:queue_update");
      const [queue] = await pool.execute(`
  SELECT q.*, u.name, u.avatar 
  FROM join_requests q 
  JOIN users u ON q.user_id = u.id 
  WHERE q.room_id = ? AND q.status = 'pending'
`, [roomId]);

      io.to(`user_${room[0].creared_by}`).emit("room:queue_update", queue);
    } catch (err) { console.error("[SOCKET MIC REQUEST ERROR]:", err); }
  });
  //yaour
  socket.on("room:accept_request", async ({ roomId, targetUserId }) => {
    try {
      await pool.execute("UPDATE join_requests SET status = 'accepted' WHERE room_id = ? AND user_id = ?", [roomId, targetUserId]);
      await pool.execute("UPDATE room_members SET role = 'speaker' WHERE room_id = ? AND user_id = ?", [roomId, targetUserId]);
      broadcastRoomState(roomId);
      io.to(`user_${targetUserId}`).emit("room:mic_accepted");
      const [queue] = await pool.execute(`
  SELECT q.*, u.name, u.avatar 
  FROM join_requests q 
  JOIN users u ON q.user_id = u.id 
  WHERE q.room_id = ? AND q.status = 'pending'
`, [roomId]);

      const [room] = await pool.execute(
        "SELECT creared_by FROM rooms WHERE id = ?",
        [roomId]
      );
      broadcastRoomState(roomId);
      
      io.to(`user_${room[0].creared_by}`).emit("room:queue_update", queue);
    } catch (err) { console.error("[SOCKET ACCEPT ERROR]:", err); }
  });

  socket.on("room:reject_request", async ({ roomId, targetUserId }) => {
    try {
      await pool.execute("UPDATE join_requests SET status = 'rejected' WHERE room_id = ? AND user_id = ?", [roomId, targetUserId]);
      io.to(`user_${targetUserId}`).emit("room:error", "Mic request rejected");
    } catch (err) { console.error("[SOCKET REJECT ERROR]:", err); }
  });

  socket.on("room:send_message", async ({ roomId, message }) => {
    try {

      const [result] = await pool.execute(
        "INSERT INTO room_messages (room_id, sender_id, content, created_at) VALUES (?, ?, ?, NOW())",
        [roomId, userId, message]
      );
      const [rows] = await pool.execute(
        'SELECT avatar FROM users WHERE id = ?',
        [userId]
      );
      const avatar = rows[0].avatar

      const msgData = {
        id: result.insertId,
        room_id: roomId,
        sender_id: userId,
        content: message,
        name: socket.user.name,
        avatar: avatar,
        created_at: new Date()
      };

      io.to(`room_${roomId}`).emit("room:new_message", msgData);

    } catch (err) {
      console.error(err);
    }
  });

  socket.on("room:leave", async ({ roomId }) => {
    try {
      const [room] = await pool.execute(
        "SELECT creared_by FROM rooms WHERE id = ?",
        [roomId]
      );

      // إذا هو owner
      if (room[0] && room[0].creared_by == userId) {

        await pool.execute(
          "UPDATE rooms SET isLive = 0 WHERE id = ?",
          [roomId]
        );

        io.to(`room_${roomId}`).emit("room:close");

        await pool.execute(
          "UPDATE room_members SET is_online = 0 WHERE room_id = ?",
          [roomId]
        );
        await pool.execute(
          "DELETE FROM join_requests WHERE room_id = ?",
          [roomId]
        );

        await pool.execute(
          "DELETE FROM room_members WHERE room_id = ?",
          [roomId]
        );
        broadcastRooms(); // 🔥 مهم
      } else {
        handleAudioLeave(roomId, userId);
      }

      socket.leave(`room_${roomId}`);

    } catch (err) {
      console.error(err);
    }
  });
  socket.on("disconnect", () => {
    console.log(`[SOCKET] User disconnected: ${userId}`);
  });

  // Helper functions
  async function broadcastRoomState(roomId) {
    const [members] = await pool.execute(
      "SELECT m.*, u.name, u.avatar FROM room_members m JOIN users u ON m.user_id = u.id WHERE m.room_id = ? AND m.is_online = 1",
      [roomId]
    );
    const [owner] = await pool.execute(`SELECT u.name, u.avatar FROM rooms r JOIN users u ON r.creared_by = u.id WHERE r.id = ?`, [roomId]);
    io.to(`room_${roomId}`).emit("room:update_state", { members, owner: owner[0] });

    if (owner[0]) {
      const [queue] = await pool.execute("SELECT q.*, u.name, u.avatar FROM join_requests q JOIN users u ON q.user_id = u.id WHERE q.room_id = ? AND q.status = 'pending'", [roomId]);
      io.to(`user_${members.find(m => m.role === 'owner')?.user_id}`).emit("room:queue_update", queue);
    }
  }

  async function handleAudioLeave(roomId, uid) {
    try {
      await pool.execute("UPDATE room_members SET is_online = 0 WHERE room_id = ? AND user_id = ?", [roomId, uid]);
      broadcastRoomState(roomId);
    } catch (e) { }
  }
});

// ========================
// API ROUTES
// ========================

app.post("/api/auth/register", upload.single("avatar"), async (req, res) => {
  try {
    const { name, password } = req.body || {};
    const avatar = req.file ? req.file.filename : null;
    if (!name || !password) return res.status(400).json({ message: "Name and password required" });
    const [rows] = await pool.execute("SELECT id FROM users WHERE name = ?", [name]);
    if (rows.length > 0) {
      return res.status(400).json({ message: "Username already exists" });
    }
    const hashedPassword = await bcrypt.hash(password, 12);
    const [result] = await pool.execute("INSERT INTO users (name, password, avatar, role, coins) VALUES (?, ?, ?, 'user', 0)", [name, hashedPassword, avatar]);
    return res.status(201).json({ message: "User registered successfully", user: { id: result.insertId, name, role: "user" } });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ message: "Username already exists" });
    return res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/auth/register-admin", upload.single("avatar"), async (req, res) => {
  try {
    const { name, password, adminKey } = req.body || {};
    const avatar = req.file ? req.file.filename : null;
    const [rows] = await pool.execute("SELECT id FROM users WHERE name = ?", [name]);
    if (rows.length > 0) {
      return res.status(400).json({ message: "Username already exists" });
    }
    if (adminKey !== ADMIN_REGISTRATION_KEY) return res.status(403).json({ message: "Invalid Admin Key" });
    const hashedPassword = await bcrypt.hash(password, 12);
    const [result] = await pool.execute("INSERT INTO users (name, password, avatar, role, gift_send, gift_resnd, coins) VALUES (?, ?, ?, 'admin', 0, 0, 0)", [name, hashedPassword, avatar]);
    return res.status(201).json({ message: "Admin registered successfully", user: { id: result.insertId, name, role: "admin" } });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { name, password } = req.body || {};
    const [rows] = await pool.execute("SELECT * FROM users WHERE name = ?", [name]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password))) return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ id: rows[0].id, name: rows[0].name, role: rows[0].role }, JWT_SECRET, { expiresIn: "7d" });
    const { password: _, ...userInfo } = rows[0];
    return res.status(200).json({ message: "Login successful", token, role: rows[0].role, user: userInfo });
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

app.get("/api/plans", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT * FROM plans");
    return res.json(rows);
  } catch (err) { return res.status(500).json({ message: "Error" }); }
});

app.get("/api/rooms", authenticateToken, async (req, res) => {
  try {
    const [rooms] = await pool.execute("SELECT * FROM rooms");
    return res.json(rooms);
  } catch (err) { return res.status(500).json({ message: "Error" }); }
});

app.get("/api/friends/requests", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.execute(
      `SELECT 
        fr.id,
        fr.fromUserId,
        fr.toUserId,
        fr.status,
        fr.createdAt,
        u.name AS fromUserName,
        u.avatar AS fromUserAvatar
       FROM friend_requests fr
       JOIN users u ON fr.fromUserId = u.id
       WHERE fr.toUserId = ? AND fr.status = 'pending'
       ORDER BY fr.createdAt DESC`,
      [userId]
    );

    res.json(rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error loading requests" });
  }
});

app.post("/api/friends/accept", authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.body;

    // 1. جلب الطلب
    const [reqRows] = await pool.execute(
      "SELECT * FROM friend_requests WHERE id = ?",
      [requestId]
    );

    if (!reqRows[0]) {
      return res.status(404).json({ message: "Request not found" });
    }

    const request = reqRows[0];

    // 2. تحديث الحالة
    await pool.execute(
      "UPDATE friend_requests SET status = 'accepted' WHERE id = ?",
      [requestId]
    );

    // 3. إنشاء chat (اختياري لكن مهم)
    const u1 = Math.min(request.fromUserId, request.toUserId);
    const u2 = Math.max(request.fromUserId, request.toUserId);

    await pool.execute(
      "INSERT IGNORE INTO chats (user1_id, user2_id, last_message_at) VALUES (?, ?, NOW())",
      [u1, u2]
    );

    res.json({ message: "Friend request accepted" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error" });
  }
});

app.post("/api/friends/reject", authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.body;

    await pool.execute(
      "UPDATE friend_requests SET status = 'rejected' WHERE id = ?",
      [requestId]
    );

    res.json({ message: "Request rejected" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error" });
  }
});

app.get("/api/subscriptions/me", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.execute(
      `SELECT 
        s.id,
        s.user_id,
        s.plan_id,
        s.status,
        s.start_date,
        s.end_date,
        s.room_existe,
        p.name AS plan_name
       FROM subscriptions s
       JOIN plans p ON s.plan_id = p.id
       WHERE s.user_id = ?
       ORDER BY s.id DESC
       LIMIT 1`,
      [userId]
    );

    // ❌ لا يوجد اشتراك نهائياً
    if (rows.length === 0) {
      return res.json({
        hasSubscription: false
      });
    }

    const sub = rows[0];

    // تحديث انتهاء تلقائي
    const now = new Date();
    const isExpired = sub.end_date && new Date(sub.end_date) < now;

    if (isExpired && sub.status !== "expired") {
      await pool.execute(
        "UPDATE subscriptions SET status = 'expired' WHERE id = ?",
        [sub.id]
      );
      sub.status = "expired";
    }

    let allowed = false;

    if (sub.status === "active" && sub.room_existe === 0) {
      allowed = true;
    }

    res.json({
      hasSubscription: true,
      subscription: sub,
      allowed: allowed
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/subscriptions/create", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan_id } = req.body;

    const [active] = await pool.execute(
      `SELECT * FROM subscriptions 
   WHERE user_id = ? 
   AND status = 'active'
   AND end_date > NOW()`,
      [userId]
    );

    if (active.length > 0) {
      return res.status(400).json({
        message: "You already have an active subscription until it expires"
      });
    }

    if (active.length > 0) {
      return res.status(400).json({ message: "You already have an active subscription" });
    }

    // 2. جلب الباقة
    const [plans] = await pool.execute(
      "SELECT * FROM plans WHERE id = ?",
      [plan_id]
    );

    if (plans.length === 0) {
      return res.status(404).json({ message: "Plan not found" });
    }

    const plan = plans[0];

    // 3. جلب المستخدم
    const [users] = await pool.execute(
      "SELECT coins FROM users WHERE id = ?",
      [userId]
    );

    if (!users.length) {
      return res.status(404).json({ message: "User not found" });
    }

    // 4. تحقق الرصيد
    if (users[0].coins < plan.price) {
      return res.status(400).json({ message: "Not enough coins" });
    }

    // 5. خصم العملات
    await pool.execute(
      "UPDATE users SET coins = coins - ? WHERE id = ?",
      [plan.price, userId]
    );

    // 6. حساب انتهاء الاشتراك
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + plan.expire_date);

    // 7. إنشاء الاشتراك
    await pool.execute(
      `INSERT INTO subscriptions (user_id, plan_id, status, room_existe, end_date)
       VALUES (?, ?, 'active', 0, ?)`,
      [userId, plan_id, endDate]
    );

    res.json({ message: "Subscription created successfully" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/rooms/create", authenticateToken, upload.single("logo"), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { name } = req.body || {};
    const logo = req.file ? `/uploads/${req.file.filename}` : null;
    if (!name) return res.status(400).json({ message: "Name required" });

    await connection.beginTransaction();
    const [subs] = await connection.execute("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' AND room_existe = 0", [req.user.id]);
    if (!subs[0]) { await connection.rollback(); return res.status(403).json({ message: "No active sub or room exists" }); }
    const [plans] = await connection.execute("SELECT max_users, number_mics FROM plans WHERE id = ?", [subs[0].plan_id]);

    await connection.execute(`
      INSERT INTO rooms (name, logo, plan_id, number_mic, creared_by, status, isLive, max_users, created_at, expires_at, subscriptions_id)
      VALUES (?, ?, ?, ?, ?, 'active', 0, ?, CURRENT_DATE, ?, ?)
    `, [name, logo, subs[0].plan_id, plans[0].number_mics, req.user.id, plans[0].max_users, subs[0].end_date, subs[0].id]);

    await connection.execute("UPDATE subscriptions SET room_existe = 1 WHERE id = ?", [subs[0].id]);
    await connection.commit();
    return res.status(201).json({ message: "Room created successfully" });
  } catch (err) { if (connection) await connection.rollback(); return res.status(500).json({ message: "Error" }); }
  finally { connection.release(); }
});

app.post("/api/rooms/start", authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.body || {};
    const [rooms] = await pool.execute("SELECT * FROM rooms WHERE id = ?", [roomId]);
    if (!rooms[0] || (rooms[0].creared_by != req.user.id && req.user.role !== 'admin')) return res.status(403).json({ message: "Unauthorized" });

    await pool.execute(`
  UPDATE rooms 
  SET isLive = 1, last_live_time = NOW() 
  WHERE id = ?
`, [roomId]);

    broadcastRoomsGlobal(); // 🔥 أضف هذا بعد التحديث
    await pool.execute("INSERT INTO room_members (user_id, room_id, role, is_online, joined_at) VALUES (?, ?, 'owner', 1, NOW()) ON DUPLICATE KEY UPDATE role = 'owner', is_online = 1", [rooms[0].creared_by, roomId]);

    return res.json({ success: true, roomId });
  } catch (err) { return res.status(500).json({ message: "Error" }); }
});

app.get("/api/users/search", authenticateToken, async (req, res) => {
  try {
    const { q } = req.query;
    const [users] = await pool.execute("SELECT id, name, avatar FROM users WHERE name LIKE CONCAT('%', ?, '%') AND id != ? LIMIT 20", [q || "", req.user.id]);
    return res.json(users);
  } catch (err) { return res.status(500).json({ message: "Error" }); }
});

app.post("/api/friends/request", authenticateToken, async (req, res) => {
  try {
    const { toUserId } = req.body;
    await pool.execute("INSERT INTO friend_requests (fromUserId, toUserId, status) VALUES (?, ?, 'pending')", [req.user.id, toUserId]);
    io.to(`user_${toUserId}`).emit("new_friend_request", { fromUserId: req.user.id, fromUserName: req.user.name });
    return res.json({ message: "Sent" });
  } catch (err) { return res.status(500).json({ message: err }); }
});

app.post("/api/friends/accept", authenticateToken, async (req, res) => {
  try {
    io.to(`user_${req.user.id}`).emit("chat_created");
    return res.json({ message: "Accepted" });
  } catch (err) { return res.status(500).json({ message: "Error" }); }
});

app.get("/api/chats", authenticateToken, async (req, res) => {
  try {
    const [chats] = await pool.execute(`SELECT c.*, u.id as friendId, u.name as friendName, u.avatar as friendAvatar FROM chats c JOIN users u ON (c.user1_id = u.id OR c.user2_id = u.id) WHERE (c.user1_id = ? OR c.user2_id = ?) AND u.id != ? ORDER BY c.last_message_at DESC`, [req.user.id, req.user.id, req.user.id]);
    return res.json(chats);
  } catch (err) { return res.status(500).json({ message: "Error" }); }
});

app.get("/api/messages/:userId", authenticateToken, async (req, res) => {
  try {
    const [msgs] = await pool.execute(`SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY createdAt ASC`, [req.user.id, req.params.userId, req.params.userId, req.user.id]);
    return res.json(msgs);
  } catch (err) { return res.status(500).json({ message: "Error" }); }
});

app.get("/api/rooms/messages/:roomId", authenticateToken, async (req, res) => {
  try {
    const roomId = req.params.roomId;

    const [room] = await pool.execute(
      "SELECT last_live_time FROM rooms WHERE id = ?",
      [roomId]
    );

    if (!room[0]) return res.json([]);

    const [messages] = await pool.execute(`
      SELECT 
        rm.*, 
        u.name, 
        u.avatar 
      FROM room_messages rm
      JOIN users u ON rm.sender_id = u.id
      WHERE rm.room_id = ?
      AND rm.created_at >= ?
      ORDER BY rm.created_at ASC
    `, [roomId, room[0].last_live_time]);

    res.json(messages);

  } catch (err) {
    res.status(500).json({ message: "Error" });
  }
});

// 404 Handler - MUST BE LAST
app.use((req, res) => {
  return res.status(404).json({ message: `Route ${req.url} not found` });
});

// START SERVER
server.listen(PORT, () => {
  console.log("\n========================================");
  console.log(`SERVER RUNNING ON http://localhost:${PORT}`);
  console.log("Database connected & Socket.io Ready");
  console.log("========================================\n");
});