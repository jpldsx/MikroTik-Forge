# MikroTik Forge 1.0.0 - RouterOS v7 configuration
# Target: RouterOS 7.x   Multi-WAN: single   VLANs: 0   QoS: cake
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

# ---- WAN addressing + routing (single)
/ip dhcp-client add interface=ether1 use-peer-dns=no use-peer-ntp=no disabled=no comment=WAN1 add-default-route=yes default-route-distance=1

# ---- Address lists
/ip firewall address-list add list=LOCAL_NETS address=192.168.88.0/24 comment=LAN
/ip firewall address-list add list=GAMING_DEVICES address=192.168.88.20
/ip firewall address-list add list=BOGONS address=0.0.0.0/8
/ip firewall address-list add list=BOGONS address=127.0.0.0/8
/ip firewall address-list add list=BOGONS address=224.0.0.0/3

# ---- Mangle
/ip firewall mangle add chain=forward src-address-list=GAMING_DEVICES protocol=udp out-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS gaming: gaming devices"
/ip firewall mangle add chain=forward protocol=udp dst-port=5000-5500 out-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS gaming: game UDP ports"
/ip firewall mangle add chain=forward protocol=udp dst-port=27015-27050,4380 out-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS gaming: game UDP ports"
/ip firewall mangle add chain=forward protocol=udp dst-port=53,3478-3481,5060,5061,8801-8810,19302-19309 out-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS realtime: DNS/VoIP/video-call UDP"
/ip firewall mangle add chain=forward protocol=tcp dst-port=53 out-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS realtime: DNS over TCP"
/ip firewall mangle add chain=forward protocol=icmp out-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS realtime: ICMP"
/ip firewall mangle add chain=forward dst-address-list=GAMING_DEVICES protocol=udp in-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS gaming: gaming devices"
/ip firewall mangle add chain=forward protocol=udp src-port=5000-5500 in-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS gaming: game UDP ports"
/ip firewall mangle add chain=forward protocol=udp src-port=27015-27050,4380 in-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS gaming: game UDP ports"
/ip firewall mangle add chain=forward protocol=udp src-port=53,3478-3481,5060,5061,8801-8810,19302-19309 in-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS realtime: DNS/VoIP/video-call UDP"
/ip firewall mangle add chain=forward protocol=tcp src-port=53 in-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS realtime: DNS over TCP"
/ip firewall mangle add chain=forward protocol=icmp in-interface-list=WAN action=change-dscp new-dscp=46 passthrough=no comment="QoS realtime: ICMP"

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

# ---- Queues (cake)
/queue type add name=ft-cake kind=cake cake-diffserv=diffserv4 cake-nat=yes
/queue tree add name=sqm-up-WAN1 parent=ether1 packet-mark=no-mark max-limit=28500k queue=ft-cake comment="WAN1 upload"
/queue tree add name=sqm-down parent=bridge packet-mark=no-mark max-limit=285M queue=ft-cake comment="download (aggregate)"

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
