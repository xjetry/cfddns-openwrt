'use strict';
// Tests for the luci-app-cfddns menu entry and rpcd ACL: the page may only
// read and write UCI cfddns, list the procd service, commit UCI, run the exact
// commands service.js uses and read the status file and run the inspection
// status.js uses. Run with: node --test tests/js/acl_test.cjs

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

test('test_acl_exact_capabilities', () => {
	const acl = readJSON(ACL);
	assert.deepEqual(Object.keys(acl), ['luci-app-cfddns']);
	const group = acl['luci-app-cfddns'];
	assert.equal(typeof group.description, 'string');

	// Spelled out so a failure names the offending grant before the whole
	// file is compared below.
	for (const perm of ['read', 'write']) {
		assert.deepEqual(group[perm].uci, ['cfddns'], `${perm}: UCI other than cfddns`);
		for (const [path, ops] of Object.entries(group[perm].file)) {
			assert.ok(/^\/[^*?[\s]*( [^*?[\s]+)*$/.test(path), `${perm}: file pattern ${path}`);
			assert.ok(ops.length === 1 && ['read', 'exec'].includes(ops[0]), `${perm}: ${path} ${ops}`);
		}
		for (const object of Object.keys(group[perm].ubus))
			assert.ok(['file', 'service', 'uci'].includes(object), `${perm}: ubus object ${object}`);
		assert.ok(!('cgi-io' in group[perm]), `${perm}: cgi-io`);
	}
	assert.deepEqual(group.read.ubus.service, ['list'], 'service: only list');
	assert.ok(!('service' in group.write.ubus), 'service: no write methods');
	assert.deepEqual(group.read.file['/var/run/cfddns.status'], ['read']);
	assert.deepEqual(group.read.file['/usr/bin/cfddns -inspect'], ['exec']);
	assert.ok(!('/usr/bin/cfddns' in group.read.file) && !('/usr/bin/cfddns' in group.write.file),
		'cfddns may only run as -inspect');

	assert.deepEqual(group, {
		description: group.description,
		read: {
			file: {
				[`${INIT} enabled`]: ['exec'],
				'/var/run/cfddns.status': ['read'],
				'/usr/bin/cfddns -inspect': ['exec'],
			},
			ubus: {
				file: ['exec', 'read'],
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
