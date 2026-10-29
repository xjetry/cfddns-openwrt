'use strict';
'require baseclass';
'require dom';
'require fs';
'require cfddns.service as service';

var STATUS_FILE = '/var/run/cfddns.status';
var CFDDNS = '/usr/bin/cfddns';
var INSPECT = CFDDNS + ' -inspect';
var CONTAINER = 'cfddns-status';

var RFC3339_UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?Z$/;
var GO_DURATION = /^(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s)?$/;

var FAMILIES = { ipv4: 'IPv4', ipv6: 'IPv6' };

var ACTIONS = { start: _('启动'), stop: _('停止'), restart: _('重启') };

var SYNC = {
	created: _('已创建记录'),
	updated: _('已更新记录'),
	unchanged: _('无需更新'),
	error: _('失败')
};

var COMPARE = {
	match: _('一致'),
	mismatch: _('不一致'),
	missing: _('记录不存在'),
	error: _('查询失败'),
	nodata: _('无数据')
};

function message(err) {
	return (err && err.message) ? err.message : String(err);
}

/* The view model only ever copies these documented fields one by one. */
function str(obj, key) {
	return (L.isObject(obj) && typeof(obj[key]) == 'string') ? obj[key] : '';
}

function bool(obj, key) {
	return (L.isObject(obj) && typeof(obj[key]) == 'boolean') ? obj[key] : null;
}

function text(value) {
	return (typeof(value) == 'string' && value !== '') ? value : null;
}

function pad(n) {
	return (n < 10 ? '0' : '') + n;
}

/* Core times are RFC 3339 UTC whose fraction is omitted on whole seconds;
 * they are shown in the browser's local time. Go's zero time means unset. */
function displayTime(value) {
	var m = RFC3339_UTC.exec(value), d;

	if (!m)
		return null;

	d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
	if (isNaN(d.getTime()) || d.getUTCFullYear() < 1970)
		return null;

	return '%s-%s-%s %s:%s:%s'.format(d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()),
		pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds()));
}

/* period is a Go duration string such as 10s, 5m0s or 1h30m0s. */
function displayPeriod(value) {
	var m = GO_DURATION.exec(value), parts = [];

	if (value === '')
		return null;

	if (!m)
		return value;

	if (+m[1])
		parts.push(_('%d 小时').format(+m[1]));
	if (+m[2])
		parts.push(_('%d 分钟').format(+m[2]));
	if (+m[3])
		parts.push(_('%d 秒').format(+m[3]));

	return parts.length ? parts.join(' ') : value;
}

/* rpcd answers a missing file with UBUS_STATUS_NOT_FOUND, which fs.read()
 * rejects as NotFoundError: the daemon has not finished a cycle yet or is
 * stopped. Any other failure is an error. */
function readStatus() {
	return fs.read(STATUS_FILE).then(function(data) {
		var parsed;

		try {
			parsed = JSON.parse(data);
		}
		catch (e) {
			throw new Error(_('%s 不是有效的 JSON：%s').format(STATUS_FILE, e.message));
		}

		if (!L.isObject(parsed) || parsed.version !== 1)
			throw new Error(_('%s 的格式不受支持').format(STATUS_FILE));

		return parsed;
	}, function(err) {
		if (err && err.name === 'NotFoundError')
			return null;

		throw new Error(_('读取 %s 失败：%s').format(STATUS_FILE, message(err)));
	});
}

function parseInspect(stdout) {
	var parsed;

	try {
		parsed = JSON.parse(String(stdout || ''));
	}
	catch (e) {
		throw new Error(_('%s 的输出不是有效的 JSON：%s').format(INSPECT, e.message));
	}

	if (!L.isObject(parsed) || !Array.isArray(parsed.results))
		throw new Error(_('%s 的输出格式不受支持').format(INSPECT));

	return parsed;
}

function emptyCloudflare(state) {
	return { state: state, content: '', queriedAt: null, warning: '', error: '' };
}

/* Finds or adds the entry for one documented family and domain. */
function familyEntry(list, item) {
	var family = str(item, 'family'), domain = str(item, 'domain'), entry;

	if (!FAMILIES.hasOwnProperty(family) || domain === '')
		return null;

	for (var i = 0; i < list.length; i++)
		if (list[i].family === family && list[i].domain === domain)
			return list[i];

	entry = {
		family: family,
		label: FAMILIES[family],
		domain: domain,
		recordType: str(item, 'record_type'),
		detection: null,
		execution: null,
		cloudflare: null,
		compare: 'nodata'
	};
	list.push(entry);

	return entry;
}

/* A failed detection leaves ip empty, so it never compares. IPv6 text from
 * the daemon and from Cloudflare may differ in case only. */
function compare(entry) {
	var cf = entry.cloudflare, ip = entry.detection ? entry.detection.ip : '';

	if (cf.state === 'error' || cf.state === 'missing')
		return cf.state;

	if (cf.state === 'found' && ip !== '')
		return (ip.toLowerCase() === cf.content.toLowerCase()) ? 'match' : 'mismatch';

	return 'nodata';
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '33%' }, [ label ]),
		E('td', { 'class': 'td left', 'style': 'white-space:pre-wrap' }, [ value ])
	]);
}

function notice(type, value) {
	return E('div', { 'class': 'alert-message ' + type, 'style': 'white-space:pre-wrap' }, [ value ]);
}

/* luci.js turns null children into text, so absent parts are dropped. */
function compact(list) {
	return list.filter(function(item) { return item != null; });
}

function detectionText(det) {
	if (!det)
		return _('无数据');

	if (det.error !== '')
		return _('探测失败：%s').format(det.error);

	if (det.ip === '')
		return _('无数据');

	return det.source !== '' ? _('%s（来源：%s）').format(det.ip, det.source) : det.ip;
}

function executionText(exe, det) {
	var label;

	if (!exe)
		return _('无数据');

	label = SYNC.hasOwnProperty(exe.action) ? SYNC[exe.action] : (exe.action || _('无数据'));

	if (exe.error !== '')
		return _('%s：%s').format(label, exe.error);

	/* On a failed detection the reason is only in detection.error. */
	if (exe.action === 'error' && det && det.error !== '')
		return _('%s（IP 探测失败）').format(label);

	return label;
}

function cloudflareText(cf) {
	switch (cf.state) {
	case 'found':
		return cf.content !== '' ? cf.content : _('（空）');
	case 'missing':
		return _('记录不存在');
	case 'error':
		return cf.error !== '' ? _('查询失败：%s').format(cf.error) : _('查询失败');
	default:
		return _('无数据');
	}
}

function renderFamily(f) {
	var det = f.detection, exe = f.execution, cf = f.cloudflare;

	return E('div', { 'class': 'cbi-section cfddns-family', 'data-family': f.family }, [
		E('h4', [ f.recordType !== '' ? _('%s · %s（%s 记录）').format(f.label, f.domain, f.recordType) : _('%s · %s').format(f.label, f.domain) ]),
		E('table', { 'class': 'table' }, compact([
			row(_('比对结果'), COMPARE[f.compare]),
			row(_('本机 IP'), detectionText(det)),
			row(_('探测时间'), (det && det.at) || _('无数据')),
			row(_('同步结果'), executionText(exe, det)),
			row(_('同步时间'), (exe && exe.at) || _('无数据')),
			(exe && exe.warning !== '') ? row(_('同步警告'), exe.warning) : null,
			row(_('Cloudflare 记录'), cloudflareText(cf)),
			row(_('Cloudflare 查询时间'), cf.queriedAt || _('无数据')),
			(cf.warning !== '') ? row(_('Cloudflare 警告'), cf.warning) : null
		]))
	]);
}

return baseclass.extend({
	__init__: function() {
		this.data = null;
		this.serviceState = null;
		this.serviceError = null;
		this.actionError = null;
		this.loading = null;
		this.acting = null;
	},

	/* One read of the status file and one read-only Cloudflare query. Never
	 * rejects: each source's failure is kept apart in errors, where config
	 * is cfddns -inspect refusing the configuration (no JSON, non-zero exit,
	 * reason on stderr), as on a fresh install without Token or domains.
	 *
	 * LuCI sends the RPC calls queued in one animation frame as a single
	 * HTTP request, answered when all are done and timed out as a whole.
	 * The query, which may take far longer, starts only after the status
	 * read, so it can neither delay nor time out the calls issued with it. */
	load: function() {
		var res = { local: null, inspect: null, errors: { local: null, inspect: null, config: null } };

		return readStatus().then(function(data) {
			res.local = data;
		}, function(err) {
			res.errors.local = message(err);
		}).then(function() {
			return fs.exec(CFDDNS, [ '-inspect' ]).then(function(reply) {
				if (reply.code !== 0)
					res.errors.config = String(reply.stderr || '').trim() || _('退出码 %d').format(reply.code);
				else
					res.inspect = parseInspect(reply.stdout);
			}, function(err) {
				throw new Error(_('命令 %s 执行失败：%s').format(INSPECT, message(err)));
			});
		}).catch(function(err) {
			res.errors.inspect = message(err);
		}).then(function() {
			return res;
		});
	},

	/* payload is load()'s result, optionally with service (getState()),
	 * errors.service, errors.action, loaded, loading and acting. Status and
	 * inspect entries are merged by family and domain. */
	viewModel: function(payload) {
		var p = L.isObject(payload) ? payload : {},
		    errors = L.isObject(p.errors) ? p.errors : {},
		    local = L.isObject(p.local) ? p.local : null,
		    inspect = L.isObject(p.inspect) ? p.inspect : null,
		    inspectFailed = text(errors.config) != null || text(errors.inspect) != null,
		    families = [];

		(local && Array.isArray(local.families) ? local.families : []).forEach(function(item) {
			var entry = familyEntry(families, item), det, exe;

			if (!entry)
				return;

			det = item.detection;
			if (L.isObject(det))
				entry.detection = {
					at: displayTime(str(det, 'at')),
					ip: str(det, 'ip'),
					source: str(det, 'source'),
					error: str(det, 'error')
				};

			exe = item.execution;
			if (L.isObject(exe))
				entry.execution = {
					at: displayTime(str(exe, 'at')),
					action: str(exe, 'action'),
					error: str(exe, 'error'),
					warning: str(exe, 'warning')
				};
		});

		(inspect && Array.isArray(inspect.results) ? inspect.results : []).forEach(function(item) {
			var entry = familyEntry(families, item), error;

			if (!entry)
				return;

			error = str(item, 'error');
			entry.cloudflare = {
				state: (error !== '') ? 'error' : (bool(item, 'found') === true ? 'found' : 'missing'),
				content: str(item, 'content'),
				queriedAt: displayTime(str(item, 'queried_at')),
				warning: str(item, 'warning'),
				error: error
			};
		});

		families.forEach(function(entry) {
			if (!entry.cloudflare)
				entry.cloudflare = emptyCloudflare(inspectFailed ? 'error' : 'nodata');
			entry.compare = compare(entry);
		});

		return {
			loaded: p.loaded !== false,
			loading: p.loading === true,
			acting: ACTIONS.hasOwnProperty(p.acting) ? p.acting : null,
			service: {
				running: bool(p.service, 'running'),
				enabled: bool(p.service, 'enabled'),
				error: text(errors.service),
				actionError: text(errors.action)
			},
			period: local ? displayPeriod(str(local, 'period')) : null,
			startedAt: local ? displayTime(str(local, 'started_at')) : null,
			writtenAt: local ? displayTime(str(local, 'written_at')) : null,
			local: {
				state: text(errors.local) ? 'error' : (local ? 'ok' : 'nodata'),
				error: text(errors.local)
			},
			inspect: {
				state: text(errors.config) ? 'unconfigured' : (text(errors.inspect) ? 'error' : (inspect ? 'ok' : 'nodata')),
				error: text(errors.config) || text(errors.inspect)
			},
			families: families
		};
	},

	render: function(model) {
		return E('div', { 'class': 'cfddns-status-view' }, [
			this.renderService(model),
			this.renderRecords(model)
		]);
	},

	renderService: function(model) {
		var self = this, svc = model.service;

		function button(name, cls) {
			return E('button', {
				'class': 'cbi-button ' + cls,
				'disabled': model.acting ? 'disabled' : null,
				'click': function() { return self.handleAction(name); }
			}, [ ACTIONS[name] ]);
		}

		return E('div', { 'class': 'cbi-section' }, compact([
			E('h3', [ _('服务') ]),
			E('table', { 'class': 'table' }, [
				row(_('运行状态'), svc.running == null ? _('未知') : (svc.running ? _('运行中') : _('已停止'))),
				row(_('开机自启'), svc.enabled == null ? _('未知') : (svc.enabled ? _('已启用') : _('未启用'))),
				row(_('当前探测间隔'), model.period || _('无数据')),
				row(_('服务启动时间'), model.startedAt || _('无数据')),
				row(_('状态写入时间'), model.writtenAt || _('无数据'))
			]),
			svc.error ? notice('warning', _('无法获取服务状态：%s').format(svc.error)) : null,
			svc.actionError ? notice('danger', _('操作失败：%s').format(svc.actionError)) : null,
			model.acting ? E('p', [ _('正在执行“%s”…').format(ACTIONS[model.acting]) ]) : null,
			E('div', [
				button('start', 'cbi-button-apply'), ' ',
				button('stop', 'cbi-button-reset'), ' ',
				button('restart', 'cbi-button-action')
			])
		]));
	},

	renderRecords: function(model) {
		var self = this, body = [];

		if (model.loaded) {
			if (model.local.state === 'nodata')
				body.push(notice('info', _('本地状态：无数据（服务未运行，或首轮探测尚未完成）。')));
			else if (model.local.state === 'error')
				body.push(notice('danger', _('本地状态读取失败：%s').format(model.local.error)));

			if (model.inspect.state === 'unconfigured')
				body.push(notice('warning', _('尚未配置，无法查询 Cloudflare：请在“基本设置”中填写 Cloudflare API Token 和至少一个域名，然后点击“保存并应用”。\ncfddns：%s').format(model.inspect.error)));
			else if (model.inspect.state === 'error')
				body.push(notice('danger', _('Cloudflare 查询失败：%s').format(model.inspect.error)));

			if (model.families.length)
				body = body.concat(model.families.map(renderFamily));
			else if (model.inspect.state !== 'unconfigured')
				body.push(E('p', [ _('无数据') ]));
		}

		return E('div', { 'class': 'cbi-section' }, compact([
			E('h3', [ _('DNS 记录') ]),
			E('p', [ _('“刷新”会读取本机状态，并只读查询一次 Cloudflare 上的当前记录。') ]),
			E('div', [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'disabled': model.loading ? 'disabled' : null,
					'click': function() { return self.refresh(); }
				}, [ _('刷新') ])
			]),
			model.loading ? E('p', [ _('正在读取本机状态并查询 Cloudflare…') ]) : null
		]).concat(body));
	},

	current: function() {
		var errors = (this.data && this.data.errors) || {};

		return {
			local: this.data ? this.data.local : null,
			inspect: this.data ? this.data.inspect : null,
			service: this.serviceState,
			errors: {
				local: errors.local,
				inspect: errors.inspect,
				config: errors.config,
				service: this.serviceError,
				action: this.actionError
			},
			loaded: this.data != null,
			loading: this.loading != null,
			acting: this.acting
		};
	},

	/* The form replaces the container whenever it re-renders, so it is
	 * looked up on every draw. */
	redraw: function() {
		var container = document.getElementById(CONTAINER);

		if (container)
			dom.content(container, this.render(this.viewModel(this.current())));
	},

	queryService: function() {
		var self = this;

		return service.getState().then(function(state) {
			self.serviceState = state;
			self.serviceError = null;
		}, function(err) {
			self.serviceState = null;
			self.serviceError = message(err);
		});
	},

	/* One load plus one service state query per call; a call while one is
	 * running only redraws and shares it. */
	refresh: function() {
		var self = this;

		if (!this.loading) {
			this.loading = Promise.all([ this.load(), this.queryService() ]).then(function(res) {
				self.data = res[0];
			}).finally(function() {
				self.loading = null;
				self.redraw();
			});
		}

		this.redraw();
		return this.loading;
	},

	/* Runs one service action at a time and then re-queries only the
	 * service state; the records stay as last loaded. */
	handleAction: function(name) {
		var self = this;

		if (this.acting)
			return Promise.resolve();

		this.acting = name;
		this.actionError = null;
		this.redraw();

		return service.action(name).then(function() {
			self.actionError = null;
		}, function(err) {
			self.actionError = message(err);
		}).then(function() {
			return self.queryService();
		}).finally(function() {
			self.acting = null;
			self.redraw();
		});
	}
});
