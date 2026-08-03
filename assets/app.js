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

  function render() {
    var route = parseHash();
    var range = currentRange();
    var html;

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
    syncNav(route);
    renderSidebar(route, range);
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
    return route.name === "store" ? "store/" + route.id + "/" + route.tab : route.name;
  }

  /* Sidebar: Dashboard entry plus one item per store that has data in the
     current range (stores with nothing to show stay out, same rule as the
     cards). Rebuilt on every render because the roster is range-dependent. */
  function renderSidebar(route, range) {
    var wrap = document.getElementById("side-stores");
    if (!wrap) return;
    var stores = Core.stores().filter(function (s) {
      try {
        var m = Core.storeMetrics(s.id, range);
        if (m && m.hasData) return true;
        // sales-only stores (no KPI) still have a working activity page
        var cov = Core.coverage(s.id);
        return !!(cov && cov.byKind && cov.byKind.sales && cov.byKind.sales.snapshots);
      } catch (e) { return false; }
    });
    wrap.innerHTML = stores.map(function (s) {
      var on = route.name === "store" && route.id === s.id;
      return '<a href="#/store/' + encodeURIComponent(s.id) + '" class="side-item side-store' +
        (on ? " on" : "") + '"' + (on ? ' aria-current="page"' : "") + ">" +
        '<span class="side-mono" aria-hidden="true">' + esc(Pages.monogramFor ? Pages.monogramFor(s.name) : "") + "</span>" +
        '<span class="side-store-name">' + esc(s.name) + "</span></a>";
    }).join("");

    var dash = document.querySelector('[data-side="overview"]');
    if (dash) {
      dash.classList.toggle("on", route.name !== "store");
      if (route.name !== "store") dash.setAttribute("aria-current", "page");
      else dash.removeAttribute("aria-current");
    }
  }

  /* Topbar breadcrumb. Empty on the overview — the sidebar's active "Dashboard"
     item already says where you are, so a title there was duplication. Inside a
     store it earns its place as the way back: Dashboard / <store>. */
  function syncNav(route) {
    var ol = document.getElementById("topcrumbs");
    if (!ol) return;
    if (route.name === "store" && Core.store(route.id)) {
      var name = Core.store(route.id).name;
      ol.innerHTML = '<li><a href="#/overview">Dashboard</a></li>' +
        '<li><span aria-current="page">' + esc(name) + "</span></li>";
    } else {
      ol.innerHTML = "";
    }
  }

  /* -------------------------------------------------------------- timeframe */

  function syncTimeframeReadout(range) {
    if (!tfResolved) return;
    if (!range) { tfResolved.textContent = ""; return; }
    // the <select> already shows the preset name — spell out the actual dates here
    tfResolved.textContent = range.dateLabel || range.label || "";
    var tip = [];
    if (range.compareDateLabel || range.compareLabel) {
      tip.push("Compared against " + (range.compareDateLabel || range.compareLabel));
    }
    if (range.anchorMode === "data" && range.anchor) {
      tip.push("Presets are anchored to the newest snapshot in the data (" + range.anchor + "), not today's clock.");
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
    tfCustom.hidden = saved.id !== "custom";

    tfSelect.addEventListener("change", function () {
      var id = tfSelect.value;
      tfCustom.hidden = id !== "custom";
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
      if (tfSelect.value !== "custom") return;
      if (!tfStart.value || !tfEnd.value) return;
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
        // The button lives at the bottom of the sidebar but the panel sits at the
        // top of the main column — without scrolling it into view, opening it
        // from further down the page looks like the button does nothing.
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
    tfCustom.hidden = tf.id !== "custom";
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
      html += '<label class="goal-row"><span>' + esc(stores[i].name) + "</span>" +
        '<input type="number" min="0" step="1" class="goal-input" data-store="' + esc(stores[i].id) + '"' +
        ' placeholder="no goal" value="' + (goal === null ? "" : esc(goal)) + '"></label>';
    }
    wrap.innerHTML = html;

    var inputs = wrap.querySelectorAll(".goal-input");
    for (var j = 0; j < inputs.length; j++) {
      inputs[j].addEventListener("change", function (ev) {
        var el = ev.currentTarget;
        Core.setSalesGoal(el.getAttribute("data-store"), el.value === "" ? null : el.value);
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
    if (!global.location.hash) global.location.hash = "#/overview";
    render();
  }

  // pages.js needs to trigger a re-render for the cards/table view toggle
  global.App = { render: function () { render(); } };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

}(typeof window !== "undefined" ? window : this));
