// DeepButterfly Realm 2.1 Server 💜
// Features:
// - Registrierung + Login (username+passwort)
// - Rollen: owner 👑, coOwner 👑, admin 👑, user
//   * Erster Account wird owner
//   * owner kann andere zu coOwner machen
//   * owner kann coOwner wieder zurück zu user machen
// - Kick / Bann (owner + coOwner + admin dürfen kicken/bannen, aber niemand darf owner anfassen)
// - Bannliste: Gebannte können nicht mehr rein
// - Online-Liste in Echtzeit
// - Raum mit Avataren (x,y) und Sitzplätzen
// - Chat mit Socket.io Broadcast
// - server sendet bei jeder Nachricht auch senderLang (Sprache des Senders)
// - Spielstart-Events (TicTacToe / Memory)

const express = require("express");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const httpServer = require("http").createServer;
const { Server } = require("socket.io");

const PORT = process.env.PORT || 10000;
const JWT_SECRET = "deepbutterfly-secret-change-this";

// App Setup
const app = express();
app.use(express.json());
app.use(cors());
// Statische Dateien ausliefern (index.html usw.)
app.use(express.static(path.join(__dirname)));

const http = httpServer(app);
const io = new Server(http, {
  cors: { origin: "*" }
});

// "Speicher" im RAM (Free-Host: wird gelöscht wenn Server neu startet)
const users = {};          // username -> { username, passHash, avatar, color, language, theme, role }
const banned = {};         // username -> true
const socketsByUser = {};  // username -> Set(socketId)
const userBySocket = {};   // socketId -> username
const roomState = {};      // username -> { x,y,seatIndex, avatar,color,role }
const seats = [
  { x: 60,  y: 110 },
  { x: 120, y: 110 },
  { x: 180, y: 110 },
  { x: 240, y: 110 }
];

// Hilfsfunktionen
function publicUser(u) {
  return {
    username: u.username,
    avatar: u.avatar,
    color: u.color,
    language: u.language,
    theme: u.theme,
    role: u.role
  };
}

function isOwner(u) {
  return u && u.role === "owner";
}
function isCoOwner(u) {
  return u && u.role === "coOwner";
}
function isAdmin(u) {
  return u && (u.role === "admin" || isCoOwner(u) || isOwner(u));
}
function canPromoteToCoOwner(actor) {
  // nur owner darf CoOwner vergeben
  return isOwner(actor);
}
function canDemoteFromCoOwner(actor) {
  // nur owner darf CoOwner zurückstufen
  return isOwner(actor);
}
function canKickBan(actor) {
  // owner, coOwner, admin dürfen kicken/bannen
  return isAdmin(actor);
}

// nach jeder Änderung -> an alle schicken
function broadcastUserListAndRoom() {
  const list = Object.keys(socketsByUser).map(username => publicUser(users[username]));
  io.emit("userlist", list);

  // Sitz-Position berücksichtigen
  const stateToSend = {};
  for (const uname in roomState) {
    const entry = { ...roomState[uname] };
    if (typeof entry.seatIndex === "number" && seats[entry.seatIndex]) {
        entry.x = seats[entry.seatIndex].x;
        entry.y = seats[entry.seatIndex].y;
    }
    stateToSend[uname] = entry;
  }
  io.emit("roomUpdate", { avatars: stateToSend, seats });
}

// Registrierung
app.post("/register", async (req, res) => {
  const { username, password, avatar, color, language, theme } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username und password sind nötig" });
  }
  if (users[username]) {
    return res.status(400).json({ error: "Name schon vergeben" });
  }
  if (banned[username]) {
    return res.status(403).json({ error: "Dieser Name ist gebannt." });
  }

  const isFirst = Object.keys(users).length === 0;
  const role = isFirst ? "owner" : "user";

  const passHash = await bcrypt.hash(password, 10);

  users[username] = {
    username,
    passHash,
    avatar: avatar || "🦋",
    color: color || "#ffffff",
    language: language || "de",
    theme: theme || "default",
    role
  };

  // Raum initial
  roomState[username] = {
    x: Math.floor(Math.random() * 220) + 20,
    y: Math.floor(Math.random() * 100) + 20,
    seatIndex: null,
    avatar: users[username].avatar,
    color: users[username].color,
    role: users[username].role
  };

  return res.json({
    ok: true,
    message: "Account erstellt",
    role
  });
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Fehlt username oder password" });
  }
  if (banned[username]) {
    return res.status(403).json({ error: "Du bist gebannt." });
  }

  const u = users[username];
  if (!u) {
    return res.status(400).json({ error: "User existiert nicht" });
  }

  const ok = await bcrypt.compare(password, u.passHash);
  if (!ok) {
    return res.status(400).json({ error: "Falsches Passwort" });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "12h" });

  if (!roomState[username]) {
    roomState[username] = {
      x: Math.floor(Math.random() * 220) + 20,
      y: Math.floor(Math.random() * 100) + 20,
      seatIndex: null,
      avatar: u.avatar,
      color: u.color,
      role: u.role
    };
  }

  res.json({
    ok: true,
    token,
    profile: publicUser(u)
  });
});

// Profil ändern (Avatar, Farbe, Sprache, Theme)
app.post("/profile", (req, res) => {
  const { token, avatar, color, language, theme } = req.body || {};
  if (!token) return res.status(401).json({ error: "kein token" });
  try {
    const data = jwt.verify(token, JWT_SECRET);
    const u = users[data.username];
    if (!u) return res.status(400).json({ error: "user nicht gefunden" });
    if (avatar !== undefined) u.avatar = avatar;
    if (color !== undefined) u.color = color;
    if (language !== undefined) u.language = language;
    if (theme !== undefined) u.theme = theme;

    if (roomState[u.username]) {
      roomState[u.username].avatar = u.avatar;
      roomState[u.username].color = u.color;
      roomState[u.username].role = u.role;
    }

    broadcastUserListAndRoom();

    return res.json({ ok: true, profile: publicUser(u) });
  } catch (e) {
    return res.status(401).json({ error: "token ungültig" });
  }
});

// Socket-Verbindungen
io.on("connection", (socket) => {
  console.log("Verbunden:", socket.id);

  // joinChat
  socket.on("joinChat", (token) => {
    try {
      const data = jwt.verify(token, JWT_SECRET);
      const u = users[data.username];
      if (!u) return;
      if (banned[u.username]) {
        socket.emit("forceLogout", { reason: "Du bist gebannt." });
        socket.disconnect(true);
        return;
      }

      userBySocket[socket.id] = u.username;
      if (!socketsByUser[u.username]) socketsByUser[u.username] = new Set();
      socketsByUser[u.username].add(socket.id);

      if (!roomState[u.username]) {
        roomState[u.username] = {
          x: Math.floor(Math.random() * 220) + 20,
          y: Math.floor(Math.random() * 100) + 20,
          seatIndex: null,
          avatar: u.avatar,
          color: u.color,
          role: u.role
        };
      }

      broadcastUserListAndRoom();

      io.emit("chatMessage", {
        from: "System",
        color: "#888",
        avatar: "💬",
        role: "system",
        text: u.username + " ist jetzt online 💫",
        timestamp: Date.now(),
        senderLang: "system"
      });

    } catch (e) {
      console.log("joinChat token ungültig/fehlt");
    }
  });

  // Avatar frei bewegen
  socket.on("moveAvatar", (payload) => {
    // payload: { token, x, y }
    if (!payload || !payload.token) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const u = users[data.username];
      if (!u || banned[u.username]) return;

      if (!roomState[u.username]) {
        roomState[u.username] = {
          x: 50, y: 50, seatIndex: null,
          avatar: u.avatar,
          color: u.color,
          role: u.role
        };
      }

      roomState[u.username].seatIndex = null; // verlässt Sitz
      roomState[u.username].x = payload.x;
      roomState[u.username].y = payload.y;
      roomState[u.username].avatar = u.avatar;
      roomState[u.username].color = u.color;
      roomState[u.username].role = u.role;

      broadcastUserListAndRoom();
    } catch (e) {
      console.log("moveAvatar fail", e);
    }
  });

  // Auf Sitz setzen
  socket.on("sitOnSeat", (payload) => {
    // payload: { token, seatIndex }
    if (!payload || !payload.token) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const u = users[data.username];
      if (!u || banned[u.username]) return;
      const idx = payload.seatIndex;
      if (typeof idx !== "number") return;
      if (!seats[idx]) return;

      if (!roomState[u.username]) {
        roomState[u.username] = {
          x: seats[idx].x,
          y: seats[idx].y,
          seatIndex: idx,
          avatar: u.avatar,
          color: u.color,
          role: u.role
        };
      } else {
        roomState[u.username].seatIndex = idx;
        roomState[u.username].x = seats[idx].x;
        roomState[u.username].y = seats[idx].y;
        roomState[u.username].avatar = u.avatar;
        roomState[u.username].color = u.color;
        roomState[u.username].role = u.role;
      }

      broadcastUserListAndRoom();
    } catch (e) {
      console.log("sitOnSeat fail", e);
    }
  });

  // Chatnachricht senden -> Server broadcastet + hängt senderLang an
  socket.on("sendMessage", (payload) => {
    // payload: { token, text }
    if (!payload || !payload.token || !payload.text) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const u = users[data.username];
      if (!u || banned[u.username]) return;

      io.emit("chatMessage", {
        from: u.username,
        color: u.color,
        avatar: u.avatar,
        role: u.role,
        text: payload.text,
        timestamp: Date.now(),
        senderLang: u.language || "auto"
      });
    } catch (e) {
      console.log("sendMessage fail", e);
    }
  });

  // Mitbesitzer vergeben
  socket.on("promoteCoOwner", (payload) => {
    // { token, targetUser }
    if (!payload || !payload.token || !payload.targetUser) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;
      if (!canPromoteToCoOwner(acting)) return; // nur owner

      const t = users[payload.targetUser];
      if (!t) return;
      if (isOwner(t)) return; // owner bleibt owner
      t.role = "coOwner";

      if (roomState[t.username]) {
        roomState[t.username].role = t.role;
      }

      broadcastUserListAndRoom();

      io.emit("chatMessage", {
        from: "System",
        color: "#ffd93b",
        avatar: "👑",
        role: "system",
        text: payload.targetUser + " ist jetzt Mitbesitzer 👑",
        timestamp: Date.now(),
        senderLang: "system"
      });
    } catch (e) {
      console.log("promoteCoOwner fail", e);
    }
  });

  // Mitbesitzer entfernen (zurück zu user)
  socket.on("demoteToUser", (payload) => {
    // { token, targetUser }
    if (!payload || !payload.token || !payload.targetUser) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;
      // nur owner darf coOwner runterstufen
      if (!canDemoteFromCoOwner(acting)) return;

      const t = users[payload.targetUser];
      if (!t) return;
      if (isOwner(t)) return; // owner bleibt owner
      t.role = "user";

      if (roomState[t.username]) {
        roomState[t.username].role = t.role;
      }

      broadcastUserListAndRoom();

      io.emit("chatMessage", {
        from: "System",
        color: "#ff4dfd",
        avatar: "👑",
        role: "system",
        text: payload.targetUser + " ist kein Mitbesitzer mehr.",
        timestamp: Date.now(),
        senderLang: "system"
      });
    } catch (e) {
      console.log("demoteToUser fail", e);
    }
  });

  // Kick
  socket.on("kickUser", (payload) => {
    // { token, targetUser }
    if (!payload || !payload.token || !payload.targetUser) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;
      if (!canKickBan(acting)) return;

      const targetName = payload.targetUser;
      const targetUser = users[targetName];
      if (!targetUser) return;
      if (isOwner(targetUser)) return; // owner nicht kicken

      if (socketsByUser[targetName]) {
        for (const sid of socketsByUser[targetName]) {
          io.to(sid).emit("forceLogout", { reason: "Du wurdest gekickt." });
          io.sockets.sockets.get(sid)?.disconnect(true);
        }
      }

      io.emit("chatMessage", {
        from: "System",
        color: "#ff4dfd",
        avatar: "💥",
        role: "system",
        text: targetName + " wurde gekickt.",
        timestamp: Date.now(),
        senderLang: "system"
      });
    } catch (e) {
      console.log("kickUser fail", e);
    }
  });

  // Bann
  socket.on("banUser", (payload) => {
    // { token, targetUser }
    if (!payload || !payload.token || !payload.targetUser) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;
      if (!canKickBan(acting)) return;

      const targetName = payload.targetUser;
      const targetUser = users[targetName];
      if (!targetUser) return;
      if (isOwner(targetUser)) return; // owner nie bannen

      banned[targetName] = true;

      if (socketsByUser[targetName]) {
        for (const sid of socketsByUser[targetName]) {
          io.to(sid).emit("forceLogout", { reason: "Du wurdest gebannt." });
          io.sockets.sockets.get(sid)?.disconnect(true);
        }
      }

      io.emit("chatMessage", {
        from: "System",
        color: "#ff0000",
        avatar: "⛔",
        role: "system",
        text: targetName + " wurde gebannt.",
        timestamp: Date.now(),
        senderLang: "system"
      });
    } catch (e) {
      console.log("banUser fail", e);
    }
  });

  // Spiele starten
  socket.on("startGame", (payload) => {
    // { token, type: "tictactoe" | "memory" }
    if (!payload || !payload.token || !payload.type) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;
      // nur Admin/Owner/CoOwner
      if (!isAdmin(acting)) return;

      io.emit("gameStarted", {
        type: payload.type,
        startedBy: acting.username,
        timestamp: Date.now()
      });

    } catch (e) {
      console.log("startGame fail", e);
    }
  });

  socket.on("disconnect", () => {
    const uname = userBySocket[socket.id];
    delete userBySocket[socket.id];

    if (uname && socketsByUser[uname]) {
      socketsByUser[uname].delete(socket.id);
      if (socketsByUser[uname].size === 0) {
        delete socketsByUser[uname];
      }
    }

    broadcastUserListAndRoom();

    if (uname) {
      io.emit("chatMessage", {
        from: "System",
        color: "#888",
        avatar: "💬",
        role: "system",
        text: uname + " hat den Raum verlassen.",
        timestamp: Date.now(),
        senderLang: "system"
      });
    }

    console.log("Getrennt:", socket.id);
  });
});

// Server starten
http.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
  console.log("Bereit ✨");
});

