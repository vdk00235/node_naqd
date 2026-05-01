const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");
const console = require("console");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: { origin: "*" }
});
const PORT = process.env.PORT || 3000;
const UPLOADS_BASE_URL = `http://192.168.137.2:${PORT}`;

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

const giftsUpload = upload.fields([
  { name: "image", maxCount: 1 },
  { name: "video", maxCount: 1 }
]);

function deleteUploadFile(filePath) {
  if (!filePath) return;

  const normalized = filePath.startsWith("/uploads/")
    ? filePath.replace("/uploads/", "")
    : filePath;

  const absolutePath = path.join(uploadDir, normalized);

  if (fs.existsSync(absolutePath)) {
    try {
      fs.unlinkSync(absolutePath);
    } catch (err) {
      console.error("Failed to delete upload file:", absolutePath, err);
    }
  }
}

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

async function sendRoomQueueUpdate(roomId) {
  const [roomRows] = await pool.execute(
    "SELECT creared_by FROM rooms WHERE id = ?",
    [roomId]
  );

  if (!roomRows[0]) return;

  const [queue] = await pool.execute(`
    SELECT q.*, u.name, u.avatar
    FROM join_requests q
    JOIN users u ON q.user_id = u.id
    WHERE q.room_id = ? AND q.status = 'pending'
    ORDER BY q.created_at ASC
  `, [roomId]);

  io.to(`user_${roomRows[0].creared_by}`).emit("room:queue_update", queue);
}

async function emitRoomClosed(roomId) {
  io.to(`room_${roomId}`).emit("room:close");
  io.emit("room:live_status", {
    roomId,
    isLive: 0
  });
  await broadcastRoomsGlobal();
}

async function closeRoom(roomId) {
  await pool.execute(
    "UPDATE rooms SET isLive = 0 WHERE id = ?",
    [roomId]
  );

  await pool.execute(
    "UPDATE room_members SET is_online = 0 WHERE room_id = ?",
    [roomId]
  );

  await pool.execute(
    "DELETE FROM join_requests WHERE room_id = ?",
    [roomId]
  );

  await emitRoomClosed(roomId);
}

async function createUserNotification({
  userId,
  type,
  title,
  message,
  roomId = null
}) {
  const [result] = await pool.execute(
    `INSERT INTO notifications (user_id, type, title, message, room_id, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [userId, type, title, message, roomId]
  );

  const [[notification]] = await pool.execute(
    "SELECT * FROM notifications WHERE id = ? LIMIT 1",
    [result.insertId]
  );

  io.to(`user_${userId}`).emit("new_notification", notification);
  return notification;
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
      `SELECT rm.user_id
       FROM room_members rm
       JOIN users u ON rm.user_id = u.id
       WHERE rm.room_id = ? AND rm.is_online = 1`,
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
      "UPDATE room_members SET role = 'listener', is_muted = 0 WHERE room_id = ? AND user_id = ? AND role = 'speaker'",
      [roomId, targetUserId]
    );

    io.to(`user_${targetUserId}`).emit("room:removed_from_mic");

    broadcastRoomState(roomId);
  });
  socket.on("room:leave_speaker", async ({ roomId }) => {
    try {
      await pool.execute(
        "UPDATE room_members SET role = 'listener', is_muted = 0 WHERE room_id = ? AND user_id = ? AND role = 'speaker'",
        [roomId, userId]
      );

      io.to(`user_${userId}`).emit("room:removed_from_mic");
      broadcastRoomState(roomId);
    } catch (err) {
      console.error("[SOCKET LEAVE SPEAKER ERROR]:", err);
    }
  });
  socket.on("room:mute_user", async ({ roomId, targetUserId }) => {
    const [room] = await pool.execute(
      "SELECT creared_by FROM rooms WHERE id = ?",
      [roomId]
    );

    if (!room[0] || room[0].creared_by != userId || targetUserId == userId) return;

    await pool.execute(
      "UPDATE room_members SET is_muted = 1 WHERE room_id = ? AND user_id = ?",
      [roomId, targetUserId]
    );

    io.to(`user_${targetUserId}`).emit("room:force_mute");
    broadcastRoomState(roomId);
  });
  socket.on("room:self_mute", async ({ roomId, isMuted }) => {
    try {
      await pool.execute(
        "UPDATE room_members SET is_muted = ? WHERE room_id = ? AND user_id = ? AND role IN ('owner', 'speaker')",
        [isMuted ? 1 : 0, roomId, userId]
      );

      broadcastRoomState(roomId);
    } catch (err) {
      console.error("[SOCKET SELF MUTE ERROR]:", err);
    }
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

      const u1 = Math.min(userId, receiverId);
      const u2 = Math.max(userId, receiverId);

      const [chatRows] = await pool.execute(
        "SELECT id FROM chats WHERE user1_id = ? AND user2_id = ? LIMIT 1",
        [u1, u2]
      );

      if (!chatRows[0]) {
        socket.emit("chat:error", "You can only message accepted friends");
        return;
      }

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
        "INSERT INTO room_members (user_id, room_id, role, is_online, is_muted, joined_at) VALUES (?, ?, ?, 1, 0, NOW()) ON DUPLICATE KEY UPDATE role = IF(VALUES(role) = 'owner', 'owner', role), is_online = 1",
        [userId, roomId, role]
      );

      broadcastRoomState(roomId);
      if (isOwner) {
        sendRoomQueueUpdate(roomId);
      }
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
      const [memberRows] = await pool.execute(
        "SELECT role FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
        [roomId, userId]
      );

      if (!memberRows[0] || memberRows[0].role !== "listener") {
        return;
      }

      const [pending] = await pool.execute("SELECT id FROM join_requests WHERE room_id = ? AND user_id = ? AND status = 'pending'", [roomId, userId]);
      if (pending.length > 0) return;

      await pool.execute("INSERT INTO join_requests (room_id, user_id, status, created_at) VALUES (?, ?, 'pending', NOW())", [roomId, userId]);
      sendRoomQueueUpdate(roomId);
    } catch (err) { console.error("[SOCKET MIC REQUEST ERROR]:", err); }
  });
  //yaour
  socket.on("room:accept_request", async ({ roomId, targetUserId }) => {
    try {
      const [room] = await pool.execute(
        "SELECT creared_by FROM rooms WHERE id = ?",
        [roomId]
      );

      if (!room[0] || room[0].creared_by != userId) return;

      await pool.execute("UPDATE join_requests SET status = 'accepted' WHERE room_id = ? AND user_id = ?", [roomId, targetUserId]);
      await pool.execute("UPDATE room_members SET role = 'speaker', is_muted = 0 WHERE room_id = ? AND user_id = ?", [roomId, targetUserId]);
      broadcastRoomState(roomId);
      io.to(`user_${targetUserId}`).emit("room:mic_accepted");
      broadcastRoomState(roomId);
      sendRoomQueueUpdate(roomId);
    } catch (err) { console.error("[SOCKET ACCEPT ERROR]:", err); }
  });

  socket.on("room:reject_request", async ({ roomId, targetUserId }) => {
    try {
      const [room] = await pool.execute(
        "SELECT creared_by FROM rooms WHERE id = ?",
        [roomId]
      );

      if (!room[0] || room[0].creared_by != userId) return;

      await pool.execute("UPDATE join_requests SET status = 'rejected' WHERE room_id = ? AND user_id = ?", [roomId, targetUserId]);
      io.to(`user_${targetUserId}`).emit("room:error", "Mic request rejected");
      sendRoomQueueUpdate(roomId);
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

  socket.on("room:send_gift", async ({ roomId, giftId }) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [[room]] = await connection.execute(
        `SELECT r.id, r.name, r.creared_by, u.name AS owner_name
         FROM rooms r
         JOIN users u ON u.id = r.creared_by
         WHERE r.id = ? LIMIT 1`,
        [roomId]
      );

      if (!room) {
        await connection.rollback();
        socket.emit("room:gift_error", "ROOM_NOT_FOUND");
        return;
      }

      const [[gift]] = await connection.execute(
        "SELECT * FROM gifts WHERE id = ? LIMIT 1",
        [giftId]
      );

      if (!gift) {
        await connection.rollback();
        socket.emit("room:gift_error", "GIFT_NOT_FOUND");
        return;
      }

      const [[sender]] = await connection.execute(
        "SELECT id, name, coins FROM users WHERE id = ? LIMIT 1",
        [userId]
      );

      if (!sender || Number(sender.coins) < Number(gift.points)) {
        await connection.rollback();
        socket.emit("room:gift_error", "INSUFFICIENT_BALANCE");
        return;
      }

      await connection.execute(
        "UPDATE users SET coins = coins - ?, gift_send = COALESCE(gift_send, 0) + ? WHERE id = ?",
        [gift.points, gift.points, userId]
      );

      await connection.execute(
        "UPDATE users SET coins = coins + ?, gift_resnd = COALESCE(gift_resnd, 0) + ? WHERE id = ?",
        [gift.points, gift.points, room.creared_by]
      );

      await connection.commit();

      io.to(`room_${roomId}`).emit("room:new_gift", {
        roomId,
        giftId: gift.id,
        giftName: gift.name,
        giftPoints: gift.points,
        imageUrl: gift.image ? `${UPLOADS_BASE_URL}${gift.image}` : null,
        videoUrl: gift.video ? `${UPLOADS_BASE_URL}${gift.video}` : null,
        senderId: sender.id,
        senderName: sender.name,
        receiverId: room.creared_by,
        receiverName: room.owner_name,
        createdAt: new Date()
      });

      socket.emit("room:gift_sent", {
        remainingCoins: Number(sender.coins) - Number(gift.points)
      });
    } catch (err) {
      await connection.rollback();
      console.error("[SOCKET ROOM GIFT ERROR]:", err);
      socket.emit("room:gift_error", "SEND_GIFT_FAILED");
    } finally {
      connection.release();
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
        await closeRoom(roomId);
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
      `SELECT
        m.*,
        u.name,
        u.avatar,
        u.role AS account_role
      FROM room_members m
      JOIN users u ON m.user_id = u.id
      WHERE m.room_id = ? AND m.is_online = 1`,
      [roomId]
    );

    const visibleMembers = members.filter((member) => member.account_role !== "admin");
    const viewers = visibleMembers.length;

    const [owner] = await pool.execute(
      `SELECT
        r.id,
        r.name,
        r.logo,
        r.number_mic,
        r.max_users,
        r.creared_by,
        r.isLive,
        u.name AS owner_name,
        u.avatar AS owner_avatar
      FROM rooms r
      JOIN users u ON r.creared_by = u.id
      WHERE r.id = ?`,
      [roomId]
    );

    io.to(`room_${roomId}`).emit("room:update_state", {
      roomId,
      members: visibleMembers,
      owner: {
        name: owner[0]?.owner_name,
        avatar: owner[0]?.owner_avatar
      },
      room: owner[0],
      viewers
    });
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
    const [rooms] = await pool.execute(`
      SELECT 
        rooms.*,
        users.name AS creatorName,
        users.avatar AS creatorAvatar,
        COALESCE(viewers.total, 0) AS views
      FROM rooms
      LEFT JOIN users ON rooms.creared_by = users.id
      LEFT JOIN (
        SELECT 
          rm.room_id,
          COUNT(*) AS total
        FROM room_members rm
        JOIN users u ON rm.user_id = u.id
        WHERE rm.is_online = 1 AND u.role != 'admin'
        GROUP BY rm.room_id
      ) viewers ON viewers.room_id = rooms.id
    `);
    return res.json(rooms);
  } catch (err) {
    return res.status(500).json({ message: "Error" });
  }
});
app.get('/api/rooms/number_views/:roomId', authenticateToken, async (req, res) => {
  try {
    const roomId = req.params.roomId;

    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS total
       FROM room_members rm
       JOIN users u ON rm.user_id = u.id
       WHERE rm.room_id = ? AND rm.is_online = 1 AND u.role != 'admin'`,
      [roomId]
    );

    return res.json({
      views: rows[0].total
    });

  } catch (err) {
    return res.status(500).json({ message: "Error" });
  }
});
app.get("/api/my_room", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.execute(
      "SELECT * FROM rooms WHERE creared_by = ? LIMIT 1",
      [userId]
    );

    const room = rows.length > 0 ? rows[0] : null;
    return res.json({
      hasRoom: room !== null,
      room: room,
      isLive: room ? room.isLive === 1 : false
    });

  } catch (err) {
    return res.status(500).json({ message: "Error" });
  }
});

app.get("/api/dashboard/me", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [[userStats]] = await pool.execute(`
      SELECT
        COALESCE(gift_send, 0) AS giftSent,
        COALESCE(gift_resnd, 0) AS giftReceived,
        COALESCE(coins, 0) AS coins
      FROM users
      WHERE id = ?
      LIMIT 1
    `, [userId]);

    const [[friendsRow]] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM chats
      WHERE user1_id = ? OR user2_id = ?
    `, [userId, userId]);

    const [[requestsRow]] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM friend_requests
      WHERE toUserId = ? AND status = 'pending'
    `, [userId]);

    const [[roomsRow]] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM rooms
      WHERE creared_by = ?
    `, [userId]);

    const [[directMessagesRow]] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM messages
      WHERE sender_id = ? OR receiver_id = ?
    `, [userId, userId]);

    const [[roomMessagesRow]] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM room_messages rm
      JOIN rooms r ON r.id = rm.room_id
      WHERE r.creared_by = ?
    `, [userId]);

    const [[liveRoomRow]] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM rooms
      WHERE creared_by = ? AND isLive = 1
    `, [userId]);

    const [activities] = await pool.execute(`
      SELECT * FROM (
        SELECT
          CONCAT(u.name, ' أرسل لك طلب صداقة') AS text,
          fr.createdAt AS createdAt
        FROM friend_requests fr
        JOIN users u ON u.id = fr.fromUserId
        WHERE fr.toUserId = ?

        UNION ALL

        SELECT
          CASE
            WHEN m.sender_id = ? THEN CONCAT('أرسلت رسالة إلى ', u.name)
            ELSE CONCAT('استلمت رسالة من ', u.name)
          END AS text,
          m.createdAt AS createdAt
        FROM messages m
        JOIN users u ON u.id = CASE
          WHEN m.sender_id = ? THEN m.receiver_id
          ELSE m.sender_id
        END
        WHERE m.sender_id = ? OR m.receiver_id = ?

        UNION ALL

        SELECT
          CONCAT('تم إرسال ', COUNT(*), ' رسالة داخل غرفتك ', r.name) AS text,
          MAX(rm.created_at) AS createdAt
        FROM room_messages rm
        JOIN rooms r ON r.id = rm.room_id
        WHERE r.creared_by = ?
        GROUP BY r.id, r.name
      ) timeline
      ORDER BY createdAt DESC
      LIMIT 6
    `, [userId, userId, userId, userId, userId, userId]);

    res.json({
      stats: {
        giftSent: userStats?.giftSent ?? 0,
        giftReceived: userStats?.giftReceived ?? 0,
        coins: userStats?.coins ?? 0,
        friendsCount: friendsRow?.total ?? 0,
        pendingRequests: requestsRow?.total ?? 0,
        roomsCount: roomsRow?.total ?? 0,
        directMessagesCount: directMessagesRow?.total ?? 0,
        roomMessagesCount: roomMessagesRow?.total ?? 0,
        liveRoomsCount: liveRoomRow?.total ?? 0
      },
      activities
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error loading dashboard" });
  }
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

app.get("/api/notifications", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [friendRequests] = await pool.execute(
      `SELECT
        fr.id,
        'friend_request' AS type,
        u.name AS senderName,
        u.avatar AS senderAvatar,
        'طلب صداقة جديد' AS title,
        CONCAT(u.name, ' أرسل لك طلب صداقة') AS message,
        fr.createdAt AS createdAt,
        fr.status,
        fr.fromUserId
       FROM friend_requests fr
       JOIN users u ON fr.fromUserId = u.id
       WHERE fr.toUserId = ? AND fr.status = 'pending'`,
      [userId]
    );

    const [warnings] = await pool.execute(
      `SELECT
        n.id,
        n.type,
        n.title,
        n.message,
        n.created_at AS createdAt,
        n.room_id AS roomId,
        r.name AS roomName
       FROM notifications n
       LEFT JOIN rooms r ON r.id = n.room_id
       WHERE n.user_id = ?
       ORDER BY n.created_at DESC`,
      [userId]
    );

    const merged = [...friendRequests, ...warnings].sort((a, b) => {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error loading notifications" });
  }
});

app.get("/api/admin/rooms", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const [rooms] = await pool.execute(`
      SELECT
        r.*,
        u.name AS ownerName,
        u.avatar AS ownerAvatar,
        COALESCE(online.total, 0) AS onlineUsers
      FROM rooms r
      LEFT JOIN users u ON r.creared_by = u.id
      LEFT JOIN (
        SELECT room_id, COUNT(*) AS total
        FROM room_members
        WHERE is_online = 1
        GROUP BY room_id
      ) online ON online.room_id = r.id
      ORDER BY r.id DESC
    `);

    const roomIds = rooms.map((room) => room.id);
    let members = [];

    if (roomIds.length > 0) {
      const placeholders = roomIds.map(() => "?").join(",");
      const [memberRows] = await pool.execute(
        `SELECT rm.room_id, u.avatar
         FROM room_members rm
         JOIN users u ON u.id = rm.user_id
         WHERE rm.room_id IN (${placeholders}) AND rm.is_online = 1
         ORDER BY rm.joined_at DESC`,
        roomIds
      );
      members = memberRows;
    }

    const payload = rooms.map((room) => ({
      ...room,
      users: members
        .filter((member) => member.room_id === room.id)
        .map((member) => member.avatar)
        .filter(Boolean)
        .slice(0, 6)
    }));

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error loading admin rooms" });
  }
});

app.post("/api/admin/rooms/:id/toggle", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const [[room]] = await pool.execute(
      "SELECT * FROM rooms WHERE id = ? LIMIT 1",
      [id]
    );

    if (!room) {
      return res.status(404).json({ message: "Room not found" });
    }

    if (room.isLive === 1) {
      await closeRoom(id);
      return res.json({ success: true, isLive: 0 });
    }

    await pool.execute(
      `UPDATE rooms
       SET isLive = 1, last_live_time = NOW()
       WHERE id = ?`,
      [id]
    );

    await pool.execute(
      "INSERT INTO room_members (user_id, room_id, role, is_online, is_muted, joined_at) VALUES (?, ?, 'owner', 1, 0, NOW()) ON DUPLICATE KEY UPDATE role = 'owner', is_online = 1, is_muted = 0",
      [room.creared_by, id]
    );

    await broadcastRoomsGlobal();
    io.emit("room:live_status", {
      roomId: Number(id),
      isLive: 1
    });

    res.json({ success: true, isLive: 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error toggling room" });
  }
});

app.post("/api/admin/rooms/:id/warning", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body || {};

    if (!message || !message.toString().trim()) {
      return res.status(400).json({ message: "Warning message is required" });
    }

    const [[room]] = await pool.execute(
      "SELECT id, name, creared_by FROM rooms WHERE id = ? LIMIT 1",
      [id]
    );

    if (!room) {
      return res.status(404).json({ message: "Room not found" });
    }

    const notification = await createUserNotification({
      userId: room.creared_by,
      type: "warning",
      title: "تحذير من الإدارة",
      message: `الغرفة ${room.name}: ${message.toString().trim()}`,
      roomId: room.id
    });

    res.json(notification);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error sending warning" });
  }
});

app.post("/api/friends/accept", authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.body;

    const [reqRows] = await pool.execute(
      "SELECT * FROM friend_requests WHERE id = ? AND toUserId = ? AND status = 'pending'",
      [requestId, req.user.id]
    );

    if (!reqRows[0]) {
      return res.status(404).json({ message: "Pending request not found" });
    }

    const request = reqRows[0];

    await pool.execute(
      "UPDATE friend_requests SET status = 'accepted' WHERE id = ?",
      [requestId]
    );

    const u1 = Math.min(request.fromUserId, request.toUserId);
    const u2 = Math.max(request.fromUserId, request.toUserId);

    await pool.execute(
      "INSERT IGNORE INTO chats (user1_id, user2_id, last_message_at) VALUES (?, ?, NOW())",
      [u1, u2]
    );

    io.to(`user_${request.fromUserId}`).emit("chat_created", {
      friendId: request.toUserId
    });
    io.to(`user_${request.toUserId}`).emit("chat_created", {
      friendId: request.fromUserId
    });
    io.to(`user_${request.fromUserId}`).emit("friend_request_updated", {
      requestId,
      status: "accepted"
    });
    io.to(`user_${request.toUserId}`).emit("friend_request_updated", {
      requestId,
      status: "accepted"
    });

    res.json({ message: "Friend request accepted" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error" });
  }
});

app.post("/api/friends/reject", authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.body;

    const [reqRows] = await pool.execute(
      "SELECT id FROM friend_requests WHERE id = ? AND toUserId = ? AND status = 'pending'",
      [requestId, req.user.id]
    );

    if (!reqRows[0]) {
      return res.status(404).json({ message: "Pending request not found" });
    }

    await pool.execute(
      "UPDATE friend_requests SET status = 'rejected' WHERE id = ?",
      [requestId]
    );

    io.to(`user_${req.user.id}`).emit("friend_request_updated", {
      requestId,
      status: "rejected"
    });

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

    // 1. إنشاء الغرفة
    const [result] = await connection.execute(`
  INSERT INTO rooms (
    name,
    logo,
    plan_id,
    number_mic,
    creared_by,
    status,
    isLive,
    max_users,
    created_at,
    expires_at,
    subscriptions_id
  )
  VALUES (?, ?, ?, ?, ?, 'active', 0, ?, NOW(), ?, ?)
`, [
      name,
      logo,
      subs[0].plan_id,
      plans[0].number_mics,
      req.user.id,
      plans[0].max_users,
      subs[0].end_date,
      subs[0].id
    ]);

    // 2. تحديث الاشتراك
    await connection.execute(
      "UPDATE subscriptions SET room_existe = 1 WHERE id = ?",
      [subs[0].id]
    );

    // 3. تأكيد العملية
    await connection.commit();

    // 4. إرسال الرد إلى Flutter
    return res.status(201).json({
      message: "Room created successfully",
      roomId: result.insertId
    });
  } catch (err) { if (connection) await connection.rollback(); return res.status(500).json({ message: "Error" }); }
  finally { connection.release(); }
});
app.post("/api/rooms/stop", authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.body || {};

    const [rooms] = await pool.execute(
      "SELECT * FROM rooms WHERE id = ?",
      [roomId]
    );

    if (!rooms[0]) {
      return res.status(404).json({ message: "Room not found" });
    }

    // فقط المالك أو الأدمن
    if (rooms[0].creared_by != req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ message: "Unauthorized" });
    }

    await pool.execute(
      "UPDATE rooms SET isLive = 0 WHERE id = ?",
      [roomId]
    );

    await pool.execute(
      "UPDATE room_members SET is_online = 0 WHERE room_id = ?",
      [roomId]
    );

    await pool.execute(
      "DELETE FROM join_requests WHERE room_id = ?",
      [roomId]
    );

    await emitRoomClosed(roomId);

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: "Error" });
  }
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
    await pool.execute("INSERT INTO room_members (user_id, room_id, role, is_online, is_muted, joined_at) VALUES (?, ?, 'owner', 1, 0, NOW()) ON DUPLICATE KEY UPDATE role = 'owner', is_online = 1, is_muted = 0", [rooms[0].creared_by, roomId]);
    io.emit("room:live_status", {
      roomId: roomId,
      isLive: 1
    });
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
    if (!toUserId || Number(toUserId) === Number(req.user.id)) {
      return res.status(400).json({ message: "Invalid target user" });
    }

    const [existing] = await pool.execute(
      `SELECT id, status
       FROM friend_requests
       WHERE ((fromUserId = ? AND toUserId = ?) OR (fromUserId = ? AND toUserId = ?))
       ORDER BY id DESC
       LIMIT 1`,
      [req.user.id, toUserId, toUserId, req.user.id]
    );

    if (existing[0]?.status === "pending") {
      return res.status(400).json({ message: "Friend request already pending" });
    }

    const u1 = Math.min(req.user.id, Number(toUserId));
    const u2 = Math.max(req.user.id, Number(toUserId));

    const [chatRows] = await pool.execute(
      "SELECT id FROM chats WHERE user1_id = ? AND user2_id = ? LIMIT 1",
      [u1, u2]
    );

    if (chatRows[0] || existing[0]?.status === "accepted") {
      return res.status(400).json({ message: "Users are already friends" });
    }

    await pool.execute("INSERT INTO friend_requests (fromUserId, toUserId, status) VALUES (?, ?, 'pending')", [req.user.id, toUserId]);
    io.to(`user_${toUserId}`).emit("new_friend_request", { fromUserId: req.user.id, fromUserName: req.user.name });
    return res.json({ message: "Sent" });
  } catch (err) { return res.status(500).json({ message: err }); }
});

app.get("/api/chats", authenticateToken, async (req, res) => {
  try {
    const [chats] = await pool.execute(`
      SELECT
        c.*,
        u.id AS friendId,
        u.name AS friendName,
        u.avatar AS friendAvatar,
        (
          SELECT m.message
          FROM messages m
          WHERE
            (m.sender_id = ? AND m.receiver_id = u.id) OR
            (m.sender_id = u.id AND m.receiver_id = ?)
          ORDER BY m.createdAt DESC
          LIMIT 1
        ) AS lastMessage
      FROM chats c
      JOIN users u
        ON (c.user1_id = u.id OR c.user2_id = u.id)
      WHERE (c.user1_id = ? OR c.user2_id = ?) AND u.id != ?
      ORDER BY c.last_message_at DESC
    `, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
    return res.json(chats);
  } catch (err) { return res.status(500).json({ message: "Error" }); }
});

app.get("/api/gifts", authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT id, name, image, video, points, created_at FROM gifts ORDER BY id DESC"
    );

    const payload = rows.map((gift) => ({
      ...gift,
      image: gift.image ? `${UPLOADS_BASE_URL}${gift.image}` : null,
      video: gift.video ? `${UPLOADS_BASE_URL}${gift.video}` : null
    }));

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error loading gifts" });
  }
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

// ========================
// ADMIN PLANS CRUD
// ========================

// Get all plans
app.get("/api/admin/plans", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT * FROM plans ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Error loading plans" });
  }
});

// Create plan
app.post("/api/admin/plans", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const { name, description, price, max_users, number_mics, expire_date } = req.body;

    await pool.execute(
      `INSERT INTO plans (name, description, price, max_users, number_mics, expire_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, description, price, max_users, number_mics, expire_date]
    );

    res.json({ message: "Plan created" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Create failed" });
  }
});

// ========================
// ADMIN GIFTS CRUD
// ========================

app.get("/api/admin/gifts", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM gifts ORDER BY id DESC"
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error loading gifts" });
  }
});

app.post("/api/admin/gifts", authenticateToken, authorizeRole("admin"), giftsUpload, async (req, res) => {
  try {
    const { name, points } = req.body || {};
    const image = req.files?.image?.[0]?.filename
      ? `/uploads/${req.files.image[0].filename}`
      : null;
    const video = req.files?.video?.[0]?.filename
      ? `/uploads/${req.files.video[0].filename}`
      : null;

    if (!name || !image || !video) {
      return res.status(400).json({ message: "Name, image and video are required" });
    }

    const [result] = await pool.execute(
      `INSERT INTO gifts (name, image, video, points, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [name, image, video, Number(points) || 0]
    );

    const [[gift]] = await pool.execute(
      "SELECT * FROM gifts WHERE id = ? LIMIT 1",
      [result.insertId]
    );

    res.status(201).json(gift);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error creating gift" });
  }
});

app.put("/api/admin/gifts/:id", authenticateToken, authorizeRole("admin"), giftsUpload, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, points } = req.body || {};

    const [[existingGift]] = await pool.execute(
      "SELECT * FROM gifts WHERE id = ? LIMIT 1",
      [id]
    );

    if (!existingGift) {
      return res.status(404).json({ message: "Gift not found" });
    }

    const nextImage = req.files?.image?.[0]?.filename
      ? `/uploads/${req.files.image[0].filename}`
      : existingGift.image;
    const nextVideo = req.files?.video?.[0]?.filename
      ? `/uploads/${req.files.video[0].filename}`
      : existingGift.video;

    await pool.execute(
      `UPDATE gifts
       SET name = ?, image = ?, video = ?, points = ?
       WHERE id = ?`,
      [
        name || existingGift.name,
        nextImage,
        nextVideo,
        Number(points) || 0,
        id
      ]
    );

    if (req.files?.image?.[0]?.filename && existingGift.image) {
      deleteUploadFile(existingGift.image);
    }

    if (req.files?.video?.[0]?.filename && existingGift.video) {
      deleteUploadFile(existingGift.video);
    }

    const [[updatedGift]] = await pool.execute(
      "SELECT * FROM gifts WHERE id = ? LIMIT 1",
      [id]
    );

    res.json(updatedGift);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error updating gift" });
  }
});

app.delete("/api/admin/gifts/:id", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;

    const [[gift]] = await pool.execute(
      "SELECT * FROM gifts WHERE id = ? LIMIT 1",
      [id]
    );

    if (!gift) {
      return res.status(404).json({ message: "Gift not found" });
    }

    await pool.execute("DELETE FROM gifts WHERE id = ?", [id]);

    deleteUploadFile(gift.image);
    deleteUploadFile(gift.video);

    res.json({ message: "Gift deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error deleting gift" });
  }
});

// Update plan
app.put("/api/admin/plans/:id", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, max_users, number_mics, expire_date } = req.body;

    await pool.execute(
      `UPDATE plans 
       SET name=?, description=?, price=?, max_users=?, number_mics=?, expire_date=?
       WHERE id=?`,
      [name, description, price, max_users, number_mics, expire_date, id]
    );

    res.json({ message: "Plan updated" });
  } catch (err) {
    res.status(500).json({ message: "Update failed" });
  }
});

// Delete plan
app.delete("/api/admin/plans/:id", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute("DELETE FROM plans WHERE id = ?", [id]);

    res.json({ message: "Plan deleted" });
  } catch (err) {
    res.status(500).json({ message: "Delete failed" });
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
