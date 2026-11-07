# Local verification entry points for the cfddns OpenWrt feed. Packages are
# built by the OpenWrt SDK from the per-package Makefiles; "make feed" drives
# an OpenWrt 23.05 aarch64_cortex-a53 SDK on x86_64 Linux as a non-root user:
#   make feed SDK_DIR=<sdk> CORE_VERSION=0.3.1 OUTPUT_DIR=<dir> FEED_KEY=<usign secret key>

.PHONY: check test-config test-static test-js test-luci-static test-feed feed

check: test-config test-static test-js test-luci-static test-feed

test-config:
	sh tests/config_test.sh

test-static:
	sh tests/static_test.sh

test-js:
	node --test tests/js/*_test.cjs

test-luci-static:
	sh tests/luci_static_test.sh

test-feed:
	sh tests/feed_test.sh

feed:
	sh scripts/build-feed.sh "$(SDK_DIR)" "$(CORE_VERSION)" "$(OUTPUT_DIR)" "$(FEED_KEY)"
