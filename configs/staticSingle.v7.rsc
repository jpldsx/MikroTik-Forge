# MikroTik Forge 1.0.0 - RouterOS v7 configuration
# Target: RouterOS 7.x   Multi-WAN: single   VLANs: 0   QoS: off
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
/ip address add address=203.0.113.2/30 interface=ether1 comment=WAN1
/ip route add dst-address=0.0.0.0/0 gateway=203.0.113.1 check-gateway=ping comment="default WAN1"

# ---- Address lists
/ip firewall address-list add list=LOCAL_NETS address=192.168.88.0/24 comment=LAN
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
/ip firewall filter add chain=input action=accept in-interface-list=LAN comment="accept from LAN"
/ip firewall filter add chain=input action=drop comment="drop everything else"
/ip firewall filter add chain=forward action=fasttrack-connection connection-state=established,related hw-offload=yes comment=FastTrack
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
