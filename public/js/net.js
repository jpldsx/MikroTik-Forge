// IPv4 helpers + RouterOS value formatting. Pure functions, no DOM, runs in browser/Node/Workers.

export function ipToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip).trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

export function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isIPv4(s) {
  return ipToInt(s) !== null;
}

/** Parse "a.b.c.d/p" -> {ip, prefix, mask, net, bcast, cidr, netCidr} or null */
export function parseCidr(s) {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  const ip = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || prefix < 1 || prefix > 32) return null;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  const net = (ip & mask) >>> 0;
  const bcast = (net | (~mask >>> 0)) >>> 0;
  return {
    ip, prefix, mask, net, bcast,
    ipStr: intToIp(ip),
    cidr: `${intToIp(ip)}/${prefix}`,
    netCidr: `${intToIp(net)}/${prefix}`,
  };
}

export function cidrOverlap(a, b) {
  return a.net <= b.bcast && b.net <= a.bcast;
}

/** Default DHCP pool "start-end" avoiding the gateway address. */
export function defaultPool(c) {
  const hosts = c.bcast - c.net - 1;
  let start = hosts >= 40 ? c.net + 10 : c.net + 2;
  let end = c.bcast - 1;
  if (c.ip >= start && c.ip <= end) {
    if (c.ip - start >= end - c.ip) end = c.ip - 1; else start = c.ip + 1;
  }
  if (start > end) return null;
  return `${intToIp(start)}-${intToIp(end)}`;
}

export function validPool(range, c) {
  const m = /^([\d.]+)-([\d.]+)$/.exec(String(range).trim());
  if (!m) return false;
  const a = ipToInt(m[1]); const b = ipToInt(m[2]);
  return a !== null && b !== null && a <= b && a > c.net && b < c.bcast;
}

export function isMac(s) {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(String(s).trim());
}

/** Safe identifier for names/comments/tables: letters digits _ - */
export function ident(s, fallback = 'x') {
  const v = String(s ?? '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return v || fallback;
}

/** Quote a RouterOS value only when needed; escape \ " $ ? inside quotes */
export function q(v) {
  // Control characters (newlines!) would start a new command line in an .rsc file - flatten them to spaces.
  const s = String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  if (/^[A-Za-z0-9_.:\/@+\-,!*%]+$/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\?/g, '\\?') + '"';
}

/** Build "key=value key2=value2", skipping empty values. */
export function props(o) {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${v === true ? 'yes' : q(v)}`)
    .join(' ');
}

/** Port spec "80,443,1000-2000" validation */
export function validPorts(s) {
  return /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(String(s).replace(/\s+/g, '')) &&
    String(s).replace(/\s+/g, '').split(',').every((p) => {
      const [a, b] = p.split('-').map(Number);
      return a >= 1 && a <= 65535 && (b === undefined || (b >= a && b <= 65535));
    });
}

/** RouterOS allows max 15 entries in a port list: split into chunks. */
export function chunkPorts(s, n = 15) {
  const parts = String(s).replace(/\s+/g, '').split(',').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i += n) out.push(parts.slice(i, i + n).join(','));
  return out;
}

/** Mbps number -> RouterOS rate string, using k for fractions. */
export function rate(mbps) {
  const k = Math.round(mbps * 1000);
  return k % 1000 === 0 ? `${k / 1000}M` : `${k}k`;
}
