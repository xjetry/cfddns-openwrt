'use strict';
// Tests for view/cfddns.js, the two-tab settings page, with fake form, uci, ui,
// service and status modules. Run with: node --test tests/js/view_test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule, makeClass, plain } = require('./luci_vm.cjs');

const VIEW = path.join(__dirname,
	'../../luci/applications/luci-app-cfddns/htdocs/luci-static/resources/view/cfddns.js');

// The view base class keeps LuCI's default footer handlers so tests can tell
// inherited ones from overrides.
const defaults = {
	load() {},
	render() {},
	handleSave() {},
	handleSaveApply() {},
	handleReset() {},
};
const view = { extend: (props) => makeClass(Object.create(defaults), props) };

function fakeForm(log, saveResult) {
	const kind = (name) => ({ kind: name });
	const form = {
		Map: function (config, title, description) {
			Object.assign(this, { config, title, description, sections: [] });
		},
		NamedSection: kind('NamedSection'),
		Flag: kind('Flag'),
		Value: kind('Value'),
		DummyValue: kind('DummyValue'),
	};
	form.Map.prototype.section = function (cls, ...args) {
		const section = {
			map: this, kind: cls.kind, args, tabs: [], options: [], formValues: {},
			tab(name, title) { this.tabs.push({ name, title }); },
			taboption(tab, cls, option, title, description) {
				assert.ok(this.tabs.some((t) => t.name === tab), `tab ${tab} not declared`);
				const o = { section: this, map: this.map, tab, kind: cls.kind, option, title, description };
				this.options.push(o);
				return o;
			},
			formvalue(sectionId, option) { return this.formValues[option]; },
		};
		this.sections.push(section);
		return section;
	};
	// render() resolves with the map's root node, which LuCI keeps across
	// the re-render that follows every save.
	form.Map.prototype.render = function () {
		log.push('map.render');
		this.node = {
			listeners: [],
			addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture }); },
		};
		return Promise.resolve(this.node);
	};
	form.Map.prototype.save = function (cb, silent) {
		log.push({ save: { cb: cb == null ? null : 'callback', silent } });
		return saveResult();
	};
	form.Map.prototype.reset = function () {
		log.push('map.reset');
	};
	return form;
}

function text(node) {
	if (node == null)
		return '';
	if (typeof node !== 'object')
		return String(node);
	return (node.children || []).map(text).join('');
}

// setup loads the view with fakes; save and apply return the promises that
// map.save() and service.apply() should settle with.
function setup({ save = () => Promise.resolve(), apply = () => Promise.resolve(), enabled = '1' } = {}) {
	const log = [];
	const form = fakeForm(log, save);
	const uci = {
		get(config, section, option) {
			log.push({ uci: `${config}.${section}.${option}` });
			return option === 'enabled' ? enabled : null;
		},
	};
	const ui = {
		addNotification(title, children, ...classes) {
			log.push({ notify: classes.join(' '), text: text({ children: [].concat(children) }), html: children.html === true });
		},
		changes: { init() { log.push('changes.init'); } },
	};
	const service = {
		apply(value) {
			log.push({ apply: value });
			return apply();
		},
	};
	const status = {
		refresh() {
			log.push('status.refresh');
			return Promise.resolve();
		},
	};
	const page = loadModule(VIEW, { view, form, uci, ui, 'cfddns.service': service, 'cfddns.status': status });
	return { page, log };
}

async function rendered(opts) {
	const s = setup(opts);
	const node = await s.page.render();
	const map = s.page.map;
	assert.ok(map, 'render() must keep the map as this.map');
	assert.equal(node, map.node, 'render() must return the rendered map');
	assert.equal(map.sections.length, 1);
	return Object.assign(s, { map, section: map.sections[0] });
}

function option(section, name) {
	const o = section.options.find((x) => x.option === name);
	assert.ok(o, `option ${name} missing`);
	return o;
}

test('test_view_binds_named_section_with_two_tabs', async () => {
	const { map, section } = await rendered();
	assert.equal(map.config, 'cfddns');
	assert.equal(section.kind, 'NamedSection');
	assert.deepEqual(section.args, ['main', 'cfddns']);
	// The first tab is the default one.
	assert.deepEqual(plain(section.tabs), [{ name: 'status', title: '运行状态' }, { name: 'settings', title: '基本设置' }]);
});

test('test_status_tab_has_container', async () => {
	const { section } = await rendered();
	const status = section.options.filter((o) => o.tab === 'status');
	assert.equal(status.length, 1);
	assert.equal(status[0].kind, 'DummyValue');
	const el = status[0].renderWidget('main', 0, null);
	assert.equal(el.tag, 'div');
	assert.equal(el.attrs.id, 'cfddns-status');
	assert.deepEqual(plain(el.children), []);
});

test('test_status_loads_when_tab_opens', async () => {
	// ui.tabs dispatches the non-bubbling cbi-tab-active on a pane whenever
	// it is shown: at first render, after the re-render on save and on every
	// tab switch. Only showing the status tab loads, once per event.
	const { map, section, log } = await rendered();
	section.options.find((o) => o.tab === 'status').renderWidget('main', 0, null);
	assert.ok(!log.includes('status.refresh'), 'rendering alone must not load');
	const listeners = map.node.listeners;
	assert.deepEqual(listeners.map((l) => [l.type, l.capture]), [['cbi-tab-active', true]]);
	const onTab = listeners[0].fn;

	onTab({ detail: { tab: 'settings' } });
	assert.equal(log.filter((e) => e === 'status.refresh').length, 0);
	onTab({ detail: { tab: 'status' } });
	assert.equal(log.filter((e) => e === 'status.refresh').length, 1);
	onTab({ detail: { tab: 'settings' } });
	onTab({ detail: { tab: 'status' } });
	assert.equal(log.filter((e) => e === 'status.refresh').length, 2);
	onTab({});
	assert.equal(log.filter((e) => e === 'status.refresh').length, 2);
});

test('test_settings_fields', async () => {
	const { section } = await rendered();
	const settings = section.options.filter((o) => o.tab === 'settings');
	assert.deepEqual(settings.map((o) => [o.option, o.kind]), [
		['enabled', 'Flag'],
		['domain_v4', 'Value'],
		['domain_v6', 'Value'],
		['v6_iface', 'Value'],
		['token', 'Value'],
		['period', 'Value'],
	]);
	for (const o of settings)
		assert.ok(typeof o.title === 'string' && o.title !== '', `${o.option} needs a title`);
	assert.equal(option(section, 'enabled').rmempty, false);
	assert.equal(option(section, 'token').password, true);
	for (const name of ['enabled', 'domain_v4', 'domain_v6', 'v6_iface', 'period'])
		assert.notEqual(option(section, name).password, true, `${name} must not be a password field`);
	assert.equal(option(section, 'period').default, '5m');
});

test('test_period_validation_mirrors_generator', async () => {
	const { section } = await rendered();
	const period = option(section, 'period');
	// Same vectors as tests/config_test.sh test_period_is_validated; empty
	// means the 5m default.
	for (const good of ['', '10s', '5m', '1h', '1h30m', '5m0s', '0h0m10s', '90s', '000010s', '999999h'])
		assert.equal(period.validate('main', good), true, `period ${JSON.stringify(good)} should be valid`);
	for (const bad of ['9s', '0s', '0m', '5', 'm', '1.5m', '500ms', '5m1h', '1m1m', '-5m', '+5m', '1d',
		'1234567s', '1234567m', '1234567h', ' 5m', '5m ', '0h0m9s', '1hm', 'h', '5M'])
		assert.equal(typeof period.validate('main', bad), 'string', `period ${JSON.stringify(bad)} should be invalid`);
	assert.match(period.validate('main', '9s'), /10s/);
});

test('test_v6_iface_requires_domain_v6', async () => {
	const { section } = await rendered();
	const iface = option(section, 'v6_iface');
	section.formValues.domain_v6 = 'home6.example.com';
	assert.equal(iface.validate('main', 'br-lan'), true);
	assert.equal(iface.validate('main', ''), true);
	assert.equal(typeof iface.validate('main', 'br/lan'), 'string');
	for (const empty of ['', '.']) {
		section.formValues.domain_v6 = empty;
		assert.equal(typeof iface.validate('main', 'br-lan'), 'string', `domain_v6 ${JSON.stringify(empty)}`);
		assert.equal(iface.validate('main', ''), true);
	}
});

test('test_only_reset_and_save_apply_actions', () => {
	const { page } = setup();
	assert.equal(page.handleSave, null);
	assert.equal(page.handleReset, defaults.handleReset);
	assert.notEqual(page.handleSaveApply, defaults.handleSaveApply);
});

test('test_save_apply_sequence', async () => {
	for (const [enabled, want] of [['1', true], ['0', false], [null, false]]) {
		let finishApply;
		const { page, log } = await rendered({
			enabled,
			apply: () => new Promise((resolve) => { finishApply = resolve; }),
		});
		log.length = 0;
		const done = page.handleSaveApply({}, '0');
		await new Promise((resolve) => setImmediate(resolve));
		// Success is reported only once every service step has finished.
		assert.deepEqual(log, [{ save: { cb: null, silent: true } }, { uci: 'cfddns.main.enabled' }, { apply: want }]);
		finishApply();
		await done;
		assert.deepEqual(log.slice(3, 4).map((e) => e.notify), ['info']);
		assert.deepEqual(log.slice(4), ['changes.init']);
	}
});

test('test_save_apply_success_notices', async () => {
	// apply(true) resolves with a command result, apply(false) with the flag.
	for (const res of [undefined, { unconfigured: false }, { cmdline: '/etc/init.d/cfddns restart', code: 0 }]) {
		const { page, log } = await rendered({ apply: () => Promise.resolve(res) });
		log.length = 0;
		await page.handleSaveApply({}, '0');
		const notes = log.filter((e) => e.notify);
		assert.equal(notes.length, 1, JSON.stringify(res));
		assert.equal(notes[0].notify, 'info');
		assert.equal(notes[0].text, '设置已保存并应用。');
	}

	// Cleared credentials are a success that says what happened to the env.
	{
		const { page, log } = await rendered({ enabled: '0', apply: () => Promise.resolve({ unconfigured: true }) });
		log.length = 0;
		await page.handleSaveApply({}, '0');
		const notes = log.filter((e) => e.notify);
		assert.equal(notes.length, 1);
		assert.equal(notes[0].notify, 'info');
		for (const word of [/服务已停止/, /取消开机自启/, /Token/, /域名/, /清除/])
			assert.match(notes[0].text, word);
		assert.equal(log[log.length - 1], 'changes.init');
	}
});

test('test_save_apply_messages_are_text_nodes', async () => {
	// luci.js assigns a lone string child as innerHTML; a command's stderr
	// must be shown as text.
	const hostile = '<img src=x onerror=alert(1)>';
	for (const apply of [() => Promise.resolve(), () => Promise.resolve({ unconfigured: true }),
		() => Promise.reject(new Error(hostile))]) {
		const { page, log } = await rendered({ apply });
		log.length = 0;
		await page.handleSaveApply({}, '0');
		const notes = log.filter((e) => e.notify);
		assert.equal(notes.length, 1);
		assert.equal(notes[0].html, false, notes[0].text);
	}
});

test('test_save_apply_failure_keeps_input_and_shows_error', async () => {
	// A service step fails after the form was staged: report it, do not
	// reset or re-render the form, and resolve so the button recovers.
	{
		const { page, log } = await rendered({
			apply: () => Promise.reject(new Error('命令 /usr/libexec/cfddns-config 失败（退出码 1）：cfddns-config: period must be whole h/m/s units')),
		});
		log.length = 0;
		await page.handleSaveApply({}, '0');
		const notes = log.filter((e) => e.notify);
		assert.equal(notes.length, 1);
		assert.equal(notes[0].notify, 'danger');
		assert.match(notes[0].text, /period must be whole/);
		assert.ok(!log.includes('map.reset') && !log.includes('map.render'), JSON.stringify(log));
		assert.equal(log[log.length - 1], 'changes.init');
	}

	// The not-configured refusal from apply(true) is shown like any failure.
	{
		const { page, log } = await rendered({
			apply: () => Promise.reject(new Error('Token 和至少一个域名为必填，服务已停止')),
		});
		log.length = 0;
		await page.handleSaveApply({}, '0');
		const notes = log.filter((e) => e.notify);
		assert.equal(notes.length, 1);
		assert.equal(notes[0].notify, 'danger');
		assert.match(notes[0].text, /Token 和至少一个域名为必填，服务已停止/);
	}

	// Validation or staging fails: nothing is committed or applied.
	{
		const { page, log } = await rendered({
			save: () => Promise.reject(new TypeError('Option "探测间隔" contains an invalid input value.')),
		});
		log.length = 0;
		await page.handleSaveApply({}, '0');
		assert.ok(!log.some((e) => e.apply !== undefined), JSON.stringify(log));
		const notes = log.filter((e) => e.notify);
		assert.equal(notes.length, 1);
		assert.equal(notes[0].notify, 'danger');
		assert.match(notes[0].text, /探测间隔/);
	}
});
