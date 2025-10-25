// DeepButterflyRealm 💜👑
// Komplettversion mit Login, Chat, Übersetzung, Avataren und Owner-System

import express from "express";
import http from "http";
import { Server } from "socket.io";
import fetch from "node-fetch";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("."));

const PORT = process.env.PORT || 10000;

// === Datenhaltung ===
const users = {}; // username -> { pass, avatar, color, language, theme, role, banned }
const sessions = {}; // token -> username
const banned = new Set();
const positions = {}; // username -> {x,y}

// === Hilfsfunktionen ===
function makeToken() {
  return Math.random().toString(36).slice(2);
}

// === LOGIN & REGISTRIERUNG ===
app.post("/register", (req, res) => {
  const { username, password, avatar, color, language, theme } = req.body;
  if (!username || !password) {
    return res.json({ ok: false, error: "Fehlende Daten" });
  }
  if (users[username]) {
    return res.json({ ok: false, error: "Name existiert bereits" });
  }
  if (banned.has(username)) {
    return res.json({ ok: false, error: "Dieser Nutzer ist gebannt" });
  }

  const role = Object.keys(users).length === 0 ? "owner" : "user";
  users[username] = { pass: password, avatar, color, language, theme, role };
  console.log("User registriert:", username, "Rolle:", role);
  res.json({ ok: true, role });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const u = users[username];
  if (!u || u.pass !== password) {
    return res.json({ ok: false, error: "Falscher Name oder Passwort" });
  }
  if (banned.has(username)) {
    return res.json({ ok: false, error: "Du bist gebannt" });
  }
  const token = makeToken();
  sessions[token] = username;
  res.json({ ok: true, token, profile: { username, ...u } });
});

app.post("/profile", (req, res) => {
  const { token, avatar, color, language, theme } = req.body;
  const username = sessions[token];
  if (!username) return res.json({ ok: false, error: "Nicht eingeloggt" });
  const u = users[username];
  if (!u) return res.json({ ok: false, error: "Unbekannter Nutzer" });
  Object.assign(u, { avatar, color, language, theme });
  res.json({ ok: true, profile: { username, ...u } });
});

// === SOCKET.IO ===
io.on("connection", (socket) => {
  let username = null;

  socket.on("joinChat", (token) => {
    const uName = sessions[token];
    if (!uName || banned.has(uName)) {
      socket.emit("forceLogout", { reason: "Ungültig oder gebannt" });
      return;
    }
    username = uName;
    console.log(`${username} ist online`);
    broadcastUserlist();
    sendSystem(`${username} hat betreten 💜`);
  });

  socket.on("sendMessage", (msg) => {
    if (!msg.token || !sessions[msg.token]) return;
    const uname = sessions[msg.token];
    const u = users[uname];
    io.emit("chatMessage", {
      from: uname,
      text: msg.text,
      color: u.color,
      avatar: u.avatar,
      role: u.role,
    });
  });

  socket.on("moveAvatar", (data) => {
    if (!sessions[data.token]) return;
    const uname = sessions[data.token];
    positions[uname] = { x: data.x, y: data.y, avatar: users[uname].avatar, color: users[uname].color, role: users[uname].role };
    io.emit("roomUpdate", positions);
  });

  socket.on("kickUser", (data) => {
    const me = sessions[data.token];
    const target = data.targetUser;
    if (!isMod(me)) return;
    sendSystem(`${target} wurde rausgeworfen 🚫`);
    io.emit("forceLogout", { reason: "Du wurdest gekickt." });
  });

  socket.on("banUser", (data) => {
    const me = sessions[data.token];
    const target = data.targetUser;
    if (!isOwner(me)) return;
    banned.add(target);
    sendSystem(`${target} wurde permanent gebannt ❌`);
    io.emit("forceLogout", { reason: "Du wurdest gebannt." });
  });

  socket.on("promoteAdmin", (data) => {
    const me = sessions[data.token];
    const target = data.targetUser;
    if (!isOwner(me)) return;
    if (users[target]) {
      users[target].role = "admin";
      sendSystem(`${target} ist jetzt Mitbesitzer 👑`);
      broadcastUserlist();
    }
  });

  socket.on("disconnect", () => {
    if (username) {
      console.log(`${username} hat verlassen`);
      sendSystem(`${username} ist offline 💨`);
      broadcastUserlist();
    }
  });
});

function isOwner(u) {
  return users[u]?.role === "owner";
}
function isMod(u) {
  return ["owner", "admin"].includes(users[u]?.role);
}

function sendSystem(text) {
  io.emit("chatMessage", { from: "System", text });
}
function broadcastUserlist() {
  const list = Object.keys(users).map((u) => ({
    username: u,
    avatar: users[u].avatar,
    color: users[u].color,
    role: users[u].role,
    language: users[u].language,
  }));
  io.emit("userlist", list);
}

server.listen(PORT, () => console.log("Server läuft auf Port", PORT));



