(function () {
  'use strict';
  var core = window.GrowthCore;
  var catalogCore = window.CatalogCore;
  var activityCore = window.StarActivityCore;
  var section = document.getElementById('growth');
  if (!core || !catalogCore || !section) return;
  var catalog;
  try { catalog = JSON.parse(document.getElementById('catalog-data').textContent); }
  catch (_) { return; }
  var rows = catalogCore.prepareRecords(catalog.records);
  var byName = new Map(rows.map(function (item) { return [item.name, item]; }));
  var periods = core.WINDOWS;
  var state = {window: '7', track: 'all', category: 'all', query: '', page: 1};
  var source = {schema: 1, as_of: null, snapshot_days: 0, records: {}};
  var ready = false;
  var activityReady = false;
  var activitySource = {schema:1, records:{}, coverage:{total:0,sampled:0,fresh:0}};
  var perPage = 12;
  var list = document.getElementById('growth-list');
  var status = document.getElementById('growth-status');
  var asOf = document.getElementById('growth-asof');
  var pages = document.getElementById('growth-pages');
  var queryInput = document.getElementById('growth-query');
  var trackInput = document.getElementById('growth-track');
  var categoryInput = document.getElementById('growth-category');
  var formatter = new Intl.NumberFormat('en-US');

  function make(tag, className, content) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = String(content);
    return el;
  }
  function signed(value) { return value > 0 ? '+' + formatter.format(value) : formatter.format(value); }
  function percentage(value) { return value == null ? '不适用' : (value > 0 ? '+' : '') + value.toFixed(2) + '%'; }
  function activeDate() { return source.as_of ? source.as_of.slice(0,16).replace('T',' ') + ' UTC' : '尚无可靠 Star 快照'; }

  function readHash() {
    if (!location.hash.startsWith('#growth?')) return false;
    var params = new URLSearchParams(location.hash.slice('#growth?'.length));
    var selection = params.get('window');
    var track = params.get('track');
    var category = params.get('category');
    var page = params.get('page');
    state.window = periods.includes(selection) ? selection : '7';
    state.track = ['all', 'skills', 'ai'].includes(track) ? track : 'all';
    state.category = (catalog.categories || []).some(function (c) { return c.id === category; }) ? category : 'all';
    state.query = Array.from(params.get('q') || '').slice(0, 200).join('');
    state.page = /^[1-9]\d*$/.test(page || '') && Number.isSafeInteger(Number(page)) ? Number(page) : 1;
    return true;
  }
  function syncInputs() {
    queryInput.value = state.query;
    trackInput.value = state.track;
    categoryInput.value = state.category;
    document.querySelectorAll('[data-growth-window]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.growthWindow === state.window));
    });
  }
  function storeHash() {
    var params = new URLSearchParams();
    if (state.window !== '7') params.set('window', state.window);
    if (state.track !== 'all') params.set('track', state.track);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.query) params.set('q', state.query);
    if (state.page > 1) params.set('page', String(state.page));
    var fragment = '#growth?' + params.toString();
    if (location.hash === fragment) return;
    try { history.pushState(null, '', location.pathname + location.search + fragment); }
    catch (_) { location.hash = 'growth'; }
  }
  function svgChart(history, days, width, height) {
    var points = core.points(history, days);
    if (points.length < 2) return null;
    var documentNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(documentNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Star 变化趋势，从 ' + points[0][0] + ' 的 ' + formatter.format(points[0][1]) + ' 到 ' + points[points.length - 1][0] + ' 的 ' + formatter.format(points[points.length - 1][1]));
    var stamps = points.map(function (p) { return Date.parse(p[0] + 'T00:00:00Z'); });
    var minTime = stamps[0];
    var maxTime = stamps[stamps.length-1];
    var values = points.map(function (p) { return p[1]; });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var pad = 4;
    var prevTime = null;
    var segments = [];
    var path = '';
    points.forEach(function (p, index) {
      var x = pad + (stamps[index] - minTime) / (maxTime - minTime || 1) * (width - pad*2);
      var y = pad + (max === min ? 0.5 : (max - p[1]) / (max - min)) * (height - pad*2);
      // A missing day is deliberately not drawn as an unbroken line.
      if (prevTime != null && stamps[index] - prevTime > 1.5 * 86400000) {
        if (path) segments.push(path);
        path = '';
      }
      path += (path ? 'L' : 'M') + x.toFixed(2) + ',' + y.toFixed(2);
      prevTime = stamps[index];
    });
    if (path) segments.push(path);
    segments.forEach(function (d) {
      var line = document.createElementNS(documentNS, 'path');
      line.setAttribute('d', d);
      svg.appendChild(line);
    });
    return svg;
  }
  function drawRow(item, rank) {
    var row = make('article', 'growth-item');
    row.setAttribute('role','listitem');
    row.append(make('span', 'growth-rank', String(rank).padStart(2, '0')));
    var identity = make('div','growth-identity');
    var link = make('a','growth-name',item.name);
    var url = catalogCore.safeRepoUrl(item.catalog);
    if (url) { link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    else { link.removeAttribute('href'); }
    identity.append(link);
    identity.append(make('span','growth-summary',item.catalog.summary || '暂无简介'));
    // The source is disclosed once for the entire ranking; keep row metadata
    // focused on the values that can differ between repositories.
    var metadata = make('small', 'growth-meta');
    metadata.append(
      make('span', '', item.catalog.track === 'skills' ? 'Skills' : 'AI'),
      make('span', '', formatter.format(item.growth.stars) + ' 星')
    );
    var measurementDate = item.activity ? item.windowEnd : item.reported ? item.refreshed : '';
    if (measurementDate) {
      var date = make('time', '', '截至 ' + measurementDate);
      date.dateTime = measurementDate;
      metadata.append(date);
    }
    identity.append(metadata);
    row.append(identity);
    var delta = make('span','growth-delta',signed(item.metric.delta));
    if (item.metric.delta < 0) delta.classList.add('negative');
    delta.setAttribute('aria-label', (item.activity ? '当前仍有效的新增 ' : '窗口净增 ') + signed(item.metric.delta) + ' 星');
    if (item.activity) delta.title = 'GitHub 官方 Star History API：按创建日期统计当前仍有效的 Star，不含取消 Star 事件';
    else if (item.reported) delta.title = '数据源：目录 gain_7d 字段，尚未经本站日快照独立核验';
    row.append(delta, make('span','growth-rate',percentage(item.metric.rate)));
    var spark = make('div','growth-spark');
    var chartData = item.activity ? item.growth.activity_history : item.growth.history;
    var svg = svgChart(chartData, state.window.indexOf('30') >= 0 ? 30 : 7, 120, 36);
    if (svg) {
      if (item.activity) svg.setAttribute('aria-label', 'GitHub 历史新增 Star 每日变化，非净涨星');
      spark.append(svg);
    }
    else if (item.reported) spark.append(make('span','growth-spark-empty','待积累历史'));
    row.append(spark);
    return row;
  }
  function drawPagination(totalPages, total) {
    pages.replaceChildren();
    if (totalPages < 2) { pages.hidden = true; return; }
    pages.hidden = false;
    var previous = make('button','','上一页');
    previous.type = 'button'; previous.disabled = state.page === 1;
    previous.addEventListener('click', function () {state.page--; storeHash(); render(); section.focus({preventScroll:true});});
    var next = make('button','','下一页');
    next.type = 'button'; next.disabled = state.page === totalPages;
    next.addEventListener('click', function () {state.page++; storeHash(); render(); section.focus({preventScroll:true});});
    pages.append(previous, make('span','',state.page + ' / ' + totalPages + '，共 ' + total + ' 个项目'), next);
  }
  function render() {
    syncInputs();
    var coverage = source.coverage;
    asOf.textContent = '采集时间：' + activeDate() +
      (coverage && Number.isInteger(coverage.total) ? '  |  覆盖 ' + formatter.format(coverage.collected) + ' / ' + formatter.format(coverage.total) : '');
    list.replaceChildren();
    if (!ready && !activityReady) { status.textContent = '正在加载 Star 历史数据…'; pages.hidden = true; return; }
    var ranking = core.rank(rows, source.records, state.window, state);
    var usingArchive = false;
    if (!ranking.length && activityReady && activityCore) {
      ranking = activityCore.rank(rows, activitySource.records, state.window, state, new Date().toISOString().slice(0, 10), 2);
      usingArchive = ranking.length > 0;
    }
    var usingReported = false;
    if (!ranking.length && (state.window === '7' || state.window === 'rate7')) {
      ranking = core.reportedRank(rows, state.window, state, catalog.updated, 2);
      usingReported = ranking.length > 0;
    }
    var total = ranking.length;
    var sourceKind = usingArchive ? 'activity' : usingReported ? 'reference' : total ? 'net' : 'activity';
    var ratioLabel = sourceKind === 'activity' ? '新增占比' : sourceKind === 'reference' ? '参考占比' : '净增长率';
    var column = section.querySelector('.growth-headings span:nth-child(4)');
    if (column) column.textContent = ratioLabel;
    document.querySelector('[data-growth-window="rate7"]').textContent = '7 天' + ratioLabel;
    document.querySelector('[data-growth-window="rate30"]').textContent = '30 天' + ratioLabel;
    section.dataset.metric = sourceKind;
    if (!total) {
      var scope = activitySource.coverage || {};
      status.textContent = '当前窗口尚无可比较数据。官方历史采集覆盖 ' + formatter.format(scope.sampled || 0) +
        ' / ' + formatter.format(scope.total || rows.length) + ' 个项目，可切换 7 天参考榜；真实净变化会按天积累。';
      pages.hidden = true; return;
    }
    var totalPages = Math.max(1, Math.ceil(total / perPage));
    state.page = Math.min(state.page, totalPages);
    var start = (state.page - 1) * perPage;
    var fragment = document.createDocumentFragment();
    ranking.slice(start,start + perPage).forEach(function (row,index) { fragment.append(drawRow(row,start+index+1)); });
    list.append(fragment);
    if (usingArchive) {
      var archiveCoverage = activitySource.coverage || {};
      var period = state.window === '1' ? '最近一个完整统计日（不是滚动 24 小时）'
        : state.window.indexOf('30') >= 0 ? '最近 30 个完整统计日' : '最近 7 个完整统计日';
      status.textContent = '官方历史新增：' + formatter.format(total) + ' 个项目。' + period +
        '，按创建日期统计目前仍有效的 Star；不是净涨星。';
      asOf.textContent = '历史覆盖 ' + formatter.format(archiveCoverage.sampled || 0) + '/' +
        formatter.format(archiveCoverage.total || rows.length) + '  |  最近采集 ' +
        String(activitySource.updated_at || '').slice(0, 16).replace('T',' ') + ' UTC';
    } else if (usingReported) {
      status.textContent = '目录参考：' + formatter.format(total) + ' 项，来自原有 gain_7d 字段，尚未经独立历史快照复核。';
      asOf.textContent = '目录更新 ' + catalog.updated + '  |  实测快照 ' + (source.snapshot_days || 0) + ' 天';
    } else {
      status.textContent = '实测净涨星：' + formatter.format(total) + ' 个项目具备完整窗口数据。';
      asOf.textContent = '实测截至 ' + activeDate();
    }
    drawPagination(totalPages,total);
  }
  (catalog.categories || []).forEach(function (cat) {
    if (!cat || !cat.id) return;
    var option = make('option','',cat.name || cat.id);
    option.value = cat.id;
    categoryInput.append(option);
  });
  document.querySelectorAll('[data-growth-window]').forEach(function (button) {
    button.addEventListener('click',function () {state.window=this.dataset.growthWindow;state.page=1;storeHash();render();});
  });
  trackInput.addEventListener('change',function () {state.track=this.value;state.page=1;storeHash();render();});
  categoryInput.addEventListener('change',function () {state.category=this.value;state.page=1;storeHash();render();});
  queryInput.addEventListener('input',function () {state.query=Array.from(this.value).slice(0,200).join('');state.page=1;storeHash();render();});
  document.getElementById('growth-form').addEventListener('submit',function (event) {event.preventDefault();});
  window.addEventListener('popstate',function () { if (readHash()) render(); });
  window.addEventListener('hashchange',function () { if (readHash()) render(); });

  // Enrich the existing catalog's project details, preserving its original
  // search, sorting, keyboard flow and safe GitHub links.
  var detail = document.getElementById('repo-dialog');
  var chartSection = make('section','growth-detail-chart');
  chartSection.append(make('h3','', 'Star 历史趋势'));
  var controls = make('div','growth-chart-controls');
  var graphic = make('div','growth-detail-graphic');
  var caption = make('p','growth-chart-caption','历史数据积累中');
  [7,30,90,0].forEach(function (days) {
    var button = make('button','',days === 0 ? '全部历史' : days + ' 天');
    button.type = 'button'; button.dataset.days = String(days);
    button.setAttribute('aria-pressed',String(days === 30));
    button.addEventListener('click',function () {
      controls.querySelectorAll('button').forEach(function (b) {b.setAttribute('aria-pressed',String(b===button));});
      updateDetail(days);
    });
    controls.append(button);
  });
  chartSection.append(controls,graphic,caption);
  detail.querySelector('.dialog-body').append(chartSection);
  var activeDetailName = null;
  function updateDetail(days) {
    graphic.replaceChildren();
    var current = activeDetailName && source.records[activeDetailName];
    if (!current || !Array.isArray(current.history) || current.history.length < 2) {
      var activity = activeDetailName && activitySource.records[activeDetailName];
      if (activity && Array.isArray(activity.days) && activity.days.length >= 2) {
        var fromActivity = activity.days;
        var spark = svgChart(fromActivity, days && days < 30 ? days : 30, 600, 142);
        if (spark) {
          spark.setAttribute('aria-label', 'GitHub 官方历史每日新增且目前仍有效的 Star');
          graphic.append(spark);
        }
        var shown = core.points(fromActivity, days && days < 30 ? days : 30);
        caption.textContent = 'GitHub 官方日新增数据：' + shown[0][0] + ' 至 ' + shown[shown.length-1][0] +
          '。仅统计当前仍有效的 Star，不代表历史净涨星。';
        return;
      }
      var reported = activeDetailName && byName.get(activeDetailName);
      caption.textContent = reported && reported.gain_7d
        ? '目录参考：近 7 天变化 ' + signed(reported.gain_7d) + ' 星（' + reported.last_refreshed + ' 更新，未经日快照核验）。真实历史趋势仍在积累。'
        : '历史数据积累中。暂时没有可信的 Star 历史曲线。';
      return;
    }
    var pts = core.points(current.history,days);
    var chart = svgChart(current.history,days,600,142);
    if (chart) graphic.append(chart);
    caption.textContent = pts.length < 2
      ? '只有 ' + pts.length + ' 个有效历史快照，尚不足以绘制趋势。'
      : pts[0][0] + ' 至 ' + pts[pts.length-1][0] + '，' + formatter.format(pts[0][1]) + ' → ' + formatter.format(pts[pts.length-1][1]) + ' 星。缺失日期不连接曲线。';
  }
  var mainResults = document.getElementById('results');
  mainResults.addEventListener('click',function (event) {
    var button = event.target.closest('[data-detail]');
    if (!button) return;
    activeDetailName = button.dataset.detail;
    controls.querySelectorAll('button').forEach(function (b) {b.setAttribute('aria-pressed',String(b.dataset.days==='30'));});
    updateDetail(30);
  });

  readHash(); syncInputs(); render();
  if (location.hash.startsWith('#growth?')) section.scrollIntoView({block:'start',behavior:'instant'});
  // Actions commits made with GITHUB_TOKEN may not trigger GitHub Pages
  // redeploys. Fetch the current public repository data first, keeping the
  // deployed local JSON as an offline/availability fallback.
  function fetchGrowth(url) {
    return fetch(url,{cache:'no-store'})
      .then(function (response) {if (!response.ok) throw new Error('HTTP '+response.status);return response.json();});
  }
  fetchGrowth('https://raw.githubusercontent.com/longkum/trending-agent-skills/main/data/star-growth.json?at=' + Date.now())
    .catch(function () {return fetchGrowth('data/star-growth.json');})
    .then(function (payload) {
      if (!payload || payload.schema !== 1 || typeof payload.records !== 'object' || Array.isArray(payload.records)) throw new Error('无效的涨星数据格式');
      source = payload; ready=true; render();
      if (activeDetailName) updateDetail(30);
    })
    .catch(function (error) {
      ready=true;
      render();
      asOf.textContent = '历史快照不可用，目录参考数据截至 ' + catalog.updated;
      console.warn('Growth data unavailable:',error.message);
    });
  // Official daily history is distinct from observed net changes. The REST
  // endpoint groups currently active Stars by creation date; unstars are not
  // recoverable and must never be modeled as a zero-delta event.
  fetchGrowth('https://raw.githubusercontent.com/longkum/trending-agent-skills/main/data/star-activity.json?at=' + Date.now())
    .catch(function () { return fetchGrowth('data/star-activity.json'); })
    .then(function (payload) {
      if (!payload || payload.schema !== 1 || payload.source !== 'github-rest-star-history' ||
          !payload.records || typeof payload.records !== 'object' || Array.isArray(payload.records)) {
        throw new Error('Invalid official Star history format');
      }
      activitySource = payload; activityReady = true; render();
      if (activeDetailName) updateDetail(30);
    })
    .catch(function (error) {
      activityReady = true; render();
      console.warn('Official Star history unavailable:', error.message);
    });
})();
