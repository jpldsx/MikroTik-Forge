// MikroTik Forge - RouterOS v6/v7 configuration generator.
// Pure ES module: no DOM, no Node APIs. Used by the browser UI, the Cloudflare Pages Function and the tests.
//
// Output is an .rsc script intended for a router reset with `no-defaults=yes`
// (see the header comment it emits). Every command is emitted as a single line with a full menu path,
// so lines are order-independent and lintable (see tests/lint.js).

import {
  isIPv4, parseCidr, cidrOverlap, defaultPool, validPool, isMac, ident, q, props,
  validPorts, chunkPorts, rate,
} from './net.js';
import { GAME_PRESETS, DEFAULT_CONFIG } from './presets.js';

export const GENERATOR_VERSION = '1.0.0';

const REALTIME_UDP = '53,3478-3481,5060,5061,8801-8810,19302-19309';
const BOGONS = ['0.0.0.0/8', '127.0.0.0/8', '224.0.0.0/3'];

function merge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base)) return over;
  if (base && typeof base === 'object' && over && typeof over === 'object' && !Array.isArray(over)) {
    const out = { ...base };
    for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
    return out;
  }
  return over;
}

const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);

/** Normalise + validate. Returns { cfg, errors, warnings }. */
export function normalize(input) {
  // Clone both sides: normalize() mutates cfg, and defaults/caller input must never be touched (Worker isolates are long-lived).
  const cfg = merge(structuredClone(DEFAULT_CONFIG), structuredClone(input || {}));
  const errors = [];
  const warnings = [];
  const err = (path, msg) => errors.push({ path, msg });
  const warn = (msg) => warnings.push(msg);

  if (cfg.version !== '6' && cfg.version !== '7') err('version', 'RouterOS version must be "6" or "7".');
  const v7 = cfg.version === '7';

  // ---- system
  const s = cfg.system;
  s.identity = ident(s.identity, 'MikroTik');
  s.ntp = list(s.ntp);
  s.dns = list(s.dns);
  for (const [i, d] of s.dns.entries()) if (!isIPv4(d)) err(`system.dns[${i}]`, `DNS server "${d}" is not an IPv4 address.`);
  for (const [i, n] of s.ntp.entries()) {
    if (!v7 && !isIPv4(n)) err(`system.ntp[${i}]`, `RouterOS v6 NTP server must be an IP address ("${n}").`);
    if (v7 && !isIPv4(n) && !/^[A-Za-z0-9.-]+$/.test(n)) err(`system.ntp[${i}]`, `Invalid NTP server "${n}".`);
  }
  if (s.timezone && !/^[A-Za-z0-9_+\-\/]+$/.test(s.timezone)) err('system.timezone', 'Invalid time zone name.');
  if (s.forceDns && !s.allowRemoteRequests) err('system.forceDns', 'Forcing DNS requires "allow remote requests" to be on.');
  s.staticDns = (s.staticDns || []).filter((r) => r && (r.name || r.address));
  for (const [i, r] of s.staticDns.entries()) {
    if (!/^[A-Za-z0-9._-]+$/.test(r.name || '')) err(`system.staticDns[${i}].name`, 'Invalid DNS name.');
    if (!isIPv4(r.address)) err(`system.staticDns[${i}].address`, 'Address must be IPv4.');
  }

  // ---- LAN
  const lan = cfg.lan;
  lan.bridge = ident(lan.bridge, 'bridge');
  lan.ports = list(lan.ports);
  const nets = []; // {label, c}
  lan.c = null;
  if (lan.address) {
    lan.c = parseCidr(lan.address);
    if (!lan.c) err('lan.address', `LAN address "${lan.address}" must look like 192.168.88.1/24.`);
    else if (lan.c.prefix > 30) err('lan.address', 'LAN prefix must be /30 or larger network (e.g. /24).');
    else nets.push({ label: 'LAN', c: lan.c });
  }
  if (lan.dhcp && lan.c) {
    lan.poolFinal = lan.pool || defaultPool(lan.c);
    if (!lan.poolFinal || !validPool(lan.poolFinal, lan.c)) err('lan.pool', 'DHCP pool must be "start-end" inside the LAN subnet.');
  }

  // ---- VLANs
  const vlans = (cfg.vlans || []).map((v) => ({ dhcp: true, isolate: false, internet: true, mgmt: false, limitUp: '', limitDown: '', ...v }));
  const seenIds = new Set();
  const accessOwner = new Map();
  for (const [i, v] of vlans.entries()) {
    const p = `vlans[${i}]`;
    v.id = Number(v.id);
    v.name = ident(v.name, `vlan${v.id}`);
    v.ifname = `vlan${v.id}-${v.name}`.slice(0, 15);
    if (!Number.isInteger(v.id) || v.id < 2 || v.id > 4094) err(`${p}.id`, 'VLAN ID must be 2-4094 (1 is the native LAN).');
    if (seenIds.has(v.id)) err(`${p}.id`, `Duplicate VLAN ID ${v.id}.`);
    seenIds.add(v.id);
    v.c = parseCidr(v.subnet);
    if (!v.c) err(`${p}.subnet`, `VLAN ${v.id} gateway/prefix "${v.subnet}" is invalid (use e.g. 192.168.10.1/24).`);
    else if (v.c.prefix > 30) err(`${p}.subnet`, 'VLAN prefix must be /30 or larger network.');
    else {
      for (const n of nets) if (cidrOverlap(n.c, v.c)) err(`${p}.subnet`, `VLAN ${v.id} overlaps ${n.label}.`);
      nets.push({ label: `VLAN ${v.id}`, c: v.c });
    }
    v.access = list(v.access);
    v.tagged = list(v.tagged);
    for (const port of v.access) {
      if (accessOwner.has(port)) err(`${p}.access`, `Port ${port} is already an untagged port of VLAN ${accessOwner.get(port)}.`);
      accessOwner.set(port, v.id);
    }
    v.dhcp = v.dhcp !== false;
    if (v.dhcp && v.c) {
      v.poolFinal = v.pool || defaultPool(v.c);
      if (!v.poolFinal || !validPool(v.poolFinal, v.c)) err(`${p}.pool`, `VLAN ${v.id} DHCP pool is invalid.`);
    }
    for (const k of ['limitUp', 'limitDown']) {
      if (v[k] !== '' && v[k] !== undefined && !(num(v[k]) > 0)) err(`${p}.${k}`, 'Limit must be a positive number of Mbps (or empty).');
    }
  }
  cfg.vlans = vlans;
  const vlanMode = vlans.length > 0;

  // ---- WireGuard
  const wg = cfg.wireguard;
  if (wg.enabled) {
    if (!v7) { warn('WireGuard is RouterOS v7 only - it was skipped for v6.'); wg.enabled = false; }
    else {
      wg.name = ident(wg.name, 'wg0');
      wg.c = parseCidr(wg.address);
      if (!wg.c) err('wireguard.address', 'WireGuard address must be CIDR, e.g. 10.99.0.1/24.');
      else {
        for (const n of nets) if (cidrOverlap(n.c, wg.c)) err('wireguard.address', `WireGuard subnet overlaps ${n.label}.`);
        nets.push({ label: 'WireGuard', c: wg.c });
      }
      const port = Number(wg.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) err('wireguard.port', 'WireGuard port must be 1-65535.');
      wg.peers = (wg.peers || []).filter((x) => x && (x.publicKey || x.allowed));
      for (const [i, pr] of wg.peers.entries()) {
        if (!/^[A-Za-z0-9+/]{43}=$/.test(pr.publicKey || '')) err(`wireguard.peers[${i}].publicKey`, 'Public key must be 44-char base64.');
        if (!parseCidr(pr.allowed || '')) err(`wireguard.peers[${i}].allowed`, 'Allowed address must be CIDR (e.g. 10.99.0.2/32).');
      }
    }
  }

  // ---- WANs
  const wans = (cfg.wans || []).map((w) => ({ type: 'dhcp', weight: 1, down: '', up: '', vlanId: '', ...w }));
  if (wans.length < 1) err('wans', 'At least one WAN is required.');
  const seenWanName = new Set(); const seenWanIf = new Set();
  const lanPorts = new Set([...lan.ports, ...vlans.flatMap((v) => [...v.access, ...v.tagged])]);
  for (const [i, w] of wans.entries()) {
    const p = `wans[${i}]`;
    w.name = ident(w.name, `WAN${i + 1}`);
    w.iface = String(w.iface || '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(w.iface)) err(`${p}.iface`, 'WAN interface name is required (e.g. ether1).');
    if (seenWanName.has(w.name)) err(`${p}.name`, `Duplicate WAN name ${w.name}.`);
    if (seenWanIf.has(w.iface)) err(`${p}.iface`, `Interface ${w.iface} used twice.`);
    seenWanName.add(w.name); seenWanIf.add(w.iface);
    if (lanPorts.has(w.iface)) err(`${p}.iface`, `${w.iface} is both a WAN and a LAN/VLAN port.`);
    w.weight = Math.max(1, Math.round(num(w.weight) || 1));
    w.vlanId = w.vlanId === '' || w.vlanId === undefined ? '' : Number(w.vlanId);
    if (w.vlanId !== '' && (!Number.isInteger(w.vlanId) || w.vlanId < 1 || w.vlanId > 4094)) err(`${p}.vlanId`, 'WAN VLAN ID must be 1-4094.');
    w.base = w.vlanId !== '' ? `${w.iface}-vlan${w.vlanId}`.slice(0, 15) : w.iface;
    if (!['dhcp', 'static', 'pppoe'].includes(w.type)) err(`${p}.type`, 'WAN type must be dhcp, static or pppoe.');
    if (w.type === 'pppoe') {
      w.eff = `pppoe-${w.name}`.slice(0, 15);
      if (!w.pppoeUser) err(`${p}.pppoeUser`, 'PPPoE username is required.');
    } else w.eff = w.base;
    if (w.type === 'static') {
      w.c = parseCidr(w.address);
      if (!w.c) err(`${p}.address`, 'Static WAN address must be CIDR (e.g. 203.0.113.2/30).');
      if (!isIPv4(w.gateway)) err(`${p}.gateway`, 'Static WAN gateway must be an IPv4 address.');
      else if (w.c && (w.c.net > (require_ip(w.gateway)) || require_ip(w.gateway) > w.c.bcast)) warn(`${w.name}: gateway ${w.gateway} is outside ${w.c.netCidr}.`);
      if (w.c) for (const n of nets) if (cidrOverlap(n.c, w.c)) err(`${p}.address`, `${w.name} subnet overlaps ${n.label}.`);
    }
    for (const k of ['down', 'up']) {
      if (w[k] !== '' && w[k] !== undefined && !(num(w[k]) > 0)) err(`${p}.${k}`, 'Speed must be a positive number of Mbps (or empty).');
    }
  }
  cfg.wans = wans;

  let mode = cfg.multiwan.mode;
  if (!['single', 'failover', 'ecmp', 'pcc'].includes(mode)) { err('multiwan.mode', 'Unknown multi-WAN mode.'); mode = 'single'; }
  if (wans.length > 1 && mode === 'single') { err('multiwan.mode', 'More than one WAN needs mode failover, ecmp or pcc.'); }
  if (wans.length === 1 && mode !== 'single') { warn(`Only one WAN defined - multi-WAN mode "${mode}" ignored.`); mode = 'single'; }
  cfg.multiwan.mode = mode;
  if (mode === 'ecmp' && wans.some((w) => w.weight !== 1) && !wans.every((w) => w.type === 'static')) {
    warn('ECMP weights are only applied when every WAN uses a static gateway; weights were ignored.');
  }
  if (mode === 'failover' && wans.some((w) => w.type === 'dhcp')) {
    warn('Failover with DHCP WANs relies on the DHCP route and link state; a dead ISP behind a live link is not detected. Use static gateways for ping-based failover, or PCC mode (which pings gateways).');
  }

  // ---- firewall
  const fw = cfg.firewall;
  fw.portForwards = (fw.portForwards || []).filter((f) => f && (f.wanPort || f.toAddr));
  for (const [i, f] of fw.portForwards.entries()) {
    const p = `firewall.portForwards[${i}]`;
    f.name = ident(f.name, `fwd${i + 1}`);
    if (!['tcp', 'udp', 'both'].includes(f.proto)) err(`${p}.proto`, 'Protocol must be tcp, udp or both.');
    if (!validPorts(f.wanPort || '')) err(`${p}.wanPort`, 'External port(s) invalid.');
    if (!isIPv4(f.toAddr)) err(`${p}.toAddr`, 'Target address must be IPv4.');
    else if (!nets.some((n) => ipIn(n.c, f.toAddr))) warn(`Port forward "${f.name}" targets ${f.toAddr}, which is not in any configured LAN/VLAN subnet.`);
    if (f.toPort && !validPorts(f.toPort)) err(`${p}.toPort`, 'Target port invalid.');
    if (f.toPort && String(f.wanPort).includes(',')) err(`${p}.toPort`, 'Port translation only works with a single external port or range.');
  }
  fw.mgmtWhitelist = list(fw.mgmtWhitelist);
  if (fw.mgmtFromWan) {
    if (!fw.mgmtWhitelist.length) err('firewall.mgmtWhitelist', 'Allowing management from WAN requires at least one whitelisted IP/CIDR.');
    for (const a of fw.mgmtWhitelist) if (!(isIPv4(a) || parseCidr(a))) err('firewall.mgmtWhitelist', `"${a}" is not an IPv4 address or CIDR.`);
  }

  // ---- QoS
  const qos = cfg.qos;
  const g = qos.gaming;
  g.devices = list(g.devices);
  for (const d of g.devices) if (!isIPv4(d)) err('qos.gaming.devices', `Gaming device "${d}" must be an IPv4 address.`);
  g.presets = list(g.presets).filter((id) => GAME_PRESETS.some((x) => x.id === id));
  for (const k of ['customUdp', 'customTcp']) if (g[k] && !validPorts(g[k])) err(`qos.gaming.${k}`, 'Invalid port list.');
  qos.bulkDevices = list(qos.bulkDevices);
  for (const d of qos.bulkDevices) if (!isIPv4(d)) err('qos.bulkDevices', `Bulk device "${d}" must be IPv4.`);
  qos.shapePercent = Math.min(100, Math.max(50, Number(qos.shapePercent) || 95));
  if (!['off', 'htb', 'cake', 'fq-codel'].includes(qos.mode)) err('qos.mode', 'Unknown QoS mode.');
  if ((qos.mode === 'cake' || qos.mode === 'fq-codel') && !v7) {
    warn(`${qos.mode} needs RouterOS v7.1+; falling back to the HTB priority queue tree for v6.`);
    qos.mode = 'htb';
  }
  if (g.enabled && qos.mode === 'off') {
    warn('Gaming priority needs a QoS mode; HTB priority queue tree was enabled for you.');
    qos.mode = 'htb';
  }
  if (qos.mode === 'fq-codel' && g.enabled) {
    warn('fq-codel does not honour priorities or DSCP; gaming priority only works with HTB or CAKE. fq-codel still removes most bufferbloat for gaming.');
  }
  if (qos.mode !== 'off') {
    if (!wans.some((w) => num(w.up) > 0 && num(w.down) > 0)) err('qos.mode', 'QoS needs measured up/down speeds (Mbps) on at least one WAN.');
    for (const w of wans) if (!(num(w.up) > 0 && num(w.down) > 0)) warn(`${w.name}: no up/down speed set - this WAN is not shaped.`);
    if (qos.mode === 'cake' || qos.mode === 'fq-codel') {
      if (wans.length > 1) warn('SQM shapes download as one aggregate across all WANs; for multi-WAN prefer the HTB mode or per-WAN accuracy will suffer.');
    }
    qos.dlParent = (!qos.dlParent || qos.dlParent === 'bridge') ? lan.bridge : ident(qos.dlParent, lan.bridge);
    if (vlanMode) warn(`Download shaping uses a queue tree on "${qos.dlParent}". With VLAN interfaces on a bridge, check "/queue tree print stats" shows traffic counters on the download queues; if not, change the download parent to "global".`);
  }
  const vlanLimited = qos.vlanLimits && vlans.some((v) => num(v.limitUp) > 0 || num(v.limitDown) > 0);
  qos._vlanLimited = vlanLimited;
  qos._marks = qos.mode === 'htb' || ((qos.mode === 'cake') && (g.enabled || qos.realtime || qos.bulkDevices.length > 0));

  // fasttrack compatibility
  fw._fasttrack = !!fw.fasttrack;
  if (fw._fasttrack && (mode === 'pcc' || qos._marks || vlanLimited)) {
    fw._fasttrack = false;
    warn('FastTrack was disabled because it bypasses mangle/queues, which PCC, packet marking and per-VLAN limits depend on. Expect higher CPU use at gigabit speeds.');
  }

  // dhcp static leases
  lan.leases = (lan.leases || []).filter((l) => l && (l.mac || l.ip));
  for (const [i, l] of lan.leases.entries()) {
    if (!isMac(l.mac || '')) err(`lan.leases[${i}].mac`, 'Invalid MAC address.');
    if (!isIPv4(l.ip)) err(`lan.leases[${i}].ip`, 'Invalid IP address.');
    else if (!nets.some((n) => ipIn(n.c, l.ip))) err(`lan.leases[${i}].ip`, `${l.ip} is not inside any LAN/VLAN subnet.`);
  }

  cfg._nets = nets;
  cfg._v7 = v7;
  cfg._vlanMode = vlanMode;
  return { cfg, errors, warnings };
}

function require_ip(s) { return parseCidr(`${s}/32`).ip; }
function ipIn(c, ip) { const n = parseCidr(`${ip}/32`).ip; return n >= c.net && n <= c.bcast; }

/** Generate the .rsc script. */
export function generate(input) {
  const { cfg, errors, warnings } = normalize(input);
  if (errors.length) return { ok: false, errors, warnings, script: '' };

  const v7 = cfg._v7;
  const RT = v7 ? 'routing-table' : 'routing-mark'; // route property that selects the table
  const out = [];
  const add = (path, p) => out.push(`/${path} add ${props(p)}`);
  const set = (path, p) => out.push(`/${path} set ${props(p)}`);
  const raw = (l) => out.push(l);
  const sec = (t) => { out.push(''); out.push(`# ---- ${t}`); };
  const wans = cfg.wans; const vlans = cfg.vlans; const lan = cfg.lan; const fw = cfg.firewall; const qos = cfg.qos;
  const mode = cfg.multiwan.mode; const wg = cfg.wireguard;
  const pppoeAny = wans.some((w) => w.type === 'pppoe');
  const dhcpServers = []; // {name, c}

  // ---------------------------------------------------------------- header
  raw(`# MikroTik Forge ${GENERATOR_VERSION} - RouterOS v${cfg.version} configuration`);
  raw(`# Target: RouterOS ${v7 ? '7.x' : '6.41+ (6.x)'}   Multi-WAN: ${mode}   VLANs: ${vlans.length}   QoS: ${qos.mode}`);
  raw('#');
  raw('# Apply (recommended - this script assumes an empty configuration):');
  raw('#   1) Upload this file to the router (Winbox > Files, or scp).');
  raw('#   2) /system reset-configuration no-defaults=yes skip-backup=yes run-after-reset=forge.rsc');
  raw('#   Rename the file to forge.rsc first, or change the name above.');
  raw('# Reach the router afterwards at the LAN address below (or via Winbox MAC if you have no LAN address).');
  raw('# Test in Safe Mode first when applying by hand (Ctrl+X in the terminal).');

  // ---------------------------------------------------------------- system
  sec('System');
  set('system identity', { name: cfg.system.identity });
  if (cfg.system.timezone) set('system clock', { 'time-zone-name': cfg.system.timezone });
  if (cfg.system.ntp.length) {
    if (v7) set('system ntp client', { enabled: 'yes', servers: cfg.system.ntp.join(',') });
    else {
      set('system ntp client', {
        enabled: 'yes', 'primary-ntp': cfg.system.ntp[0], ...(cfg.system.ntp[1] ? { 'secondary-ntp': cfg.system.ntp[1] } : {}),
      });
    }
  }
  set('ip dns', { servers: cfg.system.dns.join(','), 'allow-remote-requests': cfg.system.allowRemoteRequests ? 'yes' : 'no' });
  for (const r of cfg.system.staticDns) add('ip dns static', { name: r.name, address: r.address });
  set('ip settings', { 'tcp-syncookies': 'yes' });
  if (cfg.system.disableIpv6) { raw('# (needs the ipv6 package on v6; harmless to skip)'); set('ipv6 settings', { 'disable-ipv6': 'yes' }); }

  // ---------------------------------------------------------------- interface lists
  sec('Interface lists');
  add('interface list', { name: 'WAN' });
  add('interface list', { name: 'LAN' });

  // ---------------------------------------------------------------- WAN link layer
  sec('WAN interfaces');
  for (const w of wans) {
    if (w.vlanId !== '') add('interface vlan', { name: w.base, interface: w.iface, 'vlan-id': w.vlanId, comment: `${w.name} ISP VLAN` });
    if (w.type === 'pppoe') {
      add('interface pppoe-client', {
        name: w.eff, interface: w.base, user: w.pppoeUser, password: w.pppoePass || '',
        'add-default-route': 'no', 'use-peer-dns': 'no', disabled: 'no', comment: w.name,
      });
    }
    add('interface list member', { list: 'WAN', interface: w.eff });
  }

  // ---------------------------------------------------------------- bridge, VLANs
  sec('LAN bridge' + (cfg._vlanMode ? ' + VLAN filtering' : ''));
  add('interface bridge', { name: lan.bridge, comment: 'LAN bridge', ...(cfg._vlanMode ? { 'vlan-filtering': 'no' } : {}) });
  const allPorts = [...new Set([...lan.ports, ...vlans.flatMap((v) => [...v.access, ...v.tagged])])];
  for (const port of allPorts) {
    const accessVlan = vlans.find((v) => v.access.includes(port));
    const isTagged = vlans.some((v) => v.tagged.includes(port));
    const native = lan.ports.includes(port);
    let frame = 'admit-only-untagged-and-priority-tagged';
    if (isTagged) frame = (accessVlan || native) ? 'admit-all' : 'admit-only-vlan-tagged';
    add('interface bridge port', {
      bridge: lan.bridge, interface: port,
      ...(cfg._vlanMode ? { pvid: accessVlan ? accessVlan.id : 1, 'frame-types': frame, 'ingress-filtering': 'yes' } : {}),
      comment: accessVlan ? `VLAN ${accessVlan.id} access` : (isTagged ? 'trunk' : 'LAN'),
    });
  }
  add('interface list member', { list: 'LAN', interface: lan.bridge });

  for (const v of vlans) {
    add('interface vlan', { name: v.ifname, interface: lan.bridge, 'vlan-id': v.id, comment: v.name });
    add('interface list member', { list: 'LAN', interface: v.ifname });
    const tagged = [lan.bridge, ...v.tagged].join(',');
    add('interface bridge vlan', { bridge: lan.bridge, 'vlan-ids': v.id, tagged, ...(v.access.length ? { untagged: v.access.join(',') } : {}), comment: v.name });
  }

  // ---------------------------------------------------------------- addressing + DHCP
  sec('IP addressing + DHCP');
  if (lan.c) {
    add('ip address', { address: lan.c.cidr, interface: lan.bridge, comment: 'LAN' });
    if (lan.dhcp) {
      add('ip pool', { name: 'pool-lan', ranges: lan.poolFinal });
      add('ip dhcp-server', { name: 'dhcp-lan', interface: lan.bridge, 'address-pool': 'pool-lan', 'lease-time': lan.leaseTime || '1d', disabled: 'no' });
      add('ip dhcp-server network', { address: lan.c.netCidr, gateway: lan.c.ipStr, 'dns-server': cfg.system.allowRemoteRequests ? lan.c.ipStr : cfg.system.dns.join(',') });
      dhcpServers.push({ name: 'dhcp-lan', c: lan.c });
    }
  }
  for (const v of vlans) {
    add('ip address', { address: v.c.cidr, interface: v.ifname, comment: v.name });
    if (v.dhcp) {
      const pn = `pool-${v.ifname}`; const dn = `dhcp-${v.ifname}`;
      add('ip pool', { name: pn, ranges: v.poolFinal });
      add('ip dhcp-server', { name: dn, interface: v.ifname, 'address-pool': pn, 'lease-time': lan.leaseTime || '1d', disabled: 'no' });
      add('ip dhcp-server network', { address: v.c.netCidr, gateway: v.c.ipStr, 'dns-server': cfg.system.allowRemoteRequests ? v.c.ipStr : cfg.system.dns.join(',') });
      dhcpServers.push({ name: dn, c: v.c });
    }
  }
  for (const l of lan.leases) {
    const srv = dhcpServers.find((s) => ipIn(s.c, l.ip));
    if (!srv) { out.push(`# skipped static lease ${l.ip}: no DHCP server serves that subnet`); continue; }
    add('ip dhcp-server lease', { address: l.ip, 'mac-address': l.mac.toUpperCase(), server: srv.name, comment: l.comment || '' });
  }

  // ---------------------------------------------------------------- WireGuard
  if (wg.enabled) {
    sec('WireGuard (v7)');
    add('interface wireguard', { name: wg.name, 'listen-port': wg.port, comment: 'private key is generated by the router' });
    add('ip address', { address: wg.c.cidr, interface: wg.name });
    add('interface list member', { list: 'LAN', interface: wg.name });
    for (const p of wg.peers) {
      add('interface wireguard peers', { interface: wg.name, 'public-key': p.publicKey, 'allowed-address': p.allowed, comment: p.name || '' });
    }
    raw(`# Show the router's public key with: /interface wireguard print`);
  }

  // ---------------------------------------------------------------- WAN addressing + routing
  sec(`WAN addressing + routing (${mode})`);
  const tbl = (w) => `to_${w.name}`;
  const connMark = (w) => `${w.name}_conn`;
  if (mode === 'pcc' && v7) for (const w of wans) raw(`/routing table add name=${tbl(w)} fib`);

  // route list used by PCC: returns [{table, gw, distance, comment}] for WAN index i given gateway expression
  const pccRoutes = (i, gw) => {
    const w = wans[i];
    const r = [{ table: null, gw, distance: i + 1, comment: `PCC-${w.name}-main` }];
    r.push({ table: tbl(w), gw, distance: 1, comment: `PCC-${w.name}-own` });
    wans.forEach((o, j) => { if (j !== i) r.push({ table: tbl(o), gw, distance: i + 2, comment: `PCC-${w.name}-fb-${o.name}` }); });
    return r;
  };
  // `dyn` = gateway comes from a DHCP lease script variable ($gw) and must not be quoted/escaped here.
  const routeCmd = (r, check, dyn = false) => {
    const line = `/ip route add ${props({
      'dst-address': '0.0.0.0/0', gateway: dyn ? '@@GW@@' : r.gw, distance: r.distance, ...(r.table ? { [RT]: r.table } : {}),
      ...(check ? { 'check-gateway': 'ping' } : {}), comment: r.comment,
    })}`;
    return dyn ? line.replace('@@GW@@', '$gw') : line;
  };

  wans.forEach((w, i) => {
    const dist = mode === 'failover' ? i + 1 : 1;
    if (w.type === 'static') {
      add('ip address', { address: w.c.cidr, interface: w.base, comment: w.name });
    } else if (w.type === 'dhcp') {
      let script;
      if (mode === 'pcc') {
        // DHCP gateway is dynamic: the lease script (re)creates this WAN's routes with the learned gateway.
        const parts = [':if ($bound=1) do={', ':local gw $"gateway-address";', `/ip route remove [find where comment~"^PCC-${w.name}-"];`];
        for (const r of pccRoutes(i, '$gw')) parts.push(routeCmd(r, true, true) + ';');
        parts.push('}');
        script = parts.join(' ');
      }
      add('ip dhcp-client', {
        interface: w.base, 'use-peer-dns': 'no', 'use-peer-ntp': 'no', disabled: 'no', comment: w.name,
        'add-default-route': mode === 'pcc' ? 'no' : 'yes',
        ...(mode !== 'pcc' ? { 'default-route-distance': dist } : {}),
        ...(script ? { script } : {}),
      });
    }
  });

  // static default routes
  if (mode === 'single') {
    wans.forEach((w) => {
      if (w.type === 'static') add('ip route', { 'dst-address': '0.0.0.0/0', gateway: w.gateway, 'check-gateway': 'ping', comment: `default ${w.name}` });
      if (w.type === 'pppoe') set('interface pppoe-client', { numbers: w.eff, 'add-default-route': 'yes' });
    });
  } else if (mode === 'failover' || mode === 'ecmp') {
    const allStatic = wans.every((w) => w.type === 'static');
    if (mode === 'ecmp' && allStatic && wans.some((w) => w.weight !== 1)) {
      const gws = wans.flatMap((w) => Array(w.weight).fill(w.gateway));
      add('ip route', { 'dst-address': '0.0.0.0/0', gateway: gws.join(','), 'check-gateway': 'ping', comment: 'ECMP weighted' });
    } else {
      wans.forEach((w, i) => {
        const d = mode === 'failover' ? i + 1 : 1;
        if (w.type === 'static') add('ip route', { 'dst-address': '0.0.0.0/0', gateway: w.gateway, distance: d, 'check-gateway': 'ping', comment: `${mode} ${w.name}` });
        if (w.type === 'pppoe') set('interface pppoe-client', { numbers: w.eff, 'add-default-route': 'yes', 'default-route-distance': d });
      });
    }
  } else if (mode === 'pcc') {
    wans.forEach((w, i) => {
      if (w.type === 'static') for (const r of pccRoutes(i, w.gateway)) raw(routeCmd(r, true));
      if (w.type === 'pppoe') for (const r of pccRoutes(i, w.eff)) raw(routeCmd(r, false));
    });
  }

  // ---------------------------------------------------------------- firewall address lists
  sec('Address lists');
  for (const n of cfg._nets) add('ip firewall address-list', { list: 'LOCAL_NETS', address: n.c.netCidr, comment: n.label });
  for (const d of cfg.qos.gaming.devices) add('ip firewall address-list', { list: 'GAMING_DEVICES', address: d });
  for (const d of qos.bulkDevices) add('ip firewall address-list', { list: 'BULK_DEVICES', address: d });
  if (fw.dropBogons) for (const b of BOGONS) add('ip firewall address-list', { list: 'BOGONS', address: b });
  if (fw.mgmtFromWan) for (const a of fw.mgmtWhitelist) add('ip firewall address-list', { list: 'MGMT_WAN', address: a });

  // ---------------------------------------------------------------- mangle
  const mangle = (p) => add('ip firewall mangle', p);
  sec('Mangle');
  let anyMangle = false;
  if (mode === 'pcc') {
    anyMangle = true;
    mangle({ chain: 'prerouting', action: 'accept', 'dst-address-list': 'LOCAL_NETS', 'in-interface-list': 'LAN', comment: 'PCC: keep LAN-to-LAN traffic in main table' });
    for (const w of wans) {
      mangle({ chain: 'prerouting', action: 'mark-connection', 'in-interface': w.eff, 'connection-mark': 'no-mark', 'new-connection-mark': connMark(w), passthrough: 'yes', comment: `PCC: replies in via ${w.name}` });
    }
    const total = wans.reduce((a, w) => a + w.weight, 0);
    let slot = 0;
    for (const w of wans) {
      for (let k = 0; k < w.weight; k++) {
        mangle({
          chain: 'prerouting', action: 'mark-connection', 'in-interface-list': 'LAN', 'dst-address-type': '!local', 'connection-mark': 'no-mark',
          'per-connection-classifier': `both-addresses-and-ports:${total}/${slot}`, 'new-connection-mark': connMark(w), passthrough: 'yes', comment: `PCC: new LAN connections -> ${w.name}`,
        });
        slot++;
      }
    }
    for (const w of wans) {
      mangle({ chain: 'prerouting', action: 'mark-routing', 'in-interface-list': 'LAN', 'connection-mark': connMark(w), 'new-routing-mark': tbl(w), passthrough: 'no', comment: `PCC: route ${w.name} connections via ${tbl(w)}` });
    }
    for (const w of wans) {
      mangle({ chain: 'output', action: 'mark-routing', 'connection-mark': connMark(w), 'new-routing-mark': tbl(w), passthrough: 'no', comment: `PCC: router traffic ${w.name}` });
    }
  }
  if (pppoeAny) {
    anyMangle = true;
    for (const w of wans.filter((x) => x.type === 'pppoe')) {
      mangle({ chain: 'forward', action: 'change-mss', protocol: 'tcp', 'tcp-flags': 'syn', 'out-interface': w.eff, 'new-mss': 'clamp-to-pmtu', passthrough: 'yes', comment: `MSS clamp ${w.name}` });
    }
  }

  // QoS classification (forward chain, direct packet marks so it coexists with PCC connection marks)
  const g = qos.gaming;
  const cake = qos.mode === 'cake';
  const gamePorts = { udp: [], tcp: [] };
  if (g.enabled) {
    for (const id of g.presets) { const pr = GAME_PRESETS.find((x) => x.id === id); if (pr?.udp) gamePorts.udp.push(pr.udp); }
    if (g.customUdp) gamePorts.udp.push(g.customUdp.replace(/\s+/g, ''));
    if (g.customTcp) gamePorts.tcp.push(g.customTcp.replace(/\s+/g, ''));
  }
  const classes = []; // {id, prio, share}
  if (qos._marks) {
    anyMangle = true;
    const dirs = [
      { d: 'up', iface: { 'out-interface-list': 'WAN' }, addr: 'src-address-list', port: 'dst-port' },
      { d: 'down', iface: { 'in-interface-list': 'WAN' }, addr: 'dst-address-list', port: 'src-port' },
    ];
    const actionFor = (cls, d) => (cake
      ? { action: 'change-dscp', 'new-dscp': cls === 'bulk' ? 8 : 46, passthrough: 'no' }
      : { action: 'mark-packet', 'new-packet-mark': `${cls}_${d}`, passthrough: 'no' });
    const rule = (cls, dir, match, why) => mangle({ chain: 'forward', ...match, ...dir.iface, ...actionFor(cls, dir.d), comment: `QoS ${cls}: ${why}` });
    for (const dir of dirs) {
      if (g.enabled) {
        if (g.devices.length) rule('gaming', dir, { [dir.addr]: 'GAMING_DEVICES', ...(g.devicesMode === 'all' ? {} : { protocol: 'udp' }) }, 'gaming devices');
        for (const ports of gamePorts.udp.flatMap((x) => chunkPorts(x))) rule('gaming', dir, { protocol: 'udp', [dir.port]: ports }, 'game UDP ports');
        for (const ports of gamePorts.tcp.flatMap((x) => chunkPorts(x))) rule('gaming', dir, { protocol: 'tcp', [dir.port]: ports }, 'game TCP ports');
      }
      if (qos.realtime) {
        for (const ports of chunkPorts(REALTIME_UDP)) rule('realtime', dir, { protocol: 'udp', [dir.port]: ports }, 'DNS/VoIP/video-call UDP');
        rule('realtime', dir, { protocol: 'tcp', [dir.port]: '53' }, 'DNS over TCP');
        rule('realtime', dir, { protocol: 'icmp' }, 'ICMP');
      }
      if (qos.bulkDevices.length) rule('bulk', dir, { [dir.addr]: 'BULK_DEVICES' }, 'bulk devices');
      if (!cake) {
        rule('web', dir, { protocol: 'tcp', [dir.port]: '80,443' }, 'web');
        rule('web', dir, { protocol: 'udp', [dir.port]: '443' }, 'QUIC');
        mangle({ chain: 'forward', ...dir.iface, action: 'mark-packet', 'new-packet-mark': `default_${dir.d}`, passthrough: 'no', comment: 'QoS default class' });
      }
    }
    if (!cake) {
      if (g.enabled) classes.push({ id: 'gaming', prio: 1, share: 0.30 });
      if (qos.realtime) classes.push({ id: 'realtime', prio: 2, share: 0.15 });
      classes.push({ id: 'web', prio: 4, share: 0.25 });
      classes.push({ id: 'default', prio: 6, share: 0.10 });
      if (qos.bulkDevices.length) classes.push({ id: 'bulk', prio: 8, share: 0.05 });
    }
  }
  if (!anyMangle) raw('# (no mangle rules needed)');

  // ---------------------------------------------------------------- NAT
  sec('NAT');
  add('ip firewall nat', { chain: 'srcnat', action: 'masquerade', 'out-interface-list': 'WAN', comment: 'NAT to WAN' });
  if (cfg.system.forceDns) {
    for (const proto of ['udp', 'tcp']) add('ip firewall nat', { chain: 'dstnat', action: 'redirect', protocol: proto, 'dst-port': 53, 'in-interface-list': 'LAN', 'dst-address-type': '!local', 'to-ports': 53, comment: 'Force clients to use router DNS' });
  }
  for (const f of fw.portForwards) {
    for (const proto of f.proto === 'both' ? ['tcp', 'udp'] : [f.proto]) {
      add('ip firewall nat', {
        chain: 'dstnat', action: 'dst-nat', protocol: proto, 'dst-port': f.wanPort.replace(/\s+/g, ''), 'in-interface-list': 'WAN',
        'to-addresses': f.toAddr, ...(f.toPort ? { 'to-ports': f.toPort } : {}), comment: `fwd ${f.name}`,
      });
      if (f.hairpin) {
        add('ip firewall nat', {
          chain: 'srcnat', action: 'masquerade', protocol: proto, 'dst-address': f.toAddr, 'dst-port': (f.toPort || f.wanPort).replace(/\s+/g, ''),
          'src-address-list': 'LOCAL_NETS', 'out-interface-list': 'LAN', comment: `hairpin ${f.name}`,
        });
      }
    }
  }

  // ---------------------------------------------------------------- raw
  if (fw.dropBogons) {
    sec('Raw');
    add('ip firewall raw', { chain: 'prerouting', action: 'drop', 'in-interface-list': 'WAN', 'src-address-list': 'BOGONS', comment: 'drop bogon sources from WAN' });
  }

  // ---------------------------------------------------------------- filter
  sec('Firewall filter');
  const filt = (p) => add('ip firewall filter', p);
  filt({ chain: 'input', action: 'accept', 'connection-state': 'established,related,untracked', comment: 'accept established/related' });
  filt({ chain: 'input', action: 'drop', 'connection-state': 'invalid', comment: 'drop invalid' });
  if (fw.allowPing) filt({ chain: 'input', action: 'accept', protocol: 'icmp', comment: 'accept ICMP' });
  for (const v of vlans.filter((x) => x.isolate)) {
    filt({ chain: 'input', action: 'accept', protocol: 'udp', 'dst-port': '53,67', 'in-interface': v.ifname, comment: `${v.name}: DNS/DHCP only` });
    filt({ chain: 'input', action: 'accept', protocol: 'tcp', 'dst-port': '53', 'in-interface': v.ifname, comment: `${v.name}: DNS/TCP` });
    filt({ chain: 'input', action: 'drop', 'in-interface': v.ifname, comment: `${v.name}: no access to router` });
  }
  filt({ chain: 'input', action: 'accept', 'in-interface-list': 'LAN', comment: 'accept from LAN' });
  if (wg.enabled) filt({ chain: 'input', action: 'accept', protocol: 'udp', 'dst-port': wg.port, 'in-interface-list': 'WAN', comment: 'WireGuard' });
  if (fw.mgmtFromWan) filt({ chain: 'input', action: 'accept', protocol: 'tcp', 'dst-port': '22,8291', 'src-address-list': 'MGMT_WAN', 'in-interface-list': 'WAN', comment: 'management from whitelisted WAN IPs' });
  filt({ chain: 'input', action: 'drop', comment: 'drop everything else' });

  if (fw._fasttrack) filt({ chain: 'forward', action: 'fasttrack-connection', 'connection-state': 'established,related', 'hw-offload': 'yes', comment: 'FastTrack' });
  filt({ chain: 'forward', action: 'accept', 'connection-state': 'established,related,untracked', comment: 'accept established/related' });
  filt({ chain: 'forward', action: 'drop', 'connection-state': 'invalid', comment: 'drop invalid' });
  const mgmtVlan = vlans.find((v) => v.mgmt);
  if (mgmtVlan) filt({ chain: 'forward', action: 'accept', 'in-interface': mgmtVlan.ifname, 'out-interface-list': 'LAN', comment: 'management VLAN may reach all LANs' });
  for (const v of vlans.filter((x) => x.isolate && !x.mgmt)) {
    filt({ chain: 'forward', action: 'drop', 'in-interface': v.ifname, 'out-interface-list': 'LAN', comment: `${v.name}: isolated from other LANs` });
  }
  for (const v of vlans.filter((x) => x.internet === false)) {
    filt({ chain: 'forward', action: 'drop', 'in-interface': v.ifname, 'out-interface-list': 'WAN', comment: `${v.name}: no internet` });
  }
  filt({ chain: 'forward', action: 'drop', 'connection-state': 'new', 'connection-nat-state': '!dstnat', 'in-interface-list': 'WAN', comment: 'drop WAN->LAN unless port-forwarded' });

  // ---------------------------------------------------------------- queues
  if (qos.mode !== 'off' || qos._vlanLimited) sec(`Queues (${qos.mode})`);
  if (qos._vlanLimited) {
    for (const v of vlans) {
      const up = Number(v.limitUp) > 0 ? rate(Number(v.limitUp)) : '0';
      const down = Number(v.limitDown) > 0 ? rate(Number(v.limitDown)) : '0';
      if (up === '0' && down === '0') continue;
      add('queue simple', { name: `limit-${v.ifname}`, target: v.c.netCidr, 'max-limit': `${up}/${down}`, comment: `${v.name} cap (upload/download)` });
    }
  }
  const shaped = wans.filter((w) => Number(w.up) > 0 && Number(w.down) > 0);
  const k = qos.shapePercent / 100;
  if (qos.mode === 'cake' || qos.mode === 'fq-codel') {
    const type = cake ? 'ft-cake' : 'ft-fqcodel';
    if (cake) add('queue type', { name: type, kind: 'cake', 'cake-diffserv': 'diffserv4', 'cake-nat': 'yes' });
    else add('queue type', { name: type, kind: 'fq-codel' });
    for (const w of shaped) add('queue tree', { name: `sqm-up-${w.name}`, parent: w.eff, 'packet-mark': 'no-mark', 'max-limit': rate(w.up * k), queue: type, comment: `${w.name} upload` });
    const downTotal = shaped.reduce((a, w) => a + Number(w.down), 0) * k;
    add('queue tree', { name: 'sqm-down', parent: qos.dlParent, 'packet-mark': 'no-mark', 'max-limit': rate(downTotal), queue: type, comment: 'download (aggregate)' });
  } else if (qos.mode === 'htb') {
    add('queue type', { name: 'ft-pfifo', kind: 'pfifo', 'pfifo-limit': 50 });
    add('queue type', { name: 'ft-pcq-down', kind: 'pcq', 'pcq-classifier': 'dst-address', 'pcq-rate': 0, 'pcq-limit': '50KiB', 'pcq-total-limit': '2000KiB' });
    if (v7) add('queue type', { name: 'ft-fqcodel', kind: 'fq-codel' });
    else add('queue type', { name: 'ft-sfq', kind: 'sfq', 'sfq-perturb': 5, 'sfq-allot': 1514 });
    const upLeaf = v7 ? 'ft-fqcodel' : 'ft-sfq';
    const leafFor = (id, d) => (id === 'gaming' || id === 'realtime' ? 'ft-pfifo' : (d === 'up' ? upLeaf : 'ft-pcq-down'));
    for (const w of shaped) {
      const U = Number(w.up) * k;
      add('queue tree', { name: `up-${w.name}`, parent: w.eff, 'max-limit': rate(U), comment: `${w.name} upload root` });
      for (const c of classes) {
        add('queue tree', { name: `${c.id}-up-${w.name}`, parent: `up-${w.name}`, 'packet-mark': `${c.id}_up`, priority: c.prio, 'limit-at': rate(U * c.share), 'max-limit': rate(U), queue: leafFor(c.id, 'up') });
      }
    }
    const D = shaped.reduce((a, w) => a + Number(w.down), 0) * k;
    add('queue tree', { name: 'down-total', parent: qos.dlParent, 'max-limit': rate(D), comment: 'download root' });
    for (const c of classes) {
      add('queue tree', { name: `${c.id}-down`, parent: 'down-total', 'packet-mark': `${c.id}_down`, priority: c.prio, 'limit-at': rate(D * c.share), 'max-limit': rate(D), queue: leafFor(c.id, 'down') });
    }
  }

  // ---------------------------------------------------------------- hardening (last, so a mistake above cannot lock you out earlier)
  sec('Management hardening');
  if (fw.hardenServices) {
    for (const s of ['telnet', 'ftp', 'www', 'api', 'api-ssl']) raw(`/ip service set ${s} disabled=yes`);
    const allowed = [...cfg._nets.map((n) => n.c.netCidr), ...(fw.mgmtFromWan ? fw.mgmtWhitelist : [])].join(',');
    raw(`/ip service set ssh address=${allowed}`);
    raw(`/ip service set winbox address=${allowed}`);
    raw('/ip ssh set strong-crypto=yes');
    raw('/ip neighbor discovery-settings set discover-interface-list=LAN');
    raw('/tool mac-server set allowed-interface-list=LAN');
    raw('/tool mac-server mac-winbox set allowed-interface-list=LAN');
    raw('/tool bandwidth-server set enabled=no');
  }
  if (cfg._vlanMode) {
    sec('Enable VLAN filtering (last)');
    raw(`/interface bridge set [find where name=${q(lan.bridge)}] vlan-filtering=yes`);
  }
  out.push('');
  return { ok: true, errors: [], warnings, script: out.join('\n'), summary: { wans: wans.length, vlans: vlans.length, mode, qos: qos.mode, lines: out.length } };
}
