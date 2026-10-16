// Browser integration against a fresh synthetic store; never opens the user's data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-writing-ui-'));
  const fixture = `
import sys
sys.path.insert(0,sys.argv[1])
import server
class Models:
 entries={}; default=''
 def public(self): return {'models':[], 'default':'', 'error':''}
store=server.Store(sys.argv[2])
store.save_settings({'review_enabled':False})
note=store.note({'title':'Example journal','content':'## Observations\\n\\nA fictional reflection.','format':'markdown'})
srv=server.DeskServer(('127.0.0.1',0),store,Models())
print(srv.server_port,flush=True)
srv.serve_forever()
`;
  const child = spawn(process.env.MAINLINE_TEST_PYTHON || 'python', ['-u', '-c', fixture, root, folder], {stdio:['ignore','pipe','pipe'], windowsHide:true});
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic server startup timed out')), 15000);
      child.stdout.once('data', data => { clearTimeout(timeout); resolve(Number(String(data).trim())); });
      child.once('error', reject);
      child.stderr.on('data', data => process.stderr.write(data));
    });
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({channel:'msedge', headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:1000}, acceptDownloads:true});
    const errors = [], external = [], failures = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400) failures.push(r.url()); });
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const getState = () => page.request.get(base+'/api/state', {headers:{'X-Personal-Desk':'1'}}).then(r => r.json());
    const until = async predicate => {
      for (let i=0; i<40; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r,150)); }
      throw new Error('Timed out awaiting expected writing state');
    };
    await page.goto(base);
    await page.locator('[data-nav=notes]').click();
    await page.locator('[data-action=edit-note]').first().click();
    const body = page.locator('#writing-editor .vditor-ir pre[contenteditable=true]');
    await body.waitFor();
    await until(() => page.locator('#writing-fallback').isHidden());
    assert.equal(await page.locator('#note-dialog').evaluate(el => Math.round(el.getBoundingClientRect().width)), 1440);
    await page.locator('#writing-title').fill('虚构项目复盘');
    await body.click(); await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('中文输入、自动保存和光标保持测试。');
    await until(async () => (await getState()).notes.some(n => n.title === '虚构项目复盘' && n.content.includes('中文输入')));
    const cursor = await page.evaluate(() => ({text:getSelection().focusNode?.textContent, offset:getSelection().focusOffset}));
    await page.evaluate(() => refresh());
    assert.deepEqual(await page.evaluate(() => ({text:getSelection().focusNode?.textContent, offset:getSelection().focusOffset})), cursor);
    await page.locator('#writing-font').selectOption('20');
    await page.locator('#writing-spacing').selectOption('2.2');
    assert.equal(await body.evaluate(el => getComputedStyle(el).fontSize), '20px');
    assert.equal(await body.evaluate(el => getComputedStyle(el).lineHeight), '44px');
    await page.locator('#writing-focus').click();
    assert.equal(await page.locator('#writing-focus').getAttribute('aria-pressed'), 'true');
    await page.locator('#writing-focus').click();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    await body.click(); await page.keyboard.press('ControlOrMeta+End');
    await page.locator('#writing-image').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});
    await until(async () => (await getState()).notes.some(n => n.content.includes('/note-assets/')));
    const img = page.locator('#writing-editor .vditor-ir img[src^="/note-assets/"]').first();
    await img.waitFor();
    assert.equal(await img.evaluate(el => el.complete && el.naturalWidth > 0), true);
    await body.click(); await page.keyboard.press('ControlOrMeta+End');
    await body.evaluate((el, encoded) => {
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'pasted.png', {type:'image/png'}));
      el.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:transfer}));
    }, png.toString('base64'));
    await until(async () => ((await getState()).notes[0].content.match(/\/note-assets\//g)||[]).length >= 2);
    await page.locator('#writing-save').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#writing-export').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.zip$/);
    await download.saveAs(path.join(folder,'synthetic-export.zip'));
    await page.screenshot({path:path.join(root,'qa-artifacts','writing-verified.png')});
    await page.locator('#writing-back').click();
    await page.locator('[data-action=edit-note]').first().click();
    await body.waitFor(); await until(() => page.locator('#writing-fallback').isHidden());
    assert.match(await body.innerText(), /中文输入/);
    assert.equal(await page.locator('#writing-editor .vditor-ir img[src^="/note-assets/"]').count(), 2);
    await page.locator('#writing-versions').click();
    await page.locator('.writing-version').filter({hasText:'Example journal'}).last().click();
    await page.locator('#writing-restore').click();
    await until(async () => (await getState()).notes[0].title === 'Example journal');
    await page.locator('#writing-back').click();
    await page.locator('[data-action=new-note]').first().click();
    await body.waitFor(); await until(() => page.locator('#writing-fallback').isHidden());
    await body.click(); await page.keyboard.insertText('没有标题，也能恢复的虚构草稿。');
    await until(async () => (await getState()).writing_drafts.length === 1);
    await page.locator('#writing-back').click();
    await page.locator('[data-action=recover-note-drafts]').first().click();
    await page.locator('.writing-version').first().click();
    await page.locator('#writing-restore').click();
    await until(() => page.locator('#writing-fallback').isHidden());
    assert.match(await body.innerText(), /没有标题/);
    await page.locator('#writing-title').fill('恢复的虚构草稿');
    await page.locator('#writing-save').click();
    await until(async () => (await getState()).notes.length === 2);
    await page.setViewportSize({width:960,height:640});
    assert.equal(await page.locator('#note-dialog').evaluate(el => el.scrollWidth <= innerWidth), true);
    await page.locator('#writing-back').click();
    const legacyResponse = await page.request.post(base+'/api/notes', {
      headers:{'X-Personal-Desk':'1'}, data:{title:'旧格式的虚构笔记', content:'旧格式 **原始文字**\n  保留缩进和末尾换行。\n'}
    });
    const legacy = await legacyResponse.json();
    await page.evaluate(() => refresh());
    await page.locator('.note-card').filter({hasText:'旧格式的虚构笔记'}).locator('[data-action=edit-note]').click();
    await until(() => page.locator('#writing-fallback').isHidden());
    await page.locator('#writing-back').click();
    const unchanged = (await getState()).notes.find(n => n.id === legacy.id);
    assert.equal(unchanged.content, legacy.content, 'Opening an old plain-text note must not rewrite its body');
    assert.equal(unchanged.revision, legacy.revision);
    assert.deepEqual(external, [], 'Editor must not send any request to outside services');
    assert.deepEqual(failures, [], 'No missing local editor dependencies');
    assert.deepEqual(errors, [], 'No JS or CSP console errors');
    console.log('Writing UI passed: Chinese text, autosave, refresh cursor, styles, images, paste, export, versions, draft recovery, offline requests.');
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
