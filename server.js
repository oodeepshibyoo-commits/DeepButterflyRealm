// DeepButterfly Realm Server 💜 Version v3
// Features in dieser Version:
// - Kein Owner-Quicklogin mehr (niemand kann sich einfach "Owner" nennen)
// - Erster registrierter User = role "owner"
// - Owner/Admin können:
//    * User kicken
//    * User bannen (gebannt = darf nie wieder rein)
//    * User zu "admin" machen
// - Raum mit Avataren (x/y Position)
// - Chat mit Übersetzung bleibt
// - Jeder kann eigenes Profil ändern (Avatar Emoji, Farbe, Sprache, Theme)
// - Enter schickt nicht automatisch (Client-Schutz in index.html)
//
// Wichtig: Das ist alles im RAM. Bei Render Free schläft der Server manchmal ein,
// dann ist Speicher leer und du bist wieder die Erste -> wieder owner 👑.
// Gebannte Listen und Admin-Status gehen dann auch weg, das ist normal bei Free.

const express = require("express");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");

const io = new Server(http, {
    cors: {
        origin: "*"
    }
});

// Einstellungen
const PORT = process.env.PORT || 10000;
const JWT_SECRET = "butterfly-secret-please-change";

// Middleware
app.use(express.json());
app.use(cors());

// index.html usw. ausliefern
app.use(express.static(path.join(__dirname)));

// "Datenbank" im RAM
const usersByName = {};      // username -> {username, passHash, avatar, color, language, theme, role}
const bannedUsers = {};      // username -> true (wenn gebannt)
const onlineUsers = {};      // socket.id -> username
const socketsByUser = {};    // username -> Set(socket.id)
const roomState   = {};      // username -> { x,y,avatar,color,role }

// Hilfsfunktionen
function publicUser(u) {
    return {
        username: u.username,
        avatar: u.avatar,
        color: u.color,
        language: u.language,
        theme: u.theme,
        role: u.role // "owner", "admin", "user"
    };
}

function isOwnerOrAdmin(u) {
    return u && (u.role === "owner" || u.role === "admin");
}

function broadcastUserlistAndRoom() {
    io.emit("userlist",
        Object.values(onlineUsers)
        .map(un => publicUser(usersByName[un]))
    );
    io.emit("roomUpdate", roomState);
}

// REGISTRIEREN
app.post("/register", async (req, res) => {
    const { username, password, avatar, color, language, theme } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ error: "username und password sind nötig" });
    }
    if (usersByName[username]) {
        return res.status(400).json({ error: "Name schon vergeben" });
    }
    if (bannedUsers[username]) {
        return res.status(403).json({ error: "Dieser Name ist gebannt." });
    }

    // erster Account => Owner 👑
    const isFirst = Object.keys(usersByName).length === 0;
    const role = isFirst ? "owner" : "user";

    const passHash = await bcrypt.hash(password, 10);

    usersByName[username] = {
        username,
        passHash,
        avatar:   avatar   || "🦋",
        color:    color    || "#ffffff",
        language: language || "de",
        theme:    theme    || "default",
        role
    };

    // Anfangsposition im Raum
    roomState[username] = {
        x: Math.floor(Math.random()*200)+20,
        y: Math.floor(Math.random()*120)+20,
        avatar: usersByName[username].avatar,
        color: usersByName[username].color,
        role: usersByName[username].role
    };

    return res.json({
        ok: true,
        message: "Account erstellt",
        role
    });
});

// LOGIN (immer mit Passwort jetzt)
app.post("/login", async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ error: "Fehlt username oder password" });
    }

    if (bannedUsers[username]) {
        return res.status(403).json({ error: "Du bist gebannt." });
    }

    const u = usersByName[username];
    if (!u) {
        return res.status(400).json({ error: "User existiert nicht" });
    }

    const good = await bcrypt.compare(password, u.passHash);
    if (!good) {
        return res.status(400).json({ error: "Falsches Passwort" });
    }

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "12h" });

    // Falls User noch keine Position im Raum hat
    if (!roomState[username]) {
        roomState[username] = {
            x: Math.floor(Math.random()*200)+20,
            y: Math.floor(Math.random()*120)+20,
            avatar: u.avatar,
            color:  u.color,
            role:   u.role
        };
    }

    return res.json({
        ok: true,
        token,
        profile: publicUser(u)
    });
});

// PROFIL ändern (jeder darf seins ändern)
app.post("/profile", (req,res)=> {
    const { token, avatar, color, language, theme } = req.body || {};
    if (!token) return res.status(401).json({ error:"kein token" });

    try {
        const data = jwt.verify(token, JWT_SECRET);
        const u = usersByName[data.username];
        if (!u) return res.status(400).json({ error:"user nicht gefunden" });

        if (avatar   !== undefined) u.avatar   = avatar;
        if (color    !== undefined) u.color    = color;
        if (language !== undefined) u.language = language;
        if (theme    !== undefined) u.theme    = theme;

        // Raum-Info aktualisieren
        if (roomState[u.username]) {
            roomState[u.username].avatar = u.avatar;
            roomState[u.username].color  = u.color;
            roomState[u.username].role   = u.role;
        }

        broadcastUserlistAndRoom();

        return res.json({ ok:true, profile: publicUser(u) });
    } catch(e){
        return res.status(401).json({ error:"token ungültig" });
    }
});

// SOCKET.IO ECHTZEIT
io.on("connection", (socket) => {
    console.log("Socket verbunden:", socket.id);

    // User tritt dem Chat bei
    socket.on("joinChat", (token) => {
        try {
            const data = jwt.verify(token, JWT_SECRET);
            const u = usersByName[data.username];
            if (!u) return;
            if (bannedUsers[u.username]) {
                // direkt kicken, falls gebannt
                socket.emit("forceLogout", { reason: "Du bist gebannt." });
                socket.disconnect(true);
                return;
            }

            onlineUsers[socket.id] = u.username;

            if (!socketsByUser[u.username]) {
                socketsByUser[u.username] = new Set();
            }
            socketsByUser[u.username].add(socket.id);

            // Falls keine Position -> gib ihm eine
            if (!roomState[u.username]) {
                roomState[u.username] = {
                    x: Math.floor(Math.random()*200)+20,
                    y: Math.floor(Math.random()*120)+20,
                    avatar: u.avatar,
                    color:  u.color,
                    role:   u.role
                };
            }

            broadcastUserlistAndRoom();

            // Chat-Systemmessage
            io.emit("chatMessage", {
                from: "System",
                color: "#888",
                avatar: "💬",
                role: "system",
                text: u.username + " ist jetzt online 💫",
                timestamp: Date.now()
            });

        } catch(e){
            console.log("joinChat token ungültig oder fehlt");
        }
    });

    // User bewegt seinen Avatar im Raum
    socket.on("moveAvatar", (payload) => {
        // payload = { token, x, y }
        if (!payload || !payload.token) return;
        try {
            const data = jwt.verify(payload.token, JWT_SECRET);
            const u = usersByName[data.username];
            if (!u) return;
            if (bannedUsers[u.username]) return;

            // Position speichern
            roomState[u.username] = roomState[u.username] || {};
            roomState[u.username].x = payload.x;
            roomState[u.username].y = payload.y;
            roomState[u.username].avatar = u.avatar;
            roomState[u.username].color  = u.color;
            roomState[u.username].role   = u.role;

            broadcastUserlistAndRoom();
        } catch(e){
            console.log("moveAvatar token ungültig");
        }
    });

    // Chat Nachricht senden
    socket.on("sendMessage", (payload) => {
        // payload = { token, text }
        if (!payload || !payload.token || !payload.text) return;
        try {
            const data = jwt.verify(payload.token, JWT_SECRET);
            const u = usersByName[data.username];
            if (!u) return;
            if (bannedUsers[u.username]) return;

            io.emit("chatMessage", {
                from: u.username,
                color: u.color,
                avatar: u.avatar,
                role: u.role,
                text: payload.text,
                timestamp: Date.now()
            });
        } catch(e){
            console.log("sendMessage token ungültig");
        }
    });

    // ADMIN ACTIONS: promoteAdmin / kickUser / banUser
    socket.on("promoteAdmin", (payload) => {
        // { token, targetUser }
        if (!payload || !payload.token || !payload.targetUser) return;
        try {
            const data = jwt.verify(payload.token, JWT_SECRET);
            const acting = usersByName[data.username];
            if (!acting) return;
            if (acting.role !== "owner") return; // Nur der Owner darf Admin verteilen

            const target = usersByName[payload.targetUser];
            if (!target) return;
            if (target.role === "owner") return; // Owner bleibt Owner
            target.role = "admin";

            // RaumState aktualisieren
            if (roomState[target.username]) {
                roomState[target.username].role = target.role;
            }

            broadcastUserlistAndRoom();

            io.emit("chatMessage", {
                from: "System",
                color: "#ffd93b",
                avatar: "👑",
                role: "system",
                text: payload.targetUser + " wurde Admin 👑",
                timestamp: Date.now()
            });
        } catch(e){
            console.log("promoteAdmin token ungültig");
        }
    });

    socket.on("kickUser", (payload) => {
        // { token, targetUser }
        if (!payload || !payload.token || !payload.targetUser) return;
        try {
            const data = jwt.verify(payload.token, JWT_SECRET);
            const acting = usersByName[data.username];
            if (!acting) return;
            if (!isOwnerOrAdmin(acting)) return; // owner oder admin

            const targetName = payload.targetUser;
            if (!targetName) return;
            const targetUser = usersByName[targetName];
            if (!targetUser) return;
            if (targetUser.role === "owner") return; // Owner nicht kicken

            // alle sockets von target kicken
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
                timestamp: Date.now()
            });

        } catch(e){
            console.log("kickUser token ungültig");
        }
    });

    socket.on("banUser", (payload) => {
        // { token, targetUser }
        if (!payload || !payload.token || !payload.targetUser) return;
        try {
            const data = jwt.verify(payload.token, JWT_SECRET);
            const acting = usersByName[data.username];
            if (!acting) return;
            if (!isOwnerOrAdmin(acting)) return;

            const targetName = payload.targetUser;
            const targetUser = usersByName[targetName];
            if (!targetUser) return;
            if (targetUser.role === "owner") return; // Owner NIE bannen

            bannedUsers[targetName] = true;

            // alle sockets von target rauswerfen
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
                timestamp: Date.now()
            });

        } catch(e){
            console.log("banUser token ungültig");
        }
    });

    // Disconnect
    socket.on("disconnect", () => {
        const uname = onlineUsers[socket.id];
        delete onlineUsers[socket.id];

        // socket aus user-Set entfernen
        if (uname && socketsByUser[uname]) {
            socketsByUser[uname].delete(socket.id);
            if (socketsByUser[uname].size === 0) {
                delete socketsByUser[uname];
            }
        }

        broadcastUserlistAndRoom();

        if (uname) {
            io.emit("chatMessage", {
                from: "System",
                color: "#888",
                avatar: "💬",
                role: "system",
                text: uname + " hat den Raum verlassen.",
                timestamp: Date.now()
            });
        }
        console.log("Socket getrennt:", socket.id);
    });
});

// Server starten
http.listen(PORT, () => {
    console.log("Server läuft auf Port " + PORT);
    console.log("Bereit ✨");
});

