#!/bin/sh
# shellcheck disable=SC2016 # expected Makefile and JavaScript text is literal
# Static checks for luci-app-cfddns: package Makefile, menu and ACL files and
# the settings view. Behaviour is tested by tests/js. Run with:
# make test-luci-static

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=$ROOT/luci/applications/luci-app-cfddns
APP_MK=$APP/Makefile
RES=$APP/htdocs/luci-static/resources
VIEW=$RES/view/cfddns.js
SERVICE=$RES/cfddns/service.js
MENU=$APP/root/usr/share/luci/menu.d/luci-app-cfddns.json
ACL=$APP/root/usr/share/rpcd/acl.d/luci-app-cfddns.json

fail() {
	echo "    $*"
	exit 1
}

require() {
	for f in "$@"; do
		[ -f "$f" ] || fail "missing ${f#"$ROOT"/}"
	done
}

# make_var NAME prints the value of a top-level "NAME:=value" assignment.
make_var() {
	sed -n "s/^$1:=//p" "$APP_MK"
}

# has_line TEXT: stdin contains TEXT as a whole line, ignoring indentation.
has_line() {
	sed 's/^[[:space:]]*//' | grep -qxF -- "$1"
}

# line_of TEXT: number of the first VIEW line containing TEXT, or nothing.
line_of() {
	grep -nF -- "$1" "$VIEW" | head -n 1 | cut -d: -f1
}

# option_block NAME prints the view's settings option NAME up to the next
# taboption.
option_block() {
	awk -v start="s.taboption('settings', " -v name="'$1'" '
		index($0, "s.taboption(") { inside = index($0, start) && index($0, name) }
		inside { print }
		/^[[:space:]]*this\.map = / { inside = 0 }
	' "$VIEW"
}

test_app_files_exist() {
	require "$APP_MK" "$VIEW" "$SERVICE" "$MENU" "$ACL"
}

test_js_syntax() {
	require "$VIEW" "$SERVICE"
	find "$ROOT/luci" "$ROOT/tests/js" -type f \( -name '*.js' -o -name '*.cjs' \) >"$TMP_ROOT/js"
	[ -s "$TMP_ROOT/js" ] || fail "no JavaScript files found"
	while IFS= read -r f; do
		node --check "$f" || fail "${f#"$ROOT"/} does not parse"
	done <"$TMP_ROOT/js"
}

test_json_syntax() {
	require "$MENU" "$ACL"
	for f in "$MENU" "$ACL"; do
		node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" ||
			fail "${f#"$ROOT"/} is not valid JSON"
	done
}

test_package_metadata() {
	require "$APP_MK"
	[ "$(make_var PKG_VERSION)" = 0.1.0 ] || fail "PKG_VERSION must be 0.1.0"
	[ "$(make_var PKG_RELEASE)" = 1 ] || fail "PKG_RELEASE must be 1"
	# luci.mk turns LUCI_PKGARCH into PKGARCH and LUCI_EXTRA_DEPENDS into the
	# versioned control-file dependency; plain DEPENDS cannot carry versions.
	[ "$(make_var LUCI_PKGARCH)" = all ] || fail "LUCI_PKGARCH (PKGARCH:=all) must be all"
	[ "$(make_var LUCI_DEPENDS)" = '+luci-base +cfddns' ] || fail "LUCI_DEPENDS must be +luci-base +cfddns"
	[ "$(make_var LUCI_EXTRA_DEPENDS)" = 'cfddns (>=0.3.0)' ] ||
		fail "LUCI_EXTRA_DEPENDS must be cfddns (>=0.3.0)"
	has_line 'include $(TOPDIR)/feeds/luci/luci.mk' <"$APP_MK" ||
		fail "Makefile must include the SDK's \$(TOPDIR)/feeds/luci/luci.mk"
	has_line '# call BuildPackage - OpenWrt buildroot signature' <"$APP_MK" ||
		fail "Makefile lacks the BuildPackage signature the OpenWrt scanner looks for"
}

test_menu_route() {
	require "$MENU"
	grep -qF '"admin/services/cfddns"' "$MENU" || fail "menu route must be admin/services/cfddns"
	grep -qF '"path": "cfddns"' "$MENU" || fail "menu must open view cfddns"
	grep -qF '"luci-app-cfddns"' "$MENU" || fail "menu must depend on the luci-app-cfddns ACL"
}

test_acl_has_no_wildcards() {
	require "$ACL"
	! grep -qF '*' "$ACL" || fail "ACL must not contain wildcards"
}

test_view_requires() {
	require "$VIEW"
	for dep in view form uci ui 'cfddns.service as service'; do
		grep -qx "'require $dep';" "$VIEW" || fail "view must 'require $dep'"
	done
}

test_view_tabs() {
	require "$VIEW"
	grep -qF "form.NamedSection, 'main', 'cfddns')" "$VIEW" || fail "view must bind NamedSection cfddns.main"
	status=$(line_of "s.tab('status', _('运行状态'));")
	settings=$(line_of "s.tab('settings', _('基本设置'));")
	[ -n "$status" ] || fail "missing tab status/运行状态"
	[ -n "$settings" ] || fail "missing tab settings/基本设置"
	[ "$status" -lt "$settings" ] || fail "运行状态 must be the first (default) tab"
	grep -qF "s.taboption('status', form.DummyValue, '_status'" "$VIEW" || fail "status tab needs its container option"
	grep -qF "'id': 'cfddns-status'" "$VIEW" || fail "status tab must render the #cfddns-status container"
}

test_view_settings_fields() {
	require "$VIEW"
	grep -qF "s.taboption('settings', form.Flag, 'enabled', _('启用')" "$VIEW" || fail "missing Flag enabled"
	for field in domain_v4 domain_v6 v6_iface token period; do
		grep -qF "s.taboption('settings', form.Value, '$field'," "$VIEW" || fail "missing Value $field"
	done
	n=$(grep -cF "s.taboption('settings', " "$VIEW")
	[ "$n" = 6 ] || fail "settings tab has $n fields, want exactly 6"
}

test_view_token_is_password() {
	require "$VIEW"
	option_block token | has_line 'o.password = true;' || fail "token must be a password input"
}

test_view_period_mirrors_generator() {
	require "$VIEW"
	block=$(option_block period)
	printf '%s\n' "$block" | has_line "o.default = '5m';" || fail "period must default to 5m"
	printf '%s\n' "$block" | grep -q 'validPeriod' || fail "period must use validPeriod"
	grep -qF '>= 10;' "$VIEW" || fail "validPeriod must require at least 10s"
	grep -qF '[0-9]{1,6}' "$VIEW" || fail "validPeriod must bound components to 6 digits like the generator"
	printf '%s\n' "$block" | grep -qF '10s' || fail "period help or error must name the 10s minimum"
}

test_view_actions_are_reset_and_save_apply() {
	require "$VIEW"
	grep -qx '	handleSave: null' "$VIEW" || grep -qx '	handleSave: null,' "$VIEW" ||
		fail "view must drop the plain Save button (handleSave: null)"
	grep -qF 'handleSaveApply: function(' "$VIEW" || fail "view must implement handleSaveApply"
	! grep -qF 'handleReset:' "$VIEW" || fail "view must keep LuCI's default Reset"
	! grep -qF 'ui.changes.apply' "$VIEW" || fail "view must not trigger LuCI's global apply"
	grep -qF 'map.save(null, true)' "$VIEW" || fail "Save & Apply must stage silently via map.save(null, true)"
}

TESTS="
test_app_files_exist
test_js_syntax
test_json_syntax
test_package_metadata
test_menu_route
test_acl_has_no_wildcards
test_view_requires
test_view_tabs
test_view_settings_fields
test_view_token_is_password
test_view_period_mirrors_generator
test_view_actions_are_reset_and_save_apply
"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cfddns-luci-static-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP_ROOT"' EXIT

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
echo "LuCI static tests: $passed passed, $failed failed"
[ "$failed" = 0 ]
