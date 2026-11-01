(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StarActivityCore = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var WINDOWS = ['1', '7', '30', 'rate7', 'rate30'];
  function dayMs(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    var n = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value) return NaN;
    return n;
  }
  function windowDays(selection) {
    var match = /^rate(7|30)$|^(1|7|30)$/.exec(selection || '');
    return match ? Number(match[1] || match[2]) : null;
  }
  function compareNames(a,b) {
    var x = a.name.toLowerCase(), y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }
  function rank(catalog, cache, selection, filters, today, maxAgeDays) {
    var period = windowDays(selection);
    if (!period || !Array.isArray(catalog) || !cache || typeof cache !== 'object') return [];
    filters = filters || {};
    var todayMs = dayMs(today);
    if (!Number.isFinite(todayMs)) return [];
    var maximumAge = Number.isInteger(maxAgeDays) && maxAgeDays >= 0 ? maxAgeDays : 2;
    var terms = String(filters.query || '').normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
    var rate = selection.startsWith('rate');
    var out = [];
    catalog.forEach(function (record) {
      if (!record || !record.name ||
          (filters.track && filters.track !== 'all' && record.track !== filters.track) ||
          (filters.category && filters.category !== 'all' && record.category !== filters.category)) return;
      var haystack = [record.name, record.summary, record.summary_en, record.description].join(' ').normalize('NFKC').toLowerCase();
      if (terms.some(function (term) {return haystack.indexOf(term) === -1;})) return;
      var history = cache[record.name];
      if (!history || history.source !== 'github-rest-star-history' || !Number.isSafeInteger(history.stars) || history.stars < 0) return;
      var asOfMs = dayMs(history.window_end);
      if (!Number.isFinite(asOfMs) || asOfMs >= todayMs || todayMs - asOfMs > (maximumAge + 1) * 86400000) return;
      var series = history.days;
      if (!Array.isArray(series) || series.length !== 30 || series[29][0] !== history.window_end) return;
      var valid = series.every(function (row, i) {
        return Array.isArray(row) && row.length === 2 && Number.isSafeInteger(row[1]) && row[1] >= 0 &&
          dayMs(row[0]) === asOfMs - (29 - i) * 86400000;
      });
      if (!valid) return;
      var delta = series.slice(-period).reduce(function (sum,row) {return sum + row[1];},0);
      if (!Number.isSafeInteger(delta) || delta <= 0) return;
      // GitHub's history endpoint counts *currently active* stars created in
      // the interval. This is NOT an observed net change in total Stars.
      var baseline = history.stars - delta;
      if (baseline < 0 || (rate && baseline < 10)) return;
      var percent = baseline > 0 ? 100 * delta / baseline : null;
      out.push({
        name: record.name, catalog: record, activity: true,
        windowEnd: history.window_end, collectedAt: history.collected_at,
        growth: {stars: history.stars, history: [], activity_history: series},
        metric: {delta:delta, baseline:baseline, rate:percent}
      });
    });
    out.sort(function (a,b) {
      if (rate && a.metric.rate !== b.metric.rate) return b.metric.rate - a.metric.rate;
      if (!rate && a.metric.delta !== b.metric.delta) return b.metric.delta - a.metric.delta;
      return b.growth.stars - a.growth.stars || compareNames(a,b);
    });
    return out;
  }
  return Object.freeze({WINDOWS:WINDOWS, dayMs:dayMs, windowDays:windowDays, rank:rank});
});