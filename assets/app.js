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
    syncTimeframeReadout(range);

    // Move focus for keyboard/screen-reader users, but preventScroll — a plain
    // focus() scrolls <main> into view, which pushes the header and nav off the
    // top of the window on the taller pages.
    try { view.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
    if (routeKey(route) !== lastRouteKey) {
      lastRouteKey = routeKey(route);
      global.scrollTo(0, 0);
    }
  }

  function routeKey(route) {
    return route.name === "store" ? "store/" + route.id + "/" + route.tab : route.name;
  }

  /* There is no global tab bar any more — Overview is the dashboard and the only
     tabs live inside a store (rendered by pages.js). All this does is light the
     brand link when we are at the top level. */
  function syncNav(route) {
    var brand = document.querySelector(".brand-link");
    if (brand) brand.classList.toggle("on", route.name === "overview");
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
    var warn = document.getElementById("foot-warnings");
    var generatedAt = Core.generatedAt && Core.generatedAt();
    gen.textContent = generatedAt ? "Data generated " + generatedAt : "";
    var list = Core.warnings ? Core.warnings() : [];
    if (list.length) {
      warn.textContent = list.length + " ingest note" + (list.length === 1 ? "" : "s");
      warn.title = list.join("\n");
      warn.className = "foot-warn";
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

    if (!Core.dataAvailable()) {
      view.innerHTML = notFound("No usable snapshots",
        "The data file loaded but contains no store snapshots the dashboard can read.");
      return;
    }

    initTimeframe();
    initSettings();
    footer();

    global.addEventListener("hashchange", render);
    if (!global.location.hash) global.location.hash = "#/overview";
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

}(typeof window !== "undefined" ? window : this));
