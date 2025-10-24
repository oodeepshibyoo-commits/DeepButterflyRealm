// DeepButterfly Realm 3.0 Server 💜
// Neu:
// - fester OWNER (DeepButterflyMusic bleibt immer Owner 👑)
// - Owner-Fix-Button
// - CoOwner geben/wegnehmen
// - Kick/Ban
// - Avatare bewegen / Sitzplätze
// - Mehrsprach-Chat mit senderLang
// - Spiel-Lobby / Einladungen zu Spielen

const express = require("express");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const httpServer = require("http").createServer;
const { Server } = require("socket.io");

const PORT = process.env.PORT || 10000;
const JWT_SECRET = "deepbutterfly-secret-change-this";

// 💜 DAS IST DIE KÖNIGIN. DIESER NAME IST IMMER OWNER.
const MASTER_OWNER_NAME = "DeepButterflyMusic";

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname)));

const http = httpServer(app);
const io = new Server(http, {
  cors: { origin: "*" }
});

// "Datenbank" im RAM
const users = {};          // username -> { username, passHash, avatar, color, language, theme, role }
const banned = {};         // username -> true
const socketsByUser = {};  // username -> Set(socketId)
const userBySocket = {};   // socketId -> username

// Raum (Avatare)
const roomState = {};      // username -> { x,y,seatIndex, avatar,color,role }
const seats = [
  { x: 60,  y: 110 },
  { x: 120, y: 110 },
  { x: 180, y: 110 },
  { x: 240, y: 110 }
];

// Spielsystem (ganz basic Lobby)
let currentGame = null;
// currentGame = {
//   type: "tictactoe" | "memory",
//   host: "DeepButterflyMusic",
//   players: ["DeepButterflyMusic"],
//   open: true // kann man noch joinen?
// }

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

// Rollen-Helper
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
  return isOwner(actor); // nur Owner darf CoOwner geben
}
function canDemoteFromCoOwner(actor) {
  return isOwner(actor); // nur Owner darf CoOwner wegnehmen
}
function canKickBan(actor) {
  return isAdmin(actor); // owner/coOwner/admin
}

// Allen den Online-Status + Raum schicken
function broadcastUserListAndRoom() {
  // Online-Liste
  const list = Object.keys(socketsByUser).map(username => publicUser(users[username]));
  io.emit("userlist", list);

  // Raum (Avatare setzen)
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

  // Game Lobby Info
  broadcastGameState();
}

// Owner erzwingen: MASTER_OWNER_NAME ist IMMER owner
function enforceMasterOwner() {
  const u = users[MASTER_OWNER_NAME];
  if (!u) return;
  u.role = "owner";
  if (roomState[u.username]) {
    roomState[u.username].role = "owner";
  }
}

// Spiel-Lobby an alle senden
function broadcastGameState() {
  io.emit("gameState", currentGame);
}

// ====== REST API ======

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

  // Standardrolle
  let role = "user";
  // Wenn das der MASTER_OWNER_NAME ist → immer owner
  if (username === MASTER_OWNER_NAME) {
    role = "owner";
  }

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

  roomState[username] = {
    x: Math.floor(Math.random() * 220) + 20,
    y: Math.floor(Math.random() * 100) + 20,
    seatIndex: null,
    avatar: users[username].avatar,
    color: users[username].color,
    role: users[username].role
  };

  // Safety Owner
  enforceMasterOwner();

  return res.json({
    ok: true,
    message: "Account erstellt",
    role: users[username].role
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

  // Owner fix bei jedem Login:
  enforceMasterOwner();

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

// Profil ändern
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

    enforceMasterOwner();
    broadcastUserListAndRoom();

    return res.json({ ok: true, profile: publicUser(u) });
  } catch (e) {
    return res.status(401).json({ error: "token ungültig" });
  }
});

// Owner-Fix Button (falls dich jemand überholt hat)
app.post("/fixOwner", (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(401).json({ error: "kein token" });
  try {
    const data = jwt.verify(token, JWT_SECRET);
    const u = users[data.username];
    if (!u) return res.status(400).json({ error: "user nicht gefunden" });

    // Nur die Königin selber darf das
    if (u.username !== MASTER_OWNER_NAME) {
        return res.status(403).json({ error: "Nicht erlaubt" });
    }

    // Mach sie Owner
    u.role = "owner";
    if (roomState[u.username]) {
      roomState[u.username].role = "owner";
    }

    // Falls jemand anders 'owner' hatte, wird der runtergestuft zu 'coOwner'
    for (const name in users) {
      if (name !== MASTER_OWNER_NAME && users[name].role === "owner") {
        users[name].role = "coOwner";
        if (roomState[name]) {
          roomState[name].role = "coOwner";
        }
      }
    }

    broadcastUserListAndRoom();
    return res.json({ ok: true, profile: publicUser(u) });
  } catch (e) {
    return res.status(401).json({ error: "token ungültig" });
  }
});

// ====== SOCKET.IO ======

io.on("connection", (socket) => {
  console.log("Verbunden:", socket.id);

  // User betritt Chat
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

      // Safety
      enforceMasterOwner();

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
      console.log("joinChat fail", e);
    }
  });

  // Avatar bewegen
  socket.on("moveAvatar", (payload) => {
    if (!payload || !payload.token) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const u = users[data.username];
      if (!u || banned[u.username]) return;

      enforceMasterOwner();

      if (!roomState[u.username]) {
        roomState[u.username] = {
          x: 50,
          y: 50,
          seatIndex: null,
          avatar: u.avatar,
          color: u.color,
          role: u.role
        };
      }

      roomState[u.username].seatIndex = null;
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

  // Sitz nehmen
  socket.on("sitOnSeat", (payload) => {
    if (!payload || !payload.token) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const u = users[data.username];
      if (!u || banned[u.username]) return;

      enforceMasterOwner();

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

  // Chatnachricht
  socket.on("sendMessage", (payload) => {
    if (!payload || !payload.token || !payload.text) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const u = users[data.username];
      if (!u || banned[u.username]) return;

      enforceMasterOwner();

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

  // NEU: Spiel starten (macht eine offene Einladung/Lobby)
  socket.on("startGame", (payload) => {
    // { token, type: "tictactoe"|"memory" }
    if (!payload || !payload.token || !payload.type) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;

      enforceMasterOwner();

      // Spiele starten dürfen Admin/CoOwner/Owner
      if (!isAdmin(acting)) return;

      currentGame = {
        type: payload.type,
        host: acting.username,
        players: [acting.username],
        open: true,
        startedAt: Date.now()
      };

      broadcastUserListAndRoom();

      // Chat-Info "möchtest du spielen?"
      io.emit("gameInvite", {
        type: payload.type,
        host: acting.username,
        timestamp: Date.now()
      });

      io.emit("chatMessage", {
        from: "System",
        color: "#00fff6",
        avatar: "🕹",
        role: "system",
        text: acting.username + " hat ein Spiel gestartet: "+payload.type+"! Willst du mitspielen?",
        timestamp: Date.now(),
        senderLang: "system"
      });

    } catch (e) {
      console.log("startGame fail", e);
    }
  });

  // Spieler nimmt Einladung an
  socket.on("joinGame", (payload) => {
    // { token }
    if (!payload || !payload.token) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const u = users[data.username];
      if (!u || banned[u.username]) return;

      enforceMasterOwner();

      if (!currentGame || !currentGame.open) return;
      if (!currentGame.players.includes(u.username)) {
        currentGame.players.push(u.username);
        broadcastGameState();
      }

      io.emit("chatMessage", {
        from: "System",
        color: "#00fff6",
        avatar: "🕹",
        role: "system",
        text: u.username + " ist dem Spiel beigetreten.",
        timestamp: Date.now(),
        senderLang: "system"
      });
    } catch (e) {
      console.log("joinGame fail", e);
    }
  });

  // Owner / Host kann Spiel "locken" (starten richtig)
  socket.on("lockGame", (payload) => {
    // { token }
    if(!payload || !payload.token) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if(!acting) return;

      enforceMasterOwner();

      if(!currentGame) return;
      // nur Host oder Owner darf locken
      if(acting.username !== currentGame.host && !isOwner(acting)) return;

      currentGame.open = false;
      broadcastGameState();

      io.emit("chatMessage", {
        from:"System",
        color:"#ffd93b",
        avatar:"🕹",
        role:"system",
        text:"Spiel ist jetzt gestartet / geschlossen für neue Spieler.",
        timestamp:Date.now(),
        senderLang:"system"
      });
    } catch(e){
      console.log("lockGame fail",e);
    }
  });

  // ADMIN: Mitbesitzer geben
  socket.on("promoteCoOwner", (payload) => {
    if (!payload || !payload.token || !payload.targetUser) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;

      enforceMasterOwner();

      if (!canPromoteToCoOwner(acting)) return; // nur owner

      const t = users[payload.targetUser];
      if (!t) return;
      if (isOwner(t)) return;
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

  // ADMIN: Mitbesitzer entfernen
  socket.on("demoteToUser", (payload) => {
    if (!payload || !payload.token || !payload.targetUser) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;

      enforceMasterOwner();

      if (!canDemoteFromCoOwner(acting)) return; // nur owner

      const t = users[payload.targetUser];
      if (!t) return;
      if (isOwner(t)) return;
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
    if (!payload || !payload.token || !payload.targetUser) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;

      enforceMasterOwner();

      if (!canKickBan(acting)) return;

      const targetName = payload.targetUser;
      const targetUser = users[targetName];
      if (!targetUser) return;
      if (isOwner(targetUser)) return; // owner nie kicken

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

  // Ban
  socket.on("banUser", (payload) => {
    if (!payload || !payload.token || !payload.targetUser) return;
    try {
      const data = jwt.verify(payload.token, JWT_SECRET);
      const acting = users[data.username];
      if (!acting) return;

      enforceMasterOwner();

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

http.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
  console.log("Bereit ✨");
});

