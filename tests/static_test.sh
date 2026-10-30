#!/bin/sh
# shellcheck disable=SC2016 # expected Makefile and shell text is literal
# Static checks for the cfddns package: UCI defaults, procd init script,
# config generator and package Makefile. Run with: make test-static

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG=$ROOT/net/network/cfddns
PKG_MK=$PKG/Makefile
UCI_DEFAULTS=$PKG/files/cfddns.config
INIT=$PKG/files/cfddns.init
GEN=$PKG/files/cfddns-config
DAEMON_COMMAND="/usr/bin/cfddns -status-file /var/run/cfddns.status"
CORE_URL=https://github.com/xjetry/cfddns/releases/download/v0.3.0/cfddns-linux-arm64

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cfddns-static-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
	echo "    $*"
	exit 1
}

require() {
	for f in "$@"; do
		[ -f "$f" ] || fail "missing ${f#"$ROOT"/}"
	done
}

# make_define NAME prints the body of "define NAME ... endef" from the package
# Makefile, with make's $$ escapes turned back into the shell's $.
make_define() {
	awk -v name="$1" '
		$0 == "define " name { inside = 1; next }
		inside && $0 == "endef" { exit }
		inside { print }
	' "$PKG_MK" | sed 's/\$\$/$/g'
}

# make_var NAME prints the value of a top-level "NAME:=value" assignment.
make_var() {
	sed -n "s/^$1:=//p" "$PKG_MK"
}

# shell_function FILE NAME prints the body of "NAME() {" up to its closing
# "}" in column one.
shell_function() {
	awk -v name="$2" '
		$0 == name "() {" { inside = 1; next }
		inside && $0 == "}" { exit }
		inside { print }
	' "$1"
}

# has_line TEXT: stdin contains TEXT as a whole line, ignoring indentation.
has_line() {
	sed 's/^[[:space:]]*//' | grep -qxF -- "$1"
}

# line_number PATTERN: first stdin line matching PATTERN, or nothing.
line_number() {
	grep -n -- "$1" | head -n 1 | cut -d: -f1
}

# exact_line_number TEXT: first stdin line equal to TEXT, ignoring indentation.
exact_line_number() {
	sed 's/^[[:space:]]*//' | grep -nxF -- "$1" | head -n 1 | cut -d: -f1
}

uci_default() {
	awk -v name="$1" '$1 == "option" && $2 == name { print $3 }' "$UCI_DEFAULTS"
}

test_uci_defaults() {
	require "$UCI_DEFAULTS"
	[ "$(grep -c '^config ' "$UCI_DEFAULTS")" = 1 ] || fail "want exactly one UCI section"
	grep -qx "config cfddns 'main'" "$UCI_DEFAULTS" || fail "section must be: config cfddns 'main'"
	! grep -q '^[[:space:]]*list ' "$UCI_DEFAULTS" || fail "UCI defaults must not use lists"
	names=$(awk '$1 == "option" { print $2 }' "$UCI_DEFAULTS" | sort | tr '\n' ' ')
	[ "$names" = "domain_v4 domain_v6 enabled period token v6_iface " ] ||
		fail "options are '$names', want exactly the approved six"
	[ "$(uci_default enabled)" = "'0'" ] || fail "enabled must default to '0'"
	[ "$(uci_default period)" = "'5m'" ] || fail "period must default to '5m'"
	for name in domain_v4 domain_v6 v6_iface token; do
		[ "$(uci_default "$name")" = "''" ] || fail "$name must default to empty"
	done
}

test_init_is_procd_service() {
	require "$INIT"
	[ "$(head -n 1 "$INIT")" = "#!/bin/sh /etc/rc.common" ] || fail "init must run under rc.common"
	grep -qx 'USE_PROCD=1' "$INIT" || fail "init must set USE_PROCD=1"
	grep -q '^START=[0-9][0-9]$' "$INIT" || fail "init must set START"
}

test_procd_command_exact() {
	require "$INIT"
	commands=$(grep 'procd_set_param command' "$INIT" | sed 's/^[[:space:]]*//')
	[ "$commands" = "procd_set_param command $DAEMON_COMMAND" ] ||
		fail "procd command is '$commands'"
	! grep -q 'procd_append_param command' "$INIT" || fail "procd command must not be extended"
	body=$(shell_function "$INIT" start_service)
	for param in respawn 'stdout 1' 'stderr 1'; do
		printf '%s\n' "$body" | has_line "procd_set_param $param" ||
			fail "start_service lacks procd_set_param $param"
	done
}

test_start_service_checks_enabled_then_generates_env() {
	require "$INIT"
	body=$(shell_function "$INIT" start_service)
	guard=$(printf '%s\n' "$body" | line_number 'enabled.*return 0')
	generate=$(printf '%s\n' "$body" | line_number '/usr/libexec/cfddns-config || return 1')
	launch=$(printf '%s\n' "$body" | line_number procd_open_instance)
	[ -n "$guard" ] || fail "start_service must return 0 without launching when disabled"
	[ -n "$generate" ] || fail "start_service must generate the env and stop on failure"
	[ -n "$launch" ] || fail "start_service must open a procd instance"
	[ "$guard" -lt "$generate" ] && [ "$generate" -lt "$launch" ] ||
		fail "start_service must check enabled, then generate the env, then launch"
}

test_stop_removes_status_file() {
	require "$INIT"
	shell_function "$INIT" stop_service | has_line 'rm -f /var/run/cfddns.status' ||
		fail "stop_service must remove /var/run/cfddns.status"
}

test_reload_regenerates_env_and_restarts_only_when_enabled() {
	require "$INIT"
	body=$(shell_function "$INIT" reload_service)
	generate=$(printf '%s\n' "$body" | line_number '/usr/libexec/cfddns-config')
	check=$(printf '%s\n' "$body" | line_number 'enabled')
	restart=$(printf '%s\n' "$body" | line_number '^[[:space:]]*restart$')
	[ "$generate" = 1 ] || fail "reload_service must first regenerate the env"
	[ -n "$check" ] && [ -n "$restart" ] && [ "$check" -lt "$restart" ] ||
		fail "reload_service must restart only after checking enabled"
}

# reload_calls GENERATOR_STATUS UCI_ENABLED runs reload_service with a generator
# exiting GENERATOR_STATUS and stubs for rc.common, and prints the init verbs it
# called and its return status.
reload_calls() {
	{
		printf 'uci_enabled() { [ %s = 1 ]; }\n' "$2"
		echo 'stop() { echo stop; }'
		echo 'restart() { echo restart; }'
		echo 'reload_service() {'
		shell_function "$INIT" reload_service | sed "s|/usr/libexec/cfddns-config|(exit $1)|"
		echo '}'
		echo 'reload_service'
		echo 'echo "return $?"'
	} >"$TMP_ROOT/reload"
	sh "$TMP_ROOT/reload" | tr '\n' ' '
}

# Generator exit 3 means Token or both domains are empty and the env is gone:
# no daemon may keep running on what it loaded earlier, and that is only an
# error when UCI still wants the service on.
test_reload_follows_generator_status() {
	require "$INIT"
	while read -r status enabled want; do
		got=$(reload_calls "$status" "$enabled")
		[ "$got" = "$want " ] ||
			fail "generator exit $status, UCI enabled $enabled: got '$got', want '$want '"
	done <<'EOF'
0 1 restart return 0
0 0 stop return 0
3 1 stop return 1
3 0 stop return 0
1 1 return 1
1 0 return 1
2 1 return 1
127 0 return 1
EOF
}

test_package_metadata() {
	require "$PKG_MK"
	[ "$(make_var PKG_NAME)" = cfddns ] || fail "PKG_NAME"
	[ "$(make_var PKG_VERSION)" = 0.3.0 ] || fail "PKG_VERSION must be 0.3.0"
	[ "$(make_var PKG_RELEASE)" = 2 ] || fail "PKG_RELEASE must be 2"
	url=$(make_var PKG_SOURCE_URL | sed 's/\$(PKG_VERSION)/0.3.0/')
	[ "${url%/}/$(make_var PKG_SOURCE_URL_FILE)" = "$CORE_URL" ] ||
		fail "source must be $CORE_URL"
	hash=$(make_var PKG_HASH)
	[ ${#hash} = 64 ] || fail "PKG_HASH must be a SHA256"
	case $hash in
	*[!0-9a-f]*) fail "PKG_HASH must be lower-case hex" ;;
	esac
	package=$(make_define Package/cfddns)
	printf '%s\n' "$package" | has_line 'PKGARCH:=aarch64_cortex-a53' ||
		fail "PKGARCH must be aarch64_cortex-a53"
	printf '%s\n' "$package" | grep -q '^[[:space:]]*DEPENDS:=.*+ca-bundle' ||
		fail "package must depend on ca-bundle"
}

test_package_installs_files_with_modes() {
	require "$PKG_MK"
	install=$(make_define Package/cfddns/install)
	for line in \
		'$(INSTALL_BIN) $(PKG_BUILD_DIR)/cfddns $(1)/usr/bin/cfddns' \
		'$(INSTALL_BIN) ./files/cfddns-config $(1)/usr/libexec/cfddns-config' \
		'$(INSTALL_BIN) ./files/cfddns.init $(1)/etc/init.d/cfddns' \
		'$(INSTALL_CONF) ./files/cfddns.config $(1)/etc/config/cfddns'; do
		printf '%s\n' "$install" | has_line "$line" || fail "install lacks: $line"
	done
	make_define Package/cfddns/conffiles | has_line /etc/config/cfddns ||
		fail "/etc/config/cfddns must be a conffile"
}

test_preinst_refuses_manual_install() {
	require "$PKG_MK"
	preinst=$(make_define Package/cfddns/preinst)
	[ -n "$preinst" ] || fail "package has no preinst"
	for text in /usr/bin/cfddns /etc/init.d/cfddns /etc/cfddns.env IPKG_INSTROOT upgrade 'exit 1'; do
		printf '%s\n' "$preinst" | grep -qF -- "$text" || fail "preinst does not handle $text"
	done
}

test_postrm_cleans_derived_files_only_on_remove() {
	require "$PKG_MK"
	postrm=$(make_define Package/cfddns/postrm)
	printf '%s\n' "$postrm" | has_line '[ "$1" = remove ] || exit 0' ||
		fail "postrm must act only on removal, not on upgrade"
	printf '%s\n' "$postrm" | grep -qF '/etc/cfddns.env' || fail "postrm must remove the derived env"
}

test_scripts_parse() {
	require "$INIT" "$GEN" "$PKG_MK"
	[ "$(head -n 1 "$GEN")" = "#!/bin/sh" ] || fail "cfddns-config needs a #!/bin/sh line"
	make_define Package/cfddns/preinst >"$TMP_ROOT/preinst"
	make_define Package/cfddns/postrm >"$TMP_ROOT/postrm"
	for script in "$INIT" "$GEN" "$TMP_ROOT/preinst" "$TMP_ROOT/postrm"; do
		[ -s "$script" ] || fail "empty script ${script##*/}"
		sh -n "$script" || fail "${script##*/} does not parse"
	done
	for script in "$TMP_ROOT/preinst" "$TMP_ROOT/postrm"; do
		[ "$(head -n 1 "$script")" = "#!/bin/sh" ] || fail "${script##*/} needs a #!/bin/sh line"
	done
}

test_token_stays_out_of_argv_and_logs() {
	require "$INIT" "$GEN" "$PKG_MK"
	! grep -v '^[[:space:]]*#' "$INIT" | grep -qi token || fail "init script must not handle the Token"
	make_define Package/cfddns/preinst >"$TMP_ROOT/preinst"
	make_define Package/cfddns/postrm >"$TMP_ROOT/postrm"
	for script in "$INIT" "$GEN" "$TMP_ROOT/preinst" "$TMP_ROOT/postrm"; do
		! grep -i 'procd_' "$script" | grep -qi token ||
			fail "${script##*/} passes the Token to procd"
		! grep -E 'logger|echo|printf|>&2' "$script" | grep -qE '\$\{?token' ||
			fail "${script##*/} logs or prints the Token"
	done
	# The generator may only read the Token, test it with builtins and write
	# it through the here-document.
	grep -E '\$\{?token' "$GEN" | sed 's/^[[:space:]]*//' | while IFS= read -r line; do
		case $line in
		'token=$(uci -q get cfddns.main.token)' | 'env_safe "$token" '* | '[ -n "$token" ] '* | 'CFDDNS_TOKEN=$token') ;;
		*) fail "unexpected use of the Token in cfddns-config: $line" ;;
		esac
	done || exit 1
}

# rpcd "file exec" lets a caller pass environment variables to a root process,
# so as root the generator must ignore CFDDNS_ENV_FILE and the caller's PATH,
# and must not let that PATH choose the id binary that decides it is root.
test_generator_ignores_overrides_as_root() {
	require "$GEN"
	code=$TMP_ROOT/cfddns-config.code
	grep -v '^[[:space:]]*#' "$GEN" >"$code"
	pin=$(exact_line_number 'PATH=/usr/sbin:/usr/bin:/sbin:/bin' <"$code")
	default=$(exact_line_number 'ENV_FILE=/etc/cfddns.env' <"$code")
	check=$(exact_line_number 'case $(id -u) in' <"$code")
	root=$(exact_line_number "'' | 0 | *[!0-9]*) ;;" <"$code")
	[ -n "$pin" ] && [ -n "$default" ] && [ -n "$check" ] ||
		fail "cfddns-config must pin PATH and ENV_FILE, then branch on: case \$(id -u) in"
	[ "$pin" -lt "$check" ] && [ "$default" -lt "$check" ] ||
		fail "PATH and ENV_FILE must be pinned before id runs"
	[ "$root" = $((check + 1)) ] ||
		fail "uid 0 and unknown uids must keep the pinned values: want \"'' | 0 | *[!0-9]*) ;;\" first"
	end=$(sed -n "$check,\$p" "$code" | exact_line_number 'esac')
	[ -n "$end" ] || fail "uid case is not closed"
	end=$((check + end - 1))
	# Overrides may only be honoured inside the non-root branch.
	grep -n -e CFDDNS_ENV_FILE -e 'PATH=' "$code" | cut -d: -f1 | while read -r n; do
		[ "$n" = "$pin" ] && continue
		[ "$n" -gt "$root" ] && [ "$n" -lt "$end" ] ||
			fail "line $n honours an override outside the non-root branch: $(sed -n "${n}p" "$code")"
	done || exit 1
	first_tool=$(grep -nE '(^|[^A-Za-z0-9_])(uci|mktemp|mv|rm) ' "$code" | head -n 1 | cut -d: -f1)
	[ -n "$first_tool" ] && [ "$first_tool" -gt "$end" ] ||
		fail "uci, mktemp, mv and rm must only run after the root check"
	# Removing the env is a root write too: only the pinned path may be named.
	has_line 'rm -f "$ENV_FILE" || fail "cannot remove $ENV_FILE"' <"$code" ||
		fail "cfddns-config must remove \$ENV_FILE and report a failed removal"
}

TESTS="
test_uci_defaults
test_init_is_procd_service
test_procd_command_exact
test_start_service_checks_enabled_then_generates_env
test_stop_removes_status_file
test_reload_regenerates_env_and_restarts_only_when_enabled
test_reload_follows_generator_status
test_package_metadata
test_package_installs_files_with_modes
test_preinst_refuses_manual_install
test_postrm_cleans_derived_files_only_on_remove
test_scripts_parse
test_token_stays_out_of_argv_and_logs
test_generator_ignores_overrides_as_root
"

passed=0
failed=0
for t in $TESTS; do
	if ("$t"); then
		echo "PASS $t"
		passed=$((passed + 1))
	else
		echo "FAIL $t"
		failed=$((failed + 1))
	fi
done
echo "static tests: $passed passed, $failed failed"
[ "$failed" = 0 ]
