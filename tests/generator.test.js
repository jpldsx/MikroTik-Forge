import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, normalize } from '../public/js/generator.js';
import { lint } from './lint.js';
import { parseCidr, defaultPool, validPorts, chunkPorts, q, rate } from '../public/js/net.js';
import { SCENARIOS } from '../public/js/examples.js';

// ---------- helpers ----------
test('net: cidr, pool, ports, quoting, rates', () => {
  const c = parseCidr('192.168.88.1/24');
  assert.equal(c.netCidr, '192.168.88.0/24');
  assert.equal(defaultPool(c), '192.168.88.10-192.168.88.254');
  assert.equal(defaultPool(parseCidr('10.0.0.254/24')), '10.0.0.10-10.0.0.253'); // gateway at the top
  assert.equal(parseCidr('10.0.0.1/33'), null);
  assert.equal(parseCidr('300.0.0.1/24'), null);
  assert.ok(validPorts('80,443,7000-8000'));
  assert.ok(!validPorts('0,80'));
  assert.ok(!validPorts('70000'));
  assert.ok(!validPorts('9000-8000'));
  assert.equal(chunkPorts('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16').length, 2);
  assert.equal(q('plain-text_1'), 'plain-text_1');
  assert.equal(q('has space'), '"has space"');
  assert.equal(q('a"b$c'), '"a\\"b\\$c"');
  assert.equal(rate(25), '25M');
  assert.equal(rate(0.5), '500k');
});

// ---------- every scenario x both versions must be valid and lint-clean ----------
for (const [name, build] of Object.entries(SCENARIOS)) {
  for (const version of ['6', '7']) {
    test(`scenario "${name}" on v${version}: generates and lints clean`, () => {
      const r = generate({ ...build(), version });
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      const problems = lint(r.script, version);
      assert.deepEqual(problems, [], `\n${problems.join('\n')}\n---\n${r.script}`);
      // determinism: same input -> same output
      assert.equal(generate({ ...build(), version }).script, r.script);
    });
  }
}

// ---------- version differences ----------
test('v6 vs v7: routing syntax, NTP, tables', () => {
  const s = SCENARIOS.pccDual();
  const v6 = generate({ ...s, version: '6' }).script;
  const v7 = generate({ ...s, version: '7' }).script;
  assert.ok(!/\/routing table/.test(v6));
  assert.ok(/\/routing table add name=to_WAN1 fib/.test(v7));
  assert.match(v6, /ip route add [^\n]*routing-mark=to_WAN2/);
  assert.match(v7, /ip route add [^\n]*routing-table=to_WAN2/);
  assert.match(v6, /primary-ntp=162\.159\.200\.1/);
  assert.match(v7, /ntp client set enabled=yes servers=/);
  // mangle keeps new-routing-mark on both
  assert.match(v6, /new-routing-mark=to_WAN1/);
  assert.match(v7, /new-routing-mark=to_WAN1/);
});

test('v6 downgrades cake/fq-codel to HTB and skips WireGuard with warnings', () => {
  const s = { ...SCENARIOS.gamingCake(), wireguard: { enabled: true, name: 'wg0', port: 51820, address: '10.99.0.1/24', peers: [] } };
  const r = generate({ ...s, version: '6' });
  assert.ok(r.ok);
  assert.ok(!/kind=cake|kind=fq-codel/.test(r.script));
  assert.ok(/kind=sfq/.test(r.script));
  assert.ok(!/interface wireguard/.test(r.script));
  assert.ok(r.warnings.some((w) => /falling back/.test(w)));
  assert.ok(r.warnings.some((w) => /WireGuard/.test(w)));
});

// ---------- multi-WAN semantics ----------
test('PCC: weighted classifier covers 0..N-1 and each WAN gets its weight', () => {
  const s = SCENARIOS.pccDual();
  s.wans[0].weight = 3; s.wans[1].weight = 1;
  const { script } = generate({ ...s, version: '7' });
  const slots = [...script.matchAll(/both-addresses-and-ports:4\/(\d) new-connection-mark=(\w+)/g)];
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map((m) => Number(m[1])), [0, 1, 2, 3]);
  assert.equal(slots.filter((m) => m[2] === 'WAN1_conn').length, 3);
  assert.equal(slots.filter((m) => m[2] === 'WAN2_conn').length, 1);
});

test('PCC: LAN-to-LAN accept comes before any marking, replies are marked per ingress WAN', () => {
  const { script } = generate({ ...SCENARIOS.pccDual(), version: '7' });
  const lines = script.split('\n').filter((l) => l.startsWith('/ip firewall mangle'));
  assert.match(lines[0], /action=accept dst-address-list=LOCAL_NETS/);
  assert.ok(lines.some((l) => /in-interface=ether1 .*new-connection-mark=WAN1_conn/.test(l)));
});

test('PCC: every WAN has a fallback route in every other WAN table (distance > own)', () => {
  const { script } = generate({ ...SCENARIOS.pccDual(), version: '7' });
  assert.match(script, /gateway=198\.51\.100\.1 distance=3 routing-table=to_WAN1/);
  assert.match(script, /gateway=203\.0\.113\.1 distance=1 routing-table=to_WAN1/);
});

test('failover: increasing distance + ping check; ECMP: equal distance', () => {
  const f = generate({ ...SCENARIOS.failoverStatic(), version: '7' }).script;
  assert.match(f, /gateway=203\.0\.113\.1 distance=1 check-gateway=ping/);
  assert.match(f, /gateway=198\.51\.100\.1 distance=2 check-gateway=ping/);
  const e = generate({ ...SCENARIOS.ecmpWeighted(), version: '6' }).script;
  assert.match(e, /gateway=203\.0\.113\.1,203\.0\.113\.1,198\.51\.100\.1 check-gateway=ping/);
});

test('DHCP WAN in failover uses default-route-distance, not static routes', () => {
  const { script } = generate({ ...SCENARIOS.failoverDhcp(), version: '7' });
  assert.match(script, /dhcp-client add interface=ether1 [^\n]*add-default-route=yes default-route-distance=1/);
  assert.match(script, /dhcp-client add interface=ether2 [^\n]*add-default-route=yes default-route-distance=2/);
});

test('PPPoE over ISP VLAN: vlan iface, pppoe on vlan, WAN list uses pppoe iface, MSS clamp', () => {
  const { script } = generate({ ...SCENARIOS.pppoeVlan(), version: '7' });
  assert.match(script, /interface vlan add name=ether1-vlan100 interface=ether1 vlan-id=100/);
  assert.match(script, /pppoe-client add name=pppoe-WAN1 interface=ether1-vlan100/);
  assert.match(script, /interface list member add list=WAN interface=pppoe-WAN1/);
  assert.match(script, /change-mss [^\n]*out-interface=pppoe-WAN1|out-interface=pppoe-WAN1[^\n]*change-mss/);
  assert.match(script, /masquerade out-interface-list=WAN/);
});

// ---------- VLANs ----------
test('VLANs: tagged bridge, trunk ports admit only tagged, isolation + no-internet, filtering last', () => {
  const { script } = generate({ ...SCENARIOS.vlans(), version: '7' });
  assert.match(script, /interface bridge vlan add bridge=bridge vlan-ids=10 tagged=bridge,ether5 untagged=ether3/);
  assert.match(script, /bridge port add bridge=bridge interface=ether5 pvid=1 frame-types=admit-only-vlan-tagged/);
  assert.match(script, /bridge port add bridge=bridge interface=ether3 pvid=10/);
  assert.match(script, /chain=forward action=drop in-interface=vlan40-iot out-interface-list=WAN/); // internet=false
});

test('VLAN isolation rules: guest blocked from LAN and router, management VLAN allowed everywhere', () => {
  const { script } = generate({ ...SCENARIOS.vlans(), version: '7' });
  assert.match(script, /chain=forward action=accept in-interface=vlan99-mgmt out-interface-list=LAN/);
  assert.match(script, /chain=forward action=drop in-interface=vlan30-guest out-interface-list=LAN/);
  assert.match(script, /chain=input action=drop in-interface=vlan30-guest/);
  const idxMgmt = script.indexOf('in-interface=vlan99-mgmt out-interface-list=LAN');
  const idxGuest = script.indexOf('chain=forward action=drop in-interface=vlan30-guest');
  assert.ok(idxMgmt < idxGuest, 'mgmt accept must precede isolation drops');
  assert.ok(script.trim().endsWith('vlan-filtering=yes'));
});

test('VLAN per-VLAN limits become simple queues with upload/download order', () => {
  const { script } = generate({ ...SCENARIOS.vlans(), version: '7' });
  assert.match(script, /queue simple add name=limit-vlan30-guest target=192\.168\.30\.0\/24 max-limit=5M\/20M/);
});

// ---------- QoS / gaming ----------
test('HTB gaming: marks per direction, priority 1 for gaming, limit-at sums under parent', () => {
  const { script } = generate({ ...SCENARIOS.gamingHtb(), version: '7' });
  assert.match(script, /new-packet-mark=gaming_up/);
  assert.match(script, /new-packet-mark=gaming_down/);
  assert.match(script, /name=gaming-up-WAN1 [^\n]*priority=1/);
  assert.match(script, /dst-port=7000-8000,8180-8181/); // valorant (upload: remote game port)
  assert.match(script, /src-port=7000-8000,8180-8181/); // download direction uses src-port
  assert.match(script, /src-address-list=GAMING_DEVICES/);
  assert.match(script, /dst-address-list=GAMING_DEVICES/);
  // shaped to 95%
  assert.match(script, /name=up-WAN1 [^\n]*max-limit=47\.5M|name=up-WAN1 [^\n]*max-limit=47500k/);
  assert.ok(!/fasttrack-connection/.test(script));
});

test('CAKE gaming: DSCP EF marks (no packet marks), cake queue on WAN + LAN with no-mark', () => {
  const { script } = generate({ ...SCENARIOS.gamingCake(), version: '7' });
  assert.match(script, /queue type add name=ft-cake kind=cake/);
  assert.match(script, /action=change-dscp new-dscp=46/);
  assert.ok(!/new-packet-mark/.test(script));
  assert.match(script, /queue tree add name=sqm-up-WAN1 parent=ether1 packet-mark=no-mark/);
  assert.match(script, /queue tree add name=sqm-down parent=bridge packet-mark=no-mark/);
});

test('SQM without marks keeps FastTrack (interface-parent queue tree shapes fast-tracked traffic)', () => {
  const s = SCENARIOS.simple(); s.qos = { mode: 'fq-codel', realtime: false, gaming: { enabled: false } }; s.wans[0].up = 20; s.wans[0].down = 100;
  const r = generate({ ...s, version: '7' });
  assert.match(r.script, /fasttrack-connection/);
  assert.match(r.script, /kind=fq-codel/);
});

test('gaming port presets are chunked to <=15 list entries per rule', () => {
  const s = SCENARIOS.gamingHtb();
  s.qos.gaming.presets = ['valorant', 'cod', 'lol', 'steam', 'fortnite', 'xbox', 'psn'];
  const { script } = generate({ ...s, version: '7' });
  for (const l of script.split('\n')) {
    const m = /dst-port=([\d,-]+)/.exec(l);
    if (m) assert.ok(m[1].split(',').length <= 15, l);
  }
});

// ---------- firewall / misc ----------
test('FastTrack: on for plain setups, disabled (with warning) for PCC', () => {
  const plain = generate({ ...SCENARIOS.simple(), version: '7' });
  assert.match(plain.script, /action=fasttrack-connection/);
  const pcc = generate({ ...SCENARIOS.pccDual(), version: '7' });
  assert.ok(!/fasttrack-connection/.test(pcc.script));
  assert.ok(pcc.warnings.some((w) => /FastTrack/.test(w)));
});

test('port forwards: dstnat + optional hairpin, both-protocol expands', () => {
  const { script } = generate({ ...SCENARIOS.portForward(), version: '7' });
  assert.match(script, /nat add chain=dstnat action=dst-nat protocol=tcp dst-port=8080 in-interface-list=WAN to-addresses=192\.168\.88\.50 to-ports=80/);
  assert.match(script, /dst-nat protocol=udp dst-port=51000/);
  assert.match(script, /srcnat action=masquerade protocol=tcp dst-address=192\.168\.88\.50 dst-port=80 src-address-list=LOCAL_NETS out-interface-list=LAN/);
});

test('WireGuard (v7): interface, address, LAN membership, firewall rule, peers', () => {
  const { script } = generate({ ...SCENARIOS.wireguard(), version: '7' });
  assert.match(script, /interface wireguard add name=wg0 listen-port=51820/);
  assert.match(script, /interface wireguard peers add interface=wg0 public-key=/);
  assert.match(script, /input action=accept protocol=udp dst-port=51820 in-interface-list=WAN/);
});

test('service hardening restricts to configured subnets and optional WAN whitelist', () => {
  const s = SCENARIOS.simple(); s.firewall = { mgmtFromWan: true, mgmtWhitelist: '198.51.100.7, 203.0.113.0/28' };
  const { script } = generate({ ...s, version: '7' });
  assert.match(script, /ip service set winbox address=192\.168\.88\.0\/24,198\.51\.100\.7,203\.0\.113\.0\/28/);
  assert.match(script, /src-address-list=MGMT_WAN in-interface-list=WAN/);
});

test('script is one command per line and never contains raw control characters', () => {
  for (const [name, build] of Object.entries(SCENARIOS)) {
    const { script } = generate({ ...build(), version: '7' });
    assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(script), name);
  }
});

// ---------- validation ----------
test('validation rejects bad input with actionable errors', () => {
  const bad = (patch, re) => {
    const r = generate({ ...SCENARIOS.simple(), ...patch });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => re.test(`${e.path} ${e.msg}`)), JSON.stringify(r.errors));
  };
  bad({ lan: { address: '192.168.88.1/33', ports: ['ether2'] } }, /lan\.address/);
  bad({ version: '8' }, /version/);
  bad({ wans: [{ name: 'WAN1', iface: 'ether1', type: 'static', address: 'x', gateway: 'y' }] }, /wans\[0\]\.address/);
  bad({ wans: [{ name: 'A', iface: 'ether2', type: 'dhcp' }] }, /both a WAN and a LAN/); // ether2 is a LAN port in simple()
  bad({ vlans: [{ id: 1, name: 'x', subnet: '10.1.1.1/24' }] }, /VLAN ID/);
  bad({ vlans: [{ id: 10, name: 'x', subnet: '192.168.88.1/24' }] }, /overlaps/);
  bad({ vlans: [{ id: 10, name: 'a', subnet: '10.1.1.1/24' }, { id: 10, name: 'b', subnet: '10.1.2.1/24' }] }, /Duplicate VLAN/);
  bad({ vlans: [{ id: 10, name: 'a', subnet: '10.1.1.1/24', access: 'ether3' }, { id: 20, name: 'b', subnet: '10.1.2.1/24', access: 'ether3' }] }, /already an untagged port/);
});

test('validation: multi-WAN mode required when >1 WAN; QoS needs speeds; WAN mgmt needs whitelist', () => {
  const two = SCENARIOS.pccDual(); two.multiwan = { mode: 'single' };
  assert.equal(generate({ ...two, version: '7' }).ok, false);
  const q0 = SCENARIOS.simple(); q0.qos = { mode: 'htb' };
  assert.ok(generate({ ...q0, version: '7' }).errors.some((e) => /speeds/.test(e.msg)));
  const m0 = SCENARIOS.simple(); m0.firewall = { mgmtFromWan: true, mgmtWhitelist: '' };
  assert.ok(generate({ ...m0, version: '7' }).errors.some((e) => /whitelist/.test(e.msg)));
  const dup = SCENARIOS.pccDual(); dup.wans[1].iface = 'ether1';
  assert.ok(generate({ ...dup, version: '7' }).errors.some((e) => /used twice/.test(e.msg)));
});

test('injection safety: hostile strings cannot add commands or break quoting', () => {
  const s = SCENARIOS.simple();
  s.system = { identity: 'evil"; /system reset-configuration', timezone: 'UTC', ntp: [], dns: ['1.1.1.1'], staticDns: [] };
  s.firewall = { portForwards: [{ name: 'x"\n/system reboot', proto: 'tcp', wanPort: '80', toAddr: '192.168.88.5', toPort: '' }] };
  s.lan = { ...s.lan, leases: [{ mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.88.9', comment: 'hi"\n/system reboot $(x)' }] };
  const r = generate({ ...s, version: '7' });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.ok(!/^\/system (reboot|reset)/m.test(r.script));
  assert.deepEqual(lint(r.script, '7'), []);
});

test('no shared state: defaults and caller input are never mutated; interleaved calls are independent', async () => {
  const { DEFAULT_CONFIG } = await import('../public/js/presets.js');
  const snap = JSON.stringify(DEFAULT_CONFIG);
  const inputs = Object.values(SCENARIOS).map((b) => b());
  const frozen = inputs.map((i) => JSON.stringify(i));
  const first = inputs.map((i) => generate({ ...i, version: '7' }).script);
  // run in reverse order, then again forwards: output must not depend on call history
  const rev = [...inputs].reverse().map((i) => generate({ ...i, version: '7' }).script).reverse();
  const again = inputs.map((i) => generate({ ...i, version: '7' }).script);
  assert.deepEqual(rev, first);
  assert.deepEqual(again, first);
  assert.equal(JSON.stringify(DEFAULT_CONFIG), snap, 'DEFAULT_CONFIG was mutated');
  inputs.forEach((i, k) => assert.equal(JSON.stringify(i), frozen[k], `input ${k} was mutated`));
});

test('string/array coercion: list fields accept comma/space separated strings or arrays', () => {
  const s = SCENARIOS.simple();
  s.qos = { mode: 'htb', gaming: { enabled: true, devices: '192.168.88.20, 192.168.88.21', presets: 'valorant' } };
  s.wans[0].up = 20; s.wans[0].down = 100;
  const a = generate({ ...s, version: '7' }).script;
  s.qos.gaming.devices = ['192.168.88.20', '192.168.88.21']; s.qos.gaming.presets = ['valorant'];
  assert.equal(generate({ ...s, version: '7' }).script, a);
});
