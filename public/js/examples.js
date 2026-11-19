// Reusable input configs for tests, the golden-file snapshots in /configs and the UI "Load example" menu.
const base = () => ({
  system: { identity: 'forge', timezone: 'UTC', ntp: ['162.159.200.1', '162.159.200.123'], dns: ['1.1.1.1', '9.9.9.9'], allowRemoteRequests: true, staticDns: [] },
  lan: { bridge: 'bridge', ports: ['ether2', 'ether3', 'ether4', 'ether5'], address: '192.168.88.1/24', dhcp: true, pool: '', leaseTime: '1d', leases: [] },
});

const dhcpWan = (name, iface, extra = {}) => ({ name, iface, type: 'dhcp', ...extra });
const staticWan = (name, iface, address, gateway, extra = {}) => ({ name, iface, type: 'static', address, gateway, ...extra });

export const SCENARIOS = {
  simple: () => ({ ...base(), wans: [dhcpWan('WAN1', 'ether1')], multiwan: { mode: 'single' } }),

  staticSingle: () => ({ ...base(), wans: [staticWan('WAN1', 'ether1', '203.0.113.2/30', '203.0.113.1')], multiwan: { mode: 'single' } }),

  pppoeVlan: () => ({
    ...base(),
    wans: [{ name: 'WAN1', iface: 'ether1', type: 'pppoe', pppoeUser: 'user@isp', pppoePass: 'p@ss "word" $1', vlanId: 100 }],
    multiwan: { mode: 'single' },
  }),

  failoverStatic: () => ({
    ...base(),
    wans: [staticWan('WAN1', 'ether1', '203.0.113.2/30', '203.0.113.1'), staticWan('WAN2', 'ether6', '198.51.100.2/30', '198.51.100.1')],
    multiwan: { mode: 'failover' },
  }),

  failoverDhcp: () => ({
    ...base(),
    lan: { ...base().lan, ports: ['ether3', 'ether4', 'ether5'] },
    wans: [dhcpWan('WAN1', 'ether1'), dhcpWan('WAN2', 'ether2')],
    multiwan: { mode: 'failover' },
  }),

  ecmpWeighted: () => ({
    ...base(),
    wans: [staticWan('WAN1', 'ether1', '203.0.113.2/30', '203.0.113.1', { weight: 2 }), staticWan('WAN2', 'ether6', '198.51.100.2/30', '198.51.100.1')],
    multiwan: { mode: 'ecmp' },
  }),

  pccDual: () => ({
    ...base(),
    wans: [staticWan('WAN1', 'ether1', '203.0.113.2/30', '203.0.113.1'), staticWan('WAN2', 'ether6', '198.51.100.2/30', '198.51.100.1')],
    multiwan: { mode: 'pcc' },
  }),

  pccMixedThree: () => ({
    ...base(),
    wans: [dhcpWan('WAN1', 'ether1', { weight: 2 }), staticWan('WAN2', 'ether6', '198.51.100.2/30', '198.51.100.1'),
      { name: 'WAN3', iface: 'ether7', type: 'pppoe', pppoeUser: 'u', pppoePass: 'p' }],
    multiwan: { mode: 'pcc' },
  }),

  vlans: () => ({
    ...base(),
    lan: { bridge: 'bridge', ports: [], address: '', dhcp: false, leases: [] },
    wans: [dhcpWan('WAN1', 'ether1')],
    multiwan: { mode: 'single' },
    vlans: [
      { id: 10, name: 'trusted', subnet: '192.168.10.1/24', access: 'ether3', tagged: 'ether5' },
      { id: 30, name: 'guest', subnet: '192.168.30.1/24', access: 'ether4', tagged: 'ether5', isolate: true, limitUp: 5, limitDown: 20 },
      { id: 40, name: 'iot', subnet: '192.168.40.1/24', tagged: 'ether5', isolate: true, internet: false },
      { id: 99, name: 'mgmt', subnet: '192.168.99.1/24', access: 'ether2', tagged: 'ether5', mgmt: true },
    ],
  }),

  vlansMixedNative: () => ({
    ...base(),
    wans: [dhcpWan('WAN1', 'ether1')],
    multiwan: { mode: 'single' },
    lan: { ...base().lan, ports: ['ether2', 'ether3'] },
    vlans: [{ id: 20, name: 'cams', subnet: '10.20.0.1/24', access: 'ether4', tagged: 'ether2' }],
  }),

  gamingHtb: () => ({
    ...base(),
    wans: [dhcpWan('WAN1', 'ether1', { down: 500, up: 50 })],
    multiwan: { mode: 'single' },
    qos: { mode: 'htb', shapePercent: 95, realtime: true, bulkDevices: ['192.168.88.200'], gaming: { enabled: true, devices: ['192.168.88.20', '192.168.88.21'], presets: ['valorant', 'cod'], customUdp: '3659', customTcp: '', devicesMode: 'udp' } },
  }),

  gamingCake: () => ({
    ...base(),
    wans: [dhcpWan('WAN1', 'ether1', { down: 300, up: 30 })],
    multiwan: { mode: 'single' },
    qos: { mode: 'cake', shapePercent: 95, realtime: true, bulkDevices: [], gaming: { enabled: true, devices: ['192.168.88.20'], presets: ['lol', 'steam'], customUdp: '', customTcp: '', devicesMode: 'udp' } },
  }),

  dualWanGamingVlans: () => ({
    ...base(),
    lan: { bridge: 'bridge', ports: ['ether2'], address: '192.168.88.1/24', dhcp: true, leases: [{ mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.88.20', comment: 'PC' }] },
    wans: [staticWan('Fiber', 'ether1', '203.0.113.2/30', '203.0.113.1', { down: 500, up: 500, weight: 3 }), dhcpWan('LTE', 'ether6', { down: 80, up: 20 })],
    multiwan: { mode: 'pcc' },
    vlans: [
      { id: 10, name: 'work', subnet: '192.168.10.1/24', access: 'ether3', tagged: 'ether5', limitDown: 200 },
      { id: 30, name: 'guest', subnet: '192.168.30.1/24', access: 'ether4', isolate: true, limitUp: 10, limitDown: 50 },
    ],
    qos: { mode: 'htb', gaming: { enabled: true, devices: ['192.168.88.20'], presets: ['valorant'] }, realtime: true },
    firewall: { portForwards: [{ name: 'nas', proto: 'both', wanPort: '51000', toAddr: '192.168.88.20', toPort: '', hairpin: false }] },
    system: { ...base().system, forceDns: true },
  }),

  portForward: () => ({
    ...base(),
    wans: [dhcpWan('WAN1', 'ether1')],
    multiwan: { mode: 'single' },
    firewall: { portForwards: [
      { name: 'web', proto: 'tcp', wanPort: '8080', toAddr: '192.168.88.50', toPort: '80', hairpin: true },
      { name: 'wg-nas', proto: 'udp', wanPort: '51000', toAddr: '192.168.88.50', toPort: '', hairpin: false },
    ] },
  }),

  wireguard: () => ({
    ...base(),
    wans: [dhcpWan('WAN1', 'ether1')],
    multiwan: { mode: 'single' },
    wireguard: { enabled: true, name: 'wg0', port: 51820, address: '10.99.0.1/24', peers: [{ name: 'phone', publicKey: 'A'.repeat(43) + '=', allowed: '10.99.0.2/32' }] },
  }),

  everything: () => ({
    ...SCENARIOS.dualWanGamingVlans(),
    wireguard: { enabled: true, name: 'wg0', port: 51820, address: '10.99.0.1/24', peers: [] },
    system: { identity: 'edge', timezone: 'Asia/Shanghai', ntp: ['162.159.200.1'], dns: ['1.1.1.1'], allowRemoteRequests: true, forceDns: true, disableIpv6: true, staticDns: [{ name: 'nas.lan', address: '192.168.88.20' }] },
    firewall: { fasttrack: true, allowPing: true, dropBogons: true, hardenServices: true, mgmtFromWan: true, mgmtWhitelist: '198.51.100.7', portForwards: [] },
  }),
};

export const EXAMPLE_LABELS = {
  simple: 'Basic home router (DHCP WAN)',
  staticSingle: 'Single static-IP WAN',
  pppoeVlan: 'PPPoE over ISP VLAN (e.g. FTTH VLAN 100)',
  failoverStatic: 'Dual WAN failover (static gateways, ping check)',
  failoverDhcp: 'Dual WAN failover (DHCP, by distance)',
  ecmpWeighted: 'Dual WAN ECMP 2:1 weighted',
  pccDual: 'Dual WAN load balancing (PCC)',
  pccMixedThree: 'Triple WAN PCC (DHCP + static + PPPoE)',
  vlans: 'VLANs: trusted / guest / IoT / management',
  vlansMixedNative: 'Native LAN + camera VLAN',
  gamingHtb: 'Gaming priority (HTB queue tree)',
  gamingCake: 'Gaming + bufferbloat fix (CAKE, v7)',
  dualWanGamingVlans: 'Dual WAN PCC + VLANs + gaming QoS',
  portForward: 'Port forwards with hairpin NAT',
  wireguard: 'WireGuard road-warrior VPN (v7)',
  everything: 'Everything enabled',
};
