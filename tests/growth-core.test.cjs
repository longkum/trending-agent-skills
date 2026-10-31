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
