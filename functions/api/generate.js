// POST /api/generate            -> JSON { ok, script, warnings, errors, summary }
// POST /api/generate?format=rsc -> text/plain script (400 + JSON errors if the config is invalid)
// Stateless and CPU-light, so it is safe to expose publicly; add a Cloudflare rate-limiting rule if you want a cap.
import { generate } from '../../public/js/generator.js';

const MAX_BYTES = 64 * 1024;
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors } });

export const onRequestOptions = () => new Response(null, { status: 204, headers: cors });

export async function onRequestGet() {
  return json({
    usage: 'POST a JSON config (see "Export JSON" in the web UI). Add ?format=rsc for text/plain output.',
    versions: ['6', '7'],
  });
}

export async function onRequestPost({ request }) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return json({ ok: false, errors: [{ path: 'body', msg: 'Config too large (64 KB max).' }] }, 413);
  let text;
  try { text = await request.text(); } catch { return json({ ok: false, errors: [{ path: 'body', msg: 'Unreadable body.' }] }, 400); }
  if (text.length > MAX_BYTES) return json({ ok: false, errors: [{ path: 'body', msg: 'Config too large (64 KB max).' }] }, 413);

  let cfg;
  try { cfg = JSON.parse(text); } catch { return json({ ok: false, errors: [{ path: 'body', msg: 'Body must be valid JSON.' }] }, 400); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return json({ ok: false, errors: [{ path: 'body', msg: 'Body must be a JSON object.' }] }, 400);

  let result;
  try { result = generate(cfg); } catch (e) {
    return json({ ok: false, errors: [{ path: 'body', msg: 'Config could not be processed.' }] }, 422);
  }
  const wantsText = new URL(request.url).searchParams.get('format') === 'rsc';
  if (wantsText && result.ok) {
    return new Response(result.script, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-forge-warnings': String(result.warnings.length), ...cors } });
  }
  return json(result, result.ok ? 200 : 400);
}
