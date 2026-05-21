// Cloudflare Zero Trust (Access) authentication.
//
// Configure an Access Application that protects the host-facing paths of this
// Worker (everything except `/`, `/play.html`, static assets, and the
// player-facing API/WS). Access will then inject `Cf-Access-Jwt-Assertion` on
// every request, which we verify here against the team's JWKS.
//
// Local dev: set DEV_USER_EMAIL in .dev.vars to bypass Access entirely.

import { Hono } from 'hono';
import { verifyWithJwks } from 'hono/jwt';
import { newId } from './crypto';
import type { Env, AuthVars } from './types';

const me = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// GET /api/me — returns the currently authenticated host user.
me.get('/', async (c) => {
  return c.json({
    user: {
      id: c.get('userId'),
      name: c.get('userName'),
      email: c.get('userEmail'),
    },
  });
});

async function ensureUser(db: D1Database, email: string) {
  const row = await db.prepare('SELECT id, name FROM users WHERE email = ?')
    .bind(email).first<{ id: string; name: string }>();
  if (row) return { id: row.id, name: row.name, email };
  const id = newId('u');
  const name = email.split('@')[0];
  await db.prepare(
    'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)',
  ).bind(id, email, name, Date.now()).run();
  return { id, name, email };
}

export async function requireAuth(c: any, next: () => Promise<void>): Promise<Response | void> {
  // Dev bypass: set DEV_USER_EMAIL in .dev.vars to skip Access verification.
  if (c.env.DEV_USER_EMAIL) {
    const user = await ensureUser(c.env.DB, c.env.DEV_USER_EMAIL);
    c.set('userId', user.id);
    c.set('userName', user.name);
    c.set('userEmail', user.email);
    await next();
    return;
  }

  const team = c.env.CF_ACCESS_TEAM_DOMAIN;
  const aud = c.env.CF_ACCESS_AUD;
  if (!team || !aud) {
    return c.json({ error: 'Server not configured: missing CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD' }, 500);
  }

  // Access injects the verified JWT on this header for every request.
  // Cookie name `CF_Authorization` is a fallback (e.g., WebSocket upgrades).
  const jwt =
    c.req.header('Cf-Access-Jwt-Assertion') ||
    parseCookie(c.req.header('Cookie') ?? '', 'CF_Authorization');
  if (!jwt) return c.json({ error: 'Access JWT missing' }, 401);

  try {
    const payload = await verifyWithJwks(jwt, {
      jwks_uri: `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`,
      verification: { aud },
      allowedAlgorithms: ['RS256'],
    }) as { email?: string };
    const email = payload.email;
    if (!email) return c.json({ error: 'Access JWT missing email claim' }, 401);
    const user = await ensureUser(c.env.DB, email);
    c.set('userId', user.id);
    c.set('userName', user.name);
    c.set('userEmail', email);
    await next();
  } catch {
    return c.json({ error: 'invalid Access JWT' }, 401);
  }
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export default me;
