// Structural linter for generated RouterOS scripts. It cannot replace testing on a router, but it
// catches the classes of mistakes a generator makes: dangling references, version-specific syntax in the
// wrong version, unbalanced quoting, unresolved placeholders and duplicate names.

const KNOWN_MENUS = [
  'system identity', 'system clock', 'system ntp client', 'ip dns', 'ip dns static', 'ip settings', 'ipv6 settings',
  'interface list', 'interface list member', 'interface vlan', 'interface pppoe-client', 'interface bridge',
  'interface bridge port', 'interface bridge vlan', 'ip address', 'ip pool', 'ip dhcp-server', 'ip dhcp-server network',
  'ip dhcp-server lease', 'interface wireguard', 'interface wireguard peers', 'ip dhcp-client', 'ip route',
  'routing table', 'ip firewall address-list', 'ip firewall mangle', 'ip firewall nat', 'ip firewall raw',
  'ip firewall filter', 'queue simple', 'queue type', 'queue tree', 'ip service', 'ip ssh', 'ip neighbor discovery-settings',
  'tool mac-server', 'tool mac-server mac-winbox', 'tool bandwidth-server',
];
const FLAGS = new Set(['fib']);
const PHYSICAL = /^(ether|sfp|sfp-sfpplus|qsfp|qsfpplus|combo|wlan|lte|wifi)\d+/;
const BUILTIN_QUEUES = new Set(['default', 'default-small', 'ethernet-default', 'wireless-default', 'synchronous-default']);

/** Split "key=value key2="quoted value"" respecting quotes and backslash escapes. */
export function tokenize(str) {
  const toks = []; let cur = ''; let inQ = false; let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (!inQ && c === '[') depth++;
    if (!inQ && c === ']') depth--;
    if (inQ) {
      if (c === '\\') { cur += c + (str[++i] ?? ''); continue; }
      if (c === '"') { inQ = false; cur += c; continue; }
      cur += c; continue;
    }
    if (c === '"') { inQ = true; cur += c; continue; }
    if (c === ' ' && depth === 0) { if (cur) toks.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (inQ || depth !== 0) return null;
  if (cur) toks.push(cur);
  return toks;
}

export function parseScript(script) {
  const cmds = []; const problems = [];
  script.split('\n').forEach((line, idx) => {
    const n = idx + 1;
    if (!line.trim() || line.startsWith('#')) return;
    if (!line.startsWith('/')) { problems.push(`L${n}: line does not start with "/": ${line.slice(0, 60)}`); return; }
    const menu = KNOWN_MENUS.filter((m) => line.startsWith(`/${m} `)).sort((a, b) => b.length - a.length)[0];
    if (!menu) { problems.push(`L${n}: unknown menu: ${line.slice(0, 70)}`); return; }
    const rest = line.slice(menu.length + 2);
    const toks = tokenize(rest);
    if (!toks) { problems.push(`L${n}: unbalanced quote`); return; }
    let verb = null;
    if (['add', 'set', 'remove'].includes(toks[0])) verb = toks.shift();
    const kv = {};
    // `set`/`remove` take a positional item (e.g. `/ip service set telnet disabled=yes`)
    if ((verb === 'set' || verb === null) && toks[0] && !/^[A-Za-z-]+=/.test(toks[0])) kv.numbers = toks.shift();
    for (const t of toks) {
      if (FLAGS.has(t)) { kv[t] = 'yes'; continue; }
      const eq = t.indexOf('=');
      if (eq < 1) { problems.push(`L${n}: token without key=value: ${t}`); continue; }
      const k = t.slice(0, eq); const v = t.slice(eq + 1);
      if (k in kv) problems.push(`L${n}: duplicate property ${k}`);
      kv[k] = v.replace(/^"|"$/g, '');
    }
    cmds.push({ n, menu, verb, kv, line });
  });
  return { cmds, problems };
}

export function lint(script, version) {
  const { cmds, problems } = parseScript(script);
  const v7 = String(version) === '7';
  const P = (m) => problems.push(m);

  if (/undefined|NaN|\[object|null/.test(script.replace(/^#.*$/gm, '').replace(/comment="[^"]*"/g, ''))) P('script contains undefined/NaN/null/[object] text');
  if (/@@GW@@/.test(script)) P('unresolved gateway placeholder');

  const names = (menu) => cmds.filter((c) => c.menu === menu && c.verb === 'add').map((c) => c.kv.name).filter(Boolean);
  for (const menu of ['interface list', 'interface vlan', 'interface bridge', 'queue type', 'queue tree', 'queue simple', 'ip pool', 'ip dhcp-server', 'routing table', 'interface pppoe-client']) {
    const n = names(menu); const dup = n.filter((x, i) => n.indexOf(x) !== i);
    if (dup.length) P(`duplicate ${menu} name(s): ${[...new Set(dup)].join(', ')}`);
  }

  // interfaces that exist
  const ifaces = new Set(['global']);
  const isIface = (x) => ifaces.has(x) || PHYSICAL.test(x || '');
  for (const m of ['interface vlan', 'interface bridge', 'interface pppoe-client', 'interface wireguard']) names(m).forEach((x) => ifaces.add(x));
  for (const c of cmds) if (c.menu === 'interface bridge port' || c.menu === 'ip dhcp-client') ifaces.add(c.kv.interface); // physical ports
  for (const c of cmds) if (c.menu === 'interface vlan') ifaces.add(c.kv.interface);
  for (const c of cmds) {
    if (c.menu === 'ip address' && !isIface(c.kv.interface)) P(`L${c.n}: ip address on unknown interface ${c.kv.interface}`);
    if (c.menu === 'interface list member' && !isIface(c.kv.interface)) P(`L${c.n}: list member of unknown interface ${c.kv.interface}`);
    if (c.menu === 'ip dhcp-server' && c.verb === 'add' && !isIface(c.kv.interface)) P(`L${c.n}: dhcp-server on unknown interface ${c.kv.interface}`);
  }

  // interface lists
  const lists = new Set(names('interface list'));
  const listRefs = (c) => Object.entries(c.kv).filter(([k]) => /interface-list$/.test(k) || k === 'discover-interface-list' || k === 'allowed-interface-list').map(([, v]) => v.replace(/^!/, ''));
  for (const c of cmds) for (const l of listRefs(c)) if (!lists.has(l)) P(`L${c.n}: unknown interface list ${l}`);
  for (const c of cmds) if (c.menu === 'interface list member' && !lists.has(c.kv.list)) P(`L${c.n}: member of unknown list ${c.kv.list}`);

  // address lists defined before used
  const addrLists = new Set(cmds.filter((c) => c.menu === 'ip firewall address-list').map((c) => c.kv.list));
  for (const c of cmds) for (const [k, v] of Object.entries(c.kv)) {
    if (/address-list$/.test(k) && c.menu !== 'ip firewall address-list' && !addrLists.has(v.replace(/^!/, ''))) P(`L${c.n}: ${k} references undefined address list ${v}`);
  }

  // DHCP pools / servers
  const pools = new Set(names('ip pool'));
  for (const c of cmds) if (c.menu === 'ip dhcp-server' && c.verb === 'add' && !pools.has(c.kv['address-pool'])) P(`L${c.n}: unknown pool ${c.kv['address-pool']}`);
  const servers = new Set(names('ip dhcp-server'));
  for (const c of cmds) if (c.menu === 'ip dhcp-server lease' && !servers.has(c.kv.server)) P(`L${c.n}: lease for unknown server ${c.kv.server}`);

  // version-specific routing syntax
  const tables = new Set(names('routing table'));
  const routingText = script.split('\n');
  for (const c of cmds) {
    if (c.menu === 'ip route') {
      if (v7 && 'routing-mark' in c.kv) P(`L${c.n}: v7 route must use routing-table, not routing-mark`);
      if (!v7 && 'routing-table' in c.kv) P(`L${c.n}: v6 route must use routing-mark, not routing-table`);
    }
    if (c.menu === 'ip dhcp-client' && c.kv.script) {
      for (const m of c.kv.script.matchAll(/\/ip route add [^;]*/g)) {
        if (v7 && /routing-mark=/.test(m[0])) P(`L${c.n}: v7 lease script uses routing-mark`);
        if (!v7 && /routing-table=/.test(m[0])) P(`L${c.n}: v6 lease script uses routing-table`);
        const t = /routing-(?:table|mark)=([A-Za-z0-9_-]+)/.exec(m[0]);
        if (t && v7 && !tables.has(t[1])) P(`L${c.n}: lease script uses undefined routing table ${t[1]}`);
      }
    }
    if (c.menu === 'routing table' && !v7) P(`L${c.n}: /routing table does not exist on v6`);
    if (c.menu === 'interface wireguard' && !v7) P(`L${c.n}: WireGuard on v6`);
  }
  if (v7) {
    for (const c of cmds) if (c.menu === 'ip route' && c.kv['routing-table'] && !tables.has(c.kv['routing-table'])) P(`L${c.n}: route uses undefined table ${c.kv['routing-table']}`);
    if (/primary-ntp/.test(script)) P('v7 script uses v6 NTP syntax');
  } else if (/ntp client set .*servers=/.test(script)) P('v6 script uses v7 NTP syntax');
  if (/kind=(cake|fq-codel)/.test(script) && !v7) P('cake/fq-codel emitted for v6');

  // every routing mark set in mangle must be used by a route (and vice-versa)
  const marks = new Set(cmds.filter((c) => c.menu === 'ip firewall mangle' && c.kv.action === 'mark-routing').map((c) => c.kv['new-routing-mark']));
  const routeMarks = new Set([
    ...cmds.filter((c) => c.menu === 'ip route').map((c) => c.kv['routing-table'] || c.kv['routing-mark']),
    ...[...script.matchAll(/routing-(?:table|mark)=([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
  ].filter(Boolean));
  for (const m of marks) if (!routeMarks.has(m)) P(`routing mark ${m} is set in mangle but no route uses it`);
  if (v7) for (const m of marks) if (!tables.has(m)) P(`routing mark ${m} has no /routing table entry`);

  // connection marks consumed must be produced
  const connMade = new Set(cmds.filter((c) => c.kv.action === 'mark-connection').map((c) => c.kv['new-connection-mark']));
  for (const c of cmds) if (c.menu === 'ip firewall mangle' && c.kv['connection-mark'] && c.kv['connection-mark'] !== 'no-mark' && !connMade.has(c.kv['connection-mark'])) P(`L${c.n}: connection-mark ${c.kv['connection-mark']} never created`);

  // QoS references
  const qTypes = new Set([...names('queue type'), ...BUILTIN_QUEUES]);
  const pktMade = new Set(cmds.filter((c) => c.menu === 'ip firewall mangle' && c.kv.action === 'mark-packet').map((c) => c.kv['new-packet-mark']));
  const treeNames = new Set(names('queue tree'));
  for (const c of cmds) {
    if (c.menu === 'queue tree' && c.verb === 'add') {
      if (c.kv.queue && !qTypes.has(c.kv.queue)) P(`L${c.n}: queue tree uses undefined queue type ${c.kv.queue}`);
      if (!isIface(c.kv.parent) && !treeNames.has(c.kv.parent)) P(`L${c.n}: queue tree parent ${c.kv.parent} is neither interface nor queue`);
      const pm = c.kv['packet-mark'];
      if (pm && pm !== 'no-mark' && !pktMade.has(pm)) P(`L${c.n}: packet-mark ${pm} is never set by mangle`);
      if (c.kv['limit-at'] && c.kv['max-limit']) {
        if (toK(c.kv['limit-at']) > toK(c.kv['max-limit'])) P(`L${c.n}: limit-at exceeds max-limit`);
      }
    }
  }
  // sum of children limit-at must not exceed parent max-limit
  for (const parent of cmds.filter((c) => c.menu === 'queue tree' && !c.kv['packet-mark'])) {
    const kids = cmds.filter((c) => c.menu === 'queue tree' && c.kv.parent === parent.kv.name);
    const sum = kids.reduce((a, c) => a + toK(c.kv['limit-at'] || '0'), 0);
    if (kids.length && sum > toK(parent.kv['max-limit'])) P(`queue ${parent.kv.name}: children limit-at (${sum}k) exceeds parent max-limit`);
  }
  for (const c of cmds) if (c.menu === 'queue type' && c.kv.kind === 'pcq' && !c.kv['pcq-classifier']) P(`L${c.n}: pcq without classifier`);
  const usedPkt = new Set(cmds.filter((c) => c.menu === 'queue tree').map((c) => c.kv['packet-mark']).filter(Boolean));
  for (const m of pktMade) if (!usedPkt.has(m)) P(`packet-mark ${m} is set but no queue uses it`);

  // PCC classifier slots
  const pcc = cmds.filter((c) => c.kv['per-connection-classifier']);
  if (pcc.length) {
    const denoms = new Set(pcc.map((c) => c.kv['per-connection-classifier'].split(':')[1].split('/')[0]));
    if (denoms.size !== 1) P('PCC rules use different denominators');
    const d = Number([...denoms][0]);
    const slots = pcc.map((c) => Number(c.kv['per-connection-classifier'].split('/')[1])).sort((a, b) => a - b);
    if (slots.length !== d || slots.some((s, i) => s !== i)) P(`PCC remainders must be exactly 0..${d - 1}, got ${slots.join(',')}`);
  }

  // bridge VLAN sanity
  const vlanIds = cmds.filter((c) => c.menu === 'interface vlan' && c.kv.interface && cmds.some((b) => b.menu === 'interface bridge' && b.kv.name === c.kv.interface)).map((c) => c.kv['vlan-id']);
  const bvIds = cmds.filter((c) => c.menu === 'interface bridge vlan').map((c) => c.kv['vlan-ids']);
  for (const id of vlanIds) if (!bvIds.includes(id)) P(`VLAN ${id} interface has no /interface bridge vlan entry`);
  for (const c of cmds.filter((x) => x.menu === 'interface bridge vlan')) if (!c.kv.tagged?.split(',').includes(c.kv.bridge)) P(`L${c.n}: bridge vlan entry must tag the bridge itself`);
  const filteringOn = /vlan-filtering=yes/.test(script);
  if (cmds.some((c) => c.menu === 'interface bridge' && c.kv['vlan-filtering'] === 'no') && !filteringOn) P('VLAN mode but vlan-filtering is never enabled');
  const lines = script.trim().split('\n');
  if (filteringOn && !/vlan-filtering=yes/.test(lines[lines.length - 1])) P('vlan-filtering=yes must be the last command');

  // overlapping IPs on interfaces are caught in normalize; ensure each LAN iface gets an address
  for (const c of cmds.filter((x) => x.menu === 'ip dhcp-server' && x.verb === 'add')) {
    if (!cmds.some((a) => a.menu === 'ip address' && a.kv.interface === c.kv.interface)) P(`L${c.n}: dhcp-server on ${c.kv.interface} which has no IP address`);
  }
  // filter sanity: final input drop exists and comes after the LAN accept
  const inputRules = cmds.filter((c) => c.menu === 'ip firewall filter' && c.kv.chain === 'input');
  const lanAccept = inputRules.findIndex((c) => c.kv.action === 'accept' && c.kv['in-interface-list'] === 'LAN');
  const finalDrop = inputRules.findIndex((c) => c.kv.action === 'drop' && !c.kv['in-interface'] && !c.kv['connection-state'] && !c.kv['in-interface-list']);
  if (lanAccept < 0 || finalDrop < 0 || finalDrop < lanAccept) P('input chain must accept LAN then drop the rest');
  if (!(/chain=forward action=drop connection-state=new connection-nat-state=!dstnat/.test(script))) P('missing WAN->LAN default deny');
  return problems;
}

function toK(s) {
  const m = /^(\d+(?:\.\d+)?)([kMG]?)$/.exec(String(s));
  if (!m) return NaN;
  return Number(m[1]) * ({ '': 0.001, k: 1, M: 1000, G: 1e6 }[m[2]]);
}
