# Local verification entry points for the cfddns OpenWrt feed. Packages are
# built by the OpenWrt SDK from the per-package Makefiles, not from here.

.PHONY: check test-config test-static test-js test-luci-static

check: test-config test-static test-js test-luci-static

test-config:
	sh tests/config_test.sh

test-static:
	sh tests/static_test.sh

test-js:
	node --test tests/js/*_test.cjs

test-luci-static:
	sh tests/luci_static_test.sh
