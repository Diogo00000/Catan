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

/* --------------------------------------------------------------------------
   RESILIENCE: players are identified by a persistent TOKEN, not a socket id.
   A refresh or brief drop creates a new socket but reuses the same token (the
   client stores it in localStorage per room), so the player reclaims their
   existing lobby slot — and, once a game is running, their seat. A disconnect
   does NOT immediately destroy a slot/seat: it starts a short GRACE timer, and
   a re-join with the same token within that window seamlessly re-attaches.
   -------------------------------------------------------------------------- */

// roster: room code -> Map(token -> slot), in join order (a Map preserves
// insertion order). A slot is the player's persistent identity in the room:
//   { id: token, name, color, socketId, graceTimer }
// `socketId` is the player's CURRENT live socket, or null while disconnected;
// `graceTimer` is the pending real-departure timer while disconnected.
// The server is authoritative for everyone's name and colour: each is assigned
// a unique default on join and may be changed by its owner until the game starts.
const roster = new Map();

// hosts: room code -> TOKEN of the room's HOST (the first person to join). The
// host is the only one who can start the game. If the host truly leaves before
// the game starts (their grace expires), host transfers to the earliest-joined
// remaining slot.
const hosts = new Map();

// games: room code -> { game, seats }. One authoritative game per room.
//   game  — the engine game-state object (engine.createGame(...))
//   seats — Map(token -> player index), assigned at start in join order.
// A seat is keyed by token, so it carries across reconnects and stays reserved
// while its player is disconnected.
const games = new Map();

const MAX_PLAYERS = 6;
// The game's colour set is the single source of truth for lobby colours too.
const COLORS = E.DEFAULT_COLORS;

// Grace window (ms) after a socket drops before the slot/seat is treated as a
// real departure. A refresh reconnects well within this; a genuine leave waits
// it out. About 10–15s per the resilience design.
const GRACE_MS = 12000;

// Slots of a room in join order, or [] if the room is unknown.
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
// the lobby stays consistent and live for everyone. A player's identity here is
// their TOKEN (sent as `id`), which the client matches against its own token.
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

// Send the current full game state plus the player's own seat to one socket, so
// a reconnecting player drops straight back into the live board where it stands.
function sendGameTo(socketId, room, token) {
  const entry = games.get(room);
  if (!entry) return;
  io.to(socketId).emit('state', entry.game);
  const seat = entry.seats.get(token);
  if (seat !== undefined) io.to(socketId).emit('seat', seat);
}

// A slot's grace window expired with no reconnect — treat it as a real
// departure. In a running game the seat stays RESERVED (we keep the slot so a
// later reconnect by token still reclaims it); only an empty room is cleaned up.
// In the lobby the slot is removed (its section disappears for everyone), and if
// the host left, the host transfers to the earliest-joined remaining slot.
function onGraceExpired(room, token) {
  const slots = roster.get(room);
  if (!slots) return;
  const slot = slots.get(token);
  if (!slot || slot.socketId) return;   // gone already, or reconnected meanwhile

  slot.graceTimer = null;

  if (games.has(room)) {
    // Running game: keep the seat reserved and the game going for everyone else.
    // Only tear the room down once nobody is connected to it any more.
    const anyConnected = Array.from(slots.values()).some((s) => s.socketId);
    if (!anyConnected) {
      slots.forEach((s) => { if (s.graceTimer) clearTimeout(s.graceTimer); });
      roster.delete(room);
      hosts.delete(room);
      games.delete(room);
      console.log(`room "${room}" emptied — game cleaned up`);
    }
    return;
  }

  // Lobby: a genuine departure removes the slot.
  const wasHost = hosts.get(room) === token;
  slots.delete(token);

  if (slots.size === 0) {
    roster.delete(room);
    hosts.delete(room);
    games.delete(room);
    console.log(`room "${room}" emptied`);
    return;
  }

  if (wasHost) {
    // Transfer host to the longest-connected remaining player: the earliest-
    // joined slot still connected, or just the earliest if none is connected.
    const remaining = Array.from(slots.values());
    const next = remaining.find((s) => s.socketId) || remaining[0];
    hosts.set(room, next.id);
    console.log(`host of room "${room}" transferred to "${next.name}"`);
  }

  broadcastLobby(room);
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

  // The room and TOKEN this socket has claimed (so we can find its slot on
  // every message and on disconnect). Both are set on a successful join.
  let joinedRoom = null;
  let myToken = null;

  socket.on('join', (payload) => {
    const data = payload || {};
    const room = typeof data.room === 'string' ? data.room.trim() : '';
    const token = typeof data.token === 'string' ? data.token.trim() : '';
    if (!room || !token) return;

    // If this socket was already in a different room, leave it first (rare — the
    // client's room is fixed per page). Drop its slot there immediately.
    if (joinedRoom && joinedRoom !== room) {
      const prevRoom = joinedRoom, prevToken = myToken;
      socket.leave(prevRoom);
      const prev = roster.get(prevRoom);
      const prevSlot = prev && prev.get(prevToken);
      if (prevSlot && prevSlot.socketId === socket.id) {
        if (prevSlot.graceTimer) clearTimeout(prevSlot.graceTimer);
        prevSlot.socketId = null;
        onGraceExpired(prevRoom, prevToken);
      }
      joinedRoom = null;
      myToken = null;
    }

    socket.join(room);
    joinedRoom = room;
    myToken = token;

    const slots = roster.get(room);

    // RECONNECT: a join whose token matches an existing slot reclaims that slot.
    // Re-attach the new socket; the player keeps their name, colour, host status
    // and (if the game has started) their seat, and is sent the current state.
    if (slots && slots.has(token)) {
      const slot = slots.get(token);
      if (slot.graceTimer) { clearTimeout(slot.graceTimer); slot.graceTimer = null; }
      slot.socketId = socket.id;
      console.log(`socket ${socket.id} reconnected to room "${room}" as "${slot.name}"`);

      if (games.has(room)) {
        // Drop straight back into the live board where it stands.
        sendGameTo(socket.id, room, token);
      } else {
        socket.emit('lobby', lobbyState(room));
      }
      // Keep everyone consistent (host/roster unchanged, but harmless to resend).
      broadcastLobby(room);
      return;
    }

    // NEW player (no token match). If a game is already running and we don't
    // recognise the token, they cannot be seated — spectators are out of scope.
    if (games.has(room)) {
      socket.emit('gameInProgress');
      return;
    }

    // Room full: do NOT seat a 7th player — tell them so they can show a
    // "Room is full" message instead of the lobby.
    if (slots && slots.size >= MAX_PLAYERS) {
      socket.emit('roomFull');
      return;
    }

    if (!roster.has(room)) roster.set(room, new Map());
    // The first person to join becomes (and stays) the host until they leave.
    if (!hosts.has(room)) hosts.set(room, token);

    // Assign a unique default name and colour; these count as the player's
    // chosen name/colour unless they change them.
    const name = defaultName(room);
    const color = defaultColor(room);
    roster.get(room).set(token, { id: token, name, color, socketId: socket.id, graceTimer: null });

    console.log(`socket ${socket.id} joined room "${room}" as "${name}"`);
    broadcastLobby(room);
  });

  // Find this socket's own slot in its room, or null. Guards every owner action.
  function mySlot() {
    if (!joinedRoom || !myToken) return null;
    const slots = roster.get(joinedRoom);
    return (slots && slots.get(myToken)) || null;
  }

  // Change this socket's own name. Names must be non-empty and unique
  // (case-sensitive). A duplicate is rejected and the previous name kept.
  socket.on('setName', (payload) => {
    const room = joinedRoom;
    if (!room || games.has(room)) return;
    const me = mySlot();
    if (!me) return;

    const name = (typeof payload === 'object' && payload && typeof payload.name === 'string')
      ? payload.name.trim().slice(0, 20)
      : '';
    if (!name) {
      socket.emit('nameRejected', { reason: 'empty' });
      return;
    }
    // Case-sensitive uniqueness against every OTHER player.
    const clash = membersOf(room).some((m) => m.id !== myToken && m.name === name);
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
    if (!room || games.has(room)) return;
    const me = mySlot();
    if (!me) return;

    const color = (typeof payload === 'object' && payload) ? payload.color : null;
    if (!COLORS.includes(color)) return;
    const clash = membersOf(room).some((m) => m.id !== myToken && m.color === color);
    if (clash) return;            // taken — silently ignore (its swatch is disabled client-side)
    me.color = color;
    broadcastLobby(room);
  });

  // Start a game in this room. Only the HOST may trigger it, and only when all
  // the lobby conditions hold. Ignored if a game is already running.
  socket.on('startGame', () => {
    const room = joinedRoom;
    if (!room || !roster.has(room)) return;
    if (hosts.get(room) !== myToken) return;                 // host only
    const existing = games.get(room);
    if (existing && existing.game.phase !== 'over') return;  // already running
    if (!canStart(room)) return;                             // conditions not met

    const members = membersOf(room);                         // join order

    // Size the game to the players, using each player's chosen name and colour,
    // seated in join order.
    const game = E.createGame({
      nPlayers: members.length,
      names: members.map((m) => m.name),
      colors: members.map((m) => m.color)
    });
    game.gameId = room + ':' + Date.now();   // lets clients detect a fresh board
    E.beginSetupTurn(game);

    // Assign each player a seat (player index) BY TOKEN in join order, so the
    // seat carries across reconnects.
    const seats = new Map();
    members.forEach((m, i) => seats.set(m.id, i));
    games.set(room, { game, seats });

    console.log(`game started in room "${room}" with ${members.length} players`);

    // Broadcast the initial full state, then tell each connected socket its seat.
    io.to(room).emit('state', game);
    members.forEach((m, i) => { if (m.socketId) io.to(m.socketId).emit('seat', i); });
  });

  // A player action: { type, ...params }. Validate against the engine, apply,
  // then broadcast the new full state to everyone.
  socket.on('action', (msg) => {
    const room = joinedRoom;
    if (!room) return;
    const entry = games.get(room);
    if (!entry) return;
    const seat = entry.seats.get(myToken);
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
    const room = joinedRoom, token = myToken;
    if (!room || !roster.has(room)) return;
    const slots = roster.get(room);
    const slot = slots.get(token);
    // Ignore a stale socket (e.g. a second tab that was already superseded).
    if (!slot || slot.socketId !== socket.id) return;

    // Don't destroy the slot/seat immediately — mark it disconnected and start a
    // short grace timer. A re-join with this token within the window re-attaches
    // seamlessly; if it expires, onGraceExpired treats it as a real departure.
    slot.socketId = null;
    if (slot.graceTimer) clearTimeout(slot.graceTimer);
    slot.graceTimer = setTimeout(() => onGraceExpired(room, token), GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
