const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/star-activity-core.js');
const dates = Array.from({length:30}, (_,i) => `2026-10-${String(i+1).padStart(2,'0')}`);
const series = (daily=1)=>dates.map(d=>[d,daily]);
const fixture=(name,stars,daily=1,override={})=> ({name,track:'skills',category:'coding',stars,summary:'Code Agent',...override});
function api(stars,daily=1,extra={}) {return {source:'github-rest-star-history',stars,window_end:'2026-10-30',collected_at:'2026-10-31T06:20:00Z',days:series(daily),...extra};}
const catalog=[fixture('org/a',110),fixture('org/z',260,1,{track:'ai'}),fixture('org/empty',40)];
const cache={'org/a':api(110,2),'org/z':api(260,1),'org/empty':api(40,0)};

test('all five windows populated by authentic daily bucket counts',()=>{
  const today='2026-10-31';
  const expected=[['1',2],['7',14],['30',60],['rate7',14],['rate30',60]];
  for(const [window,count] of expected){
    const ranked=Core.rank(catalog,cache,window,{},today);
    assert.equal(ranked[0].name,'org/a');
    assert.equal(ranked[0].metric.delta,count);
    assert.equal(ranked[0].activity,true);
    assert.equal(ranked.length,2);
  }
});
test('current star total minus created cohort determines reference denominator',()=>{
  const [entry]=Core.rank(catalog,cache,'rate7',{},'2026-10-31');
  assert.equal(entry.metric.baseline,96);
  assert.equal(entry.metric.rate,100*14/96);
});
test('rate views reject small baseline and zero baseline, absolute views still show positives',()=>{
  const tiny=[fixture('org/low',20)];const c={'org/low':api(20,2)};
  assert.equal(Core.rank(tiny,c,'7',{},'2026-10-31').length,1);
  assert.equal(Core.rank(tiny,c,'rate7',{},'2026-10-31').length,0);
  assert.equal(Core.rank(tiny,c,'rate30',{},'2026-10-31').length,0);
});
test('stale and broken history are excluded, never substituted with zero',()=>{
  const invalid={...cache,'org/a':api(110,2,{window_end:'2026-10-19'})};
  assert.deepEqual(Core.rank(catalog,invalid,'7',{},'2026-10-31').map(x=>x.name),['org/z']);
  invalid['org/a']=api(110,2,{days:series(2).slice(1)});
  assert.deepEqual(Core.rank(catalog,invalid,'7',{},'2026-10-31').map(x=>x.name),['org/z']);
});
test('filters combine and search is Unicode-normalized',()=>{
  assert.deepEqual(Core.rank(catalog,cache,'1',{track:'ai',query:'ＡＧＥＮＴ'},'2026-10-31').map(x=>x.name),['org/z']);
  assert.equal(Core.rank(catalog,cache,'30',{category:'design'},'2026-10-31').length,0);
});
test('invalid date & illegal period do not rank',()=>{
  for(const period of ['72','rate1','']) assert.deepEqual(Core.rank(catalog,cache,period,{},'2026-10-31'),[]);
  assert.deepEqual(Core.rank(catalog,cache,'1',{},'2026-02-30'),[]);
});
test('source cannot be silently reinterpreted as verified net Star gain',()=>{
  const ranked=Core.rank(catalog,cache,'7',{},'2026-10-31');
  assert.ok(ranked.every(x=>x.activity && !x.reported && !x.growth.history.length));
});