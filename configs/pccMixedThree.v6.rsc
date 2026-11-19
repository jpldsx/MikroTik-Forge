# MikroTik Forge 1.0.0 - RouterOS v6 configuration
# Target: RouterOS 6.41+ (6.x)   Multi-WAN: pcc   VLANs: 0   QoS: off
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
/system ntp client set enabled=yes primary-ntp=162.159.200.1 secondary-ntp=162.159.200.123
/ip dns set servers=1.1.1.1,9.9.9.9 allow-remote-requests=yes
/ip settings set tcp-syncookies=yes

# ---- Interface lists
/interface list add name=WAN
/interface list add name=LAN

# ---- WAN interfaces
/interface list member add list=WAN interface=ether1
/interface list member add list=WAN interface=ether6
/interface pppoe-client add name=pppoe-WAN3 interface=ether7 user=u password=p add-default-route=no use-peer-dns=no disabled=no comment=WAN3
/interface list member add list=WAN interface=pppoe-WAN3

# ---- LAN bridge
/interface bridge add name=bridge comment="LAN bridge"
/interface bridge port add bridge=bridge interface=ether2 comment=LAN
/interface bridge port add bridge=bridge interface=ether3 comment=LAN
/interface bridge port add bridge=bridge interface=ether4 comment=LAN
/interface bridge port add bridge=bridge interface=ether5 comment=LAN
/interface list member add list=LAN interface=bridge

# ---- IP addressing + DHCP
/ip address add address=192.168.88.1/24 interface=bridge comment=LAN
/ip pool add name=pool-lan ranges=192.168.88.10-192.168.88.254
/ip dhcp-server add name=dhcp-lan interface=bridge address-pool=pool-lan lease-time=1d disabled=no
/ip dhcp-server network add address=192.168.88.0/24 gateway=192.168.88.1 dns-server=192.168.88.1

# ---- WAN addressing + routing (pcc)
/ip dhcp-client add interface=ether1 use-peer-dns=no use-peer-ntp=no disabled=no comment=WAN1 add-default-route=no script=":if (\$bound=1) do={ :local gw \$\"gateway-address\"; /ip route remove [find where comment~\"^PCC-WAN1-\"]; /ip route add dst-address=0.0.0.0/0 gateway=\$gw distance=1 check-gateway=ping comment=PCC-WAN1-main; /ip route add dst-address=0.0.0.0/0 gateway=\$gw distance=1 routing-mark=to_WAN1 check-gateway=ping comment=PCC-WAN1-own; /ip route add dst-address=0.0.0.0/0 gateway=\$gw distance=2 routing-mark=to_WAN2 check-gateway=ping comment=PCC-WAN1-fb-WAN2; /ip route add dst-address=0.0.0.0/0 gateway=\$gw distance=2 routing-mark=to_WAN3 check-gateway=ping comment=PCC-WAN1-fb-WAN3; }"
/ip address add address=198.51.100.2/30 interface=ether6 comment=WAN2
/ip route add dst-address=0.0.0.0/0 gateway=198.51.100.1 distance=2 check-gateway=ping comment=PCC-WAN2-main
/ip route add dst-address=0.0.0.0/0 gateway=198.51.100.1 distance=1 routing-mark=to_WAN2 check-gateway=ping comment=PCC-WAN2-own
/ip route add dst-address=0.0.0.0/0 gateway=198.51.100.1 distance=3 routing-mark=to_WAN1 check-gateway=ping comment=PCC-WAN2-fb-WAN1
/ip route add dst-address=0.0.0.0/0 gateway=198.51.100.1 distance=3 routing-mark=to_WAN3 check-gateway=ping comment=PCC-WAN2-fb-WAN3
/ip route add dst-address=0.0.0.0/0 gateway=pppoe-WAN3 distance=3 comment=PCC-WAN3-main
/ip route add dst-address=0.0.0.0/0 gateway=pppoe-WAN3 distance=1 routing-mark=to_WAN3 comment=PCC-WAN3-own
/ip route add dst-address=0.0.0.0/0 gateway=pppoe-WAN3 distance=4 routing-mark=to_WAN1 comment=PCC-WAN3-fb-WAN1
/ip route add dst-address=0.0.0.0/0 gateway=pppoe-WAN3 distance=4 routing-mark=to_WAN2 comment=PCC-WAN3-fb-WAN2

# ---- Address lists
/ip firewall address-list add list=LOCAL_NETS address=192.168.88.0/24 comment=LAN
/ip firewall address-list add list=BOGONS address=0.0.0.0/8
/ip firewall address-list add list=BOGONS address=127.0.0.0/8
/ip firewall address-list add list=BOGONS address=224.0.0.0/3

# ---- Mangle
/ip firewall mangle add chain=prerouting action=accept dst-address-list=LOCAL_NETS in-interface-list=LAN comment="PCC: keep LAN-to-LAN traffic in main table"
/ip firewall mangle add chain=prerouting action=mark-connection in-interface=ether1 connection-mark=no-mark new-connection-mark=WAN1_conn passthrough=yes comment="PCC: replies in via WAN1"
/ip firewall mangle add chain=prerouting action=mark-connection in-interface=ether6 connection-mark=no-mark new-connection-mark=WAN2_conn passthrough=yes comment="PCC: replies in via WAN2"
/ip firewall mangle add chain=prerouting action=mark-connection in-interface=pppoe-WAN3 connection-mark=no-mark new-connection-mark=WAN3_conn passthrough=yes comment="PCC: replies in via WAN3"
/ip firewall mangle add chain=prerouting action=mark-connection in-interface-list=LAN dst-address-type=!local connection-mark=no-mark per-connection-classifier=both-addresses-and-ports:4/0 new-connection-mark=WAN1_conn passthrough=yes comment="PCC: new LAN connections -> WAN1"
/ip firewall mangle add chain=prerouting action=mark-connection in-interface-list=LAN dst-address-type=!local connection-mark=no-mark per-connection-classifier=both-addresses-and-ports:4/1 new-connection-mark=WAN1_conn passthrough=yes comment="PCC: new LAN connections -> WAN1"
/ip firewall mangle add chain=prerouting action=mark-connection in-interface-list=LAN dst-address-type=!local connection-mark=no-mark per-connection-classifier=both-addresses-and-ports:4/2 new-connection-mark=WAN2_conn passthrough=yes comment="PCC: new LAN connections -> WAN2"
/ip firewall mangle add chain=prerouting action=mark-connection in-interface-list=LAN dst-address-type=!local connection-mark=no-mark per-connection-classifier=both-addresses-and-ports:4/3 new-connection-mark=WAN3_conn passthrough=yes comment="PCC: new LAN connections -> WAN3"
/ip firewall mangle add chain=prerouting action=mark-routing in-interface-list=LAN connection-mark=WAN1_conn new-routing-mark=to_WAN1 passthrough=no comment="PCC: route WAN1 connections via to_WAN1"
/ip firewall mangle add chain=prerouting action=mark-routing in-interface-list=LAN connection-mark=WAN2_conn new-routing-mark=to_WAN2 passthrough=no comment="PCC: route WAN2 connections via to_WAN2"
/ip firewall mangle add chain=prerouting action=mark-routing in-interface-list=LAN connection-mark=WAN3_conn new-routing-mark=to_WAN3 passthrough=no comment="PCC: route WAN3 connections via to_WAN3"
/ip firewall mangle add chain=output action=mark-routing connection-mark=WAN1_conn new-routing-mark=to_WAN1 passthrough=no comment="PCC: router traffic WAN1"
/ip firewall mangle add chain=output action=mark-routing connection-mark=WAN2_conn new-routing-mark=to_WAN2 passthrough=no comment="PCC: router traffic WAN2"
/ip firewall mangle add chain=output action=mark-routing connection-mark=WAN3_conn new-routing-mark=to_WAN3 passthrough=no comment="PCC: router traffic WAN3"
/ip firewall mangle add chain=forward action=change-mss protocol=tcp tcp-flags=syn out-interface=pppoe-WAN3 new-mss=clamp-to-pmtu passthrough=yes comment="MSS clamp WAN3"

# ---- NAT
/ip firewall nat add chain=srcnat action=masquerade out-interface-list=WAN comment="NAT to WAN"

# ---- Raw
/ip firewall raw add chain=prerouting action=drop in-interface-list=WAN src-address-list=BOGONS comment="drop bogon sources from WAN"

# ---- Firewall filter
/ip firewall filter add chain=input action=accept connection-state=established,related,untracked comment="accept established/related"
/ip firewall filter add chain=input action=drop connection-state=invalid comment="drop invalid"
/ip firewall filter add chain=input action=accept protocol=icmp comment="accept ICMP"
/ip firewall filter add chain=input action=accept in-interface-list=LAN comment="accept from LAN"
/ip firewall filter add chain=input action=drop comment="drop everything else"
/ip firewall filter add chain=forward action=accept connection-state=established,related,untracked comment="accept established/related"
/ip firewall filter add chain=forward action=drop connection-state=invalid comment="drop invalid"
/ip firewall filter add chain=forward action=drop connection-state=new connection-nat-state=!dstnat in-interface-list=WAN comment="drop WAN->LAN unless port-forwarded"

# ---- Management hardening
/ip service set telnet disabled=yes
/ip service set ftp disabled=yes
/ip service set www disabled=yes
/ip service set api disabled=yes
/ip service set api-ssl disabled=yes
/ip service set ssh address=192.168.88.0/24
/ip service set winbox address=192.168.88.0/24
/ip ssh set strong-crypto=yes
/ip neighbor discovery-settings set discover-interface-list=LAN
/tool mac-server set allowed-interface-list=LAN
/tool mac-server mac-winbox set allowed-interface-list=LAN
/tool bandwidth-server set enabled=no
