const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/data/star-growth.json': 'data/star-growth.json',
  '/data/star-activity.json': 'data/star-activity.json',
  '/data/repos.json': 'data/repos.json',
};
const TYPES = {'html':'text/html; charset=utf-8', 'json':'application/json; charset=utf-8'};
const screenshots = path.join(ROOT, '.artifacts');
fs.mkdirSync(screenshots, {recursive:true});

function startServer() {
  const server = http.createServer((req,res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const name = FILES[pathname];
    if (!name) {res.writeHead(404); res.end(); return;}
    const filename = path.join(ROOT,name);
    res.writeHead(200, {'Content-Type':TYPES[name.split('.').pop()] || 'application/octet-stream'});
    fs.createReadStream(filename).pipe(res);
  });
  return new Promise(resolve => server.listen(0,'127.0.0.1',() => resolve(server)));
}

async function checkPage(browser,base,width,height) {
  const page = await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  const errors=[];
  page.on('pageerror',err=>errors.push(String(err)));
  // Use this checkout's ACTUAL collected JSON, not synthetic fixture data.
  for (const filename of ['star-growth.json','star-activity.json']) {
    await page.route(new RegExp('/data/' + filename.replace('.', '\\.') + '(?:\\?|$)'), async route => {
      await route.fulfill({
        status:200,
        contentType:'application/json',
        body:fs.readFileSync(path.join(ROOT,'data',filename)),
      });
    });
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(base+'/#growth', {waitUntil:'domcontentloaded'});
  const first = page.locator('#growth-list .growth-item');
  await page.waitForFunction(() => document.querySelectorAll('#growth-list .growth-item').length > 0,
    null,{timeout:20000});
  assert.ok((await first.count())>0, 'default 7-day ranking should be populated');
  assert.match(await page.locator('#growth-status').innerText(),/官方历史新增|实测净涨星/);
  const searchLabel = await page.locator('.growth-filters-row label:first-child > span').boundingBox();
  assert.ok(searchLabel && searchLabel.height <= 23, 'Search label should remain on one line');
  if (width <= 620) {
    const cssRatioLabel = await page.locator('.growth-rate').first()
      .evaluate(el => getComputedStyle(el, '::before').content);
    assert.match(cssRatioLabel, /新增占比/, 'Official growth shares must not be mislabeled as net growth');
    const tabs = await page.locator('.growth-windows button').evaluateAll(buttons =>
      buttons.map(b => ({top: Math.round(b.getBoundingClientRect().top), width: Math.round(b.getBoundingClientRect().width)})));
    assert.equal(new Set(tabs.map(t => t.top)).size, 2, 'Five time windows should occupy balanced 3+2 rows');
    assert.equal(tabs[0].top, tabs[2].top);
    assert.equal(tabs[3].top, tabs[4].top);
  }
  await page.locator('#growth').screenshot({path:path.join(screenshots,'growth-'+width+'.png')});

  for (const view of ['1','7','30','rate7','rate30']) {
    await page.locator('[data-growth-window="' + view + '"]').click();
    assert.ok((await first.count())>0, view+' window is empty');
    assert.equal(await page.locator('[data-growth-window="'+view+'"]').getAttribute('aria-pressed'),'true');
  }
  await page.locator('[data-growth-window="7"]').click();
  const firstRank=await page.locator('.growth-rank').first().innerText();
  assert.equal(firstRank,'01');
  await page.locator('#growth-pages button').last().click();
  assert.equal(await page.locator('.growth-rank').first().innerText(),'13');
  await page.locator('#growth-pages button').first().click();

  await page.locator('#growth-query').fill('morluto/rea');
  assert.equal(await first.count(),1,'search should narrow to a matching historical record');
  await page.locator('#growth-query').fill('');
  await page.locator('#growth-track').selectOption('ai');
  const aiCount=await first.count();
  assert.ok(aiCount>0,'AI category has official history records');
  await page.locator('#growth-track').selectOption('all');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth-window.innerWidth);
  assert.ok(overflow<=2,'horizontal overflow of '+overflow+'px at viewport '+width);

  await page.locator('#skills-list [data-detail]').first().click();
  assert.equal(await page.locator('#repo-dialog').evaluate(x=>x.open),true,'detail modal opens');
  assert.ok((await page.locator('.growth-chart-caption').innerText()).length>15);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#repo-dialog').evaluate(x=>x.open),false,'Escape closes detail');

  await page.reload({waitUntil:'domcontentloaded'});
  assert.equal(await page.locator('[data-growth-window="7"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[],'runtime JavaScript errors');
  await page.close();
  return {width,rows:aiCount,overflow};
}

(async()=>{
  const server=await startServer();
  const port=server.address().port;
  const candidate=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium'].find(fs.existsSync);
  let browser;
  try {
    browser=await chromium.launch({
      headless:true,
      ...(candidate?{executablePath:candidate}:{}),
      args:['--no-sandbox','--disable-dev-shm-usage']
    });
    for(const [width,height] of [[1440,1000],[390,844]]) {
      const outcome=await checkPage(browser,'http://127.0.0.1:'+port,width,height);
      console.log('Growth browser smoke passed:',JSON.stringify(outcome));
    }
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(err=>{console.error(err);process.exitCode=1;});
