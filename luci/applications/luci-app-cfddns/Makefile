include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for Cloudflare DDNS (cfddns)
# DEPENDS cannot carry a version; luci.mk passes LUCI_EXTRA_DEPENDS to the
# package control file, which needs the core's status and inspect support.
LUCI_DEPENDS:=+luci-base +cfddns
LUCI_EXTRA_DEPENDS:=cfddns (>=0.3.0)
LUCI_PKGARCH:=all

PKG_VERSION:=0.1.1
PKG_RELEASE:=1

# This feed is not the LuCI tree: use luci.mk from the SDK's LuCI feed.
include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
