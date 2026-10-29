#!/bin/sh
# Build the cfddns and luci-app-cfddns ipks with an OpenWrt 23.05 SDK whose
# packages are aarch64_cortex-a53, check them, and publish them as a signed
# feed in OUTPUT_DIR/aarch64_cortex-a53 with index-feed.sh. The core package
# repackages the pinned release binary; no Go code is compiled.
#
# Usage: build-feed.sh SDK_DIR CORE_VERSION OUTPUT_DIR SECRET_KEY
# Runs as a non-root user on x86_64 Linux, where the SDK runs. SDK_DIR is
# modified: its feeds.conf is replaced by this feed plus the SDK's own LuCI
# feed, and its feed packages are reinstalled.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
ARCH=aarch64_cortex-a53
PKG_MK=$ROOT/net/network/cfddns/Makefile
LUCI_MK=$ROOT/luci/applications/luci-app-cfddns/Makefile
PUBLIC_KEY=$ROOT/cfddns.pub

die() {
	echo "build-feed: $*" >&2
	exit 1
}

if [ $# != 4 ] || [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ] || [ -z "$4" ]; then
	die "usage: build-feed.sh SDK_DIR CORE_VERSION OUTPUT_DIR SECRET_KEY"
fi

# abs PATH prints PATH relative to the current directory as an absolute path.
abs() {
	case $1 in
	/*) printf '%s\n' "$1" ;;
	*) printf '%s/%s\n' "$(pwd)" "$1" ;;
	esac
}

# make_var MAKEFILE NAME prints the value of a top-level "NAME:=value".
make_var() {
	sed -n "s/^$2:=//p" "$1"
}

# "make feed" exports its flags and command-line variables to this script,
# and OpenWrt's make reads OUTPUT_DIR as its own bin directory: keep all of
# them away from the SDK. The names below are reassigned unexported.
unset MAKEFLAGS MAKEOVERRIDES MFLAGS MAKELEVEL SDK_DIR CORE_VERSION OUTPUT_DIR FEED_KEY

SDK_DIR=$(abs "$1")
CORE_VERSION=$2
OUTPUT_DIR=$(abs "$3")
SECRET_KEY=$(abs "$4")

PKG_VERSION=$(make_var "$PKG_MK" PKG_VERSION)
PKG_HASH=$(make_var "$PKG_MK" PKG_HASH)
[ "$CORE_VERSION" = "$PKG_VERSION" ] ||
	die "CORE_VERSION $CORE_VERSION does not match PKG_VERSION $PKG_VERSION in net/network/cfddns/Makefile; update PKG_VERSION and PKG_HASH together"
LUCI_EXTRA_DEPENDS=$(make_var "$LUCI_MK" LUCI_EXTRA_DEPENDS)

for f in scripts/feeds scripts/ipkg-make-index.sh feeds.conf.default \
	staging_dir/host/bin/mkhash staging_dir/host/bin/usign; do
	[ -e "$SDK_DIR/$f" ] || die "$SDK_DIR is not an OpenWrt SDK: missing $f"
done
[ "$(id -u)" != 0 ] || die "run as a non-root user; the OpenWrt SDK refuses to build as root"
[ -f "$SECRET_KEY" ] || die "secret key not found: $SECRET_KEY"
[ -f "$PUBLIC_KEY" ] || die "public key not found: $PUBLIC_KEY"
MKHASH=$SDK_DIR/staging_dir/host/bin/mkhash

luci_feed=$(grep '^src-git luci ' "$SDK_DIR/feeds.conf.default") ||
	die "the SDK's feeds.conf.default has no luci feed"
printf '%s\nsrc-link cfddns %s\n' "$luci_feed" "$ROOT" >"$SDK_DIR/feeds.conf"

cd "$SDK_DIR"
./scripts/feeds update -a
./scripts/feeds uninstall -a
./scripts/feeds install -a -p cfddns
# Installing this feed also installs luci-base and its helpers from the LuCI
# feed. They cannot be built here, since lua, rpcd and ucode live in feeds
# this build does not use. luci-app-cfddns only needs luci.mk, and its control
# file still depends on luci-base.
set --
for pkg in package/feeds/luci/*; do
	if [ -L "$pkg" ]; then
		set -- "$@" "${pkg##*/}"
	fi
done
[ $# = 0 ] || ./scripts/feeds uninstall "$@"

make defconfig
grep -qx "CONFIG_TARGET_ARCH_PACKAGES=\"$ARCH\"" .config || die "the SDK does not build $ARCH packages"
for pkg in cfddns luci-app-cfddns; do
	grep -qx "CONFIG_PACKAGE_$pkg=m" .config || die "$pkg is not selected in the SDK configuration"
done

BIN_DIR=$SDK_DIR/bin/packages/$ARCH/cfddns
rm -rf "$BIN_DIR"
make package/cfddns/clean package/luci-app-cfddns/clean
# The SDK's Config-build.in sets LUCI_JSMIN and LUCI_CSSTIDY without a prompt,
# so .config cannot turn them off; without luci-base there is no jsmin, and
# luci.mk would leave empty *.js.o files in the package.
make package/cfddns/compile package/luci-app-cfddns/compile CONFIG_LUCI_JSMIN= CONFIG_LUCI_CSSTIDY=

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/cfddns-feed.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/ipk" "$STAGE/check"
for f in "$BIN_DIR"/*; do
	[ -e "$f" ] || continue
	case ${f##*/} in
	cfddns_"$CORE_VERSION"-*_"$ARCH".ipk) CORE_IPK=$f ;;
	luci-app-cfddns_*_all.ipk) LUCI_IPK=$f ;;
	*) die "unexpected build output: $f" ;;
	esac
	cp "$f" "$STAGE/ipk/"
done
[ -n "${CORE_IPK:-}" ] || die "no cfddns_${CORE_VERSION}-*_$ARCH.ipk in $BIN_DIR"
[ -n "${LUCI_IPK:-}" ] || die "no luci-app-cfddns_*_all.ipk in $BIN_DIR"

# control IPK prints the ipk's control file.
control() {
	tar -xzOf "$1" ./control.tar.gz | tar -xzOf - ./control
}

core_control=$(control "$CORE_IPK")
luci_control=$(control "$LUCI_IPK")
printf '%s\n' "$core_control" | grep -qx "Architecture: $ARCH" ||
	die "${CORE_IPK##*/} is not Architecture: $ARCH"
printf '%s\n' "$luci_control" | grep -qx 'Architecture: all' ||
	die "${LUCI_IPK##*/} is not Architecture: all"
printf '%s\n' "$luci_control" | grep '^Depends: ' | grep -qF -- "$LUCI_EXTRA_DEPENDS" ||
	die "${LUCI_IPK##*/} does not depend on $LUCI_EXTRA_DEPENDS"

tar -xzOf "$CORE_IPK" ./data.tar.gz | tar -xzOf - ./usr/bin/cfddns >"$STAGE/check/cfddns"
binary_hash=$("$MKHASH" sha256 "$STAGE/check/cfddns")
[ "$binary_hash" = "$PKG_HASH" ] ||
	die "packaged /usr/bin/cfddns has SHA256 $binary_hash, want PKG_HASH $PKG_HASH"

# luci-app-cfddns must ship its htdocs (as /www) and root trees unchanged.
APP=$ROOT/luci/applications/luci-app-cfddns
mkdir "$STAGE/check/luci"
tar -xzOf "$LUCI_IPK" ./data.tar.gz | tar -xzf - -C "$STAGE/check/luci"
{
	(cd "$APP/htdocs" && find . -type f | sed 's|^\./|www/|')
	(cd "$APP/root" && find . -type f | sed 's|^\./||')
} | LC_ALL=C sort >"$STAGE/check/luci.want"
(cd "$STAGE/check/luci" && find . -type f | sed 's|^\./||' | LC_ALL=C sort) >"$STAGE/check/luci.got"
cmp -s "$STAGE/check/luci.want" "$STAGE/check/luci.got" ||
	die "${LUCI_IPK##*/} files differ from luci/applications/luci-app-cfddns:
$(diff "$STAGE/check/luci.want" "$STAGE/check/luci.got")"
while IFS= read -r f; do
	case $f in
	www/*) src=$APP/htdocs/${f#www/} ;;
	*) src=$APP/root/$f ;;
	esac
	cmp -s "$src" "$STAGE/check/luci/$f" || die "${LUCI_IPK##*/}: /$f differs from its source"
done <"$STAGE/check/luci.got"

for ipk in "$CORE_IPK" "$LUCI_IPK"; do
	echo "build-feed: ${ipk##*/}"
	control "$ipk" | grep -E '^(Architecture|Depends):' | sed 's/^/build-feed:   /'
done
echo "build-feed: /usr/bin/cfddns SHA256 $binary_hash matches PKG_HASH"

OPKG_MAKE_INDEX=$SDK_DIR/scripts/ipkg-make-index.sh MKHASH=$MKHASH \
	USIGN=$SDK_DIR/staging_dir/host/bin/usign \
	sh "$ROOT/scripts/index-feed.sh" "$STAGE/ipk" "$OUTPUT_DIR" "$SECRET_KEY" "$PUBLIC_KEY"
