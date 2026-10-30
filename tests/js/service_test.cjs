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
	// Turning the service off must not depend on a valid config, so disable
	// and stop run before the env is regenerated.
	const { service, log } = setup();
	const res = await service.apply(false);
	assert.deepEqual(log, [COMMIT, { exec: `${INIT} disable` }, { exec: `${INIT} stop` }, { exec: GEN }]);
	assert.deepEqual(plain(res), { unconfigured: false });
});

test('test_apply_disabled_with_cleared_credentials_resolves', async () => {
	// Generator exit 3: Token or both domains are empty and the env is gone.
	// That is what the user asked for, not a failure.
	const stderr = 'cfddns-config: token empty, removed /etc/cfddns.env\n';
	const { service, log } = setup({ exec: { [GEN]: { code: 3, stderr } } });
	const res = await service.apply(false);
	assert.deepEqual(log, [COMMIT, { exec: `${INIT} disable` }, { exec: `${INIT} stop` }, { exec: GEN }]);
	assert.deepEqual(plain(res), { unconfigured: true });
});

test('test_apply_enabled_with_cleared_credentials_stops', async () => {
	// The env is gone, so nothing may keep running on the config the daemon
	// loaded earlier, and the service must not be enabled or restarted.
	const stderr = 'cfddns-config: domain_v4 and domain_v6 empty, removed /etc/cfddns.env\n';
	{
		const { service, log } = setup({ exec: { [GEN]: { code: 3, stderr } } });
		const err = await rejection(service.apply(true));
		assert.deepEqual(log, [COMMIT, { exec: GEN }, { exec: `${INIT} stop` }]);
		assert.equal(err.message, 'Token 和至少一个域名为必填，服务已停止');
	}

	// A failed stop must not be reported as stopped.
	{
		const { service, log } = setup({
			exec: { [GEN]: { code: 3, stderr }, [`${INIT} stop`]: { code: 1, stderr: 'boom stop\n' } },
		});
		const err = await rejection(service.apply(true));
		assert.deepEqual(log, [COMMIT, { exec: GEN }, { exec: `${INIT} stop` }]);
		assert.match(err.message, /boom stop/);
		assert.doesNotMatch(err.message, /服务已停止/);
	}
});

test('test_apply_disabled_with_invalid_config_still_stops', async () => {
	for (const [code, stderr] of [[1, 'cfddns-config: domain_v4 is not a valid host name\n'],
		[1, 'cfddns-config: period must be whole h/m/s units\n'], [2, 'sh: syntax error\n'], [127, 'not found\n']]) {
		const { service, log } = setup({ exec: { [GEN]: { code, stderr } } });
		const err = await rejection(service.apply(false));
		assert.deepEqual(log, [COMMIT, { exec: `${INIT} disable` }, { exec: `${INIT} stop` }, { exec: GEN }]);
		assert.match(err.message, /^服务已停止并已取消开机自启，但配置无效：/);
		assert.ok(err.message.endsWith(stderr.trim()), err.message);
	}

	// An rpcd-level generator error still reports that the service is off.
	{
		const { service, log } = setup({ exec: { [GEN]: 6 } });
		const err = await rejection(service.apply(false));
		assert.deepEqual(log, [COMMIT, { exec: `${INIT} disable` }, { exec: `${INIT} stop` }, { exec: GEN }]);
		assert.match(err.message, /^服务已停止并已取消开机自启/);
	}
});

test('test_apply_rejects_non_boolean', async () => {
	for (const value of ['1', '0', 1, 0, null, undefined]) {
		const { service, log } = setup();
		await rejection(service.apply(value));
		assert.deepEqual(log, [], `apply(${JSON.stringify(value)})`);
	}
});

test('test_apply_failure_stops_sequence', async () => {
	// Enabling: a config-generation failure stops before any service
	// operation, and the rejection carries the generator's diagnostic.
	for (const code of [1, 2, 127]) {
		const stderr = 'cfddns-config: period must be whole h/m/s units\n';
		const { service, log } = setup({ exec: { [GEN]: { code, stderr } } });
		const err = await rejection(service.apply(true));
		assert.match(err.message, /cfddns-config: period must be whole h\/m\/s units/);
		assert.doesNotMatch(err.message, /已停止/);
		assert.deepEqual(log, [COMMIT, { exec: GEN }]);
	}
	{
		const { service, log } = setup({ exec: { [GEN]: 6 } });
		await rejection(service.apply(true));
		assert.deepEqual(log, [COMMIT, { exec: GEN }]);
	}

	// The commit must succeed before anything reads UCI.
	for (const enabled of [true, false]) {
		const { service, log } = setup({ ubus: { 'uci.commit': () => [6] } });
		await rejection(service.apply(enabled));
		assert.deepEqual(log, [COMMIT], `apply(${enabled})`);
	}

	// Every service step stops the sequence and reports its stderr; when
	// disabling, the generator never runs after a failed disable or stop.
	const sequences = [
		[true, [GEN, `${INIT} enable`, `${INIT} restart`], [`${INIT} enable`, `${INIT} restart`]],
		[false, [`${INIT} disable`, `${INIT} stop`, GEN], [`${INIT} disable`, `${INIT} stop`]],
	];
	for (const [enabled, order, failing] of sequences) {
		for (const cmd of failing) {
			const { service, log } = setup({ exec: { [cmd]: { code: 1, stderr: `boom ${cmd}\n` } } });
			const err = await rejection(service.apply(enabled));
			assert.match(err.message, new RegExp(`boom ${cmd}`));
			assert.doesNotMatch(err.message, /已停止/);
			const want = [COMMIT].concat(order.slice(0, order.indexOf(cmd) + 1).map((c) => ({ exec: c })));
			assert.deepEqual(log, want, `apply(${enabled}) failing at ${cmd}`);
		}
	}

	// An rpcd-level exec error (e.g. permission denied) also rejects.
	{
		const { service, log } = setup({ exec: { [`${INIT} enable`]: 6 } });
		await rejection(service.apply(true));
		assert.deepEqual(log, [COMMIT, { exec: GEN }, { exec: `${INIT} enable` }]);
	}
	{
		const { service, log } = setup({ exec: { [`${INIT} disable`]: 6 } });
		await rejection(service.apply(false));
		assert.deepEqual(log, [COMMIT, { exec: `${INIT} disable` }]);
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

	// Cleared credentials are no different here: the init script is not run.
	for (const name of ['start', 'restart']) {
		const stderr = 'cfddns-config: token empty, removed /etc/cfddns.env\n';
		const { service, log } = setup({ exec: { [GEN]: { code: 3, stderr } } });
		const err = await rejection(service.action(name));
		assert.match(err.message, /token empty/);
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
