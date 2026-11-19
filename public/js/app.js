import { generate } from './generator.js';
import { DEFAULT_CONFIG, GAME_PRESETS } from './presets.js';
import { SCENARIOS, EXAMPLE_LABELS } from './examples.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STORE = 'forge:config:v1';

let state = clone(DEFAULT_CONFIG);
let last = null; // last generate() result

// ---------- state helpers ----------
const parts = (p) => p.split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
const get = (o, p) => parts(p).reduce((a, k) => (a == null ? a : a[k]), o);
function set(o, p, v) {
  const ks = parts(p); let a = o;
  ks.slice(0, -1).forEach((k) => { a = a[k]; });
  a[ks[ks.length - 1]] = v;
}
function deepFill(base, over) {
  if (Array.isArray(base) || over === undefined) return over === undefined ? base : over;
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = k in base ? deepFill(base[k], over[k]) : over[k];
    return out;
  }
  return over;
}
const display = (v) => (Array.isArray(v) ? v.join(', ') : v ?? '');

// ---------- toast ----------
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- dynamic lists ----------
const input = (path, label, extra = '', cls = '') =>
  `<label class="${cls}">${label}<input data-k="${path}" ${extra}></label>`;
const check = (path, label) => `<label class="check"><input type="checkbox" data-k="${path}"> ${label}</label>`;
const head = (title, act, i) => `<div class="item-head"><span>${esc(title)}</span><button type="button" data-act="${act}" data-i="${i}" aria-label="Remove ${esc(title)}">Remove</button></div>`;

function renderLists() {
  $('#wans').innerHTML = state.wans.map((w, i) => `
    <div class="item" data-type="${esc(w.type)}">
      ${state.wans.length > 1 ? head(`${w.name || 'WAN'} · ${w.iface || '?'}`, 'rm-wan', i) : `<div class="item-head"><span>${esc(w.name || 'WAN')} · ${esc(w.iface || '?')}</span></div>`}
      <div class="grid">
        ${input(`wans.${i}.name`, 'Name')}
        ${input(`wans.${i}.iface`, 'Interface', 'placeholder="ether1"')}
        <label>Connection<select data-k="wans.${i}.type" data-rerender>
          <option value="dhcp">DHCP client</option><option value="static">Static IP</option><option value="pppoe">PPPoE</option></select></label>
        ${input(`wans.${i}.vlanId`, 'ISP VLAN ID (optional)', 'type="number" min="1" max="4094"')}
        ${input(`wans.${i}.address`, 'Address / prefix', 'placeholder="203.0.113.2/30"', 'only-static')}
        ${input(`wans.${i}.gateway`, 'Gateway', 'placeholder="203.0.113.1"', 'only-static')}
        ${input(`wans.${i}.pppoeUser`, 'PPPoE user', 'autocomplete="off"', 'only-pppoe')}
        ${input(`wans.${i}.pppoePass`, 'PPPoE password', 'type="password" autocomplete="off"', 'only-pppoe')}
        ${input(`wans.${i}.down`, 'Download Mbps (for QoS)', 'type="number" min="0" step="any"')}
        ${input(`wans.${i}.up`, 'Upload Mbps (for QoS)', 'type="number" min="0" step="any"')}
        ${input(`wans.${i}.weight`, 'Weight (PCC / ECMP)', 'type="number" min="1" max="10" placeholder="1"')}
      </div>
    </div>`).join('');

  $('#vlans').innerHTML = state.vlans.map((v, i) => `
    <div class="item">
      ${head(`VLAN ${v.id || '?'} · ${v.name || ''}`, 'rm-vlan', i)}
      <div class="grid">
        ${input(`vlans.${i}.id`, 'VLAN ID', 'type="number" min="2" max="4094"')}
        ${input(`vlans.${i}.name`, 'Name')}
        ${input(`vlans.${i}.subnet`, 'Gateway / prefix', 'placeholder="192.168.10.1/24"')}
        ${input(`vlans.${i}.pool`, 'DHCP pool', 'placeholder="auto"')}
        ${input(`vlans.${i}.access`, 'Untagged (access) ports', 'placeholder="ether3, ether4"')}
        ${input(`vlans.${i}.tagged`, 'Tagged (trunk) ports', 'placeholder="ether5"')}
        ${input(`vlans.${i}.limitDown`, 'Download cap Mbps', 'type="number" min="0" step="any"')}
        ${input(`vlans.${i}.limitUp`, 'Upload cap Mbps', 'type="number" min="0" step="any"')}
        ${check(`vlans.${i}.dhcp`, 'DHCP server')}
        ${check(`vlans.${i}.isolate`, 'Isolate (no access to other LANs / router)')}
        ${check(`vlans.${i}.internet`, 'Internet allowed')}
        ${check(`vlans.${i}.mgmt`, 'Management VLAN (may reach all)')}
      </div>
    </div>`).join('') || '<p class="hint">No VLANs: the router runs a single native LAN on the bridge.</p>';

  $('#leases').innerHTML = state.lan.leases.map((l, i) => `
    <div class="item"><div class="grid">
      ${input(`lan.leases.${i}.mac`, 'MAC', 'placeholder="AA:BB:CC:DD:EE:FF"')}
      ${input(`lan.leases.${i}.ip`, 'IP address')}
      ${input(`lan.leases.${i}.comment`, 'Comment')}
      <label>&nbsp;<button type="button" data-act="rm-lease" data-i="${i}">Remove</button></label>
    </div></div>`).join('');

  $('#staticdns').innerHTML = state.system.staticDns.map((r, i) => `
    <div class="item"><div class="grid">
      ${input(`system.staticDns.${i}.name`, 'Name', 'placeholder="nas.lan"')}
      ${input(`system.staticDns.${i}.address`, 'Address')}
      <label>&nbsp;<button type="button" data-act="rm-dns" data-i="${i}">Remove</button></label>
    </div></div>`).join('');

  $('#forwards').innerHTML = state.firewall.portForwards.map((f, i) => `
    <div class="item">
      ${head(`Forward ${f.name || i + 1}`, 'rm-fwd', i)}
      <div class="grid">
        ${input(`firewall.portForwards.${i}.name`, 'Name')}
        <label>Protocol<select data-k="firewall.portForwards.${i}.proto"><option value="tcp">TCP</option><option value="udp">UDP</option><option value="both">TCP + UDP</option></select></label>
        ${input(`firewall.portForwards.${i}.wanPort`, 'External port(s)', 'placeholder="8080 or 5000-5100"')}
        ${input(`firewall.portForwards.${i}.toAddr`, 'Internal IP')}
        ${input(`firewall.portForwards.${i}.toPort`, 'Internal port (optional)')}
        ${check(`firewall.portForwards.${i}.hairpin`, 'Hairpin NAT (reach it via WAN IP from LAN)')}
      </div>
    </div>`).join('');

  $('#wgpeers').innerHTML = state.wireguard.peers.map((p, i) => `
    <div class="item">
      ${head(`Peer ${p.name || i + 1}`, 'rm-peer', i)}
      <div class="grid">
        ${input(`wireguard.peers.${i}.name`, 'Name')}
        ${input(`wireguard.peers.${i}.allowed`, 'Allowed address', 'placeholder="10.99.0.2/32"')}
        ${input(`wireguard.peers.${i}.publicKey`, 'Client public key', 'placeholder="44-char base64 ending in ="', 'wide')}
      </div>
    </div>`).join('');

  $('#presets').innerHTML = GAME_PRESETS.map((p) => `
    <label><input type="checkbox" data-preset="${p.id}"> ${esc(p.name)}<em class="${p.source}">${p.source}</em></label>`).join('');
  syncInputs();
}

function syncInputs() {
  $$('[data-k]').forEach((el) => {
    const v = get(state, el.dataset.k);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (document.activeElement !== el) el.value = display(v);
  });
  $$('[data-preset]').forEach((el) => { el.checked = (state.qos.gaming.presets || []).includes(el.dataset.preset); });
  $$('#wans .item').forEach((el, i) => { el.dataset.type = state.wans[i]?.type || 'dhcp'; });
  hints();
}

function hints() {
  const m = {
    single: 'One uplink.',
    failover: 'Primary ISP carries everything; the next one takes over when its gateway stops answering pings (static) or the link/lease drops (DHCP/PPPoE).',
    ecmp: 'Each flow is hashed to one of the ISPs. Simple, but all WANs must be usable, and weights only apply to static gateways.',
    pcc: 'Per-Connection Classifier: new connections are spread by weight, kept on their WAN, and fall back to the other WAN if one dies. Disables FastTrack.',
  };
  $('#mw-hint').textContent = m[state.multiwan.mode] || '';
  const q = {
    off: '', htb: 'Gaming → realtime → web → default → bulk, each with guaranteed share, borrowing the rest. Works on v6 and v7.',
    cake: 'One CAKE queue per WAN and for download, with gaming/realtime tagged EF so CAKE serves them first. Best bufferbloat fix; needs v7.1+.',
    'fq-codel': 'Fair queuing with CoDel: removes bufferbloat but ignores priorities. Needs v7.1+.',
  };
  $('#qos-hint').textContent = (state.version === '6' && ['cake', 'fq-codel'].includes(state.qos.mode)) ? 'RouterOS v6 has no CAKE/FQ-CoDel: HTB will be generated instead.' : q[state.qos.mode] || '';
  $('#ntp-note').textContent = state.version === '6' ? '(v6: IP addresses only)' : '';
  $('#curl').textContent = `curl -s -X POST ${location.origin}/api/generate?format=rsc \\\n  -H 'content-type: application/json' \\\n  --data @forge-config.json > router.rsc`;
}

// ---------- generation + output ----------
let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 120); };

function paintScript(text) {
  return text.split('\n').map((l) => {
    if (l.startsWith('# ----')) return `<span class="l s">${esc(l)}</span>`;
    if (l.startsWith('#')) return `<span class="l c">${esc(l)}</span>`;
    const m = /^(\/[a-z0-9-]+(?: [a-z0-9-]+)*?)( (?:add|set|remove) .*)$/.exec(l);
    return m ? `<span class="l"><span class="m">${esc(m[1])}</span>${esc(m[2])}</span>` : `<span class="l">${esc(l)}</span>`;
  }).join('');
}

function update() {
  last = generate(state);
  const pre = $('#script');
  const box = $('#problems');
  const bad = (last.errors || []).map((e) => `<div class="err"><b>${esc(e.path)}</b> — ${esc(e.msg)}</div>`);
  const warn = (last.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`);
  box.innerHTML = bad.join('') + warn.join('');
  $$('.invalid').forEach((e) => e.classList.remove('invalid'));
  for (const e of last.errors || []) {
    const key = e.path.replace(/\[(\d+)\]/g, '.$1');
    $$(`[data-k="${key}"]`).forEach((el) => el.classList.add('invalid'));
  }
  if (last.ok) {
    pre.classList.remove('stale');
    pre.innerHTML = paintScript(last.script);
    const s = last.summary;
    $('#badges').innerHTML = [`v${state.version}`, `${s.wans} WAN${s.wans > 1 ? 's' : ''} · ${s.mode}`, `${s.vlans} VLAN${s.vlans === 1 ? '' : 's'}`, `QoS ${s.qos}`, `${s.lines} lines`].map((b) => `<span class="badge">${esc(b)}</span>`).join('');
  } else {
    pre.classList.add('stale');
    $('#badges').innerHTML = `<span class="badge">${last.errors.length} error${last.errors.length > 1 ? 's' : ''} to fix</span>`;
  }
  $('#btn-copy').disabled = $('#btn-dl').disabled = !last.ok;
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

// ---------- events ----------
document.addEventListener('input', onEdit);
document.addEventListener('change', onEdit);
function onEdit(e) {
  const el = e.target;
  if (el.dataset.preset) {
    const set_ = new Set(state.qos.gaming.presets || []);
    el.checked ? set_.add(el.dataset.preset) : set_.delete(el.dataset.preset);
    state.qos.gaming.presets = [...set_];
    return schedule();
  }
  const k = el.dataset.k;
  if (!k) return;
  if (el.type === 'radio') { if (!el.checked) return; set(state, k, el.value); }
  else if (el.type === 'checkbox') set(state, k, el.checked);
  else set(state, k, el.value);
  if (e.type === 'change' && (el.dataset.rerender !== undefined || k === 'multiwan.mode' || k === 'version' || k === 'qos.mode')) { renderLists(); }
  if (k === 'version' || k === 'qos.mode' || k === 'multiwan.mode') hints();
  schedule();
}

const blank = {
  wan: (n) => ({ name: `WAN${n}`, iface: `ether${n}`, type: 'dhcp', address: '', gateway: '', pppoeUser: '', pppoePass: '', vlanId: '', weight: 1, down: '', up: '' }),
  vlan: () => ({ id: '', name: '', subnet: '', pool: '', access: '', tagged: '', dhcp: true, isolate: false, internet: true, mgmt: false, limitUp: '', limitDown: '' }),
};
const actions = {
  'add-wan': () => { state.wans.push(blank.wan(state.wans.length + 1)); if (state.wans.length > 1 && state.multiwan.mode === 'single') state.multiwan.mode = 'failover'; },
  'rm-wan': (i) => { state.wans.splice(i, 1); if (state.wans.length === 1) state.multiwan.mode = 'single'; },
  'add-vlan': () => {
    // next free ID (10, 20, 30...) whose 192.168.<id>.0/24 does not collide with an existing VLAN
    const used = new Set(state.vlans.map((v) => Number(v.id)));
    let id = 10; while (used.has(id) || /^192\.168\.(\d+)\./.test(state.lan.address) && Number(RegExp.$1) === id) id += 10;
    state.vlans.push({ ...blank.vlan(), id, name: `vlan${id}`, subnet: `192.168.${id}.1/24` });
  },
  'rm-vlan': (i) => state.vlans.splice(i, 1),
  'add-lease': () => state.lan.leases.push({ mac: '', ip: '', comment: '' }),
  'rm-lease': (i) => state.lan.leases.splice(i, 1),
  'add-dns': () => state.system.staticDns.push({ name: '', address: '' }),
  'rm-dns': (i) => state.system.staticDns.splice(i, 1),
  'add-fwd': () => state.firewall.portForwards.push({ name: `fwd${state.firewall.portForwards.length + 1}`, proto: 'tcp', wanPort: '', toAddr: '', toPort: '', hairpin: false }),
  'rm-fwd': (i) => state.firewall.portForwards.splice(i, 1),
  'add-peer': () => state.wireguard.peers.push({ name: '', publicKey: '', allowed: '' }),
  'rm-peer': (i) => state.wireguard.peers.splice(i, 1),
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && actions[b.dataset.act]) { actions[b.dataset.act](Number(b.dataset.i)); renderLists(); update(); }
});

$$('.tabs [role=tab]').forEach((t) => t.addEventListener('click', () => {
  $$('.tabs [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
}));

// ---------- examples / import / export / share ----------
const ex = $('#examples');
for (const [id, label] of Object.entries(EXAMPLE_LABELS)) ex.add(new Option(label, id));
ex.addEventListener('change', () => {
  if (!ex.value) return;
  load({ ...SCENARIOS[ex.value](), version: state.version });
  ex.value = '';
  toast('Example loaded');
});

function load(cfg) {
  state = deepFill(clone(DEFAULT_CONFIG), clone(cfg));
  if (state.version !== '6' && state.version !== '7') state.version = '7';
  renderLists(); update();
}

$('#btn-export').addEventListener('click', () => {
  download(`forge-config.json`, JSON.stringify(state, null, 2), 'application/json');
});
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { load(JSON.parse(await f.text())); toast('Config imported'); } catch { toast('That file is not valid JSON'); }
  e.target.value = '';
});
$('#btn-copy').addEventListener('click', async () => {
  if (!last?.ok) return;
  try { await navigator.clipboard.writeText(last.script); toast('Script copied'); }
  catch { const r = document.createRange(); r.selectNodeContents($('#script')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Press Ctrl/Cmd+C to copy'); }
});
$('#btn-dl').addEventListener('click', () => {
  if (last?.ok) download(`${(state.system.identity || 'router').replace(/[^\w-]+/g, '-')}-v${state.version}.rsc`, last.script, 'text/plain');
});
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

$('#btn-share').addEventListener('click', async () => {
  // Never put PPPoE passwords in a shared link.
  const safe = clone(state); safe.wans.forEach((w) => { w.pppoePass = ''; });
  let url = `${location.origin}/#c=${b64(JSON.stringify(safe))}`;
  try {
    const r = await fetch('/api/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(safe) });
    if (r.ok) url = `${location.origin}/#s=${(await r.json()).id}`;
  } catch { /* offline / no KV: fall back to the self-contained link */ }
  try { await navigator.clipboard.writeText(url); toast('Share link copied (passwords are never included)'); } catch { prompt('Copy this link', url); }
});

// ---------- boot ----------
async function boot() {
  renderLists();
  const h = location.hash;
  try {
    if (h.startsWith('#c=')) { load(JSON.parse(unb64(h.slice(3)))); return; }
    if (h.startsWith('#s=')) {
      const r = await fetch(`/api/share?id=${encodeURIComponent(h.slice(3))}`);
      if (r.ok) { load(await r.json()); return; }
      toast('Shared config not found');
    }
  } catch { toast('Could not read the shared config'); }
  try { const saved = localStorage.getItem(STORE); if (saved) { load(JSON.parse(saved)); return; } } catch { /* ignore */ }
  update();
}
boot();
