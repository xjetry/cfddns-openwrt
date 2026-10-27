include $(TOPDIR)/rules.mk

PKG_NAME:=cfddns
PKG_VERSION:=0.3.0
PKG_RELEASE:=1

# The verified core release binary is packaged as is; nothing is compiled.
PKG_SOURCE:=cfddns-linux-arm64-$(PKG_VERSION)
PKG_SOURCE_URL:=https://github.com/xjetry/cfddns/releases/download/v$(PKG_VERSION)
PKG_SOURCE_URL_FILE:=cfddns-linux-arm64
PKG_HASH:=b5879b25a411ea8ed2c74ba90c9e7d215f54840a9eb0a1f953d30838161c1436

include $(INCLUDE_DIR)/package.mk

# Keep the installed binary byte-identical to the published release asset.
STRIP:=:
RSTRIP:=:

define Package/cfddns
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Cloudflare DDNS client for A/AAAA records
  URL:=https://github.com/xjetry/cfddns
  DEPENDS:=+ca-bundle
  PKGARCH:=aarch64_cortex-a53
endef

define Package/cfddns/description
  cfddns keeps Cloudflare A/AAAA records pointed at this router's public
  IPv4/IPv6 address. It is configured through UCI (/etc/config/cfddns)
  and runs as a procd service.
endef

define Package/cfddns/conffiles
/etc/config/cfddns
endef

define Build/Prepare
	$(CP) $(DL_DIR)/$(PKG_SOURCE) $(PKG_BUILD_DIR)/cfddns
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/cfddns/install
	$(INSTALL_DIR) $(1)/usr/bin $(1)/usr/libexec $(1)/etc/config $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/cfddns $(1)/usr/bin/cfddns
	$(INSTALL_BIN) ./files/cfddns-config $(1)/usr/libexec/cfddns-config
	$(INSTALL_BIN) ./files/cfddns.init $(1)/etc/init.d/cfddns
	$(INSTALL_CONF) ./files/cfddns.config $(1)/etc/config/cfddns
endef

# opkg runs preinst with "install" for a first install and with "upgrade
# <old-version>" when replacing the installed package. A first install must
# not adopt files left by install.sh or "cfddns -install": that would leave
# two services or two configuration sources for the same records.
define Package/cfddns/preinst
#!/bin/sh
[ "$$1" = upgrade ] && exit 0
found=
for f in /usr/bin/cfddns /etc/init.d/cfddns /etc/cfddns.env; do
	if [ -e "$${IPKG_INSTROOT}$$f" ] || [ -L "$${IPKG_INSTROOT}$$f" ]; then
		found="$$found $$f"
	fi
done
[ -z "$$found" ] && exit 0
cat >&2 <<EOF
cfddns: found a manual installation:$$found
Back up /etc/cfddns.env, remove the manual installation with
"cfddns -uninstall", then install this package again and configure it
through UCI (/etc/config/cfddns).
EOF
exit 1
endef

# /etc/cfddns.env is derived from UCI and holds the Token: remove it with the
# package so a later reinstall is not mistaken for a manual installation.
# opkg also runs the old package's postrm with "upgrade" during upgrades.
define Package/cfddns/postrm
#!/bin/sh
[ "$$1" = remove ] || exit 0
rm -f "$${IPKG_INSTROOT}/etc/cfddns.env" "$${IPKG_INSTROOT}/var/run/cfddns.status"
exit 0
endef

$(eval $(call BuildPackage,cfddns))
