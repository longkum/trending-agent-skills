(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GrowthCore = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var WINDOWS = ['1', '7', '30', 'rate7', 'rate30'];
  function validMetric(metric, rate) {
    return metric && typeof metric === 'object' &&
      Number.isSafeInteger(metric.delta) &&
      Number.isSafeInteger(metric.baseline) && metric.baseline >= 0 &&
      (!rate || (metric.rate_rankable === true && Number.isFinite(metric.rate)));
  }
  function selectedMetric(record, selection) {
    if (!record || !record.windows || WINDOWS.indexOf(selection) === -1) return null;
    var isRate = selection.slice(0, 4) === 'rate';
    var period = isRate ? selection.slice(4) : selection;
    var metric = record.windows[period];
    return validMetric(metric, isRate) ? metric : null;
  }
  function compareNames(a, b) {
    var left = a.name.toLowerCase(), right = b.name.toLowerCase();
    return left < right ? -1 : left > right ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }
  function rank(catalogRecords, growthRecords, selection, filters) {
    filters = filters || {};
    if (!Array.isArray(catalogRecords) || !growthRecords || typeof growthRecords !== 'object') return [];
    var isRate = selection.slice(0, 4) === 'rate';
    var terms = String(filters.query || '').normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
    var rows = catalogRecords.reduce(function (out, record) {
      if (!record || !record.name || (filters.track && filters.track !== 'all' && record.track !== filters.track) ||
          (filters.category && filters.category !== 'all' && record.category !== filters.category)) return out;
      var haystack = [record.name, record.summary, record.summary_en, record.description].join(' ').normalize('NFKC').toLowerCase();
      if (terms.some(function (term) { return haystack.indexOf(term) === -1; })) return out;
      var growth = growthRecords[record.name];
      var metric = selectedMetric(growth, selection);
      if (!metric) return out;
      out.push({name: record.name, catalog: record, growth: growth, metric: metric});
      return out;
    }, []);
    rows.sort(function (a, b) {
      if (isRate && a.metric.rate !== b.metric.rate) return b.metric.rate - a.metric.rate;
      if (!isRate && a.metric.delta !== b.metric.delta) return b.metric.delta - a.metric.delta;
      return b.growth.stars - a.growth.stars || compareNames(a, b);
    });
    return rows;
  }
  function points(history, limitDays) {
    if (!Array.isArray(history) || !history.length) return [];
    var filtered = history.filter(function (p) {
      return Array.isArray(p) && /^\d{4}-\d{2}-\d{2}$/.test(p[0]) && Number.isSafeInteger(p[1]) && p[1] >= 0;
    }).slice().sort(function (a,b) { return a[0].localeCompare(b[0]); });
    if (!filtered.length || !limitDays) return filtered;
    var last = Date.parse(filtered[filtered.length-1][0] + 'T00:00:00Z');
    return filtered.filter(function (p) { return last - Date.parse(p[0] + 'T00:00:00Z') <= limitDays * 86400000; });
  }
  return Object.freeze({WINDOWS: WINDOWS, selectedMetric: selectedMetric, rank: rank, points: points});
});