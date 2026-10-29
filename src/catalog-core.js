(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CatalogCore = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var TRACKS = ['all', 'skills', 'ai'];
  var SORTS = ['stars', 'seen', 'created'];
  // Domain category ids. Keep in sync with scripts/build.py CATEGORIES and
  // ~/workspace/goals/github-skills-ai/hidden_files/classify.py CATEGORIES.
  var CATEGORY_IDS = ['finance', 'security', 'media', 'design', 'mcp',
    'marketing', 'rag', 'crawl', 'assistant', 'coding', 'agent', 'models',
    'data', 'learn', 'productivity', 'devops', 'skills', 'game', 'other'];
  var ENTITIES = Object.freeze({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', middot: ' ', bull: '•', hellip: '…',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”'
  });

  // Decode one layer without creating HTML or executing repository content.
  function normalizeText(value) {
    if (value == null) return '';
    return String(value).replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, function (match, entity) {
      if (entity.charAt(0) !== '#') {
        return Object.prototype.hasOwnProperty.call(ENTITIES, entity) ? ENTITIES[entity] : match;
      }
      var hex = entity.charAt(1).toLowerCase() === 'x';
      var point = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (point < 32 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return match;
      return String.fromCodePoint(point);
    }).replace(/\u00b7/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function searchable(value) {
    return normalizeText(value).normalize('NFKC').toLowerCase();
  }

  function starValue(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER) : 0;
  }

  function prepareRecords(raw) {
    if (!Array.isArray(raw)) throw new TypeError('Catalog data must be an array.');
    return raw.map(function (record, index) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.name !== 'string' || !record.name.trim()) {
        throw new TypeError('Invalid catalog record at index ' + index + '.');
      }
      if (record.track !== 'skills' && record.track !== 'ai') {
        throw new TypeError('Unknown catalog category for ' + record.name + '.');
      }
      var summary = normalizeText(record.summary);
      var description = normalizeText(record.description);
      var english = normalizeText(record.summary_en);
      // The build validates categories strictly; the browser degrades an
      // unknown or missing value to 'other' instead of dropping the record.
      var category = CATEGORY_IDS.indexOf(record.category) !== -1 ? record.category : 'other';
      return Object.assign({}, record, {
        stars: starValue(record.stars),
        category: category,
        summary: summary || description || english,
        summary_en: english,
        description: description,
        searchText: searchable([record.name, summary, description, english].join(' '))
      });
    });
  }

  function searchRecords(records, query) {
    var text = searchable(query);
    if (!text) return records.slice();
    var terms = text.split(/\s+/);
    return records.filter(function (record) {
      var haystack = typeof record.searchText === 'string' ? record.searchText : searchable([
        record.name, record.summary, record.summary_en, record.description
      ].join(' '));
      return terms.every(function (term) { return haystack.indexOf(term) !== -1; });
    });
  }

  function dateValue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return -Infinity;
    var milliseconds = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) return -Infinity;
    return milliseconds;
  }

  function compareNames(a, b) {
    var left = String(a.name || '').toLowerCase();
    var right = String(b.name || '').toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    left = String(a.name || '');
    right = String(b.name || '');
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function sortRecords(records, sort) {
    var key = SORTS.indexOf(sort) === -1 ? 'stars' : sort;
    return records.slice().sort(function (a, b) {
      if (key !== 'stars') {
        var field = key === 'seen' ? 'first_seen' : 'created_at';
        var left = dateValue(a[field]);
        var right = dateValue(b[field]);
        if (left !== right) return left > right ? -1 : 1;
      }
      return starValue(b.stars) - starValue(a.stars) || compareNames(a, b);
    });
  }

  function safeRepoUrl(record) {
    if (!record || typeof record.name !== 'string' || typeof record.url !== 'string') return null;
    var namePattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/i;
    if (!namePattern.test(record.name)) return null;
    var repository = record.name.split('/')[1];
    if (repository === '.' || repository === '..') return null;
    var match = /^https:\/\/github\.com\/([a-z0-9-]+\/[a-z0-9._-]+)$/i.exec(record.url);
    if (!match || match[1].toLowerCase() !== record.name.toLowerCase()) return null;
    return 'https://github.com/' + record.name;
  }

  function groupRecords(records) {
    var groups = { skills: [], ai: [] };
    records.forEach(function (record) {
      if (record.track === 'skills' || record.track === 'ai') groups[record.track].push(record);
    });
    return groups;
  }

  function filterByCategory(records, category) {
    if (!category || category === 'all' || CATEGORY_IDS.indexOf(category) === -1) return records.slice();
    return records.filter(function (record) { return record.category === category; });
  }

  function pageNumber(value) {
    var text = String(value == null ? '' : value);
    if (!/^[1-9]\d*$/.test(text)) return 1;
    var number = Number(text);
    return Number.isSafeInteger(number) ? number : 1;
  }

  function queryValue(value) {
    return Array.from(typeof value === 'string' ? value : '').slice(0, 200).join('').trim();
  }

  function readState(search) {
    var params = new URLSearchParams(typeof search === 'string' ? search : '');
    var track = params.get('track');
    var sort = params.get('sort');
    var category = params.get('category');
    return {
      q: queryValue(params.get('q')),
      track: TRACKS.indexOf(track) !== -1 ? track : 'all',
      sort: SORTS.indexOf(sort) !== -1 ? sort : 'stars',
      category: CATEGORY_IDS.indexOf(category) !== -1 ? category : 'all',
      pages: { skills: pageNumber(params.get('skillsPage')), ai: pageNumber(params.get('aiPage')) }
    };
  }

  // A leading '?' is included only when non-default state needs preserving.
  function stateQuery(state) {
    state = state || {};
    var params = new URLSearchParams();
    var q = queryValue(state.q);
    if (q) params.set('q', q);
    if (state.track === 'skills' || state.track === 'ai') params.set('track', state.track);
    if (state.sort === 'seen' || state.sort === 'created') params.set('sort', state.sort);
    if (state.category && state.category !== 'all' && CATEGORY_IDS.indexOf(state.category) !== -1) params.set('category', state.category);
    var pages = state.pages || {};
    var skillsPage = pageNumber(pages.skills);
    var aiPage = pageNumber(pages.ai);
    if (skillsPage > 1) params.set('skillsPage', String(skillsPage));
    if (aiPage > 1) params.set('aiPage', String(aiPage));
    var query = params.toString();
    return query ? '?' + query : '';
  }

  return Object.freeze({
    normalizeText: normalizeText,
    prepareRecords: prepareRecords,
    searchRecords: searchRecords,
    filterByCategory: filterByCategory,
    sortRecords: sortRecords,
    safeRepoUrl: safeRepoUrl,
    groupRecords: groupRecords,
    readState: readState,
    stateQuery: stateQuery
  });
});
