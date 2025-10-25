// ===== DeepButterflyRealm Server 💜 =====
// Express + Socket.io Chat mit Owner- und Admin-System
// Unterstützt Login, Register, Kick, Ban, Owner-Rechte und Avatar-Positionen

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server);

// ====== Speicher-Dateien ======
const USERS_FILE = "./users.json";
const BANNED_FILE = "./banned.json";

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");
if (!fs.existsSync(BANNED_FILE)) fs.writeFileSync(BANNED_FILE, "[]");

function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function loadBanned() {
  return JSON.parse(fs.readFileSync(BANNED_FILE, "utf8"));
}
function saveBanned(list) {
  fs.writeFileSync(BANNED_FILE, JSON.stringify(list, null, 2));
}

// ====== Globale Variablen ======
let onlineUsers = {};
let roomState = {};

// ====== Hilfsfunktionen ======
function genToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// ====== API: Registrierung ======
app.post("/register", (req, res) => {
  const { username, password, avatar, color, language, theme } = req.body;
  let users = loadUsers();
  const banned = loadBanned();

  if (banned.includes(username))
    return res.json({ ok: false, error: "Du bist gebannt." });

  if (users.find(u => u.username === username))
    return res.json({ ok: false, error: "Benutzername existiert bereits." });

  const isOwner = users.length === 0;
  const role = isOwner ? "owner" : "user";

  const newUser = {
    username,
    password,
    avatar,
    color,
    language,
    theme,
    role,
  };

  users.push(newUser);
  saveUsers(users);

  res.json({ ok: true, role });
});

// ====== API: Login ======
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  const banned = loadBanned();

  if (banned.includes(username))
    return res.json({ ok: false, error: "Du bist gebannt." });

  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.json({ ok: false, error: "Falscher Benutzer oder Passwort" });

  const token = genToken();
  onlineUsers[token] = user;

  res.json({ ok: true, token, profile: user });
});

// ====== API: Profil speichern ======
app.post("/profile", (req, res) => {
  const { token, avatar, color, language, theme } = req.body;
  const user = onlineUsers[token];
  if (!user) return res.json({ ok: false, error: "Nicht eingeloggt" });

  let users = loadUsers();
  const idx = users.findIndex(u => u.username === user.username);
  if (idx >= 0) {
    users[idx].avatar = avatar;
    users[idx].color = color;
    users[idx].language = language;
    users[idx].theme = theme;
    saveUsers(users);
    onlineUsers[token] = users[idx];
    return res.json({ ok: true, profile: users[idx] });
  }
  res.json({ ok: false, error: "Profil nicht gefunden" });
});

// ====== SOCKET.IO ======
io.on("connection", (socket) => {
  console.log("Ein Benutzer hat sich verbunden.");

  socket.on("joinChat", (token) => {
    const user = onlineUsers[token];
    if (!user) return;
    socket.user = user;
    socket.emit("chatMessage", {
      from: "System",
      text: `Willkommen ${user.username}!`,
    });
    io.emit("userlist", Object.values(onlineUsers));
    io.emit("roomUpdate", roomState);
  });

  socket.on("sendMessage", (data) => {
    const user = onlineUsers[data.token];
    if (!user) return;
    io.emit("chatMessage", {
      from: user.username,
      avatar: user.avatar,
      color: user.color,
      role: user.role,
      text: data.text,
    });
  });

  socket.on("moveAvatar", (data) => {
    const user = onlineUsers[data.token];
    if (!user) return;
    roomState[user.username] = {
      x: data.x,
      y: data.y,
      avatar: user.avatar,
      color: user.color,
      role: user.role,
    };
    io.emit("roomUpdate", roomState);
  });

  // ===== Moderation =====
  socket.on("kickUser", (data) => {
    const me = onlineUsers[data.token];
    if (!me || (me.role !== "owner" && me.role !== "admin")) return;

    const target = Object.entries(onlineUsers).find(
      ([t, u]) => u.username === data.targetUser
    );
    if (target) {
      const [token] = target;
      io.emit("forceLogout", { reason: "Du wurdest gekickt." });
      delete onlineUsers[token];
      io.emit("userlist", Object.values(onlineUsers));
    }
  });

  socket.on("banUser", (data) => {
    const me = onlineUsers[data.token];
    if (!me || (me.role !== "owner" && me.role !== "admin")) return;

    const target = Object.entries(onlineUsers).find(
      ([t, u]) => u.username === data.targetUser
    );
    if (target) {
      const [token, user] = target;
      const banned = loadBanned();
      banned.push(user.username);
      saveBanned(banned);
      io.emit("forceLogout", { reason: "Du wurdest gebannt." });
      delete onlineUsers[token];
      io.emit("userlist", Object.values(onlineUsers));
    }
  });

  socket.on("promoteAdmin", (data) => {
    const me = onlineUsers[data.token];
    if (!me || me.role !== "owner") return;

    const users = loadUsers();
    const target = users.find(u => u.username === data.targetUser);
    if (target) {
      target.role = "admin";
      saveUsers(users);
      io.emit("chatMessage", {
        from: "System",
        text: `${target.username} ist jetzt Admin 👑`,
      });
      io.emit("userlist", users);
    }
  });

  socket.on("disconnect", () => {
    if (socket.user) {
      const token = Object.keys(onlineUsers).find(
        t => onlineUsers[t].username === socket.user.username
      );
      if (token) delete onlineUsers[token];
      io.emit("userlist", Object.values(onlineUsers));
    }
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("DeepButterflyRealm läuft auf Port " + PORT));