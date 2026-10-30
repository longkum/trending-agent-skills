(function () {
  'use strict';

  var core = window.CatalogCore;
  var PAGE_SIZE = 12;
  var number = new Intl.NumberFormat('en-US');
  var input = document.getElementById('q');
  var sort = document.getElementById('sort');
  var categorySelect = document.getElementById('category');
  var form = document.getElementById('search-form');
  var tabs = Array.from(document.querySelectorAll('.tabs button'));
  var results = document.getElementById('results');
  var count = document.getElementById('count');
  var clear = document.getElementById('clear-query');
  var reset = document.getElementById('reset-filters');
  var empty = document.getElementById('empty-state');
  var dialog = document.getElementById('repo-dialog');
  var records, byName, updated, state, categoryNames;
  var pendingSearch = null;
  var composing = false;
  var opener = null;

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function formatDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '未提供';
  }

  function textLanguage(text) {
    if (!text) return 'zh-CN';
    if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return 'ko';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\u3400-\u9fff]/.test(text)) return 'zh-CN';
    // An empty lang denotes unknown; absence of Han characters is not proof of English.
    return '';
  }

  function syncTheme() {
    var selected = document.documentElement.dataset.theme;
    var dark = selected ? selected === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    var toggle = document.getElementById('theme-toggle');
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? '切换浅色模式' : '切换深色模式');
    toggle.title = dark ? '切换浅色模式' : '切换深色模式';
    toggle.hidden = false;
  }
  syncTheme();
  document.getElementById('theme-toggle').addEventListener('click', function () {
    var dark = this.getAttribute('aria-pressed') === 'true';
    var theme = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('tas-theme', theme); } catch (_) {}
    syncTheme();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);

  function updateUrl(mode, hash) {
    var target = location.pathname + core.stateQuery(state) + (hash == null ? location.hash : hash);
    if (target === location.pathname + location.search + location.hash) return;
    try { history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', target); } catch (_) {
      // Downloaded HTML still works in browsers that restrict file URL history.
    }
  }

  function makeRow(record, position) {
    var row = element('article', 'row');
    row.setAttribute('role', 'listitem');
    row.dataset.name = record.name;
    row.dataset.stars = String(record.stars);
    row.dataset.created = record.created_at || '';
    row.dataset.seen = record.first_seen || '';
    var index = element('span', 'row-index', String(position).padStart(2, '0'));
    index.setAttribute('aria-label', '分类内第 ' + position + ' 项');
    row.append(index);
    var main = element('div', 'row-main');
    var titleLine = element('div', 'row-line');
    var heading = element('h3');
    var link = element('a', 'repo');
    var url = core.safeRepoUrl(record);
    if (!url) throw new Error('Invalid repository link.');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', record.name + '，在新标签页打开 GitHub');
    var pieces = record.name.split('/');
    link.append(element('span', 'repo-owner', pieces[0]), element('span', 'repo-slash', '/'), document.createTextNode(pieces[1]));
    heading.append(link);
    titleLine.append(heading);
    if (record.first_seen === updated) titleLine.append(element('span', 'new-badge', '本次新增'));
    main.append(titleLine);
    var summary = element('p', 'repo-summary' + (record.summary ? '' : ' missing'), record.summary || '仓库尚未提供简介');
    summary.lang = textLanguage(record.summary);
    main.append(summary);
    var details = element('button', 'row-detail', '查看详情');
    details.type = 'button';
    details.dataset.detail = record.name;
    details.setAttribute('aria-label', '查看 ' + record.name + ' 的详情');
    details.setAttribute('aria-haspopup', 'dialog');
    var arrow = element('span', '', '→');
    arrow.setAttribute('aria-hidden', 'true');
    details.append(arrow);
    main.append(details);
    row.append(main);
    var stars = element('div', 'row-stars');
    stars.append(element('span', 'mobile-label', '星数'), element('span', 'stars-value', number.format(record.stars)));
    if (record.gain_7d > 0) {
      var gain = element('span', 'stars-gain', '+' + number.format(record.gain_7d));
      gain.setAttribute('aria-label', '近 7 天新增 ' + number.format(record.gain_7d) + ' 星');
      gain.title = '近 7 天涨星';
      stars.append(gain);
    }
    var refreshed = element('time', 'stars-refreshed', formatDate(record.last_refreshed).slice(5) + ' 采集');
    if (record.last_refreshed) refreshed.dateTime = record.last_refreshed;
    refreshed.setAttribute('aria-label', '星数采集日期 ' + formatDate(record.last_refreshed));
    stars.append(refreshed);
    row.append(stars);
    var dateKey = state.sort === 'seen' ? 'first_seen' : 'created_at';
    var dateLabel = state.sort === 'seen' ? '入库' : '创建';
    var date = element('div', 'row-date');
    var time = element('time', '', formatDate(record[dateKey]));
    if (record[dateKey]) time.dateTime = record[dateKey];
    time.setAttribute('aria-label', dateLabel + '日期 ' + formatDate(record[dateKey]));
    date.append(element('span', 'mobile-label', dateLabel), time);
    row.append(date);
    return row;
  }

  function makePagination(track, total, page) {
    var container = document.getElementById(track + '-pagination');
    container.replaceChildren();
    var pages = Math.ceil(total / PAGE_SIZE);
    var start = (page - 1) * PAGE_SIZE + 1;
    container.append(element('span', '', '显示 ' + number.format(start) + '–' + number.format(Math.min(page * PAGE_SIZE, total)) + ' / ' + number.format(total)));
    if (pages < 2) return;
    var nav = element('nav');
    nav.setAttribute('aria-label', (track === 'skills' ? 'Skills' : 'AI') + ' 分页');
    var previous = element('button', 'page-button', '上一页');
    var next = element('button', 'page-button', '下一页');
    [previous, next].forEach(function (button) {
      button.type = 'button';
      button.dataset.pageTrack = track;
      button.setAttribute('aria-controls', track + '-list');
    });
    previous.dataset.page = String(page - 1);
    previous.disabled = page === 1;
    next.dataset.page = String(page + 1);
    next.disabled = page === pages;
    var position = element('span', 'page-position', page + ' / ' + pages);
    position.setAttribute('aria-label', '第 ' + page + ' 页，共 ' + pages + ' 页');
    nav.append(previous, position, next);
    container.append(nav);
  }

  function render(urlMode, anchor) {
    var matches = core.filterByCategory(core.searchRecords(records, state.q), state.category);
    var groups = core.groupRecords(core.sortRecords(matches, state.sort));
    var total = state.track === 'all' ? matches.length : groups[state.track].length;
    document.querySelector('[data-tab-count="all"]').textContent = number.format(matches.length);
    document.querySelector('[data-tab-count="skills"]').textContent = number.format(groups.skills.length);
    document.querySelector('[data-tab-count="ai"]').textContent = number.format(groups.ai.length);
    tabs.forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.track === state.track)); });
    ['skills', 'ai'].forEach(function (track) {
      var section = document.getElementById(track);
      var list = document.getElementById(track + '-list');
      var pageCount = Math.max(1, Math.ceil(groups[track].length / PAGE_SIZE));
      state.pages[track] = Math.min(Math.max(1, state.pages[track] || 1), pageCount);
      var visible = (state.track === 'all' || state.track === track) && groups[track].length > 0;
      section.hidden = !visible;
      list.replaceChildren();
      if (!visible) return;
      var page = state.pages[track];
      var start = (page - 1) * PAGE_SIZE;
      var fragment = document.createDocumentFragment();
      groups[track].slice(start, start + PAGE_SIZE).forEach(function (record, index) { fragment.append(makeRow(record, start + index + 1)); });
      list.append(fragment);
      document.getElementById(track + '-count').textContent = number.format(groups[track].length) + ' 个仓库';
      section.querySelector('[data-date-heading]').textContent = state.sort === 'seen' ? '入库日期' : '创建日期';
      var jump = section.querySelector('.section-jump');
      if (track === 'skills') jump.hidden = state.track !== 'all' || !groups.ai.length;
      makePagination(track, groups[track].length, page);
    });
    var filtered = Boolean(state.q || state.track !== 'all' || state.category !== 'all');
    count.textContent = filtered ? '找到 ' + number.format(total) + ' 个仓库' : '共 ' + number.format(records.length) + ' 个仓库';
    reset.hidden = !filtered;
    clear.hidden = !input.value;
    empty.hidden = total !== 0;
    if (!total) {
      var active = [];
      if (state.q) active.push('关键词“' + state.q + '”');
      if (state.track !== 'all') active.push(state.track === 'skills' ? 'Skills' : 'AI');
      if (state.category !== 'all') active.push('“' + categoryName(state.category) + '”领域');
      document.getElementById('empty-context').textContent = active.length
        ? '没有找到符合' + active.join('、') + '的仓库。试试更短的关键词，或清除当前筛选。'
        : '当前没有匹配的仓库。清除筛选后可查看完整目录。';
    }
    results.setAttribute('aria-busy', 'false');
    if (urlMode) updateUrl(urlMode, anchor);
  }

  function syncControls() {
    input.value = state.q;
    sort.value = state.sort;
    if (categorySelect.options.length) categorySelect.value = state.category;
  }

  function categoryName(id) {
    return (categoryNames && categoryNames[id]) || id || '其他';
  }

  function buildCategoryOptions(list) {
    categoryNames = {};
    categorySelect.replaceChildren();
    var all = element('option', '', '全部分类');
    all.value = 'all';
    categorySelect.append(all);
    (Array.isArray(list) ? list : []).forEach(function (entry) {
      if (!entry || typeof entry.id !== 'string') return;
      categoryNames[entry.id] = entry.name || entry.id;
      var option = element('option', '', (entry.name || entry.id) + ' (' + number.format(entry.count || 0) + ')');
      option.value = entry.id;
      categorySelect.append(option);
    });
  }

  function resetPages() { state.pages = { skills: 1, ai: 1 }; }

  function applySearch() {
    clearTimeout(pendingSearch);
    pendingSearch = null;
    state.q = Array.from(input.value).slice(0, 200).join('').trim();
    resetPages();
    render('replace', '');
  }

  function clearFilters() {
    clearTimeout(pendingSearch);
    pendingSearch = null;
    state.q = '';
    state.track = 'all';
    state.category = 'all';
    resetPages();
    syncControls();
    render('push', '');
    input.focus({ preventScroll: true });
  }

  function openDetails(name, trigger) {
    var record = byName.get(name);
    if (!record) return;
    opener = trigger;
    document.getElementById('dialog-track').textContent = record.track === 'skills' ? 'Skills' : 'AI';
    document.getElementById('dialog-title').textContent = record.name;
    var summary = document.getElementById('dialog-summary');
    summary.textContent = record.summary || '仓库尚未提供简介。具体用途与使用方式请查看原仓库。';
    summary.lang = textLanguage(record.summary);
    var translation = document.getElementById('dialog-translation');
    translation.hidden = !record.summary_en || record.summary_en === record.summary;
    document.getElementById('dialog-summary-en').textContent = record.summary_en || '';
    var meta = document.getElementById('dialog-meta');
    meta.replaceChildren();
    [['星数', number.format(record.stars)], ['7 天涨星', record.gain_7d > 0 ? '+' + number.format(record.gain_7d) : '—'], ['领域分类', categoryName(record.category)], ['星数采集', formatDate(record.last_refreshed)], ['创建日期', formatDate(record.created_at)], ['首次入库', formatDate(record.first_seen)]].forEach(function (pair) {
      var item = element('div');
      item.append(element('dt', '', pair[0]), element('dd', '', pair[1]));
      meta.append(item);
    });
    document.getElementById('dialog-repo').href = core.safeRepoUrl(record);
    dialog.showModal();
  }

  function showError(error) {
    results.hidden = true;
    results.setAttribute('aria-busy', 'false');
    empty.hidden = true;
    document.getElementById('error-state').hidden = false;
    count.textContent = '目录加载失败';
    console.error('Catalog could not be displayed:', error);
  }

  document.getElementById('retry').addEventListener('click', function () { location.reload(); });

  try {
    if (!core) throw new Error('Catalog logic is unavailable.');
    var payload = JSON.parse(document.getElementById('catalog-data').textContent);
    records = core.prepareRecords(payload.records);
    if (!records.length || records.some(function (record) { return !core.safeRepoUrl(record); })) throw new Error('Catalog data is invalid.');
    updated = payload.updated;
    byName = new Map(records.map(function (record) { return [record.name, record]; }));
    buildCategoryOptions(payload.categories);
    state = core.readState(location.search);
    syncControls();
    render('replace');
    input.disabled = false;
    sort.disabled = false;
    categorySelect.disabled = false;
    tabs.forEach(function (button) { button.disabled = false; });
  } catch (error) {
    showError(error);
    return;
  }

  input.addEventListener('compositionstart', function () { composing = true; clearTimeout(pendingSearch); pendingSearch = null; });
  input.addEventListener('compositionend', function () { composing = false; applySearch(); });
  input.addEventListener('input', function () {
    clear.hidden = !input.value;
    if (composing) return;
    clearTimeout(pendingSearch);
    pendingSearch = setTimeout(applySearch, 120);
  });
  form.addEventListener('submit', function (event) { event.preventDefault(); if (!composing) applySearch(); });
  clear.addEventListener('click', function () { input.value = ''; applySearch(); input.focus(); });
  reset.addEventListener('click', clearFilters);
  document.getElementById('empty-reset').addEventListener('click', clearFilters);
  tabs.forEach(function (button) {
    button.addEventListener('click', function () {
      clearTimeout(pendingSearch);
      pendingSearch = null;
      state.q = input.value.trim();
      state.track = button.dataset.track;
      resetPages();
      render('push', '');
    });
  });
  sort.addEventListener('change', function () {
    clearTimeout(pendingSearch);
    pendingSearch = null;
    state.q = input.value.trim();
    state.sort = sort.value;
    resetPages();
    render('push', '');
  });
  categorySelect.addEventListener('change', function () {
    clearTimeout(pendingSearch);
    pendingSearch = null;
    state.q = input.value.trim();
    state.category = categorySelect.value;
    resetPages();
    render('push', '');
  });
  results.addEventListener('click', function (event) {
    if (pendingSearch !== null) {
      clearTimeout(pendingSearch);
      pendingSearch = null;
      if (state.q !== input.value.trim()) {
        applySearch();
        input.focus({ preventScroll: true });
        return;
      }
    }
    var detail = event.target.closest('[data-detail]');
    if (detail) { openDetails(detail.dataset.detail, detail); return; }
    var page = event.target.closest('[data-page-track]');
    if (!page || page.disabled) return;
    state.pages[page.dataset.pageTrack] = Number(page.dataset.page);
    render('push', '#' + page.dataset.pageTrack);
    var heading = document.getElementById(page.dataset.pageTrack + '-title');
    heading.focus({ preventScroll: true });
    document.getElementById(page.dataset.pageTrack).scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  dialog.querySelector('.close-dialog').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab') return;
    var focusable = Array.from(dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(function (node) { return node.getClientRects().length > 0; });
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  dialog.addEventListener('click', function (event) {
    if (event.target !== dialog) return;
    var box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  dialog.addEventListener('close', function () {
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', function (event) {
    var target = event.target;
    var editing = target.closest('input, select, textarea, [contenteditable="true"]');
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !dialog.open) {
      event.preventDefault(); input.focus();
    }
    if (event.key === 'Escape' && target === input && input.value && !composing) {
      event.preventDefault(); input.value = ''; applySearch();
    }
  });
  window.addEventListener('popstate', function () {
    clearTimeout(pendingSearch);
    pendingSearch = null;
    var closedName = dialog.open && opener ? opener.dataset.detail : null;
    if (dialog.open) { opener = null; dialog.close(); }
    state = core.readState(location.search);
    syncControls();
    render();
    if (closedName) {
      var sameRecord = Array.from(results.querySelectorAll('[data-detail]')).find(function (button) { return button.dataset.detail === closedName; });
      var section = document.getElementById(state.track === 'ai' ? 'ai' : 'skills');
      var destination = sameRecord || (!section.hidden && section.querySelector('h2')) || input;
      destination.focus({ preventScroll: true });
    }
  });
})();
