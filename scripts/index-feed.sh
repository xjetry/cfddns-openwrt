#!/bin/sh
# Assemble the signed opkg feed: copy the cfddns and luci-app-cfddns ipks to
# OUTPUT_DIR/aarch64_cortex-a53, index them the way OpenWrt's package/index
# does, sign Packages with usign and verify the signature with the public key
# users import. The feed directory only appears once every step succeeded.
#
# Usage: index-feed.sh IPK_DIR OUTPUT_DIR SECRET_KEY PUBLIC_KEY
# Environment: OPKG_MAKE_INDEX (default: opkg-make-index) is run as
# "OPKG_MAKE_INDEX ." inside the feed and prints the full Packages manifest;
# USIGN (default: usign) signs and verifies.

set -eu

ARCH=aarch64_cortex-a53

die() {
	echo "index-feed: $*" >&2
	exit 1
}

if [ $# != 4 ] || [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ] || [ -z "$4" ]; then
	die "usage: index-feed.sh IPK_DIR OUTPUT_DIR SECRET_KEY PUBLIC_KEY"
fi

# abs PATH prints PATH relative to the current directory as an absolute path.
abs() {
	case $1 in
	/*) printf '%s\n' "$1" ;;
	*) printf '%s/%s\n' "$(pwd)" "$1" ;;
	esac
}

# tool NAME prints NAME as an absolute path if it names a file, or unchanged
# if it is a command on PATH; it fails if neither exists.
tool() {
	case $1 in
	*/*) [ -f "$1" ] && [ -x "$1" ] && abs "$1" ;;
	*) command -v "$1" >/dev/null 2>&1 && printf '%s\n' "$1" ;;
	esac
}

IPK_DIR=$1
OUTPUT_DIR=$(abs "$2")
SECRET_KEY=$(abs "$3")
PUBLIC_KEY=$(abs "$4")

[ -d "$IPK_DIR" ] || die "IPK_DIR is not a directory: $IPK_DIR"
[ -f "$SECRET_KEY" ] && [ -r "$SECRET_KEY" ] || die "secret key not found or unreadable: $SECRET_KEY"
[ -f "$PUBLIC_KEY" ] || die "public key not found: $PUBLIC_KEY"
INDEXER=$(tool "${OPKG_MAKE_INDEX:-opkg-make-index}") ||
	die "opkg-make-index not found: ${OPKG_MAKE_INDEX:-opkg-make-index} (set OPKG_MAKE_INDEX)"
USIGN=$(tool "${USIGN:-usign}") || die "usign not found: ${USIGN:-usign} (set USIGN)"

# single DESCRIPTION FILE... prints the only FILE that exists.
single() {
	desc=$1
	shift
	found=
	n=0
	for f in "$@"; do
		[ -f "$f" ] || continue
		found=$f
		n=$((n + 1))
	done
	[ "$n" = 1 ] || die "want exactly one $desc in $IPK_DIR, found $n"
	printf '%s\n' "$found"
}

CORE_IPK=$(single "cfddns_*_$ARCH.ipk" "$IPK_DIR"/cfddns_*_"$ARCH".ipk)
LUCI_IPK=$(single "luci-app-cfddns_*_all.ipk" "$IPK_DIR"/luci-app-cfddns_*_all.ipk)
for f in "$IPK_DIR"/* "$IPK_DIR"/.[!.]* "$IPK_DIR"/..?*; do
	[ -e "$f" ] || [ -L "$f" ] || continue
	case $f in
	"$CORE_IPK" | "$LUCI_IPK") ;;
	*) die "unexpected file in $IPK_DIR: ${f##*/}" ;;
	esac
done

# The output directory is published as a whole, so the signing key must not
# live anywhere below it.
if [ -d "$OUTPUT_DIR" ]; then
	out=$(cd "$OUTPUT_DIR" && pwd -P)
	key_dir=$(cd "$(dirname "$SECRET_KEY")" && pwd -P)
	case $key_dir/ in
	"$out"/*) die "the secret key must be kept outside OUTPUT_DIR: $SECRET_KEY" ;;
	esac
fi

mkdir -p "$OUTPUT_DIR"
FEED=$OUTPUT_DIR/$ARCH
if [ -e "$FEED" ] || [ -L "$FEED" ]; then
	die "$FEED already exists; remove it or choose another OUTPUT_DIR"
fi

STAGE=$(mktemp -d "$OUTPUT_DIR/.$ARCH.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
chmod 755 "$STAGE"
cp "$CORE_IPK" "$LUCI_IPK" "$STAGE/"

(cd "$STAGE" && "$INDEXER" . >Packages.manifest) || die "opkg-make-index failed"
grep -vE '^(Maintainer|LicenseFiles|Source|SourceName|Require|SourceDateEpoch)' \
	"$STAGE/Packages.manifest" >"$STAGE/Packages" || [ $? = 1 ]
for name in cfddns luci-app-cfddns; do
	grep -qx "Package: $name" "$STAGE/Packages" || die "the index does not list $name"
done
size=$(wc -c <"$STAGE/Packages" | tr -d ' ')
case $(((64 + size) % 128)) in
110 | 111)
	echo "index-feed: padding Packages to work around the usign SHA-512 bug" >&2
	printf '\n\n' >>"$STAGE/Packages"
	;;
esac
gzip -9nc "$STAGE/Packages" >"$STAGE/Packages.gz"

"$USIGN" -S -m "$STAGE/Packages" -s "$SECRET_KEY" -x "$STAGE/Packages.sig" ||
	die "signing Packages failed"
"$USIGN" -V -q -m "$STAGE/Packages" -p "$PUBLIC_KEY" -x "$STAGE/Packages.sig" ||
	die "Packages.sig does not verify with $PUBLIC_KEY"

chmod 644 "$STAGE"/*
mv "$STAGE" "$FEED"
echo "index-feed: wrote $FEED"
