// server.js
// DeepButterflyRealm COMPLETE SERVER
// Features: Login/Register, Rollen, Kick/Ban/Unban, Owner geben/wegnehmen,
// Raum (Avatare bewegen + Sitzen), Chat Broadcast, TicTacToe Lobby/Spiel,
// Übersetzungs-Proxy zu Google Translate (GOOGLE_API_KEY).
//
// WICHTIG: Vor Deploy in Render: setze eine ENV Variable GOOGLE_API_KEY mit deinem Key.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const fetch = require("node-fetch"); // falls Render Node 22: evtl global fetch vorhanden, aber wir lassen das hier
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

// ==========================
// In-Memory Speicher
// ==========================
// users[username] = {
//   passwordHash,
//   avatarUrl, color, language, theme,
//   role: "owner"|"coOwner"|"admin"|"user",
//   banned: false
// }
// WICHTIG: avatarUrl ist ein Bild/GIF Link (für animierte Avatare)
const users = Object.create(null);

// tokens[token] = username
const tokens = Object.create(null);

// online[username] = socket.id
const online = Object.create(null);

// Raumzustand
// roomState.avatars[username] = { x,y, seatIndex:null|number, avatarUrl,color,role }
const roomState = {
  seats: [
    { x:30,  y:100, label:"💺" }, // Stuhl
    { x:90,  y:100, label:"💺" },
    { x:150, y:100, label:"💺" },
    { x:210, y:100, label:"🛋" }  // Couch / AFK
  ],
  avatars: Object.create(null)
};

// TicTacToe-Spielzustand (nur 1 Spiel zur Zeit, reicht erstmal)
let gameState = null;
// gameState = {
//   type: "tictactoe",
//   host: "Name",
//   open: true,
//   started: false,
//   players: ["Name1","Name2", ...],
//   board: ["","","","","","","","",""],
//   turn: "Name1",
//   winner: null
// }

// ==================================================
// Hilfsfunktionen
// ==================================================
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
function canChangeOwner(myRole){
  // Nur owner darf Owner-Rechte vergeben/wegnehmen
  return myRole==="owner";
}
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

// Gewinner Check für TicTacToe
function checkTicTacWinner(board){
  const wins = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6]          // diag
  ];
  for(const [a,b,c] of wins){
    if(board[a]!=="" && board[a]===board[b] && board[b]===board[c]){
      return board[a]; // "X" oder "O"
    }
  }
  // check draw?
  if(board.every(v=>v!=="")){
    return "draw";
  }
  return null;
}

// wer ist "X", wer ist "O"
function markForPlayer(username, players){
  // Spieler 0 = X, 1 = O
  const idx = players.indexOf(username);
  if(idx === 0) return "X";
  if(idx === 1) return "O";
  return null;
}

// ==================================================
// Middleware / Static
// ==================================================
app.use(express.json());

// Statische Dateien (index.html, css inline, usw.)
app.use(express.static(path.join(__dirname)));

// ==================================================
// API: Übersetzen (Proxy nach Google Translate API)
// ==================================================
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

// ==================================================
// API: Registrierung
// body: { username, password, avatarUrl, color, language, theme }
app.post("/register",(req,res)=>{
  const { username, password, avatarUrl, color, language, theme } = req.body || {};

  if(!username || !password){
    return res.json({ok:false,error:"Name/Passwort fehlen"});
  }
  if(users[username]){
    return res.json({ok:false,error:"Name existiert schon"});
  }

  // prüfen ob gebannt wurde vormals? (wenn nix gespeichert -> egal)
  // Rolle standardmäßig "user"
  let role = "user";

  users[username] = {
    passwordHash: hashPass(password),
    avatarUrl: avatarUrl || "", // kann Bild/GIF sein
    color: color || "#ff4dfd",
    language: language || "de",
    theme: theme || "default",
    role,
    banned: false
  };

  return res.json({ok:true,role});
});

// ==================================================
// API: Login
// body: { username, password }
app.post("/login",(req,res)=>{
  const { username, password } = req.body || {};
  if(!username || !password){
    return res.json({ok:false,error:"Fehlt"});
  }

  const u = users[username];
  if(!u) return res.json({ok:false,error:"Nicht gefunden"});
  if(u.banned) return res.json({ok:false,error:"Gebannt"});
  if(hashPass(password) !== u.passwordHash){
    return res.json({ok:false,error:"Falsches Passwort"});
  }

  const token = makeToken();
  tokens[token] = username;

  // Raum-Avatar initialisieren falls nicht da
  if(!roomState.avatars[username]){
    roomState.avatars[username] = {
      x: 40,
      y: 40,
      seatIndex: null,
      avatarUrl: u.avatarUrl || "",
      color: u.color || "#fff",
      role: u.role || "user"
    };
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

// ==================================================
// API: Profil speichern
// body: { token, color, language, theme }
// (AvatarUrl könnte auch kommen; du kannst erweitern wie du magst)
app.post("/profile",(req,res)=>{
  const { token, color, language, theme } = req.body || {};
  const username = getUserByToken(token);
  if(!username){
    return res.json({ok:false,error:"Ungültiger Token"});
  }
  const u = users[username];
  if(!u){
    return res.json({ok:false,error:"Kein User"});
  }

  if(typeof color === "string") u.color = color;
  if(typeof language === "string") u.language = language;
  if(typeof theme === "string") u.theme = theme;

  // Raum-Avatar Farbe auch updaten
  if(roomState.avatars[username]){
    roomState.avatars[username].color = u.color;
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

// ==================================================
// SOCKET.IO
// ==================================================
io.on("connection", socket => {

  // Client sagt: ich bin online
  socket.on("joinChat",(token)=>{
    const username = getUserByToken(token);
    if(!username){
      socket.emit("forceLogout",{reason:"Ungültige Sitzung"});
      return;
    }
    if(users[username].banned){
      socket.emit("forceLogout",{reason:"Gebannt"});
      return;
    }

    online[username] = socket.id;

    // Stelle sicher, dass Raumavatar existiert
    if(!roomState.avatars[username]){
      roomState.avatars[username] = {
        x: 40, y: 40,
        seatIndex: null,
        avatarUrl: users[username].avatarUrl || "",
        color: users[username].color || "#fff",
        role: users[username].role || "user"
      };
    } else {
        // Sync Rolle/Farbe evtl geändert
        roomState.avatars[username].role  = users[username].role;
        roomState.avatars[username].color = users[username].color;
        roomState.avatars[username].avatarUrl = users[username].avatarUrl || "";
    }

    broadcastUserlist();
    broadcastRoom();
    broadcastGame(); // falls es schon ein Spiel gibt

    sendSystemMessage(`${username} ist online`);
  });

  // Chat Nachricht
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
      avatarUrl: u.avatarUrl || "",
      timestamp: Date.now()
    });
  });

  // Avatar frei bewegen
  // data: { token, x, y }
  socket.on("moveAvatar",(data)=>{
    const username = getUserByToken(data.token);
    if(!username) return;
    const u = users[username];
    if(!u || u.banned) return;

    // nur bewegen wenn NICHT auf Sitz fest
    const av = roomState.avatars[username];
    if(!av) return;
    if(av.seatIndex !== null){
      // sitzt fest: darf nicht laufen
      return;
    }

    // clamp coords grob
    let nx = data.x;
    let ny = data.y;
    if(nx<0) nx=0;
    if(ny<0) ny=0;
    if(nx>500) nx=500;
    if(ny>200) ny=200;

    av.x = nx;
    av.y = ny;
    av.avatarUrl = u.avatarUrl || "";
    av.color = u.color || "#fff";
    av.role = u.role || "user";

    broadcastRoom();
  });

  // Hinsetzen
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

    // check ob schon jemand dort sitzt
    let taken = false;
    for(const who in roomState.avatars){
      if(roomState.avatars[who].seatIndex === data.seatIndex){
        taken = true;
        break;
      }
    }
    if(taken){
      // Platz besetzt → nichts
      return;
    }

    av.seatIndex = data.seatIndex;
    av.x = seat.x;
    av.y = seat.y;
    av.avatarUrl = u.avatarUrl || "";
    av.color = u.color || "#fff";
    av.role = u.role || "user";

    broadcastRoom();
  });

  // ADMIN / OWNER Aktionen
  // data: { token, action, targetUser }
  // action = "kick" | "ban" | "unban" | "makeOwner" | "removeOwner"
  socket.on("adminAction",(data)=>{
    const actor = getUserByToken(data.token);
    if(!actor){
      socket.emit("adminResult",{ok:false,msg:"Nicht eingeloggt"});
      return;
    }
    const actorInfo = users[actor];
    if(!actorInfo){
      socket.emit("adminResult",{ok:false,msg:"Kein User"});
      return;
    }
    const target = data.targetUser;
    if(!users[target]){
      socket.emit("adminResult",{ok:false,msg:"Ziel existiert nicht"});
      return;
    }

    // Sicherheitsregeln:
    // - Niemand darf Owner anfassen außer Owner selber
    // - User ohne Rechte dürfen gar nichts
    if(!isMod(actorInfo.role)){
      socket.emit("adminResult",{ok:false,msg:"Keine Rechte"});
      return;
    }

    const targetInfo = users[target];

    if(data.action==="kick"){
      // Owner darf nicht gekickt werden von nicht-Owner
      if(targetInfo.role==="owner" && actorInfo.role!=="owner"){
        socket.emit("adminResult",{ok:false,msg:"Owner kann nicht gekickt werden"});
        return;
      }

      const sid = online[target];
      if(sid){
        const sockKick = io.sockets.sockets.get(sid);
        if(sockKick){
          sockKick.emit("forceLogout",{reason:"Gekickt von "+actor});
          sockKick.disconnect(true);
        }
      }
      delete online[target];
      delete roomState.avatars[target];
      sendSystemMessage(`${target} wurde gekickt von ${actor}`);
      broadcastUserlist();
      broadcastRoom();
      socket.emit("adminResult",{ok:true,msg:"Gekickt"});
      return;
    }

    if(data.action==="ban"){
      if(targetInfo.role==="owner" && actorInfo.role!=="owner"){
        socket.emit("adminResult",{ok:false,msg:"Owner kann nicht gebannt werden"});
        return;
      }
      targetInfo.banned = true;
      const sid = online[target];
      if(sid){
        const sockBan = io.sockets.sockets.get(sid);
        if(sockBan){
          sockBan.emit("forceLogout",{reason:"Gebannt von "+actor});
          sockBan.disconnect(true);
        }
      }
      delete online[target];
      delete roomState.avatars[target];
      sendSystemMessage(`${target} wurde gebannt von ${actor}`);
      broadcastUserlist();
      broadcastRoom();
      socket.emit("adminResult",{ok:true,msg:"Gebannt"});
      return;
    }

    if(data.action==="unban"){
      targetInfo.banned = false;
      sendSystemMessage(`${target} wurde entbannt von ${actor}`);
      broadcastUserlist();
      socket.emit("adminResult",{ok:true,msg:"Entbannt"});
      return;
    }

    if(data.action==="makeOwner"){
      // nur aktueller Owner darf Owner-Status verteilen
      if(!canChangeOwner(actorInfo.role)){
        socket.emit("adminResult",{ok:false,msg:"Nur Owner kann Owner setzen"});
        return;
      }
      // alter Owner wird zu coOwner
      for(const name in users){
        if(users[name].role==="owner"){
          users[name].role="coOwner";
          if(roomState.avatars[name]){
            roomState.avatars[name].role="coOwner";
          }
        }
      }
      users[target].role = "owner";
      if(roomState.avatars[target]){
        roomState.avatars[target].role="owner";
      }
      sendSystemMessage(`${target} ist jetzt OWNER 👑 (von ${actor})`);
      broadcastUserlist();
      broadcastRoom();
      socket.emit("adminResult",{ok:true,msg:"Owner vergeben"});
      return;
    }

    if(data.action==="removeOwner"){
      // nur aktueller Owner darf Owner entfernen
      if(!canChangeOwner(actorInfo.role)){
        socket.emit("adminResult",{ok:false,msg:"Nur Owner kann Owner wegnehmen"});
        return;
      }
      // wir machen target zu "user"
      if(users[target].role==="owner"){
        // Owner sich selbst runterstufen verbieten? du kannst entscheiden.
        // Ich lasse es zu.
      }
      users[target].role="user";
      if(roomState.avatars[target]){
        roomState.avatars[target].role="user";
      }
      sendSystemMessage(`${target} ist kein Owner mehr (von ${actor})`);
      broadcastUserlist();
      broadcastRoom();
      socket.emit("adminResult",{ok:true,msg:"Owner entfernt"});
      return;
    }

    socket.emit("adminResult",{ok:false,msg:"Unbekannte Aktion"});
  });

  // SPIEL STEUERN
  // gameCreate {token, type:"tictactoe"}
  socket.on("gameCreate",(data)=>{
    const username = getUserByToken(data.token);
    if(!username) return;

    const u = users[username];
    if(!u || u.banned) return;

    // Nur Mods dürfen Spiel erstellen? => ich mach: ja, nur Mod
    if(!isMod(u.role)){
      // wenn du willst dass jeder darf: entferne das if
      return;
    }

    // Neues Spiel anlegen
    gameState = {
      type: "tictactoe",
      host: username,
      open: true,
      started: false,
      players: [username], // host ist drin
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
      // max 2 Spieler für TicTacToe sinnvoll
      if(gameState.players.length >= 2){
        // voll
        return;
      }
      gameState.players.push(username);
    }
    broadcastGame();
    sendSystemMessage(`${username} ist dem Spiel beigetreten 🎮`);
  });

  // gameLock {token}
  // Host oder Mod darf "starten/schließen"
  socket.on("gameLock",(data)=>{
    const username = getUserByToken(data.token);
    if(!username || !gameState) return;
    const u = users[username];
    if(!u || u.banned) return;

    const isHost = (gameState.host === username);
    const amMod = isMod(u.role);

    if(!(isHost || amMod)) return;

    // schließen / starten
    gameState.open = false;
    gameState.started = true;
    // ensure board clean
    if(!Array.isArray(gameState.board) || gameState.board.length!==9){
      gameState.board = ["","","","","","","","",""];
    }
    // turn = erster spieler
    if(gameState.players.length>0){
      gameState.turn = gameState.players[0];
    }
    gameState.winner = null;

    broadcastGame();
    sendSystemMessage(`Spiel wurde gestartet von ${username} 🚀`);
  });

  // gameMove {token,index}
  socket.on("gameMove",(data)=>{
    const username = getUserByToken(data.token);
    if(!username || !gameState) return;
    if(!gameState.started) return;
    if(gameState.winner) return; // schon Ende

    // darf der user spielen?
    if(!gameState.players.includes(username)) return;
    // ist der dran?
    if(gameState.turn !== username) return;

    const idx = data.index;
    if(idx<0 || idx>8) return;
    if(gameState.board[idx] !== "") return;

    // X/O bestimmen
    const mark = markForPlayer(username, gameState.players);
    if(!mark) return;

    gameState.board[idx] = mark;

    // Gewinner prüfen
    const win = checkTicTacWinner(gameState.board);
    if(win === "X" || win === "O"){
      // wer hat gewonnen? Finde welcher Spieler hat dieses Zeichen
      let winnerName = null;
      gameState.players.forEach((p,i)=>{
        if((i===0 && win==="X") || (i===1 && win==="O")){
          winnerName = p;
        }
      });
      gameState.winner = winnerName || "???";
    } else if(win === "draw"){
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
    // finde welcher User das war
    let goneUser = null;
    for(const name in online){
      if(online[name] === socket.id){
        goneUser = name;
        break;
      }
    }
    if(goneUser){
      delete online[goneUser];
      // er bleibt im roomState.avatars drin, damit man "Geist" behalten könnte.
      // Wenn du willst, dass er verschwindet:
      delete roomState.avatars[goneUser];

      broadcastUserlist();
      broadcastRoom();
      sendSystemMessage(`${goneUser} hat den Chat verlassen`);
    }
  });

});

// ==================================================
// Start Server
// ==================================================
server.listen(PORT, ()=>{
  console.log("Server läuft auf Port", PORT);
});



