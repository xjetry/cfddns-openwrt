'use strict';
// Tests for cfddns/status.js, the status tab: loading the daemon's status
// file and the read-only Cloudflare inspection, the merged view model and its
// rendering, with fake fs, dom, document and service modules. Run with:
// node --test tests/js/status_test.cjs

// Times are shown in the browser's zone; pin one without DST. node --test
// runs every file in its own process.
process.env.TZ = 'Asia/Shanghai';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule, baseclass, plain, fakeFs } = require('./luci_vm.cjs');

const STATUS = path.join(__dirname,
	'../../luci/applications/luci-app-cfddns/htdocs/luci-static/resources/cfddns/status.js');
const STATUS_FILE = '/var/run/cfddns.status';
const INSPECT = '/usr/bin/cfddns -inspect';

// Core v0.3.1 outputs (unchanged since v0.3.0), as in its README.
const LOCAL = {
	version: 1,
	started_at: '2026-10-27T08:00:00.412345678Z',
	written_at: '2026-10-27T08:05:01Z',
	period: '5m0s',
	families: [
		{
			family: 'ipv4', domain: 'home.example.com', record_type: 'A',
			detection: { at: '2026-10-27T08:05:00.218734Z', ip: '203.0.113.10', source: 'trace', error: '' },
			execution: { at: '2026-10-27T08:05:01.733901Z', action: 'unchanged', error: '', warning: '' },
		},
		{
			family: 'ipv6', domain: 'home6.example.com', record_type: 'AAAA',
			detection: { at: '2026-10-27T08:05:00.5Z', ip: '2001:db8::10', source: 'iface:br-lan', error: '' },
			execution: { at: '2026-10-27T08:05:01Z', action: 'updated', error: '', warning: '' },
		},
	],
};

function result(family, domain, fields) {
	return Object.assign({
		family, domain, record_type: family === 'ipv4' ? 'A' : 'AAAA',
		found: true, content: '', queried_at: '2026-10-27T08:10:00.531208Z', warning: '', error: '',
	}, fields);
}

const INSPECT_OK = {
	ok: true,
	results: [
		result('ipv4', 'home.example.com', { content: '203.0.113.10' }),
		result('ipv6', 'home6.example.com', { content: '2001:db8::99' }),
	],
};

const NO_ERRORS = { local: null, inspect: null, config: null };

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

function tick() {
	return new Promise((resolve) => setImmediate(resolve));
}

// setup loads status.js with fakes. read returns the status file text or an
// rpcd status number; exec returns the inspect reply { code, stdout, stderr },
// a promise of it, or an rpcd status number.
function setup({
	read = () => JSON.stringify(LOCAL),
	exec = () => ({ code: 0, stdout: JSON.stringify(INSPECT_OK) + '\n' }),
	getState = () => Promise.resolve({ running: true, enabled: true }),
	action = () => Promise.resolve(),
} = {}) {
	const log = [];
	const fs = fakeFs(log, (cmdline) => {
		assert.equal(cmdline, INSPECT, `unexpected command ${cmdline}`);
		return exec();
	}, (file) => {
		assert.equal(file, STATUS_FILE, `unexpected read ${file}`);
		return read();
	});
	const service = {
		getState() {
			log.push('getState');
			return getState();
		},
		action(name) {
			log.push({ action: name });
			return action(name);
		},
	};
	const dom = {
		content(node, children) {
			node.children = children == null ? [] : [].concat(children);
			return node;
		},
	};
	const document = {
		current: { tag: 'div', attrs: { id: 'cfddns-status' }, children: [] },
		getElementById(id) {
			return id === 'cfddns-status' ? this.current : null;
		},
	};
	const status = loadModule(STATUS, { baseclass, dom, fs, 'cfddns.service': service }, { document });
	return { status, log, document };
}

function payload(local, inspect, errors = {}) {
	return { local: clone(local), inspect: clone(inspect), errors: Object.assign({}, NO_ERRORS, errors) };
}

function model(status, p) {
	return plain(status.viewModel(p));
}

function text(node) {
	if (node == null)
		return '';
	if (Array.isArray(node))
		return node.map(text).join('\n');
	if (typeof node !== 'object')
		return String(node);
	return text(node.children || []);
}

function rendered(status, p) {
	return text(status.render(status.viewModel(p)));
}

function walk(node, fn) {
	if (node == null || typeof node !== 'object')
		return;
	fn(node);
	for (const child of node.children || [])
		walk(child, fn);
}

function buttons(root) {
	const found = {};
	walk(root, (n) => {
		if (n.tag === 'button')
			found[text(n)] = n;
	});
	return found;
}

function family(m, name, domain) {
	const f = m.families.find((x) => x.family === name && (domain === undefined || x.domain === domain));
	assert.ok(f, `family ${name} ${domain || ''} missing from ${JSON.stringify(m.families)}`);
	return f;
}

function count(log, entry) {
	return log.filter((e) => JSON.stringify(e) === JSON.stringify(entry)).length;
}

test('test_status_match_and_mismatch', (t) => {
	const { status } = setup();
	const m = model(status, payload(LOCAL, INSPECT_OK));
	assert.deepEqual(m.families.map((f) => [f.family, f.domain, f.recordType]),
		[['ipv4', 'home.example.com', 'A'], ['ipv6', 'home6.example.com', 'AAAA']]);
	assert.equal(family(m, 'ipv4').compare, 'match');
	assert.equal(family(m, 'ipv6').compare, 'mismatch');
	assert.equal(family(m, 'ipv6').cloudflare.state, 'found');
	assert.equal(family(m, 'ipv6').cloudflare.content, '2001:db8::99');
	const out = rendered(status, payload(LOCAL, INSPECT_OK));
	assert.match(out, /一致/);
	assert.match(out, /不一致/);
	assert.match(out, /2001:db8::99/);

	// IPv6 text differing only in case is the same address.
	const upper = clone(INSPECT_OK);
	upper.results[1].content = '2001:DB8::10';
	assert.equal(family(model(status, payload(LOCAL, upper)), 'ipv6').compare, 'match');
});

test('test_status_missing_record', () => {
	const { status } = setup();
	const inspect = {
		ok: false,
		results: [
			result('ipv4', 'home.example.com', { found: false }),
			result('ipv6', 'home6.example.com', { found: false, error: 'cloudflare api: Authentication error' }),
		],
	};
	const m = model(status, payload(LOCAL, inspect));
	assert.equal(family(m, 'ipv4').cloudflare.state, 'missing');
	assert.equal(family(m, 'ipv4').compare, 'missing');
	assert.equal(family(m, 'ipv6').cloudflare.state, 'error');
	assert.equal(family(m, 'ipv6').cloudflare.error, 'cloudflare api: Authentication error');
	assert.equal(family(m, 'ipv6').compare, 'error');
	const out = rendered(status, payload(LOCAL, inspect));
	assert.match(out, /记录不存在/);
	assert.match(out, /查询失败/);
	assert.match(out, /Authentication error/);
});

test('test_status_load_reads_status_and_inspects_once', async () => {
	const { status, log } = setup();
	const p = plain(await status.load());
	assert.deepEqual(p, { local: LOCAL, inspect: INSPECT_OK, errors: NO_ERRORS });
	// Exactly the two ACL-granted calls, and never an environment.
	assert.deepEqual(log, [{ read: STATUS_FILE }, { exec: INSPECT }]);

	// LuCI sends the RPC calls queued in one animation frame as one HTTP
	// request with one timeout, so the slow inspection starts only once the
	// status read has settled, whatever its outcome.
	for (const outcome of [() => JSON.stringify(LOCAL), () => 4, () => 6]) {
		const gate = deferred();
		const s = setup({ read: () => gate.promise.then(outcome) });
		const loading = s.status.load();
		await tick();
		assert.deepEqual(s.log, [{ read: STATUS_FILE }]);
		gate.resolve();
		const p = await loading;
		assert.deepEqual(s.log, [{ read: STATUS_FILE }, { exec: INSPECT }]);
		assert.deepEqual(plain(p.inspect), INSPECT_OK);
	}
});

test('test_status_independent_errors', async () => {
	// No status file (rpcd NOT_FOUND): no data, not an error; inspect kept.
	{
		const { status } = setup({ read: () => 4 });
		const p = await status.load();
		assert.deepEqual(plain(p), { local: null, inspect: INSPECT_OK, errors: NO_ERRORS });
		const m = model(status, p);
		assert.equal(m.local.state, 'nodata');
		assert.equal(m.local.error, null);
		assert.equal(m.period, null);
		assert.equal(family(m, 'ipv4').cloudflare.content, '203.0.113.10');
		assert.equal(family(m, 'ipv4').detection, null);
		assert.equal(family(m, 'ipv4').compare, 'nodata');
		const out = rendered(status, p);
		assert.match(out, /无数据/);
		assert.match(out, /203\.0\.113\.10/);
	}

	// Unreadable or unparsable status file: an error; inspect kept.
	for (const read of [() => 6, () => 5, () => '{"version":1,', () => '', () => '{"version":2}', () => '[1]']) {
		const { status } = setup({ read });
		const p = await status.load();
		assert.equal(p.local, null, String(read));
		assert.equal(typeof p.errors.local, 'string', String(read));
		assert.deepEqual(plain(p.inspect), INSPECT_OK);
		const m = model(status, p);
		assert.equal(m.local.state, 'error');
		assert.equal(family(m, 'ipv4').cloudflare.state, 'found');
		assert.match(rendered(status, p), /203\.0\.113\.10/);
	}
	{
		const { status } = setup({ read: () => 6 });
		const p = await status.load();
		assert.match(p.errors.local, /\/var\/run\/cfddns\.status/);
		assert.match(rendered(status, p), /rpcd status 6/);
	}

	// Inspect fails (rpcd error, bad output): local status kept.
	for (const exec of [() => 6, () => 7, () => ({ code: 0, stdout: 'not json' }), () => ({ code: 0 }),
		() => ({ code: 0, stdout: '{"ok":true}' })]) {
		const { status } = setup({ exec });
		const p = await status.load();
		assert.equal(p.inspect, null, String(exec));
		assert.equal(typeof p.errors.inspect, 'string', String(exec));
		assert.equal(p.errors.config, null);
		assert.deepEqual(plain(p.local), LOCAL);
		const m = model(status, p);
		assert.equal(m.inspect.state, 'error');
		assert.equal(m.period, '5 分钟');
		assert.equal(family(m, 'ipv4').detection.ip, '203.0.113.10');
		assert.equal(family(m, 'ipv4').cloudflare.state, 'error');
		assert.equal(family(m, 'ipv4').compare, 'error');
		const out = rendered(status, p);
		assert.match(out, /203\.0\.113\.10/);
		assert.match(out, /查询失败/);
	}
	{
		const { status } = setup({ exec: () => 6 });
		const p = await status.load();
		assert.match(p.errors.inspect, /\/usr\/bin\/cfddns -inspect/);
		assert.match(p.errors.inspect, /rpcd status 6/);
	}
});

test('test_status_not_configured', async () => {
	// Fresh install: no status file and inspect refuses the config on
	// stderr without JSON. Shown as "not configured", not as a crash.
	const stderr = '2026/10/29 08:00:00 cfddns -token is required\n';
	const { status } = setup({ read: () => 4, exec: () => ({ code: 1, stderr }) });
	const p = await status.load();
	assert.deepEqual(plain(p), { local: null, inspect: null, errors: { local: null, inspect: null, config: stderr.trim() } });
	const m = model(status, p);
	assert.equal(m.local.state, 'nodata');
	assert.equal(m.inspect.state, 'unconfigured');
	assert.deepEqual(m.families, []);
	const out = rendered(status, p);
	assert.match(out, /尚未配置/);
	assert.match(out, /基本设置/);
	assert.match(out, /-token is required/);
	assert.doesNotMatch(out, /查询失败/);

	// A rejected config while the daemon still runs the old one keeps the
	// local status visible.
	{
		const { status } = setup({ exec: () => ({ code: 1, stderr: 'cfddns at least one of -4 or -6 is required\n' }) });
		const m2 = model(status, await status.load());
		assert.equal(m2.inspect.state, 'unconfigured');
		assert.equal(family(m2, 'ipv4').detection.ip, '203.0.113.10');
	}
});

test('test_status_partial_families', () => {
	const { status } = setup();

	// IPv4 detection failed: execution.action is error with an empty error
	// and the reason only in detection.error. IPv4's query failed too.
	const local = clone(LOCAL);
	local.families[0].detection = { at: '2026-10-27T08:05:00Z', ip: '', source: '', error: 'trace: dial tcp4: network unreachable' };
	local.families[0].execution = { at: '2026-10-27T08:05:00Z', action: 'error', error: '', warning: '' };
	const inspect = clone(INSPECT_OK);
	inspect.ok = false;
	inspect.results[0] = result('ipv4', 'home.example.com', { found: false, error: 'zone lookup failed' });
	inspect.results[1].content = '2001:db8::10';
	{
		const m = model(status, payload(local, inspect));
		const v4 = family(m, 'ipv4');
		assert.equal(v4.detection.ip, '');
		assert.equal(v4.detection.error, 'trace: dial tcp4: network unreachable');
		assert.equal(v4.execution.action, 'error');
		assert.equal(v4.compare, 'error');
		assert.equal(family(m, 'ipv6').compare, 'match');
		const out = rendered(status, payload(local, inspect));
		assert.match(out, /network unreachable/);
		assert.match(out, /zone lookup failed/);
		assert.match(out, /2001:db8::10/);
	}

	// A family without results yet (detection/execution omitted) and a
	// family absent from inspect keep the other family intact.
	{
		const partial = clone(LOCAL);
		delete partial.families[1].detection;
		delete partial.families[1].execution;
		const one = { ok: true, results: [INSPECT_OK.results[0]] };
		const m = model(status, payload(partial, one));
		assert.equal(family(m, 'ipv4').compare, 'match');
		assert.equal(family(m, 'ipv6').detection, null);
		assert.equal(family(m, 'ipv6').execution, null);
		assert.equal(family(m, 'ipv6').cloudflare.state, 'nodata');
		assert.equal(family(m, 'ipv6').compare, 'nodata');
	}

	// Merged by family and domain: a domain the daemon no longer runs with
	// is a separate entry, not compared with the new one.
	{
		const old = clone(LOCAL);
		old.families[0].domain = 'old.example.com';
		const m = model(status, payload(old, INSPECT_OK));
		assert.deepEqual(m.families.map((f) => [f.family, f.domain]),
			[['ipv4', 'old.example.com'], ['ipv6', 'home6.example.com'], ['ipv4', 'home.example.com']]);
		assert.equal(family(m, 'ipv4', 'old.example.com').compare, 'nodata');
		assert.equal(family(m, 'ipv4', 'home.example.com').compare, 'nodata');
		assert.equal(family(m, 'ipv4', 'home.example.com').cloudflare.content, '203.0.113.10');
	}

	// Entries that are not one of the two documented families are ignored.
	{
		const odd = clone(LOCAL);
		odd.families.push({ family: 'ipx', domain: 'x.example.com', record_type: 'X' }, { family: 'ipv4' }, null, 'ipv4');
		const m = model(status, payload(odd, INSPECT_OK));
		assert.equal(m.families.length, 2);
	}
});

test('test_status_times_and_period', () => {
	const { status } = setup();
	const local = clone(LOCAL);
	local.families[1].detection.at = '2026-10-27T16:30:00.5Z';
	const m = model(status, payload(local, INSPECT_OK));
	// UTC, with or without a fraction, shown in local time (UTC+8 here).
	assert.equal(m.startedAt, '2026-10-27 16:00:00');
	assert.equal(m.writtenAt, '2026-10-27 16:05:01');
	assert.equal(family(m, 'ipv4').detection.at, '2026-10-27 16:05:00');
	assert.equal(family(m, 'ipv4').execution.at, '2026-10-27 16:05:01');
	assert.equal(family(m, 'ipv6').detection.at, '2026-10-28 00:30:00');
	assert.equal(family(m, 'ipv4').cloudflare.queriedAt, '2026-10-27 16:10:00');
	assert.equal(m.period, '5 分钟');
	const out = rendered(status, payload(local, INSPECT_OK));
	for (const want of ['2026-10-27 16:00:00', '2026-10-27 16:05:01', '2026-10-28 00:30:00', '2026-10-27 16:10:00', '5 分钟'])
		assert.ok(out.includes(want), `rendered text lacks ${want}`);

	for (const [period, want] of [['10s', '10 秒'], ['5m0s', '5 分钟'], ['1m30s', '1 分钟 30 秒'],
		['1h0m0s', '1 小时'], ['1h30m0s', '1 小时 30 分钟'], ['26h0m10s', '26 小时 10 秒']]) {
		const p = clone(LOCAL);
		p.period = period;
		assert.equal(model(status, payload(p, INSPECT_OK)).period, want, period);
	}

	// Not an RFC 3339 UTC time, or Go's zero time: no time is shown.
	for (const bad of ['', 'yesterday', '2026-10-27 08:05:00', '0001-01-01T00:00:00Z', 1761552300]) {
		const p = clone(LOCAL);
		p.written_at = bad;
		p.families[0].detection.at = bad;
		const m2 = model(status, payload(p, INSPECT_OK));
		assert.equal(m2.writtenAt, null, JSON.stringify(bad));
		assert.equal(family(m2, 'ipv4').detection.at, null, JSON.stringify(bad));
	}
});

test('test_status_no_token', () => {
	const SECRET = 'cfut_SENTINEL_9f3c71d2';
	const local = clone(LOCAL);
	local.token = SECRET;
	local.families[0].token = SECRET;
	local.families[0].detection.token = SECRET;
	local.families[0].execution.passwd = SECRET;
	local.families[1].extra = { token: SECRET };
	local.families.push({ family: 'token', domain: SECRET, record_type: SECRET });
	const inspect = clone(INSPECT_OK);
	inspect.token = SECRET;
	inspect.results[0].token = SECRET;
	inspect.results[1].raw = { token: SECRET, headers: { Authorization: `Bearer ${SECRET}` } };
	const p = {
		local, inspect,
		errors: Object.assign({ token: SECRET }, NO_ERRORS),
		service: { running: true, enabled: true, token: SECRET },
		token: SECRET,
	};
	const { status } = setup();
	const m = status.viewModel(p);
	assert.ok(!JSON.stringify(m).includes(SECRET), JSON.stringify(m));
	const tree = status.render(m);
	assert.ok(!JSON.stringify(tree).includes(SECRET));
	assert.ok(!text(tree).includes(SECRET));
	// The documented data is still there.
	assert.equal(plain(m).families.length, 2);
	assert.match(text(tree), /203\.0\.113\.10/);
});

test('test_status_render_uses_text_nodes', () => {
	// luci.js assigns a lone string child as innerHTML and turns null or
	// nested arrays inside child arrays into text: none of them may occur.
	const HOSTILE = '<img src=x onerror=alert(1)>';
	const local = clone(LOCAL);
	local.families[0].detection.source = HOSTILE;
	local.families[0].execution.warning = HOSTILE;
	local.families[1].detection = { at: 'x', ip: '', source: '', error: HOSTILE };
	local.period = HOSTILE;
	const inspect = clone(INSPECT_OK);
	inspect.results[0].warning = HOSTILE;
	inspect.results[1].error = HOSTILE;
	const { status } = setup();
	const cases = [
		payload(local, inspect),
		payload(null, null, { local: HOSTILE, inspect: HOSTILE }),
		payload(null, null, { config: HOSTILE }),
		Object.assign(payload(local, inspect), { service: null, errors: Object.assign({}, NO_ERRORS, { service: HOSTILE, action: HOSTILE }) }),
		Object.assign(payload(local, inspect), { loading: true, acting: 'restart', loaded: true }),
		{ loaded: false, loading: true },
	];
	for (const p of cases) {
		const tree = status.render(status.viewModel(p));
		let hostile = 0;
		walk(tree, (n) => {
			assert.ok(n.isElement, JSON.stringify(n));
			assert.ok(!n.html, `<${n.tag}> has a lone string child: ${JSON.stringify(n.children)}`);
			for (const c of n.children) {
				assert.ok(c != null && !Array.isArray(c), `<${n.tag}> child ${JSON.stringify(c)}`);
				assert.ok(typeof c === 'string' || (typeof c === 'object' && c.isElement), `<${n.tag}> child ${typeof c}`);
				if (typeof c === 'string' && c.includes(HOSTILE))
					hostile++;
			}
			for (const [k, v] of Object.entries(n.attrs))
				assert.ok(typeof v !== 'string' || !v.includes(HOSTILE), `attribute ${k}`);
		});
		if (p.local || p.errors && Object.values(p.errors).some((v) => v === HOSTILE))
			assert.ok(hostile > 0, 'hostile text should be shown as text');
	}
});

test('test_status_refresh_loads_once_and_disables_refresh', async () => {
	let gate = deferred();
	const { status, log, document } = setup({
		exec: () => gate.promise.then(() => ({ code: 0, stdout: JSON.stringify(INSPECT_OK) })),
	});
	const first = document.current;
	const done = status.refresh();
	// Drawn at once with the refresh button disabled.
	assert.equal(buttons(first)['刷新'].attrs.disabled, 'disabled');
	assert.match(text(first), /正在/);
	// A second trigger while loading does not start another load.
	const again = status.refresh();
	await tick();
	assert.equal(count(log, { read: STATUS_FILE }), 1);
	assert.equal(count(log, { exec: INSPECT }), 1);
	assert.equal(count(log, 'getState'), 1);

	// The form re-rendered meanwhile: the result goes to the current
	// container, never to the replaced one.
	const second = { tag: 'div', attrs: { id: 'cfddns-status' }, children: [] };
	document.current = second;
	const stale = JSON.stringify(first);
	gate.resolve();
	await done;
	await again;
	assert.equal(JSON.stringify(first), stale);
	const refresh = buttons(second)['刷新'];
	assert.equal(refresh.attrs.disabled, null);
	assert.match(text(second), /一致/);
	assert.match(text(second), /运行中/);
	assert.equal(log.length, 3);

	// Clicking Refresh loads once more, and nothing runs on its own.
	gate = deferred();
	refresh.attrs.click({});
	await tick();
	assert.equal(buttons(second)['刷新'].attrs.disabled, 'disabled');
	gate.resolve();
	await tick();
	await tick();
	assert.equal(count(log, { read: STATUS_FILE }), 2);
	assert.equal(count(log, { exec: INSPECT }), 2);
	assert.equal(count(log, 'getState'), 2);
	assert.equal(log.length, 6);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(log.length, 6);
});

test('test_status_service_state_and_controls', async () => {
	// getState() rejecting as a whole is shown in the service area while
	// status and inspect data stay.
	{
		const { status, document } = setup({
			getState: () => Promise.reject(new Error('RPC call to service/list failed with ubus code 6')),
		});
		await status.refresh();
		const out = text(document.current);
		assert.match(out, /无法获取服务状态/);
		assert.match(out, /ubus code 6/);
		assert.match(out, /203\.0\.113\.10/);
		assert.match(out, /一致/);
		assert.match(out, /5 分钟/);
	}

	for (const [state, want] of [[{ running: false, enabled: false }, ['已停止', '未启用']],
		[{ running: true, enabled: true }, ['运行中', '已启用']],
		[{ running: true, enabled: false }, ['运行中', '未启用']]]) {
		const { status, document } = setup({ getState: () => Promise.resolve(state) });
		await status.refresh();
		for (const w of want)
			assert.match(text(document.current), new RegExp(w), JSON.stringify(state));
	}

	// Start/Stop/Restart go through service.action, show its rejection and
	// re-query only the service state.
	{
		const refusal = '服务未启用：请先在“基本设置”中勾选“启用”，再点击“保存并应用”。';
		let gate = deferred();
		let running = false;
		const { status, log, document } = setup({
			getState: () => Promise.resolve({ running, enabled: running }),
			action: (name) => gate.promise.then(() => {
				if (name === 'start')
					throw new Error(refusal);
				running = name !== 'stop';
			}),
		});
		await status.refresh();
		log.length = 0;
		const b = buttons(document.current);
		assert.deepEqual(Object.keys(b).sort(), ['停止', '启动', '刷新', '重启'].sort());

		b['启动'].attrs.click({});
		await tick();
		const busy = buttons(document.current);
		for (const name of ['启动', '停止', '重启'])
			assert.equal(busy[name].attrs.disabled, 'disabled', name);
		gate.resolve();
		await tick();
		await tick();
		assert.deepEqual(log, [{ action: 'start' }, 'getState']);
		assert.ok(text(document.current).includes(refusal));
		assert.equal(buttons(document.current)['启动'].attrs.disabled, null);

		gate = deferred();
		gate.resolve();
		buttons(document.current)['重启'].attrs.click({});
		await tick();
		await tick();
		assert.deepEqual(log.slice(2), [{ action: 'restart' }, 'getState']);
		assert.ok(!text(document.current).includes(refusal));
		assert.match(text(document.current), /运行中/);

		buttons(document.current)['停止'].attrs.click({});
		await tick();
		await tick();
		assert.deepEqual(log.slice(4), [{ action: 'stop' }, 'getState']);
		assert.match(text(document.current), /已停止/);
	}
});
