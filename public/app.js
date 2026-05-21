// Client helpers. Auth is handled by Cloudflare Access (cookie), so we no
// longer manage tokens client-side. Access cookies travel with every fetch
// automatically on same-origin requests.

async function request(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const r = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) {
    // Access challenge expired — reload so the IdP can re-authenticate.
    location.reload();
    throw new Error('Session expired');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${method} ${path} failed`);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
  del: (p) => request('DELETE', p),
};

export const auth = {
  async me() {
    try {
      const { user } = await api.get('/api/me');
      return user;
    } catch {
      return null;
    }
  },
};
