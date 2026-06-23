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

// Start a socket.io server on the same HTTP server. For this first networking
// step it only does room/connection plumbing: it tracks who is connected to
// each room and broadcasts an updated roster whenever someone joins or leaves.
// No game state is shared yet — that comes in a later step.
const io = new Server(server);

// roster: room code -> Map(socket.id -> { name }). Tracks who's in each room.
const roster = new Map();

// Broadcast the current member list of a room to everyone in that room, so
// each client's "who's here" indicator updates live.
function broadcastRoster(room) {
  const members = roster.has(room)
    ? Array.from(roster.get(room).values())
    : [];
  io.to(room).emit('roster', members);
}

io.on('connection', (socket) => {
  console.log(`socket connected: ${socket.id}`);

  // The room this socket has joined (so we can clean it up on disconnect).
  let joinedRoom = null;

  socket.on('join', (payload) => {
    const data = payload || {};
    const room = typeof data.room === 'string' ? data.room.trim() : '';
    if (!room) return;

    const name = (typeof data.name === 'string' && data.name.trim())
      ? data.name.trim()
      : 'Player';

    // If this socket was already in a different room, leave it first.
    if (joinedRoom && joinedRoom !== room) {
      socket.leave(joinedRoom);
      const prev = roster.get(joinedRoom);
      if (prev) {
        prev.delete(socket.id);
        if (prev.size === 0) roster.delete(joinedRoom);
        else broadcastRoster(joinedRoom);
      }
    }

    socket.join(room);
    joinedRoom = room;

    if (!roster.has(room)) roster.set(room, new Map());
    roster.get(room).set(socket.id, { id: socket.id, name });

    console.log(`socket ${socket.id} joined room "${room}" as "${name}"`);
    broadcastRoster(room);
  });

  socket.on('disconnect', (reason) => {
    console.log(`socket disconnected: ${socket.id} (${reason})`);
    if (joinedRoom && roster.has(joinedRoom)) {
      const members = roster.get(joinedRoom);
      members.delete(socket.id);
      if (members.size === 0) roster.delete(joinedRoom);
      else broadcastRoster(joinedRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
