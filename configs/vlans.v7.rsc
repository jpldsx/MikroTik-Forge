# MikroTik Forge 1.0.0 - RouterOS v7 configuration
# Target: RouterOS 7.x   Multi-WAN: single   VLANs: 4   QoS: off
#
# Apply (recommended - this script assumes an empty configuration):
#   1) Upload this file to the router (Winbox > Files, or scp).
#   2) /system reset-configuration no-defaults=yes skip-backup=yes run-after-reset=forge.rsc
#   Rename the file to forge.rsc first, or change the name above.
# Reach the router afterwards at the LAN address below (or via Winbox MAC if you have no LAN address).
# Test in Safe Mode first when applying by hand (Ctrl+X in the terminal).

# ---- System
/system identity set name=forge
/system clock set time-zone-name=UTC
/system ntp client set enabled=yes servers=162.159.200.1,162.159.200.123
/ip dns set servers=1.1.1.1,9.9.9.9 allow-remote-requests=yes
/ip settings set tcp-syncookies=yes

# ---- Interface lists
/interface list add name=WAN
/interface list add name=LAN

# ---- WAN interfaces
/interface list member add list=WAN interface=ether1

# ---- LAN bridge + VLAN filtering
/interface bridge add name=bridge comment="LAN bridge" vlan-filtering=no
/interface bridge port add bridge=bridge interface=ether3 pvid=10 frame-types=admit-only-untagged-and-priority-tagged ingress-filtering=yes comment="VLAN 10 access"
/interface bridge port add bridge=bridge interface=ether5 pvid=1 frame-types=admit-only-vlan-tagged ingress-filtering=yes comment=trunk
/interface bridge port add bridge=bridge interface=ether4 pvid=30 frame-types=admit-only-untagged-and-priority-tagged ingress-filtering=yes comment="VLAN 30 access"
/interface bridge port add bridge=bridge interface=ether2 pvid=99 frame-types=admit-only-untagged-and-priority-tagged ingress-filtering=yes comment="VLAN 99 access"
/interface list member add list=LAN interface=bridge
/interface vlan add name=vlan10-trusted interface=bridge vlan-id=10 comment=trusted
/interface list member add list=LAN interface=vlan10-trusted
/interface bridge vlan add bridge=bridge vlan-ids=10 tagged=bridge,ether5 untagged=ether3 comment=trusted
/interface vlan add name=vlan30-guest interface=bridge vlan-id=30 comment=guest
/interface list member add list=LAN interface=vlan30-guest
/interface bridge vlan add bridge=bridge vlan-ids=30 tagged=bridge,ether5 untagged=ether4 comment=guest
/interface vlan add name=vlan40-iot interface=bridge vlan-id=40 comment=iot
/interface list member add list=LAN interface=vlan40-iot
/interface bridge vlan add bridge=bridge vlan-ids=40 tagged=bridge,ether5 comment=iot
/interface vlan add name=vlan99-mgmt interface=bridge vlan-id=99 comment=mgmt
/interface list member add list=LAN interface=vlan99-mgmt
/interface bridge vlan add bridge=bridge vlan-ids=99 tagged=bridge,ether5 untagged=ether2 comment=mgmt

# ---- IP addressing + DHCP
/ip address add address=192.168.10.1/24 interface=vlan10-trusted comment=trusted
/ip pool add name=pool-vlan10-trusted ranges=192.168.10.10-192.168.10.254
/ip dhcp-server add name=dhcp-vlan10-trusted interface=vlan10-trusted address-pool=pool-vlan10-trusted lease-time=1d disabled=no
/ip dhcp-server network add address=192.168.10.0/24 gateway=192.168.10.1 dns-server=192.168.10.1
/ip address add address=192.168.30.1/24 interface=vlan30-guest comment=guest
/ip pool add name=pool-vlan30-guest ranges=192.168.30.10-192.168.30.254
/ip dhcp-server add name=dhcp-vlan30-guest interface=vlan30-guest address-pool=pool-vlan30-guest lease-time=1d disabled=no
/ip dhcp-server network add address=192.168.30.0/24 gateway=192.168.30.1 dns-server=192.168.30.1
/ip address add address=192.168.40.1/24 interface=vlan40-iot comment=iot
/ip pool add name=pool-vlan40-iot ranges=192.168.40.10-192.168.40.254
/ip dhcp-server add name=dhcp-vlan40-iot interface=vlan40-iot address-pool=pool-vlan40-iot lease-time=1d disabled=no
/ip dhcp-server network add address=192.168.40.0/24 gateway=192.168.40.1 dns-server=192.168.40.1
/ip address add address=192.168.99.1/24 interface=vlan99-mgmt comment=mgmt
/ip pool add name=pool-vlan99-mgmt ranges=192.168.99.10-192.168.99.254
/ip dhcp-server add name=dhcp-vlan99-mgmt interface=vlan99-mgmt address-pool=pool-vlan99-mgmt lease-time=1d disabled=no
/ip dhcp-server network add address=192.168.99.0/24 gateway=192.168.99.1 dns-server=192.168.99.1

# ---- WAN addressing + routing (single)
/ip dhcp-client add interface=ether1 use-peer-dns=no use-peer-ntp=no disabled=no comment=WAN1 add-default-route=yes default-route-distance=1

# ---- Address lists
/ip firewall address-list add list=LOCAL_NETS address=192.168.10.0/24 comment="VLAN 10"
/ip firewall address-list add list=LOCAL_NETS address=192.168.30.0/24 comment="VLAN 30"
/ip firewall address-list add list=LOCAL_NETS address=192.168.40.0/24 comment="VLAN 40"
/ip firewall address-list add list=LOCAL_NETS address=192.168.99.0/24 comment="VLAN 99"
/ip firewall address-list add list=BOGONS address=0.0.0.0/8
/ip firewall address-list add list=BOGONS address=127.0.0.0/8
/ip firewall address-list add list=BOGONS address=224.0.0.0/3

# ---- Mangle
# (no mangle rules needed)

# ---- NAT
/ip firewall nat add chain=srcnat action=masquerade out-interface-list=WAN comment="NAT to WAN"

# ---- Raw
/ip firewall raw add chain=prerouting action=drop in-interface-list=WAN src-address-list=BOGONS comment="drop bogon sources from WAN"

# ---- Firewall filter
/ip firewall filter add chain=input action=accept connection-state=established,related,untracked comment="accept established/related"
/ip firewall filter add chain=input action=drop connection-state=invalid comment="drop invalid"
/ip firewall filter add chain=input action=accept protocol=icmp comment="accept ICMP"
/ip firewall filter add chain=input action=accept protocol=udp dst-port=53,67 in-interface=vlan30-guest comment="guest: DNS/DHCP only"
/ip firewall filter add chain=input action=accept protocol=tcp dst-port=53 in-interface=vlan30-guest comment="guest: DNS/TCP"
/ip firewall filter add chain=input action=drop in-interface=vlan30-guest comment="guest: no access to router"
/ip firewall filter add chain=input action=accept protocol=udp dst-port=53,67 in-interface=vlan40-iot comment="iot: DNS/DHCP only"
/ip firewall filter add chain=input action=accept protocol=tcp dst-port=53 in-interface=vlan40-iot comment="iot: DNS/TCP"
/ip firewall filter add chain=input action=drop in-interface=vlan40-iot comment="iot: no access to router"
/ip firewall filter add chain=input action=accept in-interface-list=LAN comment="accept from LAN"
/ip firewall filter add chain=input action=drop comment="drop everything else"
/ip firewall filter add chain=forward action=accept connection-state=established,related,untracked comment="accept established/related"
/ip firewall filter add chain=forward action=drop connection-state=invalid comment="drop invalid"
/ip firewall filter add chain=forward action=accept in-interface=vlan99-mgmt out-interface-list=LAN comment="management VLAN may reach all LANs"
/ip firewall filter add chain=forward action=drop in-interface=vlan30-guest out-interface-list=LAN comment="guest: isolated from other LANs"
/ip firewall filter add chain=forward action=drop in-interface=vlan40-iot out-interface-list=LAN comment="iot: isolated from other LANs"
/ip firewall filter add chain=forward action=drop in-interface=vlan40-iot out-interface-list=WAN comment="iot: no internet"
/ip firewall filter add chain=forward action=drop connection-state=new connection-nat-state=!dstnat in-interface-list=WAN comment="drop WAN->LAN unless port-forwarded"

# ---- Queues (off)
/queue simple add name=limit-vlan30-guest target=192.168.30.0/24 max-limit=5M/20M comment="guest cap (upload/download)"

# ---- Management hardening
/ip service set telnet disabled=yes
/ip service set ftp disabled=yes
/ip service set www disabled=yes
/ip service set api disabled=yes
/ip service set api-ssl disabled=yes
/ip service set ssh address=192.168.10.0/24,192.168.30.0/24,192.168.40.0/24,192.168.99.0/24
/ip service set winbox address=192.168.10.0/24,192.168.30.0/24,192.168.40.0/24,192.168.99.0/24
/ip ssh set strong-crypto=yes
/ip neighbor discovery-settings set discover-interface-list=LAN
/tool mac-server set allowed-interface-list=LAN
/tool mac-server mac-winbox set allowed-interface-list=LAN
/tool bandwidth-server set enabled=no

# ---- Enable VLAN filtering (last)
/interface bridge set [find where name=bridge] vlan-filtering=yes
