// POST /api/share      body: config JSON  -> { id }      (needs a KV namespace bound as SHARES)
// GET  /api/share?id=  -> the stored config JSON
// Without the KV binding the endpoint answers 501 and the web UI falls back to self-contained #c= links.
const MAX_BYTES = 32 * 1024;
const TTL = 60 * 60 * 24 * 90; // 90 days
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

function newId(len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

// Secrets must never be persisted, even if a client sends them.
function scrub(cfg) {
  for (const w of Array.isArray(cfg.wans) ? cfg.wans : []) if (w && typeof w === 'object') w.pppoePass = '';
  return cfg;
}

export async function onRequestPost({ request, env }) {
  if (!env.SHARES) return reply({ error: 'Sharing is not enabled on this deployment.' }, 501);
  const text = await request.text();
  if (text.length > MAX_BYTES) return reply({ error: 'Config too large.' }, 413);
  let cfg;
  try { cfg = JSON.parse(text); } catch { return reply({ error: 'Body must be JSON.' }, 400); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return reply({ error: 'Body must be a JSON object.' }, 400);
  const id = newId();
  await env.SHARES.put(`s:${id}`, JSON.stringify(scrub(cfg)), { expirationTtl: TTL });
  return reply({ id });
}

export async function onRequestGet({ request, env }) {
  if (!env.SHARES) return reply({ error: 'Sharing is not enabled on this deployment.' }, 501);
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[A-Za-z0-9]{10}$/.test(id)) return reply({ error: 'Bad id.' }, 400);
  const v = await env.SHARES.get(`s:${id}`);
  return v ? new Response(v, { headers }) : reply({ error: 'Not found.' }, 404);
}
