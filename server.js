const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { buildDeck } = require('./cards');

const PORT = process.env.PORT || 3000;
const START_LP = 8000, HAND_START = 5, HAND_MAX = 8, ZONES = 3;

// ---------- http ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); res.end('erro'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

// ---------- salas ----------
const rooms = new Map();

function newRoom(id) {
  return { id, players: [], turn: 0, turnNo: 1, started: false, over: false, winner: null, log: [], events: [], seq: 0, spectators: [], touched: Date.now() };
}
function newPlayer(token, name, ws) {
  return { token, name, ws, lp: START_LP, deck: [], hand: [], field: Array(ZONES).fill(null), traps: Array(ZONES).fill(null), gy: [], summoned: false, rematch: false };
}
const other = (room, p) => room.players.find(x => x !== p);
const idx = (room, p) => room.players.indexOf(p);
function log(room, msg) { room.log.push(msg); if (room.log.length > 40) room.log.shift(); }
const ev = (room, e) => room.events.push(e);
const snapM = m => ({ type: 'monster', name: m.card.name, emoji: m.card.emoji, atk: m.atk, def: m.def, tributes: m.card.tributes, pos: m.pos });
const snapC = c => ({ type: c.type, name: c.name, emoji: c.emoji, text: c.text, atk: c.atk, def: c.def, tributes: c.tributes });

// ---------- efeitos básicos ----------
function lp(room, p, delta) { p.lp += delta; ev(room, { type: 'lp', who: idx(room, p), delta }); }
function destroyM(room, p, slot) {
  const m = p.field[slot];
  if (!m) return;
  p.gy.push(m.card); p.field[slot] = null;
  ev(room, { type: 'destroy', who: idx(room, p), zone: 'mon', slot, card: snapM(m) });
}
function destroyT(room, p, slot) {
  const t = p.traps[slot];
  if (!t) return;
  p.gy.push(t.card); p.traps[slot] = null;
  ev(room, { type: 'destroy', who: idx(room, p), zone: 'trap', slot, card: snapC(t.card) });
}
function findTrap(room, p, effects) {
  for (let i = 0; i < ZONES; i++) {
    const t = p.traps[i];
    if (t && t.setTurn < room.turnNo && effects.includes(t.card.effect)) return i;
  }
  return -1;
}
function fireTrap(room, p, slot) {
  const t = p.traps[slot];
  p.traps[slot] = null; p.gy.push(t.card);
  ev(room, { type: 'trap', who: idx(room, p), slot, card: snapC(t.card) });
  log(room, `${p.name} ativou a armadilha ${t.card.name}!`);
  return t.card;
}

function draw(room, p, n = 1) {
  for (let i = 0; i < n; i++) {
    if (!p.deck.length) { endGame(room, other(room, p), `${p.name} ficou sem cartas!`); return false; }
    const c = p.deck.pop();
    if (p.hand.length >= HAND_MAX) { p.gy.push(c); log(room, `${p.name} descartou ${c.name} (mão cheia).`); }
    else { p.hand.push(c); ev(room, { type: 'draw', who: idx(room, p) }); }
  }
  return true;
}
function startGame(room) {
  room.started = true; room.over = false; room.winner = null; room.turnNo = 1; room.log = [];
  room.events = []; room.seq++;
  room.players.forEach(p => {
    p.lp = START_LP; p.deck = buildDeck(); p.hand = []; p.field = Array(ZONES).fill(null); p.traps = Array(ZONES).fill(null);
    p.gy = []; p.summoned = false; p.rematch = false;
    for (let i = 0; i < HAND_START; i++) p.hand.push(p.deck.pop());
  });
  room.turn = Math.floor(Math.random() * 2);
  log(room, `Duelo começou! ${room.players[room.turn].name} joga primeiro (sem ataque no 1º turno).`);
  beginTurn(room);
}
function beginTurn(room) {
  const p = room.players[room.turn];
  p.summoned = false;
  p.field.forEach(m => { if (m) { m.attacked = false; m.moved = false; m.fresh = false; } });
  ev(room, { type: 'turn', who: room.turn });
  if (room.turnNo > 1) draw(room, p, 1);
  log(room, `— Turno ${room.turnNo}: ${p.name} —`);
}
function endGame(room, winner, why) {
  if (room.over) return;
  room.over = true; room.winner = winner;
  log(room, `${why} ${winner.name} venceu!`);
}
function checkWin(room) {
  if (room.over) return;
  const [a, b] = room.players;
  if (a.lp <= 0 && b.lp <= 0) endGame(room, a, 'Empate de LP.');
  else if (a.lp <= 0) endGame(room, b, `${a.name} chegou a 0 LP.`);
  else if (b.lp <= 0) endGame(room, a, `${b.name} chegou a 0 LP.`);
}

// ---------- ações ----------
function handle(room, p, msg) {
  if (msg.t === 'chat') { log(room, `${p.name}: ${String(msg.text || '').slice(0, 120)}`); return; }
  if (msg.t === 'rematch') {
    if (!room.over) return;
    p.rematch = true;
    if (room.players.length === 2 && room.players.every(x => x.rematch)) startGame(room);
    return;
  }
  if (!room.started || room.over) return fail(p, 'O duelo não está em andamento.');
  if (msg.t === 'surrender') { endGame(room, other(room, p), `${p.name} desistiu.`); return; }
  if (room.players[room.turn] !== p) return fail(p, 'Não é seu turno.');
  const opp = other(room, p), me = idx(room, p), oppI = idx(room, opp);
  const validSlot = s => Number.isInteger(s) && s >= 0 && s < ZONES;

  switch (msg.t) {
    case 'summon': {
      const card = p.hand[msg.hand];
      if (!card || card.type !== 'monster') return fail(p, 'Carta inválida.');
      if (p.summoned) return fail(p, 'Você já invocou neste turno.');
      const set = msg.pos === 'set';
      const need = card.tributes || 0;
      const tr = Array.isArray(msg.tributes) ? [...new Set(msg.tributes)] : [];
      if (tr.length !== need) return fail(p, `${card.name} exige ${need} sacrifício(s).`);
      if (tr.some(s => !validSlot(s) || !p.field[s])) return fail(p, 'Sacrifício inválido.');
      const slot = need ? tr[0] : msg.slot;
      if (!validSlot(slot) || (!need && p.field[slot])) return fail(p, 'Zona inválida.');
      p.hand.splice(msg.hand, 1);
      tr.forEach(s => { log(room, `${p.name} sacrificou ${p.field[s].card.name}.`); destroyM(room, p, s); });
      const m = { card, pos: set ? 'set' : 'atk', atk: card.atk, def: card.def, attacked: false, moved: false, fresh: true };
      p.field[slot] = m; p.summoned = true;
      ev(room, { type: set ? 'setmon' : 'summon', who: me, slot, card: snapM(m) });
      log(room, set ? `${p.name} baixou um monstro virado para baixo.` : `${p.name} invocou ${card.name} em ATAQUE.`);
      if (!set && card.atk >= 1500) {
        const ts = findTrap(room, opp, ['pit']);
        if (ts >= 0) { fireTrap(room, opp, ts); log(room, `${card.name} caiu no fosso!`); destroyM(room, p, slot); }
      }
      break;
    }
    case 'pos': {
      const m = p.field[msg.slot];
      if (!m) return fail(p, 'Sem monstro aí.');
      if (m.fresh || m.moved || m.attacked) return fail(p, 'Não pode mudar a posição agora.');
      if (m.pos === 'set') {
        m.pos = 'atk';
        ev(room, { type: 'flip', who: me, slot: msg.slot, card: snapM(m) });
        log(room, `${p.name} virou ${m.card.name} para ATAQUE.`);
      } else {
        m.pos = m.pos === 'atk' ? 'def' : 'atk';
        log(room, `${p.name} mudou ${m.card.name} para ${m.pos === 'atk' ? 'ATAQUE' : 'DEFESA'}.`);
      }
      m.moved = true;
      break;
    }
    case 'attack': {
      if (room.turnNo === 1) return fail(p, 'Ninguém ataca no 1º turno.');
      const m = p.field[msg.slot];
      if (!m) return fail(p, 'Sem monstro aí.');
      if (m.pos !== 'atk') return fail(p, 'Só monstros em ataque atacam.');
      if (m.attacked) return fail(p, 'Esse monstro já atacou.');
      const direct = msg.target === 'direct';
      const t = direct ? null : opp.field[msg.target];
      if (direct && opp.field.some(Boolean)) return fail(p, 'O oponente tem monstros.');
      if (!direct && !t) return fail(p, 'Alvo inválido.');
      m.attacked = true;
      ev(room, { type: 'attack', who: me, from: msg.slot, to: direct ? 'direct' : msg.target, atk: snapM(m), tgt: t && snapM(t), tgtSet: !!t && t.pos === 'set' });

      let negated = false;
      const ts = findTrap(room, opp, ['mirror', 'barrier', 'revenge']);
      if (ts >= 0) {
        const c = fireTrap(room, opp, ts);
        if (c.effect === 'mirror') { destroyM(room, p, msg.slot); negated = true; log(room, `${m.card.name} foi destruído pelo reflexo!`); }
        else if (c.effect === 'barrier') { negated = true; log(room, 'O ataque foi anulado!'); }
        else { lp(room, p, -c.value); log(room, `${p.name} sofre ${c.value} de dano.`); if (p.lp <= 0) negated = true; }
      }
      if (!negated) {
        if (direct) {
          lp(room, opp, -m.atk);
          log(room, `${m.card.name} atacou direto: -${m.atk} LP para ${opp.name}.`);
        } else {
          if (t.pos === 'set') {
            t.pos = 'def';
            ev(room, { type: 'flip', who: oppI, slot: msg.target, card: snapM(t) });
          }
          const vs = t.pos === 'atk' ? t.atk : t.def;
          const diff = m.atk - vs;
          const desc = `${m.card.name} (${m.atk}) × ${t.card.name} (${vs} ${t.pos === 'atk' ? 'ATK' : 'DEF'})`;
          if (t.pos === 'atk') {
            if (diff > 0) { destroyM(room, opp, msg.target); lp(room, opp, -diff); log(room, `${desc}: ${t.card.name} destruído, -${diff} LP para ${opp.name}.`); }
            else if (diff < 0) { destroyM(room, p, msg.slot); lp(room, p, diff); log(room, `${desc}: ${m.card.name} destruído, ${diff} LP para ${p.name}.`); }
            else { destroyM(room, opp, msg.target); destroyM(room, p, msg.slot); log(room, `${desc}: ambos destruídos.`); }
          } else {
            if (diff > 0) { destroyM(room, opp, msg.target); log(room, `${desc}: ${t.card.name} destruído.`); }
            else if (diff < 0) { lp(room, p, diff); log(room, `${desc}: rebatido, ${diff} LP para ${p.name}.`); }
            else log(room, `${desc}: nada acontece.`);
          }
        }
      }
      ev(room, { type: 'attackEnd' });
      checkWin(room);
      break;
    }
    case 'trap': {
      const card = p.hand[msg.hand];
      if (!card || card.type !== 'trap') return fail(p, 'Carta inválida.');
      if (!validSlot(msg.slot) || p.traps[msg.slot]) return fail(p, 'Zona de armadilha inválida.');
      p.hand.splice(msg.hand, 1);
      p.traps[msg.slot] = { card, setTurn: room.turnNo };
      ev(room, { type: 'settrap', who: me, slot: msg.slot, card: snapC(card) });
      log(room, `${p.name} baixou uma armadilha.`);
      break;
    }
    case 'spell': {
      const card = p.hand[msg.hand];
      if (!card || card.type !== 'spell') return fail(p, 'Carta inválida.');
      let tgt = null;
      if (card.target === 'enemy') { tgt = opp.field[msg.slot]; if (!tgt) return fail(p, 'Escolha um monstro do oponente.'); }
      if (card.target === 'ally') { tgt = p.field[msg.slot]; if (!tgt) return fail(p, 'Escolha um monstro seu.'); }
      if (card.target === 'enemyTrap') { tgt = opp.traps[msg.slot]; if (!tgt) return fail(p, 'Escolha uma armadilha do oponente.'); }
      p.hand.splice(msg.hand, 1); p.gy.push(card);
      ev(room, { type: 'spell', who: me, card: snapC(card) });
      log(room, `${p.name} usou ${card.name}.`);
      const ts = findTrap(room, opp, ['negate']);
      if (ts >= 0) { fireTrap(room, opp, ts); log(room, `${card.name} foi anulada!`); break; }
      switch (card.effect) {
        case 'heal': lp(room, p, card.value); break;
        case 'burn': lp(room, opp, -card.value); break;
        case 'destroy': log(room, `${tgt.card.name} destruído.`); destroyM(room, opp, msg.slot); break;
        case 'destroyTrap': log(room, `${tgt.card.name} destruída.`); destroyT(room, opp, msg.slot); break;
        case 'boost': tgt.atk += card.value; tgt.def += card.value; ev(room, { type: 'boost', who: me, slot: msg.slot }); break;
        case 'draw': draw(room, p, card.value); break;
        case 'sweep': for (let i = 0; i < ZONES; i++) { destroyM(room, p, i); destroyM(room, opp, i); } break;
      }
      checkWin(room);
      break;
    }
    case 'end': {
      room.turn = 1 - room.turn; room.turnNo++;
      beginTurn(room);
      break;
    }
    default: return;
  }
}
function fail(p, msg) { send(p, { t: 'error', msg }); }

// ---------- envio ----------
function send(p, obj) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
function evFor(room, e, viewerIdx, spec) {
  const o = { ...e };
  if ('who' in o) o.who = e.who === viewerIdx ? 'you' : 'opp';
  if ((e.type === 'setmon' || e.type === 'settrap') && (spec || e.who !== viewerIdx)) o.card = null;
  return o;
}
// spec = espectador: vê o lado do jogador 0 embaixo, sem ver mãos nem cartas viradas de ninguém
function view(room, p, spec = false) {
  const a = spec ? room.players[0] : p, o = spec ? room.players[1] : other(room, p), own = !spec;
  const mons = (field, show) => field.map(m => !m ? null
    : (m.pos === 'set' && !show) ? { hidden: true, pos: 'set' }
    : { name: m.card.name, emoji: m.card.emoji, pos: m.pos, atk: m.atk, def: m.def, attacked: m.attacked, fresh: m.fresh, moved: m.moved, tributes: m.card.tributes });
  const traps = (list, show) => list.map(t => !t ? null : show ? { ...snapC(t.card), ready: t.setTurn < room.turnNo } : { hidden: true });
  const viewerIdx = idx(room, a);
  return {
    t: 'state',
    spectator: spec, spectators: room.spectators.length,
    room: room.id, seq: room.seq,
    started: room.started, over: room.over,
    winner: room.winner ? (room.winner === a ? 'you' : 'opp') : null,
    winnerName: room.winner ? room.winner.name : null,
    turnName: room.started ? room.players[room.turn].name : null,
    myTurn: own && room.started && !room.over && room.players[room.turn] === p,
    turnNo: room.turnNo,
    summoned: a.summoned,
    rematch: own && a.rematch, oppRematch: own && !!(o && o.rematch),
    you: { name: a.name, lp: a.lp, hand: own ? a.hand : a.hand.map(() => ({ hidden: true })), field: mons(a.field, own), traps: traps(a.traps, own), deck: a.deck.length, gy: a.gy.length },
    opp: o ? { name: o.name, lp: o.lp, hand: o.hand.length, field: mons(o.field, false), traps: traps(o.traps, false), deck: o.deck.length, gy: o.gy.length, online: !!(o.ws && o.ws.readyState === 1) } : null,
    events: room.events.map(e => evFor(room, e, viewerIdx, spec)),
    log: room.log.slice(-25),
  };
}
function broadcast(room) {
  room.players.forEach(p => send(p, view(room, p)));
  if (room.players.length === 2) room.spectators.forEach(sp => send(sp, view(room, sp, true)));
}

// ---------- websocket ----------
wss.on('connection', ws => {
  let room = null, player = null, spec = false;
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'join') {
      if (room) return;
      const id = String(msg.room || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
      if (!id) { ws.send(JSON.stringify({ t: 'error', msg: 'Sala inválida.' })); return; }
      room = rooms.get(id) || (rooms.set(id, newRoom(id)), rooms.get(id));
      const name = String(msg.name || 'Duelista').slice(0, 16) || 'Duelista';
      const backP = msg.token && room.players.find(x => x.token === msg.token);
      const backS = msg.token && room.spectators.find(x => x.token === msg.token);
      if (backP) { player = backP; player.ws = ws; }
      else if (backS) { player = backS; player.ws = ws; spec = true; }
      else if (room.players.length < 2) {
        player = newPlayer(crypto.randomBytes(8).toString('hex'), name, ws);
        room.players.push(player);
        log(room, `${name} entrou na sala.`);
      } else {
        player = { token: crypto.randomBytes(8).toString('hex'), name, ws };
        room.spectators.push(player); spec = true;
        log(room, `${name} está assistindo.`);
      }
      room.touched = Date.now();
      send(player, { t: 'joined', token: player.token, spectator: spec });
      if (room.players.length === 2 && !room.started) startGame(room);
      broadcast(room);
      return;
    }
    if (!room || !player) return;
    room.touched = Date.now();
    if (spec) {
      if (msg.t === 'chat') { log(room, `👁 ${player.name}: ${String(msg.text || '').slice(0, 120)}`); room.events = []; broadcast(room); }
      return;
    }
    room.events = []; room.seq++;
    handle(room, player, msg);
    broadcast(room);
  });
  ws.on('close', () => {
    if (!room || !player) return;
    if (player.ws === ws) player.ws = null;
    if (spec) {
      room.spectators = room.spectators.filter(x => x !== player);
    } else log(room, `${player.name} desconectou.`);
    room.events = [];
    broadcast(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) if (now - r.touched > 3 * 3600e3) rooms.delete(id);
}, 600e3);

server.listen(PORT, () => console.log(`Duelo de cartas em http://localhost:${PORT}`));
