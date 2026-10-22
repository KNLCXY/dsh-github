window.__ModuleLoader__.load({
	id: "dsh-github",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var React = react.default !== undefined ? react.default : react;
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;

		var inject = ["slots"];
		var ENDPOINT = "/_dsh-github/settings";

		var S = {
			wrap: { display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px", maxWidth: "620px" },
			lead: { fontSize: "12px", lineHeight: "1.65", opacity: 0.68 },
			card: {
				display: "flex", flexDirection: "column", gap: "9px", padding: "10px 12px", borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28))",
			},
			row: { display: "grid", gridTemplateColumns: "92px 1fr", gap: "8px", alignItems: "center" },
			label: { fontSize: "12px", opacity: 0.72 },
			input: {
				font: "inherit", fontSize: "12.5px", padding: "6px 9px", borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35))",
				background: "var(--dsw-alias-bg-layer-1,transparent)", color: "inherit",
				width: "100%", boxSizing: "border-box", outline: "none",
			},
			btns: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "2px" },
			btn: {
				font: "inherit", fontSize: "12.5px", padding: "6px 13px", borderRadius: "7px", cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35))", background: "transparent", color: "inherit",
			},
			btnPrimary: { border: "1px solid rgba(76,154,255,.65)", background: "rgba(76,154,255,.14)", fontWeight: 600 },
			btnOff: { opacity: 0.45, cursor: "default" },
			note: { fontSize: "11.5px", lineHeight: "1.6", opacity: 0.55 },
			ok: { color: "#2ea043" },
			bad: { color: "#d9534f" },
			kv: { display: "grid", gridTemplateColumns: "88px 1fr", gap: "4px 10px", fontSize: "12px" },
			kvKey: { opacity: 0.55 },
		};

		function statusLine(data) {
			if (!data) return "未读取到状态";
			if (!data.hasToken) return "未配置 token —— 工具会提示你去设置里填";
			return "已配置 " + data.tokenHint + "（只显示前 4 位和末 4 位）";
		}

		function Panel() {
			var state = useState(null);       // 设置快照
			var data = state[0], setData = state[1];
			var tok = useState("");           // 输入框：永远是空的，只有占位示例
			var token = tok[0], setToken = tok[1];
			var api = useState("");
			var apiBase = api[0], setApiBase = api[1];
			var proxy = useState("");
			var proxyUrl = proxy[0], setProxyUrl = proxy[1];
			var busyState = useState(false);
			var busy = busyState[0], setBusy = busyState[1];
			var msgState = useState("");
			var msg = msgState[0], setMsg = msgState[1];
			var dirty = token.length > 0 || apiBase.length > 0 || proxyUrl.length > 0;

			function load() {
				fetch(ENDPOINT, { headers: { accept: "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (j) {
						if (j && j.ok) {
							setData(j);
							// 这里刻意不预填 apiBase / proxyUrl —— 只有当前值为空时才显示占位示例
							setApiBase("");
							setProxyUrl("");
						}
					})
					.catch(function () {});
			}

			useEffect(load, []);

			function post(patch, okText) {
				setBusy(true);
				setMsg("");
				fetch(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch),
				})
					.then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); })
					.then(function (out) {
						if (out.status === 200 && out.json.ok) {
							setData(out.json);
							setToken("");
							setApiBase("");
							setProxyUrl("");
							setMsg(okText || "已保存");
						} else {
							setMsg("失败：" + ((out.json && out.json.error) || ("HTTP " + out.status)));
						}
					})
					.catch(function (e) { setMsg("失败：" + String(e && e.message ? e.message : e)); })
					.then(function () { setBusy(false); });
			}

			function save() {
				var patch = {};
				if (token.trim()) patch.token = token.trim();
				if (apiBase.trim()) patch.apiBase = apiBase.trim();
				if (proxyUrl.trim()) patch.proxyUrl = proxyUrl.trim();
				if (!Object.keys(patch).length) { setMsg("没有要保存的改动"); return; }
				post(patch, "已保存（下一轮工具调用即生效，不用重启）");
			}

			function clearToken() { post({ token: "" }, "已清除 token"); }

			return h("div", { style: S.wrap },
				h("div", { style: S.lead },
					"给 agent 用的 GitHub 工具：调 REST API、一次提交多个文件、建仓库。",
					"token 只存在 ", h("code", null, "~/.dsh/storages/dsh-github/settings.json"),
					"，不会进仓库、也不会出现在任何工具结果里。"),

				h("div", { style: S.card },
					h("div", { style: { fontSize: "12px", fontWeight: 600, opacity: 0.55 } }, "访问令牌"),
					h("div", { style: S.row },
						h("span", { style: S.label }, "GitHub token"),
						h("input", {
							style: S.input,
							type: "password",
							autoComplete: "off",
							// 只有示例，没有默认值：不填就等于没配
							placeholder: (data && data.tokenPlaceholder) || "ghp_xxxxxxxxxxxxxxxxxxxx",
							value: token,
							onChange: function (e) { setToken(e.target.value); },
						})),
					h("div", { style: S.row },
						h("span", { style: S.label }, "API 地址"),
						h("input", {
							style: S.input,
							type: "text",
							autoComplete: "off",
							placeholder: (data && data.apiBase) || "https://api.github.com",
							value: apiBase,
							onChange: function (e) { setApiBase(e.target.value); },
						})),
					h("div", { style: S.row },
						h("span", { style: S.label }, "代理"),
						h("input", {
							style: S.input,
							type: "text",
							autoComplete: "off",
							placeholder: data && data.proxyUrl ? data.proxyUrl : "http://127.0.0.1:7897（留空 = 直连）",
							value: proxyUrl,
							onChange: function (e) { setProxyUrl(e.target.value); },
						})),

					h("div", { style: S.btns },
						h("button", {
							type: "button",
							style: Object.assign({}, S.btn, S.btnPrimary, busy ? S.btnOff : null),
							disabled: busy,
							onClick: save,
						}, busy ? "保存中…" : "保存"),
						h("button", {
							type: "button", style: S.btn, disabled: busy || !(data && data.hasToken), onClick: clearToken,
						}, "清除 token"),
						h("button", { type: "button", style: S.btn, disabled: busy, onClick: load }, "刷新状态")),

					h("div", { style: msg ? { fontSize: "12px", opacity: 0.85 } : S.note }, msg || "填好后点保存；工具下一轮调用即生效。"),
					h("div", { style: { fontSize: "12px", opacity: 0.8 } },
						h("span", { style: data && data.hasToken ? S.ok : S.bad }, data && data.hasToken ? "● " : "○ "),
						statusLine(data)),

					data
						? h("div", { style: S.kv },
							h("span", { style: S.kvKey }, "配置文件"),
							h("span", { style: { wordBreak: "break-all", opacity: 0.8 } }, data.settingsPath || "—"))
						: null),

				h("div", { style: S.note },
					"权限怎么选：只想读仓库 → Contents: Read；要提交文件 → Contents: Read and write；" +
					"要设 topics / 建仓库 → 再加上 Administration。classic token 勾一个 repo 就都有了。"),
			);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register(
					{ name: "settings.section", id: "dsh-github", order: 62, label: "GitHub" },
					Panel);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
