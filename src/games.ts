import { Hono } from 'hono';
import { generatePIN, newId } from './crypto';
import type { Env, AuthVars } from './types';
import { requireAuth } from './auth';

const games = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// POST /api/games — host starts a new game from a quiz they own.
// Returns { pin, hostToken } — hostToken is single-use for the WS upgrade.
games.post('/', requireAuth, async (c) => {
  const userId = c.get('userId');
  const hostName = c.get('userName');
  const body = await c.req.json().catch(() => ({})) as { quizId?: string };
  if (!body.quizId) return c.json({ error: 'quizId required' }, 400);

  const quiz = await c.env.DB.prepare(
    'SELECT id, owner_id, title FROM quizzes WHERE id = ?',
  ).bind(body.quizId).first<{ id: string; owner_id: string; title: string }>();
  if (!quiz || quiz.owner_id !== userId) return c.json({ error: 'quiz not found' }, 404);

  const questions = await c.env.DB.prepare(
    'SELECT id, position, text, options_json, correct_index, time_limit_sec FROM questions WHERE quiz_id = ? ORDER BY position',
  ).bind(body.quizId).all();
  if ((questions.results as any[]).length === 0) {
    return c.json({ error: 'quiz has no questions' }, 400);
  }

  // Try a few PINs in case of collision.
  let pin = '';
  let attempt = 0;
  while (attempt < 10) {
    pin = generatePIN();
    const id = c.env.GAME_ROOM.idFromName(pin);
    const stub = c.env.GAME_ROOM.get(id);
    const res = await stub.fetch(`https://room/init`, {
      method: 'POST',
      body: JSON.stringify({
        pin,
        hostId: userId,
        hostName,
        quizId: quiz.id,
        quizTitle: quiz.title,
        questions: (questions.results as any[]).map((r) => ({
          id: r.id,
          position: r.position,
          text: r.text,
          options: JSON.parse(r.options_json),
          correctIndex: r.correct_index,
          timeLimitSec: r.time_limit_sec,
        })),
      }),
    });
    if (res.ok) {
      const data = await res.json() as { hostToken: string };
      return c.json({ pin, hostToken: data.hostToken });
    }
    attempt++;
  }
  return c.json({ error: 'could not allocate PIN, try again' }, 503);
});

// GET /api/games/:pin/check — does this PIN exist? (player-facing, no auth)
games.get('/:pin/check', async (c) => {
  const pin = c.req.param('pin');
  if (!/^\d{4,8}$/.test(pin)) return c.json({ ok: false }, 400);
  const id = c.env.GAME_ROOM.idFromName(pin);
  const stub = c.env.GAME_ROOM.get(id);
  const res = await stub.fetch(`https://room/status?pin=${pin}`);
  if (!res.ok) return c.json({ ok: false }, 404);
  const data = await res.json() as { ok: boolean; title?: string };
  return c.json(data);
});

// WS /ws/host?pin=...&token=...
// WS /ws/play?pin=...&nickname=...
games.get('/ws/host', async (c) => {
  const pin = c.req.query('pin') ?? '';
  const token = c.req.query('token') ?? '';
  if (!/^\d{4,8}$/.test(pin) || !token) return c.text('bad request', 400);
  if (c.req.header('Upgrade') !== 'websocket') return c.text('expected websocket', 426);
  const id = c.env.GAME_ROOM.idFromName(pin);
  return c.env.GAME_ROOM.get(id).fetch(`https://room/ws/host?pin=${pin}&token=${token}`, c.req.raw);
});

games.get('/ws/play', async (c) => {
  const pin = c.req.query('pin') ?? '';
  const nickname = (c.req.query('nickname') ?? '').slice(0, 32);
  if (!/^\d{4,8}$/.test(pin) || !nickname) return c.text('bad request', 400);
  if (c.req.header('Upgrade') !== 'websocket') return c.text('expected websocket', 426);
  const id = c.env.GAME_ROOM.idFromName(pin);
  return c.env.GAME_ROOM.get(id).fetch(`https://room/ws/play?pin=${pin}&nickname=${encodeURIComponent(nickname)}`, c.req.raw);
});

export default games;
