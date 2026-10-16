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
    page.setDefaultTimeout(8000);
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
    const body = page.locator('#writing-editor .vditor-wysiwyg pre[contenteditable=true]');
    await body.waitFor();
    await until(() => page.locator('#writing-fallback').isHidden());
    assert.equal(await page.locator('#note-dialog').evaluate(el => Math.round(el.getBoundingClientRect().width)), 1440);
    const selectText = async (surface, text, collapsed = false) => surface.evaluate((el, {text, collapsed}) => {
      el.focus();
      if (el instanceof HTMLTextAreaElement) {
        const start = el.value.indexOf(text); if (start < 0) throw new Error('Synthetic source text not found');
        el.setSelectionRange(collapsed ? start + text.length : start, start + text.length); return;
      }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) {
        const start = node.textContent.indexOf(text);
        if (start < 0) continue;
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + text.length);
        if (collapsed) range.collapse(false);
        getSelection().removeAllRanges(); getSelection().addRange(range); return;
      }
      throw new Error('Synthetic text not found: ' + text);
    }, {text, collapsed});
    const command = name => page.locator('#writing-editor button[data-type="' + name + '"]');
    const chooseHeading = async level => {
      await command('headings').click();
      await page.locator(level ? '#writing-editor button[data-tag="h' + level + '"]' : '#writing-editor button[data-writing-paragraph]').click();
    };
    await selectText(body, 'fictional'); await command('bold').click();
    assert.equal(await body.locator('b,strong').innerText(), 'fictional');
    assert.ok(Number(await body.locator('b,strong').evaluate(el => getComputedStyle(el).fontWeight)) >= 700);
    await command('bold').click(); assert.equal(await body.locator('b,strong').count(), 0);
    await selectText(body, 'fictional'); await page.keyboard.press('ControlOrMeta+b');
    assert.equal(await body.locator('b,strong').innerText(), 'fictional');
    await page.keyboard.press('ControlOrMeta+b'); assert.equal(await body.locator('b,strong').count(), 0);
    for (const [name, tag] of [['italic','em,i'],['strike','s,strike']]) {
      await selectText(body, 'fictional'); await command(name).click();
      assert.equal(await body.locator(tag).innerText(), 'fictional');
      await command(name).click(); assert.equal(await body.locator(tag).count(), 0);
    }
    // Opening the heading picker on an existing heading must not edit the note.
    await selectText(body, 'Observations'); await command('headings').click();
    assert.equal(await body.locator('h2').innerText(), 'Observations');
    await page.locator('#writing-editor button[data-tag=h3]').click();
    assert.equal(await body.locator('h3').innerText(), 'Observations');
    for (const level of [1,2,3,4,5,6]) {
      await selectText(body, 'Observations'); await chooseHeading(level);
      assert.equal(await body.locator('h' + level).innerText(), 'Observations');
    }
    await chooseHeading(0); assert.match(await body.locator('p').first().innerText(), /Observations/);
    for (const [name, tag] of [['list','ul li'],['ordered-list','ol li'],['quote','blockquote']]) {
      await selectText(body, 'fictional'); await command(name).click();
      assert.match(await body.locator(tag).innerText(), /fictional reflection/);
      await command(name).click(); assert.equal(await body.locator(tag).count(), 0);
    }
    await selectText(body, 'reflection.', true); await command('bold').click();
    await page.keyboard.insertText(' 加粗续写');
    assert.match(await body.locator('b,strong').innerText(), /加粗续写/);
    await command('bold').click(); await page.keyboard.insertText(' 正常续写');
    assert.doesNotMatch(await body.locator('b,strong').innerText(), /正常续写/);
    await page.keyboard.insertText(' 撤销重做检查');
    const beforeUndo = await body.innerText();
    await page.waitForTimeout(900); await command('undo').click();
    assert.notEqual(await body.innerText(), beforeUndo);
    await command('redo').click(); assert.equal(await body.innerText(), beforeUndo);
    await selectText(body, 'Observations'); await chooseHeading(3);
    await page.locator('#writing-save').click();
    await until(async () => (await getState()).notes[0].content.includes('** 加粗续写**') || (await getState()).notes[0].content.includes('**加粗续写**'));
    await command('edit-mode').click(); await page.locator('#writing-editor button[data-mode=sv]').click();
    let sourceBody = page.locator('#writing-editor textarea.vditor-sv');
    await selectText(sourceBody, 'Observations'); await chooseHeading(2); await chooseHeading(0);
    await page.locator('#writing-save').click();
    assert.doesNotMatch((await getState()).notes[0].content, /^#+ Observations/m);
    await command('edit-mode').click(); await page.locator('#writing-editor button[data-mode=ir]').click();
    const instantBody = page.locator('#writing-editor .vditor-ir pre[contenteditable=true]');
    await selectText(instantBody, 'Observations'); await chooseHeading(2); await chooseHeading(0);
    assert.equal(await instantBody.locator('h1,h2,h3,h4,h5,h6').count(), 0);
    await command('edit-mode').click(); await page.locator('#writing-editor button[data-mode=wysiwyg]').click();
    // Reopening repeatedly must not accumulate formatting handlers.
    await page.locator('#writing-back').click(); await page.locator('[data-action=edit-note]').first().click();
    await body.waitFor(); await until(() => page.locator('#writing-fallback').isHidden());
    await selectText(body, 'fictional'); await command('bold').click();
    assert.match(await body.locator('b,strong').allInnerTexts().then(t => t.join('')), /fictional/);
    await command('bold').click();
    await page.setViewportSize({width:960,height:640});
    await selectText(body, 'Observations'); await command('headings').click();
    const menu = page.locator('#writing-editor button[data-type=headings]').locator('..').locator('.vditor-hint');
    assert.ok(await menu.evaluate(el => el.getBoundingClientRect().bottom <= document.querySelector('.writing-bottom').getBoundingClientRect().top));
    await page.locator('#writing-editor button[data-tag=h6]').click();
    assert.equal(await body.locator('h6').innerText(), 'Observations'); await chooseHeading(0);
    await page.setViewportSize({width:1440,height:1000});
    const beforeTitleClick = await body.innerHTML();
    await page.locator('#writing-title').focus(); await command('bold').click();
    assert.equal(await body.innerHTML(), beforeTitleClick, 'Title focus must not format an unrelated body selection');
    assert.match(await page.locator('#note-error').innerText(), /正文/);
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
    const img = page.locator('#writing-editor .vditor-wysiwyg img[src^="/note-assets/"]').first();
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
    assert.equal(await page.locator('#writing-editor .vditor-wysiwyg img[src^="/note-assets/"]').count(), 2);
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
    assert.match(await body.innerText(), /\*\*原始文字\*\*/);
    assert.equal(await body.locator('b,strong').count(), 0, 'Legacy plain text must retain its literal appearance');
    await page.locator('#writing-back').click();
    const unchanged = (await getState()).notes.find(n => n.id === legacy.id);
    assert.equal(unchanged.content, legacy.content, 'Opening an old plain-text note must not rewrite its body');
    assert.equal(unchanged.revision, legacy.revision);
    assert.deepEqual(external, [], 'Editor must not send any request to outside services');
    assert.deepEqual(failures, [], 'No missing local editor dependencies');
    assert.deepEqual(errors, [], 'No JS or CSP console errors');
    console.log('Writing UI passed: formatting toggles and shortcuts, six heading levels and paragraph in all modes, reopen, Chinese text, autosave, images, export, versions, literal legacy text, offline requests.');
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
