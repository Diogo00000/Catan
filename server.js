'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Serve the existing game (index.html + any static assets in the repo root)
// from "/". Nothing about the game itself changes — it's just served by Node.
app.use(express.static(path.join(__dirname)));

// Start a socket.io server on the same HTTP server. It doesn't do anything
// game-related yet — it just accepts connections and logs them. The actual
// multiplayer protocol will be built in a later step.
const io = new Server(server);

io.on('connection', (socket) => {
  console.log(`socket connected: ${socket.id}`);

  socket.on('disconnect', (reason) => {
    console.log(`socket disconnected: ${socket.id} (${reason})`);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
