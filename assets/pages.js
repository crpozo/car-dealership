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
  /* Activity and Internet render one section per store; pass a storeId to scope
     them to a single store for its detail page. */
  function scopedStores(storeId) {
    if (!storeId) return STORES();
    var s = storeById(storeId);
    return s ? [s] : [];
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

  /* Everything displays as a whole number (client's call). Split deals make some
     counts fractional (7.5 units) — the display rounds, and the exact value is
     preserved in the hover title wherever it differs. */
  function fmtN(v) {
    if (!isNum(v)) return null;
    var rounded = Math.round(v);
    try { return rounded.toLocaleString(undefined, { maximumFractionDigits: 0 }); } catch (e) { return String(rounded); }
  }
  function exactNote(v) {
    return (isNum(v) && Math.round(v) !== v) ? "Exact: " + v : "";
  }

  /* Percentages arrive from Core as fractions (0.79 → 79%). Never clamped:
     Appts set of contacted legitimately exceeds 100%. */
  function fmtPct(v, digits) {
    if (!isNum(v)) return null;
    var d = (digits === undefined) ? 0 : digits;
    return (v * 100).toFixed(d) + "%";
  }

  function num(v, reason) {
    var s = fmtN(v);
    if (s === null) return na(reason);
    var ex = exactNote(v);
    return ex ? '<span title="' + esc(ex) + '">' + esc(s) + "</span>" : esc(s);
  }
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
  /* nullable goals: no default, colour only when the manager sets one */
  function nullableTarget(key) {
    var v = ((global.Core && C().settings) || {})[key];
    if (!isNum(v) || v <= 0) return null;
    return v > 1 ? v / 100 : v;
  }
  function closingTarget() { return nullableTarget("closingTarget"); }
  function shownTarget() { return nullableTarget("shownTarget"); }

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

  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function prettyMonth(key) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(key || ""));
    if (!m) return String(key || "");
    return MONTH_NAMES[Number(m[2]) - 1] + " " + m[1];
  }

  /* An empty store card is useless if it only says "no data". Say which months the
     store DOES have, so the reader knows to change the timeframe rather than
     assuming the store is dead or that we simply failed to load it. */
  /* Split a store list into the ones with data in this range and the ones without.
     Stores without data are dropped from the UI, but they are still counted and
     named so a client that quietly stopped reporting cannot vanish unnoticed. */
  function withData(list, range) {
    var kept = [], missing = [];
    for (var i = 0; i < list.length; i++) {
      if (hasData(storeMetrics(list[i].id, range))) kept.push(list[i]);
      else missing.push(list[i]);
    }
    return { list: kept, missing: missing };
  }

  /* Stores with no data are simply absent — no count, no note. Which stores are
     missing which scheduled reports is tracked in the README instead. */

  function whereDataIs(storeId, range, sm) {
    // Core already works out WHY there is nothing (no KPI report at all vs. reports
    // that miss this range); repeating a months-only hint over the top of it
    // produced nonsense like "only has Jul 2026" while viewing Jul 2026.
    var reason = (sm && sm.coverage && sm.coverage.reason) || null;
    var months = [];
    try {
      var cov = C().coverage(storeId);
      // these cards show KPI figures, so it is the KPI months that matter
      months = (cov && cov.byKind && cov.byKind.kpi && cov.byKind.kpi.months) ||
               (cov && cov.months) || [];
    } catch (e) { months = []; }

    var hint = "";
    if (months.length) {
      var pretty = months.map(prettyMonth);
      var list = pretty.length === 1
        ? pretty[0]
        : pretty.slice(0, -1).join(", ") + " and " + pretty[pretty.length - 1];
      hint = " KPI reports so far cover " + list + ".";
    }
    if (reason) return reason + hint;
    if (!months.length) return "No reports loaded for this store at all.";
    return "No reports in this range." + hint;
  }

  /* Two-letter monogram for a store's identity tile. First letter of the first
     word + first letter of the last word (parentheticals stripped), so sister
     rooftops stay distinct: Vern Eide Acura → VA, Vern Eide Honda → VH,
     Vern Eide Mitsubishi → VM — where first-two-words would make them all "VE". */
  function monogramFor(name) {
    var words = String(name || "").replace(/\([^)]*\)/g, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
  }

  function monogram(name, large) {
    return '<span class="store-mono' + (large ? " lg" : "") + '" aria-hidden="true">' +
      esc(monogramFor(name)) + "</span>";
  }

  function coverageAsOf(sm) {
    var cov = sm && sm.coverage;
    if (!cov) return "";
    // range coverage carries lastDate; the declared per-store coverage lastRun
    var last = cov.lastDate || cov.lastRun ||
      (Array.isArray(cov.runDates) && cov.runDates.length ? cov.runDates[cov.runDates.length - 1] : null);
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

  /* Breadcrumb trail. Last entry is the current page: rendered as plain text with
     aria-current, not a link back to where the reader already is. */
  function breadcrumbs(trail) {
    var items = (trail || []).filter(Boolean).map(function (c, i, arr) {
      var last = i === arr.length - 1;
      var label = esc(c.label);
      return "<li>" + (last || !c.href
        ? '<span aria-current="page">' + label + "</span>"
        : '<a href="' + esc(c.href) + '">' + label + "</a>") + "</li>";
    });
    if (!items.length) return "";
    return '<nav class="crumbs" aria-label="Breadcrumb"><ol>' + items.join("") + "</ol></nav>";
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

  /* Footnotes are switched off platform-wide at the client's request: the blocks of
     explanatory prose under every table were noise for people who already know the
     domain. The caveats they carried (Referral/PreviousCustomer folded into TOTAL,
     internet-scoped Contact/Appts, appts-set over 100%, DMS Sold == Total sold,
     browser-local goals, NETWORKDAYS pace) still live on the column-header title
     tooltips and in the README. Return the list again here to bring them back. */
  function footnotes(/* list */) {
    return "";
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

    // Order per the client: closing rate before Solds. Subs are uppercase via
    // CSS; the goal is a badge so it stands out from descriptive text.
    var tiles = [
      {
        label: "Good Internet Leads",
        html: net ? num(net.goodLeads, noNet) : na(noNet),
        cls: "none",
        delta: netCmp ? deltaChip(netCmp, "goodLeads") : ""
      },
      {
        label: "Engagement %",
        html: net ? pct(engagement, "Internet Actual Contact % not reported for " + rangeLabel(range)) : na(noNet),
        cls: colorFor(engagement, engagementTarget()),
        subHtml: '<span class="goal-badge">Goal ' + esc(fmtPct(engagementTarget(), 0)) + "</span>"
      },
      {
        label: "Appts Set Of Contacted %",
        html: net ? pct(apptSet, "Appts Set of Contacted % not reported for " + rangeLabel(range)) : na(noNet),
        cls: colorFor(apptSet, apptTarget()),
        subHtml: '<span class="goal-badge">Goal ' + esc(fmtPct(apptTarget(), 0)) + "</span> Can Exceed 100%"
      },
      {
        label: "Internet Closing Rate",
        html: net ? pct(closing, "Needs internet good leads and internet sold") : na(noNet),
        cls: colorFor(closing, closingTarget()),
        subHtml: closingTarget() ? '<span class="goal-badge">Goal ' + esc(fmtPct(closingTarget(), 0)) + "</span>" : esc("Internet Sold \u00f7 Internet Good Leads")
      },
      {
        label: "Total Solds",
        html: total ? num(total.sold, noTotal) : na(noTotal),
        cls: "none",
        sub: "All Lead Types",
        delta: cmp ? deltaChip(cmp, "sold") : ""
      }
    ];

    return '<div class="tiles">' + tiles.map(function (t) {
      var sub = t.subHtml || (t.sub ? esc(t.sub) : "");
      return '<div class="tile tone-' + esc(t.cls) + '">' +
        '<div class="tile-label">' + esc(t.label) + "</div>" +
        '<div class="tile-value ' + esc(t.cls) + '">' + t.html + "</div>" +
        (t.delta ? '<div class="tile-delta">' + t.delta + "</div>" : "") +
        (sub ? '<div class="tile-sub">' + sub + "</div>" : "") +
        "</div>";
    }).join("") + "</div>";
  }

  /* Percentage-POINT change chip, e.g. 62% now vs 66% Prev MTD → "-4 pts". */
  function ppChip(cur, pri, label) {
    if (!isNum(cur) || !isNum(pri)) return "";
    var d = Math.round((cur - pri) * 100);
    if (d === 0) return "";
    return ' <span class="delta ' + (d > 0 ? "up" : "down") + '" title="' +
      esc("Percentage points vs " + (label || "Prev MTD") + " (was " + (fmtPct(pri) || "?") + ")") +
      '">' + esc((d > 0 ? "+" : "") + d + " pts") + "</span>";
  }

  /* Core.compare() supplies the delta; the sign/direction come from Core too. */
  function deltaChip(cmp, key, compareLabel) {
    if (!cmp || !cmp[key]) return "";
    var d = cmp[key];
    if (!isNum(d.delta) || d.delta === 0) return "";
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
      if (!withData(list, range).list.length) {
        return '<section class="page" id="page-overview">' + head +
          emptyState("No store has data for " + rangeLabel(range),
            "All " + list.length + " stores are missing reports for this range. Pick another timeframe.") +
          "</section>";
      }
      if (!all || !all.hasData) {
        return '<section class="page" id="page-overview">' + head +
          emptyState("No data for this range",
            "No report snapshot covers " + rangeLabel(range) + ". Pick another timeframe — nothing is shown as zero here.") +
          "</section>";
      }

      // A store with nothing to show in this range is left out entirely rather
      // than rendered as an empty card. withData() is shared with the table view
      // so the cards and the rows can never disagree about who is on the roster.
      var shown = withData(list, range);
      var cr = compareRange(range);
      var allPrior = null;
      if (cr) { try { allPrior = c.allStoresMetrics(cr); } catch (e) { allPrior = null; } }
      var cards = shown.list.map(function (s) { return storeCard(s, range, cr); }).join("");
      var isCards = storeView() === "cards";

      // The topbar breadcrumb carries the page identity, and the timeframe
      // control already spells out the dates — the stats band leads directly,
      // like the reference layout.
      return '<section class="page" id="page-overview">' +
        coverageBanner(range) +
        statsBand(all, range, allPrior) +
        '<div class="cards-toolbar">' +
          '<span class="search-wrap"><span class="search-ico" aria-hidden="true">&#8981;</span>' +
          '<input type="search" id="store-search" placeholder="Search store&hellip;" aria-label="Search stores"' +
          ' oninput="Pages.filterStores(this.value)"></span>' +
          '<span class="view-toggle" role="group" aria-label="View">' +
            '<button type="button" class="vt-btn' + (isCards ? " on" : "") + '" title="Card view"' +
              ' aria-pressed="' + (isCards ? "true" : "false") + '" onclick="Pages.setStoreView(\'cards\')">&#9638;</button>' +
            '<button type="button" class="vt-btn' + (!isCards ? " on" : "") + '" title="Table view"' +
              ' aria-pressed="' + (!isCards ? "true" : "false") + '" onclick="Pages.setStoreView(\'table\')">&#9776;</button>' +
          "</span>" +
        "</div>" +
        (isCards
          ? '<div class="store-cards">' + cards + "</div>"
          : storesTableBlock(range)) +
        '<p class="roster-note">Showing ' + shown.list.length + " of " + list.length + " stores" +
        (shown.missing.length ? " — the rest have no reports for " + esc(rangeLabel(range)) : "") + ".</p>" +
        "</section>";
    });
  }

  /* Reference-style store card: identity row (tile, name, CRM subline) with a
     performance pill, label/value body, and explicit actions. The pill is the
     engagement colour band, spelled out — Good / Average / Needs attention —
     never an invented rating. */
  function storeCard(s, range, priorRange) {
    var c = C();
    var sm = storeMetrics(s.id, range);
    var prior = priorRange ? storeMetrics(s.id, priorRange) : null;
    if (prior && !hasData(prior)) prior = null;
    var href = "#/store/" + encodeURIComponent(s.id);
    var net = sm.internet || null;
    var eng = net ? net.contactPct : null;
    var ap = net ? net.apptSetOfContactedPct : null;
    var closing = net ? c.rate(net.sold, net.goodLeads) : null;
    var noNet = "No internet lead rows for " + rangeLabel(range);

    var st = storeStatus(sm, prior);
    var pill = st.band === "none" ? "" :
      '<span class="pill ' + st.band + '" title="' + esc(st.detail) +
      '"><span class="dot" aria-hidden="true"></span>' + esc(st.word) + "</span>";

    var soldDelta = "";
    if (prior && sm.total && prior.total) {
      var scmp = null;
      try { scmp = c.compare(sm.total, prior.total); } catch (e) { scmp = null; }
      soldDelta = scmp ? deltaChip(scmp, "sold", "Prev MTD (same days last month)") : "";
    }

    var sub = [s.crm].concat(s.tools || []).filter(Boolean).join(" · ");
    var asOf = coverageAsOf(sm);
    var rows = [
      { l: "Internet leads", v: net ? num(net.goodLeads, noNet) : na(noNet), cls: "none" },
      { l: "Engagement", v: net ? pct(eng, noNet) : na(noNet), cls: colorFor(eng, engagementTarget()) },
      { l: "Appts set", v: net ? pct(ap, noNet) : na(noNet), cls: colorFor(ap, apptTarget()) },
      { l: "Internet closing", v: net ? pct(closing, noNet) : na(noNet), cls: colorFor(closing, closingTarget()) },
      { l: "Sold", v: num(sm.total ? sm.total.sold : null, "No store total row for " + rangeLabel(range)) + soldDelta, cls: "none" },
      { l: "Data through", v: asOf ? esc(asOf.replace(/^as of /, "")) : na("No run date"), cls: "none" }
    ];

    return '<article class="store-card" data-store-name="' + esc(s.name.toLowerCase()) + '">' +
      '<div class="store-card-head">' + monogram(s.name) +
      '<span class="store-card-title"><span class="store-card-name">' + esc(s.name) + "</span>" +
      (sub ? '<span class="store-card-kicker">' + esc(sub) + "</span>" : "") +
      "</span>" + pill + "</div>" +
      '<div class="store-card-stats">' + rows.map(function (st) {
        return '<div class="scs"><span class="scs-l">' + esc(st.l) + "</span>" +
          '<span class="scs-v ' + esc(st.cls) + '">' + st.v + "</span></div>";
      }).join("") + "</div>" +
      '<div class="store-card-actions">' +
        '<a class="btn" href="' + esc(href) + '">View store</a>' +
        '<a class="btn btn-accent" href="' + esc(href) + '/activity">Salesperson activity</a>' +
      "</div>" +
      "</article>";
  }

  /* Store health from FOUR checks, not one: Engagement vs its goal, Appts set
     vs its goal, Sold vs the same days last month, Internet closing vs the same
     days last month. 0 misses = On track, 1 = Watch, 2+ = Needs attention.
     Checks that cannot be evaluated (no prior report) are skipped, never
     counted as failures, and the pill tooltip itemises every check. */
  function storeStatus(sm, prior) {
    var c = C();
    var net = sm && sm.internet;
    var checks = [];
    var eng = net ? net.contactPct : null;
    if (isNum(eng)) checks.push({ ok: eng >= engagementTarget(),
      label: "Engagement " + fmtPct(eng) + " vs goal " + fmtPct(engagementTarget(), 0) });
    var ap = net ? net.apptSetOfContactedPct : null;
    if (isNum(ap)) checks.push({ ok: ap >= apptTarget(),
      label: "Appts set " + fmtPct(ap) + " vs goal " + fmtPct(apptTarget(), 0) });
    if (prior && prior.total && sm.total && isNum(sm.total.sold) && isNum(prior.total.sold)) {
      checks.push({ ok: sm.total.sold >= prior.total.sold,
        label: "Sold " + fmtN(sm.total.sold) + " vs " + fmtN(prior.total.sold) + " Prev MTD" });
    }
    var closing = net ? c.rate(net.sold, net.goodLeads) : null;
    var priorNet = prior && prior.internet;
    var priorClosing = priorNet ? c.rate(priorNet.sold, priorNet.goodLeads) : null;
    if (isNum(closing) && isNum(priorClosing)) {
      checks.push({ ok: closing >= priorClosing,
        label: "Internet closing " + fmtPct(closing) + " vs " + fmtPct(priorClosing) + " Prev MTD" });
    }
    if (!checks.length) return { band: "none", word: "", detail: "" };
    var misses = checks.filter(function (x) { return !x.ok; }).length;
    var band = misses >= 2 ? "bad" : (misses === 1 ? "warn" : "good");
    var word = misses >= 2 ? "Needs attention" : (misses === 1 ? "Watch" : "On track");
    var detail = checks.map(function (x) { return (x.ok ? "\u2713 " : "\u2717 ") + x.label; }).join("  \u00b7  ") +
      "  \u2014  " + misses + " of " + checks.length + " checks missed";
    return { band: band, word: word, detail: detail };
  }

  /* Dealer-group dashboard: the overview, scoped to one group's stores. */
  function groupPage(groupId, range) {
    return guard(function () {
      var c = C();
      var g = c.groupById(groupId);
      if (!g) {
        return '<section class="page">' + pageHead("Group not found") +
          emptyState("Unknown group", 'No dealer group "' + groupId + '" is loaded.') + "</section>";
      }
      var members = STORES().filter(function (s) { return g.storeIds.indexOf(s.id) !== -1; });
      var shown = withData(members, range);
      var head = pageHead(g.name, shown.list.length + " of " + members.length + " stores reporting \u00b7 " + rangeLabel(range));
      if (!shown.list.length) {
        return '<section class="page" id="page-group">' + head +
          emptyState("No data for this range", "No " + g.name + " store has reports covering " + rangeLabel(range) + ".") +
          "</section>";
      }
      var all = null, allPrior = null;
      try { all = c.allStoresMetrics(range, g.storeIds); } catch (e) { all = null; }
      var cr = compareRange(range);
      if (cr) { try { allPrior = c.allStoresMetrics(cr, g.storeIds); } catch (e) { allPrior = null; } }
      var cards = shown.list.map(function (s) { return storeCard(s, range, cr); }).join("");
      return '<section class="page" id="page-group">' + head + coverageBanner(range, g.storeIds) +
        (all && all.hasData ? statsBand(all, range, allPrior) : "") +
        '<div class="store-cards">' + cards + "</div>" +
        "</section>";
    });
  }

  /* One stat card with divided columns, like the reference's summary band.
     prior (same roll-up over the comparison range) adds a red/green delta light
     on Solds — sold up vs the same days last month reads green, down reads red. */
  function statsBand(all, range, prior) {
    var c = C();
    var net = all.internet || null;
    var total = all.total || null;
    var noNet = "No internet lead rows in the reports for " + rangeLabel(range) + ".";
    var eng = net ? net.contactPct : null;
    var ap = net ? net.apptSetOfContactedPct : null;
    var closing = net ? c.rate(net.sold, net.goodLeads) : null;
    var soldDelta = "";
    if (prior && prior.hasData && total && prior.total) {
      var cmp = null;
      try { cmp = c.compare(total, prior.total); } catch (e) { cmp = null; }
      soldDelta = cmp ? deltaChip(cmp, "sold", "Prev MTD (same days last month)") : "";
    }
    var cells = [
      { v: net ? num(net.goodLeads, noNet) : na(noNet), l: "Good Internet Leads", cls: "none" },
      { v: net ? pct(eng, noNet) : na(noNet), l: "Engagement %", goal: engagementTarget(), cls: colorFor(eng, engagementTarget()) },
      { v: net ? pct(ap, noNet) : na(noNet), l: "Appts Set Of Contacted", goal: apptTarget(), cls: colorFor(ap, apptTarget()) },
      { v: net ? pct(closing, noNet) : na(noNet), l: "Internet Closing Rate", goal: closingTarget(), cls: colorFor(closing, closingTarget()) },
      { v: (total ? num(total.sold, "No totals") : na("No totals")) + soldDelta, l: "Total Solds \u00b7 All Lead Types", cls: "none" }
    ];
    return '<div class="statsband">' + cells.map(function (x) {
      return '<div class="sb-cell"><span class="sb-v ' + esc(x.cls) + '">' + x.v + "</span>" +
        '<span class="sb-l">' + esc(x.l) +
        (x.goal ? ' <span class="goal-badge">Goal ' + esc(fmtPct(x.goal, 0)) + "</span>" : "") +
        "</span></div>";
    }).join("") + "</div>";
  }

  /* cards ⇄ table view for the store roster, persisted per browser */
  var VIEW_KEY = "icdash.storeView";
  function storeView() {
    try { return global.localStorage.getItem(VIEW_KEY) === "table" ? "table" : "cards"; }
    catch (e) { return "cards"; }
  }
  function setStoreView(v) {
    try { global.localStorage.setItem(VIEW_KEY, v === "table" ? "table" : "cards"); } catch (e) { /* private mode */ }
    if (global.App && global.App.render) global.App.render();
  }

  /* Client-side name filter over whichever roster view is on screen. */
  function filterStores(q) {
    q = String(q || "").trim().toLowerCase();
    var cards = document.querySelectorAll(".store-card[data-store-name]");
    for (var i = 0; i < cards.length; i++) {
      cards[i].hidden = q !== "" && cards[i].getAttribute("data-store-name").indexOf(q) === -1;
    }
    var rows = document.querySelectorAll(".stores-tbl tbody tr");
    for (var j = 0; j < rows.length; j++) {
      var cell = rows[j].querySelector("td.name");
      rows[j].hidden = q !== "" && cell && cell.textContent.toLowerCase().indexOf(q) === -1;
    }
  }

  /* ============================================================== 2. STORES */

  /* Column order is dictated by the client and must not change:
     1 Total opportunities · 2 Good leads (internet) · 3 Engagement % ·
     4 Appts set of contacted % · 5 Internet sold closing % · 6 Total sold ·
     7 DMS Sold · 8 Sales goal + pace */
  /* The store table lives on the Overview (the main dashboard) — extracted so the
     standalone #/stores route and the Overview render exactly the same thing. */
  function storesTableBlock(range) {
      var c = C();
      var all = STORES();
      if (!all.length) return emptyState("No stores loaded", "assets/data.js contains no stores.");
      var split = withData(all, range);
      var list = split.list;
      if (!list.length) {
        return emptyState("No store has data for " + rangeLabel(range),
          "All " + all.length + " stores are missing reports for this range. Pick another timeframe.");
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

      // The caveats these used to spell out (DMS Sold == Total sold, goals are
      // browser-local, NETWORKDAYS/no-holiday pace) live on the column headers'
      // title tooltips and in the README, so nothing was lost by removing them.
      return tableWrap(header + "<tbody>" + rows + "</tbody>", "stores-tbl");
  }

  function storesPage(range) {
    return guard(function () {
      return '<section class="page" id="page-stores">' +
        pageHead("Stores", rangeLabel(range)) + coverageBanner(range) +
        storesTableBlock(range) + "</section>";
    });
  }

  /* ======================================================== 3. STORE DETAIL */

  /* Tabs belong to a store, not to the whole app: at the top level the reader has
     one dashboard, and only once they've picked a store does "activity" or
     "internet performance" mean anything specific. */
  var STORE_TABS = [
    { id: "performance", label: "Performance", suffix: "" },
    { id: "activity", label: "Salesperson Activity", suffix: "/activity" },
    { id: "internet", label: "Internet Performance", suffix: "/internet" }
  ];

  function storeTabs(storeId, active) {
    var base = "#/store/" + encodeURIComponent(storeId);
    return '<nav class="subnav" aria-label="Store sections">' + STORE_TABS.map(function (t) {
      var on = t.id === active;
      return '<a href="' + esc(base + t.suffix) + '"' + (on ? ' class="on" aria-current="page"' : "") +
        ">" + esc(t.label) + "</a>";
    }).join("") + "</nav>";
  }

  /* Shared chrome for every store page: breadcrumbs, title, meta, tabs. */
  function storeShell(storeId, range, active, body) {
    var store = storeById(storeId);
    if (!store) {
      return '<section class="page">' + pageHead("Store not found") +
        emptyState("Unknown store", 'No store with id "' + storeId + '" is loaded.') + "</section>";
    }
    var sm = storeMetrics(store.id, range);
    var meta = '<div class="store-meta">' +
      (store.crm ? '<span class="chip crm">' + esc(store.crm) + "</span>" : "") +
      (store.tools || []).map(function (t) { return '<span class="chip tool">' + esc(t) + "</span>"; }).join("") +
      (coverageAsOf(sm) ? '<span class="asof">' + esc(coverageAsOf(sm)) + "</span>" : "") +
      "</div>";
    // the topbar breadcrumb (Dashboard / <store>) owns wayfinding now
    return '<section class="page" id="page-store">' +
      // same identity tile as the overview card, so following a card into its
      // detail page visibly lands on the same store
      '<div class="store-ident">' + monogram(store.name, true) +
      pageHead(store.name, rangeLabel(range) + (store.location ? " · " + store.location : "")) +
      "</div>" +
      meta +
      storeTabs(store.id, active) +
      coverageBanner(range, [store.id]) +
      body(store, sm) +
      "</section>";
  }

  function storeActivity(storeId, range) {
    return guard(function () {
      return storeShell(storeId, range, "activity", function () {
        return activity(range, storeId);
      });
    });
  }

  function storeInternet(storeId, range) {
    return guard(function () {
      return storeShell(storeId, range, "internet", function () {
        return internet(range, storeId);
      });
    });
  }

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
      // Column names are the client's: Good Leads (they ARE Good Leads),
      // Engagement (a PERCENTAGE — Phone and Walk-in are always contacted, so
      // those rows leave it blank), Appts Set, Appts Shown, Sold.
      var groups = [
        { key: "goodLeads", label: "Good Leads", title: "Good Leads" },
        { key: "engagement", label: "Engagement", title: "Internet Actual Contact % \u2014 an internet-lead measure. Phone and Walk-in customers are contacted by definition, so those rows are blank." },
        { key: "apptsSet", label: "Appts Set", title: "Appointments set" },
        { key: "apptsShown", label: "Appts Shown", title: "Appts Shown" },
        { key: "sold", label: "Sold", title: "Sold in Time Frame" }
      ];

      var groupRow = '<tr class="groups"><th rowspan="2">Lead type</th>' + groups.map(function (g) {
        return '<th colspan="' + (showCompare ? 2 : 1) + '" class="num" title="' + esc(g.title) + '">' + esc(g.label) + "</th>";
      }).join("") + "</tr>";
      var subRow = "<tr>" + groups.map(function () {
        return '<th class="num">MTD</th>' + (showCompare ? '<th class="num prior" title="Same days of the previous month">Prev MTD</th>' : "");
      }).join("") + "</tr>";

      function metricCells(m, pm, cmp, engMode) {
        return groups.map(function (g) {
          var reason = m ? "Not reported in this report" : "No rows for this lead type in " + rangeLabel(range);
          // Engagement AND Appts Set are internet-scoped derivations (contact %
          // x internet leads); on Phone/Walk-in rows a zero there would be an
          // invention, so both stay blank outside internet.
          if ((g.key === "engagement" || g.key === "apptsSet") && engMode !== "pct") {
            return td("") + (showCompare ? '<td class="num prior"></td>' : "");
          }
          if (g.key === "engagement") {
            var cell0 = td(m ? pct(m.contactPct, reason) : na(reason), "",
              m && isNum(m.contacted) ? fmtN(m.contacted) + " contacted" : "");
            if (!showCompare) return cell0;
            return cell0 + '<td class="num prior">' + (pm ? pct(pm.contactPct, "No Prev MTD data") : na("No Prev MTD data")) + "</td>";
          }
          var v = m ? m[g.key] : null;
          var extra = "";
          if (g.key === "apptsSet" && m && isNum(m.apptSetOfContactedPct)) extra = "Appts set of contacted " + fmtPct(m.apptSetOfContactedPct);
          var cell = td(num(v, reason) + (cmp ? " " + deltaChip(cmp, g.key, "Prev MTD") : ""), "", extra);
          if (!showCompare) return cell;
          var pv = pm ? pm[g.key] : null;
          return cell + '<td class="num prior">' + num(pv, "No Prev MTD data") + "</td>";
        }).join("");
      }

      function findByKey(arr, key) {
        for (var i = 0; i < (arr || []).length; i++) if (arr[i].key === key) return arr[i];
        return null;
      }

      function cmpOf(cur, pri) {
        if (!cur || !pri) return null;
        try { return c.compare(cur, pri); } catch (e) { return null; }
      }

      /* Name cell for an expandable row: a real <button> so the drill-down works
         by keyboard too. Pages.toggleRows shows/hides the child rows. */
      function nameCell(label, cls, depth, expandable, kids) {
        var inner = expandable
          ? '<button type="button" class="expander" aria-expanded="false" onclick="Pages.toggleRows(this)"' +
            ' title="' + esc("Break down by " + kids + " (" + label + ")") + '">' +
            '<span class="chev" aria-hidden="true"></span>' + esc(label) + "</button>"
          : esc(label);
        return '<td class="name depth-' + depth + " " + cls + '">' + inner + "</td>";
      }

      /* Lead type → inventory type → vehicle make. Children render collapsed and
         come straight from Core's aggregated tree, so they respect the selected
         timeframe exactly like the parent rows do. */
      var UNKNOWN = /^unknown/i;
      var ltRows = DISPLAY_LEAD_TYPES.map(function (name) {
        var node = findLeadType(sm.byLeadType, name);
        var priNode = prior ? findLeadType(prior.byLeadType, name) : null;
        var cur = metricsOf(node);
        var pri = priNode ? metricsOf(priNode) : null;
        // Engagement is internet-only; Phone and Walk-in rows leave it blank
        var engMode = ltKey(name) === "internet" ? "pct" : "blank";
        // "Unknown" inventory rows are hidden at the client's request; their
        // numbers still count in the lead-type row above (it is the parent's
        // own subtotal, not a sum of the visible children).
        var invs = ((node && node.byInventory) || []).filter(function (inv) {
          return !UNKNOWN.test(inv.inventoryType || "");
        });
        var ltPath = "lt:" + (node ? node.key : name);

        var rows = '<tr class="lt-row" data-path="' + esc(ltPath) + '">' +
          nameCell(name, "", 0, invs.length > 0, "inventory type") +
          metricCells(cur, pri, cmpOf(cur, pri), engMode) + "</tr>";

        rows += invs.map(function (inv) {
          var priInv = priNode ? findByKey(priNode.byInventory, inv.key) : null;
          var invPath = ltPath + "/inv:" + inv.key;
          var makes = (inv.byMake || []).filter(function (mk) {
            return !UNKNOWN.test(mk.make || "");
          }).sort(function (a, b) {
            var d = (b.metrics.goodLeads || 0) - (a.metrics.goodLeads || 0);
            return d !== 0 ? d : (a.make < b.make ? -1 : 1);
          });
          var out = '<tr class="inv-row" data-path="' + esc(invPath) + '" data-parent="' + esc(ltPath) + '" hidden>' +
            nameCell(inv.inventoryType, "", 1, makes.length > 0, "vehicle make") +
            metricCells(inv.metrics, priInv && priInv.metrics, cmpOf(inv.metrics, priInv && priInv.metrics), engMode) + "</tr>";
          out += makes.map(function (mk) {
            var priMk = priInv ? findByKey(priInv.byMake, mk.key) : null;
            return '<tr class="mk-row" data-path="' + esc(invPath + "/mk:" + mk.key) + '" data-parent="' + esc(invPath) + '" hidden>' +
              nameCell(mk.make, "", 2, false, "") +
              metricCells(mk.metrics, priMk && priMk.metrics, cmpOf(mk.metrics, priMk && priMk.metrics), engMode) + "</tr>";
          }).join("");
          return out;
        }).join("");
        return rows;
      }).join("");

      var totalCmp = null, netCmp = null;
      if (prior) {
        try { totalCmp = c.compare(sm.total, prior.total); } catch (e) { totalCmp = null; }
        try { netCmp = c.compare(sm.internet, prior.internet); } catch (e) { netCmp = null; }
      }
      var totalRow = '<tr class="total-row"><td class="name">All lead types (TOTAL)</td>' +
        metricCells(sm.total, prior ? prior.total : null, totalCmp, "pct") + "</tr>";

      var table = tableWrap(
        "<thead>" + groupRow + subRow + "</thead>" +
        "<tbody>" + ltRows + "</tbody>" +
        "<tfoot>" + totalRow + "</tfoot>",
        "leadtype-tbl"
      );

      // Footnotes removed at the client's request. The same caveats (Referral /
      // PreviousCustomer folded into TOTAL, internet-scoped Contact/Appts, appts
      // set of contacted exceeding 100%) remain on the column tooltips and in the
      // README; the sub-header still names the comparison column when one exists.

      var storeMeta = '<div class="store-meta">' +
        (store.crm ? '<span class="chip crm">' + esc(store.crm) + "</span>" : "") +
        (store.tools || []).map(function (t) { return '<span class="chip tool">' + esc(t) + "</span>"; }).join("") +
        (coverageAsOf(sm) ? '<span class="asof">' + esc(coverageAsOf(sm)) + "</span>" : "") +
        "</div>";

      return storeShell(storeId, range, "performance", function () {
        return headlineTiles(sm, range, totalCmp, netCmp) +
          '<h2 class="section-title">Lead types <span class="section-sub" title="' +
          esc(prior ? "Prev MTD = " + compareLabel : "") + '">' +
          esc(prior ? "MTD vs Prev MTD" : "MTD") + "</span></h2>" +
          table +
          storeTrendSection(storeId, store.name);
      });
    });
  }

  /* ==================================================== 4. SALESPERSON ACTIVITY */

  /* Column order dictated by the client:
     1 Total opportunities · 2 Internet leads · 3 Calls · 4 Emails · 5 Texts ·
     6 Appts set · 7 Shown % · 8 Internet sold · 9 Total sold (last) */
  /* Per-day activity, the way the coaches' Excel works: total outbound ÷
     NETWORKDAYS in the selected range. Colours compare each rep's per-day rate
     to the store's own per-rep average for the same range (same denominator, so
     no invented quota), team grouping follows the export's User Group column,
     and the table can be downloaded as CSV or printed. */
  /* Per-day activity the way the coaches' Excel works. Calls and Texts+Emails
     are per working day (NETWORKDAYS); colours compare each rep to the
     CONFIGURED per-day goal when the manager has set one, otherwise to the
     store's own per-rep average for the range. Videos come from the Matador
     per-rep join. Everything rounds to whole numbers; hover shows the exact
     figures and the full formula. */
  function activity(range, storeId) {
    return guard(function () {
      var c = C();
      var list = scopedStores(storeId);
      var scoped = !!storeId;
      var head = scoped ? "" : pageHead("Salesperson Activity", rangeLabel(range));
      var st = c.settings || {};
      var sat = st.includeSaturday !== false;
      var days = null;
      try { days = c.networkDays(range.start, range.end, sat); } catch (e) { days = null; }
      var daysNote = "Working days in " + rangeLabel(range) + ": " + (days === null ? "?" : days) +
        " (NETWORKDAYS, Mon\u2013" + (sat ? "Sat" : "Fri") + ", no holiday calendar)";
      var priorRange = compareRange(range);
      var groupMode = activityGroupMode();
      var callsGoal = isNum(st.callsPerDayGoal) && st.callsPerDayGoal > 0 ? st.callsPerDayGoal : null;
      var msgsGoal = isNum(st.msgsPerDayGoal) && st.msgsPerDayGoal > 0 ? st.msgsPerDayGoal : null;
      var matadorNote = "From the Matador Users export (a snapshot) \u2014 NOT filtered by the selected dates.";

      function dayCell(total, exact, bench, goal, what) {
        var avg = c.rate(total, days);
        var target = goal !== null ? goal : (bench !== null ? c.rate(bench, days) : null);
        var cls = colorFor(avg, target);
        var basis = goal !== null
          ? "goal " + fmtN(goal) + "/day (Settings)"
          : (isNum(target) ? "store average " + fmtN(target) + "/day (no goal set)" : "no goal or average available");
        var title = what + ": " + (isNum(total) ? fmtN(total) + " total" : "not reported") +
          (exact ? " \u00b7 " + exact : "") +
          " \u00b7 " + daysNote + " \u00b7 coloured vs " + basis;
        return td(avg === null ? na(isNum(total) ? daysNote : "Not reported in this export") : esc(fmtN(avg)), cls, title);
      }

      function soldCell(r, priorBy) {
        var chip = "";
        if (priorBy) {
          var pv = priorBy[normName(r.name)];
          if (isNum(pv) && isNum(r.sold)) {
            var d = Math.round(r.sold - pv);
            if (d !== 0) {
              chip = ' <span class="delta ' + (d > 0 ? "up" : "down") + '" title="vs Prev MTD: ' +
                esc(fmtN(pv)) + '">' + esc((d > 0 ? "+" : "") + d) + "</span>";
            }
          }
        }
        return td(num(r.sold, "Not reported") + chip);
      }

      function msgsOf(r) {
        if (!isNum(r.texts) && !isNum(r.emails)) return { v: null, note: "Neither Texts Out nor Emails Out reported" };
        var v = (isNum(r.texts) ? r.texts : 0) + (isNum(r.emails) ? r.emails : 0);
        var bits = [];
        bits.push(isNum(r.texts) ? "Texts " + fmtN(r.texts) : "Texts not reported");
        bits.push(isNum(r.emails) ? "Emails " + fmtN(r.emails) : "Emails not reported");
        return { v: v, note: bits.join(" \u00b7 ") };
      }

      function videosCell(r) {
        var m = r.matador;
        if (!m || !isNum(m.videosSent)) return td(na("No Matador join for this rep \u2014 Covideo not connected yet"));
        return td(num(m.videosSent, ""), "", matadorNote);
      }

      function normName(n) { return String(n || "").toLowerCase().replace(/\s+/g, " ").trim(); }

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
        var priorBy = null;
        if (priorRange) {
          try {
            var priorReps = c.reps(s.id, priorRange) || [];
            priorBy = {};
            for (var pi = 0; pi < priorReps.length; pi++) {
              if (!isTotalRow(priorReps[pi])) priorBy[normName(priorReps[pi].name)] = priorReps[pi].sold;
            }
            if (!priorReps.length) priorBy = null;
          } catch (e) { priorBy = null; }
        }
        var benchMsgs = bench ? ((isNum(bench.texts) ? bench.texts : 0) + (isNum(bench.emails) ? bench.emails : 0)) : null;
        var hasGroups = people.some(function (r) { return !!r.group; });

        var salesGoal = c.getSalesGoal(s.id);
        var goalsLine = '<div class="goals-line">' +
          '<span class="gl-t">Goals</span>' +
          '<span class="gl-chip">Calls: ' + (callsGoal !== null ? esc(fmtN(callsGoal)) + "/day" : "store avg") + "</span>" +
          '<span class="gl-chip">Texts+Emails: ' + (msgsGoal !== null ? esc(fmtN(msgsGoal)) + "/day" : "store avg") + "</span>" +
          '<span class="gl-chip">Sales: ' + (salesGoal !== null ? esc(fmtN(salesGoal)) + "/month" : "not set") + "</span>" +
          '<span class="gl-legend"><span class="pill good"><span class="dot"></span>at goal</span>' +
          '<span class="pill warn"><span class="dot"></span>\u2265 ' + esc(warnPctLabel()) + " of goal</span>" +
          '<span class="pill bad"><span class="dot"></span>below</span></span>' +
          '<span class="gl-edit" title="Goals are edited in Settings and are gated behind Manager mode in this browser.">Edit in Settings \u00b7 Manager only</span>' +
          "</div>";

        var header = "<thead><tr>" +
          "<th>Salesperson</th>" +
          '<th class="num" title="Good Leads">Good Leads</th>' +
          '<th class="num" title="Calls Out \u00f7 working days \u00b7 ' + esc(daysNote) + '">Calls/Day</th>' +
          '<th class="num" title="(Texts Out + Emails Out) \u00f7 working days">Texts+Emails/Day</th>' +
          '<th class="num" title="' + esc(matadorNote) + '">Videos Sent</th>' +
          '<th class="num" title="Appts Scheduled">Appts Set</th>' +
          '<th class="num" title="Appts Shown \u00f7 Appts Scheduled">Appts Shown %</th>' +
          '<th class="num" title="Sold in Time Frame \u00b7 \u00b1 vs Prev MTD where a prior report exists">Sold</th>' +
          "</tr></thead>";

        function repRow(r) {
          var shown = isNum(r.shownPct) ? r.shownPct : c.rate(r.apptsShown, r.apptsScheduled);
          var m = msgsOf(r);
          return '<tr><td class="name">' + esc(r.name) + "</td>" +
            td(num(r.goodLeads, "Not reported")) +
            dayCell(r.calls, exactNote(r.calls), bench && isNum(bench.calls) ? bench.calls : null, callsGoal, "Calls") +
            dayCell(m.v, m.note, benchMsgs, msgsGoal, "Texts+Emails") +
            videosCell(r) +
            td(num(r.apptsScheduled, "Not reported")) +
            td(pct(shown, "No appointments scheduled in this range"), colorFor(shown, shownTarget()),
              shownTarget() !== null ? "Goal " + fmtPct(shownTarget(), 0) : "No shown-% goal set") +
            soldCell(r, priorBy) +
            "</tr>";
        }

        var body;
        if (hasGroups && groupMode) {
          var byTeam = {};
          people.forEach(function (r) { (byTeam[r.group || "Ungrouped"] = byTeam[r.group || "Ungrouped"] || []).push(r); });
          var teams = Object.keys(byTeam).sort(function (a, b) {
            return (c.sumReps(byTeam[b]).sold || 0) - (c.sumReps(byTeam[a]).sold || 0);
          });
          body = teams.map(function (g) {
            var members = byTeam[g];
            var sub = c.sumReps(members);
            var subShown = c.rate(sub.apptsShown, sub.apptsScheduled);
            var subMsgs = msgsOf(sub);
            return '<tr class="group-row"><td colspan="8">' + esc(g) +
              ' <span class="section-sub">' + members.length + (members.length === 1 ? " rep" : " reps") + "</span></td></tr>" +
              members.map(repRow).join("") +
              '<tr class="team-sub"><td class="name">' + esc(g) + " total</td>" +
              td(num(sub.goodLeads, "Not reported")) +
              dayCell(sub.calls, exactNote(sub.calls), null, null, "Calls") +
              dayCell(subMsgs.v, subMsgs.note, null, null, "Texts+Emails") +
              td("") +
              td(num(sub.apptsScheduled, "Not reported")) +
              td(pct(subShown, "No appointments")) +
              td(num(sub.sold, "Not reported")) +
              "</tr>";
          }).join("");
        } else {
          body = people.map(repRow).join("");
        }

        var foot = "";
        if (totals) {
          var tShown = isNum(totals.shownPct) ? totals.shownPct : c.rate(totals.apptsShown, totals.apptsScheduled);
          var tMsgs = msgsOf(totals);
          foot = '<tfoot><tr class="total-row"><td class="name">STORE TOTAL</td>' +
            td(num(totals.goodLeads, "Not reported")) +
            dayCell(totals.calls, exactNote(totals.calls), null, null, "Calls") +
            dayCell(tMsgs.v, tMsgs.note, null, null, "Texts+Emails") +
            td("") +
            td(num(totals.apptsScheduled, "Not reported")) +
            td(pct(tShown, "No appointments scheduled in this range")) +
            td(num(totals.sold, "Not reported")) +
            "</tr></tfoot>";
        }

        var groupBtn = hasGroups
          ? '<button type="button" class="ghost-btn act-group-btn' + (groupMode ? " on" : "") + '"' +
            ' aria-pressed="' + (groupMode ? "true" : "false") + '" onclick="Pages.toggleActivityGroups()">Group by team</button>'
          : "";

        return '<section class="panel act-panel"><h2 class="section-title">' + esc(s.name) +
          '<span class="section-sub">' + esc(String(people.length) + (people.length === 1 ? " rep" : " reps") +
          " \u00b7 " + (days === null ? "?" : days) + " working days") + "</span>" + groupBtn + "</h2>" +
          goalsLine +
          tableWrap(header + "<tbody>" + body + "</tbody>" + foot, "activity-tbl") +
          "</section>";
      }).join("");

      if (!list.length) {
        sections = emptyState("No stores loaded", "assets/data.js contains no stores.");
      }

      var tools = '<div class="act-tools">' +
        '<button type="button" class="ghost-btn" onclick="Pages.exportActivity(' +
        (scoped ? "'" + esc(storeId) + "'" : "null") + ')">Download CSV</button>' +
        '<button type="button" class="ghost-btn" title="Use your browser\u2019s Save as PDF \u2014 the metric colours are kept" onclick="window.print()">Print / Save PDF</button>' +
        "</div>";

      return '<section class="page" id="page-activity">' + head + (scoped ? "" : coverageBanner(range)) +
        tools + sections + "</section>";
    });
  }

  function warnPctLabel() {
    var w = (C().settings || {}).warnRatio;
    if (!isNum(w)) w = 0.85;
    if (w > 1) w = w / 100;
    return Math.round(w * 100) + "%";
  }

  var ACT_GROUP_KEY = "icdash.activityGroups";
  function activityGroupMode() {
    try { return global.localStorage.getItem(ACT_GROUP_KEY) === "1"; } catch (e) { return false; }
  }
  function toggleActivityGroups() {
    try {
      global.localStorage.setItem(ACT_GROUP_KEY, activityGroupMode() ? "0" : "1");
    } catch (e) { /* private mode */ }
    if (global.App && global.App.render) global.App.render();
  }

  /* CSV of the activity table for the current timeframe — totals AND per-day
     averages, so the spreadsheet matches what the page shows. */
  function exportActivity(storeId) {
    var c = C();
    var tf = (c.settings && c.settings.timeframe) || { id: "month" };
    var range = c.resolveRange(tf.id, tf.start, tf.end);
    var sat = (c.settings || {}).includeSaturday !== false;
    var days = null;
    try { days = c.networkDays(range.start, range.end, sat); } catch (e) { days = null; }
    var stores = storeId ? scopedStores(storeId) : STORES();
    var rows = [["Store", "Salesperson", "Team", "Good Leads",
      "Calls", "Calls/Day", "Emails", "Emails/Day", "Texts", "Texts/Day",
      "Appts Set", "Appts Shown %", "Sold"]];
    stores.forEach(function (s) {
      var reps = [];
      try { reps = c.reps(s.id, range) || []; } catch (e) { reps = []; }
      reps.filter(function (r) { return !isTotalRow(r); }).forEach(function (r) {
        var shown = isNum(r.shownPct) ? r.shownPct : c.rate(r.apptsShown, r.apptsScheduled);
        rows.push([s.name, r.name, r.group || "",
          isNum(r.goodLeads) ? r.goodLeads : "",
          isNum(r.calls) ? r.calls : "", fmtN(c.rate(r.calls, days)) || "",
          isNum(r.emails) ? r.emails : "", fmtN(c.rate(r.emails, days)) || "",
          isNum(r.texts) ? r.texts : "", fmtN(c.rate(r.texts, days)) || "",
          isNum(r.apptsScheduled) ? r.apptsScheduled : "",
          fmtPct(shown) || "", isNum(r.sold) ? r.sold : ""]);
      });
    });
    var csv = rows.map(function (r) {
      return r.map(function (v) {
        v = String(v == null ? "" : v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(",");
    }).join("\n");
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "salesperson-activity-" + (range.start || "") + "-to-" + (range.end || "") + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  /* ================================================= 5. INTERNET PERFORMANCE */

  /* Column order dictated by the client:
     Good leads · Engagement % · Appts set % · Appts shown % · Calls · Texts ·
     Emails · Internet sold · Internet closing % */
  /* Store-level internet funnel. Each store row expands into its New/Used
     (inventory) breakdown, internet-scoped, via the same expander machinery as
     the store performance table. Emails were dropped at the client's request;
     Texts stays, Videos come from the Matador join. */
  function internet(range, storeId) {
    return guard(function () {
      var c = C();
      var list = scopedStores(storeId);
      var scoped = !!storeId;
      var head = scoped ? "" : pageHead("Internet Performance", rangeLabel(range));

      if (!list.length) {
        return '<section class="page" id="page-internet">' + head + (scoped ? "" : coverageBanner(range)) +
          emptyState("No stores loaded", "assets/data.js contains no stores.") + "</section>";
      }

      var outboundNote = "Outbound counts come from the rep-level report and cover all lead types, not internet only.";
      var matadorNote = "From the Matador Users export (a snapshot) \u2014 NOT filtered by the selected dates.";
      var UNKNOWN = /^unknown/i;

      var header = "<thead><tr>" +
        "<th>Store</th>" +
        '<th class="num" title="Good Leads where Lead Type = Internet">Good Leads</th>' +
        '<th class="num" title="Internet Actual Contact % \u00b7 Goal ' + esc(fmtPct(engagementTarget(), 0)) + '">Engagement %</th>' +
        '<th class="num" title="Appts set \u00b7 Goal ' + esc(fmtPct(apptTarget(), 0)) + ' \u00b7 can exceed 100%">Appts Set %</th>' +
        '<th class="num" title="Appts Shown \u00f7 appts set">Appts Shown %</th>' +
        '<th class="num" title="Calls Out \u00b7 ' + esc(outboundNote) + '">Calls</th>' +
        '<th class="num" title="Texts Out \u00b7 ' + esc(outboundNote) + '">Texts</th>' +
        '<th class="num" title="' + esc(matadorNote) + '">Videos Sent</th>' +
        '<th class="num" title="Internet Sold in Time Frame">Internet Sold</th>' +
        '<th class="num" title="Internet sold \u00f7 internet good leads">Internet Closing %</th>' +
        "</tr></thead>";

      var cr = compareRange(range);
      var rows = list.map(function (s) {
        var href = "#/store/" + encodeURIComponent(s.id);
        var nameLink = '<a href="' + esc(href) + '">' + esc(s.name) + "</a>";

        var sm = storeMetrics(s.id, range);
        var net = sm.internet;
        var noNet = "No internet lead rows for " + rangeLabel(range);
        if (!net || !hasData(sm)) {
          return "";
        }
        var priorSm = cr ? storeMetrics(s.id, cr) : null;
        var pNet = priorSm && hasData(priorSm) ? priorSm.internet : null;
        var netCmp = null;
        if (pNet) { try { netCmp = c.compare(net, pNet); } catch (e) { netCmp = null; } }

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
        var videos = storeVideos(s.id);

        var pApSet = pNet ? (isNum(pNet.apptSetPct) ? pNet.apptSetPct : pNet.apptSetOfContactedPct) : null;
        var pShown = pNet ? c.rate(pNet.apptsShown, pNet.apptsSet) : null;
        var pClosing = pNet ? c.rate(pNet.sold, pNet.goodLeads) : null;

        // inventory children (New / Used / Certified), Unknown hidden as elsewhere
        var invs = [];
        var ltList = sm.byLeadType || [];
        for (var li = 0; li < ltList.length; li++) {
          if (ltList[li].key === "internet") {
            invs = (ltList[li].byInventory || []).filter(function (inv) { return !UNKNOWN.test(inv.inventoryType || ""); });
          }
        }
        var path = "st:" + s.id;
        var nameCell = '<td class="name">' +
          (invs.length
            ? '<button type="button" class="expander" aria-expanded="false" onclick="Pages.toggleRows(this)"' +
              ' title="Break down by inventory type (New / Used)"><span class="chev" aria-hidden="true"></span></button> '
            : "") + nameLink + "</td>";

        var out = '<tr data-path="' + esc(path) + '">' + nameCell +
          td(num(net.goodLeads, noNet) + (netCmp ? " " + deltaChip(netCmp, "goodLeads", "Prev MTD") : "")) +
          td(pct(net.contactPct, "Internet Actual Contact % not reported") + ppChip(net.contactPct, pNet && pNet.contactPct),
            colorFor(net.contactPct, engagementTarget()), "Goal " + fmtPct(engagementTarget(), 0)) +
          td(pct(apSet, "Appts set % not reported") + ppChip(apSet, pApSet),
            colorFor(apSet, apptTarget()), apSetTitle + " \u00b7 Goal " + fmtPct(apptTarget(), 0)) +
          td(pct(shownPct, "Needs appts set and appts shown") + ppChip(shownPct, pShown),
            colorFor(shownPct, shownTarget()), shownTarget() !== null ? "Goal " + fmtPct(shownTarget(), 0) : "No shown-% goal set") +
          td(totals ? num(totals.calls, outReason) : na(outReason), "", outboundNote) +
          td(totals && isNum(totals.texts) ? num(totals.texts, "") : na("Texts Out not in this store's export"), "", outboundNote) +
          td(videos === null ? na("No Matador data for this store \u2014 Covideo not connected yet") : num(videos, ""), "", matadorNote) +
          td(num(net.sold, noNet) + (netCmp ? " " + deltaChip(netCmp, "sold", "Prev MTD") : "")) +
          td(pct(closing, "Needs internet good leads and internet sold") + ppChip(closing, pClosing),
            colorFor(closing, closingTarget()), closingTarget() !== null ? "Goal " + fmtPct(closingTarget(), 0) : "No closing goal set") +
          "</tr>";

        out += invs.map(function (inv) {
          var m = inv.metrics;
          var iShown = c.rate(m.apptsShown, m.apptsSet);
          var iClosing = c.rate(m.sold, m.goodLeads);
          return '<tr class="inv-row" data-path="' + esc(path + "/inv:" + inv.key) + '" data-parent="' + esc(path) + '" hidden>' +
            '<td class="name depth-1">' + esc(inv.inventoryType) + "</td>" +
            td(num(m.goodLeads, "Not reported")) +
            td(pct(m.contactPct, "Not reported")) +
            td(pct(m.apptSetOfContactedPct, "Not reported")) +
            td(pct(iShown, "Needs appts set and shown")) +
            td("") + td("") + td("") +
            td(num(m.sold, "Not reported")) +
            td(pct(iClosing, "Needs leads and sold")) +
            "</tr>";
        }).join("");
        return out;
      }).join("");

      return '<section class="page" id="page-internet">' + head + (scoped ? "" : coverageBanner(range)) +
        tableWrap(header + "<tbody>" + rows + "</tbody>", "internet-tbl") +
        "</section>";
    });
  }

  /* Store-level Matador videos: sum of the per-user snapshot rows. */
  function storeVideos(storeId) {
    var rows = [];
    try { rows = C().matador() || []; } catch (e) { rows = []; }
    var sum = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].storeId === storeId && isNum(rows[i].videosSent)) {
        sum = (sum === null ? 0 : sum) + rows[i].videosSent;
      }
    }
    return sum;
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

  /* ---------------------------------------------------- performance over time */

  var TREND_KEY = "icdash.trend";
  function trendState() {
    try {
      var raw = global.localStorage.getItem(TREND_KEY);
      var st = raw ? JSON.parse(raw) : {};
      return { metric: st.metric || "internetLeads", gran: st.gran === "day" ? "day" : "week", hidden: st.hidden || {} };
    } catch (e) { return { metric: "internetLeads", gran: "week", hidden: {} }; }
  }
  function saveTrendState(st) {
    try { global.localStorage.setItem(TREND_KEY, JSON.stringify(st)); } catch (e) { /* private mode */ }
    if (global.App && global.App.render) global.App.render();
  }
  function setTrendMetric(v) { var st = trendState(); st.metric = v; saveTrendState(st); }
  function setTrendGran(v) { var st = trendState(); st.gran = v; saveTrendState(st); }
  function toggleTrendStore(id) {
    var st = trendState();
    if (st.hidden[id]) delete st.hidden[id]; else st.hidden[id] = 1;
    saveTrendState(st);
  }

  var TREND_METRICS = [
    { key: "internetLeads", label: "Good Internet Leads", pct: false },
    { key: "sold", label: "Total Sold", pct: false },
    { key: "internetSold", label: "Internet Sold", pct: false },
    { key: "engagementPct", label: "Engagement %", pct: true },
    { key: "apptSetPct", label: "Appts Set %", pct: true },
    { key: "closingPct", label: "Internet Closing %", pct: true }
  ];
  function trendMetric(key) {
    for (var i = 0; i < TREND_METRICS.length; i++) if (TREND_METRICS[i].key === key) return TREND_METRICS[i];
    return TREND_METRICS[0];
  }

  /* Validated categorical palette (dataviz reference instance): 8 slots, both
     themes, fixed order — assigned to stores alphabetically so a filter never
     repaints the survivors. Stores past slot 8 draw in gray (solid, then dashed). */
  var TREND_SLOTS = 8;
  function trendStores() {
    var c = C();
    var out = [];
    var all = STORES().slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    for (var i = 0; i < all.length; i++) {
      var series = [];
      try { series = c.trendSeries(all[i].id, "week"); } catch (e) { series = []; }
      if (series.length) out.push(all[i]);
    }
    return out;
  }
  function trendColor(idx) {
    if (idx < TREND_SLOTS) return { css: "var(--viz" + (idx + 1) + ")", dash: "" };
    return { css: "var(--faint)", dash: (idx - TREND_SLOTS) % 2 === 0 ? "" : "6 4" };
  }

  function lineChart(seriesArr, opts) {
    opts = opts || {};
    var W = 960, H = 340, L = 52, R = opts.direct ? 130 : 20, T = 16, B = 36;
    var dates = {};
    seriesArr.forEach(function (sr) { sr.points.forEach(function (pt) { dates[pt.d] = 1; }); });
    var xs = Object.keys(dates).sort();
    if (!xs.length) return emptyState("No trend data", "No single-day report deltas exist for this selection yet.");
    var xi = {}; xs.forEach(function (d, i) { xi[d] = i; });
    var maxV = 0;
    seriesArr.forEach(function (sr) { sr.points.forEach(function (pt) { if (isNum(pt.v) && pt.v > maxV) maxV = pt.v; }); });
    if (maxV <= 0) maxV = 1;
    maxV = maxV * 1.06;
    var IW = W - L - R, IH = H - T - B;
    function X(d) { return L + (xs.length === 1 ? IW / 2 : xi[d] * (IW / (xs.length - 1))); }
    function Y(v) { return T + IH - (v / maxV) * IH; }
    function fmtV(v) { return opts.pct ? fmtPct(v, 0) : fmtN(v); }
    function fmtD(d) { return (C().formatDate ? C().formatDate(d) : d).replace(/, \d{4}$/, ""); }

    var grid = "";
    for (var g = 0; g <= 4; g++) {
      var gv = maxV * g / 4, gy = Y(gv);
      grid += '<line x1="' + L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + gy.toFixed(1) +
        '" stroke="var(--line-soft)" stroke-width="1"/>' +
        '<text x="' + (L - 8) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="var(--faint)">' +
        esc(fmtV(gv) || "0") + "</text>";
    }
    var step = Math.max(1, Math.ceil(xs.length / 8));
    var ticks = "";
    for (var t2 = 0; t2 < xs.length; t2 += step) {
      ticks += '<text x="' + X(xs[t2]).toFixed(1) + '" y="' + (H - 12) + '" text-anchor="middle" font-size="11" fill="var(--faint)">' +
        esc(fmtD(xs[t2])) + "</text>";
    }

    var lines = "", labels = "";
    var visible = seriesArr.length;
    seriesArr.forEach(function (sr) {
      var dcmd = "", last = null;
      sr.points.forEach(function (pt) {
        if (!isNum(pt.v)) { last = null; return; }
        dcmd += (last === null ? "M" : "L") + X(pt.d).toFixed(1) + " " + Y(pt.v).toFixed(1) + " ";
        last = pt;
      });
      if (!dcmd) return;
      lines += '<path d="' + dcmd + '" fill="none" stroke="' + sr.color + '" stroke-width="2"' +
        (sr.dash ? ' stroke-dasharray="' + sr.dash + '"' : "") + ' stroke-linejoin="round" stroke-linecap="round"/>';
      sr.points.forEach(function (pt) {
        if (!isNum(pt.v)) return;
        lines += '<circle cx="' + X(pt.d).toFixed(1) + '" cy="' + Y(pt.v).toFixed(1) + '" r="3" fill="' + sr.color + '"/>' +
          '<circle cx="' + X(pt.d).toFixed(1) + '" cy="' + Y(pt.v).toFixed(1) + '" r="10" fill="transparent">' +
          "<title>" + esc(sr.name + " \u2014 " + fmtD(pt.d) + ": " + (fmtV(pt.v) || "")) +
          (isNum(pt.exact) && Math.round(pt.exact) !== pt.exact ? esc(" (exact " + pt.exact + ")") : "") + "</title></circle>";
      });
      if (opts.direct && visible <= 4 && last) {
        labels += '<text x="' + (X(last.d) + 8).toFixed(1) + '" y="' + (Y(last.v) + 4).toFixed(1) +
          '" font-size="12" font-weight="600" fill="var(--ink)">' + esc(sr.name) + "</text>";
      }
    });

    return '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(opts.label || "Trend chart") +
      '" style="width:100%;height:auto;display:block">' +
      '<line x1="' + L + '" y1="' + (T + IH) + '" x2="' + (W - R) + '" y2="' + (T + IH) + '" stroke="var(--line)" stroke-width="1"/>' +
      grid + ticks + lines + labels + "</svg>";
  }

  function trendControls(st, opts) {
    var sel = '<select onchange="Pages.setTrendMetric(this.value)" aria-label="Metric">' +
      TREND_METRICS.map(function (m) {
        return '<option value="' + m.key + '"' + (st.metric === m.key ? " selected" : "") + ">" + esc(m.label) + "</option>";
      }).join("") + "</select>";
    var gran = '<span class="view-toggle" role="group" aria-label="Granularity">' +
      '<button type="button" class="vt-btn' + (st.gran === "day" ? " on" : "") + '" onclick="Pages.setTrendGran(\'day\')">Daily</button>' +
      '<button type="button" class="vt-btn' + (st.gran === "week" ? " on" : "") + '" onclick="Pages.setTrendGran(\'week\')">Weekly</button>' +
      "</span>";
    var chips = "";
    if (opts && opts.stores) {
      chips = '<div class="trend-legend">' + opts.stores.map(function (entry) {
        var off = !!st.hidden[entry.store.id];
        return '<button type="button" class="tl-chip' + (off ? " off" : "") + '" aria-pressed="' + (!off) +
          '" onclick="Pages.toggleTrendStore(\'' + esc(entry.store.id) + '\')">' +
          '<span class="tl-dot" style="background:' + entry.color.css + '"></span>' + esc(entry.store.name) + "</button>";
      }).join("") + "</div>";
    }
    return '<div class="cards-toolbar trend-tools">' + sel + gran + "</div>" + chips;
  }

  /* Global trends: every store's history on one chart. */
  function trendsPage(range) {
    return guard(function () {
      var c = C();
      var st = trendState();
      var metric = trendMetric(st.metric);
      var stores = trendStores();
      var entries = stores.map(function (s2, i) { return { store: s2, color: trendColor(i) }; });
      var seriesArr = [];
      entries.forEach(function (entry) {
        if (st.hidden[entry.store.id]) return;
        var pts = c.trendSeries(entry.store.id, st.gran).map(function (row) {
          return { d: row.date, v: row[metric.key], exact: row[metric.key] };
        });
        seriesArr.push({ id: entry.store.id, name: entry.store.name, color: entry.color.css, dash: entry.color.dash, points: pts });
      });
      var head = pageHead("Trends", "Performance over time \u00b7 full loaded history, independent of the timeframe picker");
      return '<section class="page" id="page-trends">' + head +
        trendControls(st, { stores: entries }) +
        '<div class="fig-card panel">' +
        lineChart(seriesArr, { pct: metric.pct, direct: true, label: metric.label + " over time by store" }) +
        "</div>" +
        '<p class="roster-note">A store\u2019s line starts on its first daily report. The one-block catch-up report a store sends when it joins mid-month is excluded \u2014 it cannot be placed on a single ' +
        (st.gran === "week" ? "week" : "day") + ".</p>" +
        "</section>";
    });
  }

  /* Single-store trend section for the store performance page. */
  function storeTrendSection(storeId, storeName) {
    var c = C();
    var st = trendState();
    var metric = trendMetric(st.metric);
    var pts = [];
    try {
      pts = c.trendSeries(storeId, st.gran).map(function (row) {
        return { d: row.date, v: row[metric.key], exact: row[metric.key] };
      });
    } catch (e) { pts = []; }
    if (!pts.length) return "";
    return '<h2 class="section-title">Performance Over Time <span class="section-sub">full loaded history</span></h2>' +
      trendControls(st, null) +
      '<div class="fig-card panel">' +
      lineChart([{ id: storeId, name: storeName, color: "var(--viz1)", dash: "", points: pts }],
        { pct: metric.pct, direct: false, label: metric.label + " over time for " + storeName }) +
      "</div>";
  }

  /* Expand/collapse for the drill-down rows in the lead-type table. Expanding
     reveals direct children only; collapsing hides every descendant and resets
     their expanders, so re-opening a lead type never dumps the whole make list. */
  function toggleRows(btn) {
    var tr = btn.closest ? btn.closest("tr") : null;
    if (!tr) return;
    var table = tr.closest("table");
    var path = tr.getAttribute("data-path");
    if (!table || !path) return;
    var expanded = btn.getAttribute("aria-expanded") === "true";
    var rows = table.querySelectorAll("tr[data-parent]");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (expanded) {
        // collapse: hide the whole subtree beneath this row
        var p = row.getAttribute("data-path") || "";
        if (p.indexOf(path + "/") === 0) {
          row.hidden = true;
          var b = row.querySelector(".expander");
          if (b) b.setAttribute("aria-expanded", "false");
        }
      } else if (row.getAttribute("data-parent") === path) {
        row.hidden = false;
      }
    }
    btn.setAttribute("aria-expanded", expanded ? "false" : "true");
  }

  /* ----------------------------------------------------------------- export */

  global.Pages = {
    toggleRows: toggleRows,
    trends: trendsPage,
    setTrendMetric: setTrendMetric,
    setTrendGran: setTrendGran,
    toggleTrendStore: toggleTrendStore,
    toggleActivityGroups: toggleActivityGroups,
    exportActivity: exportActivity,
    group: groupPage,
    monogramFor: monogramFor,
    setStoreView: setStoreView,
    filterStores: filterStores,
    overview: overview,
    stores: storesPage,
    storeDetail: storeDetail,
    storeActivity: storeActivity,
    storeInternet: storeInternet,
    activity: activity,
    internet: internet,
    sources: sources
  };
})(window);
