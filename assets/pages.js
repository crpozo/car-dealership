/* assets/pages.js — The Internet Coaches Dashboard
 *
 * RENDERING ONLY. Every number on screen comes from window.Core (or is a raw
 * count Core handed back). This file never averages, sums, divides or clamps a
 * metric on its own — where a number is not available it renders "—" with a
 * title explaining why.
 *
 * Exposes: window.Pages = { overview, stores, storeDetail, activity, internet, sources }
 * Each function returns an HTML string to be dropped into #view.
 */
(function (global) {
  "use strict";

  /* ---------------------------------------------------------------- utils */

  function C() {
    var c = global.Core;
    if (!c) throw new Error("Core is not loaded — assets/core.js must run before pages.js");
    return c;
  }
  function DATA() { return global.DASH_DATA || {}; }
  function STORES() { return DATA().stores || []; }
  function storeById(id) {
    var list = STORES();
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }

  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var DASH = "—";

  /* "—" plus the reason it is not a number. */
  function na(reason) {
    return '<span class="na" title="' + esc(reason || "No data available") + '">' + DASH + "</span>";
  }

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  /* Counts can be fractional (split deals: 7.5 units). Show at most 1 decimal. */
  function fmtN(v) {
    if (!isNum(v)) return null;
    var rounded = Math.round(v * 10) / 10;
    var opts = (rounded % 1 === 0)
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    try { return rounded.toLocaleString(undefined, opts); } catch (e) { return String(rounded); }
  }

  /* Percentages arrive from Core as fractions (0.79 → 79%). Never clamped:
     Appts set of contacted legitimately exceeds 100%. */
  function fmtPct(v, digits) {
    if (!isNum(v)) return null;
    var d = (digits === undefined) ? 1 : digits;
    return (v * 100).toFixed(d) + "%";
  }

  function num(v, reason) { var s = fmtN(v); return s === null ? na(reason) : esc(s); }
  function pct(v, reason) { var s = fmtPct(v); return s === null ? na(reason) : esc(s); }

  /* Numeric <td>. cls is the conditional colour class from Core.colorFor(). */
  function td(html, cls, title) {
    return '<td class="num' + (cls ? " " + esc(cls) : "") + '"' +
      (title ? ' title="' + esc(title) + '"' : "") + ">" + html + "</td>";
  }

  /* ---------------------------------------------- targets & colour classes */

  /* Core.settings owns the targets. Accept either fraction (0.8) or percent
     (80) form so a settings mismatch can't flip every cell to red. */
  function targetOf(key, fallback) {
    var s = (global.Core && C().settings) || {};
    var v = s[key];
    if (!isNum(v)) v = fallback;
    return v > 1 ? v / 100 : v;
  }
  function engagementTarget() { return targetOf("engagementTarget", 0.8); }
  function apptTarget() { return targetOf("apptTarget", 0.4); }

  /* Delegates to Core.colorFor — the banding lives there, not here. */
  function colorFor(actual, target) {
    if (!isNum(actual) || !isNum(target) || target === 0) return "none";
    var c = C();
    if (typeof c.colorFor !== "function") return "none";
    return c.colorFor(actual, target) || "none";
  }

  /* --------------------------------------------------------- range helpers */

  function rangeLabel(range) {
    return (range && (range.label || (range.start && range.end && range.start + " → " + range.end))) || "selected range";
  }

  function compareRange(range) {
    if (!range || !range.compareStart || !range.compareEnd) return null;
    return {
      start: range.compareStart,
      end: range.compareEnd,
      label: range.compareLabel || "prior period"
    };
  }

  function storeMetrics(storeId, range) {
    try { return C().storeMetrics(storeId, range) || null; } catch (e) { return null; }
  }

  function hasData(sm) {
    if (!sm || !sm.total) return false;
    var cov = sm.coverage;
    if (cov) {
      if (cov.hasData === false) return false;
      if (Array.isArray(cov.runDates) && cov.runDates.length === 0) return false;
      if (Array.isArray(cov.snapshots) && cov.snapshots.length === 0) return false;
      if (isNum(cov.count) && cov.count === 0) return false;
    }
    return true;
  }

  function noCoverageReason(range) {
    return "No report snapshot covers " + rangeLabel(range) + " for this store.";
  }

  function coverageAsOf(sm) {
    var cov = sm && sm.coverage;
    if (!cov) return "";
    var last = cov.lastRun || (Array.isArray(cov.runDates) && cov.runDates.length ? cov.runDates[cov.runDates.length - 1] : null);
    return last ? "as of " + last : "";
  }

  /* ------------------------------------------------------------ lead types */

  /* Internet / Phone / Walk-in are the only lead types shown as rows.
     Referral & PreviousCustomer stay inside the TOTAL row (footnoted). */
  var DISPLAY_LEAD_TYPES = ["Internet", "Phone", "Walk-in"];

  function ltKey(s) { return String(s || "").toLowerCase().replace(/[^a-z]/g, ""); }

  function findLeadType(list, name) {
    var want = ltKey(name);
    var arr = list || [];
    for (var i = 0; i < arr.length; i++) {
      if (ltKey(arr[i].leadType) === want) return arr[i];
    }
    return null;
  }

  function metricsOf(entry) { return entry ? (entry.metrics || entry) : null; }

  /* ------------------------------------------------------------------ pace */

  /* Calendar bounds for the month the range ends in. This is date arithmetic,
     not metric arithmetic — Core.pace does the NETWORKDAYS work. */
  function monthBounds(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ""));
    if (!m) return null;
    var lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return {
      start: m[1] + "-" + m[2] + "-01",
      end: m[1] + "-" + m[2] + "-" + (lastDay < 10 ? "0" + lastDay : String(lastDay))
    };
  }

  function goalFor(storeId) {
    var s = (C().settings) || {};
    var goals = s.salesGoals || {};
    var g = goals[storeId];
    if (g === null || g === undefined || g === "" || !isFinite(Number(g))) return null;
    return Number(g);
  }

  function paceFor(storeId, range) {
    var goal = goalFor(storeId);
    if (goal === null) return { goal: null, pace: null, reason: "No sales goal set for this store — goals are not in the reports." };
    var c = C();
    // Prefer Core.storePace: it pro-rates the MONTHLY goal down to the workdays that
    // actually fall inside the selected range. Judging a single day against a whole
    // month's target would paint every store red.
    if (typeof c.storePace === "function") {
      try {
        var sp = c.storePace(storeId, range, null, goal);
        if (sp) return { goal: goal, pace: sp, reason: "" };
      } catch (e) { /* fall through to the month-scoped calculation */ }
    }
    var b = monthBounds(range && range.end);
    if (!b) return { goal: goal, pace: null, reason: "Pace needs a month end date; the selected range has none." };
    var settings = c.settings || {};
    try {
      var p = c.pace({
        goal: goal,
        asOf: range.end,
        monthStart: b.start,
        monthEnd: b.end,
        includeSaturday: settings.includeSaturday !== false
      });
      return { goal: goal, pace: p || null, reason: p ? "" : "Pace could not be computed for this range." };
    } catch (e) {
      return { goal: goal, pace: null, reason: "Pace could not be computed for this range." };
    }
  }

  function goalInput(storeId, storeName, goal) {
    return '<input class="goal-input" type="number" min="0" step="1" inputmode="numeric"' +
      ' data-goal-store="' + esc(storeId) + '"' +
      ' value="' + (goal === null ? "" : esc(String(goal))) + '"' +
      ' placeholder="' + DASH + '"' +
      ' aria-label="Monthly sales goal for ' + esc(storeName) + '">';
  }

  /* Column 8 of the stores table: the editable goal plus the pace read-out. */
  function paceCell(store, range, actualSold) {
    var pf = paceFor(store.id, range);
    var input = goalInput(store.id, store.name, pf.goal);
    if (pf.goal === null) {
      return '<td class="goal none">' + input +
        '<span class="pace none" title="' + esc(pf.reason) + '">no goal</span></td>';
    }
    if (!pf.pace) {
      return '<td class="goal none">' + input + na(pf.reason) + "</td>";
    }
    var p = pf.pace;
    var cls = colorFor(actualSold, p.expected);
    var expected = fmtN(p.expected);
    var bits = [];
    if (expected !== null) bits.push("expected " + expected);
    if (isNum(p.elapsed) && isNum(p.total)) bits.push(p.elapsed + " of " + p.total + " workdays");
    if (isNum(p.remaining)) bits.push(p.remaining + " left");
    var title = "Goal " + pf.goal + " units. " + bits.join(" · ") +
      ". Workdays counted Mon–" + ((C().settings || {}).includeSaturday !== false ? "Sat" : "Fri") +
      "; no holiday calendar.";
    return '<td class="goal ' + esc(cls) + '" title="' + esc(title) + '">' + input +
      '<span class="pace ' + esc(cls) + '">' +
      (expected === null ? na("Expected pace unavailable") : "vs " + esc(expected)) +
      "</span>" +
      '<span class="pace-sub">' + esc(bits.slice(1).join(" · ")) + "</span></td>";
  }

  function paceFootnote() {
    var sat = (C().settings || {}).includeSaturday !== false;
    return "Pace uses Excel NETWORKDAYS semantics over Mon–" + (sat ? "Sat (dealerships work Saturdays)" : "Fri") +
      ". There is no holiday calendar, so holidays count as working days.";
  }

  /* ---------------------------------------------------- rep-level activity */

  /* The rep-level (Summary Level 1 = User) report has no lead-type split, so
     "internet leads" / "internet sold" per rep only exist if Core supplies them. */
  function repInternet(rep, key) {
    if (!rep) return null;
    var v = rep[key];
    return isNum(v) ? v : null;
  }

  /* Team totals, if Core exposes them. Never summed here. */
  function repTotalsFor(storeId, range, reps) {
    var c = C();
    if (typeof c.repTotals === "function") {
      // repTotals always returns a filled bag (zeros for missing counts), so an
      // explicit hasData:false must fall through to "—" rather than print 0s.
      try {
        var t = c.repTotals(storeId, range);
        if (t && t.hasData !== false) return t;
      } catch (e) { /* fall through */ }
    }
    if (reps && reps.totals) return reps.totals;
    var arr = reps || [];
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i].name || "").trim().toUpperCase() === "TOTAL") return arr[i];
    }
    return null;
  }

  function isTotalRow(rep) { return String(rep && rep.name || "").trim().toUpperCase() === "TOTAL"; }

  /* Benchmark for the calls/emails/texts colouring: the store's own per-rep
     average, derived from Core's team totals via Core.rate(). If Core exposes
     no totals we colour nothing rather than invent a target. */
  function activityBenchmarks(storeId, range, reps, people) {
    var c = C();
    if (typeof c.activityBenchmark === "function") {
      try { var b = c.activityBenchmark(storeId, range); if (b) return b; } catch (e) { /* fall through */ }
    }
    var totals = repTotalsFor(storeId, range, reps);
    if (!totals || !people.length) return null;
    var out = {};
    ["calls", "emails", "texts"].forEach(function (k) {
      out[k] = isNum(totals[k]) ? c.rate(totals[k], people.length) : null;
    });
    return out;
  }

  var NO_BENCHMARK = "No outbound-activity target is available — Core exposes no team totals for this range, so this cell is uncoloured.";

  function activityCell(value, bench, key) {
    var b = bench ? bench[key] : null;
    var cls = isNum(b) ? colorFor(value, b) : "none";
    var title = isNum(b)
      ? "Team average for this range: " + fmtN(b) + " per rep"
      : NO_BENCHMARK;
    return td(num(value, "Not reported"), cls, title);
  }

  /* ------------------------------------------------------------ fragments */

  function pageHead(title, sub, suffix) {
    return '<header class="page-head">' +
      "<h1>" + esc(title) + (suffix ? ' <span class="ttl-suffix">' + esc(suffix) + "</span>" : "") + "</h1>" +
      (sub ? '<p class="page-sub">' + esc(sub) + "</p>" : "") +
      "</header>";
  }

  function emptyState(title, msg) {
    return '<div class="empty"><strong>' + esc(title) + "</strong>" +
      (msg ? "<p>" + esc(msg) + "</p>" : "") + "</div>";
  }

  /* A range can be wider than the reports that cover it — "Last month" resolves to
   * Jun 1–30 while the exports stop at Jun 22. Presenting a partial period under a
   * full-period heading understates every count, so say it out loud rather than
   * leaving the reader to assume the month is complete. */
  function coverageBanner(range, storeIds) {
    var c = C();
    var ids = storeIds && storeIds.length
      ? storeIds
      : (c.stores() || []).map(function (s) { return s.id; });
    var seen = {}, lines = [];
    for (var i = 0; i < ids.length; i++) {
      var sm;
      try { sm = c.storeMetrics(ids[i], range); } catch (e) { continue; }
      var cov = sm && sm.coverage;
      if (!cov || !cov.hasData || !cov.partial) continue;
      var name = (sm.storeName || ids[i]);
      var note = null;
      for (var m = 0; m < (cov.months || []).length; m++) {
        if (cov.months[m].partial && cov.months[m].note) { note = cov.months[m].note; break; }
      }
      if (!note) note = "Reports do not cover the whole of " + rangeLabel(range) + ".";
      var line = name + " — " + note;
      if (!seen[line]) { seen[line] = 1; lines.push(line); }
    }
    if (!lines.length) return "";
    return '<div class="banner warn-banner" role="status">' +
      "<strong>Partial coverage for " + esc(rangeLabel(range)) + "</strong>" +
      "<ul>" + lines.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul>" +
      "<p>Totals below cover only the days that were actually reported, so they understate the full period.</p>" +
      "</div>";
  }

  function footnotes(list) {
    if (!list || !list.length) return "";
    return '<div class="footnotes">' + list.map(function (n) { return "<p>" + esc(n) + "</p>"; }).join("") + "</div>";
  }

  function tableWrap(inner, cls) {
    return '<div class="tblwrap"><table' + (cls ? ' class="' + esc(cls) + '"' : "") + ">" + inner + "</table></div>";
  }

  function errorPanel(e) {
    return '<section class="page"><div class="empty"><strong>This page could not be rendered.</strong><p>' +
      esc(e && e.message ? e.message : String(e)) + "</p></div></section>";
  }

  function guard(fn) {
    try { return fn(); } catch (e) { return errorPanel(e); }
  }

  /* ---------------------------------------------------- headline five tiles */

  /* The five headline metrics, in the order the client asked for:
     Good internet leads · Engagement % · Appts set of contacted % ·
     Solds · Internet closing rate. */
  /* cmp compares the all-lead-type TOTAL; netCmp compares the Internet slice.
   * They must not be interchanged — a tile's delta has to be drawn from the same
   * population as the number printed above it. */
  function headlineTiles(m, range, cmp, netCmp) {
    var c = C();
    // Core always hands back a filled metrics bag (counts coerced to 0), so the
    // container's hasData is the only honest "is there anything here" signal.
    var has = !!(m && m.hasData);
    var total = (has && m.total) || null;
    var net = (has && m.internet) || null;
    var noNet = "No internet lead rows in the reports for " + rangeLabel(range) + ".";
    var noTotal = "No store total row in the reports for " + rangeLabel(range) + ".";

    var engagement = net ? net.contactPct : null;
    var apptSet = net ? net.apptSetOfContactedPct : null;
    var closing = net ? c.rate(net.sold, net.goodLeads) : null;

    var tiles = [
      {
        label: "Good internet leads",
        html: net ? num(net.goodLeads, noNet) : na(noNet),
        cls: "none",
        sub: "Lead Type = Internet",
        delta: netCmp ? deltaChip(netCmp, "goodLeads") : ""
      },
      {
        label: "Engagement %",
        html: net ? pct(engagement, "Internet Actual Contact % not reported for " + rangeLabel(range)) : na(noNet),
        cls: colorFor(engagement, engagementTarget()),
        sub: "target " + fmtPct(engagementTarget(), 0)
      },
      {
        label: "Appts set of contacted %",
        html: net ? pct(apptSet, "Appts Set of Contacted % not reported for " + rangeLabel(range)) : na(noNet),
        cls: colorFor(apptSet, apptTarget()),
        sub: "target " + fmtPct(apptTarget(), 0) + " · can exceed 100%"
      },
      {
        label: "Solds",
        html: total ? num(total.sold, noTotal) : na(noTotal),
        cls: "none",
        sub: "all lead types · " + rangeLabel(range),
        delta: cmp ? deltaChip(cmp, "sold") : ""
      },
      {
        label: "Internet closing rate",
        html: net ? pct(closing, "Needs internet good leads and internet sold") : na(noNet),
        cls: "none",
        sub: "internet sold ÷ internet good leads"
      }
    ];

    return '<div class="tiles">' + tiles.map(function (t) {
      return '<div class="tile tone-' + esc(t.cls) + '">' +
        '<div class="tile-label">' + esc(t.label) + "</div>" +
        '<div class="tile-value ' + esc(t.cls) + '">' + t.html + "</div>" +
        (t.delta ? '<div class="tile-delta">' + t.delta + "</div>" : "") +
        '<div class="tile-sub">' + esc(t.sub) + "</div>" +
        "</div>";
    }).join("") + "</div>";
  }

  /* Core.compare() supplies the delta; the sign/direction come from Core too. */
  function deltaChip(cmp, key, compareLabel) {
    if (!cmp || !cmp[key]) return "";
    var d = cmp[key];
    if (!isNum(d.delta)) return "";
    var dir = d.direction || (d.delta > 0 ? "up" : (d.delta < 0 ? "down" : "flat"));
    var s = fmtN(d.delta);
    var sign = d.delta > 0 ? "+" : "";
    return '<span class="delta ' + esc(dir) + '" title="Change vs ' + esc(compareLabel || "the comparison period") + '">' +
      esc(sign + s) + "</span>";
  }

  function comparison(storeId, range) {
    var cr = compareRange(range);
    if (!cr) return { prior: null, cmp: null, label: null };
    var pm = storeMetrics(storeId, cr);
    if (!hasData(pm)) return { prior: null, cmp: null, label: cr.label };
    var cur = storeMetrics(storeId, range);
    var cmp = null;
    try {
      if (hasData(cur) && typeof C().compare === "function") cmp = C().compare(cur.total, pm.total);
    } catch (e) { cmp = null; }
    return { prior: pm, cmp: cmp, label: cr.label };
  }

  /* ============================================================ 1. OVERVIEW */

  function overview(range) {
    return guard(function () {
      var c = C();
      var all = null;
      try { all = c.allStoresMetrics(range); } catch (e) { all = null; }
      var list = STORES();

      var head = pageHead("Overview", "All stores · " + rangeLabel(range));

      if (!list.length) {
        return '<section class="page" id="page-overview">' + head +
          emptyState("No stores loaded", "assets/data.js contains no stores.") + "</section>";
      }
      if (!all || !all.hasData) {
        return '<section class="page" id="page-overview">' + head +
          emptyState("No data for this range",
            "No report snapshot covers " + rangeLabel(range) + ". Pick another timeframe — nothing is shown as zero here.") +
          "</section>";
      }

      var cards = list.map(function (s) {
        var sm = storeMetrics(s.id, range);
        var href = "#/store/" + encodeURIComponent(s.id);
        if (!hasData(sm)) {
          return '<a class="store-card no-data" href="' + esc(href) + '">' +
            '<div class="store-card-head"><span class="store-card-name">' + esc(s.name) + "</span>" +
            (s.crm ? '<span class="chip crm">' + esc(s.crm) + "</span>" : "") + "</div>" +
            '<div class="store-card-empty">' + na(noCoverageReason(range)) + " no data for this range</div></a>";
        }
        var net = sm.internet || null;
        var closing = net ? c.rate(net.sold, net.goodLeads) : null;
        var eng = net ? net.contactPct : null;
        var ap = net ? net.apptSetOfContactedPct : null;
        var noNet = "No internet lead rows for " + rangeLabel(range);
        var stats = [
          { l: "Internet leads", v: net ? num(net.goodLeads, noNet) : na(noNet), cls: "none" },
          { l: "Engagement", v: net ? pct(eng, noNet) : na(noNet), cls: colorFor(eng, engagementTarget()) },
          { l: "Appts set", v: net ? pct(ap, noNet) : na(noNet), cls: colorFor(ap, apptTarget()) },
          { l: "Sold", v: num(sm.total ? sm.total.sold : null, "No store total row for " + rangeLabel(range)), cls: "none" },
          { l: "Internet closing", v: net ? pct(closing, noNet) : na(noNet), cls: "none" }
        ];
        var asOf = coverageAsOf(sm);
        return '<a class="store-card" href="' + esc(href) + '">' +
          '<div class="store-card-head"><span class="store-card-name">' + esc(s.name) + "</span>" +
          (s.crm ? '<span class="chip crm">' + esc(s.crm) + "</span>" : "") +
          ((s.tools || []).map(function (t) { return '<span class="chip tool">' + esc(t) + "</span>"; }).join("")) +
          "</div>" +
          (s.location ? '<div class="store-card-loc">' + esc(s.location) + "</div>" : "") +
          '<div class="store-card-stats">' + stats.map(function (st) {
            return '<div class="scs"><span class="scs-l">' + esc(st.l) + "</span>" +
              '<span class="scs-v ' + esc(st.cls) + '">' + st.v + "</span></div>";
          }).join("") + "</div>" +
          (asOf ? '<div class="store-card-foot">' + esc(asOf) + "</div>" : "") +
          "</a>";
      }).join("");

      return '<section class="page" id="page-overview">' +
        head + coverageBanner(range) +
        headlineTiles(all, range, null, null) +
        '<h2 class="section-title">Stores</h2>' +
        '<div class="store-cards">' + cards + "</div>" +
        footnotes([
          "Engagement target " + fmtPct(engagementTarget(), 0) + "; appts set of contacted target " + fmtPct(apptTarget(), 0) + ".",
          "Every figure is aggregated from the counts in the VinSolutions exports; percentages are recomputed from those counts, never averaged."
        ]) +
        "</section>";
    });
  }

  /* ============================================================== 2. STORES */

  /* Column order is dictated by the client and must not change:
     1 Total opportunities · 2 Good leads (internet) · 3 Engagement % ·
     4 Appts set of contacted % · 5 Internet sold closing % · 6 Total sold ·
     7 DMS Sold · 8 Sales goal + pace */
  function storesPage(range) {
    return guard(function () {
      var c = C();
      var list = STORES();
      var head = pageHead("Stores", rangeLabel(range));

      if (!list.length) {
        return '<section class="page" id="page-stores">' + head + coverageBanner(range) +
          emptyState("No stores loaded", "assets/data.js contains no stores.") + "</section>";
      }

      var header =
        "<thead><tr>" +
        "<th>Store</th>" +
        '<th class="num" title="Good Leads, all lead types (store TOTAL row)">Total opportunities</th>' +
        '<th class="num" title="Good Leads where Lead Type = Internet">Good leads — internet</th>' +
        '<th class="num" title="Internet Actual Contact % · target ' + esc(fmtPct(engagementTarget(), 0)) + '">Engagement %</th>' +
        '<th class="num" title="Appts set ÷ contacted (internet) · target ' + esc(fmtPct(apptTarget(), 0)) + ' · can exceed 100%">Appts set of contacted %</th>' +
        '<th class="num" title="Internet Sold in Time Frame ÷ internet Good Leads">Internet sold closing %</th>' +
        '<th class="num" title="Sold in Time Frame for the selected timeframe, all lead types — includes Referral &amp; PreviousCustomer. This is the DMS sold figure; no separate DMS feed exists, so it is not shown twice.">Total sold (DMS)</th>' +
        '<th class="num" title="Monthly unit goal (user-set, stored locally) and pace against it">Sales goal + pace</th>' +
        "</tr></thead>";

      var rows = list.map(function (s) {
        var href = "#/store/" + encodeURIComponent(s.id);
        var linkAttrs = ' class="rowlink" tabindex="0" role="link" data-href="' + esc(href) + '"' +
          " onclick=\"location.hash=this.getAttribute('data-href')\"" +
          " onkeydown=\"if(event.key==='Enter'){location.hash=this.getAttribute('data-href')}\"";
        var nameCell = '<td class="name"><a href="' + esc(href) + '">' + esc(s.name) + "</a>" +
          (s.crm ? '<span class="chip crm">' + esc(s.crm) + "</span>" : "") + "</td>";

        var sm = storeMetrics(s.id, range);
        if (!hasData(sm)) {
          return "<tr" + linkAttrs + ">" + nameCell +
            '<td class="num none" colspan="7">' + na(noCoverageReason(range)) +
            ' <span class="row-note">no data for this range</span></td></tr>';
        }
        var t = sm.total || {};
        var net = sm.internet || null;
        var noNet = "No internet lead rows for " + rangeLabel(range);
        var eng = net ? net.contactPct : null;
        var ap = net ? net.apptSetOfContactedPct : null;
        var closing = net ? c.rate(net.sold, net.goodLeads) : null;

        return "<tr" + linkAttrs + ">" + nameCell +
          td(num(t.goodLeads, "No TOTAL row for " + rangeLabel(range))) +
          td(net ? num(net.goodLeads, noNet) : na(noNet)) +
          td(net ? pct(eng, noNet) : na(noNet), colorFor(eng, engagementTarget()),
            "Target " + fmtPct(engagementTarget(), 0)) +
          td(net ? pct(ap, noNet) : na(noNet), colorFor(ap, apptTarget()),
            "Target " + fmtPct(apptTarget(), 0)) +
          td(net ? pct(closing, noNet) : na(noNet)) +
          td(num(t.sold, "No TOTAL row for " + rangeLabel(range)), "",
            "Sold in Time Frame for " + rangeLabel(range) + ", all lead types.") +
          paceCell(s, range, isNum(t.sold) ? t.sold : null) +
          "</tr>";
      }).join("");

      return '<section class="page" id="page-stores">' + head + coverageBanner(range) +
        tableWrap(header + "<tbody>" + rows + "</tbody>", "stores-tbl") +
        footnotes([
          "Click any row to open the store.",
          "“DMS Sold” and “Total sold” are the same figure — Sold in Time Frame from the CRM export — so they are shown once, as Total sold (DMS). If a separate DMS extract is ever wired in, this splits into two columns.",
          "Sales goals are not part of the reports: they are entered here and stored in this browser only. A store with no goal shows \"no goal\" and is never marked red.",
          paceFootnote()
        ]) +
        "</section>";
    });
  }

  /* ======================================================== 3. STORE DETAIL */

  function storeDetail(storeId, range) {
    return guard(function () {
      var c = C();
      var store = storeById(storeId);
      if (!store) {
        return '<section class="page">' + pageHead("Store not found") +
          emptyState("Unknown store", 'No store with id "' + storeId + '" is loaded.') + "</section>";
      }

      var sm = storeMetrics(store.id, range);
      var head = pageHead(store.name, rangeLabel(range) + (store.location ? " · " + store.location : ""),
        "— MTD vs same period last month");

      if (!hasData(sm)) {
        return '<section class="page" id="page-store">' + head +
          emptyState("No data for this range", noCoverageReason(range)) + "</section>";
      }

      var cmpInfo = comparison(store.id, range);
      var prior = cmpInfo.prior;
      var compareLabel = cmpInfo.label;

      /* --- Table 1: lead-type breakdown ---------------------------------- */
      var showCompare = !!prior;
      var groups = [
        { key: "goodLeads", label: "Opportunities", kind: "count", title: "Good Leads" },
        { key: "contacted", label: "Contact", kind: "count", title: "Leads contacted (derived from Internet Actual Contact % × Good Leads)" },
        { key: "apptsSet", label: "Appts", kind: "count", title: "Appointments set" },
        { key: "apptsShown", label: "Shown", kind: "count", title: "Appts Shown" },
        { key: "sold", label: "Sold", kind: "count", title: "Sold in Time Frame" }
      ];

      var groupRow = '<tr class="groups"><th rowspan="2">Lead type</th>' + groups.map(function (g) {
        return '<th colspan="' + (showCompare ? 2 : 1) + '" class="num" title="' + esc(g.title) + '">' + esc(g.label) + "</th>";
      }).join("") + "</tr>";
      var subRow = "<tr>" + groups.map(function () {
        return '<th class="num">MTD</th>' + (showCompare ? '<th class="num prior">' + esc(compareLabel) + "</th>" : "");
      }).join("") + "</tr>";

      function metricCells(m, pm, cmp) {
        return groups.map(function (g) {
          var v = m ? m[g.key] : null;
          var reason = m ? "Not reported in this report" : "No rows for this lead type in " + rangeLabel(range);
          var extra = "";
          if (g.key === "contacted" && m && isNum(m.contactPct)) extra = "Contact rate " + fmtPct(m.contactPct);
          if (g.key === "apptsSet" && m && isNum(m.apptSetOfContactedPct)) extra = "Appts set of contacted " + fmtPct(m.apptSetOfContactedPct);
          var cell = td(num(v, reason) + (cmp ? " " + deltaChip(cmp, g.key, compareLabel) : ""), "", extra);
          if (!showCompare) return cell;
          var pv = pm ? pm[g.key] : null;
          return cell + '<td class="num prior">' + num(pv, "No comparison data for " + esc(compareLabel)) + "</td>";
        }).join("");
      }

      var ltRows = DISPLAY_LEAD_TYPES.map(function (name) {
        var cur = metricsOf(findLeadType(sm.byLeadType, name));
        var pri = prior ? metricsOf(findLeadType(prior.byLeadType, name)) : null;
        var cmp = null;
        if (cur && pri) { try { cmp = c.compare(cur, pri); } catch (e) { cmp = null; } }
        return '<tr class="lt-row"><td class="name">' + esc(name) + "</td>" + metricCells(cur, pri, cmp) + "</tr>";
      }).join("");

      var totalCmp = null, netCmp = null;
      if (prior) {
        try { totalCmp = c.compare(sm.total, prior.total); } catch (e) { totalCmp = null; }
        try { netCmp = c.compare(sm.internet, prior.internet); } catch (e) { netCmp = null; }
      }
      var totalRow = '<tr class="total-row"><td class="name">All lead types (TOTAL)</td>' +
        metricCells(sm.total, prior ? prior.total : null, totalCmp) + "</tr>";

      var table = tableWrap(
        "<thead>" + groupRow + subRow + "</thead>" +
        "<tbody>" + ltRows + "</tbody>" +
        "<tfoot>" + totalRow + "</tfoot>",
        "leadtype-tbl"
      );

      var notes = [
        "Rows show Internet, Phone and Walk-in only. Referral and PreviousCustomer leads are deliberately not listed, but their Good Leads and Sold in Time Frame are still included in the TOTAL row.",
        "Contact and Appts are counts derived from the reported percentages so they can be aggregated across days and stores.",
        "VinSolutions reports “Internet Actual Contact %” for internet leads only — it writes a literal 0 on Phone, Walk-in, Referral and PreviousCustomer rows, and copies the internet rate onto the store total. Contact and Appts are therefore internet-scoped on every row, which is why the TOTAL matches the Internet row rather than exceeding it.",
        "Appts set of contacted can exceed 100% — one contacted lead can produce several appointments."
      ];
      if (!prior) {
        notes.unshift("No comparison period is available for " + rangeLabel(range) + ", so only MTD values are shown.");
      }

      var storeMeta = '<div class="store-meta">' +
        (store.crm ? '<span class="chip crm">' + esc(store.crm) + "</span>" : "") +
        (store.tools || []).map(function (t) { return '<span class="chip tool">' + esc(t) + "</span>"; }).join("") +
        (coverageAsOf(sm) ? '<span class="asof">' + esc(coverageAsOf(sm)) + "</span>" : "") +
        "</div>";

      return '<section class="page" id="page-store">' +
        head + storeMeta + coverageBanner(range, [storeId]) +
        headlineTiles(sm, range, totalCmp, netCmp) +
        '<h2 class="section-title">Lead types <span class="section-sub">' +
        esc(prior ? "MTD vs " + compareLabel : "MTD") + "</span></h2>" +
        table +
        footnotes(notes) +
        '<p class="backlink"><a href="#/stores">← All stores</a></p>' +
        "</section>";
    });
  }

  /* ==================================================== 4. SALESPERSON ACTIVITY */

  /* Column order dictated by the client:
     1 Total opportunities · 2 Internet leads · 3 Calls · 4 Emails · 5 Texts ·
     6 Appts set · 7 Shown % · 8 Internet sold · 9 Total sold (last) */
  function activity(range) {
    return guard(function () {
      var c = C();
      var list = STORES();
      var head = pageHead("Salesperson activity", rangeLabel(range));
      var noInternetSplit = "The salesperson report is not broken out by lead type, so internet figures are not available per rep.";

      var sections = list.map(function (s) {
        var reps = null;
        try { reps = c.reps(s.id, range); } catch (e) { reps = null; }
        var people = (reps || []).filter(function (r) { return !isTotalRow(r); });

        if (!people.length) {
          return '<section class="panel"><h2 class="section-title">' + esc(s.name) + "</h2>" +
            emptyState("No salesperson activity for this range",
              "No rep-level (Summary Level 1 = User) export covers " + rangeLabel(range) + " for this store.") +
            "</section>";
        }

        var totals = repTotalsFor(s.id, range, reps);
        var bench = activityBenchmarks(s.id, range, reps, people);

        var header = "<thead><tr>" +
          "<th>Salesperson</th>" +
          '<th class="num" title="Good Leads">Total opportunities</th>' +
          '<th class="num" title="' + esc(noInternetSplit) + '">Internet leads</th>' +
          '<th class="num" title="Calls Out">Calls</th>' +
          '<th class="num" title="Emails Out">Emails</th>' +
          '<th class="num" title="Texts Out">Texts</th>' +
          '<th class="num" title="Appts Scheduled">Appts set</th>' +
          '<th class="num" title="Appts Shown ÷ Appts Scheduled">Shown %</th>' +
          '<th class="num" title="' + esc(noInternetSplit) + '">Internet sold</th>' +
          '<th class="num" title="Sold in Time Frame">Total sold</th>' +
          "</tr></thead>";

        var rows = people.map(function (r) {
          var shown = isNum(r.shownPct) ? r.shownPct : c.rate(r.apptsShown, r.apptsScheduled);
          var iLeads = repInternet(r, "internetLeads");
          if (iLeads === null) iLeads = repInternet(r, "internetGoodLeads");
          var iSold = repInternet(r, "internetSold");
          return '<tr><td class="name">' + esc(r.name) + "</td>" +
            td(num(r.goodLeads, "Not reported")) +
            td(iLeads === null ? na(noInternetSplit) : num(iLeads, noInternetSplit)) +
            activityCell(r.calls, bench, "calls") +
            activityCell(r.emails, bench, "emails") +
            activityCell(r.texts, bench, "texts") +
            td(num(r.apptsScheduled, "Not reported")) +
            td(pct(shown, "No appointments scheduled in this range")) +
            td(iSold === null ? na(noInternetSplit) : num(iSold, noInternetSplit)) +
            td(num(r.sold, "Not reported")) +
            "</tr>";
        }).join("");

        var foot = "";
        if (totals) {
          var tShown = isNum(totals.shownPct) ? totals.shownPct : c.rate(totals.apptsShown, totals.apptsScheduled);
          foot = '<tfoot><tr class="total-row"><td class="name">TEAM TOTAL</td>' +
            td(num(totals.goodLeads, "Not reported")) +
            td(na(noInternetSplit)) +
            td(num(totals.calls, "Not reported")) +
            td(num(totals.emails, "Not reported")) +
            td(num(totals.texts, "Not reported")) +
            td(num(totals.apptsScheduled, "Not reported")) +
            td(pct(tShown, "No appointments scheduled in this range")) +
            td(na(noInternetSplit)) +
            td(num(totals.sold, "Not reported")) +
            "</tr></tfoot>";
        }

        return '<section class="panel"><h2 class="section-title">' + esc(s.name) +
          '<span class="section-sub">' + esc(String(people.length) + (people.length === 1 ? " rep" : " reps")) + "</span></h2>" +
          tableWrap(header + "<tbody>" + rows + "</tbody>" + foot, "activity-tbl") +
          (bench ? "" : '<p class="note">' + esc(NO_BENCHMARK) + "</p>") +
          "</section>";
      }).join("");

      if (!list.length) {
        sections = emptyState("No stores loaded", "assets/data.js contains no stores.");
      }

      return '<section class="page" id="page-activity">' + head + coverageBanner(range) + sections +
        footnotes([
          "CRM house accounts (any user whose name contains \"team\" or \"house\") are excluded — they are not people.",
          "Calls, Emails and Texts are coloured against the store's own per-rep average for the same range. No outbound-activity quota exists in the reports, so nothing here is compared to an invented target.",
          "Split deals mean Sold can be fractional (e.g. 7.5 units)."
        ]) +
        "</section>";
    });
  }

  /* ================================================= 5. INTERNET PERFORMANCE */

  /* Column order dictated by the client:
     Good leads · Engagement % · Appts set % · Appts shown % · Calls · Texts ·
     Emails · Internet sold · Internet closing % */
  function internet(range) {
    return guard(function () {
      var c = C();
      var list = STORES();
      var head = pageHead("Internet performance", rangeLabel(range));

      if (!list.length) {
        return '<section class="page" id="page-internet">' + head + coverageBanner(range) +
          emptyState("No stores loaded", "assets/data.js contains no stores.") + "</section>";
      }

      var outboundNote = "Outbound counts come from the rep-level report and cover all lead types, not internet only.";

      var header = "<thead><tr>" +
        "<th>Store</th>" +
        '<th class="num" title="Good Leads where Lead Type = Internet">Good leads</th>' +
        '<th class="num" title="Internet Actual Contact % · target ' + esc(fmtPct(engagementTarget(), 0)) + '">Engagement %</th>' +
        '<th class="num" title="Appts set · target ' + esc(fmtPct(apptTarget(), 0)) + ' · can exceed 100%">Appts set %</th>' +
        '<th class="num" title="Appts Shown ÷ appts set">Appts shown %</th>' +
        '<th class="num" title="Calls Out · ' + esc(outboundNote) + '">Calls</th>' +
        '<th class="num" title="Texts Out · ' + esc(outboundNote) + '">Texts</th>' +
        '<th class="num" title="Emails Out · ' + esc(outboundNote) + '">Emails</th>' +
        '<th class="num" title="Internet Sold in Time Frame">Internet sold</th>' +
        '<th class="num" title="Internet sold ÷ internet good leads">Internet closing %</th>' +
        "</tr></thead>";

      var rows = list.map(function (s) {
        var href = "#/store/" + encodeURIComponent(s.id);
        var linkAttrs = ' class="rowlink" tabindex="0" role="link" data-href="' + esc(href) + '"' +
          " onclick=\"location.hash=this.getAttribute('data-href')\"" +
          " onkeydown=\"if(event.key==='Enter'){location.hash=this.getAttribute('data-href')}\"";
        var nameCell = '<td class="name"><a href="' + esc(href) + '">' + esc(s.name) + "</a></td>";

        var sm = storeMetrics(s.id, range);
        if (!hasData(sm)) {
          return "<tr" + linkAttrs + ">" + nameCell +
            '<td class="num none" colspan="9">' + na(noCoverageReason(range)) +
            ' <span class="row-note">no data for this range</span></td></tr>';
        }
        var net = sm.internet;
        var noNet = "No internet lead rows for " + rangeLabel(range);
        if (!net) {
          return "<tr" + linkAttrs + ">" + nameCell +
            '<td class="num none" colspan="9">' + na(noNet) + "</td></tr>";
        }

        /* "Appts set %" prefers the report's own Appts Set % when present,
           otherwise the appts-set-of-contacted rate. */
        var apSet = isNum(net.apptSetPct) ? net.apptSetPct : net.apptSetOfContactedPct;
        var apSetTitle = isNum(net.apptSetPct)
          ? "Appts Set % as reported"
          : "Appts Set of Contacted % (this store's report has no Appts Set % column)";
        var shownPct = c.rate(net.apptsShown, net.apptsSet);
        var closing = c.rate(net.sold, net.goodLeads);

        var reps = null;
        try { reps = c.reps(s.id, range); } catch (e) { reps = null; }
        var totals = repTotalsFor(s.id, range, reps);
        var outReason = "No rep-level (User) export covers " + rangeLabel(range) + " for this store, so outbound activity is unavailable.";

        return "<tr" + linkAttrs + ">" + nameCell +
          td(num(net.goodLeads, noNet)) +
          td(pct(net.contactPct, "Internet Actual Contact % not reported"), colorFor(net.contactPct, engagementTarget()),
            "Target " + fmtPct(engagementTarget(), 0)) +
          td(pct(apSet, "Appts set % not reported"), colorFor(apSet, apptTarget()),
            apSetTitle + " · target " + fmtPct(apptTarget(), 0)) +
          td(pct(shownPct, "Needs appts set and appts shown")) +
          td(totals ? num(totals.calls, outReason) : na(outReason), "", outboundNote) +
          td(totals ? num(totals.texts, outReason) : na(outReason), "", outboundNote) +
          td(totals ? num(totals.emails, outReason) : na(outReason), "", outboundNote) +
          td(num(net.sold, noNet)) +
          td(pct(closing, "Needs internet good leads and internet sold")) +
          "</tr>";
      }).join("");

      return '<section class="page" id="page-internet">' + head + coverageBanner(range) +
        tableWrap(header + "<tbody>" + rows + "</tbody>", "internet-tbl") +
        footnotes([
          "Engagement % and Appts set % are coloured against their targets (" +
          fmtPct(engagementTarget(), 0) + " and " + fmtPct(apptTarget(), 0) +
          "): green at or above target, amber within 15% below, red further below.",
          outboundNote + " VinSolutions does not split Calls/Texts/Emails by lead type in these exports.",
          "Appts set of contacted can exceed 100% and is shown unclamped."
        ]) +
        "</section>";
    });
  }

  /* ========================================================= 6. DATA SOURCES */

  function sources(range) {
    return guard(function () {
      var data = DATA();
      var list = STORES();
      var head = pageHead("Data sources", "Ingestion status · " + rangeLabel(range));

      /* --- integrations ------------------------------------------------- */
      var integrations = data.integrations || [];
      var intBlock = integrations.length
        ? tableWrap(
          "<thead><tr><th>Source</th><th>Type</th><th>Coverage</th><th>API</th><th>Scheduled email</th><th>Notes</th></tr></thead>" +
          "<tbody>" + integrations.map(function (i) {
            return "<tr>" +
              '<td class="name">' + esc(i.name) + "</td>" +
              "<td>" + (i.type ? esc(i.type) : na("Not recorded")) + "</td>" +
              "<td>" + (i.coverage ? esc(i.coverage) : na("Not recorded")) + "</td>" +
              "<td>" + (i.api ? '<span class="chip ' + esc(String(i.api).toLowerCase()) + '">' + esc(i.api) + "</span>" : na("Not recorded")) + "</td>" +
              "<td>" + (i.scheduledEmail === true ? "Yes" : i.scheduledEmail === false ? "No" : na("Unknown")) + "</td>" +
              '<td class="note-cell">' + (i.note ? esc(i.note) : na("No note")) + "</td>" +
              "</tr>";
          }).join("") + "</tbody>",
          "sources-tbl")
        : emptyState("No integrations recorded", "assets/data.js contains no integrations list.");

      /* --- what is actually loaded per store ---------------------------- */
      var coverage = data.coverage || {};
      var matador = data.matador || [];

      var loadedRows = list.map(function (s) {
        var cov = coverage[s.id] || null;
        var sm = storeMetrics(s.id, range);
        var runDates = (cov && Array.isArray(cov.runDates)) ? cov.runDates : [];
        var months = (cov && Array.isArray(cov.months)) ? cov.months : [];
        var matCount = matador.filter(function (m) { return String(m.storeId) === String(s.id); }).length;
        var inRange = hasData(sm)
          ? '<span class="chip ok">covered</span>'
          : '<span class="chip no" title="' + esc(noCoverageReason(range)) + '">no data</span>';
        return "<tr>" +
          '<td class="name"><a href="#/store/' + esc(encodeURIComponent(s.id)) + '">' + esc(s.name) + "</a></td>" +
          "<td>" + (s.crm ? esc(s.crm) : na("CRM not recorded")) + "</td>" +
          "<td>" + ((s.tools && s.tools.length) ? s.tools.map(function (t) { return '<span class="chip tool">' + esc(t) + "</span>"; }).join("") : na("No extra tools recorded")) + "</td>" +
          "<td>" + (cov && cov.firstRun ? esc(cov.firstRun) : na("No snapshot loaded for this store")) + "</td>" +
          "<td>" + (cov && cov.lastRun ? esc(cov.lastRun) : na("No snapshot loaded for this store")) + "</td>" +
          td(runDates.length ? esc(String(runDates.length)) : na("No run dates recorded"), "", runDates.join(", ")) +
          "<td>" + (months.length ? months.map(function (m) { return '<span class="chip">' + esc(m) + "</span>"; }).join("") : na("No months recorded")) + "</td>" +
          "<td>" + inRange + "</td>" +
          td(matCount ? esc(String(matCount)) : na("No Matador export loaded for this store")) +
          "</tr>";
      }).join("");

      var loadedBlock = list.length
        ? tableWrap(
          "<thead><tr><th>Store</th><th>CRM</th><th>Tools</th>" +
          '<th title="Run Date of the earliest snapshot loaded">First run</th>' +
          '<th title="Run Date of the latest snapshot loaded">Last run</th>' +
          '<th class="num" title="Number of distinct Run Dates loaded — hover for the list">Snapshots</th>' +
          "<th>Months</th>" +
          '<th title="Does a snapshot cover the selected timeframe?">Selected range</th>' +
          '<th class="num">Matador users</th>' +
          "</tr></thead><tbody>" + loadedRows + "</tbody>",
          "coverage-tbl")
        : emptyState("No stores loaded", "assets/data.js contains no stores.");

      /* --- gaps ---------------------------------------------------------- */
      var gapNotes = [];
      list.forEach(function (s) {
        var cov = coverage[s.id];
        if (!cov || !cov.runDates || !cov.runDates.length) {
          gapNotes.push(s.name + ": no snapshots loaded at all.");
          return;
        }
        if (cov.runDates.length === 1) {
          gapNotes.push(s.name + ": only one snapshot (" + cov.runDates[0] + ") — day, week and custom-range filters cannot be differenced until a second export lands.");
        }
        var sm = storeMetrics(s.id, range);
        if (!hasData(sm)) {
          gapNotes.push(s.name + ": nothing covering " + rangeLabel(range) + " (loaded " + cov.firstRun + " → " + cov.lastRun + ").");
        }
      });

      var gapsBlock = gapNotes.length
        ? '<ul class="gaps">' + gapNotes.map(function (g) { return "<li>" + esc(g) + "</li>"; }).join("") + "</ul>"
        : '<p class="note">Every loaded store has a snapshot covering ' + esc(rangeLabel(range)) + ".</p>";

      var generated = data.generatedAt ? "Data built " + data.generatedAt + "." : "";

      return '<section class="page" id="page-sources">' + head +
        '<h2 class="section-title">CRMs &amp; tools</h2>' + intBlock +
        '<h2 class="section-title">What is loaded</h2>' + loadedBlock +
        '<h2 class="section-title">Gaps</h2>' + gapsBlock +
        footnotes([
          "Store, date range and run date all come from the Filters sheet of each export — never from the file name or email subject.",
          "Weekend and holiday days legitimately have no run date; a missing weekday export is a real gap.",
          generated
        ].filter(Boolean)) +
        "</section>";
    });
  }

  /* ----------------------------------------------------------------- export */

  global.Pages = {
    overview: overview,
    stores: storesPage,
    storeDetail: storeDetail,
    activity: activity,
    internet: internet,
    sources: sources
  };
})(window);
