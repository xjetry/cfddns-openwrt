'use strict';
'require baseclass';
'require fs';
'require rpc';

var INIT = '/etc/init.d/cfddns';
var GENERATOR = '/usr/libexec/cfddns-config';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} },
	reject: true
});

var callUciGet = rpc.declare({
	object: 'uci',
	method: 'get',
	params: [ 'config', 'section', 'option' ]
});

/* Commits only the cfddns config staged in this rpcd session; LuCI's own
 * apply would also apply every other pending config with a rollback. */
var callUciCommit = rpc.declare({
	object: 'uci',
	method: 'commit',
	params: [ 'config' ],
	reject: true
});

/* fs.exec() resolves with { code, stdout, stderr } whatever the exit code and
 * rejects only on rpcd errors such as a denied ACL. No env is ever passed:
 * rpcd would hand it to the root process. */
function exec(command, params) {
	var cmdline = [ command ].concat(params || []).join(' ');

	return fs.exec(command, params).then(function(res) {
		return { cmdline: cmdline, code: res.code, stdout: res.stdout, stderr: res.stderr };
	}, function(err) {
		throw new Error(_('命令 %s 执行失败：%s').format(cmdline, err.message));
	});
}

function detail(res) {
	return String(res.stderr || res.stdout || '').trim();
}

function failure(res) {
	if (detail(res) != '')
		return new Error(_('命令 %s 失败（退出码 %d）：%s').format(res.cmdline, res.code, detail(res)));

	return new Error(_('命令 %s 失败（退出码 %d）').format(res.cmdline, res.code));
}

/* run() is exec() for commands that must succeed. */
function run(command, params) {
	return exec(command, params).then(function(res) {
		if (res.code !== 0)
			throw failure(res);
		return res;
	});
}

/* UCI cfddns.main.enabled as rpcd sees it; a missing option or section means
 * disabled, as with config_get_bool in the init script. */
function uciEnabled() {
	return callUciGet('cfddns', 'main', 'enabled').then(function(res) {
		if (L.isObject(res))
			return res.value === '1';
		if (res === 4) /* UBUS_STATUS_NOT_FOUND */
			return false;
		throw new Error(_('读取 cfddns 配置失败：%s').format(rpc.getStatusText(res)));
	});
}

/* "/etc/init.d/cfddns enabled" exits 0 when the boot link exists, 1 when not. */
function bootEnabled() {
	return exec(INIT, [ 'enabled' ]).then(function(res) {
		if (res.code === 0 || res.code === 1)
			return res.code === 0;
		throw failure(res);
	});
}

function isRunning(services) {
	var instances = (L.isObject(services.cfddns) && L.isObject(services.cfddns.instances))
		? services.cfddns.instances : {};

	for (var name in instances)
		if (L.isObject(instances[name]) && instances[name].running === true)
			return true;

	return false;
}

return baseclass.extend({
	/* running comes from procd; enabled is the effective boot autostart:
	 * the init script is enabled and UCI enabled is '1', because a fresh
	 * install leaves the init script enabled while UCI is still 0. */
	getState: function() {
		return Promise.all([
			callServiceList('cfddns'),
			bootEnabled(),
			uciEnabled()
		]).then(function(res) {
			return {
				running: isRunning(res[0]),
				enabled: res[1] && res[2]
			};
		});
	},

	/* Changes only the current run state; never writes UCI. The init
	 * script's start and restart exit 0 both when UCI is disabled and when
	 * config generation fails, so both are checked here first. */
	action: function(name) {
		if (name === 'stop')
			return run(INIT, [ 'stop' ]);

		if (name !== 'start' && name !== 'restart')
			return Promise.reject(new Error(_('不支持的服务操作：%s').format(String(name))));

		return uciEnabled().then(function(enabled) {
			if (!enabled)
				throw new Error(_('服务未启用：请先在“基本设置”中勾选“启用”，再点击“保存并应用”。'));

			return run(GENERATOR);
		}).then(function() {
			return run(INIT, [ name ]);
		});
	},

	/* Save & Apply after the form staged its changes: commit cfddns, so the
	 * generator and init script read it, then regenerate the env file and
	 * set boot autostart and the run state to match enabled. The generator
	 * checks Token and domains whatever enabled is, so when disabling it
	 * runs last: an incomplete config must not keep the service running. */
	apply: function(enabled) {
		if (typeof(enabled) != 'boolean')
			return Promise.reject(new TypeError('apply() expects a boolean'));

		var committed = callUciCommit('cfddns').catch(function(err) {
			throw new Error(_('提交 cfddns 配置失败：%s').format(err.message));
		});

		if (enabled)
			return committed.then(function() {
				return run(GENERATOR);
			}).then(function() {
				return run(INIT, [ 'enable' ]);
			}).then(function() {
				return run(INIT, [ 'restart' ]);
			});

		return committed.then(function() {
			return run(INIT, [ 'disable' ]);
		}).then(function() {
			return run(INIT, [ 'stop' ]);
		}).then(function() {
			return exec(GENERATOR).then(function(res) {
				if (res.code !== 0)
					throw new Error(_('服务已停止并已取消开机自启，但配置无效：%s')
						.format(detail(res) || _('退出码 %d').format(res.code)));
			}, function(err) {
				throw new Error(_('服务已停止并已取消开机自启，但未能生成配置：%s').format(err.message));
			});
		});
	}
});
