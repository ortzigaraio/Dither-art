// Anonymous visit counter for horain.
// Stores only two numbers in D1 (all-time total and per-day total). Never stores IPs, user agents or cookies.
//   POST /hit   → increments and returns { total, today }   (only from ALLOWED_ORIGINS)
//   GET  /count → returns { total, today } without incrementing

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

async function read(env, day) {
  const [total, today] = await env.DB.batch([
    env.DB.prepare("SELECT n FROM counters WHERE id = 'total'"),
    env.DB.prepare('SELECT n FROM daily WHERE day = ?1').bind(day),
  ]);
  return { total: total.results[0]?.n ?? 0, today: today.results[0]?.n ?? 0 };
}

async function hit(env, day) {
  const [total, today] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO counters (id, n) VALUES ('total', 1) ON CONFLICT(id) DO UPDATE SET n = n + 1 RETURNING n",
    ),
    env.DB.prepare(
      'INSERT INTO daily (day, n) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n',
    ).bind(day),
  ]);
  return { total: total.results[0].n, today: today.results[0].n };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const cors = corsHeaders(request, env);
    const day = new Date().toISOString().slice(0, 10);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
    }

    try {
      if (pathname === '/count' && request.method === 'GET') {
        return json(await read(env, day), 200, cors ?? {});
      }
      if (pathname === '/hit' && request.method === 'POST') {
        if (!cors) return json({ error: 'origin not allowed' }, 403);
        if (env.LIMITER) {
          // The IP is only handed to Cloudflare's in-memory rate limiter; it is never written anywhere.
          const key = request.headers.get('CF-Connecting-IP') || 'unknown';
          const { success } = await env.LIMITER.limit({ key });
          if (!success) return json(await read(env, day), 429, cors);
        }
        return json(await hit(env, day), 200, cors);
      }
      return json({ error: 'not found' }, 404, cors ?? {});
    } catch {
      return json({ error: 'unavailable' }, 503, cors ?? {});
    }
  },
};
