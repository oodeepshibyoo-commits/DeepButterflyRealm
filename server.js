// server.js
// DeepButterflyRealm basic backend
// Express + Socket.io

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

// ====== SERVER SETUP ======
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

// Body parser
app.use(express.json());

// Static serve index.html and socket.io client
app.use(express.static(path.join(__dirname)));

// ====== IN-MEMORY STORAGE ======

// usersDB: alle registrierten Nutzer
//   username: {
//     username, passwordHash, avatar, color, language, theme, role
//   }
const usersDB = {};

// tokens: token -> username
const tokens = {};

// banned: { username: true }
const banned = {};

// onlineUsers: username -> { username, avatar, color, language, role, socketId }
const onlineUsers = {};

// raum: Avatare im Raum + Sitzplätze
const roomState = {
  avatars: {
    // username: { x, y, avatar, color, role }
  },
  seats: [
    { x: 50,  y: 100 },
    { x: 120, y: 100 },
    { x: 190, y: 100 },
    { x: 260, y: 100 },
    { x: 330, y: 100 }
  ]
};

// Spiel-Lobby
// currentGame = {
//   type: "tictactoe" | "memory",
//   host: "Name",
//   players: ["Name1","Name2",...],
//   open: true/false
// }
let currentGame = null;

// ====== HELPER FUNKTIONEN ======
function hashPass(pw) {
  return crypto.createHash("sha256").update(pw).digest("hex");
}

function makeToken(username) {
  const t = crypto.randomBytes(16).toString("hex");
  tokens[t] = username;
  return t;
}

function userPublicData(u) {
  return {
    username: u.username,
    avatar: u.avatar,
    color: u.color,
    language: u.language,
    role: u.role
  };
}

function broadcastUserlist() {
  const list = Object.values(onlineUsers).map(u => ({
    username: u.username,
    avatar: u.avatar,
    color: u.color,
    language: u.language,
    role: u.role
  }));
  io.emit("userlist", list);
}

function broadcastRoom() {
  io.emit("roomUpdate", {
    avatars: roomState.avatars,
    seats: roomState.seats
  });
}

function broadcastGame() {
  io.emit("gameState", currentGame);
}

function kickUser(targetName, reason = "Du wurdest gekickt.") {
  // find socket
  for (const [sockId, data] of Object.entries(connectedSockets)) {
    if (data.username === targetName) {
      const sock = io.sockets.sockets.get(sockId);
      if (sock) {
        sock.emit("forceLogout", { reason });
        sock.disconnect(true);
      }
    }
  }
}

// Check ob role1 Admin-Rechte über andere hat
function canModerate(role1) {
  return role1 === "owner" || role1 === "coOwner" || role1 === "admin";
}

// ====== VERBUNDENE SOCKETS ======
const connectedSockets = {};
// connectedSockets[socket.id] = { username }

// ====== OWNER DEFAULT ======
// Wenn es keinen Owner gibt, erste Registrierung mit Name "DeepButterflyMusic"
// bekommt automatisch Rolle owner

function ensureOwnerExists() {
  const alreadyHasOwner = Object.values(usersDB).some(u => u.role === "owner");
  if (!alreadyHasOwner) {
    // Falls User "DeepButterflyMusic" existiert, der wird Owner
    if (usersDB["DeepButterflyMusic"]) {
      usersDB["DeepButterflyMusic"].role = "owner";
    }
  }
}

// ====== API ROUTES ======

// POST /register
// body: { username, password, avatar, color, language, theme }
app.post("/register", (req, res) => {
  const { username, password, avatar, color, language, theme } = req.body || {};

  if (!username || !password) {
    return res.json({ ok: false, error: "Name/Passwort fehlt" });
  }
  if (usersDB[username]) {
    return res.json({ ok: false, error: "Name existiert schon" });
  }

  const pwHash = hashPass(password);

  // Standardrolle user
  let role = "user";

  // Sonderfall: DeepButterflyMusic wird Owner, wenn kein Owner existiert
  const alreadyHasOwner = Object.values(usersDB).some(u => u.role === "owner");
  if (!alreadyHasOwner && username === "DeepButterflyMusic") {
    role = "owner";
  }

  usersDB[username] = {
    username,
    passwordHash: pwHash,
    avatar: avatar || "🦋",
    color: color || "#ff4dfd",
    language: language || "de",
    theme: theme || "default",
    role
  };

  ensureOwnerExists();

  return res.json({
    ok: true,
    role: usersDB[username].role
  });
});

// POST /login
// body: { username, password }
app.post("/login", (req,res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.json({ ok:false, error:"Fehlt" });
  }
  const u = usersDB[username];
  if (!u) {
    return res.json({ ok:false, error:"Unbekannt" });
  }
  if (banned[username]) {
    return res.json({ ok:false, error:"Gebannt" });
  }

  const pwHash = hashPass(password);
  if (pwHash !== u.passwordHash) {
    return res.json({ ok:false, error:"Falsches Passwort" });
  }

  const token = makeToken(username);
  return res.json({
    ok:true,
    token,
    profile: {
      username: u.username,
      avatar: u.avatar,
      color: u.color,
      language: u.language,
      theme: u.theme,
      role: u.role
    }
  });
});

// POST /profile
// body: { token, avatar, color, language, theme }
app.post("/profile", (req,res) => {
  const { token, avatar, color, language, theme } = req.body || {};
  const username = tokens[token];
  if (!username) {
    return res.json({ ok:false, error:"Ungültig" });
  }
  const u = usersDB[username];
  if (!u) {
    return res.json({ ok:false, error:"Kein Profil" });
  }

  if (avatar)   u.avatar   = avatar;
  if (color)    u.color    = color;
  if (language) u.language = language;
  if (theme)    u.theme    = theme;

  // Update live online user too
  if (onlineUsers[username]) {
    onlineUsers[username].avatar   = u.avatar;
    onlineUsers[username].color    = u.color;
    onlineUsers[username].language = u.language;
    onlineUsers[username].role     = u.role;
  }
  // Update room avatar style
  if (roomState.avatars[username]) {
    roomState.avatars[username].avatar = u.avatar;
    roomState.avatars[username].color  = u.color;
    roomState.avatars[username].role   = u.role;
  }

  broadcastUserlist();
  broadcastRoom();

  return res.json({
    ok:true,
    profile: {
      username: u.username,
      avatar: u.avatar,
      color: u.color,
      language: u.language,
      theme: u.theme,
      role: u.role
    }
  });
});

// POST /fixOwner
// body: { token }
app.post("/fixOwner", (req,res) => {
  const { token } = req.body || {};
  const username = tokens[token];
  if (!username) {
    return res.json({ ok:false, error:"Ungültig" });
  }
  const u = usersDB[username];
  if (!u) {
    return res.json({ ok:false, error:"Kein Profil" });
  }

  // Nur DeepButterflyMusic darf sich selbst Owner zurückgeben
  if (username === "DeepButterflyMusic") {
    u.role = "owner";
  } else {
    return res.json({ ok:false, error:"Nur DeepButterflyMusic darf Owner fixen" });
  }

  // Update live:
  if (onlineUsers[username]) {
    onlineUsers[username].role = u.role;
  }
  if (roomState.avatars[username]) {
    roomState.avatars[username].role = u.role;
  }

  broadcastUserlist();
  broadcastRoom();

  return res.json({
    ok:true,
    profile: {
      username:u.username,
      avatar:u.avatar,
      color:u.color,
      language:u.language,
      theme:u.theme,
      role:u.role
    }
  });
});

// ===== SOCKET.IO HANDLING =====

// joinChat: nach Login ruft Client joinChat(token)
io.on("connection", socket => {
  console.log("Socket verbunden", socket.id);

  connectedSockets[socket.id] = { username: null };

  socket.on("joinChat", token => {
    const username = tokens[token];
    if (!username) return;
    if (banned[username]) {
        socket.emit("forceLogout",{reason:"Gebannt"});
        return;
    }

    const u = usersDB[username];
    if (!u) return;

    connectedSockets[socket.id].username = username;

    // in onlineUsers eintragen
    onlineUsers[username] = {
      username: u.username,
      avatar: u.avatar,
      color: u.color,
      language: u.language,
      role: u.role,
      socketId: socket.id
    };

    // Raumavatar initialisieren falls nicht vorhanden
    if (!roomState.avatars[username]) {
      roomState.avatars[username] = {
        x: 20 + Math.floor(Math.random()*200),
        y: 20 + Math.floor(Math.random()*80),
        avatar: u.avatar,
        color: u.color,
        role: u.role
      };
    }

    // Broadcast Updates
    broadcastUserlist();
    broadcastRoom();

    // Begrüßungs-Systemmeldung für alle
    const joinMsg = {
      from:"System",
      color:"#888",
      avatar:"🔔",
      text:`${username} ist jetzt online`,
      timestamp:Date.now(),
      senderLang:"system"
    };
    io.emit("chatMessage", joinMsg);
  });

  // Chat-Nachricht
  // { token, text }
  socket.on("sendMessage", data => {
    const { token, text } = data || {};
    const username = tokens[token];
    if (!username) return;
    if (banned[username]) {
        socket.emit("forceLogout",{reason:"Gebannt"});
        return;
    }
    const u = usersDB[username];
    if (!u) return;

    const msgObj = {
      from: username,
      avatar: u.avatar,
      color: u.color,
      role: u.role,
      text: text,
      timestamp: Date.now(),
      senderLang: u.language || "de"
    };
    io.emit("chatMessage", msgObj);
  });

  // moveAvatar: { token, x, y }
  socket.on("moveAvatar", data => {
    const { token, x, y } = data || {};
    const username = tokens[token];
    if (!username) return;
    if (!roomState.avatars[username]) return;

    roomState.avatars[username].x = x;
    roomState.avatars[username].y = y;
    broadcastRoom();
  });

  // sitOnSeat: { token, seatIndex }
  socket.on("sitOnSeat", data => {
    const { token, seatIndex } = data || {};
    const username = tokens[token];
    if (!username) return;
    const u = usersDB[username];
    if (!u) return;
    if (!roomState.seats[seatIndex]) return;
    if (!roomState.avatars[username]) return;

    // setze Avatar auf Sitzposition
    roomState.avatars[username].x = roomState.seats[seatIndex].x;
    roomState.avatars[username].y = roomState.seats[seatIndex].y;
    broadcastRoom();
  });

  // startGame: { token, type }
  socket.on("startGame", data => {
    const { token, type } = data || {};
    const username = tokens[token];
    if (!username) return;
    const u = usersDB[username];
    if (!u) return;

    // Nur owner / coOwner / admin darf Spiel hosten
    if (!canModerate(u.role)) return;

    currentGame = {
      type: type || "tictactoe",
      host: username,
      players: [ username ],
      open: true
    };
    broadcastGame();

    // Einladung an alle anderen
    for (const [sockId, info] of Object.entries(connectedSockets)) {
      if (info.username && info.username !== username) {
        const otherSock = io.sockets.sockets.get(sockId);
        if (otherSock) {
          otherSock.emit("gameInvite", {
            type: currentGame.type,
            host: username,
            timestamp: Date.now()
          });
        }
      }
    }
  });

  // joinGame: { token }
  socket.on("joinGame", data => {
    const { token } = data || {};
    const username = tokens[token];
    if (!username) return;
    if (!currentGame) return;
    if (!currentGame.open) return;

    if (!currentGame.players.includes(username)) {
      currentGame.players.push(username);
      broadcastGame();
    }
  });

  // lockGame: { token }
  socket.on("lockGame", data => {
    const { token } = data || {};
    const username = tokens[token];
    if (!username) return;
    if (!currentGame) return;
    const u = usersDB[username];
    if (!u) return;

    // nur Host oder Owner darf schließen
    if (currentGame.host === username || u.role === "owner") {
      currentGame.open = !currentGame.open;
      broadcastGame();
    }
  });

  // promoteCoOwner: { token, targetUser }
  socket.on("promoteCoOwner", data => {
    const { token, targetUser } = data || {};
    const username = tokens[token];
    if (!username) return;
    const me = usersDB[username];
    if (!me) return;
    if (!canModerate(me.role)) return;
    if (!usersDB[targetUser]) return;
    if (targetUser === "DeepButterflyMusic") return; // bleibt Owner-Kandidat

    usersDB[targetUser].role = "coOwner";

    // sync live data
    if (onlineUsers[targetUser]) {
      onlineUsers[targetUser].role = "coOwner";
    }
    if (roomState.avatars[targetUser]) {
      roomState.avatars[targetUser].role = "coOwner";
    }
    broadcastUserlist();
    broadcastRoom();
  });

  // demoteToUser: { token, targetUser }
  socket.on("demoteToUser", data => {
    const { token, targetUser } = data || {};
    const username = tokens[token];
    if (!username) return;
    const me = usersDB[username];
    if (!me) return;
    if (!canModerate(me.role)) return;
    if (!usersDB[targetUser]) return;
    // nicht Owner runterschmeißen
    if (usersDB[targetUser].role === "owner") return;

    usersDB[targetUser].role = "user";

    if (onlineUsers[targetUser]) {
      onlineUsers[targetUser].role = "user";
    }
    if (roomState.avatars[targetUser]) {
      roomState.avatars[targetUser].role = "user";
    }
    broadcastUserlist();
    broadcastRoom();
  });

  // kickUser: { token, targetUser }
  socket.on("kickUser", data => {
    const { token, targetUser } = data || {};
    const username = tokens[token];
    if (!username) return;
    const me = usersDB[username];
    if (!me) return;
    if (!canModerate(me.role)) return;
    if (!usersDB[targetUser]) return;
    if (usersDB[targetUser].role === "owner") return;

    // Kicken = Verbindung trennen
    kickUser(targetUser, "Du wurdest gekickt.");

    // Entfernen aus onlineUsers
    delete onlineUsers[targetUser];
    delete roomState.avatars[targetUser];
    broadcastUserlist();
    broadcastRoom();
  });

  // banUser: { token, targetUser }
  socket.on("banUser", data => {
    const { token, targetUser } = data || {};
    const username = tokens[token];
    if (!username) return;
    const me = usersDB[username];
    if (!me) return;
    if (!canModerate(me.role)) return;
    if (!usersDB[targetUser]) return;
    if (usersDB[targetUser].role === "owner") return;

    banned[targetUser] = true;
    kickUser(targetUser, "Du wurdest gebannt.");

    delete onlineUsers[targetUser];
    delete roomState.avatars[targetUser];
    broadcastUserlist();
    broadcastRoom();
  });

  socket.on("disconnect", () => {
    const who = connectedSockets[socket.id]?.username;
    delete connectedSockets[socket.id];

    if (who && onlineUsers[who]) {
      delete onlineUsers[who];
      // Raum-Avatar bleibt aber erhalten (damit Position gemerkt bleibt)
      broadcastUserlist();

      const leaveMsg = {
        from:"System",
        color:"#888",
        avatar:"💤",
        text:`${who} hat den Chat verlassen`,
        timestamp:Date.now(),
        senderLang:"system"
      };
      io.emit("chatMessage", leaveMsg);
    }

    console.log("Socket getrennt", socket.id);
  });
});

// ====== START ======
server.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});


