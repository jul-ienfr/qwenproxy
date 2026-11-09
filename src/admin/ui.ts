/**
 * Dependency-free dashboard UI.
 *
 * The markup, styles and script are plain strings so the proxy keeps its
 * single-process, no-frontend-build deployment. All dynamic values are inserted
 * with textContent/createElement, never innerHTML.
 */

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QwenProxy Admin</title>
<link rel="stylesheet" href="/admin/assets/admin.css">
</head>
<body>
<div id="tls-warning" class="warning hidden">Dashboard is served over plain HTTP. Use TLS or a trusted tunnel before exposing it beyond loopback.</div>

<section id="login-view" class="login-shell hidden">
  <form id="login-form" class="card login-card">
    <h1>QwenProxy</h1>
    <p class="muted">Administration dashboard</p>
    <label for="api-key">Admin API key</label>
    <input id="api-key" type="password" autocomplete="current-password" placeholder="sk-... (empty is allowed on a no-key loopback install)">
    <button type="submit">Sign in</button>
    <p id="login-error" class="error" role="alert"></p>
  </form>
</section>

<section id="app-view" class="hidden">
  <header class="topbar">
    <div class="brand">QwenProxy <span id="version" class="muted"></span></div>
    <div class="live"><span id="live-dot" class="dot"></span><span id="live-status">connecting</span></div>
    <div class="session"><span id="session-label"></span><button id="logout" class="ghost" type="button">Sign out</button></div>
  </header>

  <nav id="tabs" class="tabs">
    <button data-tab="overview" class="active" type="button">Overview</button>
    <button data-tab="accounts" type="button">Accounts</button>
    <button data-tab="users" type="button">Users</button>
    <button data-tab="models" type="button">Models</button>
    <button data-tab="settings" type="button">Settings</button>
    <button data-tab="logs" type="button">Logs</button>
    <button data-tab="audit" type="button">Audit</button>
  </nav>

  <main>
    <section id="tab-overview" class="tab">
      <div class="section-head"><h2>Overview</h2><span id="overview-updated" class="muted"></span></div>
      <div id="kpi-grid" class="kpi-grid"></div>
      <div class="card">
        <div class="section-head"><h3>Accounts</h3><button id="overview-refresh" class="ghost" type="button">Refresh</button></div>
        <div class="table-wrap"><table><thead><tr><th>Account</th><th>Status</th><th>Proxy</th><th>Cooldown</th></tr></thead><tbody id="overview-accounts"></tbody></table></div>
      </div>
    </section>

    <section id="tab-accounts" class="tab hidden">
      <div class="section-head"><h2>Accounts</h2><button id="clear-all-cooldowns" class="ghost" type="button">Clear all cooldowns</button></div>
      <form id="account-form" class="card form-grid">
        <h3>Add account</h3>
        <label>Email<input id="account-email" type="email" autocomplete="off" required></label>
        <label>Password<input id="account-password" type="password" autocomplete="new-password"></label>
        <label>Proxy (optional)<input id="account-proxy" type="text" placeholder="http://user:pass@host:port"></label>
        <button type="submit">Add account</button>
        <p id="accounts-error" class="error" role="alert"></p>
      </form>
      <div class="card">
        <div class="table-wrap"><table><thead><tr><th>Account</th><th>Status</th><th>Proxy</th><th>Cooldown</th><th>Actions</th></tr></thead><tbody id="accounts-table"></tbody></table></div>
      </div>
    </section>

    <section id="tab-users" class="tab hidden">
      <div class="section-head"><h2>Users</h2><span class="muted">Keys are shown once, then stored hashed.</span></div>
      <div id="new-key-banner" class="card key-banner hidden">
        <div><strong id="new-key-label"></strong><pre id="new-key-value"></pre></div>
        <button id="copy-key" class="ghost" type="button">Copy key</button>
      </div>
      <form id="user-form" class="card form-grid">
        <h3>Create user</h3>
        <label>Label<input id="user-label" type="text" required></label>
        <label>Role<select id="user-role"><option value="user">user</option><option value="admin">admin</option></select></label>
        <label>RPM (0 = unlimited)<input id="user-rpm" type="number" min="0" step="1" value="0"></label>
        <label>Concurrency (0 = unlimited)<input id="user-concurrency" type="number" min="0" step="1" value="0"></label>
        <button type="submit">Create user</button>
        <p id="users-error" class="error" role="alert"></p>
      </form>
      <div class="card">
        <div class="table-wrap"><table><thead><tr><th>Label</th><th>Role</th><th>Key</th><th>RPM</th><th>Streams</th><th>Status</th><th>Actions</th></tr></thead><tbody id="users-table"></tbody></table></div>
      </div>
    </section>

    <section id="tab-models" class="tab hidden">
      <div class="section-head"><h2>Models</h2><span id="models-meta" class="muted"></span></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Context</th><th>Capabilities</th></tr></thead><tbody id="models-table"></tbody></table></div></div>
      <p id="models-error" class="error" role="alert"></p>
    </section>

    <section id="tab-settings" class="tab hidden">
      <div class="section-head"><h2>Settings</h2><span class="muted">Only allowlisted values can be changed.</span></div>
      <form id="settings-form" class="card"></form>
      <p id="settings-error" class="error" role="alert"></p>
      <form id="model-mappings-form" class="card mapping-editor">
        <h3>Model mappings</h3>
        <p class="muted">Rewrite client model names to Qwen ids without restarting. Format: <code>alias=qwen-id</code> separated by commas or new lines; use <code>*=qwen-id</code> for a wildcard fallback. Exact aliases win over wildcard, and Qwen-native ids are never rewritten.</p>
        <label>Mappings
          <textarea id="model-mappings-map" rows="5" spellcheck="false" placeholder="gpt-4o=qwen3.8-max,claude-sonnet=qwen3.8-max,*=qwen3.7-plus"></textarea>
        </label>
        <p id="model-mappings-meta" class="muted"></p>
        <div class="actions">
          <button type="submit">Save mappings</button>
          <button id="model-mappings-reset" class="ghost" type="button">Reset to MODEL_MAP</button>
        </div>
        <p id="model-mappings-error" class="error" role="alert"></p>
      </form>
    </section>

    <section id="tab-logs" class="tab hidden">
      <div class="section-head"><h2>Logs</h2>
        <label class="inline">Level
          <select id="log-level"><option value="all">all</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option></select>
        </label>
      </div>
      <div id="logs-list" class="log-list card"></div>
      <p id="logs-error" class="error" role="alert"></p>
    </section>

    <section id="tab-audit" class="tab hidden">
      <div class="section-head"><h2>Audit</h2><span class="muted">Recent dashboard and admin API mutations.</span></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Result</th></tr></thead><tbody id="audit-table"></tbody></table></div></div>
    </section>
  </main>
</section>

<script src="/admin/assets/admin.js"></script>
</body>
</html>`;

export const ADMIN_CSS = `:root {
  color-scheme: dark;
  --bg: #0b1020;
  --panel: #141a2e;
  --panel-2: #1b2340;
  --border: #2a3558;
  --text: #e7ecff;
  --muted: #8e9bc4;
  --accent: #6c8cff;
  --ok: #37d39a;
  --warn: #f5b74e;
  --bad: #ff6b7a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
.hidden { display: none !important; }
.muted { color: var(--muted); }
.error { color: var(--bad); min-height: 1.2em; margin: 0; }
.warning { background: #3a2a10; color: #ffd28a; padding: 10px 16px; border-bottom: 1px solid #6a4d1b; }
.login-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 18px; margin: 0 0 18px; }
.login-card { width: min(420px, 100%); display: grid; gap: 12px; }
h1, h2, h3 { margin: 0 0 8px; line-height: 1.2; }
h1 { font-size: 26px; } h2 { font-size: 20px; } h3 { font-size: 16px; }
label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
label.inline { display: inline-flex; align-items: center; gap: 8px; }
input, select, button { font: inherit; }
input, select, textarea { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px; min-width: 0; }
textarea { resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
button { background: var(--accent); color: #071022; border: 0; border-radius: 9px; padding: 9px 14px; font-weight: 650; cursor: pointer; }
button:disabled { opacity: .55; cursor: wait; }
button.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); font-weight: 500; }
button.danger { background: transparent; color: var(--bad); border: 1px solid #5a2733; }
.topbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--border); background: #0e1426; position: sticky; top: 0; z-index: 5; }
.brand { font-weight: 750; letter-spacing: .2px; }
.live { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 13px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 3px rgba(245,183,78,.15); }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(55,211,154,.15); }
.dot.bad { background: var(--bad); box-shadow: 0 0 0 3px rgba(255,107,122,.15); }
.session { display: flex; align-items: center; gap: 12px; color: var(--muted); }
.tabs { display: flex; gap: 6px; padding: 12px 20px; overflow-x: auto; border-bottom: 1px solid var(--border); background: #0d1324; position: sticky; top: 58px; z-index: 4; }
.tabs button { background: transparent; color: var(--muted); border: 1px solid transparent; white-space: nowrap; }
.tabs button.active { color: var(--text); border-color: var(--border); background: var(--panel); }
main { padding: 20px; max-width: 1400px; margin: 0 auto; }
.section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 18px; }
.kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
.kpi-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
.kpi-value { font-size: 24px; font-weight: 750; margin-top: 4px; }
.kpi-hint { color: var(--muted); font-size: 12px; margin-top: 2px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 620px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .4px; }
tr:last-child td { border-bottom: 0; }
.chip { display: inline-block; border-radius: 999px; padding: 2px 9px; font-size: 12px; border: 1px solid var(--border); color: var(--muted); }
.chip.ok { color: var(--ok); border-color: #1f6b52; }
.chip.warn { color: var(--warn); border-color: #6a4d1b; }
.chip.bad { color: var(--bad); border-color: #5a2733; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.actions button { padding: 5px 9px; font-size: 12px; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; align-items: end; }
.form-grid h3, .form-grid .error { grid-column: 1 / -1; margin: 0; }
.key-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; border-color: #6a4d1b; background: #2a210f; }
.key-banner pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-all; color: #ffd28a; }
.log-list { max-height: 60vh; overflow: auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.log-line { display: grid; grid-template-columns: 70px 54px 1fr; gap: 8px; padding: 4px 0; border-bottom: 1px solid #202945; }
.log-line:last-child { border-bottom: 0; }
.log-level-INFO { color: var(--muted); }
.log-level-WARN { color: var(--warn); }
.log-level-ERROR { color: var(--bad); }
.settings-group { border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 12px; }
.settings-group h3 { margin-bottom: 10px; }
.settings-row { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(200px, 2fr); gap: 12px; align-items: center; padding: 7px 0; }
.settings-row .help { color: var(--muted); font-size: 12px; }
@media (max-width: 700px) {
  .topbar { position: static; }
  .tabs { top: 0; }
  main { padding: 14px; }
  .settings-row { grid-template-columns: 1fr; }
  .log-line { grid-template-columns: 60px 48px 1fr; }
}
`;

export const ADMIN_JS = `(function () {
  "use strict";

  var state = {
    csrf: null,
    user: null,
    tab: "overview",
    es: null,
    pollTimer: null,
    logsTimer: null,
    logsRefreshTimer: null,
    overview: null
  };

  function byId(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function setError(id, message) {
    var node = byId(id);
    if (node) node.textContent = message || "";
  }

  function api(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.method && options.method !== "GET" && state.csrf) {
      headers["x-csrf-token"] = state.csrf;
    }
    return fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }).then(function (response) {
      if (response.status === 401) {
        showLogin();
        throw new Error("Session expired. Sign in again.");
      }
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          throw new Error((body.error && body.error.message) || ("HTTP " + response.status));
        }
        return body;
      });
    });
  }

  function setLive(ok) {
    var dot = byId("live-dot");
    var label = byId("live-status");
    if (!dot || !label) return;
    dot.className = "dot " + (ok ? "ok" : "bad");
    label.textContent = ok ? "live" : "polling (degraded)";
  }

  function stopLive() {
    if (state.es) { state.es.close(); state.es = null; }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.logsTimer) { clearInterval(state.logsTimer); state.logsTimer = null; }
    if (state.logsRefreshTimer) { clearTimeout(state.logsRefreshTimer); state.logsRefreshTimer = null; }
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(function () {
      if (state.tab === "overview") loadOverview();
    }, 5000);
    setLive(false);
  }

  function startLive() {
    stopLive();
    loadOverview();
    if (typeof EventSource === "undefined") { startPolling(); return; }
    var source = new EventSource("/admin/api/events");
    state.es = source;
    source.addEventListener("overview", function (event) {
      setLive(true);
      try {
        var data = JSON.parse(event.data);
        state.overview = data;
        renderOverview(data);
      } catch (error) {}
    });
    source.addEventListener("log", function () {
      if (state.tab !== "logs" || state.logsRefreshTimer) return;
      state.logsRefreshTimer = setTimeout(function () {
        state.logsRefreshTimer = null;
        if (state.tab === "logs") loadLogs();
      }, 800);
    });
    source.onopen = function () { setLive(true); };
    source.onerror = function () {
      setLive(false);
      source.close();
      state.es = null;
      startPolling();
    };
  }

  function showLogin() {
    stopLive();
    state.csrf = null;
    state.user = null;
    byId("app-view").classList.add("hidden");
    byId("login-view").classList.remove("hidden");
    byId("login-error").textContent = "";
  }

  function showApp() {
    byId("login-view").classList.add("hidden");
    byId("app-view").classList.remove("hidden");
    byId("session-label").textContent = state.user ? state.user.label : "";
    startLive();
    selectTab(state.tab || "overview");
  }

  function kpi(label, value, hint) {
    return el("div", { class: "kpi" }, [
      el("div", { class: "kpi-label", text: label }),
      el("div", { class: "kpi-value", text: value }),
      hint ? el("div", { class: "kpi-hint", text: hint }) : null
    ]);
  }

  function formatDuration(seconds) {
    var value = Math.max(0, Number(seconds) || 0);
    var days = Math.floor(value / 86400);
    var hours = Math.floor((value % 86400) / 3600);
    var minutes = Math.floor((value % 3600) / 60);
    if (days > 0) return days + "d " + hours + "h";
    if (hours > 0) return hours + "h " + minutes + "m";
    return minutes + "m";
  }

  function accountStatus(account) {
    if (account.cooldown_remaining_ms > 0) {
      return el("span", { class: "chip warn", text: "cooldown " + formatDuration(account.cooldown_remaining_ms / 1000) });
    }
    if (account.active) return el("span", { class: "chip ok", text: "active" });
    if (account.headers_ready) return el("span", { class: "chip ok", text: "ready" });
    return el("span", { class: "chip", text: "standby" });
  }

  function renderOverview(data) {
    byId("version").textContent = "v" + data.version;
    byId("overview-updated").textContent = "updated " + new Date(data.timestamp).toLocaleTimeString();
    var grid = byId("kpi-grid");
    grid.replaceChildren(
      kpi("Accounts", data.accounts.ready + "/" + data.accounts.total, data.accounts.cooldown + " on cooldown"),
      kpi("Active streams", String(data.streams.active), "limit shared with clients"),
      kpi("Requests/min", String(data.requests.rpm), "last 60 seconds"),
      kpi("Error rate", data.requests.errorRatePercent.toFixed(1) + "%", data.requests.errorsPerMinute + " errors/min"),
      kpi("Avg latency", data.latency.avgMs + " ms", "since process start"),
      kpi("Memory", data.memory.rssMb.toFixed(0) + " MB", "heap " + data.memory.heapUsagePercent.toFixed(1) + "%"),
      kpi("Tokens today", String(data.usage.totalTokens), data.usage.poolUsagePercent.toFixed(1) + "% of pool"),
      kpi("Uptime", formatDuration(data.uptimeSec), data.chatMode)
    );

    var tbody = byId("overview-accounts");
    var rows = (data.accounts.list || []).map(function (account) {
      return el("tr", {}, [
        el("td", { text: account.email }),
        el("td", {}, [accountStatus(account)]),
        el("td", { text: account.proxy || "(direct)" }),
        el("td", { text: account.cooldown_reason || "-" })
      ]);
    });
    if (rows.length === 0) {
      rows.push(el("tr", {}, [el("td", { colspan: "4", class: "muted", text: "No accounts configured." })]));
    }
    tbody.replaceChildren.apply(tbody, rows);
  }

  function loadOverview() {
    return api("/admin/api/overview").then(function (data) {
      state.overview = data;
      renderOverview(data);
    }).catch(function () {});
  }

  function accountAction(id, action, button) {
    var encoded = encodeURIComponent(id);
    if (action === "delete") {
      if (!window.confirm("Remove this account? Its browser profile and sessions will be deleted.")) return;
      api("/admin/api/accounts/" + encoded, { method: "DELETE" }).then(function () {
        loadAccounts();
      }).catch(function (error) { setError("accounts-error", error.message); });
      return;
    }
    if (action === "proxy") {
      var current = window.prompt("Proxy URL (empty = direct)", "");
      if (current === null) return;
      api("/admin/api/accounts/" + encoded + "/proxy", {
        method: "PATCH",
        body: { proxy: current.trim() || null }
      }).then(function () { loadAccounts(); })
        .catch(function (error) { setError("accounts-error", error.message); });
      return;
    }
    if (action === "refresh") {
      if (button) { button.disabled = true; button.textContent = "Refreshing..."; }
      api("/admin/api/accounts/" + encoded + "/headers/refresh", { method: "POST", body: {} })
        .then(function () { loadAccounts(); })
        .catch(function (error) { setError("accounts-error", error.message); })
        .finally(function () { if (button) { button.disabled = false; button.textContent = "Refresh headers"; } });
      return;
    }
    if (action === "cooldown") {
      api("/admin/api/accounts/" + encoded + "/cooldown/clear", { method: "POST", body: {} })
        .then(function () { loadAccounts(); })
        .catch(function (error) { setError("accounts-error", error.message); });
    }
  }

  function renderAccounts(accounts) {
    var tbody = byId("accounts-table");
    var rows = accounts.map(function (account) {
      return el("tr", {}, [
        el("td", { text: account.email }),
        el("td", {}, [accountStatus(account)]),
        el("td", { text: account.proxy || "(direct)" }),
        el("td", { text: account.cooldown_reason || "-" }),
        el("td", {}, [el("div", { class: "actions" }, [
          el("button", { class: "ghost", type: "button", text: "Clear cooldown", onclick: function () { accountAction(account.id, "cooldown"); } }),
          el("button", { class: "ghost", type: "button", text: "Edit proxy", onclick: function () { accountAction(account.id, "proxy"); } }),
          el("button", { class: "ghost", type: "button", text: "Refresh headers", onclick: function (event) { accountAction(account.id, "refresh", event.currentTarget); } }),
          el("button", { class: "danger", type: "button", text: "Remove", onclick: function () { accountAction(account.id, "delete"); } })
        ])])
      ]);
    });
    if (rows.length === 0) {
      rows.push(el("tr", {}, [el("td", { colspan: "5", class: "muted", text: "No accounts configured." })]));
    }
    tbody.replaceChildren.apply(tbody, rows);
  }

  function loadAccounts() {
    setError("accounts-error", "");
    return api("/admin/api/accounts").then(function (data) {
      renderAccounts(data.accounts || []);
    }).catch(function (error) { setError("accounts-error", error.message); });
  }

  function showKey(label, key) {
    byId("new-key-label").textContent = "API key for " + label;
    byId("new-key-value").textContent = key;
    byId("new-key-banner").classList.remove("hidden");
    byId("new-key-banner").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function userAction(id, action, user) {
    var encoded = encodeURIComponent(id);
    if (action === "rotate") {
      if (!window.confirm("Rotate the key for " + user.label + "? The old key stops working immediately.")) return;
      api("/admin/api/users/" + encoded + "/rotate", { method: "POST", body: {} })
        .then(function (data) { showKey(data.user.label, data.api_key); loadUsers(); })
        .catch(function (error) { setError("users-error", error.message); });
      return;
    }
    if (action === "revoke") {
      if (!window.confirm("Revoke the key for " + user.label + "?")) return;
      api("/admin/api/users/" + encoded, { method: "DELETE" })
        .then(function () { loadUsers(); })
        .catch(function (error) { setError("users-error", error.message); });
      return;
    }
    if (action === "limits") {
      var rpm = window.prompt("Requests per minute (0 = unlimited)", String(user.rate_limit_rpm));
      if (rpm === null) return;
      var concurrency = window.prompt("Max concurrent streams (0 = unlimited)", String(user.max_concurrency));
      if (concurrency === null) return;
      api("/admin/api/users/" + encoded, {
        method: "PATCH",
        body: { rpm: Number(rpm), concurrency: Number(concurrency) }
      }).then(function () { loadUsers(); })
        .catch(function (error) { setError("users-error", error.message); });
    }
  }

  function renderUsers(users) {
    var tbody = byId("users-table");
    var rows = users.map(function (user) {
      var status = user.revoked_at
        ? el("span", { class: "chip bad", text: "revoked" })
        : el("span", { class: "chip ok", text: "active" });
      return el("tr", {}, [
        el("td", { text: user.label }),
        el("td", { text: user.role }),
        el("td", { text: user.prefix + "..." }),
        el("td", { text: String(user.rate_limit_rpm) }),
        el("td", { text: String(user.active_streams || 0) }),
        el("td", {}, [status]),
        el("td", {}, [el("div", { class: "actions" }, [
          el("button", { class: "ghost", type: "button", text: "Limits", onclick: function () { userAction(user.id, "limits", user); } }),
          el("button", { class: "ghost", type: "button", text: "Rotate", onclick: function () { userAction(user.id, "rotate", user); } }),
          user.revoked_at ? null : el("button", { class: "danger", type: "button", text: "Revoke", onclick: function () { userAction(user.id, "revoke", user); } })
        ])])
      ]);
    });
    if (rows.length === 0) {
      rows.push(el("tr", {}, [el("td", { colspan: "7", class: "muted", text: "No users configured." })]));
    }
    tbody.replaceChildren.apply(tbody, rows);
  }

  function loadUsers() {
    setError("users-error", "");
    return api("/admin/api/users").then(function (data) {
      renderUsers(data.users || []);
    }).catch(function (error) { setError("users-error", error.message); });
  }

  function loadModels() {
    setError("models-error", "");
    byId("models-meta").textContent = "loading...";
    return api("/admin/api/models").then(function (data) {
      var tbody = byId("models-table");
      var models = data.models || [];
      var rows = models.map(function (model) {
        var capabilities = model.capabilities
          ? Object.keys(model.capabilities).filter(function (key) { return model.capabilities[key]; }).join(", ")
          : (model.media_generation || "-");
        return el("tr", {}, [
          el("td", { text: model.id }),
          el("td", { text: model.name || model.id }),
          el("td", { text: model.context_window ? String(model.context_window) : "-" }),
          el("td", { text: capabilities || "-" })
        ]);
      });
      if (rows.length === 0) {
        rows.push(el("tr", {}, [el("td", { colspan: "4", class: "muted", text: "No models available." })]));
      }
      tbody.replaceChildren.apply(tbody, rows);
      byId("models-meta").textContent = models.length + " models" + (data.accountId ? " (catalog account " + data.accountId.slice(0, 8) + ")" : "");
    }).catch(function (error) {
      byId("models-meta").textContent = "";
      setError("models-error", error.message);
    });
  }

  function settingInput(setting) {
    if (setting.type === "select") {
      var select = el("select", {});
      (setting.options || []).forEach(function (option) {
        var node = el("option", { value: option, text: option });
        if (option === setting.value) node.selected = true;
        select.append(node);
      });
      return select;
    }
    if (setting.type === "boolean") {
      var checkbox = el("input", { type: "checkbox" });
      checkbox.checked = Boolean(setting.value);
      return checkbox;
    }
    var input = el("input", {
      type: setting.type === "number" ? "number" : "text",
      value: String(setting.value)
    });
    if (setting.type === "number") { input.min = "0"; input.step = "1"; }
    return input;
  }

  function renderSettings(settings) {
    var form = byId("settings-form");
    var groups = {};
    settings.forEach(function (setting) {
      if (!groups[setting.group]) groups[setting.group] = [];
      groups[setting.group].push(setting);
    });
    var nodes = Object.keys(groups).map(function (group) {
      var container = el("div", { class: "settings-group" }, [el("h3", { text: group })]);
      groups[group].forEach(function (setting) {
        var input = settingInput(setting);
        input.dataset.key = setting.key;
        container.append(el("div", { class: "settings-row" }, [
          el("div", {}, [
            el("div", { text: setting.label }),
            el("div", { class: "help", text: setting.help + (setting.restartRequired ? " Restart required." : "") })
          ]),
          input
        ]));
      });
      return container;
    });
    nodes.push(el("div", { class: "actions" }, [
      el("button", { type: "submit", text: "Save settings" })
    ]));
    form.replaceChildren.apply(form, nodes);
  }

  function loadSettings() {
    return api("/admin/api/settings").then(function (data) {
      renderSettings(data.settings || []);
    }).catch(function (error) { setError("settings-error", error.message); });
  }

  function saveSettings(event) {
    event.preventDefault();
    var values = {};
    byId("settings-form").querySelectorAll("[data-key]").forEach(function (input) {
      var key = input.dataset.key;
      if (input.type === "checkbox") values[key] = input.checked;
      else if (input.type === "number") values[key] = Number(input.value);
      else values[key] = input.value;
    });
    api("/admin/api/settings", { method: "PUT", body: { values: values } })
      .then(function (data) {
        setError("settings-error", "");
        renderSettings(data.settings || []);
      })
      .catch(function (error) { setError("settings-error", error.message); });
  }

  function mappingText(state) {
    var lines = (state.entries || []).map(function (entry) {
      return entry.alias + "=" + entry.target;
    });
    if (state.fallback) lines.push("*=" + state.fallback);
    return lines.join(",\n");
  }

  function mappingSourceLabel(state) {
    if (state.source === "file") return "saved file";
    if (state.source === "env") return "MODEL_MAP seed";
    return "no mapping";
  }

  function renderModelMappings(state) {
    byId("model-mappings-map").value = mappingText(state);
    var meta = "Source: " + mappingSourceLabel(state);
    if (state.updatedAt) meta += " (updated " + state.updatedAt + ")";
    byId("model-mappings-meta").textContent = meta;
  }

  function loadModelMappings() {
    return api("/admin/api/model-mappings").then(function (state) {
      renderModelMappings(state);
      setError("model-mappings-error", "");
    }).catch(function (error) { setError("model-mappings-error", error.message); });
  }

  function saveModelMappings(event) {
    event.preventDefault();
    setError("model-mappings-error", "");
    api("/admin/api/model-mappings", {
      method: "PUT",
      body: { map: byId("model-mappings-map").value }
    }).then(function (state) {
      renderModelMappings(state);
    }).catch(function (error) { setError("model-mappings-error", error.message); });
  }

  function resetModelMappings() {
    if (!window.confirm("Reset model mappings to the MODEL_MAP seed?")) return;
    setError("model-mappings-error", "");
    api("/admin/api/model-mappings", { method: "DELETE" })
      .then(function (state) { renderModelMappings(state); })
      .catch(function (error) { setError("model-mappings-error", error.message); });
  }

  function renderLogs(logs) {
    var list = byId("logs-list");
    var nodes = logs.map(function (entry) {
      return el("div", { class: "log-line" }, [
        el("span", { class: "muted", text: entry.time }),
        el("span", { class: "log-level-" + entry.level, text: entry.level }),
        el("span", { text: entry.message })
      ]);
    });
    if (nodes.length === 0) {
      nodes.push(el("div", { class: "muted", text: "No log entries." }));
    }
    list.replaceChildren.apply(list, nodes);
    list.scrollTop = list.scrollHeight;
  }

  function loadLogs() {
    var level = byId("log-level").value;
    return api("/admin/api/logs?level=" + encodeURIComponent(level) + "&limit=300")
      .then(function (data) { renderLogs(data.logs || []); })
      .catch(function (error) { setError("logs-error", error.message); });
  }

  function loadAudit() {
    return api("/admin/api/audit?limit=150").then(function (data) {
      var tbody = byId("audit-table");
      var rows = (data.records || []).map(function (record) {
        return el("tr", {}, [
          el("td", { text: record.created_at }),
          el("td", { text: record.actor }),
          el("td", { text: record.action }),
          el("td", { text: record.target }),
          el("td", {}, [el("span", { class: "chip " + (record.result === "ok" ? "ok" : "bad"), text: record.result })])
        ]);
      });
      if (rows.length === 0) {
        rows.push(el("tr", {}, [el("td", { colspan: "5", class: "muted", text: "No audit records yet." })]));
      }
      tbody.replaceChildren.apply(tbody, rows);
    }).catch(function () {});
  }

  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll("#tabs button").forEach(function (button) {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
    document.querySelectorAll(".tab").forEach(function (section) {
      section.classList.toggle("hidden", section.id !== "tab-" + tab);
    });
    if (state.logsTimer) { clearInterval(state.logsTimer); state.logsTimer = null; }
    if (tab === "overview") loadOverview();
    if (tab === "accounts") loadAccounts();
    if (tab === "users") loadUsers();
    if (tab === "models") loadModels();
    if (tab === "settings") {
      loadSettings();
      loadModelMappings();
    }
    if (tab === "logs") {
      loadLogs();
      state.logsTimer = setInterval(function () {
        if (state.tab === "logs") loadLogs();
      }, 3000);
    }
    if (tab === "audit") loadAudit();
  }

  function wire() {
    byId("login-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var key = byId("api-key").value.trim();
      setError("login-error", "");
      api("/admin/api/session", { method: "POST", body: { apiKey: key } })
        .then(function (data) {
          state.csrf = data.csrf;
          state.user = data.user;
          showApp();
        })
        .catch(function (error) { setError("login-error", error.message); });
    });

    byId("logout").addEventListener("click", function () {
      api("/admin/api/session", { method: "DELETE" })
        .catch(function () {})
        .finally(function () { showLogin(); });
    });

    document.querySelectorAll("#tabs button").forEach(function (button) {
      button.addEventListener("click", function () { selectTab(button.dataset.tab); });
    });

    byId("overview-refresh").addEventListener("click", loadOverview);
    byId("clear-all-cooldowns").addEventListener("click", function () {
      if (!window.confirm("Clear every active account cooldown?")) return;
      api("/admin/api/accounts/cooldowns/clear", { method: "POST", body: {} })
        .then(function () { loadAccounts(); })
        .catch(function (error) { setError("accounts-error", error.message); });
    });

    byId("account-form").addEventListener("submit", function (event) {
      event.preventDefault();
      setError("accounts-error", "");
      api("/admin/api/accounts", {
        method: "POST",
        body: {
          email: byId("account-email").value.trim(),
          password: byId("account-password").value,
          proxy: byId("account-proxy").value.trim() || null
        }
      }).then(function () {
        byId("account-form").reset();
        loadAccounts();
      }).catch(function (error) { setError("accounts-error", error.message); });
    });

    byId("user-form").addEventListener("submit", function (event) {
      event.preventDefault();
      setError("users-error", "");
      api("/admin/api/users", {
        method: "POST",
        body: {
          label: byId("user-label").value.trim(),
          role: byId("user-role").value,
          rpm: Number(byId("user-rpm").value || 0),
          concurrency: Number(byId("user-concurrency").value || 0)
        }
      }).then(function (data) {
        byId("user-form").reset();
        showKey(data.user.label, data.api_key);
        loadUsers();
      }).catch(function (error) { setError("users-error", error.message); });
    });

    byId("copy-key").addEventListener("click", function () {
      var text = byId("new-key-value").textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () {});
      }
    });

    byId("settings-form").addEventListener("submit", saveSettings);
    byId("model-mappings-form").addEventListener("submit", saveModelMappings);
    byId("model-mappings-reset").addEventListener("click", resetModelMappings);
    byId("log-level").addEventListener("change", loadLogs);
  }

  function boot() {
    if (location.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].indexOf(location.hostname) === -1) {
      byId("tls-warning").classList.remove("hidden");
    }
    wire();
    api("/admin/api/session").then(function (data) {
      state.csrf = data.csrf;
      state.user = data.user;
      showApp();
    }).catch(function () {
      showLogin();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();`;
