// DeepButterflyRealm 💜👑
// Voll-Server für Render, CommonJS-Version (require statt import)
//
// Features:
// - Registrierung / Login
// - Profile speichern (Avatar, Farbe, Sprache, Theme)
// - Rollen: owner / coOwner / admin / user
// - Kick / Ban / Unban / Owner geben / Owner wegnehmen
// - Raum: Avatare bewegen, Sitzplätze
// - TicTacToe Spiel Lobby + Spiel
// - Chat Broadcast
// - Übersetzungs-Proxy (/translateText -> Google API)
//
// Wichtig für dich bei Render:
// 1. Build Command: npm install
// 2. Start Command: node server.js
// 3. Env Variable setzen: GOOGLE_API_KEY = (dein Google-Key)
//
// Hinweis: Alles ist "In Memory". Wenn der Server neu startet, sind Accounts weg.
// Für jetzt ist das okay, weil wir erstmal "es läuft" wollen.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fetch = require("node-fetch"); // aus package.json
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

// -------------------------
// Speicher im RAM
// -------------------------
//
// users = {
//   "DeepButterflyMusic": {
//      passwordHash: "...",
//      avatarUrl: "https://...gif" oder "🦋",
//      color: "#ff4dfd",
//      language: "de",
//      theme: "butterfly",
//      role: "owner" | "coOwner" | "admin" | "user",
//      banned: false
//   },
//   ...
// }
const users = Object.create(null);

// tokens = { tokenString: "username" }
const tokens = Object.create(null);

// online = { username: socketId }
const online = Object.create(null);

// roomState speichert Sitzplätze + Avatarpositionen
// roomState.avatars[name] = { x,y, seatIndex, avatarUrl,color,role }
const roomState = {
  seats: [
    { x:30,  y:100, label:"💺" }, // Stuhl 1
    { x:90,  y:100, label:"💺" }, // Stuhl 2
    { x:150, y:100, label:"💺" }, // Stuhl 3
    { x:210, y:100, label:"🛋" }  // Couch / AFK
  ],
  avatars: Object.create(null)
};

// TicTacToe Spielzustand für eine Lobby
// Wir halten es erstmal simpel: nur 1 laufendes Spiel
let gameState = null;
// gameState = {
//   type: "tictactoe",
//   host: "Name",
//   open: true,
//   started: false,
//   players: ["Name1","Name2"],
//   board: ["","","","","","","","",""],
//   turn: "Name1",
//   winner: null
// }

// -------------------------
// Hilfsfunktionen
// -------------------------
function hashPass(pw){
  return crypto.createHash("sha256").update(pw).digest("hex");
}
function makeToken(){
  return crypto.randomBytes(16).toString("hex");
}
function getUserByToken(token){
  const u = tokens[token];
  if(!u) return null;
  if(!users[u]) return null;
  return u;
}
function isMod(role){
  return role==="owner" || role==="coOwner" || role==="admin";
}
function canChangeOwner(role){
  // Nur echter owner darf Owner setzen/wegnehmen
  return role==="owner";
}

// Gewinner-Erkennung TicTacToe
function checkTicTacWinner(board){
  const wins = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for(const [a,b,c] of wins){
    if(board[a]!=="" && board[a]===board[b] && board[b]===board[c]){
      return board[a]; // "X" oder "O"
    }
  }
  if(board.every(v=>v!=="")){
    return "draw";
  }
  return null;
}
// Welches Zeichen hat welcher Spieler
function markForPlayer(username, players){
  // Spieler[0] = X, Spieler[1] = O
  const i = players.indexOf(username);
  if(i===0) return "X";
  if(i===1) return "O";
  return null;
}

// Broadcast Helfer
function broadcastUserlist(){
  const list = Object.keys(online).map(u=>{
    const info = users[u] || {};
    return {
      username: u,
      avatarUrl: info.avatarUrl || "",
      color: info.color || "#fff",
      language: info.language || "de",
      role: info.role || "user"
    };
  });
  io.emit("userlist", list);
}
function broadcastRoom(){
  io.emit("roomUpdate", {
    seats: roomState.seats,
    avatars: roomState.avatars
  });
}
function broadcastGame(){
  io.emit("gameState", gameState);
}
function sendSystemMessage(txt){
  io.emit("chatMessage", {
    from: "System",
    avatarUrl: "",
    color: "#888",
    role: "system",
    text: txt,
    timestamp: Date.now()
  });
}

// -------------------------
// Middleware / Static
// -------------------------
app.use(express.json());

// statische Dateien: index.html liegt im selben Ordner wie server.js
app.use(express.static(path.join(__dirname)));

// -------------------------
// /translateText -> Google API
// -------------------------
app.post("/translateText", async (req,res)=>{
  if(!GOOGLE_API_KEY){
    return res.json({ok:false,error:"SERVER: GOOGLE_API_KEY fehlt"});
  }
  const { text, target } = req.body || {};
  if(!text || !target){
    return res.json({ok:false,error:"missing text/target"});
  }

  try {
    const gRes = await fetch(
      "https://translation.googleapis.com/language/translate/v2?key="+GOOGLE_API_KEY,
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          q: text,
          target: target
        })
      }
    );
    if(!gRes.ok){
      return res.json({ok:false,error:"google upstream error"});
    }
    const data = await gRes.json();
    const tr = data?.data?.translations?.[0];
    if(!tr){
      return res.json({ok:false,error:"no translation"});
    }
    return res.json({
      ok:true,
      translatedText: tr.translatedText,
      detectedSource: tr.detectedSourceLanguage || "auto"
    });
  } catch(err){
    console.error("translate error",err);
    return res.json({ok:false,error:"server translate fail"});
  }
});

// -------------------------
// Registrierung
// body: { username, password, avatarUrl, color, language, theme }
app.post("/register",(req,res)=>{
  const { username, password, avatarUrl, color, language, theme } = req.body || {};

  if(!username || !password){
    return res.json({ok:false,error:"Name/Passwort fehlen"});
  }
  if(users[username]){
    return res.json({ok:false,error:"Name existiert schon"});
  }

  // erste Person, die sich jemals registriert -> owner
  const firstUser = Object.keys(users).length===0;
  const role = firstUser ? "owner" : "user";

  users[username] = {
    passwordHash: hashPass(password),
    avatarUrl: avatarUrl || "🦋",
    color: color || "#ff4dfd",
    language: language || "de",
    theme: theme || "default",
    role,
    banned: false
  };

  return res.json({ok:true,role});
});

// -------------------------
// Login
// body: { username, password }
app.post("/login",(req,res)=>{
  const { username, password } = req.body || {};
  if(!username || !password){
    return res.json({ok:false,error:"Fehlt"});
  }

  const u = users[username];
  if(!u) return res.json({ok:false,error:"Nicht gefunden"});
  if(u.banned) return res.json({ok:false,error:"Gebannt"});
  if(hashPass(password)!==u.passwordHash){
    return res.json({ok:false,error:"Falsches Passwort"});
  }

  const token = makeToken();
  tokens[token] = username;

  // Avatar im Raum vorbereiten
  if(!roomState.avatars[username]){
    roomState.avatars[username] = {
      x: 40,
      y: 40,
      seatIndex: null,
      avatarUrl: u.avatarUrl || "🦋",
      color: u.color || "#fff",
      role: u.role || "user"
    };
  } else {
    // sync Rolle + Farbe
    roomState.avatars[username].role = u.role;
    roomState.avatars[username].color = u.color;
    roomState.avatars[username].avatarUrl = u.avatarUrl || "🦋";
  }

  return res.json({
    ok:true,
    token,
    profile:{
      username,
      avatarUrl: u.avatarUrl,
      color: u.color,
      language: u.language,
      theme: u.theme,
      role: u.role
    }
  });
});

// -------------------------
// Profil speichern
// body: { token, avatarUrl, color, language, theme }
app.post("/profile",(req,res)=>{
  const { token, avatarUrl, color, language, theme } = req.body || {};
  const username = getUserByToken(token);
  if(!username){
    return res.json({ok:false,error:"Ungültiger Token"});
  }
  const u = users[username];
  if(!u){
    return res.json({ok:false,error:"Kein User"});
  }

  if(typeof avatarUrl==="string") u.avatarUrl=avatarUrl;
  if(typeof color==="string")     u.color=color;
  if(typeof language==="string")  u.language=language;
  if(typeof theme==="string")     u.theme=theme;

  // auch im Raum speichern
  if(roomState.avatars[username]){
    roomState.avatars[username].avatarUrl = u.avatarUrl;
    roomState.avatars[username].color     = u.color;
    roomState.avatars[username].role      = u.role;
  }

  return res.json({
    ok:true,
    profile:{
      username,
      avatarUrl: u.avatarUrl,
      color: u.color,
      language: u.language,
      theme: u.theme,
      role: u.role
    }
  });
});

// -------------------------
// SOCKET.IO Echtzeit
// -------------------------
io.on("connection", socket => {

  // wer ist dieser socket?
  let myName = null;

  // joinChat: Client sagt "ich bin da"
  socket.on("joinChat",(token)=>{
    const username = getUserByToken(token);
    if(!username){
      socket.emit("forceLogout",{reason:"Ungültige Sitzung"});
      return;
    }
    const u = users[username];
    if(!u || u.banned){
      socket.emit("forceLogout",{reason:"Gebannt"});
      return;
    }

    myName = username;
    online[username] = socket.id;

    // sync Raumdaten nochmal
    if(!roomState.avatars[username]){
      roomState.avatars[username] = {
        x:40,y:40,
        seatIndex:null,
        avatarUrl: u.avatarUrl || "🦋",
        color: u.color || "#fff",
        role: u.role || "user"
      };
    } else {
      roomState.avatars[username].avatarUrl = u.avatarUrl || "🦋";
      roomState.avatars[username].color     = u.color || "#fff";
      roomState.avatars[username].role      = u.role || "user";
    }

    broadcastUserlist();
    broadcastRoom();
    broadcastGame();
    sendSystemMessage(username+" ist online 💜");
  });

  // Chat Nachricht senden
  // data: { token, text }
  socket.on("sendMessage",(data)=>{
    const username = getUserByToken(data.token);
    if(!username) return;
    const u = users[username];
    if(!u || u.banned){
      socket.emit("forceLogout",{reason:"Gebannt"});
      return;
    }

    io.emit("chatMessage",{
      from: username,
      text: data.text,
      color: u.color,
      role: u.role,
      avatarUrl: u.avatarUrl || "🦋",
      timestamp: Date.now()
    });
  });

  // Avatar bewegen
  // data: { token, x, y }
  socket.on("moveAvatar",(data)=>{
    const username = getUserByToken(data.token);
    if(!username) return;
    const u = users[username];
    if(!u || u.banned) return;

    const av = roomState.avatars[username];
    if(!av) return;

    // wenn der User gerade auf einem Sitz sitzt, darf er nicht laufen
    if(av.seatIndex !== null){
      return;
    }

    let nx = data.x;
    let ny = data.y;
    if(nx<0) nx=0;
    if(ny<0) ny=0;
    if(nx>600) nx=600;
    if(ny>260) ny=260;

    av.x = nx;
    av.y = ny;
    av.avatarUrl = u.avatarUrl||"🦋";
    av.color     = u.color||"#fff";
    av.role      = u.role||"user";

    broadcastRoom();
  });

  // Hinsetzen auf Sitz
  // data: { token, seatIndex }
  socket.on("sitOnSeat",(data)=>{
    const username = getUserByToken(data.token);
    if(!username) return;
    const u = users[username];
    if(!u || u.banned) return;
    const av = roomState.avatars[username];
    if(!av) return;

    const seat = roomState.seats[data.seatIndex];
    if(!seat) return;

    // prüfen ob Platz frei
    let taken = false;
    for(const who in roomState.avatars){
      if(roomState.avatars[who].seatIndex === data.seatIndex){
        taken = true;
        break;
      }
    }
    if(taken){
      return;
    }

    av.seatIndex = data.seatIndex;
    av.x = seat.x;
    av.y = seat.y;
    av.avatarUrl = u.avatarUrl||"🦋";
    av.color     = u.color||"#fff";
    av.role      = u.role||"user";

    broadcastRoom();
  });

  // === Admin-Aktionen ===
  // data: { token, action, targetUser }
  // action = "kick" | "ban" | "unban" | "makeOwner" | "removeOwner" | "makeCoOwner" | "removeCoOwner"
  socket.on("adminAction",(data)=>{
    const actorName = getUserByToken(data.token);
    if(!actorName){
      socket.emit("adminResult",{ok:false,msg:"Nicht eingeloggt"});
      return;
    }
    const actorInfo = users[actorName];
    if(!actorInfo){
      socket.emit("adminResult",{ok:false,msg:"Kein User"});
      return;
    }
    const targetName = data.targetUser;
    const targetInfo = users[targetName];
    if(!targetInfo){
      socket.emit("adminResult",{ok:false,msg:"Ziel existiert nicht"});
      return;
    }

    const actorRole = actorInfo.role;
    const targetRole = targetInfo.role;

    // Basisschutz:
    if(!isMod(actorRole)){
      socket.emit("adminResult",{ok:false,msg:"Keine Rechte"});
      return;
    }

    // Owner darf alles, CoOwner/Admin dürfen NICHT gegen Owner
    if(targetRole==="owner" && actorRole!=="owner"){
      socket.emit("adminResult",{ok:false,msg:"Darfst Owner nicht anfassen"});
      return;
    }

    switch(data.action){

      case "kick": {
        // Kick = rauswerfen jetzt, er kann aber wiederkommen
        // forceLogout nur für den targetUser
        const sid = online[targetName];
        if(sid){
          const sockKick = io.sockets.sockets.get(sid);
          if(sockKick){
            sockKick.emit("forceLogout",{reason:"Du wurdest gekickt von "+actorName});
            sockKick.disconnect(true);
          }
        }
        delete online[targetName];
        delete roomState.avatars[targetName];
        sendSystemMessage(`${targetName} wurde gekickt von ${actorName} 🚫`);
        broadcastUserlist();
        broadcastRoom();
        socket.emit("adminResult",{ok:true,msg:"Gekickt"});
        break;
      }

      case "ban": {
        // Nur owner darf ban aussprechen gegen coOwner/admin/user?
        // Wir erlauben auch coOwner/admin zu bannen, aber NICHT owner.
        targetInfo.banned = true;

        const sid = online[targetName];
        if(sid){
          const sockBan = io.sockets.sockets.get(sid);
          if(sockBan){
            sockBan.emit("forceLogout",{reason:"Gebannt von "+actorName});
            sockBan.disconnect(true);
          }
        }
        delete online[targetName];
        delete roomState.avatars[targetName];

        sendSystemMessage(`${targetName} wurde gebannt von ${actorName} ❌`);
        broadcastUserlist();
        broadcastRoom();
        socket.emit("adminResult",{ok:true,msg:"Gebannt"});
        break;
      }

      case "unban": {
        targetInfo.banned = false;
        sendSystemMessage(`${targetName} wurde entbannt von ${actorName} 💖`);
        broadcastUserlist();
        socket.emit("adminResult",{ok:true,msg:"Entbannt"});
        break;
      }

      case "makeOwner": {
        // Nur aktueller Owner darf neuen Owner bestimmen
        if(!canChangeOwner(actorRole)){
          socket.emit("adminResult",{ok:false,msg:"Nur Owner darf Owner setzen"});
          return;
        }

        // der alte Owner verliert Krone → wird coOwner
        for(const name in users){
          if(users[name].role==="owner"){
            users[name].role="coOwner";
            if(roomState.avatars[name]){
              roomState.avatars[name].role="coOwner";
            }
          }
        }

        users[targetName].role = "owner";
        if(roomState.avatars[targetName]){
          roomState.avatars[targetName].role="owner";
        }

        sendSystemMessage(`${targetName} ist jetzt OWNER 👑 (von ${actorName})`);
        broadcastUserlist();
        broadcastRoom();
        socket.emit("adminResult",{ok:true,msg:"Owner vergeben"});
        break;
      }

      case "removeOwner": {
        // Nur Owner darf Owner wieder wegnehmen
        if(!canChangeOwner(actorRole)){
          socket.emit("adminResult",{ok:false,msg:"Nur Owner darf Owner wegnehmen"});
          return;
        }

        users[targetName].role = "user";
        if(roomState.avatars[targetName]){
          roomState.avatars[targetName].role="user";
        }

        sendSystemMessage(`${targetName} ist kein Owner mehr (von ${actorName}) 💔`);
        broadcastUserlist();
        broadcastRoom();
        socket.emit("adminResult",{ok:true,msg:"Owner entfernt"});
        break;
      }

      case "makeCoOwner": {
        // nur Owner darf coOwner verleihen
        if(!canChangeOwner(actorRole)){
          socket.emit("adminResult",{ok:false,msg:"Nur Owner darf CoOwner setzen"});
          return;
        }
        users[targetName].role="coOwner";
        if(roomState.avatars[targetName]){
          roomState.avatars[targetName].role="coOwner";
        }
        sendSystemMessage(`${targetName} ist jetzt Co-Owner 👑`);
        broadcastUserlist();
        broadcastRoom();
        socket.emit("adminResult",{ok:true,msg:"CoOwner gesetzt"});
        break;
      }

      case "removeCoOwner": {
        // nur Owner darf coOwner entfernen
        if(!canChangeOwner(actorRole)){
          socket.emit("adminResult",{ok:false,msg:"Nur Owner darf CoOwner entfernen"});
          return;
        }
        users[targetName].role="user";
        if(roomState.avatars[targetName]){
          roomState.avatars[targetName].role="user";
        }
        sendSystemMessage(`${targetName} ist kein Co-Owner mehr 💔`);
        broadcastUserlist();
        broadcastRoom();
        socket.emit("adminResult",{ok:true,msg:"CoOwner entfernt"});
        break;
      }

      default: {
        socket.emit("adminResult",{ok:false,msg:"Unbekannte Aktion"});
      }
    }
  });

  // === SPIEL-LOGIK ===
  // gameCreate {token}
  socket.on("gameCreate",(data)=>{
    const username = getUserByToken(data.token);
    if(!username) return;
    const u = users[username];
    if(!u || u.banned) return;

    // Nur Mods dürfen Spiele erstellen (kannst du später lockern)
    if(!isMod(u.role)) return;

    gameState = {
      type: "tictactoe",
      host: username,
      open: true,
      started: false,
      players: [username],
      board: ["","","","","","","","",""],
      turn: username,
      winner: null
    };
    broadcastGame();
    sendSystemMessage(`${username} hat ein TicTacToe-Spiel erstellt 🎮`);
  });

  // gameJoin {token}
  socket.on("gameJoin",(data)=>{
    const username = getUserByToken(data.token);
    if(!username || !gameState) return;
    const u = users[username];
    if(!u || u.banned) return;
    if(!gameState.open) return;

    if(!gameState.players.includes(username)){
      if(gameState.players.length>=2){
        return; // voll
      }
      gameState.players.push(username);
    }
    broadcastGame();
    sendSystemMessage(`${username} ist dem Spiel beigetreten 🎮`);
  });

  // gameLock {token}
  // Host oder Owner darf Spiel "starten" (close/open = false, started = true)
  socket.on("gameLock",(data)=>{
    const username = getUserByToken(data.token);
    if(!username || !gameState) return;
    const u = users[username];
    if(!u || u.banned) return;

    const isHost = (gameState.host===username);
    const amOwner = (u.role==="owner");

    if(!(isHost || amOwner)) return;

    gameState.open = false;
    gameState.started = true;
    gameState.winner = null;
    if(!Array.isArray(gameState.board) || gameState.board.length!==9){
      gameState.board = ["","","","","","","","",""];
    }
    if(gameState.players.length>0){
      gameState.turn = gameState.players[0];
    }
    broadcastGame();
    sendSystemMessage(`Spiel wurde gestartet von ${username} 🚀`);
  });

  // gameMove {token,index}
  socket.on("gameMove",(data)=>{
    const username = getUserByToken(data.token);
    if(!username || !gameState) return;
    if(!gameState.started) return;
    if(gameState.winner) return;
    if(!gameState.players.includes(username)) return;
    if(gameState.turn !== username) return;

    const i = data.index;
    if(i<0 || i>8) return;
    if(gameState.board[i] !== "") return;

    const mark = markForPlayer(username, gameState.players); // "X" oder "O"
    if(!mark) return;

    gameState.board[i] = mark;

    const win = checkTicTacWinner(gameState.board);
    if(win==="X" || win==="O"){
      // Gewinner Name ermitteln
      let whoWin = null;
      gameState.players.forEach((p,idx)=>{
        if((idx===0 && win==="X") || (idx===1 && win==="O")){
          whoWin = p;
        }
      });
      gameState.winner = whoWin || "???";
    } else if(win==="draw"){
      gameState.winner = "Unentschieden 🤝";
    } else {
      // nächster Spieler
      if(gameState.players.length===2){
        const [p0,p1] = gameState.players;
        gameState.turn = (gameState.turn===p0 ? p1 : p0);
      }
    }

    broadcastGame();
  });

  // Disconnect
  socket.on("disconnect", ()=>{
    if(myName){
      delete online[myName];
      // wir entfernen Avatar aus Raum, damit "offline" nicht rumsteht
      delete roomState.avatars[myName];
      broadcastUserlist();
      broadcastRoom();
      sendSystemMessage(myName+" hat verlassen 💨");
    }
  });

});

// -------------------------
// Server starten
// -------------------------
server.listen(PORT, ()=>{
  console.log("Server läuft auf Port", PORT);
});



