'use strict';
// Tests for cfddns/service.js, the LuCI service controller, with fake fs and
// rpc modules. Run with: node --test tests/js/service_test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule, baseclass, plain, fakeRpc, fakeFs } = require('./luci_vm.cjs');

const SERVICE = path.join(__dirname,
	'../../luci/applications/luci-app-cfddns/htdocs/luci-static/resources/cfddns/service.js');
const GEN = '/usr/libexec/cfddns-config';
const INIT = '/etc/init.d/cfddns';
const COMMANDS = [GEN].concat(['start', 'stop', 'restart', 'enable', 'disable', 'enabled'].map((v) => `${INIT} ${v}`));

const COMMIT = { ubus: 'uci.commit', params: { config: 'cfddns' } };
const GET_ENABLED = { ubus: 'uci.get', params: { config: 'cfddns', section: 'main', option: 'enabled' } };
const SERVICE_LIST = { ubus: 'service.list', params: { name: 'cfddns' } };

function running(instances) {
	return [0, { cfddns: { instances } }];
}

// setup loads service.js against fakes. exec maps a command line to its
// { code, stdout, stderr } reply (or an rpcd status number); ubus maps
// 'object.method' to a ubus [status, data] reply. Unlisted known commands
// succeed; anything else fails the test.
function setup({ exec = {}, ubus = {} } = {}) {
	const log = [];
	const fs = fakeFs(log, (cmdline) => {
		if (cmdline in exec)
			return exec[cmdline];
		if (COMMANDS.includes(cmdline))
			return { code: 0 };
		throw new Error(`unexpected command ${cmdline}`);
	});
	const rpc = fakeRpc(log, Object.assign({
		'uci.commit': () => [0],
		'uci.get': () => [0, { value: '1' }],
		'service.list': () => [0, {}],
	}, ubus));
	const service = loadModule(SERVICE, { baseclass, fs, rpc });
	return { service, log };
}

async function rejection(promise) {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	assert.fail('promise resolved, want a rejection');
}

function assertNoUciWrites(log) {
	for (const entry of log) {
		if (entry.ubus)
			assert.ok(['uci.get', 'service.list'].includes(entry.ubus), `unexpected ubus call ${entry.ubus}`);
		if (entry.exec)
			assert.ok(!/ (enable|disable)$/.test(entry.exec), `unexpected command ${entry.exec}`);
	}
}

test('test_apply_enabled_sequence', async () => {
	const { service, log } = setup();
	await service.apply(true);
	assert.deepEqual(log, [COMMIT, { exec: GEN }, { exec: `${INIT} enable` }, { exec: `${INIT} restart` }]);
});

test('test_apply_disabled_sequence', async () => {
	const { service, log } = setup();
	await service.apply(false);
	assert.deepEqual(log, [COMMIT, { exec: GEN }, { exec: `${INIT} disable` }, { exec: `${INIT} stop` }]);
});

test('test_apply_rejects_non_boolean', async () => {
	for (const value of ['1', '0', 1, 0, null, undefined]) {
		const { service, log } = setup();
		await rejection(service.apply(value));
		assert.deepEqual(log, [], `apply(${JSON.stringify(value)})`);
	}
});

test('test_apply_failure_stops_sequence', async () => {
	// A config-generation failure stops before any service operation, and
	// the rejection carries the generator's diagnostic.
	{
		const stderr = 'cfddns-config: token is required\n';
		const { service, log } = setup({ exec: { [GEN]: { code: 1, stderr } } });
		const err = await rejection(service.apply(true));
		assert.match(err.message, /cfddns-config: token is required/);
		assert.deepEqual(log, [COMMIT, { exec: GEN }]);
	}

	// The commit must succeed before the generator reads UCI.
	{
		const { service, log } = setup({ ubus: { 'uci.commit': () => [6] } });
		await rejection(service.apply(true));
		assert.deepEqual(log, [COMMIT]);
	}

	// Every later step stops the sequence too and reports its stderr.
	for (const [enabled, steps] of [[true, ['enable', 'restart']], [false, ['disable', 'stop']]]) {
		for (let i = 0; i < steps.length; i++) {
			const failing = `${INIT} ${steps[i]}`;
			const { service, log } = setup({ exec: { [failing]: { code: 1, stderr: `boom ${steps[i]}\n` } } });
			const err = await rejection(service.apply(enabled));
			assert.match(err.message, new RegExp(`boom ${steps[i]}`));
			const want = [COMMIT, { exec: GEN }].concat(steps.slice(0, i + 1).map((s) => ({ exec: `${INIT} ${s}` })));
			assert.deepEqual(log, want, `apply(${enabled}) failing at ${steps[i]}`);
		}
	}

	// An rpcd-level exec error (e.g. permission denied) also rejects.
	{
		const { service, log } = setup({ exec: { [`${INIT} enable`]: 6 } });
		await rejection(service.apply(true));
		assert.deepEqual(log, [COMMIT, { exec: GEN }, { exec: `${INIT} enable` }]);
	}
});

test('test_manual_action_does_not_write_uci', async () => {
	{
		const { service, log } = setup();
		await service.action('stop');
		assert.deepEqual(log, [{ exec: `${INIT} stop` }]);
	}
	for (const name of ['start', 'restart']) {
		const { service, log } = setup();
		await service.action(name);
		assert.deepEqual(log, [GET_ENABLED, { exec: GEN }, { exec: `${INIT} ${name}` }]);
		assertNoUciWrites(log);
	}
});

test('test_manual_action_rejects_unknown_names', async () => {
	const names = ['enable', 'disable', 'enabled', 'reload', 'boot', 'running', '', 'Start', 'start ', ' stop',
		'stop;reboot', 'restart\n', 'constructor', '__proto__', 'toString', undefined, null, 1, ['start']];
	for (const name of names) {
		const { service, log } = setup();
		await rejection(service.action(name));
		assert.deepEqual(log, [], `action(${JSON.stringify(name)})`);
	}
});

test('test_manual_start_requires_uci_enabled', async () => {
	// UCI disabled or option missing: refuse with guidance, run nothing.
	for (const reply of [[0, { value: '0' }], [0, { value: '' }], [4]]) {
		for (const name of ['start', 'restart']) {
			const { service, log } = setup({ ubus: { 'uci.get': () => reply } });
			const err = await rejection(service.action(name));
			assert.match(err.message, /基本设置/);
			assert.match(err.message, /保存并应用/);
			assert.deepEqual(log, [GET_ENABLED], `${name} with uci reply ${JSON.stringify(reply)}`);
		}
	}

	// A failed UCI read is an error, not "disabled", and runs nothing.
	{
		const { service, log } = setup({ ubus: { 'uci.get': () => [6] } });
		const err = await rejection(service.action('start'));
		assert.doesNotMatch(err.message, /基本设置/);
		assert.deepEqual(log, [GET_ENABLED]);
	}

	// Stop is always allowed: it only changes the current run state.
	{
		const { service, log } = setup({ ubus: { 'uci.get': () => [0, { value: '0' }] } });
		await service.action('stop');
		assert.deepEqual(log, [{ exec: `${INIT} stop` }]);
	}
});

test('test_manual_start_runs_generator_first', async () => {
	for (const name of ['start', 'restart']) {
		const stderr = 'cfddns-config: period must be whole h/m/s units\n';
		const { service, log } = setup({ exec: { [GEN]: { code: 1, stderr } } });
		const err = await rejection(service.action(name));
		assert.match(err.message, /period must be whole h\/m\/s units/);
		assert.deepEqual(log, [GET_ENABLED, { exec: GEN }]);
	}
});

test('test_manual_action_failure_carries_stderr', async () => {
	for (const name of ['start', 'stop', 'restart']) {
		const { service } = setup({ exec: { [`${INIT} ${name}`]: { code: 1, stderr: `procd said no to ${name}\n` } } });
		const err = await rejection(service.action(name));
		assert.match(err.message, new RegExp(`procd said no to ${name}`));
	}
});

test('test_getState', async () => {
	const cases = [
		{ list: running({ instance1: { running: true, pid: 42 } }), boot: 0, uci: '1', want: { running: true, enabled: true } },
		{ list: running({ instance1: { running: true } }), boot: 1, uci: '1', want: { running: true, enabled: false } },
		{ list: [0, {}], boot: 0, uci: '1', want: { running: false, enabled: true } },
		{ list: [0, {}], boot: 1, uci: '0', want: { running: false, enabled: false } },
		// First install: the init script is boot-enabled while UCI is 0.
		{ list: [0, {}], boot: 0, uci: '0', want: { running: false, enabled: false } },
		{ list: running({ instance1: { running: false } }), boot: 0, uci: '1', want: { running: false, enabled: true } },
		{ list: running({ a: { running: false }, b: { running: true } }), boot: 0, uci: '1', want: { running: true, enabled: true } },
		{ list: [0, { cfddns: {} }], boot: 0, uci: '1', want: { running: false, enabled: true } },
	];
	for (const c of cases) {
		const { service, log } = setup({
			exec: { [`${INIT} enabled`]: { code: c.boot } },
			ubus: { 'service.list': () => c.list, 'uci.get': () => [0, { value: c.uci }] },
		});
		assert.deepEqual(plain(await service.getState()), c.want, JSON.stringify(c));
		assert.deepEqual([...log].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
			[GET_ENABLED, SERVICE_LIST, { exec: `${INIT} enabled` }].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
		assertNoUciWrites(log);
	}

	// A missing UCI option means disabled, like config_get_bool.
	{
		const { service } = setup({ ubus: { 'uci.get': () => [4] } });
		assert.deepEqual(plain(await service.getState()), { running: false, enabled: false });
	}
});

test('test_getState_errors', async () => {
	{
		const { service } = setup({ exec: { [`${INIT} enabled`]: { code: 2, stderr: 'enabled: bad things\n' } } });
		const err = await rejection(service.getState());
		assert.match(err.message, /enabled: bad things/);
	}
	{
		const { service } = setup({ ubus: { 'service.list': () => [6] } });
		await rejection(service.getState());
	}
	{
		const { service } = setup({ ubus: { 'uci.get': () => [6] } });
		await rejection(service.getState());
	}
});
