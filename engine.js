'use strict';
/* ============================================================================
   Catan game engine — ALL game logic, with NO browser / DOM dependencies.

   This file never touches document, the DOM, SVG, rendering, sounds, UI timers,
   or any other presentation concern. Everything it needs lives in a plain
   game-state object created by createGame(); every function takes such an object
   as its first argument and reads / modifies only that object. This means many
   independent games can run side by side (e.g. one per room on the server) — no
   game state is ever held in a module-level global.

   The public API is attached to a single object and dual-exported below so the
   SAME file works in both environments: window.CatanEngine in the browser and
   module.exports under Node.
   ============================================================================ */
(function(){

/* ---------------- Resource & card constants ---------------- */
const RES_ORDER=["wood","brick","sheep","wheat","ore"];
const RES_SHORT={wood:"Wood",brick:"Brick",sheep:"Sheep",wheat:"Wheat",ore:"Ore"};
// Development cards — playable types (VP cards are never actively played) and all types.
const DEV_TYPES=["knight","road","plenty","mono"];
const DEV_ALL=["knight","vp","road","plenty","mono"];
const DEV_NAME={knight:"Knight",vp:"Victory Point",road:"Road Building",plenty:"Year of Plenty",mono:"Monopoly"};
const COST={
  road:{wood:1,brick:1},
  settlement:{wood:1,brick:1,sheep:1,wheat:1},
  city:{ore:3,wheat:2},
  dev:{ore:1,wheat:1,sheep:1}
};
const LIMIT={settlement:5,city:4,road:15};
// Fallback player colours (only used when a caller omits colours; the UI always passes its own).
const DEFAULT_COLORS=["#c0392b","#2f74b5","#df8a2c","#3e8e5a","#8a5a2b","#efe9dc"];

/* ---------------- Board geometry ---------------- */
const R=48, W=Math.sqrt(3)*R, VD=1.5*R, CX0=300, CY0=295;
const COUNTS_SMALL=[3,4,5,4,3];        // 19-hex board (3-4 players)
const COUNTS_LARGE=[3,4,5,6,5,4,3];    // 30-hex 5-6 extension board (5-6 players)

function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

/* Build the hex/vertex/edge graph for a given row layout. Returns fresh arrays
   (nothing module-level), so each game owns its own geometry. */
function buildGeometry(counts){
  const hexes=[], vertices=[], edges=[];
  const vmap=new Map(), emap=new Map();
  const vkey=(x,y)=>Math.round(x)+","+Math.round(y);
  const ekey=(a,b)=>a<b?a+"-"+b:b+"-"+a;
  const getV=(x,y)=>{const k=vkey(x,y);if(vmap.has(k))return vmap.get(k);
    const v={id:vertices.length,x,y,hexes:[],edges:[],adj:[]};vertices.push(v);vmap.set(k,v);return v;};
  const getE=(a,b,hi)=>{const k=ekey(a,b);
    if(emap.has(k)){const e=emap.get(k);if(!e.hexes.includes(hi))e.hexes.push(hi);return e;}
    const e={id:edges.length,v1:Math.min(a,b),v2:Math.max(a,b),hexes:[hi]};edges.push(e);emap.set(k,e);return e;};
  counts.forEach((count,row)=>{
    const y=CY0+(row-(counts.length-1)/2)*VD, xStart=CX0-(count-1)/2*W;
    for(let i=0;i<count;i++) hexes.push({cx:xStart+i*W,cy:y,corners:[],edgeIds:[]});
  });
  hexes.forEach((h,hi)=>{
    for(let k=0;k<6;k++){
      const ang=(-90+60*k)*Math.PI/180;
      const v=getV(h.cx+R*Math.cos(ang),h.cy+R*Math.sin(ang));
      h.corners.push(v.id); v.hexes.push(hi);
    }
    for(let k=0;k<6;k++){
      const a=h.corners[k], b=h.corners[(k+1)%6];
      const e=getE(a,b,hi); h.edgeIds.push(e.id);
    }
  });
  edges.forEach(e=>{
    vertices[e.v1].edges.push(e.id); vertices[e.v2].edges.push(e.id);
    vertices[e.v1].adj.push(e.v2); vertices[e.v2].adj.push(e.v1);
  });
  return {hexes,vertices,edges};
}

/* Assign terrain + number tokens. Mutates geo.hexes; returns the desert index
   the robber starts on (one of the two on the large board). */
function assignTiles(geo){
  const {hexes,edges}=geo;
  let bag, nums;
  if(hexes.length===30){
    // 5-6 extension board: 6 wood, 6 sheep, 6 wheat, 5 brick, 5 ore, 2 desert
    bag=shuffle([...Array(6).fill("wood"),...Array(6).fill("sheep"),...Array(6).fill("wheat"),
      ...Array(5).fill("brick"),...Array(5).fill("ore"),...Array(2).fill("desert")]);
    // 28 number tokens: two each of 2 & 12, three each of 3,4,5,6,8,9,10,11
    nums=shuffle([2,2,12,12,3,3,3,4,4,4,5,5,5,6,6,6,8,8,8,9,9,9,10,10,10,11,11,11]);
  } else {
    // standard 19-hex board
    bag=shuffle([...Array(4).fill("wood"),...Array(3).fill("brick"),...Array(4).fill("sheep"),
      ...Array(4).fill("wheat"),...Array(3).fill("ore"),"desert"]);
    nums=shuffle([2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12]);
  }
  const deserts=[];
  hexes.forEach((h,i)=>{
    h.resource=bag[i];
    if(h.resource==="desert"){h.number=null; deserts.push(i);}
  });
  // hex adjacency: two hexes are adjacent when they share an edge
  const hexAdj=hexes.map(()=>[]);
  edges.forEach(e=>{ if(e.hexes.length===2){ const[a,b]=e.hexes; hexAdj[a].push(b); hexAdj[b].push(a); } });
  const numbered=hexes.map((h,i)=>i).filter(i=>hexes[i].resource!=="desert");
  // red number tokens (6 & 8) may never sit next to another red token
  const isRed=n=>n===6||n===8;
  const place=()=>numbered.forEach((hi,k)=>{ hexes[hi].number=nums[k]; });
  const okay=()=>numbered.every(hi=>!isRed(hexes[hi].number) || hexAdj[hi].every(nb=>!isRed(hexes[nb].number)));
  place();
  for(let tries=0; tries<300 && !okay(); tries++){ shuffle(nums); place(); }
  // robber starts on a desert (one of the two on the large board)
  return deserts[Math.floor(Math.random()*deserts.length)];
}

/* Place harbours (ports) on coastal boundary edges, spread around the coast.
   type "3:1" = generic; a resource name = 2:1 for that resource. */
function assignHarbours(geo){
  const {hexes,vertices,edges}=geo;
  const harbours=[];
  // boundary edges = edges touching only one hex; order them around the coast by angle
  const boundary=edges.filter(e=>e.hexes.length===1).map(e=>{
    const a=vertices[e.v1], b=vertices[e.v2];
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
    return {e, ang:Math.atan2(my-CY0,mx-CX0)};
  }).sort((p,q)=>p.ang-q.ang);
  let types;
  if(hexes.length===30){
    // 30-hex board: 5 generic 3:1 and 6 specific 2:1 (wheat repeated)
    types=["3:1","3:1","3:1","3:1","3:1","wood","brick","sheep","wheat","ore","wheat"];
  } else {
    // 19-hex board: 4 generic 3:1 and 5 specific 2:1 (one of each resource)
    types=["3:1","3:1","3:1","3:1","wood","brick","sheep","wheat","ore"];
  }
  shuffle(types);
  const n=types.length, step=boundary.length/n;
  for(let i=0;i<n;i++){
    const e=boundary[Math.floor(i*step)].e;
    harbours.push({edge:e.id, v1:e.v1, v2:e.v2, type:types[i]});
  }
  return harbours;
}

/* ---------------- Game creation ---------------- */
/* Create a fresh, self-contained game-state object. config: {nPlayers, names, colors}.
   names/colors are optional (defaults are filled in). The returned object holds the
   whole game — board geometry, players, bank, turn info, decks and live stats. */
function createGame(config){
  config=config||{};
  let names=config.names ? config.names.slice() : null;
  let n = config.nPlayers || (names&&names.length) || 3;
  if(!names) names=Array.from({length:n},(_,i)=>"Player "+(i+1));
  n=names.length;
  let colors=config.colors ? config.colors.slice() : Array.from({length:n},(_,i)=>DEFAULT_COLORS[i%DEFAULT_COLORS.length]);

  const counts=(n>=5)?COUNTS_LARGE:COUNTS_SMALL;   // larger board for 5-6 players
  const geo=buildGeometry(counts);
  const robberHex=assignTiles(geo);
  const harbours=assignHarbours(geo);

  const g={
    nPlayers:n,
    playerNames:names,
    playerColors:colors,
    counts,
    // board geometry (each game owns its own copy)
    hexes:geo.hexes, vertices:geo.vertices, edges:geo.edges, harbours,
    // The bank: 19 cards of each resource. Everything players earn is drawn from here;
    // everything they pay or discard returns here. Monopoly never touches the bank.
    bank:{wood:19,brick:19,sheep:19,wheat:19,ore:19},
    players:Array.from({length:n},(_,i)=>({i,resources:{wood:0,brick:0,sheep:0,wheat:0,ore:0},vp:0,
      dev:{knight:0,vp:0,road:0,plenty:0,mono:0},      // development cards currently held
      devNew:{knight:0,vp:0,road:0,plenty:0,mono:0},   // of those, bought this turn (not yet playable)
      playedKnights:0, roadLen:0,
      // ---- lifetime per-player stats (all live) ----
      devBought:0, devPlayed:0,           // dev cards bought / actually played over the game
      lifetimeRes:0,                      // every resource card ever gained, from any source
      expProd:0,                          // cumulative expected production (pips/36 summed each roll)
      robberMoves:0,                      // times this player moved the robber (7 or Knight)
      cardsStolen:0, cardsStolenFrom:0,   // cards robbed from others / times robbed by others
      tradesBank:0, tradesHarbour:0, tradesPlayer:0,   // trades made, by kind
      discardsLost:0})),                  // cards discarded on 7s
    buildings:{},          // vertexId -> {player,type}
    roads:{},              // edgeId -> player
    robberHex,
    phase:"setup",
    cur:0,
    hasRolled:false,
    mode:null,             // null|settlement|road|city|robber|roadBuild|setupSettlement|setupRoad
    pendingRobber:false,
    lastSetupV:null,
    dice:[null,null],
    // ---- live statistics ----
    rollCounts:Array(13).fill(0),     // index = dice total (2..12) -> times rolled
    production:{wood:0,brick:0,sheep:0,wheat:0,ore:0},                    // total of each resource paid out on rolls
    playerProduction:Array.from({length:n},()=>({wood:0,brick:0,sheep:0,wheat:0,ore:0})),  // per-player dice gains
    // development deck (25): 14 Knight, 5 VP, 2 Road Building, 2 Year of Plenty, 2 Monopoly
    deck:shuffle([...Array(14).fill("knight"),...Array(5).fill("vp"),...Array(2).fill("road"),
      ...Array(2).fill("plenty"),...Array(2).fill("mono")]),
    devPlayedThisTurn:false,
    freeRoadsLeft:0,
    largestArmy:null,      // player index holding Largest Army (+2 VP)
    longestRoad:null,      // player index holding Longest Road (+2 VP)
    log:[]
  };
  // Randomly choose which seat takes the very first setup placement, then build the
  // snake order RELATIVE to it: forward through the seating from the starting seat
  // for the first settlement+road round, then back in reverse for the second round.
  // Normal play later proceeds forward from this same starting seat.
  const startSeat=Math.floor(Math.random()*n);
  g.startSeat=startSeat;
  const fwd=Array.from({length:n},(_,k)=>(startSeat+k)%n);
  g.setupQueue=[...fwd,...[...fwd].reverse()];
  g.setupIdx=0;
  g.settlementsPlaced=Array(n).fill(0);
  g.cur=startSeat;
  return g;
}

function pushLog(g,msg,now){ g.log.push({msg,now}); if(g.log.length>40)g.log.shift(); }

/* ---------------- Counting / rules helpers ---------------- */
function ownCount(g,p,type){
  if(type==="road") return Object.values(g.roads).filter(x=>x===p).length;
  return Object.values(g.buildings).filter(b=>b.player===p&&b.type===type).length;
}
function recomputeVP(g){
  g.players.forEach(pl=>pl.vp=0);
  for(const vid in g.buildings){const b=g.buildings[vid];g.players[b.player].vp+=(b.type==="city"?2:1);}
  // Victory Point development cards each add 1 (silently, even the turn they were bought).
  g.players.forEach(pl=>pl.vp+=pl.dev.vp);
  // Special-award bonuses.
  if(g.largestArmy!=null) g.players[g.largestArmy].vp+=2;
  if(g.longestRoad!=null) g.players[g.longestRoad].vp+=2;
}
/* Longest continuous road for player p: the longest trail (no edge reused) along their
   connected road segments, with the path broken at any vertex holding an opponent's building. */
function longestRoadLength(g,p){
  const myEdges=Object.keys(g.roads).filter(eid=>g.roads[eid]===p).map(Number);
  if(myEdges.length===0) return 0;
  const adj={};
  myEdges.forEach(eid=>{
    const e=g.edges[eid];
    (adj[e.v1]=adj[e.v1]||[]).push({eid,to:e.v2});
    (adj[e.v2]=adj[e.v2]||[]).push({eid,to:e.v1});
  });
  const blocked=v=>{const b=g.buildings[v]; return !!(b&&b.player!==p);}; // opponent building cuts the path
  let best=0;
  const dfs=(v,len,used,first)=>{
    if(len>best) best=len;
    if(blocked(v)&&!first) return;          // a path can end at an opponent's building, but not pass through
    for(const {eid,to} of adj[v]){
      if(used.has(eid)) continue;
      used.add(eid); dfs(to,len+1,used,false); used.delete(eid);
    }
  };
  Object.keys(adj).map(Number).forEach(start=>dfs(start,0,new Set(),true));
  return best;
}
function updateLongestRoad(g){
  g.players.forEach(pl=>pl.roadLen=longestRoadLength(g,pl.i));
  const len=i=>g.players[i].roadLen;
  const prev=g.longestRoad;
  let holder=prev;
  if(holder!=null && len(holder)<5) holder=null;     // current holder's road was cut below 5
  let maxLen=0, leaders=[];
  for(let i=0;i<g.nPlayers;i++){const L=len(i); if(L>maxLen){maxLen=L;leaders=[i];} else if(L===maxLen) leaders.push(i);}
  if(maxLen<5) holder=null;
  else if(holder==null){ if(leaders.length===1) holder=leaders[0]; }   // first to a unique 5+
  else if(len(holder)<maxLen){ if(leaders.length===1) holder=leaders[0]; } // strictly longer unique challenger
  // (a tie, or the holder still being the max, leaves the title where it is)
  if(holder!==prev){
    g.longestRoad=holder;
    if(holder==null) pushLog(g,"Longest Road is no longer held.",true);
    else if(prev==null) pushLog(g,g.playerNames[holder]+" claims the Longest Road (+2 VP).",true);
    else pushLog(g,g.playerNames[holder]+" takes the Longest Road from "+g.playerNames[prev]+" (+2 VP).",true);
  }
}
function updateLargestArmy(g){
  const p=g.cur, k=g.players[p].playedKnights;     // only the player who just played a Knight can gain it
  if(k<3) return;
  const cur=g.largestArmy;
  if(cur===p) return;
  if(cur==null){ g.largestArmy=p; pushLog(g,g.playerNames[p]+" claims the Largest Army (+2 VP).",true); }
  else if(k>g.players[cur].playedKnights){ g.largestArmy=p; pushLog(g,g.playerNames[p]+" takes the Largest Army from "+g.playerNames[cur]+" (+2 VP).",true); }
}
function totalCards(g,p){return RES_ORDER.reduce((s,r)=>s+g.players[p].resources[r],0);}
function canAfford(g,p,cost){return Object.keys(cost).every(r=>g.players[p].resources[r]>=cost[r]);}
function pay(g,p,cost){Object.keys(cost).forEach(r=>{g.players[p].resources[r]-=cost[r]; g.bank[r]+=cost[r];});}
function costText(cost){return Object.keys(cost).map(r=>cost[r]+" "+RES_SHORT[r].toLowerCase()).join(", ");}

/* Harbours a player can use (settlement or city on one of the harbour's vertices). */
function playerHarbours(g,p){
  return g.harbours.filter(h=>{
    const b1=g.buildings[h.v1], b2=g.buildings[h.v2];
    return (b1&&b1.player===p)||(b2&&b2.player===p);
  });
}
function harbourLabel(t){ return t==="3:1" ? "3:1" : "2:1 "+RES_SHORT[t]; }
// Best maritime rate for giving resource `res`: 4 (bank), 3 (generic harbour) or 2 (matching 2:1).
function harbourRate(g,p,res){
  let rate=4;
  playerHarbours(g,p).forEach(h=>{
    if(h.type==="3:1") rate=Math.min(rate,3);
    else if(h.type===res) rate=Math.min(rate,2);
  });
  return rate;
}

function hasOwnRoadAt(g,vid,p){return g.vertices[vid].edges.some(eid=>g.roads[eid]===p);}
function roadConnected(g,eid,p){
  const e=g.edges[eid];
  for(const v of [e.v1,e.v2]){
    const b=g.buildings[v];
    if(b&&b.player===p) return true;
    if(g.vertices[v].edges.some(o=>o!==eid&&g.roads[o]===p)) return true;
  }
  return false;
}
function legalSettlements(g,p,setup){
  return g.vertices.filter(v=>!g.buildings[v.id]
      && v.adj.every(n=>!g.buildings[n])
      && (setup || hasOwnRoadAt(g,v.id,p))).map(v=>v.id);
}
function legalRoads(g,p,setup,anchorV){
  return g.edges.filter(e=> g.roads[e.id]===undefined
      && (setup ? (e.v1===anchorV||e.v2===anchorV) : roadConnected(g,e.id,p))).map(e=>e.id);
}
function legalCities(g,p){
  return Object.keys(g.buildings).filter(v=>g.buildings[v].player===p&&g.buildings[v].type==="settlement").map(Number);
}

/* ---------------- Setup phase ---------------- */
function beginSetupTurn(g){
  g.cur=g.setupQueue[g.setupIdx];
  g.mode="setupSettlement"; g.lastSetupV=null;
}

/* Place a settlement. Handles both the snake-setup placement (which also grants the
   starting resources from the second settlement) and a normal paid build. */
function placeSettlement(g,vid){
  if(g.phase==="setup"){
    g.buildings[vid]={player:g.cur,type:"settlement"};
    g.settlementsPlaced[g.cur]++;
    if(g.settlementsPlaced[g.cur]===2){ // second settlement yields starting resources
      const got=[];
      g.vertices[vid].hexes.forEach(hi=>{const h=g.hexes[hi];if(h.resource!=="desert"){g.players[g.cur].resources[h.resource]++;g.bank[h.resource]--;g.players[g.cur].lifetimeRes++;got.push(RES_SHORT[h.resource]);}});
      if(got.length) pushLog(g,g.playerNames[g.cur]+" collects "+got.join(", ")+" from the second settlement.");
    }
    g.lastSetupV=vid; g.mode="setupRoad";
    updateLongestRoad(g); recomputeVP(g);
    return {ok:true, setup:true};
  }
  // normal play
  pay(g,g.cur,COST.settlement);
  g.buildings[vid]={player:g.cur,type:"settlement"};
  pushLog(g,g.playerNames[g.cur]+" builds a settlement.",true);
  g.mode=null; updateLongestRoad(g); recomputeVP(g); const over=checkWin(g);
  return {ok:true, over};
}
/* Place a road. Handles snake setup (advancing the queue / finishing setup),
   free Road-Building roads, and a normal paid build. */
function placeRoad(g,eid){
  if(g.phase==="setup"){
    g.roads[eid]=g.cur;
    updateLongestRoad(g);
    g.setupIdx++;
    if(g.setupIdx<g.setupQueue.length){ beginSetupTurn(g); }
    else { // setup complete
      g.phase="play"; g.cur=g.startSeat; g.hasRolled=false; g.mode=null;
      pushLog(g,"Setup complete — let the trading begin!",true);
    }
    return {ok:true, setup:true};
  }
  if(g.mode==="roadBuild"){           // free roads from a Road Building card
    g.roads[eid]=g.cur; g.freeRoadsLeft--;
    pushLog(g,g.playerNames[g.cur]+" builds a free road.",true);
    updateLongestRoad(g); recomputeVP(g); const over=checkWin(g);
    if(g.phase==="over"){ g.mode=null; return {ok:true, over:true}; }
    if(!(g.freeRoadsLeft>0 && ownCount(g,g.cur,"road")<LIMIT.road && legalRoads(g,g.cur,false,null).length>0)) g.mode=null;
    return {ok:true, over:false};
  }
  pay(g,g.cur,COST.road);
  g.roads[eid]=g.cur;
  pushLog(g,g.playerNames[g.cur]+" builds a road.",true);
  g.mode=null; updateLongestRoad(g); recomputeVP(g); const over=checkWin(g);
  return {ok:true, over};
}
function upgradeCity(g,vid){
  pay(g,g.cur,COST.city);
  g.buildings[vid].type="city";
  pushLog(g,g.playerNames[g.cur]+" upgrades to a city.",true);
  g.mode=null; recomputeVP(g); const over=checkWin(g);
  return {ok:true, over};
}

/* ---------------- Robber ---------------- */
/* Move the robber to hex hi. Returns {from, needChoice, victim}: `from` is the hex it
   slid from (for animation), and either a single auto-victim or needChoice=true with the
   eligible victims stored on g.stealChoices for the caller to resolve. */
function moveRobber(g,hi){
  const from=g.robberHex;
  g.robberHex=hi; g.mode=null;
  g.players[g.cur].robberMoves++;          // live stats: a robber move (from a 7 or a Knight)
  // Opponents with a settlement or city touching the new hex are eligible to be robbed.
  const victims=[...new Set(g.hexes[hi].corners.map(v=>g.buildings[v]).filter(b=>b&&b.player!==g.cur).map(b=>b.player))];
  if(victims.length>1){
    // More than one rival borders the hex — the caller must pick.
    g.stealChoices=victims;
    return {from, needChoice:true};
  }
  return {from, needChoice:false, victim:victims[0]}; // undefined → nobody to steal from
}
function resolveSteal(g,victim){
  g.pendingRobber=false; g.mode=null; g.stealChoices=null;
  let stole=false;
  if(victim==null){
    pushLog(g,g.playerNames[g.cur]+" moves the robber. No one to steal from here.",true);
  } else {
    const pool=[]; RES_ORDER.forEach(r=>{for(let k=0;k<g.players[victim].resources[r];k++)pool.push(r);});
    if(pool.length===0){
      pushLog(g,g.playerNames[g.cur]+" moves the robber, but "+g.playerNames[victim]+" has no cards to steal.",true);
    } else {
      const r=pool[Math.floor(Math.random()*pool.length)];
      g.players[victim].resources[r]--; g.players[g.cur].resources[r]++;
      g.players[g.cur].lifetimeRes++;                  // a stolen card is a card gained
      g.players[g.cur].cardsStolen++; g.players[victim].cardsStolenFrom++;
      stole=true;
      // Privacy: the shared log must not reveal WHICH card was stolen. The robber
      // learns it anyway because it appears in their own hand; everyone else only
      // sees that a card changed hands.
      pushLog(g,g.playerNames[g.cur]+" moves the robber and steals a card from "+g.playerNames[victim]+".",true);
    }
  }
  return {stole};
}

/* ---------------- Turn actions ---------------- */
/* Roll the dice. Returns a result describing what happened for presentation:
   {ok, sum, seven, needDiscards} on a 7, or {ok, sum, seven:false, produced} otherwise. */
function rollDice(g){
  if(g.phase!=="play"||g.hasRolled) return {ok:false};
  const d1=1+Math.floor(Math.random()*6), d2=1+Math.floor(Math.random()*6);
  g.dice=[d1,d2]; g.hasRolled=true;
  const sum=d1+d2;
  g.rollCounts[sum]++;                 // live stats: roll-frequency histogram
  // live stats: every roll, accrue each player's expected production (their board pips / 36)
  for(let i=0;i<g.nPlayers;i++) g.players[i].expProd+=expectedPips(g,i)/36;
  if(sum===7){
    // A 7: first everyone over the hand limit discards, THEN the robber moves.
    g.pendingRobber=true; g.mode=null;
    pushLog(g,g.playerNames[g.cur]+" rolled a 7.",true);
    const order=[];
    for(let k=0;k<g.nPlayers;k++){const pi=(g.cur+k)%g.nPlayers; if(totalCards(g,pi)>7) order.push(pi);}
    if(order.length){
      g.discardQueue=order; g.discardIdx=0;
      return {ok:true, sum, seven:true, needDiscards:true};
    }
    g.mode="robber";
    pushLog(g,g.playerNames[g.cur]+" — move the robber.",true);
    return {ok:true, sum, seven:true, needDiscards:false};
  }
  // First tally what every player is owed per resource, without paying yet.
  const demand={}; // res -> {byP:{player:amount}, total}
  g.hexes.forEach((h,hi)=>{
    if(h.number!==sum||hi===g.robberHex||h.resource==="desert") return;
    h.corners.forEach(v=>{const b=g.buildings[v];
      if(b){const amt=b.type==="city"?2:1, r=h.resource;
        const d=demand[r]||(demand[r]={byP:{},total:0});
        d.byP[b.player]=(d.byP[b.player]||0)+amt; d.total+=amt;}});
  });
  // Pay each resource out of the bank, applying the production-shortage rule per resource.
  const gains={}, short=[];
  RES_ORDER.forEach(r=>{
    const d=demand[r]; if(!d) return;
    const avail=g.bank[r];
    const recipients=Object.keys(d.byP).map(Number);
    if(d.total<=avail){                         // bank can pay everyone in full
      recipients.forEach(pi=>{const a=d.byP[pi]; g.players[pi].resources[r]+=a; g.bank[r]-=a;
        gains[pi]=gains[pi]||{}; gains[pi][r]=a;});
    } else if(recipients.length===1){           // single claimant gets a partial payout
      const pi=recipients[0], a=Math.min(d.byP[pi],avail);
      if(a>0){ g.players[pi].resources[r]+=a; g.bank[r]-=a; gains[pi]=gains[pi]||{}; gains[pi][r]=a; }
      short.push(RES_SHORT[r].toLowerCase()+" (partial)");
    } else {                                    // several claimants, not enough for all → no one gets any
      short.push(RES_SHORT[r].toLowerCase());
    }
  });
  // live stats: tally what was actually produced, overall and per player
  Object.keys(gains).forEach(p=>{ const gg=gains[p];
    Object.keys(gg).forEach(r=>{ g.production[r]+=gg[r]; g.playerProduction[p][r]+=gg[r]; g.players[p].lifetimeRes+=gg[r]; }); });
  const parts=Object.keys(gains).map(p=>g.playerNames[p]+" +"+Object.keys(gains[p]).map(r=>gains[p][r]+RES_SHORT[r][0]).join(""));
  let msg="Rolled "+sum+(parts.length?" — "+parts.join(", "):" — no production.");
  if(short.length) msg+=" — bank short on "+short.join(", ")+".";
  pushLog(g,msg,true);
  return {ok:true, sum, seven:false, produced: parts.length>0};
}
function endTurn(g){
  if(g.phase!=="play"||!g.hasRolled||g.pendingRobber||g.mode==="robber"||g.mode==="roadBuild") return false;
  // Cards bought this turn become playable from the next turn onward.
  g.players[g.cur].devNew={knight:0,vp:0,road:0,plenty:0,mono:0};
  g.cur=(g.cur+1)%g.nPlayers; g.hasRolled=false; g.mode=null; g.dice=[null,null];
  g.devPlayedThisTurn=false;
  return true;
}
function checkWin(g){
  if(g.phase==="over") return false;
  if(g.players[g.cur].vp>=10){
    g.phase="over"; g.winner=g.cur; g.mode=null;
    const vpc=g.players[g.cur].dev.vp;
    pushLog(g,g.playerNames[g.cur]+" reaches "+g.players[g.cur].vp+" VP and wins!"+
      (vpc?` Reveals ${vpc} Victory Point card${vpc>1?"s":""}.`:""),true);
    return true;
  }
  return false;
}
// True when the current player may take a turn action (buy/build/trade) — these need the roll done first.
function canActNow(g){ return g.phase==="play"&&g.hasRolled&&!g.pendingRobber&&g.mode!=="robber"&&g.mode!=="roadBuild"; }
// True when the current player may play a development card — allowed before OR after the roll.
function canPlayDevNow(g){ return g.phase==="play"&&!g.pendingRobber&&g.mode!=="robber"&&g.mode!=="roadBuild"; }

/* ---------------- Discards (after a 7) ---------------- */
/* Advance the discard queue past players who are no longer over the limit. Returns the
   next player who must discard, or null when discards are done — at which point it hands
   control to the robber (mode "robber"). */
function nextDiscarder(g){
  while(g.discardQueue && g.discardIdx<g.discardQueue.length){
    const p=g.discardQueue[g.discardIdx];
    if(totalCards(g,p)<=7){ g.discardIdx++; continue; }
    return p;
  }
  g.discardQueue=null; g.discardIdx=0;
  g.mode="robber";
  pushLog(g,g.playerNames[g.cur]+" — move the robber.",true);
  return null;
}
function applyDiscard(g,p,sel){
  const need=Math.floor(totalCards(g,p)/2);
  const selSum=RES_ORDER.reduce((s,r)=>s+sel[r],0);
  if(selSum!==need) return {ok:false};
  RES_ORDER.forEach(r=>{ g.players[p].resources[r]-=sel[r]; g.bank[r]+=sel[r]; });
  g.players[p].discardsLost+=need;
  pushLog(g,g.playerNames[p]+" discards "+need+" card"+(need===1?"":"s")+".",true);
  g.discardIdx++;
  return {ok:true};
}

/* ---------------- Trading ---------------- */
function resList(obj){ const a=RES_ORDER.filter(r=>obj[r]>0).map(r=>obj[r]+" "+RES_SHORT[r]); return a.length?a.join(", "):"nothing"; }
function maritimeTrade(g,give,receive,harbour){
  const p=g.cur, gv=give, rc=receive;
  if(!gv||!rc||gv===rc) return {ok:false, reason:"invalid"};
  const rate=harbour?harbourRate(g,p,gv):4;
  if(g.players[p].resources[gv]<rate) return {ok:false, reason:"invalid"};
  if(g.bank[rc]<1) return {ok:false, reason:"bankout"};
  g.players[p].resources[gv]-=rate; g.bank[gv]+=rate;
  g.players[p].resources[rc]+=1; g.bank[rc]-=1;
  g.players[p].lifetimeRes+=1;
  if(harbour) g.players[p].tradesHarbour++; else g.players[p].tradesBank++;
  pushLog(g,g.playerNames[p]+" trades "+rate+" "+RES_SHORT[gv].toLowerCase()+" for 1 "+RES_SHORT[rc].toLowerCase()+
    (harbour?" at a harbour ("+rate+":1).":" with the bank (4:1)."),true);
  return {ok:true};
}
function playerTrade(g,p,q,give,receive){
  const giveOk=RES_ORDER.every(r=>g.players[p].resources[r]>=give[r]);
  const recvOk=RES_ORDER.every(r=>g.players[q].resources[r]>=receive[r]);
  if(!giveOk||!recvOk){ pushLog(g,"Trade failed — the resources are no longer available.",true); return {ok:false}; }
  RES_ORDER.forEach(r=>{
    g.players[p].resources[r]-=give[r]; g.players[q].resources[r]+=give[r];
    g.players[q].resources[r]-=receive[r]; g.players[p].resources[r]+=receive[r];
  });
  // both sides gain the cards they received; both record a player-to-player trade
  g.players[p].lifetimeRes+=RES_ORDER.reduce((s,r)=>s+receive[r],0);
  g.players[q].lifetimeRes+=RES_ORDER.reduce((s,r)=>s+give[r],0);
  g.players[p].tradesPlayer++; g.players[q].tradesPlayer++;
  pushLog(g,g.playerNames[p]+" and "+g.playerNames[q]+" trade — "+g.playerNames[p]+" gives "+resList(give)+", gets "+resList(receive)+".",true);
  return {ok:true};
}

/* ---------------- Development cards ---------------- */
function buyDev(g){
  if(!canActNow(g)) return {ok:false, reason:"phase"};
  const p=g.cur;
  if(g.deck.length===0) return {ok:false, reason:"empty"};
  if(!canAfford(g,p,COST.dev)) return {ok:false, reason:"afford"};
  pay(g,p,COST.dev);
  const card=g.deck.shift();                 // drawn from the top, hidden from opponents
  g.players[p].dev[card]++; g.players[p].devNew[card]++; g.players[p].devBought++;
  pushLog(g,g.playerNames[p]+" buys a development card.",true);
  recomputeVP(g); const over=checkWin(g);     // a bought VP card can win immediately
  return {ok:true, over, card};
}
function canPlayRoadBuilding(g,p){ return ownCount(g,p,"road")<LIMIT.road && legalRoads(g,p,false,null).length>0; }
function playKnight(g){
  if(g.players[g.cur].dev.knight-g.players[g.cur].devNew.knight<=0||g.devPlayedThisTurn) return {ok:false};
  const p=g.cur;
  g.players[p].dev.knight--; g.players[p].playedKnights++; g.players[p].devPlayed++; g.devPlayedThisTurn=true;
  updateLargestArmy(g); recomputeVP(g); const over=checkWin(g);
  if(over) return {ok:true, over:true};
  g.mode="robber";                              // robber move with no discard step
  pushLog(g,g.playerNames[p]+" plays a Knight.",true);
  return {ok:true, over:false};
}
function playRoadBuilding(g){
  const p=g.cur;
  if(g.players[p].dev.road-g.players[p].devNew.road<=0||g.devPlayedThisTurn||!canPlayRoadBuilding(g,p)) return {ok:false};
  g.players[p].dev.road--; g.players[p].devPlayed++; g.devPlayedThisTurn=true;
  g.freeRoadsLeft=2; g.mode="roadBuild";
  pushLog(g,g.playerNames[p]+" plays Road Building — place 2 free roads.",true);
  return {ok:true};
}
function plentyCap(g){ return Math.min(2, RES_ORDER.reduce((s,r)=>s+g.bank[r],0)); }
function playYearOfPlenty(g,sel){
  const p=g.cur;
  if(g.players[p].dev.plenty-g.players[p].devNew.plenty<=0||g.devPlayedThisTurn) return {ok:false};
  const cap=plentyCap(g), sum=RES_ORDER.reduce((s,r)=>s+sel[r],0);
  if(sum!==cap||cap===0) return {ok:false};
  if(RES_ORDER.some(r=>sel[r]>g.bank[r])) return {ok:false};          // never draw more than the bank holds
  RES_ORDER.forEach(r=>{g.players[p].resources[r]+=sel[r]; g.bank[r]-=sel[r];});
  g.players[p].lifetimeRes+=sum;
  g.players[p].dev.plenty--; g.players[p].devPlayed++; g.devPlayedThisTurn=true;
  pushLog(g,g.playerNames[p]+" plays Year of Plenty and takes "+resList(sel)+".",true);
  recomputeVP(g);
  return {ok:true};
}
function playMonopoly(g,r){
  const p=g.cur;
  if(!r) return {ok:false};
  if(g.players[p].dev.mono-g.players[p].devNew.mono<=0||g.devPlayedThisTurn) return {ok:false};
  let total=0;
  for(let i=0;i<g.nPlayers;i++){ if(i===p) continue; total+=g.players[i].resources[r]; g.players[i].resources[r]=0; }
  g.players[p].resources[r]+=total;
  g.players[p].lifetimeRes+=total;
  g.players[p].dev.mono--; g.players[p].devPlayed++; g.devPlayedThisTurn=true;
  pushLog(g,g.playerNames[p]+" plays Monopoly on "+RES_SHORT[r].toLowerCase()+" — collects "+total+" card"+(total===1?"":"s")+".",true);
  recomputeVP(g);
  return {ok:true, total};
}

/* ---------------- Expected production (live statistics) ---------------- */
function pips(n){ return (n==null)?0:6-Math.abs(7-n); }
/* Sum of pips for every number a player's settlements/cities sit on (city counts double).
   Divided by 36 this is their expected resource yield per roll. */
function expectedPips(g,p){
  let sum=0;
  for(const vid in g.buildings){ const b=g.buildings[vid]; if(b.player!==p) continue;
    const mult=(b.type==="city")?2:1;
    g.vertices[vid].hexes.forEach(hi=>{ sum+=pips(g.hexes[hi].number)*mult; });
  }
  return sum;
}

/* ---------------- Public API ---------------- */
const CatanEngine={
  // lifecycle
  createGame, beginSetupTurn,
  // build / turn actions
  placeSettlement, placeRoad, upgradeCity,
  rollDice, endTurn,
  // robber & discards
  moveRobber, resolveSteal, nextDiscarder, applyDiscard,
  // trading
  maritimeTrade, playerTrade,
  // development cards
  buyDev, playKnight, playRoadBuilding, playYearOfPlenty, playMonopoly,
  // queries / rules helpers
  ownCount, recomputeVP, updateLongestRoad, updateLargestArmy, longestRoadLength,
  totalCards, canAfford, pay, costText,
  playerHarbours, harbourLabel, harbourRate,
  hasOwnRoadAt, roadConnected, legalSettlements, legalRoads, legalCities,
  canActNow, canPlayDevNow, canPlayRoadBuilding, checkWin,
  pips, expectedPips, plentyCap, resList, pushLog,
  // constants & geometry
  DEFAULT_COLORS,
  RES_ORDER, RES_SHORT, COST, LIMIT, DEV_TYPES, DEV_ALL, DEV_NAME,
  COUNTS_SMALL, COUNTS_LARGE, GEO:{R,W,VD,CX0,CY0}
};

// Dual export: Node (server, many games at once) and browser (window.CatanEngine).
if(typeof module!=="undefined"&&module.exports) module.exports=CatanEngine;
if(typeof window!=="undefined") window.CatanEngine=CatanEngine;

})();
