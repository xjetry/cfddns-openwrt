'use strict';
// Tests for the luci-app-cfddns menu entry and rpcd ACL: the page may only
// read and write UCI cfddns, list the procd service, commit UCI and run the
// exact commands service.js uses. Run with: node --test tests/js/acl_test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../../luci/applications/luci-app-cfddns/root/usr/share');
const ACL = path.join(ROOT, 'rpcd/acl.d/luci-app-cfddns.json');
const MENU = path.join(ROOT, 'luci/menu.d/luci-app-cfddns.json');

const INIT = '/etc/init.d/cfddns';

function readJSON(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('test_acl_grants_exact_capabilities', () => {
	const acl = readJSON(ACL);
	assert.deepEqual(Object.keys(acl), ['luci-app-cfddns']);
	const group = acl['luci-app-cfddns'];
	assert.equal(typeof group.description, 'string');
	assert.deepEqual(group, {
		description: group.description,
		read: {
			file: {
				[`${INIT} enabled`]: ['exec'],
			},
			ubus: {
				file: ['exec'],
				service: ['list'],
			},
			uci: ['cfddns'],
		},
		write: {
			file: {
				'/usr/libexec/cfddns-config': ['exec'],
				[`${INIT} start`]: ['exec'],
				[`${INIT} stop`]: ['exec'],
				[`${INIT} restart`]: ['exec'],
				[`${INIT} enable`]: ['exec'],
				[`${INIT} disable`]: ['exec'],
			},
			ubus: {
				file: ['exec'],
				uci: ['commit'],
			},
			uci: ['cfddns'],
		},
	});
});

test('test_acl_has_no_wildcards', () => {
	const walk = (value, where) => {
		if (typeof value === 'string')
			return assert.ok(!/[*?[]/.test(value), `wildcard in ${where}: ${value}`);
		for (const [k, v] of Object.entries(value)) {
			assert.ok(!/[*?[]/.test(k), `wildcard key in ${where}: ${k}`);
			walk(v, `${where}.${k}`);
		}
	};
	walk(readJSON(ACL), 'acl');
});

test('test_menu_entry', () => {
	assert.deepEqual(readJSON(MENU), {
		'admin/services/cfddns': {
			title: 'Cloudflare DDNS',
			order: 60,
			action: { type: 'view', path: 'cfddns' },
			depends: { acl: ['luci-app-cfddns'], uci: { cfddns: true } },
		},
	});
});
