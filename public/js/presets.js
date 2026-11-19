// Game port presets. `source` records how well the numbers are backed:
//  official  = taken from the publisher's own support page during development
//  community = widely published by the community/older docs; verify against the publisher before relying on it
export const GAME_PRESETS = [
  {
    id: 'valorant', name: 'VALORANT', source: 'official',
    url: 'https://support.riotgames.com/en-us/valorant/support-tools/how-to-set-up-port-forwarding',
    udp: '7000-8000,8180-8181',
  },
  {
    id: 'cod', name: 'Call of Duty / Warzone', source: 'official',
    url: 'https://support.activision.com/uk/en/articles/ports-used-for-call-of-duty-games',
    udp: '3074,3478,4379-4380,27000-27031,27036',
  },
  {
    id: 'lol', name: 'League of Legends', source: 'community',
    url: 'https://support.riotgames.com/riot/connectivity/set-up-port-forwarding',
    udp: '5000-5500',
  },
  {
    id: 'steam', name: 'Steam / Source games (CS2, Dota 2)', source: 'community',
    url: 'https://help.steampowered.com/en/faqs/view/2EA8-4D75-DA21-31EB',
    udp: '27015-27050,4380',
  },
  {
    id: 'fortnite', name: 'Fortnite', source: 'community',
    url: 'https://www.epicgames.com/help/en-US/epic-games-store-c-202300000001639/launcher-support-c-202300000001735/how-to-unblock-ports-to-connect-to-the-epic-games-launcher-and-fortnite-a202300000017735',
    udp: '9000-9100',
  },
  {
    id: 'xbox', name: 'Xbox Live', source: 'official',
    url: 'https://support.activision.com/uk/en/articles/ports-used-for-call-of-duty-games',
    udp: '88,500,3074,3544,4500',
  },
  {
    id: 'psn', name: 'PlayStation Network', source: 'official',
    url: 'https://support.activision.com/uk/en/articles/ports-used-for-call-of-duty-games',
    udp: '3074,3478-3479',
  },
];

export const DEFAULT_CONFIG = {
  version: '7',
  system: {
    identity: 'MikroTik',
    timezone: 'UTC',
    ntp: ['162.159.200.1', '162.159.200.123'],
    dns: ['1.1.1.1', '9.9.9.9'],
    allowRemoteRequests: true,
    forceDns: false,
    disableIpv6: false,
    staticDns: [],
  },
  lan: {
    bridge: 'bridge',
    ports: ['ether2', 'ether3', 'ether4', 'ether5'],
    address: '192.168.88.1/24',
    dhcp: true,
    pool: '',
    leaseTime: '1d',
    leases: [],
  },
  vlans: [],
  wans: [
    { name: 'WAN1', iface: 'ether1', type: 'dhcp', address: '', gateway: '', pppoeUser: '', pppoePass: '', vlanId: '', weight: 1, down: '', up: '' },
  ],
  multiwan: { mode: 'single' },
  firewall: {
    fasttrack: true,
    allowPing: true,
    dropBogons: true,
    hardenServices: true,
    mgmtFromWan: false,
    mgmtWhitelist: '',
    portForwards: [],
  },
  qos: {
    mode: 'off', // off | htb | cake | fq-codel
    shapePercent: 95,
    dlParent: 'bridge',
    vlanLimits: true,
    gaming: { enabled: false, devices: [], presets: [], customUdp: '', customTcp: '', devicesMode: 'udp' },
    realtime: true,
    bulkDevices: [],
  },
  wireguard: { enabled: false, name: 'wg0', port: 51820, address: '10.99.0.1/24', peers: [] },
};
