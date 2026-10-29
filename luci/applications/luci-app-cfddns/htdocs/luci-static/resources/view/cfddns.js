'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require cfddns.service as service';
'require cfddns.status as status';

/* Mirrors valid_period in /usr/libexec/cfddns-config: whole h, m and s
 * components in that order, at most 6 digits each, at least 10s in total.
 * Empty means the 5m default. */
function validPeriod(value) {
	var m = /^(?:([0-9]{1,6})h)?(?:([0-9]{1,6})m)?(?:([0-9]{1,6})s)?$/.exec(value);

	if (value === '')
		return true;

	if (!m)
		return false;

	return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) >= 10;
}

return view.extend({
	render: function() {
		var m, s, o;

		m = new form.Map('cfddns', _('Cloudflare DDNS'),
			_('把本路由器的公网 IPv4/IPv6 地址同步到 Cloudflare 的 A/AAAA 记录。'));

		s = m.section(form.NamedSection, 'main', 'cfddns');
		s.tab('status', _('运行状态'));
		s.tab('settings', _('基本设置'));

		o = s.taboption('status', form.DummyValue, '_status');
		o.renderWidget = function() {
			return E('div', { 'id': 'cfddns-status', 'class': 'cfddns-status' });
		};

		o = s.taboption('settings', form.Flag, 'enabled', _('启用'),
			_('保存并应用时，勾选则设为开机自启并启动服务，取消勾选则停止服务并取消开机自启。'));
		o.rmempty = false;

		o = s.taboption('settings', form.Value, 'domain_v4', _('IPv4 域名'),
			_('要更新 A 记录的完整域名，例如 home.example.com；留空则不更新 IPv4。'));

		o = s.taboption('settings', form.Value, 'domain_v6', _('IPv6 域名'),
			_('要更新 AAAA 记录的完整域名；留空则不更新 IPv6。IPv4 与 IPv6 域名至少填写一个。'));

		o = s.taboption('settings', form.Value, 'v6_iface', _('IPv6 网卡'),
			_('可选，仅在填写 IPv6 域名时有效。优先使用该网卡的稳定全局 IPv6 地址，取不到时回退到 Cloudflare trace。'));
		o.validate = function(section_id, value) {
			var domain;

			if (value == null || value === '')
				return true;

			if (value.indexOf('/') != -1)
				return _('网卡名不能包含“/”');

			/* The generator strips one trailing dot before checking. */
			domain = this.section.formvalue(section_id, 'domain_v6');
			if (domain != null && String(domain).replace(/\.$/, '') === '')
				return _('设置 IPv6 网卡前需先填写 IPv6 域名');

			return true;
		};

		o = s.taboption('settings', form.Value, 'token', _('Cloudflare API Token'),
			_('必填。权限至少需要目标 Zone 的 DNS 编辑和 Zone 读取。'));
		o.password = true;

		o = s.taboption('settings', form.Value, 'period', _('探测间隔'),
			_('由整数加 h、m、s 单位组成，例如 10s、5m、1h30m；最小 10s，留空为 5m。'));
		o.default = '5m';
		o.placeholder = '5m';
		o.validate = function(section_id, value) {
			return validPeriod(value) ? true : _('格式应为 10s、5m、1h30m 这类时长，且不小于 10s');
		};

		this.map = m;
		/* ui.tabs fires the non-bubbling cbi-tab-active on a pane each time
		 * it is shown, including after the map re-renders on save; the map
		 * root survives those re-renders, so one capturing listener loads
		 * the status once per opening of the status tab. */
		return m.render().then(function(node) {
			node.addEventListener('cbi-tab-active', function(ev) {
				if (ev.detail && ev.detail.tab === 'status')
					status.refresh();
			}, true);
			return node;
		});
	},

	/* Stage the form silently, then let the service controller commit only
	 * cfddns and apply it; LuCI's global apply is never used. Report success
	 * only after every step finished; on failure the form keeps the input. */
	handleSaveApply: function(ev, mode) {
		var map = this.map;

		return map.save(null, true).then(function() {
			return service.apply(uci.get('cfddns', 'main', 'enabled') == '1');
		}).then(function() {
			ui.addNotification(null, E('p', _('设置已保存并应用。')), 'info');
		}, function(err) {
			ui.addNotification(null, E('p', { 'style': 'white-space:pre-wrap' },
				_('保存并应用失败：%s').format((err && err.message) ? err.message : String(err))), 'danger');
		}).finally(function() {
			/* The commit cleared the staged changes the header counter shows. */
			ui.changes.init();
		});
	},

	handleSave: null
});
