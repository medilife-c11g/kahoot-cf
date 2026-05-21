import { Hono } from 'hono';
import me, { requireAuth } from './auth';
import quizzes from './quizzes';
import games from './games';
import type { Env, AuthVars } from './types';

export { GameRoom } from './game-room';

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

app.get('/health', (c) => c.text('ok'));

// Authenticated (Access) endpoints
app.use('/api/me', requireAuth);
app.route('/api/me', me);

app.use('/api/quizzes/*', requireAuth);
app.route('/api/quizzes', quizzes);

// Games: POST requires auth (host); player paths are public.
app.route('/api/games', games);

// Static assets — Access policies decide which HTML pages need auth.
app.get('*', async (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
