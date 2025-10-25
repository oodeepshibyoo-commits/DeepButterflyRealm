// === DeepButterflyRealm SERVER ===
// Node.js + Express + Socket.IO + Google Translate Proxy

import express from "express";
import http from "http";
import { Server } from "socket.io";
import bcrypt from "bcrypt";
import fetch from "node-fetch"; // Wichtig für Übersetzung
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(__dirname)); // index.html usw.

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "DEIN_KEY_HIER";

// === DATEN ===
let users = {};      // username -> { passwordHash, avatar, color, language, theme, role, banned }
let sessions = {};   // token -> username
let online = {};     // username -> socket.id
let roomPositions = {}; // username -> {x,y,avatar,color,role}

// === Helper ===
function makeToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}
function isOwner(user) {
  return users[user] && users[user].role === "owner";
}

// === Routen ===

// Registrierung
app.post("/register", async (req, res) => {
  const { username, password, avatar, color, language, theme } = req.body;
  if (!username || !password)
    return res.json({ ok: false, error: "Fehlender Name oder Passwort" });
  if (users[username])
    return res.json({ ok: false, error: "Name existiert bereits" });

  const hash = await bcrypt.hash(password, 10);
  const role = Object.keys(users).length === 0 ? "owner" : "user"; // erster ist Owner
  users[username] = { passwordHash: hash, avatar, color, language, theme, role, banned: false };
  return res.json({ ok: true, role });
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user) return res.json({ ok: false, error: "Unbekannter Nutzer" });
  if (user.banned) return res.json({ ok: false, error: "Gebannt" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.json({ ok: false, error: "Falsches Passwort" });

  const token = makeToken();
  sessions[token] = username;
  return res.json({
    ok: true,
    token,
    profile: { username, avatar: user.avatar, color: user.color, language: user.language, theme: user.theme, role: user.role }
  });
});

// Profil speichern
app.post("/profile", (req, res) => {
  const { token, avatar, color, language, theme } = req.body;
  const username = sessions[token];
  if (!username || !users[username]) return res.json({ ok: false, error: "Ungültig" });

  Object.assign(users[username], { avatar, color, language, theme });
  return res.json({
    ok: true,
    profile: { username, avatar, color, language, theme, role: users[username].role }
  });
});

// === 🧠 Übersetzungs-Proxy ===
app.post("/translateText", async (req, res) => {
  try {
    const { text, target } = req.body || {};
    if (!text || !target)
      return res.json({ ok: false, error: "missing text/target" });

    const gRes = await fetch("https://translation.googleapis.com/language/translate/v2?key=" + GOOGLE_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, target })
    });

    if (!gRes.ok) return res.json({ ok: false, error: "API-Fehler" });
    const data = await gRes.json();
    const tr = data?.data?.translations?.[0];
    if (!tr) return res.json({ ok: false, error: "Keine Übersetzung" });

    return res.json({ ok: true, translatedText: tr.translatedText, detectedSource: tr.detectedSourceLanguage || "auto" });
  } catch (e) {
    console.error("translateText error", e);
    return res.json({ ok: false, error: "Serverfehler" });
  }
});

// === SOCKET.IO ===
io.on("connection", (socket) => {
  console.log("Socket verbunden:", socket.id);

  socket.on("joinChat", (token) => {
    const username = sessions[token];
    if (!username || !users[username]) {
      socket.emit("forceLogout", { reason: "Ungültige Sitzung" });
      return;
    }

    users[username].socketId = socket.id;
    online[username] = socket.id;

    io.emit("userlist", getOnlineList());
    roomPositions[username] = roomPositions[username] || { x: 20, y: 20, avatar: users[username].avatar, color: users[username].color, role: users[username].role };
    io.emit("roomUpdate", roomPositions);
  });

  socket.on("sendMessage", (data) => {
    const username = sessions[data.token];
    if (!username || !users[username]) return;

    const msg = {
      from: username,
      avatar: users[username].avatar,
      color: users[username].color,
      role: users[username].role,
      text: data.text
    };
    io.emit("chatMessage", msg);
  });

  socket.on("moveAvatar", (data) => {
    const username = sessions[data.token];
    if (!username || !users[username]) return;
    roomPositions[username] = {
      x: data.x,
      y: data.y,
      avatar: users[username].avatar,
      color: users[username].color,
      role: users[username].role
    };
    io.emit("roomUpdate", roomPositions);
  });

  socket.on("promoteAdmin", (data) => {
    const admin = sessions[data.token];
    if (!admin || !isOwner(admin)) return;
    const target = users[data.targetUser];
    if (target) {
      target.role = "admin";
      io.emit("chatMessage", { from: "System", text: `${data.targetUser} ist jetzt Mitbesitzer 👑` });
      io.emit("userlist", getOnlineList());
    }
  });

  socket.on("kickUser", (data) => {
    const admin = sessions[data.token];
    if (!admin || !(isOwner(admin) || users[admin].role === "admin")) return;
    const target = data.targetUser;
    const targetSocket = online[target];
    if (targetSocket) io.to(targetSocket).emit("forceLogout", { reason: "Du wurdest gekickt." });
    delete online[target];
    io.emit("userlist", getOnlineList());
  });

  socket.on("banUser", (data) => {
    const admin = sessions[data.token];
    if (!admin || !(isOwner(admin) || users[admin].role === "admin")) return;
    const target = data.targetUser;
    if (users[target]) users[target].banned = true;
    const targetSocket = online[target];
    if (targetSocket) io.to(targetSocket).emit("forceLogout", { reason: "Du wurdest gebannt." });
    delete online[target];
    io.emit("userlist", getOnlineList());
  });

  socket.on("disconnect", () => {
    for (const u in online) {
      if (online[u] === socket.id) {
        delete online[u];
        io.emit("userlist", getOnlineList());
      }
    }
  });
});

function getOnlineList() {
  return Object.keys(online).map(u => ({
    username: u,
    avatar: users[u].avatar,
    color: users[u].color,
    language: users[u].language,
    role: users[u].role
  }));
}

// === SERVER START ===
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("🦋 Server läuft auf Port " + PORT));



