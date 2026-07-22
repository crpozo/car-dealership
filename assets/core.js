/* assets/core.js — The Internet Coaches Dashboard
 * Pure logic. No DOM, no dependencies. Exposes window.Core.
 *
 * Responsibilities
 *   - index the generated window.DASH_DATA snapshots
 *   - difference cumulative month-to-date snapshots into per-day deltas
 *   - resolve timeframe presets / custom ranges + their comparison ranges
 *   - aggregate ONLY counts, then re-derive every percentage from those counts
 *
 * Hard rules (see SPEC):
 *   - never sum a percentage
 *   - rate() returns null (never 0 / NaN / Infinity) when the denominator is 0
 *   - missing data is missing: hasData:false and null rates, never fabricated zeros
 */
(function (global) {
  'use strict';

  var VERSION = '2.0.0';

  /* ------------------------------------------------------------------ *
   * constants
   * ------------------------------------------------------------------ */

  var STORAGE_KEY = 'ticDashboard.settings.v1';

  var DEFAULT_SETTINGS = {
    salesGoals: {},          // { storeId: units|null }  — null by default, never invented
    includeSaturday: true,   // dealerships work Saturdays
    engagementTarget: 0.80,  // Internet Actual Contact %
    apptTarget: 0.40,        // Appts set of contacted %
    weekStartsOn: 0,         // 0 = Sunday (US retail week)
    anchorMode: 'data',      // 'data' = anchor presets to the newest snapshot; 'clock' = wall clock
    timeframe: { id: 'month', start: null, end: null }
  };

  // The three lead types that get displayed. Referral / PreviousCustomer are hidden
  // as rows but their Good Leads and Sold still land in the store TOTAL.
  var DISPLAY_LEAD_TYPES = ['Internet', 'Phone', 'Walk-in'];
  var HIDDEN_LEAD_TYPES = ['Referral', 'PreviousCustomer'];

  var KPI_COUNT_KEYS = ['goodLeads', 'sold', 'apptsShown', 'contacted', 'apptsSet'];
  var REP_COUNT_KEYS = ['goodLeads', 'sold', 'apptsScheduled', 'apptsShown', 'calls', 'emails', 'texts'];

  var SEP = '\u0001';
  var P_TOTAL = 'T';
  var P_REPTOTAL = 'RT';

  var DAY_MS = 86400000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH_NUM = {};
  (function () {
    for (var i = 0; i < MONTHS.length; i++) MONTH_NUM[MONTHS[i].toLowerCase()] = i;
    var full = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
                'august', 'september', 'october', 'november', 'december'];
    for (var j = 0; j < full.length; j++) MONTH_NUM[full[j]] = j;
  }());

  /* ------------------------------------------------------------------ *
   * numbers
   * ------------------------------------------------------------------ */

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
      var s = v.replace(/[,%\s$]/g, '');
      if (s === '') return null;
      var p = Number(s);
      return isFinite(p) ? p : null;
    }
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function cnt(v) {
    var n = numOrNull(v);
    return n === null ? 0 : n;
  }

  /** null-safe ratio. Returns null when the denominator is 0/absent — never 0, NaN or Infinity. */
  function rate(numerator, denominator) {
    var n = numOrNull(numerator);
    var d = numOrNull(denominator);
    if (n === null || d === null) return null;
    if (d === 0) return null;
    var r = n / d;
    return isFinite(r) ? r : null;
  }

  function round(v) {
    return Math.round(v);
  }

  /* ------------------------------------------------------------------ *
   * dates — everything is an ISO "YYYY-MM-DD" string, arithmetic in UTC
   * ------------------------------------------------------------------ */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function mkDate(y, m, d) { return new Date(Date.UTC(y, m, d)); }

  /**
   * Accepts "YYYY-MM-DD", "YYYY-MM-DDTHH:mm:ss", "Jul  2 2026  8:10AM" (VinSolutions),
   * "7/2/2026" and Date objects. Returns a UTC-midnight Date, or null.
   */
  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      return mkDate(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
    }
    if (typeof v === 'number' && isFinite(v)) {
      var dn = new Date(v);
      return isNaN(dn.getTime()) ? null : mkDate(dn.getUTCFullYear(), dn.getUTCMonth(), dn.getUTCDate());
    }
    var s = String(v).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return mkDate(+m[1], +m[2] - 1, +m[3]);
    // "Jul  2 2026  8:10AM" / "July 2, 2026"
    m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
    if (m) {
      var mi = MONTH_NUM[m[1].toLowerCase()];
      if (mi !== undefined) return mkDate(+m[3], mi, +m[2]);
    }
    // "2 Jul 2026"
    m = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/.exec(s);
    if (m) {
      var mi2 = MONTH_NUM[m[2].toLowerCase()];
      if (mi2 !== undefined) return mkDate(+m[3], mi2, +m[1]);
    }
    // "7/2/2026"
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return mkDate(+m[3], +m[1] - 1, +m[2]);
    return null;
  }

  function iso(v) {
    var d = v instanceof Date ? v : parseDate(v);
    if (!d) return null;
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function dayNum(v) {
    var d = v instanceof Date ? v : parseDate(v);
    return d ? Math.round(d.getTime() / DAY_MS) : null;
  }

  function fromDayNum(n) { return new Date(n * DAY_MS); }

  function addDays(v, n) {
    var d = dayNum(v);
    return d === null ? null : iso(fromDayNum(d + n));
  }

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

  function monthStart(v) {
    var d = parseDate(v);
    return d ? iso(mkDate(d.getUTCFullYear(), d.getUTCMonth(), 1)) : null;
  }

  function monthEnd(v) {
    var d = parseDate(v);
    if (!d) return null;
    return iso(mkDate(d.getUTCFullYear(), d.getUTCMonth(), daysInMonth(d.getUTCFullYear(), d.getUTCMonth())));
  }

  function monthKey(v) {
    var d = parseDate(v);
    return d ? d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) : null;
  }

  /** Shift by whole months, clamping the day-of-month (Mar 31 → Feb 28/29). */
  function addMonths(v, n) {
    var d = parseDate(v);
    if (!d) return null;
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth() + n;
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    var day = Math.min(d.getUTCDate(), daysInMonth(y, m));
    return iso(mkDate(y, m, day));
  }

  function isLastDayOfMonth(v) {
    var d = parseDate(v);
    if (!d) return false;
    return d.getUTCDate() === daysInMonth(d.getUTCFullYear(), d.getUTCMonth());
  }

  function minIso(a, b) {
    if (!a) return b; if (!b) return a;
    return dayNum(a) <= dayNum(b) ? a : b;
  }

  function maxIso(a, b) {
    if (!a) return b; if (!b) return a;
    return dayNum(a) >= dayNum(b) ? a : b;
  }

  function inRange(d, start, end) {
    var n = dayNum(d);
    if (n === null) return false;
    return n >= dayNum(start) && n <= dayNum(end);
  }

  /** Excel NETWORKDAYS: whole working days between start and end, both inclusive.
   *  Mon–Fri by default; Mon–Sat when includeSaturday is true. No holiday calendar.
   *  Returns a negative count when end < start, like Excel. */
  function networkDays(start, end, includeSaturday) {
    var a = dayNum(start), b = dayNum(end);
    if (a === null || b === null) return null;
    var sign = 1;
    if (b < a) { var t = a; a = b; b = t; sign = -1; }
    var lastWorkDow = includeSaturday ? 6 : 5;   // 1=Mon … 6=Sat, 7=Sun
    var total = b - a + 1;
    var weeks = Math.floor(total / 7);
    var count = weeks * lastWorkDow;
    var rem = total - weeks * 7;
    // day-of-week of `a` in 1..7 (Mon=1). Epoch day 0 = 1970-01-01 = Thursday.
    var dow = ((a + 3) % 7 + 7) % 7 + 1;
    for (var i = 0; i < rem; i++) {
      var d = ((dow - 1 + i) % 7) + 1;
      if (d <= lastWorkDow) count++;
    }
    return sign * count;
  }

  function formatDate(v, opts) {
    var d = parseDate(v);
    if (!d) return '—';
    var withYear = !opts || opts.year !== false;
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + (withYear ? ', ' + d.getUTCFullYear() : '');
  }

  function formatRange(start, end) {
    var a = parseDate(start), b = parseDate(end);
    if (!a || !b) return '—';
    if (dayNum(a) === dayNum(b)) return formatDate(a);
    if (a.getUTCFullYear() === b.getUTCFullYear()) {
      if (a.getUTCMonth() === b.getUTCMonth()) {
        return MONTHS[a.getUTCMonth()] + ' ' + a.getUTCDate() + '–' + b.getUTCDate() + ', ' + b.getUTCFullYear();
      }
      return formatDate(a, { year: false }) + ' – ' + formatDate(b);
    }
    return formatDate(a) + ' – ' + formatDate(b);
  }

  /* ------------------------------------------------------------------ *
   * settings (localStorage backed)
   * ------------------------------------------------------------------ */

  function cloneDefaults() {
    return {
      salesGoals: {},
      includeSaturday: DEFAULT_SETTINGS.includeSaturday,
      engagementTarget: DEFAULT_SETTINGS.engagementTarget,
      apptTarget: DEFAULT_SETTINGS.apptTarget,
      weekStartsOn: DEFAULT_SETTINGS.weekStartsOn,
      anchorMode: DEFAULT_SETTINGS.anchorMode,
      timeframe: { id: 'month', start: null, end: null }
    };
  }

  function storage() {
    try {
      var ls = global.localStorage;
      if (!ls) return null;
      return ls;
    } catch (e) { return null; }
  }

  function loadSettings() {
    var s = cloneDefaults();
    var ls = storage();
    if (!ls) return s;
    try {
      var raw = ls.getItem(STORAGE_KEY);
      if (!raw) return s;
      var saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        if (saved.salesGoals && typeof saved.salesGoals === 'object') {
          for (var k in saved.salesGoals) {
            if (!Object.prototype.hasOwnProperty.call(saved.salesGoals, k)) continue;
            var g = numOrNull(saved.salesGoals[k]);
            s.salesGoals[k] = (g === null || g <= 0) ? null : g;
          }
        }
        if (typeof saved.includeSaturday === 'boolean') s.includeSaturday = saved.includeSaturday;
        if (numOrNull(saved.engagementTarget) !== null) s.engagementTarget = numOrNull(saved.engagementTarget);
        if (numOrNull(saved.apptTarget) !== null) s.apptTarget = numOrNull(saved.apptTarget);
        if (saved.weekStartsOn === 0 || saved.weekStartsOn === 1) s.weekStartsOn = saved.weekStartsOn;
        if (saved.anchorMode === 'data' || saved.anchorMode === 'clock') s.anchorMode = saved.anchorMode;
        if (saved.timeframe && typeof saved.timeframe === 'object') {
          s.timeframe = {
            id: saved.timeframe.id || 'month',
            start: iso(saved.timeframe.start) || null,
            end: iso(saved.timeframe.end) || null
          };
        }
      }
    } catch (e) { /* corrupt storage → defaults */ }
    return s;
  }

  var settings = loadSettings();

  function saveSettings() {
    var ls = storage();
    if (!ls) return false;
    try { ls.setItem(STORAGE_KEY, JSON.stringify(settings)); return true; }
    catch (e) { return false; }
  }

  function setSetting(key, value) {
    settings[key] = value;
    saveSettings();
    return settings[key];
  }

  /** null / 0 / blank all mean "no goal set" — a null goal must never render red. */
  function setSalesGoal(storeId, goal) {
    var g = numOrNull(goal);
    settings.salesGoals[storeId] = (g === null || g <= 0) ? null : g;
    saveSettings();
    return settings.salesGoals[storeId];
  }

  function getSalesGoal(storeId) {
    var g = settings.salesGoals ? settings.salesGoals[storeId] : null;
    g = numOrNull(g);
    return (g === null || g <= 0) ? null : g;
  }

  function setTimeframe(tfId, start, end) {
    settings.timeframe = { id: tfId || 'month', start: iso(start) || null, end: iso(end) || null };
    saveSettings();
    return settings.timeframe;
  }

  function resetSettings() {
    // mutate in place — Core.settings holds a live reference to this object
    var fresh = cloneDefaults();
    for (var k in settings) {
      if (Object.prototype.hasOwnProperty.call(settings, k)) delete settings[k];
    }
    for (var f in fresh) {
      if (Object.prototype.hasOwnProperty.call(fresh, f)) settings[f] = fresh[f];
    }
    saveSettings();
    return settings;
  }

  /* ------------------------------------------------------------------ *
   * conditional colors
   * ------------------------------------------------------------------ */

  /** green at/above target, amber within 15% below, red further below.
   *  "none" whenever the comparison is not real (missing actual, missing/zero target). */
  function colorFor(actual, target) {
    var a = numOrNull(actual);
    var t = numOrNull(target);
    if (a === null || t === null || t === 0) return 'none';
    var ratio = a / t;
    if (!isFinite(ratio)) return 'none';
    if (ratio >= 1) return 'good';
    if (ratio >= 0.85) return 'warn';
    return 'bad';
  }

  /* ------------------------------------------------------------------ *
   * counts bags & path maps
   *
   * A snapshot is flattened into { path -> countsBag }. Differencing and
   * aggregation are then plain map arithmetic; the tree is rebuilt at query
   * time. Paths:
   *   'T'                                store total
   *   'L\x01internet'                    lead type
   *   'L\x01internet\x01I\x01new'        + inventory type
   *   'L\x01internet\x01I\x01new\x01M\x01honda'  + vehicle make
   *   'R\x01jane doe'                    sales rep
   *   'RT'                               sales rep TOTAL row
   * ------------------------------------------------------------------ */

  function addBags(a, b) {
    var out = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
      out[k] = (out[k] || 0) + (b[k] || 0);
    }
    return out;
  }

  function addInto(target, path, bag) {
    target[path] = target[path] ? addBags(target[path], bag) : addBags({}, bag);
  }

  function mergePathMap(target, src) {
    for (var p in src) {
      if (!Object.prototype.hasOwnProperty.call(src, p)) continue;
      addInto(target, p, src[p]);
    }
    return target;
  }

  function normKey(s) {
    return String(s === null || s === undefined ? '' : s)
      .toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function normLeadType(s) { return normKey(s); }

  function nameTokens(s) {
    return String(s || '').toLowerCase().replace(/[^a-z\s]+/g, ' ')
      .split(/\s+/).filter(function (t) { return t.length > 0; });
  }

  function isDisplayLeadType(leadType) {
    var n = normLeadType(leadType);
    for (var i = 0; i < DISPLAY_LEAD_TYPES.length; i++) {
      if (normLeadType(DISPLAY_LEAD_TYPES[i]) === n) return true;
    }
    return false;
  }

  /** Normalize a report `metrics` object into a pure counts bag.
   *  Derived counts per SPEC:
   *    contacted = round(contactPct * goodLeads)
   *    apptsSet  = round(apptSetPct * goodLeads) when present,
   *                else round(apptSetOfContactedPct * contacted)
   *  (the pipeline should already supply these; we re-derive only when absent). */
  function metricsToBag(m) {
    m = m || {};
    var goodLeads = cnt(m.goodLeads);
    var sold = cnt(m.sold);
    var apptsShown = cnt(m.apptsShown);
    var contactPct = numOrNull(m.contactPct);
    var apptSetPct = numOrNull(m.apptSetPct);
    var apptOfCont = numOrNull(m.apptSetOfContactedPct);

    var contacted = numOrNull(m.contacted);
    if (contacted === null) contacted = contactPct === null ? 0 : round(contactPct * goodLeads);

    var apptsSet = numOrNull(m.apptsSet);
    if (apptsSet === null) {
      if (apptSetPct !== null) apptsSet = round(apptSetPct * goodLeads);
      else if (apptOfCont !== null) apptsSet = round(apptOfCont * contacted);
      else apptsSet = 0;
    }
    return {
      goodLeads: goodLeads,
      sold: sold,
      apptsShown: apptsShown,
      contacted: contacted,
      apptsSet: apptsSet
    };
  }

  function repToBag(r) {
    r = r || {};
    return {
      goodLeads: cnt(r.goodLeads),
      sold: cnt(r.sold),
      apptsScheduled: cnt(r.apptsScheduled),
      apptsShown: cnt(r.apptsShown),
      calls: cnt(r.calls),
      emails: cnt(r.emails),
      texts: cnt(r.texts)
    };
  }

  /* ------------------------------------------------------------------ *
   * public metric objects — counts in, percentages re-derived
   * ------------------------------------------------------------------ */

  function finalizeMetrics(bag, hasData) {
    bag = bag || {};
    var goodLeads = cnt(bag.goodLeads);
    var sold = cnt(bag.sold);
    var apptsShown = cnt(bag.apptsShown);
    var contacted = cnt(bag.contacted);
    var apptsSet = cnt(bag.apptsSet);
    var contactPct = rate(contacted, goodLeads);
    var apptSetOfContactedPct = rate(apptsSet, contacted);
    var apptSetPct = rate(apptsSet, goodLeads);
    var apptShownPct = rate(apptsShown, apptsSet);
    var closingRate = rate(sold, goodLeads);
    return {
      hasData: !!hasData,
      goodLeads: goodLeads,
      sold: sold,
      apptsShown: apptsShown,
      contacted: contacted,
      apptsSet: apptsSet,
      contactPct: contactPct,
      engagementPct: contactPct,          // alias — "Engagement %" in the UI
      apptSetOfContactedPct: apptSetOfContactedPct,
      apptSetPct: apptSetPct,
      apptShownPct: apptShownPct,
      apptsShownPct: apptShownPct,        // alias
      closingRate: closingRate,
      closingPct: closingRate             // alias
    };
  }

  var EMPTY_METRICS = finalizeMetrics({}, false);

  function emptyMetrics() { return finalizeMetrics({}, false); }

  function finalizeRep(name, bag, hasData) {
    bag = bag || {};
    var apptsScheduled = cnt(bag.apptsScheduled);
    var apptsShown = cnt(bag.apptsShown);
    return {
      name: name,
      hasData: !!hasData,
      goodLeads: cnt(bag.goodLeads),
      sold: cnt(bag.sold),
      apptsScheduled: apptsScheduled,
      apptsSet: apptsScheduled,          // alias: the sales report calls it "Appts Scheduled"
      apptsShown: apptsShown,
      shownPct: rate(apptsShown, apptsScheduled),
      calls: cnt(bag.calls),
      emails: cnt(bag.emails),
      texts: cnt(bag.texts),
      // The VinSolutions per-user report has no internet-only split. Real value unknown → null.
      internetGoodLeads: null,
      internetSold: null,
      matador: null
    };
  }

  /* ------------------------------------------------------------------ *
   * state
   * ------------------------------------------------------------------ */

  var state = {
    data: null,
    stores: [],
    storeById: {},
    groups: {},        // "storeId|kind|YYYY-MM" -> group
    groupsByStore: {}, // storeId -> { kpi: [group], sales: [group] }
    labels: {},        // path -> { leadType, inventoryType, make, name }
    anchorOverride: null,
    latestAsOf: null,
    earliestAsOf: null,
    warnings: []
  };

  function flattenSnapshot(snap) {
    var map = {};
    var labels = state.labels;

    if (snap.total) addInto(map, P_TOTAL, metricsToBag(snap.total));

    var lts = snap.byLeadType || [];
    for (var i = 0; i < lts.length; i++) {
      var lt = lts[i] || {};
      var ltName = lt.leadType || lt.name;
      if (!ltName) continue;
      var ltPath = 'L' + SEP + normLeadType(ltName);
      labels[ltPath] = labels[ltPath] || { leadType: String(ltName).trim() };
      addInto(map, ltPath, metricsToBag(lt.metrics || lt));

      var invs = lt.byInventory || [];
      for (var j = 0; j < invs.length; j++) {
        var inv = invs[j] || {};
        var invName = inv.inventoryType || inv.name;
        if (!invName) continue;
        var invPath = ltPath + SEP + 'I' + SEP + normKey(invName);
        labels[invPath] = labels[invPath] || { inventoryType: String(invName).trim() };
        addInto(map, invPath, metricsToBag(inv.metrics || inv));

        var makes = inv.byMake || [];
        for (var k = 0; k < makes.length; k++) {
          var mk = makes[k] || {};
          var mkName = mk.make || mk.vehicleMake || mk.name;
          if (!mkName) continue;
          var mkPath = invPath + SEP + 'M' + SEP + normKey(mkName);
          labels[mkPath] = labels[mkPath] || { make: String(mkName).trim() };
          addInto(map, mkPath, metricsToBag(mk.metrics || mk));
        }
      }
    }

    var reps = snap.reps || [];
    for (var r = 0; r < reps.length; r++) {
      var rep = reps[r] || {};
      if (!rep.name) continue;
      var nm = String(rep.name).trim();
      if (nm.toUpperCase() === 'TOTAL') { addInto(map, P_REPTOTAL, repToBag(rep)); continue; }
      var rPath = 'R' + SEP + normKey(nm);
      labels[rPath] = labels[rPath] || { name: nm };
      addInto(map, rPath, repToBag(rep));
    }
    if (snap.repTotals) addInto(map, P_REPTOTAL, repToBag(snap.repTotals));

    return map;
  }

  /** cur − prev, clamping negative counts to 0 and reporting that it happened. */
  function diffPathMaps(cur, prev) {
    var out = {}, clampedPaths = [], p, k;
    var paths = {};
    for (p in cur) if (Object.prototype.hasOwnProperty.call(cur, p)) paths[p] = 1;
    for (p in prev) if (Object.prototype.hasOwnProperty.call(prev, p)) paths[p] = 1;
    for (p in paths) {
      var a = cur[p] || {}, b = prev[p] || {};
      var keys = {}, bag = {}, neg = false;
      for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) keys[k] = 1;
      for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) keys[k] = 1;
      for (k in keys) {
        var v = (a[k] || 0) - (b[k] || 0);
        if (v < 0) { neg = true; v = 0; }
        bag[k] = v;
      }
      if (neg) clampedPaths.push(p);
      out[p] = bag;
    }
    return { map: out, clamped: clampedPaths.length > 0, clampedPaths: clampedPaths };
  }

  /**
   * The as-of date of a cumulative snapshot inside the month it covers.
   * "Current Month" reports carry an end-of-month `end`, so the real as-of is the Run Date.
   * "Previous Month MTD" reports are run in the following month, so their as-of is `end`.
   */
  function snapshotAsOf(snap) {
    var begin = iso(snap.begin);
    var end = iso(snap.end);
    var run = iso(snap.runDate);
    var candidate = null;
    if (end && run) candidate = minIso(end, run);
    else candidate = end || run;
    if (!candidate) return null;
    if (begin && dayNum(candidate) < dayNum(begin)) candidate = end || begin;
    return candidate;
  }

  function snapshotMonth(snap, asOf) {
    return monthKey(snap.begin) || monthKey(asOf) || monthKey(snap.end) || monthKey(snap.runDate);
  }

  function buildGroups(snapshots) {
    var groups = {};
    for (var i = 0; i < snapshots.length; i++) {
      var s = snapshots[i] || {};
      var storeId = s.storeId;
      var kind = s.kind === 'sales' ? 'sales' : (s.kind === 'kpi' ? 'kpi' : (s.reps ? 'sales' : 'kpi'));
      if (!storeId) { state.warnings.push('snapshot without storeId skipped (' + (s.source || 'unknown source') + ')'); continue; }
      var asOf = snapshotAsOf(s);
      if (!asOf) { state.warnings.push('snapshot without a usable date skipped (' + (s.source || 'unknown source') + ')'); continue; }
      var mk = snapshotMonth(s, asOf);
      var key = storeId + '|' + kind + '|' + mk;
      var g = groups[key];
      if (!g) {
        g = groups[key] = {
          key: key, storeId: storeId, kind: kind, month: mk,
          monthStart: monthStart(mk + '-01'), monthEnd: monthEnd(mk + '-01'),
          snapshots: [], deltas: []
        };
      }
      g.snapshots.push({
        raw: s,
        storeId: storeId,
        kind: kind,
        period: s.period || null,
        begin: iso(s.begin),
        end: iso(s.end),
        runDate: iso(s.runDate),
        asOf: asOf,
        source: s.source || null,
        map: flattenSnapshot(s)
      });
    }

    for (var key2 in groups) {
      var grp = groups[key2];
      grp.snapshots.sort(function (a, b) {
        var d = dayNum(a.asOf) - dayNum(b.asOf);
        if (d !== 0) return d;
        var ra = dayNum(a.runDate) || 0, rb = dayNum(b.runDate) || 0;
        return ra - rb;
      });
      // de-duplicate same as-of date: the later run wins (a re-run supersedes)
      var deduped = [];
      for (var n = 0; n < grp.snapshots.length; n++) {
        var snapN = grp.snapshots[n];
        if (deduped.length && deduped[deduped.length - 1].asOf === snapN.asOf) {
          state.warnings.push('duplicate snapshot for ' + grp.storeId + ' ' + grp.kind + ' as of ' + snapN.asOf + ' — kept the later run');
          deduped[deduped.length - 1] = snapN;
        } else {
          deduped.push(snapN);
        }
      }
      grp.snapshots = deduped;

      // difference consecutive cumulative snapshots into per-day deltas
      for (var q = 0; q < grp.snapshots.length; q++) {
        var curS = grp.snapshots[q];
        var prevS = q > 0 ? grp.snapshots[q - 1] : null;
        var d;
        if (prevS) {
          d = diffPathMaps(curS.map, prevS.map);
        } else {
          // first snapshot of the month is its own daily value
          d = { map: curS.map, clamped: false, clampedPaths: [] };
        }
        grp.deltas.push({
          date: curS.asOf,
          spanStart: prevS ? addDays(prevS.asOf, 1) : grp.monthStart,
          spanEnd: curS.asOf,
          map: d.map,
          clamped: d.clamped,
          clampedPaths: d.clampedPaths,
          source: curS.source,
          isFirst: !prevS
        });
      }
    }
    return groups;
  }

  function indexStores(data) {
    state.stores = [];
    state.storeById = {};
    var list = (data && data.stores) || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !s.id) continue;
      var store = {
        id: s.id,
        name: s.name || s.id,
        crm: s.crm || null,
        tools: s.tools || [],
        location: s.location || null,
        raw: s
      };
      state.stores.push(store);
      state.storeById[store.id] = store;
    }
  }

  function init(data, options) {
    options = options || {};
    state.data = data || (global.DASH_DATA || null) || {};
    state.labels = {};
    state.warnings = [];
    state.anchorOverride = options.anchor ? iso(options.anchor) : null;

    indexStores(state.data);
    state.groups = buildGroups((state.data && state.data.snapshots) || []);

    state.groupsByStore = {};
    var earliest = null, latest = null;
    for (var k in state.groups) {
      var g = state.groups[k];
      var byStore = state.groupsByStore[g.storeId] || (state.groupsByStore[g.storeId] = { kpi: [], sales: [] });
      (byStore[g.kind] || (byStore[g.kind] = [])).push(g);
      for (var i = 0; i < g.snapshots.length; i++) {
        var a = g.snapshots[i].asOf;
        earliest = earliest === null ? a : minIso(earliest, a);
        latest = latest === null ? a : maxIso(latest, a);
      }
      // stores present only in snapshots (not in stores[]) still deserve a record
      if (!state.storeById[g.storeId]) {
        var stub = { id: g.storeId, name: g.storeId, crm: null, tools: [], location: null, raw: null };
        state.storeById[g.storeId] = stub;
        state.stores.push(stub);
        state.warnings.push('snapshots reference unknown store "' + g.storeId + '"');
      }
    }
    for (var sid in state.groupsByStore) {
      var gs = state.groupsByStore[sid];
      for (var kind in gs) {
        gs[kind].sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : 0; });
      }
    }
    state.earliestAsOf = earliest;
    state.latestAsOf = latest;
    return Core;
  }

  /* ------------------------------------------------------------------ *
   * timeframes & ranges
   * ------------------------------------------------------------------ */

  var TIMEFRAMES = [
    { id: 'today', label: 'Today' },
    { id: 'yesterday', label: 'Yesterday' },
    { id: 'week', label: 'This week' },
    { id: 'month', label: 'This month (MTD)' },
    { id: 'lastmonth', label: 'Last month' },
    { id: 'year', label: 'This year' },
    { id: 'custom', label: 'Custom range' }
  ];

  var TF_ALIASES = {
    today: 'today', day: 'today',
    yesterday: 'yesterday', prevday: 'yesterday',
    week: 'week', thisweek: 'week', wtd: 'week', weektodate: 'week',
    month: 'month', thismonth: 'month', mtd: 'month', thismonthmtd: 'month', monthtodate: 'month', currentmonth: 'month',
    lastmonth: 'lastmonth', previousmonth: 'lastmonth', priormonth: 'lastmonth', prevmonth: 'lastmonth',
    year: 'year', thisyear: 'year', ytd: 'year', yeartodate: 'year',
    custom: 'custom', customrange: 'custom', range: 'custom'
  };

  function timeframes() {
    return TIMEFRAMES.map(function (t) { return { id: t.id, label: t.label }; });
  }

  function timeframeLabel(id) {
    for (var i = 0; i < TIMEFRAMES.length; i++) if (TIMEFRAMES[i].id === id) return TIMEFRAMES[i].label;
    return null;
  }

  function normalizeTfId(tfId) {
    if (!tfId) return 'month';
    var n = normKey(tfId);
    return TF_ALIASES[n] || 'month';
  }

  function clockToday() {
    var d = new Date();
    return iso(mkDate(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  /**
   * The date presets are anchored to. With anchorMode 'data' (default) this is the
   * newest snapshot in the loaded dataset, so "Today"/"This week"/"MTD" describe the
   * data that actually exists rather than silently resolving to an empty future range.
   * Every resolved range carries `anchor` + `anchorMode` so the UI can state the as-of date.
   */
  function anchorDate() {
    if (state.anchorOverride) return state.anchorOverride;
    if (settings.anchorMode === 'clock') return clockToday();
    return state.latestAsOf || clockToday();
  }

  function setAnchor(v) {
    state.anchorOverride = v ? iso(v) : null;
    return anchorDate();
  }

  function startOfWeek(v) {
    var d = parseDate(v);
    if (!d) return null;
    var dow = d.getUTCDay();                       // 0=Sun
    var back = (dow - (settings.weekStartsOn || 0) + 7) % 7;
    return addDays(iso(d), -back);
  }

  function comparisonFor(start, end, tfId) {
    // Whole-month ranges and anything inside a month shift back one calendar month,
    // clamping the day-of-month (Mar 31 → Feb 28/29). "This year" shifts back a year.
    if (tfId === 'year') {
      return {
        start: addMonths(start, -12),
        end: addMonths(end, -12),
        label: 'Same period last year'
      };
    }
    var cs = addMonths(start, -1);
    var ce;
    if (isLastDayOfMonth(end) &&
        dayNum(start) === dayNum(monthStart(start)) &&
        monthKey(start) === monthKey(end)) {
      // exactly ONE full calendar month → the full previous calendar month.
      // The same-month check matters: without it a range like Jun 1 – Jul 31
      // would collapse its comparison window down to a single month (May).
      ce = monthEnd(cs);
    } else {
      ce = addMonths(end, -1);
    }
    var label;
    if (dayNum(start) === dayNum(end)) label = 'Same day last month';
    else if (tfId === 'lastmonth') label = 'Previous month';
    else label = 'Same period last month';
    return { start: cs, end: ce, label: label };
  }

  /**
   * resolveRange(tfId, customStart, customEnd)
   *   → { id, label, start, end, compareStart, compareEnd, compareLabel,
   *       anchor, anchorMode, days, dateLabel, compareDateLabel, custom }
   * Also accepts a single object argument: resolveRange({id, start, end}).
   */
  function resolveRange(tfId, customStart, customEnd) {
    if (tfId && typeof tfId === 'object' && !(tfId instanceof Date)) {
      var o = tfId;
      customStart = o.start !== undefined ? o.start : o.customStart;
      customEnd = o.end !== undefined ? o.end : o.customEnd;
      tfId = o.id || o.tfId;
    }
    var id = normalizeTfId(tfId);
    var anchor = anchorDate();
    var start, end;

    if (id === 'custom') {
      var cs = iso(customStart), ce = iso(customEnd);
      if (!cs && !ce) { id = 'month'; }
      else {
        if (!cs) cs = ce;
        if (!ce) ce = cs;
        if (dayNum(cs) > dayNum(ce)) { var t = cs; cs = ce; ce = t; }
        start = cs; end = ce;
      }
    }

    if (id !== 'custom') {
      switch (id) {
        case 'today':     start = anchor; end = anchor; break;
        case 'yesterday': start = addDays(anchor, -1); end = start; break;
        case 'week':      start = startOfWeek(anchor); end = anchor; break;
        case 'lastmonth': var lm = addMonths(monthStart(anchor), -1);
                          start = monthStart(lm); end = monthEnd(lm); break;
        case 'year':      start = iso(mkDate(parseDate(anchor).getUTCFullYear(), 0, 1)); end = anchor; break;
        case 'month':
        default:          id = 'month'; start = monthStart(anchor); end = anchor; break;
      }
    }

    var cmp = comparisonFor(start, end, id);
    var label = id === 'custom' ? formatRange(start, end) : timeframeLabel(id);

    return {
      id: id,
      label: label,
      presetLabel: timeframeLabel(id) || 'Custom range',
      dateLabel: formatRange(start, end),
      start: start,
      end: end,
      days: dayNum(end) - dayNum(start) + 1,
      compareStart: cmp.start,
      compareEnd: cmp.end,
      compareLabel: cmp.label,
      compareDateLabel: formatRange(cmp.start, cmp.end),
      anchor: anchor,
      anchorMode: state.anchorOverride ? 'override' : settings.anchorMode,
      custom: id === 'custom'
    };
  }

  /** The comparison half of a resolved range, as a range object you can pass anywhere. */
  function compareRange(range) {
    if (!range) return null;
    return {
      id: range.id + ':compare',
      label: range.compareLabel,
      presetLabel: range.compareLabel,
      dateLabel: range.compareDateLabel || formatRange(range.compareStart, range.compareEnd),
      start: range.compareStart,
      end: range.compareEnd,
      days: dayNum(range.compareEnd) - dayNum(range.compareStart) + 1,
      compareStart: null, compareEnd: null, compareLabel: null,
      anchor: range.anchor,
      custom: false
    };
  }

  function asRange(range) {
    if (!range) return resolveRange(settings.timeframe && settings.timeframe.id,
                                    settings.timeframe && settings.timeframe.start,
                                    settings.timeframe && settings.timeframe.end);
    if (range.start && range.end) return range;
    return resolveRange(range);
  }

  /* ------------------------------------------------------------------ *
   * aggregation
   * ------------------------------------------------------------------ */

  function emptyCoverage(reason) {
    return {
      hasData: false,
      months: [],
      snapshotDates: [],
      sources: [],
      firstDate: null,
      lastDate: null,
      clamped: false,
      clampedDates: [],
      partial: false,
      notes: [],
      reason: reason || 'No snapshot covers this date range.'
    };
  }

  /**
   * Aggregate one (store, kind) across a date range.
   *
   * Per month:
   *   - if the range starts at/before the month start, use the newest cumulative
   *     snapshot at/before the range end (never re-sum days when a snapshot exists)
   *   - otherwise sum the per-day deltas whose as-of date falls in the range
   */
  function aggregate(storeId, kind, range) {
    range = asRange(range);
    var acc = {};
    var cov = emptyCoverage(null);
    cov.reason = null;
    var byStore = state.groupsByStore[storeId];
    var groups = byStore ? (byStore[kind] || []) : [];

    if (!groups.length) {
      var c0 = emptyCoverage('No ' + (kind === 'sales' ? 'salesperson activity' : 'KPI') + ' report loaded for this store.');
      return { map: acc, coverage: c0 };
    }

    var anyOverlap = false;

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var effStart = maxIso(range.start, g.monthStart);
      var effEnd = minIso(range.end, g.monthEnd);
      if (dayNum(effStart) > dayNum(effEnd)) continue;   // month not in range
      anyOverlap = true;

      var monthInfo = {
        month: g.month, mode: null, asOf: null, snapshots: g.snapshots.length,
        partial: false, clamped: false, coveredStart: null, coveredEnd: null, note: null
      };

      if (dayNum(effStart) <= dayNum(g.monthStart)) {
        // whole-month-from-the-start → use the cumulative snapshot itself
        var chosen = null;
        for (var s = 0; s < g.snapshots.length; s++) {
          if (dayNum(g.snapshots[s].asOf) <= dayNum(effEnd)) chosen = g.snapshots[s];
        }
        if (!chosen) {
          monthInfo.mode = 'none';
          monthInfo.note = 'No snapshot on or before ' + formatDate(effEnd) + ' for ' + g.month + '.';
          cov.months.push(monthInfo);
          continue;
        }
        mergePathMap(acc, chosen.map);
        monthInfo.mode = 'snapshot';
        monthInfo.asOf = chosen.asOf;
        monthInfo.coveredStart = g.monthStart;
        monthInfo.coveredEnd = chosen.asOf;
        cov.snapshotDates.push(chosen.asOf);
        if (chosen.source) cov.sources.push(chosen.source);
        if (dayNum(chosen.asOf) < dayNum(effEnd)) {
          monthInfo.partial = true;
          monthInfo.note = 'Data runs through ' + formatDate(chosen.asOf) + '; the selected range ends ' + formatDate(effEnd) + '.';
        }
        // a clamped delta anywhere at/before the chosen snapshot is worth surfacing
        for (var dz = 0; dz < g.deltas.length; dz++) {
          var dd = g.deltas[dz];
          if (dayNum(dd.date) <= dayNum(chosen.asOf) && dd.clamped) {
            monthInfo.clamped = true;
            cov.clampedDates.push(dd.date);
          }
        }
      } else {
        // mid-month range → sum per-day deltas
        var used = 0;
        for (var d2 = 0; d2 < g.deltas.length; d2++) {
          var del = g.deltas[d2];
          if (!inRange(del.date, effStart, effEnd)) continue;
          mergePathMap(acc, del.map);
          used++;
          cov.snapshotDates.push(del.date);
          if (del.source) cov.sources.push(del.source);
          if (del.clamped) { monthInfo.clamped = true; cov.clampedDates.push(del.date); }
          monthInfo.coveredStart = monthInfo.coveredStart === null ? del.spanStart : minIso(monthInfo.coveredStart, del.spanStart);
          monthInfo.coveredEnd = monthInfo.coveredEnd === null ? del.spanEnd : maxIso(monthInfo.coveredEnd, del.spanEnd);
        }
        if (!used) {
          monthInfo.mode = 'none';
          monthInfo.note = 'No daily snapshot between ' + formatDate(effStart) + ' and ' + formatDate(effEnd) + '.';
          cov.months.push(monthInfo);
          continue;
        }
        monthInfo.mode = 'deltas';
        monthInfo.asOf = monthInfo.coveredEnd;
        if (dayNum(monthInfo.coveredStart) < dayNum(effStart)) {
          monthInfo.partial = true;
          monthInfo.note = 'Snapshots are not daily here: the first included day covers ' +
            formatRange(monthInfo.coveredStart, monthInfo.coveredEnd) + ', wider than the selected range.';
        } else if (dayNum(monthInfo.coveredEnd) < dayNum(effEnd)) {
          monthInfo.partial = true;
          monthInfo.note = 'Data runs through ' + formatDate(monthInfo.coveredEnd) + '; the selected range ends ' + formatDate(effEnd) + '.';
        }
      }
      cov.months.push(monthInfo);
    }

    var real = cov.months.filter(function (m) { return m.mode === 'snapshot' || m.mode === 'deltas'; });
    cov.hasData = real.length > 0;
    cov.partial = real.some(function (m) { return m.partial; }) || (cov.months.length > real.length);
    cov.clamped = cov.clampedDates.length > 0;
    cov.snapshotDates.sort();
    cov.firstDate = cov.snapshotDates.length ? cov.snapshotDates[0] : null;
    cov.lastDate = cov.snapshotDates.length ? cov.snapshotDates[cov.snapshotDates.length - 1] : null;
    cov.notes = cov.months.map(function (m) { return m.note; }).filter(Boolean);
    if (!cov.hasData) {
      cov.reason = anyOverlap
        ? 'Reports for this store do not cover ' + formatRange(range.start, range.end) + '.'
        : 'No report loaded for ' + formatRange(range.start, range.end) + '.';
    }
    if (cov.clamped) {
      cov.notes.push('Some daily figures went negative between snapshots (leads re-typed or a sale unwound) and were clamped to zero on ' +
        cov.clampedDates.map(function (d) { return formatDate(d); }).join(', ') + '.');
    }
    return { map: acc, coverage: cov };
  }

  function labelFor(path, field, fallback) {
    var l = state.labels[path];
    return (l && l[field]) || fallback;
  }

  /** rebuild the lead-type tree from an aggregated path map */
  function treeFrom(map, hasData) {
    var byLeadType = [];
    var ltIndex = {};
    for (var path in map) {
      if (!Object.prototype.hasOwnProperty.call(map, path)) continue;
      if (path.charAt(0) !== 'L') continue;
      var parts = path.split(SEP);
      if (parts.length === 2) {
        var ltKey = parts[1];
        var node = ltIndex[ltKey];
        if (!node) {
          node = ltIndex[ltKey] = {
            key: ltKey,
            leadType: labelFor(path, 'leadType', ltKey),
            display: false,
            metrics: null,
            byInventory: [],
            _inv: {}
          };
          byLeadType.push(node);
        }
        node.metrics = finalizeMetrics(map[path], hasData);
        node.display = isDisplayLeadType(node.leadType);
      }
    }
    // inventory + make children
    for (var p2 in map) {
      if (!Object.prototype.hasOwnProperty.call(map, p2)) continue;
      if (p2.charAt(0) !== 'L') continue;
      var pr = p2.split(SEP);
      if (pr.length !== 4 && pr.length !== 6) continue;
      var parentLt = ltIndex[pr[1]];
      if (!parentLt) continue;
      var invKey = pr[3];
      var invPath = 'L' + SEP + pr[1] + SEP + 'I' + SEP + invKey;
      var invNode = parentLt._inv[invKey];
      if (!invNode) {
        invNode = parentLt._inv[invKey] = {
          key: invKey,
          inventoryType: labelFor(invPath, 'inventoryType', invKey),
          metrics: finalizeMetrics(map[invPath] || {}, hasData),
          byMake: [],
          _mk: {}
        };
        parentLt.byInventory.push(invNode);
      }
      if (pr.length === 6) {
        var mkKey = pr[5];
        if (!invNode._mk[mkKey]) {
          invNode._mk[mkKey] = true;
          invNode.byMake.push({
            key: mkKey,
            make: labelFor(p2, 'make', mkKey),
            metrics: finalizeMetrics(map[p2], hasData)
          });
        }
      }
    }
    // stable ordering: displayed lead types first, in spec order, then the rest A→Z
    var order = {};
    for (var oi = 0; oi < DISPLAY_LEAD_TYPES.length; oi++) order[normLeadType(DISPLAY_LEAD_TYPES[oi])] = oi;
    byLeadType.sort(function (a, b) {
      var ai = order[a.key] === undefined ? 100 : order[a.key];
      var bi = order[b.key] === undefined ? 100 : order[b.key];
      if (ai !== bi) return ai - bi;
      return a.leadType < b.leadType ? -1 : a.leadType > b.leadType ? 1 : 0;
    });
    for (var ci = 0; ci < byLeadType.length; ci++) {
      delete byLeadType[ci]._inv;
      byLeadType[ci].byInventory.sort(function (a, b) {
        return a.inventoryType < b.inventoryType ? -1 : a.inventoryType > b.inventoryType ? 1 : 0;
      });
      for (var cj = 0; cj < byLeadType[ci].byInventory.length; cj++) {
        delete byLeadType[ci].byInventory[cj]._mk;
        byLeadType[ci].byInventory[cj].byMake.sort(function (a, b) {
          return a.make < b.make ? -1 : a.make > b.make ? 1 : 0;
        });
      }
    }
    return byLeadType;
  }

  function leadTypeMetrics(byLeadType, name) {
    var n = normLeadType(name);
    for (var i = 0; i < byLeadType.length; i++) {
      if (byLeadType[i].key === n) return byLeadType[i].metrics;
    }
    return null;
  }

  /** storeMetrics(storeId, range) → {total, internet, byLeadType, coverage, ...} */
  function storeMetrics(storeId, range) {
    range = asRange(range);
    var agg = aggregate(storeId, 'kpi', range);
    var has = agg.coverage.hasData;
    var totalBag = agg.map[P_TOTAL];
    var byLeadType = treeFrom(agg.map, has);

    // If the report had no explicit TOTAL row, fall back to the sum of lead types
    // (that is still real reported data, not an invention).
    if (!totalBag && has) {
      totalBag = {};
      for (var i = 0; i < byLeadType.length; i++) {
        var m = byLeadType[i].metrics;
        totalBag = addBags(totalBag, {
          goodLeads: m.goodLeads, sold: m.sold, apptsShown: m.apptsShown,
          contacted: m.contacted, apptsSet: m.apptsSet
        });
      }
    }

    var store = state.storeById[storeId] || null;
    var internet = leadTypeMetrics(byLeadType, 'Internet');
    return {
      storeId: storeId,
      storeName: store ? store.name : storeId,
      hasData: has,
      range: range,
      total: finalizeMetrics(totalBag || {}, has),
      internet: internet || finalizeMetrics({}, false),
      byLeadType: byLeadType,
      displayLeadTypes: byLeadType.filter(function (n) { return n.display; }),
      hiddenLeadTypes: byLeadType.filter(function (n) { return !n.display; }),
      coverage: agg.coverage
    };
  }

  /** allStoresMetrics(range) → {total, internet, perStore:{id: metrics}} */
  function allStoresMetrics(range) {
    range = asRange(range);
    var perStore = {};
    var totalBag = {}, internetBag = {};
    var anyData = false;
    var storesOut = [];
    var coverages = [];

    for (var i = 0; i < state.stores.length; i++) {
      var st = state.stores[i];
      var sm = storeMetrics(st.id, range);
      // perStore[id] is the store's TOTAL metrics, with the rest hung off it so
      // both `perStore[id].goodLeads` and `perStore[id].total.goodLeads` work.
      var entry = {};
      for (var k in sm.total) if (Object.prototype.hasOwnProperty.call(sm.total, k)) entry[k] = sm.total[k];
      entry.storeId = st.id;
      entry.storeName = st.name;
      entry.total = sm.total;
      entry.internet = sm.internet;
      entry.byLeadType = sm.byLeadType;
      entry.displayLeadTypes = sm.displayLeadTypes;
      entry.coverage = sm.coverage;
      entry.hasData = sm.hasData;
      perStore[st.id] = entry;
      storesOut.push(entry);
      coverages.push({ storeId: st.id, storeName: st.name, coverage: sm.coverage });
      if (sm.hasData) {
        anyData = true;
        totalBag = addBags(totalBag, {
          goodLeads: sm.total.goodLeads, sold: sm.total.sold, apptsShown: sm.total.apptsShown,
          contacted: sm.total.contacted, apptsSet: sm.total.apptsSet
        });
        if (sm.internet.hasData) {
          internetBag = addBags(internetBag, {
            goodLeads: sm.internet.goodLeads, sold: sm.internet.sold, apptsShown: sm.internet.apptsShown,
            contacted: sm.internet.contacted, apptsSet: sm.internet.apptsSet
          });
        }
      }
    }
    return {
      range: range,
      hasData: anyData,
      total: finalizeMetrics(totalBag, anyData),
      internet: finalizeMetrics(internetBag, anyData),
      perStore: perStore,
      stores: storesOut,
      storesWithData: storesOut.filter(function (s) { return s.hasData; }).length,
      coverage: coverages
    };
  }

  /* ------------------------------------------------------------------ *
   * reps
   * ------------------------------------------------------------------ */

  function matadorFor(storeId) {
    var list = (state.data && state.data.matador) || [];
    return list.filter(function (m) { return !m.storeId || m.storeId === storeId; });
  }

  /** reps(storeId, range) → [rep] aggregated across the range (TOTAL row excluded) */
  function reps(storeId, range) {
    range = asRange(range);
    var agg = aggregate(storeId, 'sales', range);
    var has = agg.coverage.hasData;
    var out = [];
    for (var path in agg.map) {
      if (!Object.prototype.hasOwnProperty.call(agg.map, path)) continue;
      if (path.charAt(0) !== 'R' || path === P_REPTOTAL) continue;
      var parts = path.split(SEP);
      if (parts.length !== 2) continue;
      out.push(finalizeRep(labelFor(path, 'name', parts[1]), agg.map[path], has));
    }
    // join Matador activity by normalized name
    var mat = matadorFor(storeId);
    var matByName = {};
    for (var mi = 0; mi < mat.length; mi++) matByName[normKey(mat[mi].name)] = mat[mi];
    var used = {};
    for (var i = 0; i < out.length; i++) {
      var m = matByName[normKey(out[i].name)];
      if (m) { out[i].matador = m; used[normKey(m.name)] = 1; }
    }
    // Second pass, deliberately narrow: same surname and one given name is a prefix
    // of the other ("Zach Schroeder" ↔ "Zachary Schroeder"), and only when exactly
    // one unused Matador record qualifies. No fuzzy scoring, no invented links.
    for (var i2 = 0; i2 < out.length; i2++) {
      if (out[i2].matador) continue;
      var t = nameTokens(out[i2].name);
      if (t.length < 2) continue;
      var hit = null, hits = 0;
      for (var mj = 0; mj < mat.length; mj++) {
        if (used[normKey(mat[mj].name)]) continue;
        var u = nameTokens(mat[mj].name);
        if (u.length < 2) continue;
        if (u[u.length - 1] !== t[t.length - 1]) continue;
        if (u[0].indexOf(t[0]) !== 0 && t[0].indexOf(u[0]) !== 0) continue;
        hits++; hit = mat[mj];
      }
      if (hits === 1) { out[i2].matador = hit; used[normKey(hit.name)] = 1; }
    }
    out.sort(function (a, b) {
      if (b.sold !== a.sold) return b.sold - a.sold;
      if (b.goodLeads !== a.goodLeads) return b.goodLeads - a.goodLeads;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    out.coverage = agg.coverage;   // convenience; the array is still the return value
    return out;
  }

  function repTotals(storeId, range) {
    range = asRange(range);
    var agg = aggregate(storeId, 'sales', range);
    var bag = agg.map[P_REPTOTAL];
    if (!bag && agg.coverage.hasData) {
      bag = {};
      for (var path in agg.map) {
        if (!Object.prototype.hasOwnProperty.call(agg.map, path)) continue;
        if (path.charAt(0) !== 'R' || path === P_REPTOTAL) continue;
        if (path.split(SEP).length !== 2) continue;
        bag = addBags(bag, agg.map[path]);
      }
    }
    var t = finalizeRep('TOTAL', bag || {}, agg.coverage.hasData);
    t.coverage = agg.coverage;
    return t;
  }

  /** Matador users with no matching salesperson row in the loaded reports. */
  function matadorUnmatched(storeId, range) {
    var linked = {};
    var list = reps(storeId, range);
    for (var i = 0; i < list.length; i++) {
      if (list[i].matador) linked[normKey(list[i].matador.name)] = 1;
    }
    return matadorFor(storeId).filter(function (m) { return !linked[normKey(m.name)]; });
  }

  /* ------------------------------------------------------------------ *
   * comparison
   * ------------------------------------------------------------------ */

  var PCT_KEYS = {
    contactPct: 1, engagementPct: 1, apptSetOfContactedPct: 1, apptSetPct: 1,
    apptShownPct: 1, apptsShownPct: 1, closingRate: 1, closingPct: 1, shownPct: 1
  };

  /** compare(current, prior) → { metricKey: {delta, pct, direction, current, prior, isPct} } */
  function compare(current, prior) {
    var out = {};
    var keys = {}, k;
    current = current || {};
    prior = prior || {};
    for (k in current) if (typeof current[k] === 'number' || current[k] === null) keys[k] = 1;
    for (k in prior) if (typeof prior[k] === 'number' || prior[k] === null) keys[k] = 1;
    for (k in keys) {
      var a = numOrNull(current[k]);
      var b = numOrNull(prior[k]);
      if (a === null || b === null) {
        out[k] = { delta: null, pct: null, direction: 'none', current: a, prior: b, isPct: !!PCT_KEYS[k] };
        continue;
      }
      var delta = a - b;
      out[k] = {
        delta: delta,
        pct: rate(delta, Math.abs(b)),
        direction: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat'),
        current: a,
        prior: b,
        isPct: !!PCT_KEYS[k]
      };
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * pace
   * ------------------------------------------------------------------ */

  /**
   * pace({goal, storeId, asOf, monthStart, monthEnd, includeSaturday})
   *   → {goal, hasGoal, asOf, monthStart, monthEnd, elapsed, total, remaining, fraction, expected}
   * A null goal yields expected:null — the UI must show "no goal" (neutral), never red.
   */
  function pace(opts) {
    opts = opts || {};
    var asOf = iso(opts.asOf) || anchorDate();
    var ms = iso(opts.monthStart) || monthStart(asOf);
    var me = iso(opts.monthEnd) || monthEnd(ms);
    var inc = opts.includeSaturday === undefined ? !!settings.includeSaturday : !!opts.includeSaturday;

    var goal = opts.goal !== undefined ? numOrNull(opts.goal)
             : (opts.storeId ? getSalesGoal(opts.storeId) : null);
    if (goal !== null && goal <= 0) goal = null;

    var capped = minIso(asOf, me);
    var elapsed = dayNum(capped) < dayNum(ms) ? 0 : networkDays(ms, capped, inc);
    var total = networkDays(ms, me, inc);
    var fraction = rate(elapsed, total);
    var remaining = (total === null || elapsed === null) ? null : total - elapsed;
    var expected = (goal === null || fraction === null) ? null : goal * fraction;

    return {
      goal: goal,
      hasGoal: goal !== null,
      asOf: asOf,
      monthStart: ms,
      monthEnd: me,
      includeSaturday: inc,
      elapsed: elapsed,
      total: total,
      remaining: remaining,
      fraction: fraction,
      expected: expected,
      note: 'Working days are ' + (inc ? 'Mon–Sat' : 'Mon–Fri') + '. No holiday calendar is applied.'
    };
  }

  /** paceRatio(actual, paceObj|expected) → actual/expected, null when there is no goal. */
  function paceRatio(actual, paceOrExpected) {
    var expected = (paceOrExpected && typeof paceOrExpected === 'object')
      ? paceOrExpected.expected : paceOrExpected;
    return rate(actual, expected);
  }

  /** Pace for a store over a range, using the persisted (or supplied) sales goal.
   *
   * The goal is a MONTHLY number, but the selected range may be a single day, a
   * week, or several months. Comparing a day's sales against a whole month's
   * expectation would paint every store red, so the expectation is pro-rated to
   * the working days that actually fall inside the range: for each month the
   * range touches, goal x (workdays of that month inside the range / workdays in
   * that month). For the default month-to-date range this reduces exactly to the
   * spec's goal x elapsed/total.
   */
  function storePace(storeId, range, actualSold, goalOverride) {
    range = asRange(range);
    var capEnd = minIso(range.end, anchorDate());
    var p = pace({
      storeId: storeId,
      goal: goalOverride !== undefined ? goalOverride : getSalesGoal(storeId),
      asOf: capEnd,
      monthStart: monthStart(range.end),
      monthEnd: monthEnd(range.end)
    });

    var inc = p.includeSaturday;
    var rangeElapsed = 0, rangeFraction = 0, months = 0;
    if (range.start && capEnd && dayNum(capEnd) >= dayNum(range.start)) {
      var cursor = monthStart(range.start);
      var guard = 0;
      while (dayNum(cursor) <= dayNum(capEnd) && guard++ < 400) {
        var mStart = cursor;
        var mEnd = monthEnd(cursor);
        var from = dayNum(range.start) > dayNum(mStart) ? range.start : mStart;
        var to = dayNum(capEnd) < dayNum(mEnd) ? capEnd : mEnd;
        if (dayNum(to) >= dayNum(from)) {
          var inMonth = networkDays(from, to, inc);
          var monthTotal = networkDays(mStart, mEnd, inc);
          var f = rate(inMonth, monthTotal);
          if (f !== null) { rangeFraction += f; months++; }
          rangeElapsed += inMonth || 0;
        }
        cursor = monthStart(addMonths(cursor, 1));
      }
    }

    p.rangeStart = range.start || null;
    p.rangeEnd = capEnd;
    p.rangeElapsed = rangeElapsed;
    p.rangeFraction = months ? rangeFraction : null;
    p.rangeMonths = months;
    p.expected = (p.goal === null || p.rangeFraction === null) ? null : p.goal * p.rangeFraction;
    p.scopedToRange = months > 0;

    p.actual = numOrNull(actualSold);
    p.ratio = paceRatio(p.actual, p);
    p.color = p.hasGoal ? colorFor(p.actual, p.expected) : 'none';
    return p;
  }

  /* ------------------------------------------------------------------ *
   * misc accessors
   * ------------------------------------------------------------------ */

  function stores() {
    return state.stores.map(function (s) {
      return { id: s.id, name: s.name, crm: s.crm, tools: s.tools, location: s.location };
    });
  }

  function store(id) {
    var s = state.storeById[id];
    return s ? { id: s.id, name: s.name, crm: s.crm, tools: s.tools, location: s.location } : null;
  }

  function coverage(storeId) {
    var declared = (state.data && state.data.coverage && state.data.coverage[storeId]) || null;
    var byStore = state.groupsByStore[storeId];
    var kinds = {};
    var runDates = {}, months = {};
    if (byStore) {
      for (var kind in byStore) {
        var list = byStore[kind];
        var dates = [];
        for (var i = 0; i < list.length; i++) {
          months[list[i].month] = 1;
          for (var j = 0; j < list[i].snapshots.length; j++) {
            dates.push(list[i].snapshots[j].asOf);
            runDates[list[i].snapshots[j].asOf] = 1;
          }
        }
        dates.sort();
        kinds[kind] = {
          months: list.map(function (g) { return g.month; }),
          runDates: dates,
          firstRun: dates[0] || null,
          lastRun: dates[dates.length - 1] || null,
          snapshots: dates.length
        };
      }
    }
    var allDates = Object.keys(runDates).sort();
    var allMonths = Object.keys(months).sort();
    return {
      storeId: storeId,
      declared: declared,
      byKind: kinds,
      months: allMonths,
      runDates: allDates,
      firstRun: allDates[0] || null,
      lastRun: allDates[allDates.length - 1] || null,
      hasKpi: !!kinds.kpi,
      hasSales: !!kinds.sales
    };
  }

  /** Per-day deltas for a store/kind, for charts and the sources page. */
  function dailyDeltas(storeId, kind) {
    var byStore = state.groupsByStore[storeId];
    var groups = byStore ? (byStore[kind || 'kpi'] || []) : [];
    var out = [];
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].deltas.length; j++) {
        var d = groups[i].deltas[j];
        out.push({
          date: d.date,
          month: groups[i].month,
          spanStart: d.spanStart,
          spanEnd: d.spanEnd,
          isFirst: d.isFirst,
          clamped: d.clamped,
          source: d.source,
          total: finalizeMetrics(d.map[P_TOTAL] || {}, true)
        });
      }
    }
    out.sort(function (a, b) { return dayNum(a.date) - dayNum(b.date); });
    return out;
  }

  function integrations() {
    return ((state.data && state.data.integrations) || []).slice();
  }

  function matador(storeId) {
    return storeId ? matadorFor(storeId) : ((state.data && state.data.matador) || []).slice();
  }

  function generatedAt() { return (state.data && state.data.generatedAt) || null; }

  function dataAvailable() {
    return !!(state.stores.length && state.latestAsOf);
  }

  function warnings() { return state.warnings.slice(); }

  /* ------------------------------------------------------------------ *
   * export
   * ------------------------------------------------------------------ */

  var Core = {
    version: VERSION,

    // lifecycle
    init: init,
    get data() { return state.data; },

    // timeframe
    timeframes: timeframes,
    timeframeLabel: timeframeLabel,
    resolveRange: resolveRange,
    compareRange: compareRange,
    anchorDate: anchorDate,
    setAnchor: setAnchor,

    // metrics
    storeMetrics: storeMetrics,
    allStoresMetrics: allStoresMetrics,
    reps: reps,
    repTotals: repTotals,
    matadorUnmatched: matadorUnmatched,
    compare: compare,
    emptyMetrics: emptyMetrics,
    EMPTY_METRICS: EMPTY_METRICS,

    // pace & colors
    pace: pace,
    paceRatio: paceRatio,
    storePace: storePace,
    networkDays: networkDays,
    rate: rate,
    colorFor: colorFor,

    // settings
    settings: settings,
    saveSettings: saveSettings,
    setSetting: setSetting,
    setSalesGoal: setSalesGoal,
    getSalesGoal: getSalesGoal,
    setTimeframe: setTimeframe,
    resetSettings: resetSettings,
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,

    // data accessors
    stores: stores,
    store: store,
    coverage: coverage,
    dailyDeltas: dailyDeltas,
    integrations: integrations,
    matador: matador,
    generatedAt: generatedAt,
    dataAvailable: dataAvailable,
    warnings: warnings,

    // lead types
    DISPLAY_LEAD_TYPES: DISPLAY_LEAD_TYPES,
    HIDDEN_LEAD_TYPES: HIDDEN_LEAD_TYPES,
    isDisplayLeadType: isDisplayLeadType,
    normLeadType: normLeadType,

    // date utilities (shared with pages.js so formatting stays consistent)
    parseDate: parseDate,
    iso: iso,
    addDays: addDays,
    addMonths: addMonths,
    monthStart: monthStart,
    monthEnd: monthEnd,
    monthKey: monthKey,
    daysInMonth: daysInMonth,
    formatDate: formatDate,
    formatRange: formatRange,
    dayNum: dayNum,

    // numeric helpers
    numOrNull: numOrNull,
    _internal: { state: state, aggregate: aggregate, diffPathMaps: diffPathMaps, finalizeMetrics: finalizeMetrics }
  };

  global.Core = Core;

  // Auto-init when data.js was loaded first; harmless otherwise (app.js can re-init).
  if (global.DASH_DATA) {
    try { init(global.DASH_DATA); } catch (e) {
      state.warnings.push('auto-init failed: ' + (e && e.message));
    }
  }

}(typeof window !== 'undefined' ? window : this));
