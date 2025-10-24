// DeepButterfly Realm Server 💜 Online Version
// Funktionen:
// - Registrierung (Name, Passwort, Avatar Emoji, Farbe, Sprache, Theme)
// - Login mit Passwort
// - Owner 👑 Login ohne Passwort für dich
// - Jeder kann sein Profil alleine ändern (du musst nix erlauben)
// - Livechat mit allen (socket.io)
// - Online-Liste
//
// Wichtig: Der ALLERERSTE Account, der sich registriert, wird automatisch "owner" 👑
// Das bist du (Queen).

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

const PORT = process.env.PORT || 3000;
const JWT_SECRET = "butterfly-secret-please-change";

app.use(express.json());
app.use(cors());

// index.html usw. ausliefern
app.use(express.static(path.join(__dirname)));

// "Datenbank" im Speicher (geht verloren wenn Server neu startet)
const usersByName = {};
const onlineUsers = {};

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

// REGISTRIEREN
app.post("/register", async (req, res) => {
    const { username, password, avatar, color, language, theme } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ error: "username und password sind nötig" });
    }
    if (usersByName[username]) {
        return res.status(400).json({ error: "Name schon vergeben" });
    }

    // Erster Account => Owner 👑
    const isFirst = Object.keys(usersByName).length === 0;
    const role = isFirst ? "owner" : "user";

    const passHash = await bcrypt.hash(password, 10);

    usersByName[username] = {
        username,
        passHash,
        avatar:   avatar   || "⭐",
        color:    color    || "#ffffff",
        language: language || "de",
        theme:    theme    || "default",
        role
    };

    return res.json({
        ok: true,
        message: "Account erstellt",
        role
    });
});

// LOGIN (mit Passwort) ODER Owner-Login ohne Passwort
app.post("/login", async (req, res) => {
    const { username, password, ownerMode } = req.body || {};

    // Owner Modus: ohne Passwort rein
    if (ownerMode === true) {
        const owner = Object.values(usersByName).find(u => u.role === "owner");
        if (!owner) {
            return res.status(400).json({ error: "Kein Owner gefunden. Bitte zuerst normalen Account registrieren." });
        }
        const tokenOwner = jwt.sign({ username: owner.username }, JWT_SECRET, { expiresIn: "12h" });
        return res.json({ ok:true, token: tokenOwner, profile: publicUser(owner) });
    }

    // normaler Login
    if (!username || !password) {
        return res.status(400).json({ error: "Fehlt username oder password" });
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

    return res.json({
        ok: true,
        token,
        profile: publicUser(u)
    });
});

// PROFIL ändern
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

        return res.json({ ok:true, profile: publicUser(u) });
    } catch(e){
        return res.status(401).json({ error:"token ungültig" });
    }
});

// SOCKET.IO CHAT
io.on("connection", (socket) => {
    console.log("Socket verbunden:", socket.id);

    socket.on("joinChat", (token) => {
        try {
            const data = jwt.verify(token, JWT_SECRET);
            const u = usersByName[data.username];
            if (!u) return;

            onlineUsers[socket.id] = u.username;

            io.emit("userlist", Object.values(onlineUsers).map(un => publicUser(usersByName[un])));

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

    socket.on("sendMessage", (payload) => {
        if (!payload || !payload.token || !payload.text) return;

        try {
            const data = jwt.verify(payload.token, JWT_SECRET);
            const u = usersByName[data.username];
            if (!u) return;

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

    socket.on("disconnect", () => {
        const uname = onlineUsers[socket.id];
        delete onlineUsers[socket.id];

        io.emit("userlist", Object.values(onlineUsers).map(un => publicUser(usersByName[un])));

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

http.listen(PORT, () => {
    console.log("Server läuft auf Port " + PORT);
    console.log("Bereit ✨");
});
