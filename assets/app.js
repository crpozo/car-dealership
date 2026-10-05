/* app.js — router, timeframe control and settings wiring.
 *
 * Owns no numbers and no markup beyond the chrome in index.html: every view comes
 * from window.Pages, every figure from window.Core.
 */
(function (global) {
  "use strict";

  var Core = global.Core;
  var Pages = global.Pages;

  var ROUTES = {
    overview: function (range) { return Pages.overview(range); },
    trends: function (range) { return Pages.trends(range); },
    admin: function () {
      var u = global.DASH_USER;
      if (!u || !u.admin) return notFound("Admins only", "User management is available to dashboard admins.");
      return Pages.admin();
    },
    logs: function () {
      var u = global.DASH_USER;
      if (u && !u.admin) return notFound("Admins only", "The intake log is available to dashboard admins.");
      return Pages.logs();
    },
    stores: function (range) { return Pages.stores(range); },
    activity: function (range) { return Pages.activity(range); },
    internet: function (range) { return Pages.internet(range); }
  };

  var view, tfSelect, tfCustom, tfStart, tfEnd, tfResolved;
  var lastRouteKey = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ------------------------------------------------------------------ route */

  function parseHash() {
    var raw = (global.location.hash || "").replace(/^#\/?/, "");
    var parts = raw.split("/").filter(Boolean);
    if (!parts.length) return { name: "overview" };
    if (parts[0] === "store") {
      return {
        name: "store",
        id: decodeURIComponent(parts[1] || ""),
        // #/store/<id>, #/store/<id>/activity, #/store/<id>/internet
        tab: parts[2] || "performance"
      };
    }
    if (parts[0] === "group") {
      var gid = decodeURIComponent(parts[1] || "");
      // owner-scoped links: #/group/<id>/store/<store>[/tab], #/group/<id>/trends
      if (parts[2] === "store") {
        return { name: "store", id: decodeURIComponent(parts[3] || ""), tab: parts[4] || "performance", group: gid };
      }
      if (parts[2] === "trends") return { name: "trends", group: gid };
      return { name: "group", id: gid };
    }
    // The stores table now lives on the Overview; keep the old route as an alias
    // so existing links and bookmarks still land somewhere sensible.
    if (parts[0] === "stores") return { name: "overview" };
    if (ROUTES[parts[0]]) return { name: parts[0] };
    return { name: "unknown", raw: raw };
  }

  function currentRange() {
    var tf = (Core.settings && Core.settings.timeframe) || { id: "month" };
    return Core.resolveRange(tf.id, tf.start, tf.end);
  }

  function notFound(message, detail) {
    return '<section class="page">' +
      '<div class="page-head"><h1>' + esc(message) + "</h1>" +
      (detail ? '<p class="page-sub">' + esc(detail) + "</p>" : "") +
      "</div>" +
      '<p><a class="backlink" href="#/overview">&larr; Back to overview</a></p>' +
      "</section>";
  }

  /* The dealer group a route is scoped to, if any (see Pages.setScope). */
  function scopeOf(route) {
    var gid = route.group || (route.name === "group" ? route.id : null);
    return gid && Core.groupById(gid) ? gid : null;
  }

  function render() {
    var route = parseHash();
    var range = currentRange();
    var html;
    var scope = scopeOf(route);
    if (Pages.setScope) Pages.setScope(scope);

    try {
      if (route.name === "store") {
        if (!Core.store(route.id)) {
          html = notFound("Unknown store", 'No store with id "' + route.id + '" is loaded.');
        } else if (route.tab === "activity") {
          html = Pages.storeActivity(route.id, range);
        } else if (route.tab === "internet") {
          html = Pages.storeInternet(route.id, range);
        } else {
          html = Pages.storeDetail(route.id, range);
        }
      } else if (route.name === "group") {
        html = Core.groupById(route.id)
          ? Pages.group(route.id, range)
          : notFound("Unknown group", 'No dealer group "' + route.id + '" is loaded.');
      } else if (ROUTES[route.name]) {
        html = ROUTES[route.name](range);
      } else {
        html = notFound("Page not found", 'There is no route "#/' + (route.raw || "") + '".');
      }
    } catch (err) {
      html = notFound("Something went wrong rendering this page", (err && err.message) || String(err));
      if (global.console) global.console.error(err);
    }

    view.innerHTML = html;
    syncNav(route, scope);
    renderSidebar(route, range, scope);
    syncTimeframeReadout(range);

    // Move focus for keyboard/screen-reader users, but preventScroll — a plain
    // focus() scrolls <main> into view, which pushes the header and nav off the
    // top of the window on the taller pages.
    try { view.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
    if (routeKey(route) !== lastRouteKey) {
      lastRouteKey = routeKey(route);
      global.scrollTo(0, 0);
      // Navigating away closes the settings panel — it is static chrome above the
      // view, so without this it stayed open on top of whatever page came next.
      // Only on route CHANGE: editing a goal re-renders too, and closing the
      // panel mid-edit would slam it shut under the user's cursor.
      closeSettings();
    }
  }

  function closeSettings() {
    var panel = document.getElementById("settings-panel");
    var toggle = document.getElementById("settings-toggle");
    if (panel && !panel.hidden) {
      panel.hidden = true;
      if (toggle) {
        toggle.setAttribute("aria-expanded", "false");
        toggle.classList.remove("on");
      }
    }
  }

  function routeKey(route) {
    var pre = route.group ? "group/" + route.group + "/" : "";
    if (route.name === "store") return pre + "store/" + route.id + "/" + route.tab;
    if (route.name === "group") return "group/" + route.id;
    return pre + route.name;
  }

  /* Sidebar: Dashboard entry plus one item per store that has data in the
     current range (stores with nothing to show stay out, same rule as the
     cards). Rebuilt on every render because the roster is range-dependent. */
  function renderSidebar(route, range, scope) {
    var wrap = document.getElementById("side-stores");
    if (!wrap) return;
    var group = scope ? Core.groupById(scope) : null;
    var storeBase = group ? "#/group/" + encodeURIComponent(scope) + "/store/" : "#/store/";
    // Only stores with KPI data in the selected range are listed — a store whose
    // only export is a salesperson report has nothing to show on its landing tab.
    // Inside an owner scope, only that group's rooftops are listed at all.
    var stores = Core.stores().filter(function (s) {
      if (group && group.storeIds.indexOf(s.id) < 0) return false;
      try {
        var m = Core.storeMetrics(s.id, range);
        return !!(m && m.hasData);
      } catch (e) { return false; }
    });
    var visible = {};
    stores.forEach(function (s) { visible[s.id] = 1; });
    wrap.innerHTML = stores.map(function (s) {
      var on = route.name === "store" && route.id === s.id;
      return '<a href="' + storeBase + encodeURIComponent(s.id) + '" class="side-item side-store' +
        (on ? " on" : "") + '"' + (on ? ' aria-current="page"' : "") + ">" +
        '<span class="side-mono" aria-hidden="true">' + esc(Pages.monogramFor ? Pages.monogramFor(s.name) : "") + "</span>" +
        '<span class="side-store-name">' + esc(s.name) + "</span>" +
        (function () { var b = Pages.storeStatusFor ? Pages.storeStatusFor(s.id, range).band : "none"; return b && b !== "none" ? '<span class="side-dot ' + b + '" title="' + (b === "bad" ? "Needs attention" : b === "warn" ? "Watch" : "On track") + '"></span>' : ""; }()) +
        "</a>";
    }).join("");

    var gwrap = document.getElementById("side-groups");
    if (gwrap && group) {
      gwrap.innerHTML = "";   // an owner sees only their own group — no cross-links
    } else if (gwrap) {
      // a group is only worth a link when at least two of its stores have data
      var gs = (Core.groups ? Core.groups() : []).map(function (g) {
        var n = g.storeIds.filter(function (id) { return visible[id]; }).length;
        return { g: g, n: n };
      }).filter(function (e) { return e.n >= 2; });
      gwrap.innerHTML = !gs.length ? "" :
        '<p class="side-label">Groups</p>' + gs.map(function (e) {
          var g = e.g;
          var gon = route.name === "group" && route.id === g.id;
          return '<a href="#/group/' + encodeURIComponent(g.id) + '" class="side-item' +
            (gon ? " on" : "") + '"' + (gon ? ' aria-current="page"' : "") + ">" +
            '<span class="side-mono" aria-hidden="true">' + esc(Pages.monogramFor ? Pages.monogramFor(g.name) : "") + "</span>" +
            '<span class="side-store-name">' + esc(g.name) + '</span><span class="side-count">' + e.n + "</span></a>";
        }).join("");
    }

    var groupHome = group ? "#/group/" + encodeURIComponent(scope) : "#/overview";
    var brand = document.querySelector(".brand-link");
    if (brand) brand.setAttribute("href", groupHome);
    var dash = document.querySelector('[data-side="overview"]');
    if (dash) {
      dash.setAttribute("href", groupHome);
      var onDash = group ? route.name === "group"
        : (route.name !== "store" && route.name !== "group" &&
           route.name !== "trends" && route.name !== "logs" && route.name !== "admin");
      dash.classList.toggle("on", onDash);
      if (onDash) dash.setAttribute("aria-current", "page");
      else dash.removeAttribute("aria-current");
    }
    var lg = document.querySelector('[data-side="logs"]');
    if (lg) {
      lg.classList.toggle("on", route.name === "logs");
      if (route.name === "logs") lg.setAttribute("aria-current", "page");
      else lg.removeAttribute("aria-current");
    }
    var ad = document.querySelector('[data-side="admin"]');
    if (ad) {
      ad.classList.toggle("on", route.name === "admin");
      if (route.name === "admin") ad.setAttribute("aria-current", "page");
      else ad.removeAttribute("aria-current");
    }
    var tr = document.querySelector('[data-side="trends"]');
    if (tr) {
      tr.setAttribute("href", group ? groupHome + "/trends" : "#/trends");
      tr.classList.toggle("on", route.name === "trends");
      if (route.name === "trends") tr.setAttribute("aria-current", "page");
      else tr.removeAttribute("aria-current");
    }
  }

  /* Topbar breadcrumb. Empty on the overview — the sidebar's active "Dashboard"
     item already says where you are, so a title there was duplication. Inside a
     store it earns its place as the way back: Dashboard / <store>. */
  function syncNav(route, scope) {
    var ol = document.getElementById("topcrumbs");
    if (!ol) return;
    // Inside a group the sidebar's "Dashboard" is the group itself, so the
    // crumbs are the only way back up to every store.
    var group = scope ? Core.groupById(scope) : null;
    var groupHome = scope ? "#/group/" + encodeURIComponent(scope) : null;
    if (route.name === "store" && Core.store(route.id)) {
      ol.innerHTML = (group
          ? '<li><a href="#/overview">All stores</a></li>' +
            '<li><a href="' + groupHome + '">' + esc(group.name) + "</a></li>"
          : '<li><a href="#/overview">Dashboard</a></li>') +
        '<li><span aria-current="page">' + esc(Core.store(route.id).name) + "</span></li>";
    } else if (route.name === "group" && Core.groupById(route.id)) {
      ol.innerHTML = '<li><a href="#/overview">All stores</a></li>' +
        '<li><span aria-current="page">' + esc(Core.groupById(route.id).name) + "</span></li>";
    } else {
      ol.innerHTML = "";
    }
  }

  /* -------------------------------------------------------------- timeframe */

  function syncTimeframeReadout(range) {
    if (!tfResolved) return;
    if (!range) { tfResolved.textContent = ""; return; }
    // The date inputs always show the range on screen — for a preset they are
    // filled in here, so what is being looked at is never a guess. Editing
    // either one turns the preset into a custom range (see initTimeframe).
    if (tfSelect.value !== "custom") {
      if (range.start) tfStart.value = range.start;
      if (range.end) tfEnd.value = range.end;
    }
    var cmp = range.compareDateLabel || range.compareLabel;
    tfResolved.textContent = cmp ? "vs " + cmp : "";
    var tip = [];
    if (cmp) tip.push("Every comparison on the page is against " + cmp + ".");
    if (range.anchorMode === "data" && range.anchor) {
      tip.push("Presets are anchored to the newest report in the data (" + range.anchor + "), not today's clock.");
    }
    if (tip.length) tfResolved.title = tip.join("\n");
    else tfResolved.removeAttribute("title");
  }

  function initTimeframe() {
    var tfs = Core.timeframes();
    var saved = (Core.settings && Core.settings.timeframe) || { id: "month" };
    var html = "";
    for (var i = 0; i < tfs.length; i++) {
      html += '<option value="' + esc(tfs[i].id) + '"' +
        (tfs[i].id === saved.id ? " selected" : "") + ">" + esc(tfs[i].label) + "</option>";
    }
    tfSelect.innerHTML = html;

    if (saved.start) tfStart.value = saved.start;
    if (saved.end) tfEnd.value = saved.end;

    tfSelect.addEventListener("change", function () {
      var id = tfSelect.value;
      if (id === "custom" && (!tfStart.value || !tfEnd.value)) {
        // seed the custom inputs from whatever range is on screen so the first
        // switch to "custom" is not an empty, dataless view
        var r = currentRange();
        if (r && r.start && !tfStart.value) tfStart.value = r.start;
        if (r && r.end && !tfEnd.value) tfEnd.value = r.end;
      }
      Core.setTimeframe(id, tfStart.value || null, tfEnd.value || null);
      render();
    });

    function onCustom() {
      if (!tfStart.value || !tfEnd.value) return;
      // touching a date while a preset is selected means "I want these dates"
      tfSelect.value = "custom";
      if (tfStart.value > tfEnd.value) {
        var swap = tfStart.value; tfStart.value = tfEnd.value; tfEnd.value = swap;
      }
      Core.setTimeframe("custom", tfStart.value, tfEnd.value);
      render();
    }
    tfStart.addEventListener("change", onCustom);
    tfEnd.addEventListener("change", onCustom);
  }

  /* --------------------------------------------------------------- settings */

  /* Empty field = no goal (null) — the metric simply stays uncolored. */
  function pctInputNullable(el, key) {
    if (!el) return;
    var v = Core.settings[key];
    el.value = (typeof v === "number" && v > 0) ? Math.round((v > 1 ? v : v * 100)) : "";
    el.addEventListener("change", function () {
      if (el.value === "") { Core.setSetting(key, null); render(); return; }
      var n = parseFloat(el.value);
      if (isNaN(n) || n <= 0) { el.value = ""; Core.setSetting(key, null); render(); return; }
      if (n > 100) n = 100;
      el.value = Math.round(n);
      Core.setSetting(key, n / 100);
      render();
    });
  }

  function numInputNullable(el, key) {
    if (!el) return;
    var v = Core.settings[key];
    el.value = (typeof v === "number" && v > 0) ? Math.round(v) : "";
    el.addEventListener("change", function () {
      if (el.value === "") { Core.setSetting(key, null); render(); return; }
      var n = parseFloat(el.value);
      if (isNaN(n) || n <= 0) { el.value = ""; Core.setSetting(key, null); render(); return; }
      el.value = Math.round(n);
      Core.setSetting(key, Math.round(n));
      render();
    });
  }

  /* Goal editing is gated behind a manager PIN. This is a per-browser
     convenience lock, NOT security — the site is static and has no accounts. */
  function managerUnlocked() {
    try { return global.localStorage.getItem("icdash.managerMode") === "1"; } catch (e) { return false; }
  }

  function applyManagerLock() {
    // Oct 2026: goals are open to everyone who can reach the page (the client
    // asked for Scott and store managers to edit freely); the PIN is retired.
    var locked = false;
    var panel = document.getElementById("settings-panel");
    if (!panel) return;
    var fields = panel.querySelectorAll("input[type=number], .goal-input");
    for (var i = 0; i < fields.length; i++) fields[i].disabled = locked;
    var btn = document.getElementById("manager-toggle");
    if (btn) btn.textContent = locked ? "Unlock manager mode" : "Lock manager mode";
    var note = document.getElementById("manager-state");
    if (note) note.textContent = "Goals and targets are saved in this browser. Set them once on the device the team uses.";
  }

  function initManagerMode() {
    var btn = document.getElementById("manager-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (managerUnlocked()) {
        try { global.localStorage.setItem("icdash.managerMode", "0"); } catch (e) { /* private */ }
        applyManagerLock();
        return;
      }
      var pin = Core.settings.managerPin;
      if (!pin) {
        var a = global.prompt("Create a manager PIN (4+ digits). It is stored in this browser only \u2014 this is a lock, not real security.");
        if (!a || a.length < 4) return;
        var b = global.prompt("Repeat the PIN to confirm.");
        if (a !== b) { global.alert("PINs did not match."); return; }
        Core.setSetting("managerPin", a);
        try { global.localStorage.setItem("icdash.managerMode", "1"); } catch (e) { /* private */ }
      } else {
        var typed = global.prompt("Manager PIN:");
        if (typed !== pin) { if (typed !== null) global.alert("Wrong PIN."); return; }
        try { global.localStorage.setItem("icdash.managerMode", "1"); } catch (e) { /* private */ }
      }
      applyManagerLock();
    });
    applyManagerLock();
  }

  function pctInput(el, key) {
    el.value = Math.round((Core.settings[key] || 0) * 100);
    el.addEventListener("change", function () {
      var v = parseFloat(el.value);
      if (isNaN(v) || v < 0) v = 0;
      if (v > 100) v = 100;
      el.value = Math.round(v);
      Core.setSetting(key, v / 100);
      render();
    });
  }

  function initSettings() {
    var panel = document.getElementById("settings-panel");
    var toggle = document.getElementById("settings-toggle");

    toggle.addEventListener("click", function () {
      var open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.classList.toggle("on", open);
      if (open) {
        // The panel sits at the top of the main column — without scrolling it
        // into view, opening it from further down the page looks like the
        // button does nothing.
        // Explicit scrollTo, not scrollIntoView: with the sticky sidebar layout
        // Chrome resolves scrollIntoView against the wrong ancestor and can leave
        // the page stranded past the panel. 64px clears the sticky topbar.
        global.scrollTo(0, Math.max(0, panel.offsetTop - 64));
        var first = panel.querySelector("input");
        if (first) { try { first.focus({ preventScroll: true }); } catch (e2) { /* older browsers */ } }
      }
    });

    pctInput(document.getElementById("set-engagement"), "engagementTarget");
    pctInput(document.getElementById("set-appt"), "apptTarget");
    pctInputNullable(document.getElementById("set-closing"), "closingTarget");
    pctInputNullable(document.getElementById("set-shown"), "shownTarget");
    pctInput(document.getElementById("set-warn"), "warnRatio");
    numInputNullable(document.getElementById("set-calls"), "callsPerDayGoal");
    numInputNullable(document.getElementById("set-msgs"), "msgsPerDayGoal");
    numInputNullable(document.getElementById("set-repgoal"), "repSalesGoalDefault");
    initManagerMode();

    var sat = document.getElementById("set-saturday");
    sat.checked = !!Core.settings.includeSaturday;
    sat.addEventListener("change", function () {
      Core.setSetting("includeSaturday", sat.checked);
      render();
    });

    renderGoals();

    document.getElementById("settings-reset").addEventListener("click", function () {
      Core.resetSettings();
      initTimeframeValues();
      document.getElementById("set-engagement").value = Math.round(Core.settings.engagementTarget * 100);
      document.getElementById("set-appt").value = Math.round(Core.settings.apptTarget * 100);
      sat.checked = !!Core.settings.includeSaturday;
      renderGoals();
      render();
    });
  }

  function initTimeframeValues() {
    var tf = Core.settings.timeframe || { id: "month" };
    tfSelect.value = tf.id;
    tfStart.value = tf.start || "";
    tfEnd.value = tf.end || "";
  }

  function renderGoals() {
    var wrap = document.getElementById("goal-list");
    var stores = Core.stores();
    if (!stores.length) {
      wrap.innerHTML = '<p class="settings-note">No stores loaded.</p>';
      return;
    }
    var html = "";
    for (var i = 0; i < stores.length; i++) {
      var goal = Core.getSalesGoal(stores[i].id);
      var rg = (Core.settings.repSalesGoals || {})[stores[i].id];
      var dflt = Core.settings.repSalesGoalDefault;
      html += '<div class="goal-row"><span>' + esc(stores[i].name) + "</span>" +
        '<label class="goal-field" title="Store monthly sales goal"><em>store</em>' +
        '<input type="number" min="0" step="1" class="goal-input" data-store="' + esc(stores[i].id) + '"' +
        ' placeholder="no goal" value="' + (goal === null ? "" : esc(goal)) + '"></label>' +
        '<label class="goal-field" title="Monthly sales goal per salesperson at this store (empty = default)"><em>per rep</em>' +
        '<input type="number" min="0" step="1" class="repgoal-input" data-store="' + esc(stores[i].id) + '"' +
        ' placeholder="' + (typeof dflt === "number" ? esc(dflt) : "\u2014") + '" value="' + (typeof rg === "number" ? esc(rg) : "") + '"></label></div>';
    }
    wrap.innerHTML = html;
    applyManagerLock();

    var inputs = wrap.querySelectorAll(".goal-input");
    for (var j = 0; j < inputs.length; j++) {
      inputs[j].addEventListener("change", function (ev) {
        var el = ev.currentTarget;
        Core.setSalesGoal(el.getAttribute("data-store"), el.value === "" ? null : el.value);
        render();
      });
    }
    var rinputs = wrap.querySelectorAll(".repgoal-input");
    for (var k = 0; k < rinputs.length; k++) {
      rinputs[k].addEventListener("change", function (ev) {
        var el = ev.currentTarget;
        Core.setRepSalesGoal(el.getAttribute("data-store"), el.value === "" ? null : el.value);
        render();
      });
    }
  }

  /* ------------------------------------------------------------------ boot */

  function footer() {
    var gen = document.getElementById("foot-generated");
    var generatedAt = Core.generatedAt && Core.generatedAt();
    gen.textContent = generatedAt ? "Data generated " + generatedAt : "";
    // Ingest warnings (duplicate sends and the like) are pipeline diagnostics, not
    // something the reader can act on — they stay in Core.warnings() and in the
    // ingest.py run output rather than on screen.
  }

  /* Who is signed in: email in the sidebar, admin-only nav items, sign out. */
  function applyUser() {
    var u = global.DASH_USER || null;
    var box = document.getElementById("side-user");
    var mail = document.getElementById("side-user-mail");
    if (box) box.hidden = !u;
    if (mail && u) mail.textContent = u.name || u.email || "";
    var av = document.getElementById("top-avatar");
    var menu = document.getElementById("user-menu");
    if (av) {
      av.hidden = !u;
      if (u) {
        var src = (u.name || u.email || "?").trim();
        var parts = src.split(/[\s@._-]+/).filter(Boolean);
        var ini = ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
        av.textContent = ini;
        av.title = "Account";
        var set = function (id, t) { var el = document.getElementById(id); if (el) el.textContent = t; };
        set("um-avatar", ini); set("um-name", u.name || u.email || ""); set("um-mail", u.email || "");
        var role = document.getElementById("um-role");
        var nStores = (u.storeIds || []).length + (u.storeIds && u.storeIds.length === 1 ? " store" : " stores");
        if (role) role.innerHTML = u.admin
          ? '<span class="pill good"><span class="dot"></span>Admin</span><span class="um-role-sub">Sees every store and manages users</span>'
          : (u.staff
            ? '<span class="pill warn"><span class="dot"></span>Staff</span><span class="um-role-sub">' + nStores + " \u00b7 can edit goals</span>"
            : '<span class="pill none">Client</span><span class="um-role-sub">' + nStores + "</span>");
      }
      if (!av.getAttribute("data-wired")) {
        av.setAttribute("data-wired", "1");
        av.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var open = menu && !menu.hidden;
          if (menu) menu.hidden = open;
          av.setAttribute("aria-expanded", open ? "false" : "true");
        });
        document.addEventListener("click", function (ev) {
          if (menu && !menu.hidden && !menu.contains(ev.target)) { menu.hidden = true; av.setAttribute("aria-expanded", "false"); }
        });
        document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && menu && !menu.hidden) { menu.hidden = true; av.setAttribute("aria-expanded", "false"); } });
        var so = document.getElementById("um-signout");
        if (so) so.addEventListener("click", function () { if (global.Auth) global.Auth.signOut(); });
      }
    }
    var pk2 = document.getElementById("um-passkey");
    if (pk2 && u && global.Auth && global.Auth.passkeysSupported && global.Auth.passkeysSupported()) {
      var has2 = false;
      try { has2 = global.localStorage.getItem("icdash.passkey") === "1"; } catch (e) { has2 = false; }
      pk2.hidden = has2;
      if (!pk2.getAttribute("data-wired")) {
        pk2.setAttribute("data-wired", "1");
        pk2.addEventListener("click", function () {
          pk2.disabled = true; pk2.textContent = "Follow the prompt\u2026";
          global.Auth.registerPasskey().then(function () {
            pk2.textContent = "Touch ID enabled"; setTimeout(function () { pk2.hidden = true; }, 1500);
          }).catch(function (err) {
            pk2.disabled = false; pk2.textContent = "Enable Touch ID on this device";
            global.alert(err && err.name === "NotAllowedError" ? "Touch ID setup was cancelled." : (err.message || "Could not enable Touch ID."));
          });
        });
      }
    }
    var adminOnly = document.querySelectorAll("[data-admin-only]");
    for (var i = 0; i < adminOnly.length; i++) adminOnly[i].hidden = !(u && u.admin);
    var staffOnly = document.querySelectorAll("[data-staff-only]");
    for (var i2 = 0; i2 < staffOnly.length; i2++) staffOnly[i2].hidden = !(u && (u.admin || u.staff));
    if (u && !(u.admin || u.staff)) closeSettings();
    var pk = document.getElementById("side-passkey");
    if (pk && u && global.Auth && global.Auth.passkeysSupported && global.Auth.passkeysSupported()) {
      var has = false;
      try { has = global.localStorage.getItem("icdash.passkey") === "1"; } catch (e) { has = false; }
      pk.hidden = has;
      if (!pk.getAttribute("data-wired")) {
        pk.setAttribute("data-wired", "1");
        pk.addEventListener("click", function () {
          pk.disabled = true; pk.textContent = "Follow the prompt\u2026";
          global.Auth.registerPasskey().then(function () {
            pk.textContent = "Touch ID enabled"; setTimeout(function () { pk.hidden = true; }, 1500);
          }).catch(function (err) {
            pk.disabled = false; pk.textContent = "Enable Touch ID";
            global.alert(err && err.name === "NotAllowedError" ? "Touch ID setup was cancelled." : (err.message || "Could not enable Touch ID."));
          });
        });
      }
    }
    var out = document.getElementById("side-signout");
    if (out && !out.getAttribute("data-wired")) {
      out.setAttribute("data-wired", "1");
      out.addEventListener("click", function () { if (global.Auth) global.Auth.signOut(); });
    }
  }

  function boot() {
    view = document.getElementById("view");
    tfSelect = document.getElementById("tf-select");
    tfCustom = document.getElementById("tf-custom");
    tfStart = document.getElementById("tf-start");
    tfEnd = document.getElementById("tf-end");
    tfResolved = document.getElementById("tf-resolved");

    if (!Core || !Pages) {
      view.innerHTML = notFound("Dashboard failed to load",
        "core.js or pages.js did not load. Check the script tags in index.html.");
      return;
    }
    if (!global.DASH_DATA) {
      view.innerHTML = notFound("No data loaded",
        "assets/data.js is missing. Run: python3 pipeline/ingest.py && python3 pipeline/build.py");
      return;
    }

    Core.init(global.DASH_DATA);
    applyUser();

    if (!Core.dataAvailable()) {
      view.innerHTML = notFound("No usable snapshots",
        "The data file loaded but contains no store snapshots the dashboard can read.");
      return;
    }

    initTimeframe();
    initSettings();
    footer();

    // Any sidebar NAVIGATION closes the settings panel. The route-change close in
    // render() misses one case: clicking "Dashboard" while already on the
    // overview — the hash does not change, so no event fires at all. Delegated
    // here because the store links are rebuilt on every render.
    var sidebar = document.querySelector(".sidebar");
    if (sidebar) {
      sidebar.addEventListener("click", function (ev) {
        var link = ev.target.closest ? ev.target.closest("a.side-item, a.brand-link") : null;
        if (link) closeSettings();
      });
    }

    global.addEventListener("hashchange", render);
    // ⌘F / Ctrl+F jumps to the store search when it is on screen
    global.addEventListener("keydown", function (ev) {
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === "f" || ev.key === "F")) {
        var box = document.getElementById("store-search");
        if (box) { ev.preventDefault(); box.focus(); box.select(); }
      }
    });
    if (!global.location.hash) global.location.hash = "#/overview";
    render();
  }

  // pages.js needs to trigger a re-render for the cards/table view toggle;
  // auth.js calls boot() once the signed-in user's data is in DASH_DATA
  var booted = false;
  function bootOnce() {
    if (booted) { Core.init(global.DASH_DATA); applyUser(); render(); return; }
    booted = true;
    boot();
  }
  global.App = { render: function () { render(); }, boot: bootOnce };

  // Without auth.js (local file:// dev with a data.js) boot straight away.
  if (!global.Auth && !document.querySelector('script[src*="auth.js"]')) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

}(typeof window !== "undefined" ? window : this));
