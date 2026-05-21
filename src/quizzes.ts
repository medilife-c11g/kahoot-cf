import { Hono } from 'hono';
import { newId } from './crypto';
import type { Env, AuthVars } from './types';

const quizzes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// GET /api/quizzes — list my quizzes
quizzes.get('/', async (c) => {
  const userId = c.get('userId');
  const result = await c.env.DB.prepare(
    'SELECT id, title, description, created_at, updated_at FROM quizzes WHERE owner_id = ? ORDER BY updated_at DESC',
  ).bind(userId).all();
  return c.json({ quizzes: result.results });
});

// POST /api/quizzes — create
quizzes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({})) as { title?: string; description?: string };
  const title = (body.title ?? '').trim() || 'Untitled quiz';
  const description = (body.description ?? '').trim();
  const id = newId('q');
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO quizzes (id, owner_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, userId, title, description, now, now).run();
  return c.json({ id });
});

// GET /api/quizzes/:id — quiz + questions
quizzes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const quiz = await c.env.DB.prepare(
    'SELECT id, owner_id, title, description, created_at, updated_at FROM quizzes WHERE id = ?',
  ).bind(id).first<any>();
  if (!quiz || quiz.owner_id !== userId) return c.json({ error: 'not found' }, 404);
  const qs = await c.env.DB.prepare(
    'SELECT id, position, text, options_json, correct_index, time_limit_sec FROM questions WHERE quiz_id = ? ORDER BY position',
  ).bind(id).all();
  const questions = (qs.results as any[]).map((r) => ({
    id: r.id,
    position: r.position,
    text: r.text,
    options: JSON.parse(r.options_json),
    correctIndex: r.correct_index,
    timeLimitSec: r.time_limit_sec,
  }));
  return c.json({ quiz, questions });
});

// PUT /api/quizzes/:id — update title/description
quizzes.put('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { title?: string; description?: string };
  const owned = await c.env.DB.prepare('SELECT owner_id FROM quizzes WHERE id = ?').bind(id).first<{ owner_id: string }>();
  if (!owned || owned.owner_id !== userId) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare(
    'UPDATE quizzes SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ?',
  ).bind(body.title ?? null, body.description ?? null, Date.now(), id).run();
  return c.json({ ok: true });
});

// DELETE /api/quizzes/:id
quizzes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const owned = await c.env.DB.prepare('SELECT owner_id FROM quizzes WHERE id = ?').bind(id).first<{ owner_id: string }>();
  if (!owned || owned.owner_id !== userId) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare('DELETE FROM questions WHERE quiz_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM quizzes WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// POST /api/quizzes/:id/questions — add question
quizzes.post('/:id/questions', async (c) => {
  const userId = c.get('userId');
  const quizId = c.req.param('id');
  const owned = await c.env.DB.prepare('SELECT owner_id FROM quizzes WHERE id = ?').bind(quizId).first<{ owner_id: string }>();
  if (!owned || owned.owner_id !== userId) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json().catch(() => ({})) as {
    text?: string; options?: string[]; correctIndex?: number; timeLimitSec?: number;
  };
  const text = (body.text ?? '').trim();
  const options = (body.options ?? []).map((o) => String(o).trim()).filter(Boolean);
  if (!text || options.length < 2 || options.length > 4) {
    return c.json({ error: 'text and 2-4 options required' }, 400);
  }
  const correctIndex = Number.isInteger(body.correctIndex) && body.correctIndex! >= 0 && body.correctIndex! < options.length
    ? body.correctIndex! : 0;
  const timeLimitSec = Math.max(5, Math.min(120, body.timeLimitSec ?? 20));

  const pos = (await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS nextPos FROM questions WHERE quiz_id = ?',
  ).bind(quizId).first<{ nextPos: number }>())?.nextPos ?? 0;

  const qid = newId('qq');
  await c.env.DB.prepare(
    'INSERT INTO questions (id, quiz_id, position, text, options_json, correct_index, time_limit_sec) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(qid, quizId, pos, text, JSON.stringify(options), correctIndex, timeLimitSec).run();
  await c.env.DB.prepare('UPDATE quizzes SET updated_at = ? WHERE id = ?').bind(Date.now(), quizId).run();
  return c.json({ id: qid, position: pos });
});

// PUT /api/quizzes/:quizId/questions/:qid — update question
quizzes.put('/:quizId/questions/:qid', async (c) => {
  const userId = c.get('userId');
  const quizId = c.req.param('quizId');
  const qid = c.req.param('qid');
  const owned = await c.env.DB.prepare('SELECT owner_id FROM quizzes WHERE id = ?').bind(quizId).first<{ owner_id: string }>();
  if (!owned || owned.owner_id !== userId) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json().catch(() => ({})) as {
    text?: string; options?: string[]; correctIndex?: number; timeLimitSec?: number;
  };
  const updates: string[] = [];
  const binds: any[] = [];
  if (body.text !== undefined) { updates.push('text = ?'); binds.push(body.text.trim()); }
  if (body.options !== undefined) {
    const opts = body.options.map((o) => String(o).trim()).filter(Boolean);
    if (opts.length < 2 || opts.length > 4) return c.json({ error: '2-4 options required' }, 400);
    updates.push('options_json = ?'); binds.push(JSON.stringify(opts));
  }
  if (body.correctIndex !== undefined) {
    updates.push('correct_index = ?'); binds.push(body.correctIndex);
  }
  if (body.timeLimitSec !== undefined) {
    updates.push('time_limit_sec = ?'); binds.push(Math.max(5, Math.min(120, body.timeLimitSec)));
  }
  if (updates.length === 0) return c.json({ ok: true });
  binds.push(qid);
  await c.env.DB.prepare(`UPDATE questions SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
  await c.env.DB.prepare('UPDATE quizzes SET updated_at = ? WHERE id = ?').bind(Date.now(), quizId).run();
  return c.json({ ok: true });
});

// DELETE /api/quizzes/:quizId/questions/:qid
quizzes.delete('/:quizId/questions/:qid', async (c) => {
  const userId = c.get('userId');
  const quizId = c.req.param('quizId');
  const qid = c.req.param('qid');
  const owned = await c.env.DB.prepare('SELECT owner_id FROM quizzes WHERE id = ?').bind(quizId).first<{ owner_id: string }>();
  if (!owned || owned.owner_id !== userId) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare('DELETE FROM questions WHERE id = ? AND quiz_id = ?').bind(qid, quizId).run();
  return c.json({ ok: true });
});

export default quizzes;
