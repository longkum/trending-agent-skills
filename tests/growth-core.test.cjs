const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/growth-core.js');

const catalog = [
  {name:'org/z', track:'skills', category:'design', stars:90, summary:'design tools'},
  {name:'org/a', track:'ai', category:'coding', stars:80, summary:'coding tools'},
  {name:'org/missing', track:'skills', category:'coding', stars:1, summary:'no history'},
  {name:'org/zero', track:'ai', category:'coding', stars:1, summary:'coding baseline'},
];
const metric = (delta,baseline)=>({delta,baseline,rate:baseline?100*delta/baseline:null,rate_rankable:baseline>=10});
const growth = {
  'org/z':{stars:120,windows:{'1':metric(10,110),'7':metric(20,100),'30':null}},
  'org/a':{stars:100,windows:{'1':metric(10,90),'7':metric(20,80),'30':null}},
  'org/zero':{stars:1,windows:{'1':metric(1,0),'7':metric(1,0),'30':null}},
};

test('only verified complete windows can rank, never missing/zero-inferred',()=>{
  assert.deepEqual(Core.rank(catalog,growth,'30',{}).map(x=>x.name),[]);
  assert.deepEqual(Core.rank(catalog,growth,'1',{}).map(x=>x.name),['org/z','org/a','org/zero']);
});
test('absolute delta ties break on latest Star count then stable names',()=>{
  assert.deepEqual(Core.rank(catalog,growth,'7',{}).map(x=>x.name),['org/z','org/a','org/zero']);
});
test('rate rank excludes low baseline and orders by rate',()=>{
  assert.deepEqual(Core.rank(catalog,growth,'rate7',{}).map(x=>x.name),['org/a','org/z']);
});
test('search, track, domain filter are combined, NFKC and case-insensitive',()=>{
  assert.deepEqual(Core.rank(catalog,growth,'7',{track:'ai',category:'coding',query:'ＣＯＤＩＮＧ'}).map(x=>x.name),['org/a','org/zero']);
});
test('negative net Star deltas are not rounded to zero',()=>{
  const x = {...growth,'org/a':{stars:50,windows:{'7':metric(-30,80)}}};
  assert.equal(Core.rank(catalog,x,'7',{})[2].metric.delta,-30);
});
test('trend series preserves missing days instead of fabricating intervening values',()=>{
  assert.deepEqual(Core.points([['2026-10-01',10],['2026-10-03',30]],7),[['2026-10-01',10],['2026-10-03',30]]);
  assert.deepEqual(Core.points([['2026-09-01',1],['2026-10-03',3]],7),[['2026-10-03',3]]);
});

test('reported 7-day fallback gives real catalog metrics without fabricating history', () => {
  const rows = [
    {name:'org/fast', track:'skills', category:'coding', stars:120, gain_7d:20, last_refreshed:'2026-10-31', summary:'Fast Agent'},
    {name:'org/stale', track:'skills', category:'coding', stars:400, gain_7d:200, last_refreshed:'2026-10-26', summary:'Stale'},
    {name:'org/bad', track:'skills', category:'coding', stars:4, gain_7d:9, last_refreshed:'2026-10-31', summary:'Bad'},
    {name:'org/zero', track:'skills', category:'coding', stars:200, gain_7d:0, last_refreshed:'2026-10-31', summary:'Zero'},
    {name:'org/ai', track:'ai', category:'design', stars:900, gain_7d:40, last_refreshed:'2026-10-30', summary:'Design Agent'},
  ];
  const original = JSON.stringify(rows);
  const ranking = Core.reportedRank(rows, '7', {}, '2026-10-31', 2);
  assert.deepEqual(ranking.map(x=>x.name), ['org/ai','org/fast']);
  assert.equal(ranking[1].metric.baseline, 100);
  assert.equal(ranking[1].metric.rate, 20);
  assert.equal(ranking[1].reported, true);
  assert.deepEqual(ranking[1].growth.history, []);
  assert.equal(JSON.stringify(rows), original);
  assert.deepEqual(Core.reportedRank(rows, '1', {}, '2026-10-31', 2), []);
  assert.deepEqual(Core.reportedRank(rows, '30', {}, '2026-10-31', 2), []);
});

test('reported growth-rate ranking excludes weak baselines, supports filtering and old dates', () => {
  const rows = [
    {name:'org/low', track:'skills', category:'coding', stars:19, gain_7d:15, last_refreshed:'2026-10-31', summary:'Agent'},
    {name:'org/mid', track:'skills', category:'coding', stars:20, gain_7d:10, last_refreshed:'2026-10-31', summary:'Agent'},
    {name:'org/large', track:'skills', category:'coding', stars:110, gain_7d:10, last_refreshed:'2026-10-29', summary:'Agent'},
    {name:'org/other', track:'ai', category:'design', stars:50, gain_7d:25, last_refreshed:'2026-10-31', summary:'Agent'},
  ];
  assert.deepEqual(Core.reportedRank(rows,'rate7',{track:'skills',category:'coding',query:'ＡＧＥＮＴ'},'2026-10-31',2)
      .map(x=>x.name), ['org/mid','org/large']);
  assert.equal(Core.reportedRank(rows,'rate7',{track:'skills'},'2026-10-31',2)[0].metric.rate,100);
  assert.equal(Core.reportedRank(rows,'7',{},'2026-10-27',2).length,0);
  assert.equal(Core.reportedRank(rows,'7',{},'invalid-date',2).length,0);
});
