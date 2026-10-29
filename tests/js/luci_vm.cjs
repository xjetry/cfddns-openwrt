'use strict';
// Loads a LuCI JavaScript module the way luci.js require() does: the leading
// 'require name [as alias]' strings name its dependencies, the source becomes
// the body of function(window, document, L, ...dependencies), and the class it
// returns is instantiated once. Each module runs in its own vm context that
// provides LuCI's globals _(), E() and String.prototype.format.
//
// fakeRpc and fakeFs reproduce the reply handling of the device's rpc.js and
// fs.js, so tests see the same resolve/reject behaviour as a real router.
//
// E() follows luci.js dom.append(): an array of children becomes text nodes
// and elements, but a lone string child is assigned as innerHTML, so such
// elements are marked html: true for tests to reject.

const fs = require('node:fs');
const vm = require('node:vm');

const REQUIRE = /^require[ \t]+(\S+)(?:[ \t]+as[ \t]+([a-zA-Z_]\S*))?$/;

const GLOBALS = `
String.prototype.format = function() {
	var args = arguments, i = 0;
	return this.replace(/%([%sd])/g, function(m, type) {
		if (type == '%')
			return '%';
		var value = args[i++];
		return (type == 'd') ? String(parseInt(value, 10)) : String(value);
	});
};
function _(msgid) { return msgid; }
function E(tag, attrs, children) {
	if (attrs == null || typeof(attrs) != 'object' || Array.isArray(attrs) || attrs.isElement) {
		children = attrs;
		attrs = {};
	}
	var el = { isElement: true, tag: tag, attrs: attrs, children: (children == null) ? [] : [].concat(children) };
	if (children != null && typeof(children) != 'object' && typeof(children) != 'function')
		el.html = true;
	return el;
}
`;

const L = {
	isObject: (value) => value != null && typeof value == 'object',
};

function parseRequires(source) {
	const required = [];
	const prologue = /\s*'([^'\\]*)';/y;
	let m;
	while ((m = prologue.exec(source)) !== null) {
		if (m[1] === 'use strict')
			continue;
		const r = REQUIRE.exec(m[1]);
		if (!r)
			break;
		required.push({ name: r[1], as: r[2] || r[1].replace(/[^a-zA-Z0-9_]/g, '_') });
	}
	return required;
}

// loadModule(file, deps, globals) evaluates a LuCI module; deps maps every
// required module name to its fake and must match the module's requires
// exactly. globals.document replaces the module's empty document object.
function loadModule(file, deps, globals = {}) {
	const source = fs.readFileSync(file, 'utf8');
	const required = parseRequires(source);
	const wanted = required.map((r) => r.name).sort().join(', ');
	const given = Object.keys(deps).sort().join(', ');
	if (wanted !== given)
		throw new Error(`${file} requires [${wanted}], test provides [${given}]`);
	const context = vm.createContext({});
	vm.runInContext(GLOBALS, context);
	const params = ['window', 'document', 'L'].concat(required.map((r) => r.as));
	const factory = vm.runInContext(`(function(${params.join(', ')}) { ${source}\n})`, context, { filename: file });
	const Class = factory.apply(factory, [context, globals.document || {}, L].concat(required.map((r) => deps[r.name])));
	if (typeof Class !== 'function')
		throw new TypeError(`${file} does not return a class`);
	return new Class();
}

function makeClass(proto, props) {
	function Class() {
		if (typeof this.__init__ === 'function')
			this.__init__.apply(this, arguments);
	}
	Class.prototype = Object.assign(Object.create(proto), props);
	Class.prototype.constructor = Class;
	Class.extend = (more) => makeClass(Class.prototype, more);
	return Class;
}

const baseclass = { extend: (props) => makeClass(Object.prototype, props) };

// plain copies a value from a module's vm context into this realm.
function plain(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// fakeRpc follows reference rpc.js: declare() maps positional arguments onto
// options.params, a handler returns the ubus [status, data] reply, reject:true
// turns a non-zero status into an error, and expect picks and type-checks the
// reply. Every call is appended to log as { ubus: 'object.method', params }.
function fakeRpc(log, handlers) {
	const type = Object.prototype.toString;
	return {
		declare(options) {
			return function () {
				const params = {};
				(options.params || []).forEach((name, i) => { params[name] = arguments[i]; });
				const method = `${options.object}.${options.method}`;
				log.push({ ubus: method, params: plain(params) });
				return Promise.resolve().then(() => {
					if (!handlers[method])
						throw new Error(`unexpected ubus call ${method}`);
					const reply = handlers[method](plain(params));
					if (options.reject && reply[0] !== 0)
						throw new Error(`RPC call to ${method} failed with ubus code ${reply[0]}`);
					let ret = reply.length > 1 ? reply[1] : reply[0];
					for (const key in options.expect || {}) {
						if (ret != null && key !== '')
							ret = ret[key];
						if (ret == null || type.call(ret) !== type.call(options.expect[key]))
							ret = options.expect[key];
						break;
					}
					return ret;
				});
			};
		},
		getStatusText: (code) => `ubus status ${code}`,
	};
}

// Error names reference fs.js gives each non-zero rpcd status.
const RPC_ERRORS = [null, 'InvalidCommandError', 'InvalidArgumentError', 'MethodNotFoundError', 'NotFoundError',
	'NoDataError', 'PermissionError', 'TimeoutError', 'UnsupportedError'];

function rpcError(status, what) {
	const err = new Error(`rpcd status ${status} for ${what}`);
	err.name = RPC_ERRORS[status] || 'Error';
	return err;
}

// fakeFs follows reference fs.js exec() and read(): an rpcd error status (a
// number from the handler) rejects with the matching error name, e.g.
// NotFoundError for a missing file; otherwise exec resolves with
// { code, stdout, stderr } whatever the exit code and read with the file's
// text. Calls are logged as { exec: 'command args...' }, plus env: true if
// the caller passed an environment, and { read: path }.
function fakeFs(log, handler, reader) {
	return {
		exec(command, params, env) {
			const cmdline = [command].concat(Array.isArray(params) ? params : []).join(' ');
			log.push(arguments.length > 2 ? { exec: cmdline, env: true } : { exec: cmdline });
			return Promise.resolve().then(() => {
				const res = handler(cmdline);
				if (typeof res === 'number')
					throw rpcError(res, cmdline);
				return res;
			});
		},
		read(path) {
			log.push({ read: path });
			return Promise.resolve().then(() => {
				if (!reader)
					throw new Error(`unexpected read ${path}`);
				const res = reader(path);
				if (typeof res === 'number')
					throw rpcError(res, path);
				return res;
			});
		},
	};
}

module.exports = { loadModule, makeClass, baseclass, plain, fakeRpc, fakeFs };
