// Reuse the production interaction tests against the separately staged edition.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const testPath = path.resolve(__dirname,'../tests/test_writing_ui.cjs');
let source = fs.readFileSync(testPath,'utf8');
const original = "const root = path.resolve(__dirname, '..');";
if (source.split(original).length !== 2) throw new Error('Review UI test harness after source changes.');
source = source.replace(original, 'const root = '+JSON.stringify(path.resolve(__dirname,'.build/1.0/source'))+';');
source = source.replace(" def public(self): return {'models':[], 'default':'', 'error':''}", " def public(self): return {'models':[], 'default':'', 'error':''}\n def public_config(self): return {'configured':False, 'models':[], 'use_opencode':False}");
source = source.replace('await page.goto(base);', `await page.goto(base);
    await until(()=>page.evaluate(()=>Array.isArray(state.settings.workdays)));
    let reminderFixture={configured:false,enabled:false,include_titles:false,used_today:0,daily_limit:5,background_enabled:false,background_exists:false,background_state:'off',background_task_name:'Mainline-Personal-Reminders',background_interval_minutes:5,background_target:''};
    await page.route('**/api/serverchan-config', route=>route.fulfill({json:reminderFixture}));
    for(const [stateName,label,exists,active] of [['off','开启关窗后提醒',false,false],['needs_repair','修复关窗后提醒',true,false],['active','关闭关窗后提醒',true,true]]) {
      reminderFixture={...reminderFixture,background_state:stateName,background_exists:exists,background_enabled:active};
      await page.locator('[data-action=settings]').first().click();
      await page.locator('#settings-dialog').waitFor({state:'visible'});
      assert.equal(await page.locator('#background-reminders-button').innerText(),label);
      assert.equal(await page.locator('#background-disable').isHidden(),!exists||active);
      assert.match(await page.locator('#background-details').innerText(),/Mainline 安装版 1.0/);
      await page.locator('[data-close=settings-dialog]').click();
    }
    await page.unroute('**/api/serverchan-config');`);
const test = new Module(testPath, module);
test.filename = testPath;
test.paths = module.paths;
test._compile(source,testPath);
