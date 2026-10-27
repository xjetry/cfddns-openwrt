#!/bin/sh
# Tests for cfddns-config, the UCI -> env file generator, driven by a fake uci
# placed first in PATH. Run with: make test-config
#
# CFDDNS_TEST_SH selects the shell that runs the generator (default: sh), so
# the same tests can exercise dash or busybox ash.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
GEN=$ROOT/net/network/cfddns/files/cfddns-config
TEST_SH=${CFDDNS_TEST_SH:-sh}
# Obviously invalid sentinel; it must never appear in generator output.
TOKEN=SENTINEL-not-a-real-cloudflare-token

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cfddns-config-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP_ROOT"' EXIT

setup() {
	WORK=$TMP_ROOT/$1
	ENV_FILE=$WORK/etc/cfddns.env
	mkdir -p "$WORK/bin" "$WORK/etc"
	reset_uci
	cat >"$WORK/bin/uci" <<'EOF'
#!/bin/sh
# Fake uci: answers only "uci -q get cfddns.main[.<option>]" from $FAKE_UCI_DIR.
[ "$1" = -q ] && [ "$2" = get ] || exit 2
case $3 in
cfddns.main)
	[ -e "$FAKE_UCI_DIR/.section" ] || exit 1
	echo cfddns
	;;
cfddns.main.*)
	value=$FAKE_UCI_DIR/${3#cfddns.main.}
	[ -f "$value" ] || exit 1
	cat "$value"
	echo
	;;
*)
	exit 1
	;;
esac
EOF
	chmod +x "$WORK/bin/uci"
}

reset_uci() {
	rm -rf "$WORK/uci"
	mkdir -p "$WORK/uci"
	: >"$WORK/uci/.section"
}

# opt NAME VALUE stores a UCI option of cfddns.main for the fake uci.
opt() {
	printf '%s' "$2" >"$WORK/uci/$1"
}

unset_opt() {
	rm -f "$WORK/uci/$1"
}

valid_config() {
	opt enabled 1
	opt domain_v4 home.example.com
	opt domain_v6 home6.example.com
	opt v6_iface br-lan
	opt token "$TOKEN"
	opt period 2m
}

fail() {
	echo "    $*"
	exit 1
}

# run_gen runs the generator with a permissive umask and a UTF-8 locale so it
# has to enforce the file mode and byte checks itself.
run_gen() {
	(
		umask 022
		CFDDNS_ENV_FILE=$ENV_FILE FAKE_UCI_DIR=$WORK/uci PATH=$WORK/bin:$PATH LC_ALL=en_US.UTF-8 \
			"$TEST_SH" "$GEN"
	) >"$WORK/stdout" 2>"$WORK/stderr"
	RC=$?
	if grep -qF -- "$TOKEN" "$WORK/stdout" "$WORK/stderr"; then
		fail "sentinel Token leaked into generator output"
	fi
}

assert_ok() {
	[ "$RC" = 0 ] || fail "exit status $RC, want 0; stderr: $(cat "$WORK/stderr")"
	[ ! -s "$WORK/stdout" ] || fail "unexpected stdout: $(cat "$WORK/stdout")"
	[ ! -s "$WORK/stderr" ] || fail "unexpected stderr: $(cat "$WORK/stderr")"
}

# assert_failed [WORD]: non-zero exit, no stdout, and WORD named on stderr.
assert_failed() {
	[ "$RC" != 0 ] || fail "generator succeeded, want failure"
	[ ! -s "$WORK/stdout" ] || fail "unexpected stdout: $(cat "$WORK/stdout")"
	[ -s "$WORK/stderr" ] || fail "failure without a diagnostic on stderr"
	if [ -n "$1" ] && ! grep -q -- "$1" "$WORK/stderr"; then
		fail "stderr does not mention $1: $(cat "$WORK/stderr")"
	fi
}

# assert_env compares the env file with the expected content on stdin.
assert_env() {
	cat >"$WORK/expected"
	[ -f "$ENV_FILE" ] || fail "env file not written"
	cmp -s "$WORK/expected" "$ENV_FILE" || fail "env file differs:
$(diff "$WORK/expected" "$ENV_FILE")"
}

assert_no_env() {
	[ ! -e "$ENV_FILE" ] || fail "env file written: $(cat "$ENV_FILE")"
}

# assert_mode uses ls so it works with both BSD and GNU/busybox userlands.
assert_mode() {
	# shellcheck disable=SC2012
	mode=$(ls -ln "$ENV_FILE" | cut -c1-10)
	[ "$mode" = "$1" ] || fail "env file mode $mode, want $1"
}

assert_only_env_in_dir() {
	entries=$(ls -A "$WORK/etc")
	[ "$entries" = cfddns.env ] || fail "unexpected files next to the env file: $entries"
}

test_full_config_writes_expected_env() {
	valid_config
	run_gen
	assert_ok
	assert_env <<EOF
CFDDNS_V4=home.example.com
CFDDNS_V6=home6.example.com
CFDDNS_V6_IFACE=br-lan
CFDDNS_TOKEN=$TOKEN
CFDDNS_PERIOD=2m
EOF
	assert_mode -rw-------
}

test_optional_values_are_omitted() {
	opt domain_v4 home.example.com
	opt domain_v6 ''
	opt v6_iface ''
	opt token "$TOKEN"
	run_gen
	assert_ok
	# An unset period is written as the core default, never left implicit.
	assert_env <<EOF
CFDDNS_V4=home.example.com
CFDDNS_TOKEN=$TOKEN
CFDDNS_PERIOD=5m
EOF

	unset_opt domain_v4
	opt domain_v6 home6.example.com
	opt period ''
	run_gen
	assert_ok
	assert_env <<EOF
CFDDNS_V6=home6.example.com
CFDDNS_TOKEN=$TOKEN
CFDDNS_PERIOD=5m
EOF
}

test_disabled_still_generates_env() {
	valid_config
	opt enabled 0
	run_gen
	assert_ok
	assert_env <<EOF
CFDDNS_V4=home.example.com
CFDDNS_V6=home6.example.com
CFDDNS_V6_IFACE=br-lan
CFDDNS_TOKEN=$TOKEN
CFDDNS_PERIOD=2m
EOF
}

test_missing_token_fails() {
	valid_config
	unset_opt token
	run_gen
	assert_failed token
	assert_no_env

	opt token ''
	run_gen
	assert_failed token
	assert_no_env
}

test_missing_both_domains_fails() {
	valid_config
	opt domain_v4 ''
	unset_opt domain_v6
	unset_opt v6_iface
	run_gen
	assert_failed domain
	assert_no_env
}

test_missing_uci_section_fails() {
	valid_config
	rm "$WORK/uci/.section"
	run_gen
	assert_failed cfddns.main
	assert_no_env
}

test_invalid_config_preserves_existing_env() {
	printf 'CFDDNS_V4=old.example.com\nCFDDNS_TOKEN=old-SENTINEL\nCFDDNS_PERIOD=5m\n' >"$ENV_FILE"
	chmod 600 "$ENV_FILE"
	cp "$ENV_FILE" "$WORK/original"
	for breakage in no-section no-token no-domain unsafe-token bad-domain bad-iface bad-period; do
		reset_uci
		valid_config
		case $breakage in
		no-section) rm "$WORK/uci/.section" ;;
		no-token) unset_opt token ;;
		no-domain) opt domain_v4 '' && opt domain_v6 '' && opt v6_iface '' ;;
		unsafe-token) opt token "$TOKEN;" ;;
		bad-domain) opt domain_v4 home_.example.com ;;
		bad-iface) opt domain_v6 '' ;;
		bad-period) opt period 5s ;;
		esac
		run_gen
		assert_failed
		cmp -s "$WORK/original" "$ENV_FILE" || fail "$breakage: existing env file changed"
		assert_mode -rw-------
		assert_only_env_in_dir
	done
}

test_env_unsafe_value_fails_without_echoing_token() {
	tab=$(printf '\t')
	# shellcheck disable=SC1003 # '\' is a literal backslash
	for bad in ' ' "$tab" '"' "'" '\' '#' ';' "$(printf '\001')" "$(printf '\177')" "$(printf '\303\251')" "
"; do
		valid_config
		opt token "$TOKEN${bad}x"
		run_gen
		assert_failed token
		assert_no_env

		opt token "$bad$TOKEN"
		run_gen
		assert_failed token
		assert_no_env
	done

	for name in domain_v4 domain_v6 v6_iface period; do
		valid_config
		opt "$name" 'x y'
		run_gen
		assert_failed "$name"
		assert_no_env
	done
}

test_token_is_written_literally() {
	valid_config
	# Shell metacharacters are valid env bytes and must not be expanded.
	opt token "$TOKEN\$(id)\`id\`\$HOME*"
	run_gen
	assert_ok
	assert_env <<EOF
CFDDNS_V4=home.example.com
CFDDNS_V6=home6.example.com
CFDDNS_V6_IFACE=br-lan
CFDDNS_TOKEN=$TOKEN\$(id)\`id\`\$HOME*
CFDDNS_PERIOD=2m
EOF
}

test_domains_are_normalized() {
	valid_config
	opt domain_v4 Home.Example.COM.
	opt domain_v6 HOME6.example.com
	run_gen
	assert_ok
	assert_env <<EOF
CFDDNS_V4=home.example.com
CFDDNS_V6=home6.example.com
CFDDNS_V6_IFACE=br-lan
CFDDNS_TOKEN=$TOKEN
CFDDNS_PERIOD=2m
EOF
}

test_invalid_domain_fails() {
	label63=$(printf '%063d' 0 | tr 0 a)
	long=$label63.$label63.$label63.$label63
	for name in domain_v4 domain_v6; do
		for bad in localhost -home.example.com home-.example.com home..example.com \
			.example.com home.example.com.. home_x.example.com "a$label63.example.com" "$long.com"; do
			valid_config
			opt "$name" "$bad"
			run_gen
			assert_failed "$name"
			assert_no_env
		done
	done

	# Limits are inclusive: 63-byte labels and 253-byte names are valid.
	valid_config
	opt domain_v4 "$label63.example.com"
	opt domain_v6 "$label63.$label63.$label63.$(printf '%061d' 0 | tr 0 b)"
	run_gen
	assert_ok
}

test_v6_iface_requires_domain_v6() {
	valid_config
	opt domain_v6 ''
	run_gen
	assert_failed v6_iface
	assert_no_env

	valid_config
	opt v6_iface br/lan
	run_gen
	assert_failed v6_iface
	assert_no_env
}

test_period_is_validated() {
	for good in 10s 5m 1h 1h30m 5m0s 0h0m10s 90s; do
		valid_config
		opt period "$good"
		run_gen
		assert_ok
		grep -qx "CFDDNS_PERIOD=$good" "$ENV_FILE" || fail "period $good not written verbatim"
	done

	rm -f "$ENV_FILE"
	for bad in 9s 0s 0m 5 m 1.5m 500ms 5m1h 1m1m -5m +5m 1d 1234567s; do
		valid_config
		opt period "$bad"
		run_gen
		assert_failed period
		assert_no_env
	done
}

test_atomic_replace_leaves_no_temp_file() {
	printf 'CFDDNS_V4=old.example.com\n' >"$ENV_FILE"
	ln "$ENV_FILE" "$WORK/old-link"
	valid_config
	run_gen
	assert_ok
	assert_env <<EOF
CFDDNS_V4=home.example.com
CFDDNS_V6=home6.example.com
CFDDNS_V6_IFACE=br-lan
CFDDNS_TOKEN=$TOKEN
CFDDNS_PERIOD=2m
EOF
	# A rename leaves the old inode untouched; an in-place rewrite would not.
	[ "$(cat "$WORK/old-link")" = CFDDNS_V4=old.example.com ] ||
		fail "env file was rewritten in place instead of replaced"
	assert_mode -rw-------
	assert_only_env_in_dir
}

TESTS="
test_full_config_writes_expected_env
test_optional_values_are_omitted
test_disabled_still_generates_env
test_missing_token_fails
test_missing_both_domains_fails
test_missing_uci_section_fails
test_invalid_config_preserves_existing_env
test_env_unsafe_value_fails_without_echoing_token
test_token_is_written_literally
test_domains_are_normalized
test_invalid_domain_fails
test_v6_iface_requires_domain_v6
test_period_is_validated
test_atomic_replace_leaves_no_temp_file
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
echo "config tests: $passed passed, $failed failed"
[ "$failed" = 0 ]
