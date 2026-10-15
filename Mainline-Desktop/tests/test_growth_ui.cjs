// Render the production view functions against legacy and recurring-task fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');
const context = vm.createContext({
  state: {today:'2026-10-15', projects:[], goals:[], notes:[], tasks:[],settings:{areas:[]}}, search:'', projectFilter:'',projectArea:'',selectedProjectId:'',notesScope:'all',showArchivedNotes:false,showDone:false,expandedProjects:new Set(),
  esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  hours:v=>v+'分钟', repeatNames:{weekly:'每周',daily:'每天',none:'不重复'},
  fmtDate:v=>v, dateObject:v=>new Date(v+'T12:00:00'), color:()=> '#4263eb', taskCard:t=>`<div class="test-task">${t.title}</div>`,
  empty:t=>`<p>${t}</p>`,
});
vm.runInContext(`
  function project(id){return state.projects.find(p=>p.id===id);}
  function activeTasks(){return state.tasks.filter(t=>!t.deleted_at);}
  function visibleTasks(){return activeTasks().filter(t=>(showDone||t.status!=='done')&&(!projectFilter||t.project_id===projectFilter));}
  ${source.slice(source.indexOf('function homeTasks()'),source.indexOf('function qIndex('))}
  function addDays(day,n){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
  ${source.slice(source.indexOf('function projectKind('),source.indexOf('function overviewView('))}
  ${source.slice(source.indexOf('function projectProgress('),source.indexOf('function trashView('))}
  ${source.slice(source.indexOf('function goalsView('),source.indexOf('function openGoal('))}
  ${source.slice(source.indexOf('function notesView('),source.indexOf('function readFocus('))}
`, context);
const render = expression => vm.runInContext(expression, context);
assert.match(render("projectProgress({id:'old',name:'旧项目'})"), /未评估/);
assert.doesNotMatch(render("projectProgress({id:'old',name:'旧项目'})"), /aria-valuenow=/);
assert.match(render("projectProgress({id:'p',name:'实验',progress:0})"), /aria-valuenow="0"/);
assert.match(render("projectProgress({id:'p',name:'实验',progress:62.5})"), /width:62.5%/);
assert.equal(render("projectProgress({id:'a',name:'聚餐',project_type:'activity',progress:50})"), '');
assert.equal(render("projectProgress({id:'c',name:'通信组',area:'通信组',progress:90})"), '');

context.state.settings.areas=['通信组','生活与关系'];
context.state.projects=[
  {id:'c',name:'通信组',area:'通信组',progress:90},
  {id:'p',name:'示例研究项目',area:'通信组',owner:'项目负责人',project_type:'project',progress:40},
  {id:'a',name:'聚餐',area:'通信组',project_type:'activity',progress:50,tracks:[{title:'准备',percent:50}]},
];
context.state.tasks=[{id:'event',title:'预订餐厅',kind:'event',project_id:'c',status:'todo'}];
let categories=render('projectsView()');
assert.match(categories, /通信组/);
assert.doesNotMatch(categories, /progressbar|总体进度|项目进度|40%|示例研究项目/);
context.projectArea='通信组';
let inside=render('projectsView()');
assert.match(inside, /示例研究项目/);
assert.match(inside, /项目负责人/);
assert.match(inside, /aria-valuenow="40"/);
assert.match(inside, /预订餐厅/);
context.selectedProjectId='p';
let detail=render('projectsView()');
assert.match(detail,/编辑项目与进度/);
assert.match(detail,/示例研究项目/);
assert.doesNotMatch(detail,/预订餐厅/);
context.selectedProjectId='';
assert.doesNotMatch(render("projectCards([state.projects[2]])"), /progressbar|50%/);
context.search='项目负责人';context.projectArea='';
assert.match(render('projectsView()'), /通信组/);
assert.doesNotMatch(render('projectsView()'), /生活与关系/);
context.search='';context.state.projects=[];context.state.tasks=[];

context.state.tasks=[
  {id:'repeat-done',repeat:'daily',status:'done',occurrence:'2026-10-15'},
  {id:'repeat-future',repeat:'daily',status:'todo',occurrence:'2026-10-16'},
  {id:'repeat-today',repeat:'daily',status:'todo',occurrence:'2026-10-15'},
  {id:'repeat-overdue',repeat:'weekly',status:'todo',deadline:'2026-10-14'},
  {id:'long-project',repeat:'none',status:'todo',deadline:'2026-12-01'},
];
context.showDone=true;
assert.deepEqual(Array.from(render('homeTasks().map(t=>t.id)')),['repeat-today','repeat-overdue','long-project']);
context.showDone=false;
context.state.tasks=[];

context.state.goals = [{id:'g',title:'研究方向',status:'active',next_review:'2026-10-22'}];
context.state.tasks = [
  {id:'h1',title:'阅读积累',kind:'habit',goal_id:'',repeat:'weekly',status:'done',duration:30,completed_at:'2026-10-15T10:00:00'},
  {id:'h2',repeat_parent:'h1',title:'阅读积累',kind:'habit',goal_id:'g',repeat:'weekly',status:'todo',duration:30,occurrence:'2026-10-22'},
  {id:'t',title:'整理研究问题',kind:'task',goal_id:'g',status:'todo'},
  {id:'i',title:'运动',kind:'habit',goal_id:'',repeat:'daily',status:'todo',duration:30},
];
let html = render('goalsView()');
assert.equal((html.match(/<h3>阅读积累<\/h3>/g)||[]).length, 1, 'A relinked habit series must appear once with its full history.');
assert.match(html, /最近 7 天完成 1 次/);
assert.match(html, /已完成 1 次/);
assert.match(html, /等待下一次/);
assert.match(html, /整理研究问题/);
assert.equal((html.match(/<h3>运动<\/h3>/g)||[]).length, 1);
assert.ok(html.indexOf('<h3>运动</h3>') > html.indexOf('class="independent-growth"'));
context.search = '阅读积累';
html = render('goalsView()');
assert.match(html, /研究方向/);
assert.doesNotMatch(html, /<h3>运动<\/h3>/);
context.search = '';
context.state.goals[0].status = 'paused';
assert.match(render('goalsView()'), /已实现与暂时搁置/);
context.state.goals[0].deleted_at = '2026-10-15';
html = render('goalsView()');
assert.match(html, /<h3>阅读积累<\/h3>/, 'Habits linked to a missing goal remain visible as independent investments.');
assert.doesNotMatch(html, /class="goal-card/);
context.state.projects=[{id:'p',name:'示例研究项目',area:'通信组',project_type:'project'}];
context.state.notes=[
  {id:'n1',title:'整体反思',content:'需要保护思考时间',project_id:'',created_at:'2026-10-15T10:00:00',updated_at:'2026-10-15T10:00:00',deleted_at:''},
  {id:'n2',title:'方案判断',content:'先验证可行性',project_id:'p',created_at:'2026-10-15T11:00:00',updated_at:'2026-10-15T11:00:00',deleted_at:''},
];
context.notesScope='all';context.search='';
assert.match(render('notesView()'), /整体反思/);
assert.match(render('notesView()'), /方案判断/);
context.notesScope='p';
assert.match(render('notesView()'), /方案判断/);
assert.doesNotMatch(render('notesView()'), /<h3>整体反思<\/h3>/);
context.state.notes[1].deleted_at='2026-10-15T12:00:00';
assert.doesNotMatch(render('notesView()'), /<h3>方案判断<\/h3>/);
const uiElements={'#ai-result':{innerHTML:''},'#conversation-history':{innerHTML:''}};
context.$=selector=>uiElements[selector];
context.fmtTime=value=>value.slice(11,16);
context.currentJob={archived_at:'2026-10-15T12:00:00',application_summary:'已新增：示例任务',result:{summary:'已整理安排',tasks:[{title:'示例任务'}],updates:[]}};
context.state.messages=[{role:'assistant',mode:'application',content:'已新增：示例任务',created_at:'2026-10-15T12:00:00'}];
vm.runInContext(source.slice(source.indexOf('function renderAI()'),source.indexOf('function renderPlan()')),context);
render('renderAI()');
assert.match(uiElements['#ai-result'].innerHTML,/已整理安排/);
assert.doesNotMatch(uiElements['#ai-result'].innerHTML,/proposal|应用所选建议/);
render('renderHistory()');
assert.match(uiElements['#conversation-history'].innerHTML,/应用记录/);
assert.match(uiElements['#conversation-history'].innerHTML,/已新增：示例任务/);
context.currentJob={applied:[],result:{summary:'建议先建立项目',projects:[{name:'示例新项目',area:'通信组',project_type:'project',owner:'项目负责人'}],tasks:[],updates:[]}};
render('renderAI()');
assert.match(uiElements['#ai-result'].innerHTML,/建议新建 1 个项目/);
assert.match(uiElements['#ai-result'].innerHTML,/value="project:0"/);
assert.match(uiElements['#ai-result'].innerHTML,/应用所选建议/);
console.log('Growth UI rendering checks passed.');
