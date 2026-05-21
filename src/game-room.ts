// GameRoom Durable Object
//
// One DO instance per active game (keyed by 6-digit PIN).
// Responsibilities:
//   - Track host + connected players over WebSocket
//   - Drive the question lifecycle (push question, collect answers, score, broadcast results)
//   - Persist final leaderboard to D1 game_history when ended
//
// We do NOT use the Hibernation API in this MVP to keep things simple. The DO
// stays alive while there are open WebSocket connections (~minutes per game),
// then is reaped automatically when all connections close. An alarm cleans up
// stale rooms after 60 minutes regardless.

import type { Env, Question, ClientMsg, ServerMsg } from './types';
import { newId } from './crypto';

type Status = 'lobby' | 'question' | 'results' | 'ended';

interface PlayerEntry {
  id: string;
  nickname: string;
  ws: WebSocket;
  score: number;
}

interface InitPayload {
  pin: string;
  hostId: string;
  hostName: string;
  quizId: string;
  quizTitle: string;
  questions: Question[];
}

const ROOM_TTL_MS = 60 * 60 * 1000; // 60 min absolute cap

export class GameRoom {
  state: DurableObjectState;
  env: Env;

  // Game config (set on /init)
  pin = '';
  hostId = '';
  hostName = '';
  quizId = '';
  quizTitle = '';
  questions: Question[] = [];
  hostToken = '';

  // Runtime state
  initialized = false;
  status: Status = 'lobby';
  hostWs: WebSocket | null = null;
  players = new Map<string, PlayerEntry>();
  currentIndex = -1;
  questionStartedAt = 0;
  // playerId -> { choice, timeMs }
  answers = new Map<string, { choice: number; timeMs: number }>();
  questionTimer: number | null = null;
  startedAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/init' && req.method === 'POST') {
      return this.handleInit(req);
    }
    if (url.pathname === '/status') {
      return this.handleStatus(url);
    }
    if (url.pathname === '/ws/host') {
      return this.handleHostUpgrade(req, url);
    }
    if (url.pathname === '/ws/play') {
      return this.handlePlayerUpgrade(req, url);
    }
    return new Response('not found', { status: 404 });
  }

  // ---- HTTP handlers ----

  async handleInit(req: Request): Promise<Response> {
    if (this.initialized) {
      return new Response(JSON.stringify({ error: 'pin in use' }), { status: 409 });
    }
    const payload = await req.json() as InitPayload;
    this.pin = payload.pin;
    this.hostId = payload.hostId;
    this.hostName = payload.hostName;
    this.quizId = payload.quizId;
    this.quizTitle = payload.quizTitle;
    this.questions = payload.questions;
    this.hostToken = newId('ht');
    this.initialized = true;
    this.startedAt = Date.now();

    // Auto-clean after 60 minutes
    await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return new Response(JSON.stringify({ hostToken: this.hostToken }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  handleStatus(url: URL): Response {
    if (!this.initialized || this.status === 'ended') {
      return new Response(JSON.stringify({ ok: false }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, title: this.quizTitle, status: this.status }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  handleHostUpgrade(req: Request, url: URL): Response {
    if (!this.initialized) return new Response('game not initialized', { status: 404 });
    if (url.searchParams.get('token') !== this.hostToken) return new Response('bad token', { status: 401 });
    if (this.hostWs && this.hostWs.readyState === WebSocket.OPEN) {
      return new Response('host already connected', { status: 409 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.hostWs = server;
    server.addEventListener('message', (ev) => this.onHostMessage(ev));
    server.addEventListener('close', () => { if (this.hostWs === server) this.hostWs = null; });
    server.addEventListener('error', () => { if (this.hostWs === server) this.hostWs = null; });
    // Send lobby snapshot
    this.sendToHost({
      t: 'lobby',
      players: [...this.players.values()].map((p) => ({ id: p.id, nickname: p.nickname })),
      quizTitle: this.quizTitle,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  handlePlayerUpgrade(req: Request, url: URL): Response {
    if (!this.initialized) return new Response('game not initialized', { status: 404 });
    if (this.status !== 'lobby') return new Response('game already started', { status: 409 });
    const nickname = url.searchParams.get('nickname')?.trim().slice(0, 32) ?? '';
    if (!nickname) return new Response('nickname required', { status: 400 });
    // Reject duplicate nickname
    for (const p of this.players.values()) {
      if (p.nickname.toLowerCase() === nickname.toLowerCase()) {
        return new Response('nickname taken', { status: 409 });
      }
    }
    if (this.players.size >= 2000) {
      return new Response('room full', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const id = newId('p');
    const entry: PlayerEntry = { id, nickname, ws: server, score: 0 };
    this.players.set(id, entry);

    server.addEventListener('message', (ev) => this.onPlayerMessage(id, ev));
    server.addEventListener('close', () => this.removePlayer(id));
    server.addEventListener('error', () => this.removePlayer(id));

    // Notify host of new player; send lobby snapshot to this player
    this.broadcastLobbyToHost();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Message handlers ----

  onHostMessage(ev: MessageEvent) {
    const msg = safeParse(ev.data) as ClientMsg | null;
    if (!msg) return;
    switch (msg.t) {
      case 'host-start':
        if (this.status === 'lobby') this.advanceQuestion();
        break;
      case 'host-next':
        if (this.status === 'results') this.advanceQuestion();
        break;
      case 'host-end':
        this.endGame();
        break;
      case 'ping':
        this.send(this.hostWs, { t: 'pong' });
        break;
    }
  }

  onPlayerMessage(playerId: string, ev: MessageEvent) {
    const player = this.players.get(playerId);
    if (!player) return;
    const msg = safeParse(ev.data) as ClientMsg | null;
    if (!msg) return;
    if (msg.t === 'ping') { this.send(player.ws, { t: 'pong' }); return; }
    if (msg.t !== 'player-answer') return;
    if (this.status !== 'question') return;
    if (this.answers.has(playerId)) return; // already answered
    const q = this.questions[this.currentIndex];
    if (!q) return;
    if (!Number.isInteger(msg.choice) || msg.choice < 0 || msg.choice >= q.options.length) return;
    const timeMs = Date.now() - this.questionStartedAt;
    if (timeMs > q.timeLimitSec * 1000) return; // too late
    this.answers.set(playerId, { choice: msg.choice, timeMs });
    this.send(player.ws, { t: 'answer-ack', correct: null });
    // If everyone answered, finish early.
    if (this.answers.size >= this.players.size) {
      this.finishQuestion();
    }
  }

  removePlayer(playerId: string) {
    if (!this.players.delete(playerId)) return;
    this.broadcastLobbyToHost();
  }

  // ---- Game flow ----

  advanceQuestion() {
    this.currentIndex++;
    if (this.currentIndex >= this.questions.length) {
      this.endGame();
      return;
    }
    const q = this.questions[this.currentIndex];
    this.answers.clear();
    this.questionStartedAt = Date.now();
    this.status = 'question';
    const msg: ServerMsg = {
      t: 'question',
      index: this.currentIndex,
      total: this.questions.length,
      text: q.text,
      options: q.options,
      timeLimitSec: q.timeLimitSec,
      startedAt: this.questionStartedAt,
    };
    this.broadcastAll(msg);

    // Timeout to finish the question
    if (this.questionTimer !== null) clearTimeout(this.questionTimer);
    this.questionTimer = setTimeout(() => this.finishQuestion(), q.timeLimitSec * 1000 + 200) as unknown as number;
  }

  finishQuestion() {
    if (this.status !== 'question') return;
    const q = this.questions[this.currentIndex];
    if (!q) return;
    if (this.questionTimer !== null) { clearTimeout(this.questionTimer); this.questionTimer = null; }

    // Score: 1000 pts max, scaled by speed; 0 if wrong.
    const counts = new Array(q.options.length).fill(0);
    for (const [pid, ans] of this.answers) {
      counts[ans.choice]++;
      const player = this.players.get(pid);
      if (!player) continue;
      if (ans.choice === q.correctIndex) {
        const frac = 1 - (ans.timeMs / (q.timeLimitSec * 1000));
        const pts = Math.max(500, Math.round(500 + 500 * Math.max(0, frac)));
        player.score += pts;
      }
    }

    // Per-player correctness ack
    for (const [pid, ans] of this.answers) {
      const p = this.players.get(pid);
      if (p) this.send(p.ws, { t: 'answer-ack', correct: ans.choice === q.correctIndex });
    }

    const leaderboard = [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((p) => ({ nickname: p.nickname, score: p.score }));

    this.status = 'results';
    this.broadcastAll({
      t: 'results',
      index: this.currentIndex,
      correctIndex: q.correctIndex,
      counts,
      leaderboard,
    });
  }

  async endGame() {
    if (this.status === 'ended') return;
    if (this.questionTimer !== null) { clearTimeout(this.questionTimer); this.questionTimer = null; }
    this.status = 'ended';
    const leaderboard = [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p) => ({ nickname: p.nickname, score: p.score }));
    this.broadcastAll({ t: 'ended', leaderboard });

    // Persist history to D1
    try {
      await this.env.DB.prepare(
        'INSERT INTO game_history (id, quiz_id, host_id, pin, started_at, ended_at, total_players, results_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        newId('g'),
        this.quizId,
        this.hostId,
        this.pin,
        this.startedAt,
        Date.now(),
        this.players.size,
        JSON.stringify(leaderboard),
      ).run();
    } catch (e) {
      console.error('failed to persist game history', e);
    }

    // Close all sockets after a brief delay so the final message flushes.
    setTimeout(() => {
      try { this.hostWs?.close(1000, 'ended'); } catch {}
      for (const p of this.players.values()) { try { p.ws.close(1000, 'ended'); } catch {} }
      this.players.clear();
      this.hostWs = null;
    }, 1000);
  }

  async alarm() {
    // Force cleanup if a game has been sitting too long.
    this.endGame();
  }

  // ---- Broadcast helpers ----

  send(ws: WebSocket | null, msg: ServerMsg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  sendToHost(msg: ServerMsg) { this.send(this.hostWs, msg); }

  broadcastAll(msg: ServerMsg) {
    const s = JSON.stringify(msg);
    if (this.hostWs && this.hostWs.readyState === WebSocket.OPEN) {
      try { this.hostWs.send(s); } catch {}
    }
    for (const p of this.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) {
        try { p.ws.send(s); } catch {}
      }
    }
  }

  broadcastLobbyToHost() {
    this.sendToHost({
      t: 'lobby',
      players: [...this.players.values()].map((p) => ({ id: p.id, nickname: p.nickname })),
      quizTitle: this.quizTitle,
    });
  }
}

function safeParse(data: unknown): unknown {
  if (typeof data !== 'string') return null;
  try { return JSON.parse(data); } catch { return null; }
}
