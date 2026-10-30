#!/bin/sh
# Tests for the feed scripts and the cfddns package preinst. index-feed.sh is
# driven by fake opkg-make-index and usign tools with throwaway keys created
# here; the preinst is taken from make's own expansion of the package
# Makefile, which is what OpenWrt writes into the ipk. Run with:
# make test-feed
#
# CFDDNS_TEST_SH selects the shell that runs the preinst (default: sh), so the
# same tests can exercise busybox ash.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
INDEX=$ROOT/scripts/index-feed.sh
BUILD=$ROOT/scripts/build-feed.sh
PKG_MK=$ROOT/net/network/cfddns/Makefile
README=$ROOT/README.md
TEST_SH=${CFDDNS_TEST_SH:-sh}
ARCH=aarch64_cortex-a53
CORE_IPK=cfddns_0.3.0-2_$ARCH.ipk
# luci.mk versions LuCI packages by PKG_VERSION alone.
LUCI_IPK="luci-app-cfddns_0.1.1_all.ipk"
MANUAL_PATHS="/usr/bin/cfddns /etc/init.d/cfddns /etc/cfddns.env"
CORE_CONTROL="Package: cfddns
Version: 0.3.0-2
Depends: libc, ca-bundle
Architecture: $ARCH"
LUCI_CONTROL="Package: luci-app-cfddns
Version: 0.1.1
Depends: cfddns (>=0.3.0-2), libc, luci-base, cfddns
Architecture: all"
REAL_MAKE=$(command -v make)

# Byte order for ls and sort; no AppleDouble files in tar archives on macOS.
LC_ALL=C
COPYFILE_DISABLE=1
export LC_ALL COPYFILE_DISABLE

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cfddns-feed-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
	echo "    $*"
	exit 1
}

setup() {
	WORK=$TMP_ROOT/$1
	BIN=$WORK/bin
	IPKS=$WORK/ipks
	OUT=$WORK/dist
	mkdir -p "$BIN" "$IPKS" "$OUT" "$WORK/keys"
	write_fake_tools
	INDEXER=$BIN/opkg-make-index
	SIGNER=$BIN/usign
	make_keys "$WORK/keys/test"
	SECRET=$WORK/keys/test.sec
	PUBLIC=$WORK/keys/test.pub
	SENTINEL=$KEY_SENTINEL
	printf 'core package\n' >"$IPKS/$CORE_IPK"
	printf 'luci package\n' >"$IPKS/$LUCI_IPK"
}

write_fake_tools() {
	cat >"$BIN/opkg-make-index" <<'EOF'
#!/bin/sh
# Fake opkg-make-index: like OpenWrt's ipkg-make-index.sh it prints one
# stanza per ipk in $1 with Filename relative to $1 when $1 is ".". Prints
# $FAKE_INDEX_FILE verbatim instead when that is set.
if [ -n "$FAKE_INDEX_FILE" ]; then
	exec cat "$FAKE_INDEX_FILE"
fi
for ipk in "$1"/*.ipk; do
	[ -f "$ipk" ] || continue
	file=${ipk##*/}
	name=${file%%_*}
	rest=${file#*_}
	arch=${rest#*_}
	printf 'Package: %s\nVersion: %s\nMaintainer: Fake Maintainer\nSourceDateEpoch: 1\nArchitecture: %s\nFilename: %s\nSize: %s\nDescription: fake\n\n' \
		"$name" "${rest%%_*}" "${arch%.ipk}" "${ipk#./}" "$(wc -c <"$ipk" | tr -d ' ')"
done
EOF
	cat >"$BIN/usign" <<'EOF'
#!/bin/sh
# Fake usign for -S (sign) and -V (verify). Line 2 of a key file starts with
# the key id; a signature holds the key id and the message's cksum, never the
# secret key. Like usign, "-m -" reads the message from stdin and -V prints
# OK unless -q. FAKE_USIGN_SIGN_FAILS makes -S fail.
mode= msg= key= sig= quiet=
while [ $# -gt 0 ]; do
	case $1 in
	-S | -V) mode=$1 ;;
	-m) msg=$2 && shift ;;
	-s | -p) key=$2 && shift ;;
	-x) sig=$2 && shift ;;
	-q) quiet=1 ;;
	*) echo "usign: unexpected argument $1" >&2 && exit 2 ;;
	esac
	shift
done
if [ "$msg" = - ]; then
	msg=$(mktemp "${TMPDIR:-/tmp}/fake-usign.XXXXXX") || exit 1
	trap 'rm -f "$msg"' EXIT
	cat >"$msg"
fi
if [ -z "$mode" ] || [ ! -f "$msg" ] || [ ! -f "$key" ]; then
	echo "usign: missing message or key" >&2
	exit 1
fi
[ "$mode" = -S ] && [ -n "$FAKE_USIGN_SIGN_FAILS" ] && exit 1
sig=${sig:-$msg.sig}
id=$(awk 'NR == 2 { print $1 }' "$key")
sum=$(cksum <"$msg" | awk '{ print $1 "-" $2 }')
if [ "$mode" = -S ]; then
	printf 'untrusted comment: signed by fake key %s\n%s %s\n' "$id" "$id" "$sum" >"$sig"
elif [ "$(sed -n 2p "$sig" 2>/dev/null)" = "$id $sum" ]; then
	[ -n "$quiet" ] || echo OK >&2
else
	echo "verification failed" >&2
	exit 1
fi
EOF
	chmod +x "$BIN/opkg-make-index" "$BIN/usign"
}

# make_keys PREFIX writes a throwaway fake key pair PREFIX.sec and PREFIX.pub
# and sets KEY_SENTINEL to a string that only the secret key contains.
make_keys() {
	id=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
	KEY_SENTINEL=SENTINEL-SECRET-$id
	(umask 077 && printf 'untrusted comment: throwaway test secret key\n%s %s\n' "$id" "$KEY_SENTINEL" >"$1.sec")
	printf 'untrusted comment: throwaway test public key\n%s\n' "$id" >"$1.pub"
}

# run_index [IPK_DIR OUTPUT_DIR SECRET_KEY PUBLIC_KEY] runs index-feed.sh with
# $INDEXER and $SIGNER; without arguments it uses the test's ipks, output and
# key pair.
run_index() {
	if [ $# = 0 ]; then
		set -- "$IPKS" "$OUT" "$SECRET" "$PUBLIC"
	fi
	OPKG_MAKE_INDEX=$INDEXER USIGN=$SIGNER sh "$INDEX" "$@" >"$WORK/stdout" 2>"$WORK/stderr"
	RC=$?
}

assert_ok() {
	[ "$RC" = 0 ] || fail "exit status $RC, want 0; stderr: $(cat "$WORK/stderr")"
}

# assert_refused WORD [ENTRY]: non-zero exit, WORD on stderr, and nothing in
# the output directory except ENTRY.
assert_refused() {
	[ "$RC" != 0 ] || fail "succeeded, want a failure mentioning $1"
	grep -qi -- "$1" "$WORK/stderr" || fail "stderr does not mention $1: $(cat "$WORK/stderr")"
	left=$(ls -A "$OUT")
	[ "$left" = "${2:-}" ] || fail "output left behind after failure: $left"
}

# index_of_size N writes a manifest naming both packages that is N bytes long.
index_of_size() {
	{
		printf 'Package: cfddns\nPackage: luci-app-cfddns\nDescription: '
		printf "%0$(($1 - 55))d\n" 0
	} >"$WORK/manifest"
}

# preinst_from_make prints Package/cfddns/preinst as make expands it when
# OpenWrt writes the preinst, with the OpenWrt includes stubbed out.
preinst_from_make() {
	stub=$WORK/openwrt-stub
	mkdir -p "$stub"
	: >"$stub/rules.mk"
	: >"$stub/package.mk"
	# shellcheck disable=SC2016 # make expressions, not shell
	printf '%s\n' '$(info $(Package/cfddns/preinst))' 'preinst: ; @:' >"$stub/print.mk"
	(
		unset MAKEFLAGS MAKELEVEL MFLAGS
		make -s --no-print-directory -f "$PKG_MK" -f "$stub/print.mk" \
			TOPDIR="$stub" INCLUDE_DIR="$stub" preinst
	)
}

# key_fingerprint PUBKEY prints the key id as usign -F does: the 8 bytes after
# the "Ed" algorithm tag, in hex without leading zeros.
key_fingerprint() {
	sed -n 2p "$1" | base64 -d | od -An -tx1 -j2 -N8 | tr -d ' \n' | sed 's/^0*//'
}

# readme_commands prints "LINE:TEXT" for every line of the README's fenced
# code blocks, without indentation.
readme_commands() {
	awk '
		/^```/ { inside = !inside; next }
		inside { sub(/^[[:space:]]+/, ""); print NR ":" $0 }
	' "$README"
}

# command_line ERE prints the README line number of the first code line that
# matches ERE from its start; readme_commands must have filled
# $WORK/commands.
command_line() {
	grep -E -- "^[0-9]+:$1" "$WORK/commands" | head -n 1 | cut -d: -f1
}

# readme_feed_name prints the name of the README's src/gz feed, which is also
# its list file in /var/opkg-lists.
readme_feed_name() {
	sed -n "s|.*'src/gz \([^ ]*\) https://xjetry.github.io/cfddns-openwrt/$ARCH'.*|\1|p" "$README"
}

# readme_verify_command LIST_DIR SIG PUBKEY prints the README's usign -V
# command with /var/opkg-lists/, the downloaded Packages.sig and the pinned
# key replaced by LIST_DIR/, SIG and PUBKEY.
readme_verify_command() {
	readme_commands >"$WORK/commands"
	fetched=$(sed -n "s|^[0-9]*:wget -O \([^ ]*\) https://.*/Packages\.sig$|\1|p" "$WORK/commands" | head -n 1)
	line=$(grep -E '^[0-9]+:.*usign -V ' "$WORK/commands" | head -n 1 | cut -d: -f2-)
	[ -n "$fetched" ] && [ -n "$line" ] || return 1
	printf '%s\n' "$line" | sed -e "s|$fetched|$2|g" \
		-e "s|/etc/opkg/keys/$(key_fingerprint "$ROOT/cfddns.pub")|$3|g" -e "s|/var/opkg-lists/|$1/|g"
}

# run_preinst ROOT ARGS... runs the preinst with IPKG_INSTROOT=ROOT.
run_preinst() {
	root=$1
	shift
	IPKG_INSTROOT=$root "$TEST_SH" "$PREINST" "$@" >"$WORK/stdout" 2>"$WORK/stderr"
	RC=$?
}

# make_ipk FILE CONTROL DATA_DIR writes an OpenWrt-style ipk, a gzip'd tar of
# control.tar.gz and data.tar.gz.
make_ipk() {
	d=$WORK/ipk-build
	rm -rf "$d"
	mkdir -p "$d/control" "$d/pkg"
	printf '%s\n' "$2" >"$d/control/control"
	(cd "$d/control" && tar -czf ../pkg/control.tar.gz ./control)
	(cd "$3" && tar -czf "$d/pkg/data.tar.gz" .)
	printf '2.0\n' >"$d/pkg/debian-binary"
	(cd "$d/pkg" && tar -czf "$1" ./debian-binary ./data.tar.gz ./control.tar.gz)
}

# fake_build CORE_CONTROL LUCI_CONTROL CORE_BINARY [LUCI_CHANGE] prepares the
# ipks the fake SDK "builds": $FAKE_IPKS/plain as with LuCI minification off,
# and $FAKE_IPKS/jsmin with the empty *.js.o files luci.mk leaves when
# CONFIG_LUCI_JSMIN is set but jsmin is missing. A CORE_BINARY of "release
# binary" stands for the pinned asset; LUCI_CHANGE names a LuCI data file to
# append to or create.
fake_build() {
	app=$ROOT/luci/applications/luci-app-cfddns
	data=$WORK/data
	rm -rf "$FAKE_IPKS" "$data"
	mkdir -p "$FAKE_IPKS/plain" "$FAKE_IPKS/jsmin" "$data/core/usr/bin" "$data/luci/www"
	printf '%s\n' "$3" >"$data/core/usr/bin/cfddns"
	cp -R "$app/htdocs/." "$data/luci/www/"
	cp -R "$app/root/." "$data/luci/"
	if [ -n "${4:-}" ]; then
		mkdir -p "$data/luci/${4%/*}"
		printf 'changed\n' >>"$data/luci/$4"
	fi
	for variant in plain jsmin; do
		if [ "$variant" = jsmin ]; then
			find "$data/luci/www" -name '*.js' -exec sh -c ': >"$1.o"' sh {} \;
		fi
		make_ipk "$FAKE_IPKS/$variant/$CORE_IPK" "$1" "$data/core"
		make_ipk "$FAKE_IPKS/$variant/$LUCI_IPK" "$2" "$data/luci"
	done
}

# make_fake_sdk DIR creates an SDK stand-in. Its make, first in PATH, writes
# a .config that sets CONFIG_LUCI_JSMIN as the real SDK's Config-build.in
# always does, and on compile copies the matching ipks from $FAKE_IPKS to the
# feed's package directory below ${OUTPUT_DIR:-bin}, which the real SDK also
# takes from the environment. A CONFIG_LUCI_JSMIN= argument overrides the
# .config, as in make. Its scripts/feeds links luci-base on install, as the
# real one does for this feed. Every call is logged to $FAKE_SDK_LOG.
make_fake_sdk() {
	sdk=$1
	mkdir -p "$sdk/scripts" "$sdk/staging_dir/host/bin"
	printf 'src-git-full base https://example.invalid/openwrt.git\nsrc-git luci https://example.invalid/luci.git^0123abc\n' \
		>"$sdk/feeds.conf.default"
	cp "$BIN/opkg-make-index" "$sdk/scripts/ipkg-make-index.sh"
	cp "$BIN/usign" "$sdk/staging_dir/host/bin/usign"
	cat >"$sdk/staging_dir/host/bin/mkhash" <<'EOF'
#!/bin/sh
[ "$1" = sha256 ] || exit 2
if [ "$(cat "$2")" = "release binary" ]; then
	echo "$FAKE_PKG_HASH"
else
	echo 0000000000000000000000000000000000000000000000000000000000000000
fi
EOF
	cat >"$sdk/scripts/feeds" <<'EOF'
#!/bin/sh
echo "feeds $*" >>"$FAKE_SDK_LOG"
case $1 in
install)
	mkdir -p package/feeds/cfddns package/feeds/luci
	ln -sf ../../../feeds/luci/modules/luci-base package/feeds/luci/luci-base
	ln -sf ../../../feeds/cfddns/net/network/cfddns package/feeds/cfddns/cfddns
	;;
uninstall)
	shift
	if [ "$1" = -a ]; then
		rm -rf package/feeds
	else
		for p in "$@"; do rm -f "package/feeds/luci/$p"; done
	fi
	;;
esac
EOF
	cat >"$BIN/make" <<'EOF'
#!/bin/sh
echo "make $*" >>"$FAKE_SDK_LOG"
jsmin=$(sed -n 's/^CONFIG_LUCI_JSMIN=//p' .config 2>/dev/null)
for arg in "$@"; do
	case $arg in
	CONFIG_LUCI_JSMIN=*) jsmin=${arg#*=} ;;
	esac
done
for goal in "$@"; do
	case $goal in
	CONFIG_*=*) ;;
	defconfig)
		printf 'CONFIG_TARGET_ARCH_PACKAGES="aarch64_cortex-a53"\nCONFIG_PACKAGE_cfddns=m\nCONFIG_PACKAGE_luci-app-cfddns=m\nCONFIG_LUCI_JSMIN=y\n' >.config
		;;
	package/*/clean) ;;
	package/*/compile)
		dir=${OUTPUT_DIR:-$PWD/bin}/packages/aarch64_cortex-a53/cfddns
		mkdir -p "$dir"
		variant=plain
		[ -z "$jsmin" ] || variant=jsmin
		cp "$FAKE_IPKS/$variant"/*.ipk "$dir/"
		;;
	*) echo "fake make: unexpected goal $goal" >&2 && exit 2 ;;
	esac
done
EOF
	chmod +x "$sdk/scripts/feeds" "$sdk/staging_dir/host/bin/mkhash" "$BIN/make"
}

# run_build [ARGS...] runs build-feed.sh with the fake SDK's make in PATH.
run_build() {
	PATH=$BIN:$PATH sh "$BUILD" "$@" >"$WORK/stdout" 2>"$WORK/stderr"
	RC=$?
}

test_feed_layout_and_index() {
	run_index
	assert_ok
	# shellcheck disable=SC2012 # the test controls every file name here
	[ "$(ls -A "$OUT")" = "$ARCH" ] ||
		fail "output must hold only $ARCH/, got: $(ls -A "$OUT" | tr '\n' ' ')"
	feed=$OUT/$ARCH
	# shellcheck disable=SC2012
	entries=$(ls -A "$feed" | tr '\n' ' ')
	[ "$entries" = "Packages Packages.gz Packages.manifest Packages.sig $CORE_IPK $LUCI_IPK " ] ||
		fail "feed holds: $entries"
	for ipk in "$CORE_IPK" "$LUCI_IPK"; do
		cmp -s "$IPKS/$ipk" "$feed/$ipk" || fail "$ipk not copied verbatim"
		grep -qx "Filename: $ipk" "$feed/Packages" || fail "Packages must name $ipk relative to the feed"
	done
	for name in cfddns luci-app-cfddns; do
		grep -qx "Package: $name" "$feed/Packages" || fail "Packages lacks $name"
	done
	grep -qx 'Maintainer: Fake Maintainer' "$feed/Packages.manifest" ||
		fail "Packages.manifest must keep the full control fields"
	! grep -qE '^(Maintainer|SourceDateEpoch):' "$feed/Packages" ||
		fail "Packages must drop the fields OpenWrt strips from the index"
	gzip -dc "$feed/Packages.gz" | cmp -s - "$feed/Packages" || fail "Packages.gz does not match Packages"
	"$SIGNER" -V -q -m "$feed/Packages" -p "$PUBLIC" -x "$feed/Packages.sig" ||
		fail "Packages.sig does not verify with the public key"
}

test_feed_signature_contains_no_private_key() {
	cp "$SECRET" "$WORK/secret.orig"
	run_index
	assert_ok
	! grep -rqF -- "$SENTINEL" "$OUT" "$WORK/stdout" "$WORK/stderr" ||
		fail "secret key material in the output or the logs"
	! gzip -dc "$OUT/$ARCH/Packages.gz" | grep -qF -- "$SENTINEL" || fail "secret key material in Packages.gz"
	find "$OUT" -type f >"$WORK/files"
	while IFS= read -r f; do
		! cmp -s "$f" "$SECRET" || fail "secret key copied to ${f#"$OUT"/}"
	done <"$WORK/files"
	cmp -s "$SECRET" "$WORK/secret.orig" || fail "secret key modified"

	# A secret key kept inside the output tree would be published with it.
	rm -rf "$OUT" && mkdir "$OUT"
	cp "$SECRET" "$OUT/test.sec"
	run_index "$IPKS" "$OUT" "$OUT/test.sec" "$PUBLIC"
	assert_refused 'secret key' test.sec
	rm -rf "$OUT" && mkdir -p "$OUT/keys"
	cp "$SECRET" "$OUT/keys/test.sec"
	run_index "$IPKS" "$OUT" "$OUT/keys/../keys/test.sec" "$PUBLIC"
	assert_refused 'secret key' keys
}

test_feed_refuses_unsigned_release() {
	run_index "$IPKS" "$OUT" "" "$PUBLIC"
	assert_refused usage
	run_index "$IPKS" "$OUT" "$WORK/keys/missing.sec" "$PUBLIC"
	assert_refused 'secret key'
	run_index "$IPKS" "$OUT" "$SECRET" "$WORK/keys/missing.pub"
	assert_refused 'public key'

	SIGNER=$WORK/missing/usign
	run_index
	assert_refused usign
	SIGNER=$BIN/usign

	INDEXER=$WORK/missing/opkg-make-index
	run_index
	assert_refused opkg-make-index
	INDEXER=$BIN/opkg-make-index

	FAKE_USIGN_SIGN_FAILS=1
	export FAKE_USIGN_SIGN_FAILS
	run_index
	assert_refused 'signing Packages failed'
	unset FAKE_USIGN_SIGN_FAILS

	# The index must verify with the public key users import.
	make_keys "$WORK/keys/other"
	run_index "$IPKS" "$OUT" "$SECRET" "$WORK/keys/other.pub"
	assert_refused 'does not verify'

	# An existing feed directory is never replaced or merged into.
	mkdir "$OUT/$ARCH"
	printf 'old\n' >"$OUT/$ARCH/Packages"
	run_index
	assert_refused exists "$ARCH"
	[ "$(ls -A "$OUT/$ARCH")" = Packages ] && [ "$(cat "$OUT/$ARCH/Packages")" = old ] ||
		fail "existing feed directory was modified"
}

test_feed_requires_exactly_both_packages() {
	mv "$IPKS/$LUCI_IPK" "$WORK/"
	run_index
	assert_refused luci-app-cfddns
	mv "$WORK/$LUCI_IPK" "$IPKS/"

	mv "$IPKS/$CORE_IPK" "$IPKS/cfddns_0.3.0-2_aarch64_generic.ipk"
	run_index
	assert_refused "cfddns_\*_$ARCH.ipk"
	mv "$IPKS/cfddns_0.3.0-2_aarch64_generic.ipk" "$IPKS/$CORE_IPK"

	printf 'older core\n' >"$IPKS/cfddns_0.2.0-1_$ARCH.ipk"
	run_index
	assert_refused "cfddns_\*_$ARCH.ipk"
	rm "$IPKS/cfddns_0.2.0-1_$ARCH.ipk"

	printf 'other\n' >"$IPKS/luci-base_1_all.ipk"
	run_index
	assert_refused luci-base_1_all.ipk
	rm "$IPKS/luci-base_1_all.ipk"

	# The index itself must list both packages.
	printf 'Package: cfddns\n' >"$WORK/manifest"
	FAKE_INDEX_FILE=$WORK/manifest
	export FAKE_INDEX_FILE
	run_index
	assert_refused luci-app-cfddns
}

# OpenWrt pads Packages when (64 + size) % 128 is 110 or 111 because usign's
# SHA-512 code mis-signs those lengths; devices may still run such a usign.
test_feed_index_pads_for_usign_bug() {
	FAKE_INDEX_FILE=$WORK/manifest
	export FAKE_INDEX_FILE
	for size in 173 174 175 176; do
		rm -rf "$OUT" && mkdir "$OUT"
		index_of_size "$size"
		run_index
		assert_ok
		feed=$OUT/$ARCH
		got=$(wc -c <"$feed/Packages" | tr -d ' ')
		case $size in
		174 | 175) want=$((size + 2)) ;;
		*) want=$size ;;
		esac
		[ "$got" = "$want" ] || fail "a $size-byte index became $got bytes, want $want"
		gzip -dc "$feed/Packages.gz" | cmp -s - "$feed/Packages" || fail "Packages.gz does not match Packages"
		"$SIGNER" -V -q -m "$feed/Packages" -p "$PUBLIC" -x "$feed/Packages.sig" ||
			fail "Packages.sig does not verify after padding"
	done
}

test_build_feed_checks_inputs() {
	sdk=$WORK/sdk
	mkdir "$sdk"
	sh "$BUILD" "$sdk" 0.2.0 "$OUT" "$SECRET" >"$WORK/stdout" 2>"$WORK/stderr"
	RC=$?
	assert_refused PKG_VERSION
	sh "$BUILD" "$sdk" 0.3.0 "$OUT" "$SECRET" >"$WORK/stdout" 2>"$WORK/stderr"
	RC=$?
	assert_refused SDK
	sh "$BUILD" "$sdk" 0.3.0 "$OUT" >"$WORK/stdout" 2>"$WORK/stderr"
	RC=$?
	assert_refused usage
	[ -z "$(ls -A "$sdk")" ] || fail "build-feed.sh changed the SDK before validating its inputs"
}

test_build_feed_with_fake_sdk() {
	sdk=$WORK/sdk
	FAKE_IPKS=$WORK/fake-ipks
	FAKE_SDK_LOG=$WORK/sdk.log
	FAKE_PKG_HASH=$(sed -n 's/^PKG_HASH:=//p' "$PKG_MK")
	export FAKE_IPKS FAKE_SDK_LOG FAKE_PKG_HASH
	make_fake_sdk "$sdk"
	# The fake usign only compares key ids, so a throwaway secret key with the
	# committed public key's id stands in for the real signing key.
	secret=$WORK/keys/feed.sec
	(umask 077 && printf 'untrusted comment: throwaway test secret key\n%s %s\n' \
		"$(sed -n 2p "$ROOT/cfddns.pub")" "$SENTINEL" >"$secret")

	# "make feed" exports its command-line variables to build-feed.sh, and
	# OpenWrt's make also reads OUTPUT_DIR: the SDK must not see them.
	fake_build "$CORE_CONTROL" "$LUCI_CONTROL" "release binary"
	PATH=$BIN:$PATH "$REAL_MAKE" -s --no-print-directory -C "$ROOT" feed SDK_DIR="$sdk" \
		CORE_VERSION=0.3.0 OUTPUT_DIR="$OUT" FEED_KEY="$secret" >"$WORK/stdout" 2>"$WORK/stderr"
	RC=$?
	assert_ok
	# shellcheck disable=SC2012 # the test controls every file name here
	[ "$(ls -A "$OUT")" = "$ARCH" ] ||
		fail "output must hold only $ARCH/, got: $(ls -A "$OUT" | tr '\n' ' ')"
	# The SDK's promptless CONFIG_LUCI_JSMIN=y must be overridden: there is no
	# jsmin without luci-base, and the JavaScript ships as tested.
	for ipk in "$CORE_IPK" "$LUCI_IPK"; do
		cmp -s "$FAKE_IPKS/plain/$ipk" "$OUT/$ARCH/$ipk" || fail "$ipk not built without minification"
	done
	for f in Packages Packages.gz Packages.manifest Packages.sig; do
		[ -f "$OUT/$ARCH/$f" ] || fail "feed lacks $f"
	done
	printf 'src-git luci https://example.invalid/luci.git^0123abc\nsrc-link cfddns %s\n' "$ROOT" |
		cmp -s - "$sdk/feeds.conf" ||
		fail "feeds.conf must hold the SDK's luci feed and this feed: $(cat "$sdk/feeds.conf")"
	grep -qx 'feeds uninstall luci-base' "$FAKE_SDK_LOG" || fail "luci-base must be uninstalled before the build"
	[ ! -L "$sdk/package/feeds/luci/luci-base" ] || fail "luci-base still installed"
	grep -qxF 'build-feed:   Depends: cfddns (>=0.3.0-2), libc, luci-base, cfddns' "$WORK/stdout" ||
		fail "build-feed must report the LuCI Depends line: $(cat "$WORK/stdout")"

	for breakage in core-arch luci-arch luci-unversioned core-binary luci-extra-file luci-changed-file; do
		rm -rf "$OUT" && mkdir "$OUT"
		core=$CORE_CONTROL luci=$LUCI_CONTROL binary="release binary" change=
		case $breakage in
		core-arch)
			core=$(printf '%s\n' "$CORE_CONTROL" | sed 's/^Architecture: .*/Architecture: all/')
			want="Architecture: $ARCH"
			;;
		luci-arch)
			luci=$(printf '%s\n' "$LUCI_CONTROL" | sed "s/^Architecture: .*/Architecture: $ARCH/")
			want='Architecture: all'
			;;
		luci-unversioned)
			luci=$(printf '%s\n' "$LUCI_CONTROL" | sed 's/^Depends: .*/Depends: libc, luci-base, cfddns/')
			want='cfddns (>=0.3.0-2)'
			;;
		core-binary)
			binary="rebuilt binary"
			want=PKG_HASH
			;;
		luci-extra-file)
			change=www/luci-static/resources/cfddns/status.js.o
			want='differ'
			;;
		luci-changed-file)
			change=www/luci-static/resources/view/cfddns.js
			want='differ'
			;;
		esac
		fake_build "$core" "$luci" "$binary" "$change"
		run_build "$sdk" 0.3.0 "$OUT" "$secret"
		assert_refused "$want"
	done
}

test_preinst_detects_manual_install() {
	PREINST=$WORK/preinst
	preinst_from_make >"$PREINST" || fail "make could not expand Package/cfddns/preinst"
	[ "$(head -n 1 "$PREINST")" = '#!/bin/sh' ] || fail "preinst must start with #!/bin/sh"

	clean=$WORK/root-clean
	mkdir -p "$clean/usr/bin" "$clean/etc/init.d"
	run_preinst "$clean" install
	[ "$RC" = 0 ] && [ ! -s "$WORK/stderr" ] ||
		fail "first install on a clean root: exit $RC, stderr: $(cat "$WORK/stderr")"

	all=$WORK/root-all
	for path in $MANUAL_PATHS; do
		for kind in file dangling-symlink; do
			root=$WORK/root-$kind$(printf %s "$path" | tr / -)
			for r in "$root" "$all"; do
				[ "$kind" = file ] || [ "$r" = "$root" ] || continue
				mkdir -p "$r${path%/*}"
				case $kind in
				file) printf 'manual\n' >"$r$path" ;;
				*) ln -s "$r/missing-target" "$r$path" ;;
				esac
			done
			for args in install 'install 0.3.0-2'; do
				# shellcheck disable=SC2086 # split into opkg's arguments
				run_preinst "$root" $args
				[ "$RC" = 1 ] || fail "$kind $path: preinst $args exit $RC, want 1"
				grep -qF -- "$path" "$WORK/stderr" || fail "$kind $path: stderr does not name it"
				grep -qF 'cfddns -uninstall' "$WORK/stderr" || fail "$kind $path: no migration hint"
				[ ! -s "$WORK/stdout" ] || fail "$kind $path: unexpected stdout"
			done
			run_preinst "$root" upgrade 0.2.0-1
			[ "$RC" = 0 ] && [ ! -s "$WORK/stderr" ] ||
				fail "$kind $path: upgrade must pass through, exit $RC: $(cat "$WORK/stderr")"
			case $kind in
			file) [ "$(cat "$root$path")" = manual ] || fail "$path was modified" ;;
			*) [ -L "$root$path" ] || fail "symlink $path was removed" ;;
			esac
		done
	done

	run_preinst "$all" install
	[ "$RC" = 1 ] || fail "all manual files: exit $RC, want 1"
	for path in $MANUAL_PATHS; do
		grep -qF -- "$path" "$WORK/stderr" || fail "all manual files: stderr does not name $path"
	done

	# Only IPKG_INSTROOT is inspected: the conflicting roots above stay
	# invisible to an install into the clean root.
	run_preinst "$clean" install
	[ "$RC" = 0 ] || fail "files outside IPKG_INSTROOT were reported"
}

# Stock firmware may not let opkg check signatures, so the README must have
# users verify the index opkg just downloaded, against this feed's key only,
# before the first opkg install.
test_readme_verifies_index_before_install() {
	fp=$(key_fingerprint "$ROOT/cfddns.pub")
	[ -n "$fp" ] || fail "cannot read the fingerprint of cfddns.pub"
	names=$(grep -oE '[0-9a-f]{16,}' "$README" | sort -u)
	[ "$names" = "$fp" ] || fail "README names key fingerprints '$names', want only $fp from cfddns.pub"
	feed=$(readme_feed_name)
	[ -n "$feed" ] || fail "README must add the $ARCH feed with a src/gz line"

	readme_commands >"$WORK/commands"
	update=$(command_line 'opkg update$')
	fetch=$(command_line "wget -O [^ ]+ https://xjetry\\.github\\.io/cfddns-openwrt/$ARCH/Packages\\.sig$")
	verify=$(command_line '.*usign -V ')
	install=$(command_line 'opkg install ')
	[ -n "$update" ] && [ -n "$fetch" ] && [ -n "$verify" ] && [ -n "$install" ] ||
		fail "README must show opkg update, wget of Packages.sig, usign -V and opkg install commands"
	[ "$update" -lt "$fetch" ] && [ "$fetch" -lt "$verify" ] && [ "$verify" -lt "$install" ] ||
		fail "README order is opkg update:$update Packages.sig:$fetch usign -V:$verify opkg install:$install; want them in that order"

	# opkg saves a src/gz list as the downloaded Packages.gz, but the signature
	# covers Packages: like opkg-key verify, decompress the list into usign.
	sig=$(sed -n "${fetch}p" "$README" | awk '{ print $3 }')
	list=/var/opkg-lists/$feed
	line=$(sed -n "${verify}p" "$README")
	case $line in
	"(zcat $list 2>/dev/null || cat $list) | usign -V "*) ;;
	*) fail "usign -V must read the decompressed list: (zcat $list 2>/dev/null || cat $list) | usign -V -m - ...; got: $line" ;;
	esac
	m='' x='' p=''
	set -f
	# shellcheck disable=SC2086 # split the usign arguments into words
	set -- ${line#*"| usign -V "}
	set +f
	while [ $# -gt 0 ]; do
		case $1 in
		-m) m=$2 ;;
		-x) x=$2 ;;
		-p) p=$2 ;;
		-P) fail "usign -V -P accepts every key in a directory; pin this feed's key with -p" ;;
		-q) fail "usign -V -q does not print the OK the README asks for" ;;
		esac
		shift
	done
	[ "$m" = - ] || fail "usign -V must read the decompressed list from stdin (-m -), not '$m'"
	[ "$x" = "$sig" ] || fail "usign -V must use the downloaded signature $sig, not '$x'"
	[ "$p" = "/etc/opkg/keys/$fp" ] || fail "usign -V must pin -p /etc/opkg/keys/$fp, not '$p'"
	# shellcheck disable=SC2016 # literal Markdown code span
	sed -n "${verify},${install}p" "$README" | grep -qF '不要执行 `opkg install`' ||
		fail "README must tell users to stop before opkg install when usign -V fails"
}

# Runs the README's usign -V command against real files. opkg saves a src/gz
# list as the downloaded Packages.gz while the signature covers Packages, so
# usign -V -m on the list itself fails. Uses the fake usign, or a real usign
# named by CFDDNS_TEST_USIGN with a key pair generated here.
test_readme_verify_command_checks_the_gzip_list() {
	if [ -n "${CFDDNS_TEST_USIGN:-}" ]; then
		# Not a symlink: the SDK's usign finds its loader relative to itself.
		printf '#!/bin/sh\nexec "%s" "$@"\n' "$CFDDNS_TEST_USIGN" >"$SIGNER"
		rm -f "$SECRET" "$PUBLIC"
		(umask 077 && "$SIGNER" -G -s "$SECRET" -p "$PUBLIC" -c 'throwaway test key') >/dev/null 2>&1 ||
			fail "usign -G failed"
	fi
	# macOS zcat only reads .Z files; busybox and GNU zcat are gzip -dc.
	printf '#!/bin/sh\nexec gzip -dc "$@"\n' >"$BIN/zcat"
	chmod +x "$BIN/zcat"
	lists=$WORK/lists
	list=$lists/$(readme_feed_name)
	mkdir "$lists"
	cmd=$(readme_verify_command "$lists" "$WORK/Packages.sig" "$PUBLIC") ||
		fail "README lacks the Packages.sig download or the usign -V command"
	printf 'Package: cfddns\nVersion: 0.3.0-2\n\nPackage: luci-app-cfddns\nVersion: 0.1.1\n' >"$WORK/Packages"
	"$SIGNER" -S -m "$WORK/Packages" -s "$SECRET" -x "$WORK/Packages.sig" >/dev/null 2>&1 ||
		fail "cannot sign the test index"

	for kind in gzip plain direct tampered; do
		run=$cmd
		case $kind in
		gzip) gzip -9nc "$WORK/Packages" >"$list" ;;
		plain) cp "$WORK/Packages" "$list" ;;
		direct)
			# The README's round-1 form, on the list as opkg saves it.
			gzip -9nc "$WORK/Packages" >"$list"
			run="usign -V -m $list -x $WORK/Packages.sig -p $PUBLIC"
			;;
		tampered) sed 's/0\.3\.0-2/0.3.0-3/' "$WORK/Packages" | gzip -9nc >"$list" ;;
		esac
		PATH=$BIN:$PATH sh -c "$run" >"$WORK/out" 2>&1
		RC=$?
		if grep -qx OK "$WORK/out"; then ok=1; else ok=0; fi
		case $kind in
		gzip | plain)
			if [ "$RC" != 0 ] || [ "$ok" = 0 ]; then
				fail "$kind list: README command exit $RC, want OK: $(cat "$WORK/out")"
			fi
			;;
		*)
			if [ "$RC" = 0 ] || [ "$ok" = 1 ]; then
				fail "$kind list: verification passed, want a failure: $(cat "$WORK/out")"
			fi
			;;
		esac
	done
}

# The README's command-line setup must keep the Token out of process arguments
# and shell history. Its commands run here as written, with a fake uci that
# records its arguments, its stdin and the Token file's mode.
test_readme_keeps_token_out_of_argv() {
	token='SENTINEL-not-a-real-cloudflare-token'
	file=$WORK/cfddns.token
	! grep -qE 'uci[^|]*set[^|]*token' "$README" || fail "README must not set the Token as a uci argument"
	readme_commands >"$WORK/commands"
	grep -E '^[0-9]+:.*/tmp/cfddns\.token' "$WORK/commands" | cut -d: -f2- |
		sed "s|/tmp/cfddns\.token|$file|g" >"$WORK/readme-token.sh"
	[ "$(wc -l <"$WORK/readme-token.sh" | tr -d ' ')" = 3 ] ||
		fail "README must write, use and delete /tmp/cfddns.token: $(cat "$WORK/readme-token.sh")"
	cat >"$BIN/uci" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >>"$WORK/uci-args"
cat >>"$WORK/uci-stdin"
ls -ln "$file" | cut -c1-10 >"$WORK/uci-mode"
EOF
	chmod +x "$BIN/uci"
	printf '%s\n' "$token" | (umask 022 && PATH=$BIN:$PATH "$TEST_SH" "$WORK/readme-token.sh") >"$WORK/stdout" 2>"$WORK/stderr"
	RC=$?
	assert_ok
	[ ! -s "$WORK/stdout" ] && [ ! -s "$WORK/stderr" ] ||
		fail "README commands printed: $(cat "$WORK/stdout" "$WORK/stderr")"
	[ "$(cat "$WORK/uci-args")" = batch ] || fail "uci must only get 'batch': $(cat "$WORK/uci-args")"
	[ "$(cat "$WORK/uci-stdin")" = "set cfddns.main.token='$token'" ] ||
		fail "unexpected uci batch input: $(cat "$WORK/uci-stdin")"
	[ "$(cat "$WORK/uci-mode")" = -rw------- ] || fail "Token file mode is $(cat "$WORK/uci-mode")"
	[ ! -e "$file" ] || fail "the README must delete the Token file"
}

# Exit 3 is what makes clearing credentials safe to document, so the README
# has to say what happens.
test_readme_documents_cleared_credentials() {
	# shellcheck disable=SC2016 # literal Markdown code spans
	grep -F '/etc/cfddns.env' "$README" | grep -F '`token`' | grep -F '`domain_v4`' | grep -qF '删除' ||
		fail "README must say that an empty token or both empty domains remove /etc/cfddns.env"
}

TESTS="
test_feed_layout_and_index
test_feed_signature_contains_no_private_key
test_feed_refuses_unsigned_release
test_feed_requires_exactly_both_packages
test_feed_index_pads_for_usign_bug
test_build_feed_checks_inputs
test_build_feed_with_fake_sdk
test_preinst_detects_manual_install
test_readme_verifies_index_before_install
test_readme_verify_command_checks_the_gzip_list
test_readme_keeps_token_out_of_argv
test_readme_documents_cleared_credentials
"

passed=0
failed=0
for t in $TESTS; do
	setup "$t"
	if ("$t"); then
		echo "PASS $t"
		passed=$((passed + 1))
	else
		echo "FAIL $t"
		failed=$((failed + 1))
	fi
done
echo "feed tests: $passed passed, $failed failed"
[ "$failed" = 0 ]
