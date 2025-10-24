const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { cors: { origin: "*" } });
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));

io.on("connection", (socket) => {
  console.log("Neuer Benutzer verbunden", socket.id);

  socket.on("chat message", (msg) => {
    // Hier könntest du später Übersetzung und Rechteprüfung einbauen
    io.emit("chat message", msg);
  });

  socket.on("disconnect", () => console.log("Benutzer getrennt", socket.id));
});

http.listen(PORT, () => console.log("Server läuft auf Port " + PORT));


