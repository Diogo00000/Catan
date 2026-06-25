'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// The game engine runs server-side: the server is the single source of truth.
// All randomness (board layout, dice, dev-card draws, robber steals) happens
// here, so it is identical for everyone in the room.
const E = require('./engine.js');

const app = express();
const server = http.createServer(app);

// Serve the game (index.html + static assets in the repo root) from "/".
app.use(express.static(path.join(__dirname)));

const io = new Server(server);

// roster: room code -> Map(socket.id -> { id, name, color }). Tracks who's
// connected to each room, in join order (a Map preserves insertion order). The
// server is authoritative for everyone's name and colour: each is assigned a
// unique default on join and may be changed by its owner until the game starts.
const roster = new Map();

// hosts: room code -> socket.id of the room's HOST (the first person to join).
// The host is the only one who can start the game. Host-transfer on disconnect
// is intentionally out of scope for now.
const hosts = new Map();

// games: room code -> { game, seats }. One authoritative game per room.
//   game  — the engine game-state object (engine.createGame(...))
//   seats — Map(socket.id -> player index), assigned at start in join order.
// A seat stays reserved if its socket disconnects (reconnection comes later).
const games = new Map();

const MAX_PLAYERS = 6;
// The game's colour set is the single source of truth for lobby colours too.
const COLORS = E.DEFAULT_COLORS;

// Members of a room in join order, or [] if the room is unknown.
function membersOf(room) {
  return roster.has(room) ? Array.from(roster.get(room).values()) : [];
}

// Pick a default unique name for a new joiner: the lowest "Player N" not already
// taken in the room (case-sensitive comparison, matching the uniqueness rule).
function defaultName(room) {
  const taken = new Set(membersOf(room).map((m) => m.name));
  for (let n = 1; ; n++) {
    const name = 'Player ' + n;
    if (!taken.has(name)) return name;
  }
}

// Pick a default unique colour for a new joiner: the first colour in the set not
// currently held by anyone in the room. (Capped at MAX_PLAYERS === COLORS.length,
// so a free colour always exists for a seatable joiner.)
function defaultColor(room) {
  const taken = new Set(membersOf(room).map((m) => m.color));
  return COLORS.find((c) => !taken.has(c)) || COLORS[0];
}

// Are all the lobby conditions for starting met? 3–6 players, every name a
// non-empty unique string, every colour unique.
function canStart(room) {
  const members = membersOf(room);
  const n = members.length;
  if (n < 3 || n > MAX_PLAYERS) return false;
  const names = members.map((m) => m.name);
  if (names.some((nm) => !nm)) return false;
  if (new Set(names).size !== n) return false;
  if (new Set(members.map((m) => m.color)).size !== n) return false;
  return true;
}

// The full lobby state every client renders from. Broadcast on every change so
// the lobby stays consistent and live for everyone.
function lobbyState(room) {
  const members = membersOf(room);
  return {
    players: members.map((m) => ({ id: m.id, name: m.name, color: m.color })),
    hostId: hosts.get(room) || null,
    colors: COLORS,
    // 3–4 players → standard board; 5–6 → extension board.
    board: members.length >= 5 ? 'extension' : 'standard',
    canStart: canStart(room)
  };
}

// Broadcast the current lobby state to everyone in the room, so each client's
// player list, board indicator, status and Start button update live.
function broadcastLobby(room) {
  io.to(room).emit('lobby', lobbyState(room));
}

// Broadcast the full game state of a room to everyone in it. Everyone renders
// from this; for now everyone sees the complete state (hands are hidden later).
function broadcastState(room) {
  const entry = games.get(room);
  if (entry) io.to(room).emit('state', entry.game);
}

/* --------------------------------------------------------------------------
   Action handling. The client never mutates the shared game — it only sends
   ACTIONS. The server validates each action against the engine (it must be the
   sender's turn for normal actions, except discards after a 7, which any seat
   that still owes a discard may send) and only then calls the engine and
   re-broadcasts. The client is never trusted over the engine.
   -------------------------------------------------------------------------- */
function isNum(v) { return typeof v === 'number' && isFinite(v); }

// Apply one action for `seat` to `game`. Returns true if the game changed (and
// should be re-broadcast), false if the action was rejected as illegal.
function handleAction(game, seat, msg) {
  const type = msg && msg.type;
  if (!type) return false;

  switch (type) {
    /* ---- building ---- */
    case 'placeSettlement': {
      const vid = msg.vid;
      if (!isNum(vid)) return false;
      if (game.phase === 'setup') {
        if (game.cur !== seat || game.mode !== 'setupSettlement') return false;
        if (!E.legalSettlements(game, seat, true).includes(vid)) return false;
      } else {
        if (game.cur !== seat || !E.canActNow(game)) return false;
        if (E.ownCount(game, seat, 'settlement') >= E.LIMIT.settlement) return false;
        if (!E.canAfford(game, seat, E.COST.settlement)) return false;
        if (!E.legalSettlements(game, seat, false).includes(vid)) return false;
      }
      const r = E.placeSettlement(game, vid);
      return !!(r && r.ok);
    }
    case 'placeRoad': {
      const eid = msg.eid;
      if (!isNum(eid)) return false;
      if (game.phase === 'setup') {
        if (game.cur !== seat || game.mode !== 'setupRoad') return false;
        if (!E.legalRoads(game, seat, true, game.lastSetupV).includes(eid)) return false;
      } else if (game.mode === 'roadBuild') {
        if (game.cur !== seat) return false;
        if (E.ownCount(game, seat, 'road') >= E.LIMIT.road) return false;
        if (!E.legalRoads(game, seat, false, null).includes(eid)) return false;
      } else {
        if (game.cur !== seat || !E.canActNow(game)) return false;
        if (E.ownCount(game, seat, 'road') >= E.LIMIT.road) return false;
        if (!E.canAfford(game, seat, E.COST.road)) return false;
        if (!E.legalRoads(game, seat, false, null).includes(eid)) return false;
      }
      const r = E.placeRoad(game, eid);
      return !!(r && r.ok);
    }
    case 'upgradeCity': {
      const vid = msg.vid;
      if (!isNum(vid)) return false;
      if (game.cur !== seat || !E.canActNow(game)) return false;
      if (E.ownCount(game, seat, 'city') >= E.LIMIT.city) return false;
      if (!E.canAfford(game, seat, E.COST.city)) return false;
      if (!E.legalCities(game, seat).includes(vid)) return false;
      const r = E.upgradeCity(game, vid);
      return !!(r && r.ok);
    }

    /* ---- dice / turn ---- */
    case 'rollDice': {
      if (game.cur !== seat) return false;
      const r = E.rollDice(game);          // engine guards phase / already-rolled
      return !!(r && r.ok);
    }
    case 'endTurn': {
      if (game.cur !== seat) return false;
      return E.endTurn(game) === true;     // engine guards the rest
    }

    /* ---- trading (bank / harbour only; player trades are out of scope) ---- */
    case 'maritimeTrade': {
      if (game.cur !== seat || !E.canActNow(game)) return false;
      const r = E.maritimeTrade(game, msg.give, msg.receive, !!msg.harbour);
      return !!(r && r.ok);                // engine validates rate / bank stock
    }

    /* ---- development cards ---- */
    case 'buyDev': {
      if (game.cur !== seat) return false;
      const r = E.buyDev(game);            // engine guards phase / afford / deck
      return !!(r && r.ok);
    }
    case 'playKnight': {
      if (game.cur !== seat || !E.canPlayDevNow(game)) return false;
      const r = E.playKnight(game);
      return !!(r && r.ok);
    }
    case 'playRoadBuilding': {
      if (game.cur !== seat || !E.canPlayDevNow(game)) return false;
      const r = E.playRoadBuilding(game);
      return !!(r && r.ok);
    }
    case 'playYearOfPlenty': {
      if (game.cur !== seat || !E.canPlayDevNow(game)) return false;
      const r = E.playYearOfPlenty(game, msg.sel || {});
      return !!(r && r.ok);
    }
    case 'playMonopoly': {
      if (game.cur !== seat || !E.canPlayDevNow(game)) return false;
      const r = E.playMonopoly(game, msg.r);
      return !!(r && r.ok);
    }

    /* ---- robber ---- */
    case 'moveRobber': {
      const hi = msg.hi;
      if (!isNum(hi)) return false;
      if (game.cur !== seat || game.mode !== 'robber') return false;
      if (hi === game.robberHex || hi < 0 || hi >= game.hexes.length) return false;
      const r = E.moveRobber(game, hi);
      // No choice of victim → resolve the steal immediately (matches engine flow).
      if (r && !r.needChoice) E.resolveSteal(game, r.victim);
      return true;
    }
    case 'resolveSteal': {
      if (game.cur !== seat) return false;
      if (!Array.isArray(game.stealChoices) || !game.stealChoices.includes(msg.victim)) return false;
      E.resolveSteal(game, msg.victim);
      return true;
    }

    /* ---- discards after a 7 (any seat that still owes one) ---- */
    case 'applyDiscard': {
      if (!game.discardQueue) return false;
      const idx = game.discardIdx;
      const remaining = game.discardQueue.slice(idx);
      if (!remaining.includes(seat) || E.totalCards(game, seat) <= 7) return false;
      // The engine processes discards in queue order, advancing discardIdx. To
      // accept them in any order, move this seat to the head of the remaining
      // queue so that bookkeeping stays consistent.
      const j = game.discardQueue.indexOf(seat, idx);
      const tmp = game.discardQueue[idx];
      game.discardQueue[idx] = game.discardQueue[j];
      game.discardQueue[j] = tmp;
      const r = E.applyDiscard(game, seat, msg.sel || {});
      if (!(r && r.ok)) {
        // Bad selection — undo the swap and reject.
        game.discardQueue[j] = game.discardQueue[idx];
        game.discardQueue[idx] = tmp;
        return false;
      }
      E.nextDiscarder(game);  // skip any now under the limit; arm the robber when done
      return true;
    }

    default:
      return false;
  }
}

io.on('connection', (socket) => {
  console.log(`socket connected: ${socket.id}`);

  // The room this socket has joined (so we can clean it up on disconnect).
  let joinedRoom = null;

  socket.on('join', (payload) => {
    const data = payload || {};
    const room = typeof data.room === 'string' ? data.room.trim() : '';
    if (!room) return;

    // If this socket was already in a different room, leave it first.
    if (joinedRoom && joinedRoom !== room) {
      socket.leave(joinedRoom);
      const prev = roster.get(joinedRoom);
      if (prev) {
        prev.delete(socket.id);
        if (prev.size === 0) { roster.delete(joinedRoom); hosts.delete(joinedRoom); }
        else broadcastLobby(joinedRoom);
      }
    }

    // Already in this room (e.g. a duplicate join) — nothing to add.
    if (roster.has(room) && roster.get(room).has(socket.id)) {
      socket.emit('lobby', lobbyState(room));
      return;
    }

    // A game already running: let the joiner watch (no seat until reconnection
    // support lands), but they do not enter the lobby roster.
    if (games.has(room)) {
      socket.join(room);
      joinedRoom = room;
      socket.emit('state', games.get(room).game);
      const seat = games.get(room).seats.get(socket.id);
      if (seat !== undefined) socket.emit('seat', seat);
      return;
    }

    // Room full: do NOT seat a 7th player — tell them so they can show a
    // "Room is full" message instead of the lobby.
    if (membersOf(room).length >= MAX_PLAYERS) {
      socket.emit('roomFull');
      return;
    }

    socket.join(room);
    joinedRoom = room;

    if (!roster.has(room)) roster.set(room, new Map());
    // The first person to join becomes (and stays) the host.
    if (!hosts.has(room)) hosts.set(room, socket.id);

    // Assign a unique default name and colour; these count as the player's
    // chosen name/colour unless they change them.
    const name = defaultName(room);
    const color = defaultColor(room);
    roster.get(room).set(socket.id, { id: socket.id, name, color });

    console.log(`socket ${socket.id} joined room "${room}" as "${name}"`);
    broadcastLobby(room);
  });

  // Change this socket's own name. Names must be non-empty and unique
  // (case-sensitive). A duplicate is rejected and the previous name kept.
  socket.on('setName', (payload) => {
    const room = joinedRoom;
    if (!room || !roster.has(room) || games.has(room)) return;
    const me = roster.get(room).get(socket.id);
    if (!me) return;

    const name = (typeof payload === 'object' && payload && typeof payload.name === 'string')
      ? payload.name.trim().slice(0, 20)
      : '';
    if (!name) {
      socket.emit('nameRejected', { reason: 'empty' });
      return;
    }
    // Case-sensitive uniqueness against every OTHER player.
    const clash = membersOf(room).some((m) => m.id !== socket.id && m.name === name);
    if (clash) {
      socket.emit('nameRejected', { reason: 'taken' });
      return;
    }
    me.name = name;
    broadcastLobby(room);
  });

  // Change this socket's own colour. Must be a colour from the set and not
  // currently held by another player.
  socket.on('setColor', (payload) => {
    const room = joinedRoom;
    if (!room || !roster.has(room) || games.has(room)) return;
    const me = roster.get(room).get(socket.id);
    if (!me) return;

    const color = (typeof payload === 'object' && payload) ? payload.color : null;
    if (!COLORS.includes(color)) return;
    const clash = membersOf(room).some((m) => m.id !== socket.id && m.color === color);
    if (clash) return;            // taken — silently ignore (its swatch is disabled client-side)
    me.color = color;
    broadcastLobby(room);
  });

  // Start a game in this room. Only the HOST may trigger it, and only when all
  // the lobby conditions hold. Ignored if a game is already running.
  socket.on('startGame', () => {
    const room = joinedRoom;
    if (!room || !roster.has(room)) return;
    if (hosts.get(room) !== socket.id) return;               // host only
    const existing = games.get(room);
    if (existing && existing.game.phase !== 'over') return;  // already running
    if (!canStart(room)) return;                             // conditions not met

    const members = membersOf(room);                         // join order

    // Size the game to the connected players, using each player's chosen name
    // and colour, seated in join order.
    const game = E.createGame({
      nPlayers: members.length,
      names: members.map((m) => m.name),
      colors: members.map((m) => m.color)
    });
    game.gameId = room + ':' + Date.now();   // lets clients detect a fresh board
    E.beginSetupTurn(game);

    // Assign each connected socket a seat (player index) in join order.
    const seats = new Map();
    members.forEach((m, i) => seats.set(m.id, i));
    games.set(room, { game, seats });

    console.log(`game started in room "${room}" with ${members.length} players`);

    // Broadcast the initial full state, then tell each socket its own seat.
    io.to(room).emit('state', game);
    seats.forEach((idx, sid) => io.to(sid).emit('seat', idx));
  });

  // A player action: { type, ...params }. Validate against the engine, apply,
  // then broadcast the new full state to everyone.
  socket.on('action', (msg) => {
    const room = joinedRoom;
    if (!room) return;
    const entry = games.get(room);
    if (!entry) return;
    const seat = entry.seats.get(socket.id);
    if (seat === undefined) return;          // no seat → spectator, can't act

    let changed = false;
    try {
      changed = handleAction(entry.game, seat, msg || {});
    } catch (err) {
      console.error('action error', err);
      changed = false;
    }

    if (changed) broadcastState(room);
    else socket.emit('actionRejected', { type: msg && msg.type });
  });

  socket.on('disconnect', (reason) => {
    console.log(`socket disconnected: ${socket.id} (${reason})`);
    if (joinedRoom && roster.has(joinedRoom)) {
      const members = roster.get(joinedRoom);
      members.delete(socket.id);
      if (members.size === 0) {
        // Last one out: drop the roster, host and any game so a later visit to
        // this (now empty) room starts clean. Seats are NOT reshuffled while
        // anyone is still connected — a disconnected seat simply stays reserved.
        roster.delete(joinedRoom);
        hosts.delete(joinedRoom);
        games.delete(joinedRoom);
      } else {
        // Their lobby section vanishes for everyone immediately. (Host-transfer
        // when the host is the one who left is intentionally out of scope.)
        broadcastLobby(joinedRoom);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
