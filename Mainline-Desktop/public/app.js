'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusNames = {todo:'待办', doing:'推进中', waiting:'等待他人', done:'已完成'};
const kindNames = {task:'推进任务', deep:'深度思考', habit:'长期投入', event:'固定约定'};
const repeatNames = {none:'不重复', daily:'每天', weekdays:'工作日', weekly:'每周', monthly:'每月'};
const quadNames = ['重要且紧急','重要不紧急','不重要但紧急','不重要不紧急'];
const quadHints = ['及时处理，解除当前阻塞','保护时间，让长期目标向前','委派协作，保留检查节点','暂存想法，有余力时再看'];
let state = {tasks:[],projects:[],goals:[],notes:[],files:[],notifications:[],settings:{},messages:[],focus:[],today:''};
let modelInfo = {models:[],default:''};
let view = 'home', projectFilter = '', projectArea = '', search = '', showDone = false;
let notesScope = 'all', showArchivedNotes = false;
let documentProjectId = '', documentPath = '';
let overviewMode = localStorage.getItem('desk-overview-mode') || 'week';
let overviewDate = '', selectedDay = '', aiMode = 'capture', currentJob = null, busyAI = false;
let pendingPlan = null, expandedProjects = new Set(), refreshing = false, notificationInitialized = false;
let notified = new Set(JSON.parse(localStorage.getItem('desk-notified') || '[]'));
let focusSession = readFocus();
let attachedFiles = new Set(), uploadingFiles = false;

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {method, headers:{'X-Personal-Desk':'1', ...(body !== undefined ? {'Content-Type':'application/json'} : {})},
    ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
  return result;
}
function toast(text, error = false) {
  const el = document.createElement('div'); el.className = 'toast' + (error ? ' error' : ''); el.textContent = text;
  $('#toast-container').append(el); setTimeout(() => el.remove(), error ? 7000 : 4500);
}
function dateObject(iso) {const [y,m,d] = iso.slice(0,10).split('-').map(Number); return new Date(y,m-1,d,12);}
function isoDate(date) {return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function addDays(iso,n) {const date=dateObject(iso);date.setDate(date.getDate()+n);return isoDate(date);}
function weekStart(iso) {const d=dateObject(iso);return addDays(iso,-((d.getDay()+6)%7));}
function fmtDate(iso, year=false) {if(!iso)return '';const [y,m,d]=iso.slice(0,10).split('-');return `${year?y+'年':''}${Number(m)}月${Number(d)}日`;}
function fmtTime(iso) {return iso ? iso.slice(11,16) : '';}
function endTime(task) {const start = new Date(task.scheduled_at+'+08:00');if(!Number.isFinite(start.getTime()))return '';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(start.getTime()+task.duration*60000));}
function hours(minutes) {return minutes >= 60 ? `${Math.floor(minutes/60)}小时${minutes%60?minutes%60+'分':''}` : `${minutes}分钟`;}
function project(id) {return state.projects.find(p=>p.id===id);}
function taskById(id) {return state.tasks.find(t=>t.id===id);}
function activeTasks() {return state.tasks.filter(t=>!t.deleted_at);}
function visibleTasks() {return activeTasks().filter(t=>(showDone||t.status!=='done')&&(!projectFilter||t.project_id===projectFilter)&&(!search||[t.title,t.notes,t.assignee,project(t.project_id)?.name].some(x=>String(x||'').toLowerCase().includes(search.toLowerCase()))));}
function qIndex(t) {return t.important ? (t.urgent?0:1) : (t.urgent?2:3);}
function color(p) {return /^#[0-9a-fA-F]{6}$/.test(p?.color||'')?p.color:'#4263eb';}
function colorStyle(t) {return `--project-color:${color(project(t.project_id))}`;}
function empty(title, detail, action='new-task', button='＋ 添加第一项') {return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">✦</div><h2>${esc(title)}</h2><p>${esc(detail)}</p>${action?`<button class="primary-button" data-action="${action}">${esc(button)}</button>`:''}</div>`;}
function taskCard(t, draggable=true) {
  const p=project(t.project_id);const sub=t.checklist||[];
  const tags=[];
  if(t.status==='waiting')tags.push('<span class="tag amber">等待他人</span>');
  if(t.status==='doing')tags.push('<span class="tag green">推进中</span>');
  if(t.kind==='deep')tags.push('<span class="tag">整块思考</span>');
  if(t.fixed)tags.push('<span class="tag">固定约定</span>');
  if(t.deadline&&t.deadline<state.today&&t.status!=='done')tags.push('<span class="tag red">已逾期</span>');
  else if(t.deadline===state.today&&t.status!=='done')tags.push('<span class="tag red">今天到期</span>');
  if(t.followup_date&&t.followup_date<=state.today&&t.status!=='done')tags.push('<span class="tag amber">待检查</span>');
  return `<article class="task-card${t.status==='done'?' done':''}" data-task="${t.id}" draggable="${draggable&&t.status!=='done'&&!t.fixed}">
    <label class="task-check"><input type="checkbox" data-complete="${t.id}" ${t.status==='done'?'checked':''} aria-label="${t.status==='done'?'恢复':'完成'} ${esc(t.title)}"></label>
    <div class="task-body" data-action="edit-task" data-id="${t.id}"><div class="task-title">${t.status==='waiting'?'<span class="waiting-marker" title="等待他人" aria-label="等待他人">◷</span> ':''}${esc(t.title)}</div><div class="task-meta">${p?`<span class="task-project" style="${colorStyle(t)}"><i class="color-dot"></i>${esc(p.name)}</span>`:''}${t.scheduled_at?`<span>${fmtDate(t.scheduled_at)} ${fmtTime(t.scheduled_at)}</span>`:t.deadline?`<span class="${t.deadline<=state.today&&t.status!=='done'?'task-due':''}">截止 ${fmtDate(t.deadline)}</span>`:''}</div></div><button class="task-menu" data-action="edit-task" data-id="${t.id}" aria-label="编辑 ${esc(t.title)}">⋯</button></article>`;
}
function advanceRepeat(iso,rule,anchor) {const date=dateObject(iso);if(rule==='monthly'){const year=date.getFullYear(),month=date.getMonth()+1;const max=new Date(year,month+1,0).getDate();return isoDate(new Date(year,month,Math.min(anchor,max),12));}date.setDate(date.getDate()+(rule==='weekly'?7:1));if(rule==='weekdays')while(date.getDay()===0||date.getDay()===6)date.setDate(date.getDate()+1);return isoDate(date);}
function dayTasks(day) {
  const tasks=visibleTasks(),items=tasks.filter(t=>t.scheduled_at?.slice(0,10)===day),groups=new Map();
  for(const t of activeTasks()){if(t.repeat==='none')continue;const root=t.repeat_parent||t.id;if(!groups.has(root))groups.set(root,[]);groups.get(root).push(t);}
  for(const [root,group] of groups){const sources=group.filter(t=>t.status!=='done'&&t.scheduled_at&&tasks.some(v=>v.id===t.id)).sort((a,b)=>b.scheduled_at.localeCompare(a.scheduled_at));const source=sources[0];if(!source||group.some(t=>t.scheduled_at?.slice(0,10)===day))continue;const anchor=source.repeat_day||Number(source.scheduled_at.slice(8,10));let cursor=advanceRepeat(source.scheduled_at.slice(0,10),source.repeat,anchor);for(let n=0;n<12000&&cursor<day;n++)cursor=advanceRepeat(cursor,source.repeat,anchor);if(cursor===day)items.push({...source,id:source.id,preview:true,scheduled_at:day+'T'+fmtTime(source.scheduled_at),deadline:'',followup_date:''});}
  return items.sort((a,b)=>a.scheduled_at.localeCompare(b.scheduled_at));
}
function dayDue(day) {return visibleTasks().filter(t=>t.deadline===day&&t.status!=='done');}
function scheduleChip(t, month=false) {
  if(month)return `<button class="month-pill${t.preview?' repeat-preview':''}" style="${colorStyle(t)}" data-action="edit-task" data-id="${t.id}" title="${esc(fmtTime(t.scheduled_at)+' '+t.title+(t.preview?' · 重复预览':''))}">${t.preview?'↻ ':t.fixed?'◆ ':''}${fmtTime(t.scheduled_at)} ${esc(t.title)}</button>`;
  return `<div class="schedule-chip${t.status==='done'?' done':''}${t.preview?' repeat-preview':''}" style="${colorStyle(t)}" data-task="${t.id}" draggable="${t.status!=='done'&&!t.fixed&&!t.preview}"><button class="subtle-link" style="color:inherit;padding:0;text-align:left;width:100%" data-action="edit-task" data-id="${t.id}"><time>${fmtTime(t.scheduled_at)}–${endTime(t)}${t.preview?' · 重复预览':t.fixed?' · 固定':''}</time><strong>${esc(t.title)}</strong></button></div>`;
}
function renderNavigation() {
  const projects=state.projects.filter(p=>!p.deleted_at);
  $('#project-navigation').innerHTML=categoryNames().map(area=>`<button class="project-nav-item${view==='projects'&&projectArea===area?' active':''}" data-action="open-category" data-area="${esc(area)}"><span>${esc(area)}</span></button>${projectArea===area?projects.filter(p=>projectKind(p)!=='category'&&p.area===area).map(p=>`<button class="project-nav-item nested-project" data-action="filter-project" data-id="${p.id}">${esc(p.name)}</button>`).join(''):''}`).join('');
  const select=$('#project-filter');select.innerHTML='<option value="">全部项目</option>'+projects.map(p=>`<option value="${p.id}">${esc(projectKind(p)==='category'?p.name+' · 类别事项':p.area+' / '+p.name)}</option>`).join('');select.value=projectFilter;
  $('#clear-filter').hidden=!projectFilter&&!search;$('#show-done').checked=showDone;
  $$('[data-nav]').forEach(b=>{b.classList.toggle('active',b.dataset.nav===view);b.setAttribute('aria-current',b.dataset.nav===view?'page':'false');});
}
function render() {
  renderNavigation();
  $('#project-filter').hidden=['goals','projects','notes'].includes(view);$('#show-done').closest('label').hidden=['goals','notes'].includes(view)||(view==='projects'&&!projectArea);
  $('#page-title').textContent={home:'四象限',projects:'项目',overview:'周与月',goals:'长期成长',notes:'个人笔记',habits:'长期成长',trash:'回收站'}[view];
  $('#page-eyebrow').textContent=view==='notes'?'YOUR THINKING, KEPT CLOSE':'YOUR ATTENTION, WELL PLACED';
  $('#page-description').textContent=view==='notes'?'把反思与项目判断留在这里，慢慢形成自己的脉络。':'科研、创业和生活，放在同一张全景里。';
  $('#task-search').placeholder=view==='notes'?'搜索笔记':'搜索';
  $('#plan-button').hidden=['trash','habits','goals','projects','notes'].includes(view);
  const d=dateObject(state.today);$('#date-label').textContent=`${fmtDate(state.today,true)} · 星期${'日一二三四五六'[d.getDay()]}`;
  $('#page-content').innerHTML=view==='home'?homeView():view==='projects'?projectsView():view==='overview'?overviewView():view==='goals'?goalsView():view==='notes'?notesView():view==='habits'?habitsView():trashView();
  if(view==='projects')$$('.project-card').forEach(card=>{const id=$('[data-action="edit-project"]',card)?.dataset.id;if(id&&projectKind(project(id))==='project'){const footer=$('.project-card-footer',card);for(const [action,label] of [['project-notes','✎ 项目笔记'],['project-documents','▤ 项目文档']]){const button=document.createElement('button');button.className='inline-link';button.dataset.action=action;button.dataset.id=id;button.textContent=label;footer?.append(button);}}});
  const unread=state.notifications.filter(n=>!n.read).length;$('#notification-count').textContent=unread;$('#notification-button').setAttribute('aria-label',`提醒与跟进，${unread} 条未读`);
  fillAreaOptions();renderHistory();renderFocus();renderAttachments();
}
function homeView() {
  const tasks=visibleTasks();const active=tasks.filter(t=>t.status!=='done');const today=dayTasks(state.today);
  const overdue=active.filter(t=>t.deadline&&t.deadline<state.today).length;const wait=active.filter(t=>t.status==='waiting').length;
  const stats=`<div class="mini-stats"><span class="mini-stat"><b>${active.length}</b>待推进</span><span class="mini-stat"><b>${today.filter(t=>t.status!=='done').length}</b>今日安排</span><span class="mini-stat"><b>${wait}</b>等待事项</span>${overdue?`<span class="mini-stat alert"><b>${overdue}</b>已逾期</span>`:''}</div>`;
  const welcome=activeTasks().length?'':`<div class="welcome-banner"><div><strong>把脑中的事情，先放下来。</strong><p>告诉秘书你的安排，或手动添加第一项。从一件重要的事开始。</p></div><button class="primary-button" data-action="welcome-ai">和秘书聊聊 ↗</button></div>`;
  const quadrants=`<div class="quadrants">${quadNames.map((name,q)=>{const items=tasks.filter(t=>qIndex(t)===q).sort((a,b)=>(a.status==='done')-(b.status==='done')||(a.deadline||'9999').localeCompare(b.deadline||'9999'));return `<section class="quadrant q${q}" data-quadrant="${q}" aria-label="${name}"><div class="quadrant-heading"><h2><span class="quadrant-symbol" aria-hidden="true">${['!','↗','↔','◌'][q]}</span>${name}</h2><span class="quadrant-count">${items.filter(t=>t.status!=='done').length}<button class="icon-button" data-action="new-quadrant-task" data-q="${q}" aria-label="添加${name}事项">＋</button></span></div><p class="quadrant-desc">${quadHints[q]}</p>${items.map(t=>taskCard(t)).join('')||'<div class="quadrant-empty">给注意力留一点空间</div>'}</section>`;}).join('')}</div>`;
  const checks=active.filter(t=>t.followup_date&&t.followup_date<=state.today);
  return selectedProjectSummary()+pinnedGoals()+quadrants+`${today.length?`<div class="section-label">今日节奏<button class="inline-link" data-nav="overview">看一周 / 一月 →</button></div><div class="today-lanes">${today.length?today.map(t=>taskCard(t)).join(''):'<div class="today-empty">今天还没有安排时间块。可以让秘书整理事项，再生成排期建议。</div>'}</div>`:''}${checks.length?`<div class="section-label">到了检查节点</div><div class="today-lanes">${checks.map(t=>taskCard(t,false)).join('')}</div>`:''}`;
}
function projectKind(p) {
  return p.project_type||(p.name===p.area?'category':'project');
}
function categoryNames() {
  return [...new Set([...(state.settings.areas||[]),...state.projects.filter(p=>!p.deleted_at).map(p=>p.area||'未分类')])];
}
function taskMatches(t) {return !search||[t.title,t.notes,t.assignee].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()));}
function categoryProjects(area) {return state.projects.filter(p=>!p.deleted_at&&projectKind(p)!=='category'&&(p.area||'未分类')===area);}
function categoryTasks(area) {const ids=new Set(state.projects.filter(p=>!p.deleted_at&&projectKind(p)==='category'&&p.area===area).map(p=>p.id));return activeTasks().filter(t=>ids.has(t.project_id));}
function projectMatches(p) {return !search||[p.name,p.owner,p.goal,p.area].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()))||activeTasks().some(t=>t.project_id===p.id&&taskMatches(t));}
function projectsView() {
  if(!projectArea){
    const areas=categoryNames().filter(area=>!search||area.toLowerCase().includes(search.toLowerCase())||categoryProjects(area).some(projectMatches)||categoryTasks(area).some(taskMatches));
    return `<div class="category-page-actions"><button class="primary-button" data-action="new-category">＋ 新建类别</button></div><div class="category-grid">${areas.map(area=>{const projects=categoryProjects(area),direct=categoryTasks(area).filter(t=>t.status!=='done');return `<button class="category-card" data-action="open-category" data-area="${esc(area)}"><span class="category-symbol" aria-hidden="true">▧</span><h2>${esc(area)}</h2><p>${projects.filter(p=>projectKind(p)==='project').length} 个项目 · ${projects.filter(p=>projectKind(p)==='activity').length} 个活动安排 · ${direct.length} 项类别待办</p><span class="category-enter">查看项目与事项 →</span></button>`;}).join('')}</div>${areas.length?'':empty('没有匹配的类别或项目','','','')}`;
  }
  const projects=categoryProjects(projectArea).filter(projectMatches),direct=categoryTasks(projectArea).filter(t=>(showDone||t.status!=='done')&&taskMatches(t));
  return `<div class="category-breadcrumb"><button class="inline-link" data-action="all-categories">全部类别</button><span>／</span><h2>${esc(projectArea)}</h2></div><div class="category-page-actions"><button class="quiet-button" data-action="new-category-event">＋ 活动 / 聚餐</button><button class="quiet-button" data-action="new-category-task">＋ 类别事项</button><button class="primary-button" data-action="new-project">＋ 新建项目</button></div>${projects.length?projectCards(projects):empty(search?'没有匹配的项目':'这个类别还没有具体项目','可以添加项目和负责人，或直接记录一次性安排。','','')}<section class="category-direct"><div class="growth-section-heading"><h2>类别事项与活动</h2><span>无需设置项目进度</span></div>${direct.length?direct.map(t=>taskCard(t,false)).join(''):'<p class="help-text">聚餐、会议或暂未归入具体项目的事项显示在这里。</p>'}</section>`;
}
function projectCards(projects) {
  if(!projects.length)return empty('项目','','new-project','＋ 创建项目');
  return `<div class="project-grid">${projects.map(p=>{const all=activeTasks().filter(t=>t.project_id===p.id);const ts=all.filter(t=>(showDone||t.status!=='done')&&taskMatches(t));const completed=all.filter(t=>t.status==='done').length;const ms=projectKind(p)==='project'?(p.milestones||[]):[];const doneMs=ms.filter(m=>m.done).length;const expanded=expandedProjects.has(p.id);const tracks=projectKind(p)==='project'?(p.tracks||[]):[];const trackHtml=tracks.length?`<div class="track-list">${tracks.map((tr,i)=>`<div class="track-row"><div class="track-label"><span>${esc(tr.title)}</span><span class="track-percent">${tr.percent}%</span></div><div class="progress-track track-bar" role="progressbar" aria-valuenow="${tr.percent}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(tr.title)} 进度 ${tr.percent}%"><div class="progress-fill" style="width:${tr.percent}%"></div></div><input type="range" min="0" max="100" step="5" value="${tr.percent}" data-track="${p.id}" data-track-index="${i}" aria-label="调整 ${esc(tr.title)} 进度"></div>`).join('')}</div>`:'';return `<section class="project-card" style="--project-color:${color(p)}"><div class="project-card-header"><h2><i class="color-dot"></i>${esc(p.name)}</h2><button class="icon-button" data-action="edit-project" data-id="${p.id}" aria-label="编辑项目 ${esc(p.name)}">⋯</button></div><div class="project-owner">${projectKind(p)==='activity'?'活动安排':'具体项目'} · 负责人：${esc(p.owner||'未填写')}</div><p class="project-goal">${esc(p.goal||'')}</p><div class="project-counts"><span>已完成 ${completed}/${all.length} 项</span><span>等待 ${all.filter(t=>t.status==='waiting').length} 项</span>${p.deadline?`<span>目标 ${fmtDate(p.deadline)}</span>`:''}</div>${projectProgress(p)}${trackHtml}${ms.length?`<div class="progress-track" aria-label="里程碑完成 ${doneMs} / ${ms.length}"><div class="progress-fill" style="width:${doneMs/ms.length*100}%"></div></div><div class="project-counts">里程碑 ${doneMs}/${ms.length}</div><div class="milestone-list">${ms.map((m,i)=>`<label class="milestone-row${m.done?' completed':''}"><input type="checkbox" data-milestone="${p.id}" data-index="${i}" ${m.done?'checked':''}><span>${esc(m.title)}</span></label>`).join('')}</div>`:''}${(expanded?ts:ts.slice(0,4)).map(t=>taskCard(t)).join('')}<div class="project-card-footer"><button class="inline-link" data-action="filter-project" data-id="${p.id}">查看事项 →</button><button class="inline-link" data-action="new-project-task" data-id="${p.id}">＋ 添加下一步</button>${ts.length>4?`<button class="inline-link" data-action="expand-project" data-id="${p.id}">${expanded?'收起':'展开全部 '+ts.length+' 项'}</button>`:''}</div></section>`;}).join('')}</div>`;
}
function overviewView() {
  let range;
  if(overviewMode==='week'){const start=weekStart(overviewDate);range=`${fmtDate(start)} — ${fmtDate(addDays(start,6))}`;}else{const date=dateObject(overviewDate);range=`${date.getFullYear()}年 ${date.getMonth()+1}月`;}
  const toolbar=`<div class="overview-toolbar"><div class="segmented" role="group" aria-label="安排范围"><button class="${overviewMode==='week'?'active':''}" data-action="overview-mode" data-mode="week" aria-pressed="${overviewMode==='week'}">一周节奏</button><button class="${overviewMode==='month'?'active':''}" data-action="overview-mode" data-mode="month" aria-pressed="${overviewMode==='month'}">一月全景</button></div><div class="period-navigation"><button class="quiet-button" data-action="period-prev" aria-label="上一${overviewMode==='week'?'周':'月'}">‹</button><strong>${range}</strong><button class="quiet-button" data-action="period-next" aria-label="下一${overviewMode==='week'?'周':'月'}">›</button><button class="quiet-button" data-action="period-today">今天</button></div></div>`;
  let grid;
  if(overviewMode==='week'){
    const start=weekStart(overviewDate);
    grid=`<div class="week-grid">${Array.from({length:7},(_,i)=>{const day=addDays(start,i),items=dayTasks(day),due=dayDue(day),minutes=items.filter(t=>t.status!=='done').reduce((n,t)=>n+t.duration,0);return `<section class="week-day${day===state.today?' today':''}" data-drop-day="${day}"><button class="day-heading" data-action="open-day" data-day="${day}"><small>周${'一二三四五六日'[i]}</small><strong class="${day===state.today?'today-number':''}">${dateObject(day).getDate()}</strong></button><div class="day-load">${minutes?hours(minutes)+' 已安排':'留有空间'}</div>${items.map(t=>scheduleChip(t)).join('')||'<div class="day-empty">暂无时间块</div>'}${due.length?`<div class="day-deadline">◇ ${due.length} 项截止</div>`:''}<button class="day-add" data-action="new-day" data-day="${day}" aria-label="为${fmtDate(day)}添加安排">＋</button></section>`;}).join('')}</div>`;
  }else{
    const date=dateObject(overviewDate),first=isoDate(new Date(date.getFullYear(),date.getMonth(),1,12)),start=weekStart(first);
    const cells=Math.ceil((((dateObject(first).getDay()+6)%7)+new Date(date.getFullYear(),date.getMonth()+1,0).getDate())/7)*7;
    grid=`<div class="month-weekdays">${[...'一二三四五六日'].map(d=>`<span>周${d}</span>`).join('')}</div><div class="month-grid">${Array.from({length:cells},(_,i)=>{const day=addDays(start,i),items=dayTasks(day),due=dayDue(day);return `<section class="month-day${dateObject(day).getMonth()!==date.getMonth()?' outside':''}${day===state.today?' today':''}" data-drop-day="${day}"><button class="day-heading" data-action="open-day" data-day="${day}" aria-label="查看${fmtDate(day)}安排"><strong>${dateObject(day).getDate()}</strong>${due.length?`<small>${due.length} 到期</small>`:''}</button>${items.slice(0,3).map(t=>scheduleChip(t,true)).join('')}${items.length>3?`<button class="month-more" data-action="open-day" data-day="${day}">另 ${items.length-3} 项 →</button>`:''}</section>`;}).join('')}</div>`;
  }
  const pending=visibleTasks().filter(t=>!t.scheduled_at&&t.status!=='done');
  const legend=`<div class="agenda-legend">${state.projects.filter(p=>!p.deleted_at&&(!projectFilter||p.id===projectFilter)).map(p=>`<span style="--project-color:${color(p)}"><i class="color-dot"></i>${esc(p.name)}</span>`).join('')}<span>◆ 固定约定</span><span>◇ 截止日期</span><span>↻ 重复预览</span></div>`;
  return toolbar+grid+legend+`<p class="overview-note">点选日期查看完整安排。拖动事项到日期后确认具体时间；固定约定在详情中修改。↻ 预览之后的重复安排，点选可编辑当前事项，完成后生成下一次。</p><div class="section-label">还未安排时间 <span>${pending.length} 项</span></div><div class="unscheduled-list">${pending.map(t=>taskCard(t)).join('')||'<p class="today-empty">当前筛选下没有未排期事项。</p>'}</div>`;
}
function projectProgress(p) {
  if(projectKind(p)!=='project')return '';
  const known=typeof p.progress==='number'&&Number.isFinite(p.progress)&&p.progress>=0&&p.progress<=100;
  return `<div class="project-overall"><div class="progress-heading"><strong>项目进度</strong><span>${known?p.progress+'%':'未评估'}</span><button class="inline-link" data-action="edit-project" data-id="${p.id}">调整</button></div><div class="progress-track overall-bar${known?'':' unassessed'}" role="progressbar" aria-label="${esc(p.name)} 项目进度${known?'':'，未评估'}" aria-valuemin="0" aria-valuemax="100" ${known?`aria-valuenow="${p.progress}"`:''}><div class="progress-fill" style="width:${known?p.progress:0}%"></div></div></div>`;
}
function selectedProjectSummary() {
  const p=project(projectFilter);if(!p||p.deleted_at)return '';
  return `<section class="selected-project-summary" style="--project-color:${color(p)}"><div class="project-card-header"><h2><i class="color-dot"></i>${esc(p.name)}</h2><button class="inline-link" data-action="project-category" data-id="${p.id}">${projectKind(p)==='category'?'查看类别':'所属类别'} →</button></div>${p.owner?`<div class="project-owner">负责人：${esc(p.owner)}</div>`:''}${p.goal?`<p class="project-goal">${esc(p.goal)}</p>`:''}${projectProgress(p)}</section>`;
}
function currentHabit(items) {
  return items.filter(t=>t.status!=='done').sort((a,b)=>(a.occurrence||a.scheduled_at||a.created_at||'').localeCompare(b.occurrence||b.scheduled_at||b.created_at||''))[0]||items.at(-1);
}
function habitCards(tasks) {
  const grouped=new Map();
  for(const t of tasks){const root=t.repeat_parent||t.id;if(!grouped.has(root))grouped.set(root,[]);grouped.get(root).push(t);}
  return [...grouped.values()].map(items=>{
    const current=currentHabit(items),completed=items.filter(t=>t.status==='done');
    const lastDays=Array.from({length:7},(_,i)=>addDays(state.today,i-6)),future=current.occurrence&&current.occurrence>state.today;
    return `<section class="habit-card"><div><h3>${esc(current.title)}</h3><div class="habit-meta">${esc(project(current.project_id)?.name||'未分项目')} · ${repeatNames[current.repeat]} · 每次 ${hours(current.duration)} · 已完成 ${completed.length} 次${future?' · 下次 '+fmtDate(current.occurrence):''}</div><div class="habit-days">${lastDays.map(day=>{const done=completed.some(t=>t.completed_at?.slice(0,10)===day);return `<div class="habit-day${done?' done':''}" aria-label="${fmtDate(day)}${done?'已完成':'未记录'}">${day===state.today?'今天':dateObject(day).getDate()+'日'}<span>${done?'✓':'·'}</span></div>`;}).join('')}</div></div><div class="habit-action"><button class="quiet-button" data-action="edit-task" data-id="${current.id}">编辑</button><button class="primary-button" data-action="complete-habit" data-id="${current.id}" ${future||current.status==='done'?'disabled':''}>${current.status==='done'?'已完成':future?'等待下一次':'记录完成'}</button></div></section>`;
  }).join('');
}
function habitsView() {return goalsView();}
function trashView() {
  const tasks=state.tasks.filter(t=>t.deleted_at&&(!search||t.title.toLowerCase().includes(search.toLowerCase()))&&(!projectFilter||t.project_id===projectFilter));
  return tasks.length?tasks.reverse().map(t=>`<article class="trash-row"><div><strong>${esc(t.title)}</strong><p>${esc(project(t.project_id)?.name||'未分项目')} · ${fmtDate(t.deleted_at)}移入回收站</p></div><button class="quiet-button" data-action="restore-task" data-id="${t.id}">恢复</button></article>`).join(''):empty('回收站是空的','','','');
}
function openDialog(id) {const d=$('#'+id);if(!d.open)d.showModal();}
function closeDialog(id) {$('#'+id).close();}
function checklistText(items) {return (items||[]).map(x=>`[${x.done?'x':' '}] ${x.title}`).join('\n');}
function parseChecklist(text) {return text.split('\n').map(x=>x.trim()).filter(Boolean).map(line=>({title:line.replace(/^\[(?:x|X| )\]\s*/,''),done:/^\[(?:x|X)\]/.test(line)}));}
function tracksText(items) {return (items||[]).map(x=>`${x.percent>=100?'[x] ':'[ ] '}${x.title}${x.percent>0&&x.percent<100?' '+x.percent+'%':''}${x.percent>=100?' 100%':''}`).join('\n');}
function parseTracks(text) {return text.split('\n').map(x=>x.trim()).filter(Boolean).map(line=>{const done=/^\[(?:x|X)\]/.test(line);const title=line.replace(/^\[(?:x|X| )\]\s*/,'');const m=title.match(/\s(\d{1,3})\s*%$/);let percent=done?100:(m?Math.min(100,Math.max(0,Number(m[1]))):0);const clean=m?title.slice(0,m.index):title;return clean?{title:clean.trim(),percent}:null;}).filter(Boolean);}
function areaChoices() {const saved=state.settings?.areas;const fromData=new Set();for(const p of state.projects||[])if(p.area)fromData.add(p.area);for(const g of state.goals||[])if(g.area)fromData.add(g.area);return [...new Set([...(Array.isArray(saved)?saved:[]),...fromData])].filter(Boolean);}
function fillAreaOptions() {$$('#area-options option, datalist#area-options option').forEach(o=>o.remove());const list=$('#area-options');if(list)list.innerHTML=areaChoices().map(a=>`<option value="${esc(a)}"></option>`).join('');}
function renderAreasEditor() {const box=$('#areas-editor');if(!box)return;box.value=(Array.isArray(state.settings?.areas)&&state.settings.areas.length?state.settings.areas:areaChoices()).join('\n');}
function openTask(t=null, defaults={}) {
  const form=$('#task-form');form.reset();$('#task-error').textContent='';
  const source={id:'',title:'',project_id:projectFilter,status:'todo',kind:'task',duration:60,important:true,urgent:false,fixed:false,deadline:'',scheduled_at:'',assignee:'',followup_date:'',repeat:'none',notes:'',checklist:[],...defaults,...(t||{})};
  $('#task-goal').innerHTML='<option value="">不关联</option>'+(state.goals||[]).filter(g=>!g.deleted_at).map(g=>`<option value="${g.id}">${esc(g.title)}</option>`).join('');
  $('#task-project').innerHTML='<option value="">未分项目</option>'+state.projects.filter(p=>!p.deleted_at).map(p=>`<option value="${p.id}">${esc(projectKind(p)==='category'?p.name+' / 类别事项':p.area+' / '+p.name)}</option>`).join('');
  for(const [key,value] of Object.entries(source)){const field=form.elements.namedItem(key);if(!field)continue;if(field.type==='checkbox')field.checked=!!value;else field.value=value??'';}
  form.elements.checklist_text.value=checklistText(source.checklist);$('#task-editor-title').textContent=t?'事项详情':'新建事项';
  $('#archive-task').hidden=!source.id;$('#start-focus').hidden=!source.id||source.status==='done'||source.kind==='event';
  openDialog('task-dialog');setTimeout(()=>form.elements.title.focus(),50);
}
function taskFormData() {
  const form=$('#task-form'),data=Object.fromEntries(new FormData(form));
  data.duration=Number(data.duration);for(const key of ['important','urgent','fixed'])data[key]=form.elements[key].checked;
  data.checklist=parseChecklist(data.checklist_text);delete data.checklist_text;const id=data.id;delete data.id;return {id,data};
}
async function saveTask(close=true) {
  if(!$('#task-form').reportValidity())return null;
  const {id,data}=taskFormData();
  const t=await api(id?'/api/tasks/'+id:'/api/tasks',id?'PATCH':'POST',data);
  if(close)closeDialog('task-dialog');await refresh();toast(id?'事项已更新':'事项已加入指挥台');return t;
}
function openProject(p=null) {
  const form=$('#project-form');form.reset();$('#project-error').textContent='';
  const source={id:'',name:'',area:projectArea||state.settings?.areas?.[0]||'',project_type:'project',owner:'',color:'#4263eb',goal:'',deadline:'',progress:null,milestones:[],tracks:[],...(p||{})};
  for(const [k,v] of Object.entries(source)){if(form.elements.namedItem(k))form.elements[k].value=v??'';}
  form.elements.milestones_text.value=checklistText(source.milestones);form.elements.tracks_text.value=tracksText(source.tracks);
  updateProjectFields();$('#project-editor-title').textContent=p?'项目详情':'新建项目';$('#delete-project').hidden=!source.id;$('#project-documents-button').hidden=!source.id||projectKind(source)!=='project';openDialog('project-dialog');
}
function updateProjectFields() {const formal=$('#project-form').elements.project_type.value==='project';$('#project-progress-fields').hidden=!formal;$('#project-milestone-fields').hidden=!formal;$('#project-form').elements.progress.disabled=!formal;}
$('#project-form').elements.project_type.addEventListener('change',updateProjectFields);
async function openProjectDocuments(id) {
  const p=project(id);
  if(!p||p.deleted_at||projectKind(p)!=='project')return toast('项目不存在，请刷新。',true);
  if($('#project-dialog').open)closeDialog('project-dialog');
  documentProjectId=id;documentPath='';$('#project-documents-title').textContent=p.name+' · 项目文档';
  $('#project-folder-path').value=p.folder_path||'';$('#project-documents-error').textContent='';
  openDialog('project-documents-dialog');await loadProjectDocuments();
}
async function loadProjectDocuments(relative='') {
  const p=project(documentProjectId),bound=!!p?.folder_path;
  $('#document-browser').hidden=!bound;
  $('[data-action="unbind-project-folder"]', $('#project-documents-dialog')).hidden=!bound;
  if(!bound){$('#document-items').innerHTML='';return;}
  $('#document-items').innerHTML='';$('#document-more').hidden=true;
  const listing=await api('/api/project-documents/'+encodeURIComponent(documentProjectId)+'?path='+encodeURIComponent(relative));
  documentPath=listing.path;$('#project-folder-path').value=listing.root;
  const parts=documentPath?documentPath.split('/'):[];
  const crumbs=[`<button class="document-crumb" data-action="document-navigate" data-path="">${esc(p.name)}</button>`];
  parts.forEach((part,i)=>crumbs.push(`<span aria-hidden="true">›</span><button class="document-crumb" data-action="document-navigate" data-path="${esc(parts.slice(0,i+1).join('/'))}">${esc(part)}</button>`));
  $('#document-breadcrumb').innerHTML=crumbs.join('');$('#document-current-folder').textContent=parts.at(-1)||'项目根目录';
  const formatSize=bytes=>bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1048576).toFixed(1)+' MB';
  $('#document-items').innerHTML=listing.items.map(item=>{const openable=/\.(pdf|docx|pptx|xlsx|txt|md|csv|png|jpe?g|gif|webp)$/i.test(item.name);
    return `<article class="document-item"><div class="document-item-icon${item.directory?' folder':''}" aria-hidden="true">${item.directory?'▤':'▧'}</div><div class="document-item-copy"><strong title="${esc(item.name)}">${esc(item.name)}</strong><small>${item.directory?'文件夹':formatSize(item.size)} · ${esc(item.modified.slice(0,10))}</small></div>${item.directory?`<button class="inline-link" data-action="document-navigate" data-path="${esc(item.path)}">进入 →</button>`:openable?`<button class="inline-link" data-action="open-project-document" data-path="${esc(item.path)}">打开 ↗</button>`:'<span class="document-item-hint">在资源管理器查看</span>'}</article>`;}).join('')||'<div class="document-empty"><span>▤</span><strong>这个文件夹还没有内容</strong><p>可以新建子文件夹，或把电脑上的文件放进来。</p></div>';
  $('#document-more').hidden=!listing.truncated;
}
async function uploadProjectDocuments(files) {
  if(!files.length)return;
  if([...files].some(file=>file.size>20_000_000))throw new Error('每个文件需在 20 MB 以内。');
  let added=0;
  try{
    for(const file of files){
      const body=new FormData();body.append('path',documentPath);body.append('file',file);
      const response=await fetch('/api/project-documents/'+encodeURIComponent(documentProjectId)+'/upload',{method:'POST',headers:{'X-Personal-Desk':'1'},body});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'文件未能放入项目文件夹。');added++;
    }
    toast(`已放入 ${added} 个文件。`);
  }finally{await loadProjectDocuments(documentPath);}
}
async function openSettings() {
  const form=$('#settings-form');$('#settings-error').textContent='';
  for(const [k,v] of Object.entries(state.settings)){const f=form.elements.namedItem(k);if(!f)continue;if(f.type==='checkbox')f.checked=!!v;else f.value=v;}
  $('#workday-picks').innerHTML=[...'一二三四五六日'].map((d,i)=>`<label><input type="checkbox" name="workday" value="${i}" ${state.settings.workdays.includes(i)?'checked':''}>周${d}</label>`).join('');
  renderAreasEditor();$('#areas-error').textContent='';
  await loadLLMProfile();
  await loadServerChanProfile();
  openDialog('settings-dialog');
}
async function loadServerChanProfile() {
  $('#serverchan-error').textContent='';$('#serverchan-key').value='';$('#serverchan-clear').checked=false;
  try {const profile=await api('/api/serverchan-config');
    $('#serverchan-enabled').checked=profile.enabled;$('#serverchan-titles').checked=profile.include_titles;
    $('#serverchan-key').placeholder=profile.configured?'已保存，留空保留':'粘贴以 SCT 开头的 SendKey';
    $('#background-reminders-button').textContent=profile.background_enabled?'关闭关窗后提醒':'开启关窗后提醒';
    $('#background-reminders-button').dataset.enabled=profile.background_enabled?'true':'false';
    $('#serverchan-status').textContent=`${profile.configured?'SendKey 已保存在本机':'尚未配置 SendKey'} · 今日已用 ${profile.used_today}/${profile.daily_limit} 次${profile.last_result==='failed'?' · 上次发送失败，未自动重试':''}`;
  } catch(error) {$('#serverchan-error').textContent=error.message;}
}
async function loadLLMProfile() {
  $('#model-config-status').textContent=`${modelInfo.source||'模型'} · ${modelInfo.models.filter(m=>m.configured).length} 个可用模型`;
  $('#llm-config-error').textContent='';$('#llm-key').value='';$('#llm-clear-key').checked=false;
  try{const profile=await api('/api/llm-config');$('#llm-provider').value=profile.provider_name;$('#llm-base').value=profile.base_url;$('#llm-models').value=profile.models.map(m=>m.id).join('\n');$('#llm-opencode').checked=profile.use_opencode;$('#llm-key').placeholder=profile.api_key_configured?'已保存，留空保留':'填写自己的密钥';$('#save-llm-config').disabled=profile.environment_active;$('#llm-config-error').textContent=profile.environment_active?'正在使用 MAINLINE 环境变量，修改环境变量后重新读取。':'';$('#llm-configuration').open=!modelInfo.models.length;}catch(error){$('#llm-config-error').textContent=error.message;}
}
function openDay(day) {
  selectedDay=day;$('#day-title').textContent=fmtDate(day,true);const tasks=dayTasks(day),due=dayDue(day),checks=visibleTasks().filter(t=>t.followup_date===day&&t.status!=='done');
  $('#day-content').innerHTML=`<div class="section-label">时间安排</div>${tasks.map(t=>t.preview?scheduleChip(t):taskCard(t,false)).join('')||'<p class="help-text">这一天还没有安排时间块。</p>'}${due.length?`<div class="section-label">截止事项</div>${due.map(t=>taskCard(t,false)).join('')}`:''}${checks.length?`<div class="section-label">进度检查</div>${checks.map(t=>taskCard(t,false)).join('')}`:''}`;openDialog('day-dialog');
}
function renderModels() {
  const select=$('#ai-model'),old=select.value;
  select.innerHTML=modelInfo.models.map(m=>`<option value="${esc(m.id)}" ${m.configured?'':'disabled'}>${esc(m.provider+' · '+m.name)}</option>`).join('');
  const wanted=state.settings.model||old||modelInfo.default;if(modelInfo.models.some(m=>m.id===wanted))select.value=wanted;
  if(!modelInfo.models.length){select.innerHTML='<option>请先配置模型</option>';$('#ai-status').innerHTML='';const setup=document.createElement('button');setup.className='inline-link';setup.dataset.action='settings';setup.textContent='配置自己的 API →';$('#ai-status').append(setup);}
}
function setAiMode(mode) {
  aiMode=mode;$$('[data-mode]', $('.assistant-modes')).forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  $('#ai-submit').textContent=mode==='capture'?'帮我梳理 ↗':mode==='review'?'回顾推进 ↗':'一起想想 ↗';
  $('#ai-mode-hint').textContent=mode==='capture'?'先整理建议，再选择加入任务':mode==='review'?'检查逾期、等待与长期投入':'结合已有项目和时间安排讨论';
  $('#ai-input').placeholder=mode==='review'?'想重点回顾什么？':'说说你的安排，或添加文件。';
}
async function submitAI(mode=aiMode, text=$('#ai-input').value) {
  if(uploadingFiles)return toast('文件正在读取，请稍等。');
  if(busyAI)return toast('秘书正在处理，请稍等。');
  busyAI=true;$('#ai-submit').disabled=true;$('#ai-status').innerHTML='<span class="loading-dot">✦</span> 正在读取现有安排并思考，请稍候……';
  try{const job=await api('/api/ai','POST',{mode,text,model:$('#ai-model').value,file_ids:mode==='test'?[]:[...attachedFiles]});localStorage.setItem('desk-last-job',job.id);await pollJob(job.id);if(mode!=='test'){$('#ai-input').value='';attachedFiles.clear();renderAttachments();}return true;}
  catch(e){$('#ai-status').textContent=e.message;toast(e.message,true);return false;}
  finally{busyAI=false;$('#ai-submit').disabled=false;}
}
async function pollJob(id) {
  const started=Date.now();
  while(Date.now()-started<240000){const job=await api('/api/jobs/'+id);if(job.status==='done'){currentJob=job;$('#ai-status').textContent=job.mode==='test'?'模型连接测试成功。':'建议已准备好。';await refresh();renderAI();return;}if(job.status==='error')throw new Error(job.error);await new Promise(r=>setTimeout(r,1300));}
  throw new Error('请求仍在处理中，可稍后在对话记录中查看结果。');
}
function renderAI() {
  if(!currentJob?.result){$('#ai-result').innerHTML='';return;}
  const result=currentJob.result,applied=new Set(currentJob.applied||[]);
  let html=`<div class="ai-reply">${esc(result.summary)}</div>`;
  if(result.questions?.length)html+=`<div class="ai-questions">${result.questions.map(q=>`<div>· ${esc(typeof q==='string'?q:JSON.stringify(q))}</div>`).join('')}</div>`;
  if(result.tasks?.length)html+=`<div class="ai-result-header">建议新增 ${result.tasks.length} 项<button class="inline-link" data-action="select-proposals">全选</button></div>`+result.tasks.map((t,i)=>{const token='task:'+i,done=applied.has(token);return `<div class="proposal${done?' proposal-applied':''}"><label class="proposal-heading"><input type="checkbox" name="proposal" value="${token}" ${done?'disabled':'checked'}><span>${esc(t.title)}${done?' · 已加入':''}</span></label><details class="proposal-info"><summary>详情</summary>${esc(project(t.project_id)?.name||'未分项目')} · ${kindNames[t.kind]} · ${hours(t.duration)}<br>${quadNames[qIndex(t)]}${t.deadline?' · 截止 '+fmtDate(t.deadline):''}${t.scheduled_at?'<br>执行 '+fmtDate(t.scheduled_at)+' '+fmtTime(t.scheduled_at):''}${t.followup_date?'<br>检查 '+fmtDate(t.followup_date):''}${t.assignee?' · '+esc(t.assignee):''}${t.repeat!=='none'?'<br>重复：'+repeatNames[t.repeat]:''}</details>${done?'':`<div class="proposal-actions"><button class="inline-link" data-action="edit-proposal" data-index="${i}">编辑后添加</button></div>`}</div>`;}).join('');
  if(result.updates?.length)html+=`<div class="ai-result-header">建议调整 ${result.updates.length} 项</div>`+result.updates.map((u,i)=>{const token='update:'+i,done=applied.has(token),task=taskById(u.id);return `<div class="proposal${done?' proposal-applied':''}"><label class="proposal-heading"><input type="checkbox" name="proposal" value="${token}" ${done?'disabled':'checked'}><span>${esc(task?.title||'已有事项')}${done?' · 已应用':''}</span></label><details class="proposal-info"><summary>详情</summary>${esc(u.reason||'建议更新事项')}<br>${Object.entries(u.changes).map(([k,v])=>esc(changeLabel(k,v))).join('<br>')}</details></div>`;}).join('');
  if((result.tasks?.length||result.updates?.length)&&[...result.tasks.map((_,i)=>'task:'+i),...result.updates.map((_,i)=>'update:'+i)].some(t=>!applied.has(t)))html+='<button class="primary-button" style="width:100%;margin-top:13px" data-action="apply-proposals">应用所选建议</button>';
  if(result.warnings?.length)html+=`<p class="help-text">${result.warnings.map(esc).join('<br>')}</p>`;
  if(currentJob.usage?.total_tokens)html+=`<div class="ai-usage">${esc(currentJob.model)} · 本次 ${currentJob.usage.total_tokens} tokens</div>`;
  $('#ai-result').innerHTML=html;
}
function changeLabel(key,value) {const labels={title:'事项',status:'状态',important:'重要',urgent:'紧急',duration:'时长',deadline:'截止',scheduled_at:'执行时间',followup_date:'检查日期',assignee:'负责人',notes:'备注',repeat:'重复',kind:'类型',project_id:'项目',fixed:'固定时间',checklist:'子任务'};let display=value;if(key==='status')display=statusNames[value]||value;if(key==='kind')display=kindNames[value]||value;if(key==='project_id')display=project(value)?.name||'未分项目';if(typeof value==='boolean')display=value?'是':'否';if(typeof value==='object')display=JSON.stringify(value);return (labels[key]||key)+'：'+(display||'清空');}
function renderHistory() {$('#conversation-history').innerHTML=state.messages.slice(-20).map(m=>`<div class="history-message"><strong>${m.role==='user'?'你':'秘书'} · ${fmtDate(m.created_at)} ${fmtTime(m.created_at)}</strong>${esc(m.content)}${m.job_id?`<div><button class="inline-link" data-action="open-job" data-id="${m.job_id}">查看这次建议 →</button></div>`:''}</div>`).join('')||'<p class="help-text">对话会保存在本机。</p>';}
function renderPlan() {
  if(!pendingPlan)return;
  $('#plan-result').innerHTML=pendingPlan.items.map((p,i)=>`<div class="plan-row"><label><input type="checkbox" name="plan-item" value="${i}" checked><span>${esc(p.title)}<small>${hours(p.duration)} · ${esc(p.reason)}</small></span></label><time>${fmtDate(p.scheduled_at)} ${fmtTime(p.scheduled_at)}</time></div>`).join('')+(pendingPlan.unplaced.length?`<div class="unplaced"><strong>这些事项还需要你的判断</strong>${pendingPlan.unplaced.map(p=>`<p style="margin:10px 0 0">${esc(p.title)}<br><small>${esc(p.reason)}</small></p>`).join('')}</div>`:'');
  if(!pendingPlan.items.length&&!pendingPlan.unplaced.length)$('#plan-result').innerHTML='<p class="help-text">当前范围没有可自动排期的未安排事项。已排期、固定约定和等待事项会保留。</p>';
  $('#apply-plan').hidden=!pendingPlan.items.length;$('#plan-count').textContent=`${pendingPlan.items.length} 项找到空档`;
}
function renderNotifications() {$('#notifications-list').innerHTML=[...state.notifications].reverse().map(n=>`<article class="notification-row${n.read?'':' unread'}"><strong>${esc(n.title)}</strong><p>${esc(n.body)}</p><small>${fmtDate(n.created_at)} ${fmtTime(n.created_at)}</small><div>${n.goal_id?`<button class="inline-link" data-action="notification-goal" data-id="${n.goal_id}" data-notification="${esc(n.id)}">回顾目标 →</button>`:''}${n.task_id?`<button class="inline-link" data-action="notification-task" data-id="${n.task_id}" data-notification="${esc(n.id)}">查看事项 →</button>`:''}${n.job_id?`<button class="inline-link" data-action="notification-job" data-id="${n.job_id}" data-notification="${esc(n.id)}">查看回顾 →</button>`:''}</div></article>`).join('')||'<p class="help-text">目前没有提醒。设置检查日期或时间安排后，秘书会持续检查。</p>';}
function deliverNotifications() {
  const unread=state.notifications.filter(n=>!n.read&&!notified.has(n.id));
  if(notificationInitialized){for(const n of unread){if('Notification'in window&&Notification.permission==='granted')new Notification(n.title,{body:n.body,tag:n.id,icon:'/favicon.svg'});if(n.job_id)toast(n.title);}}
  for(const n of unread)notified.add(n.id);
  if(notified.size>500)notified=new Set([...notified].slice(-300));localStorage.setItem('desk-notified',JSON.stringify([...notified]));notificationInitialized=true;
}
async function refresh() {
  if(refreshing)return;refreshing=true;
  try{state=await api('/api/state');if(!overviewDate)overviewDate=state.today;$('#service-status').textContent='● 本机服务运行中';$('#service-status').classList.remove('offline');if(projectFilter&&!state.projects.some(p=>p.id===projectFilter&&!p.deleted_at))projectFilter='';render();deliverNotifications();if($('#notifications-dialog').open)renderNotifications();}
  catch(e){$('#service-status').textContent='● 本机连接已断开';$('#service-status').classList.add('offline');throw e;}
  finally{refreshing=false;}
}
function openCategory(area) {projectArea=area;view='projects';location.hash='projects/'+encodeURIComponent(area);render();}
function readRoute() {const hash=location.hash.slice(1);if(hash.startsWith('projects/')){try{projectArea=decodeURIComponent(hash.slice(9));}catch{projectArea='';}view='projects';}else if(hash.startsWith('notes/')){notesScope=decodeURIComponent(hash.slice(6));view='notes';}else{view=['home','projects','overview','goals','notes','trash'].includes(hash)?hash:hash==='habits'?'goals':'home';if(view==='projects')projectArea='';if(view==='notes')notesScope='all';}}
function navigate(next) {if(next==='projects')projectArea='';if(next==='notes')notesScope='all';if(next==='habits')next='goals';view=['home','projects','overview','goals','notes','habits','trash'].includes(next)?next:'home';location.hash=view;render();}
function notesView() {
  const all=state.notes||[],projects=state.projects.filter(p=>projectKind(p)==='project'&&(!p.deleted_at||all.some(n=>n.project_id===p.id&&!n.deleted_at)));
  const active=all.filter(n=>!n.deleted_at),archived=all.filter(n=>n.deleted_at);
  const selected=project(notesScope),scopeTitle=notesScope==='all'?'所有笔记':notesScope===''?'整体笔记':selected?.name||'原项目笔记';
  const matching=n=>(notesScope==='all'||n.project_id===notesScope)&&(!search||[n.title,n.content,project(n.project_id)?.name].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase())));
  const visible=active.filter(matching).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
  const archivedVisible=showArchivedNotes?archived.filter(matching).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)):[];
  const count=id=>active.filter(n=>n.project_id===id).length;
  const scopeButton=(id,label,countValue,icon)=>`<button class="note-scope${notesScope===id?' selected':''}" data-action="notes-scope" data-scope="${esc(id)}"><span class="note-scope-icon">${icon}</span><span class="note-scope-name">${esc(label)}</span><small>${countValue}</small></button>`;
  const rail=`<aside class="note-rail" aria-label="笔记归属"><div class="note-rail-caption">笔记索引</div>${scopeButton('all','所有笔记',active.length,'◫')}${scopeButton('','整体笔记',count(''),'◈')}<div class="note-rail-caption spaced">项目笔记</div>${projects.map(p=>scopeButton(p.id,p.name,count(p.id),'◇')).join('')||'<p class="note-rail-empty">创建项目后，可以为它单独记录思考。</p>'}</aside>`;
  const noteCard=(n,isArchived=false)=>{const p=project(n.project_id),tag=p?.name||(n.project_id?'原项目':'整体思考');return `<article class="note-card${isArchived?' is-archived':''}"><div class="note-card-top"><span class="note-tag">${esc(tag)}</span><time datetime="${esc(n.updated_at)}">${fmtDate(n.updated_at.slice(0,10),true)}</time></div><h3>${esc(n.title)}</h3><p>${esc(n.content.slice(0,260))}${n.content.length>260?'…':''}</p><div class="note-card-bottom"><span>${n.content.length} 字 · ${isArchived?'已归档':'本机保存'}</span>${isArchived?`<button class="inline-link" data-action="restore-note" data-id="${esc(n.id)}">恢复笔记 ↗</button>`:`<button class="inline-link" data-action="edit-note" data-id="${esc(n.id)}">继续思考 ↗</button>`}</div></article>`;};
  const hero=`<div class="note-hero"><div class="note-hero-copy"><div class="note-hero-kicker">THOUGHTS IN PROGRESS</div><h2>给思考一个<br>安静的地方。</h2><p>记录当下的观察、项目的转折和还没想明白的问题。它们会逐渐连成你的判断脉络。</p><button class="note-hero-button" data-action="new-note">＋ 写一篇笔记 <span>↗</span></button></div><div class="note-hero-art" aria-hidden="true"><div class="note-paper paper-back"></div><div class="note-paper paper-front"><span>◌</span><i></i><i></i><i></i><i></i><b>✦</b></div></div></div>`;
  return `<div class="notes-page">${hero}<div class="note-workspace">${rail}<section class="note-main"><div class="note-list-heading"><div><div class="note-kicker">${esc(notesScope==='all'?'YOUR COLLECTION':notesScope===''?'THE BIG PICTURE':'PROJECT JOURNAL')}</div><h2>${esc(scopeTitle)}</h2><p>${visible.length} 篇笔记 · 按最近修改排列</p></div><button class="quiet-button" data-action="new-note">＋ 新建</button></div>${visible.length?`<div class="note-grid">${visible.map(n=>noteCard(n)).join('')}</div>`:`<div class="note-empty"><span>✎</span><h3>${search?'没有找到相关笔记':'从第一篇开始'}</h3><p>${search?'试试其他关键词。':'写下此刻的观察。想法不必完整，之后还可以继续修改。'}</p><button class="primary-button" data-action="new-note">写一篇笔记</button></div>`}<div class="note-archive-toggle"><button class="inline-link" data-action="toggle-archived-notes">${showArchivedNotes?'收起':'查看'}归档笔记 · ${archived.filter(matching).length}</button></div>${archivedVisible.length?`<div class="note-grid archived-grid">${archivedVisible.map(n=>noteCard(n,true)).join('')}</div>`:''}</section></div></div>`;
}
function openNote(note=null,projectId='') {
  if(note===undefined)return toast('笔记不存在，请刷新。',true);
  const form=$('#note-form');form.reset();$('#note-error').textContent='';
  const projects=state.projects.filter(p=>projectKind(p)==='project'&&(!p.deleted_at||p.id===note?.project_id));
  $('#note-project').innerHTML='<option value="">整体笔记</option>'+projects.map(p=>`<option value="${esc(p.id)}">${esc(p.area)} / ${esc(p.name)}</option>`).join('');
  form.elements.id.value=note?.id||'';form.elements.title.value=note?.title||'';form.elements.content.value=note?.content||'';
  form.elements.project_id.value=note?.project_id||projectId||'';
  if(form.elements.project_id.value!==String(note?.project_id||projectId||''))form.elements.project_id.value='';
  $('#note-editor-title').textContent=note?'继续写这篇笔记':'写一篇笔记';$('#note-archive').hidden=!note;openDialog('note-dialog');
  form.elements.title.focus();
}
function readFocus() {try{return JSON.parse(localStorage.getItem('desk-focus')||'null');}catch{return null;}}
function persistFocus() {if(focusSession)localStorage.setItem('desk-focus',JSON.stringify(focusSession));else localStorage.removeItem('desk-focus');}
function focusElapsed() {if(!focusSession)return 0;return focusSession.elapsed+(focusSession.running?Math.max(0,Date.now()-focusSession.resumedAt):0);}
function renderFocus() {
  const bar=$('#focus-bar');bar.hidden=!focusSession;if(!focusSession)return;
  const remain=Math.max(0,focusSession.target*60000-focusElapsed()),seconds=Math.ceil(remain/1000);
  bar.innerHTML=`<div class="focus-bar"><div><strong>${esc(focusSession.title)}</strong><small>${focusSession.running?'专注进行中':'已暂停'} · 目标 ${hours(focusSession.target)}</small></div><time>${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}</time><div class="focus-bar-actions"><button class="quiet-button" data-action="pause-focus">${focusSession.running?'暂停':'继续'}</button><button class="primary-button" data-action="finish-focus">结束并记录</button></div></div>`;
  if(remain===0&&!focusSession.notified){focusSession.notified=true;persistFocus();toast('专注时间到了，可以结束记录或继续投入。');if('Notification'in window&&Notification.permission==='granted')new Notification('专注时间已到',{body:focusSession.title});}
}
async function finishFocus() {
  const minutes=Math.min(1440,Math.floor(focusElapsed()/60000));
  if(minutes>0)await api('/api/focus','POST',{id:focusSession.id,task_id:focusSession.taskId,minutes});
  focusSession=null;persistFocus();await refresh();toast(minutes?'已记录 '+minutes+' 分钟真实专注时间':'专注不足一分钟，已结束，未计入时长。');
}
async function action(name, button) {
  const id=button?.dataset.id;
  const extension = await extendedAction(name, button);if(extension) return;
  if(name==='project-documents')return openProjectDocuments(id);
  if(name==='project-documents-from-editor')return openProjectDocuments($('#project-form').elements.id.value);
  if(name==='choose-project-folder'){
    if(!window.pywebview?.api?.choose_folder)return toast('网页模式请直接填写文件夹的完整路径。',true);
    const chosen=await window.pywebview.api.choose_folder();if(chosen)$('#project-folder-path').value=chosen;return;
  }
  if(name==='bind-project-folder'||name==='create-project-root'){
    const path=$('#project-folder-path').value.trim();if(!path)return toast('请先选择或填写文件夹位置。',true);
    await api('/api/project-documents/'+encodeURIComponent(documentProjectId)+'/bind','POST',{path,create:name==='create-project-root'});
    await refresh();documentPath='';await loadProjectDocuments();return toast(name==='create-project-root'?'文件夹已创建并关联。':'项目文件夹已关联。');
  }
  if(name==='unbind-project-folder'){
    await api('/api/project-documents/'+encodeURIComponent(documentProjectId)+'/bind','POST',{path:''});
    await refresh();documentPath='';$('#project-folder-path').value='';await loadProjectDocuments();return toast('已解除关联，电脑上的文件没有删除。');
  }
  if(name==='document-navigate')return loadProjectDocuments(button.dataset.path||'');
  if(name==='show-create-subfolder'){$('#document-create-row').hidden=false;$('#document-new-folder-name').focus();return;}
  if(name==='cancel-create-subfolder'){$('#document-create-row').hidden=true;$('#document-new-folder-name').value='';return;}
  if(name==='create-project-subfolder'){
    const input=$('#document-new-folder-name');await api('/api/project-documents/'+encodeURIComponent(documentProjectId)+'/mkdir','POST',{path:documentPath,name:input.value});
    input.value='';$('#document-create-row').hidden=true;await loadProjectDocuments(documentPath);return toast('文件夹已创建。');
  }
  if(name==='document-upload')return $('#project-document-upload').click();
  if(name==='open-project-folder'||name==='open-project-document'){
    await api('/api/project-documents/'+encodeURIComponent(documentProjectId)+'/open','POST',{path:name==='open-project-folder'?documentPath:button.dataset.path});return;
  }
  if(name==='new-note')return openNote(null,notesScope==='all'?'':notesScope);
  if(name==='edit-note')return openNote((state.notes||[]).find(n=>n.id===id));
  if(name==='project-notes'){notesScope=id;view='notes';location.hash='notes/'+encodeURIComponent(id);return render();}
  if(name==='notes-scope'){notesScope=button.dataset.scope;view='notes';location.hash=notesScope==='all'?'notes':'notes/'+encodeURIComponent(notesScope);return render();}
  if(name==='toggle-archived-notes'){showArchivedNotes=!showArchivedNotes;return render();}
  if(name==='archive-note'){
    const noteId=$('#note-form').elements.id.value;if(!noteId)return;
    if(!confirm('将这篇笔记归档？内容会保留，可随时恢复。'))return;
    await api('/api/notes/'+noteId,'DELETE',{});closeDialog('note-dialog');await refresh();return toast('笔记已归档，可以在归档中恢复。');
  }
  if(name==='restore-note'){await api('/api/notes/'+id,'PATCH',{restore:true});await refresh();return toast('笔记已恢复。');}
  if(name==='new-task')return openTask();
  if(name==='new-project')return openProject();
  if(name==='new-category'){$('#category-form').reset();$('#category-error').textContent='';return openDialog('category-dialog');}
  if(name==='open-category')return openCategory(button.dataset.area);
  if(name==='all-categories'){projectArea='';return navigate('projects');}
  if(name==='project-category'){const p=project(id);if(p)return openCategory(p.area);return;}
  if(name==='new-category-task'||name==='new-category-event'){let p=state.projects.find(p=>!p.deleted_at&&projectKind(p)==='category'&&p.area===projectArea);if(!p){p=await api('/api/categories','POST',{name:projectArea});await refresh();}return openTask(null,{project_id:p.id,kind:name==='new-category-event'?'event':'task',fixed:name==='new-category-event'});}
  if(name==='new-habit')return openTask(null,{project_id:'',kind:'habit',repeat:'weekly',duration:30});
  if(name==='new-quadrant-task'){const q=Number(button.dataset.q);return openTask(null,{important:q<2,urgent:q===0||q===2});}
  if(name==='edit-task'){const t=taskById(id);if(!t)return toast('事项已变化，请刷新。',true);if($('#day-dialog').open)closeDialog('day-dialog');return openTask(t);}
  if(name==='edit-project')return openProject(project(id));
  if(name==='new-project-task')return openTask(null,{project_id:id});
  if(name==='filter-project'){projectFilter=id;view='home';location.hash='home';return render();}
  if(name==='clear-filter'){projectFilter='';search='';$('#task-search').value='';return render();}
  if(name==='expand-project'){expandedProjects.has(id)?expandedProjects.delete(id):expandedProjects.add(id);return render();}
  if(name==='settings')return openSettings();
  if(name==='toggle-assistant')return $('#assistant-panel').classList.toggle('open');
  if(name==='welcome-ai'){$('#assistant-panel').classList.add('open');$('#ai-input').focus();return;}
  if(name==='ai-submit')return submitAI();
  if(name==='test-api'){button.disabled=true;$('#model-config-status').textContent='正在测试当前模型的真实连接……';try{const ok=await submitAI('test','');$('#model-config-status').textContent=ok?'连接成功 · '+$('#ai-model').selectedOptions[0].textContent:'连接测试未完成 · '+$('#ai-status').textContent;}finally{button.disabled=false;}return;}
  if(name==='reload-models'){modelInfo=await api('/api/models/reload','POST',{});renderModels();await loadLLMProfile();return toast('模型配置已重新读取');}
  if(name==='save-llm-config'){
    button.disabled=true;$('#llm-config-error').textContent='';
    try{modelInfo=await api('/api/llm-config','POST',{provider_name:$('#llm-provider').value,base_url:$('#llm-base').value,models:$('#llm-models').value.split('\n').map(s=>s.trim()).filter(Boolean),api_key:$('#llm-key').value.trim(),clear_api_key:$('#llm-clear-key').checked,use_opencode:$('#llm-opencode').checked});$('#llm-key').value='';state.settings.model=modelInfo.default;renderModels();await loadLLMProfile();toast('模型配置已保存');}catch(error){$('#llm-config-error').textContent=error.message;}finally{button.disabled=false;}return;
  }
  if(name==='save-serverchan'){
    button.disabled=true;$('#serverchan-error').textContent='';
    try {await api('/api/serverchan-config','POST',{sendkey:$('#serverchan-key').value.trim(),enabled:$('#serverchan-enabled').checked,include_titles:$('#serverchan-titles').checked,clear_sendkey:$('#serverchan-clear').checked});await loadServerChanProfile();toast('微信提醒设置已保存');}
    catch(error){$('#serverchan-error').textContent=error.message;}finally{button.disabled=false;}return;
  }
  if(name==='test-serverchan'){
    button.disabled=true;$('#serverchan-error').textContent='';
    try {const result=await api('/api/serverchan-test','POST',{});await loadServerChanProfile();toast(result.sent?'测试消息已提交到 Server酱':'发送失败；本次请求仍占用今日额度',!result.sent);}
    catch(error){$('#serverchan-error').textContent=error.message;}finally{button.disabled=false;}return;
  }
  if(name==='toggle-background-reminders'){
    button.disabled=true;$('#serverchan-error').textContent='';
    try {const enable=button.dataset.enabled!=='true';await api('/api/background-reminders','POST',{enabled:enable});await loadServerChanProfile();toast(enable?'关窗后提醒已开启':'关窗后提醒已关闭');}
    catch(error){$('#serverchan-error').textContent=error.message;}finally{button.disabled=false;}return;
  }
  if(name==='select-proposals'){$$('input[name=proposal]:not(:disabled)').forEach(c=>c.checked=true);return;}
  if(name==='edit-proposal'){const t=currentJob.result.tasks[Number(button.dataset.index)];return openTask(null,t);}
  if(name==='apply-proposals'){const selected=$$('input[name=proposal]:checked:not(:disabled)').map(c=>c.value);if(!selected.length)return toast('请至少选择一项建议。');button.disabled=true;try{const r=await api('/api/ai/apply','POST',{job_id:currentJob.id,selected});currentJob=await api('/api/jobs/'+currentJob.id);await refresh();renderAI();toast(`已应用 ${r.applied.length} 项建议`);if(r.skipped.length)$('#ai-status').textContent=r.skipped.map(s=>s.reason).join('\n');}finally{button.disabled=false;}return;}
  if(name==='open-job'){currentJob=await api('/api/jobs/'+id);if(currentJob.status!=='done')return toast(currentJob.error||'这次请求尚未完成。',true);localStorage.setItem('desk-last-job',id);renderAI();$('#assistant-panel').classList.add('open');$('#ai-result').scrollIntoView({block:'nearest',behavior:'smooth'});return;}
  if(name==='archive-task'){const taskId=$('#task-form').elements.id.value;if(!taskId)return;await api('/api/tasks/'+taskId,'DELETE',{});closeDialog('task-dialog');await refresh();return toast('已移入回收站，可以恢复。');}
  if(name==='restore-task'){await api('/api/tasks/'+id,'PATCH',{restore:true});await refresh();return toast('事项已恢复。');}
  if(name==='delete-project'){const projectId=$('#project-form').elements.id.value;if(!confirm('删除这个空项目？已有事项的项目无法删除。'))return;await api('/api/projects/'+projectId,'DELETE',{});closeDialog('project-dialog');await refresh();return toast('空项目已删除。');}
  if(name==='complete-habit'){await api('/api/tasks/'+id,'PATCH',{status:'done'});await refresh();return toast('已记录完成；重复事项会生成下一次。');}
  if(name==='overview-mode'){overviewMode=button.dataset.mode;localStorage.setItem('desk-overview-mode',overviewMode);return render();}
  if(name==='period-today'){overviewDate=state.today;return render();}
  if(name==='period-prev'||name==='period-next'){const offset=name==='period-prev'?-1:1;if(overviewMode==='week')overviewDate=addDays(overviewDate,offset*7);else{const d=dateObject(overviewDate);overviewDate=isoDate(new Date(d.getFullYear(),d.getMonth()+offset,1,12));}return render();}
  if(name==='open-day')return openDay(button.dataset.day);
  if(name==='new-day')return openTask(null,{scheduled_at:button.dataset.day+'T09:00'});
  if(name==='new-day-task'){closeDialog('day-dialog');return openTask(null,{scheduled_at:selectedDay+'T09:00'});}
  if(name==='plan'){pendingPlan=null;$('#plan-result').innerHTML='';$('#plan-error').textContent='';$('#plan-start').value=overviewDate&&view==='overview'&&overviewDate>=state.today?overviewDate:state.today;$('#plan-days').value=overviewMode==='month'&&view==='overview'?'31':'7';$('#apply-plan').hidden=true;$('#plan-count').textContent='';return openDialog('plan-dialog');}
  if(name==='generate-plan'){button.disabled=true;$('#plan-error').textContent='';try{const ids=visibleTasks().filter(t=>t.status!=='done').map(t=>t.id);pendingPlan=await api('/api/plan','POST',{start:$('#plan-start').value,days:Number($('#plan-days').value),ids});renderPlan();}catch(e){$('#plan-error').textContent=e.message;}finally{button.disabled=false;}return;}
  if(name==='apply-plan'){const items=$$('input[name=plan-item]:checked').map(c=>pendingPlan.items[Number(c.value)]);if(!items.length)return toast('请选择要应用的时间安排。');button.disabled=true;try{const r=await api('/api/plan/apply','POST',{items});closeDialog('plan-dialog');view='overview';location.hash='overview';overviewDate=pendingPlan.start;await refresh();toast(`已安排 ${r.count} 项，周 / 月总览已更新。`);}catch(e){$('#plan-error').textContent=e.message;}finally{button.disabled=false;}return;}
  if(name==='notifications'){renderNotifications();return openDialog('notifications-dialog');}
  if(name==='read-notifications'){await api('/api/notifications/read','POST',{all:true});await refresh();return renderNotifications();}
  if(name==='notification-task'||name==='notification-job'||name==='notification-goal'){await api('/api/notifications/read','POST',{id:button.dataset.notification});closeDialog('notifications-dialog');await refresh();return action(name==='notification-task'?'edit-task':name==='notification-goal'?'review-goal':'open-job',button);}
  if(name==='desktop-notifications'){if(!('Notification'in window))return toast('当前浏览器不支持桌面提醒。',true);const permission=await Notification.requestPermission();return toast(permission==='granted'?'桌面提醒已开启；网页保持打开时可以收到。':'尚未允许桌面提醒，页内提醒仍然可用。');}
  if(name==='export'){const data=await api('/api/export'),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='主线-'+state.today+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return toast('已导出聊天、事项、日程和项目等记录。');}
  if(name==='backup'){const r=await api('/api/backup','POST',{});return toast('本机数据库备份已保存：'+r.filename);}
  if(name==='save-areas'){const areas=$('#areas-editor').value.split('\n').map(x=>x.trim()).filter(Boolean);try{await api('/api/areas','POST',{areas});state.settings.areas=areas;fillAreaOptions();$('#areas-error').textContent='';return toast('领域已保存，新建项目和目标时可以使用。');}catch(e){$('#areas-error').textContent=e.message;return;}}
  if(name==='start-focus'){if(focusSession&&!confirm('已有专注进行中，先结束并记录，再开始这项？'))return;if(focusSession)await finishFocus();const t=await saveTask(true);if(!t)return;focusSession={id:crypto.randomUUID(),taskId:t.id,title:t.title,target:t.duration,elapsed:0,resumedAt:Date.now(),running:true,notified:false};persistFocus();renderFocus();$('#focus-bar').scrollIntoView({block:'nearest',behavior:'smooth'});return;}
  if(name==='pause-focus'){if(!focusSession)return;if(focusSession.running){focusSession.elapsed=focusElapsed();focusSession.running=false;}else{focusSession.running=true;focusSession.resumedAt=Date.now();}persistFocus();return renderFocus();}
  if(name==='finish-focus')return finishFocus();
}
document.addEventListener('click',async event=>{
  const closer=event.target.closest('[data-close]');if(closer){closeDialog(closer.dataset.close);return;}
  const nav=event.target.closest('[data-nav]');if(nav){navigate(nav.dataset.nav);return;}
  const mode=event.target.closest('.assistant-modes [data-mode]');if(mode){setAiMode(mode.dataset.mode);return;}
  const button=event.target.closest('[data-action]');if(!button)return;
  try{await action(button.dataset.action,button);}catch(e){toast(e.message,true);if($('#task-dialog').open)$('#task-error').textContent=e.message;if($('#settings-dialog').open)$('#settings-error').textContent=e.message;if($('#project-dialog').open)$('#project-error').textContent=e.message;if($('#note-dialog').open)$('#note-error').textContent=e.message;if($('#project-documents-dialog').open)$('#project-documents-error').textContent=e.message;}
});
document.addEventListener('change',async event=>{
  const el=event.target;
  try{
    if(['word-upload','ppt-upload','other-upload'].includes(el.id)){await uploadFiles(el.files);el.value='';}
    else if(el.id==='project-document-upload'){try{await uploadProjectDocuments(el.files);}finally{el.value='';}}
    else if(el.name==='review_days'&&el.form?.id==='goal-form'){el.form.elements.next_review.value=addDays(state.today,Number(el.value));}
    else if(el.hasAttribute('data-file-select')){el.checked?attachedFiles.add(el.dataset.fileSelect):attachedFiles.delete(el.dataset.fileSelect);renderAttachments();}
    else if(el.hasAttribute('data-complete')){el.disabled=true;await api('/api/tasks/'+el.dataset.complete,'PATCH',{status:el.checked?'done':'todo'});await refresh();toast(el.checked?'已完成。重复事项已安排下一次。':'已恢复为待办。');}
    else if(el.hasAttribute('data-milestone')){const p=project(el.dataset.milestone),milestones=p.milestones.map((m,i)=>i===Number(el.dataset.index)?{...m,done:el.checked}:m);await api('/api/projects/'+p.id,'PATCH',{milestones});await refresh();}
    else if(el.hasAttribute('data-track')){const p=project(el.dataset.track);if(!p)throw new Error('项目不存在');const tracks=p.tracks.map((tr,i)=>i===Number(el.dataset.trackIndex)?{...tr,percent:Number(el.value)}:tr);el.disabled=true;try{await api('/api/projects/'+p.id,'PATCH',{tracks});await refresh();toast('进度已更新：'+el.value+'%');}finally{el.disabled=false;}}
    else if(el.id==='project-filter'){projectFilter=el.value;render();}
    else if(el.id==='show-done'){showDone=el.checked;render();}
    else if(el.id==='ai-model'){await api('/api/settings','POST',{model:el.value});state.settings.model=el.value;toast('秘书模型已切换。');}
    else if(el.name==='project_type'&&el.form?.id==='project-form'){updateProjectFields();}
    else if(el.name==='kind'&&el.form?.id==='task-form'){if(el.value==='event')el.form.elements.fixed.checked=true;if(el.value==='habit'&&el.form.elements.repeat.value==='none')el.form.elements.repeat.value='weekly';}
    else if(el.id==='import-file'){
      const file=el.files[0];if(!file)return;if(file.size>64_000_000)throw new Error('备份文件超过 64MB。');const data=JSON.parse(await file.text());
      if(confirm(`恢复备份将替换任务、项目、目标和文件记录（文件含 ${data.tasks?.length??'?'} 项任务）。恢复前会自动备份现有数据。确定恢复？`)){await api('/api/import','POST',data);currentJob=null;localStorage.removeItem('desk-last-job');await refresh();renderModels();renderAI();toast('备份已恢复，原数据已有本机备份。');}el.value='';
    }
  }catch(e){toast(e.message,true);if(el.hasAttribute('data-complete')){el.checked=!el.checked;el.disabled=false;}if(el.hasAttribute('data-milestone'))el.checked=!el.checked;}
});
let searchTimer;$('#task-search').addEventListener('input',e=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{search=e.target.value.trim();render();},150);});
$('#task-form').addEventListener('submit',async e=>{e.preventDefault();const submit=$('button[type=submit]',e.target);submit.disabled=true;$('#task-error').textContent='';try{await saveTask();}catch(error){$('#task-error').textContent=error.message;}finally{submit.disabled=false;}});
$('#project-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.target,data=Object.fromEntries(new FormData(form)),id=data.id;delete data.id;if(data.progress!==undefined)data.progress=data.progress.trim()===''?null:Number(data.progress);data.milestones=parseChecklist(data.milestones_text);delete data.milestones_text;data.tracks=parseTracks(data.tracks_text);delete data.tracks_text;const submit=$('button[type=submit]',form);submit.disabled=true;try{await api(id?'/api/projects/'+id:'/api/projects',id?'PATCH':'POST',data);closeDialog('project-dialog');await refresh();toast('项目已保存。');}catch(error){$('#project-error').textContent=error.message;}finally{submit.disabled=false;}});
$('#note-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.target,data=Object.fromEntries(new FormData(form)),id=data.id;delete data.id;const button=$('button[type=submit]',form);button.disabled=true;$('#note-error').textContent='';try{await api(id?'/api/notes/'+id:'/api/notes',id?'PATCH':'POST',data);closeDialog('note-dialog');await refresh();toast('笔记已保存。');}catch(error){$('#note-error').textContent=error.message;}finally{button.disabled=false;}});
$('#settings-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.target,data=Object.fromEntries(new FormData(form));data.review_enabled=form.elements.review_enabled.checked;data.workdays=$$('input[name=workday]:checked',form).map(c=>Number(c.value));delete data.workday;data.capacity=Number(data.capacity);data.buffer_minutes=Number(data.buffer_minutes);data.reminder_minutes=Number(data.reminder_minutes);try{await api('/api/settings','POST',data);closeDialog('settings-dialog');await refresh();toast('时间与跟进偏好已保存。');}catch(error){$('#settings-error').textContent=error.message;}});
let dragId='';
document.addEventListener('dragstart',e=>{const item=e.target.closest('[data-task]');if(!item)return;dragId=item.dataset.task;e.dataTransfer.setData('text/plain',dragId);e.dataTransfer.effectAllowed='move';});
document.addEventListener('dragover',e=>{const zone=e.target.closest('[data-quadrant],[data-drop-day]');if(zone&&dragId){e.preventDefault();zone.classList.add('drag-over');e.dataTransfer.dropEffect='move';}});
document.addEventListener('dragleave',e=>{const zone=e.target.closest('[data-quadrant],[data-drop-day]');if(zone&&!zone.contains(e.relatedTarget))zone.classList.remove('drag-over');});
document.addEventListener('dragend',()=>{dragId='';$$('.drag-over').forEach(z=>z.classList.remove('drag-over'));});
document.addEventListener('drop',async e=>{const zone=e.target.closest('[data-quadrant],[data-drop-day]');if(!zone)return;e.preventDefault();const id=e.dataTransfer.getData('text/plain'),t=taskById(id);dragId='';$$('.drag-over').forEach(z=>z.classList.remove('drag-over'));if(!t||t.status==='done')return;if(t.fixed)return toast('固定约定请在事项详情中修改。');try{if(zone.hasAttribute('data-quadrant')){const q=Number(zone.dataset.quadrant);await api('/api/tasks/'+id,'PATCH',{important:q<2,urgent:q===0||q===2});await refresh();toast('已移动到'+quadNames[q]);}else openTask({...t,scheduled_at:zone.dataset.dropDay+'T'+(fmtTime(t.scheduled_at)||'09:00')});}catch(error){toast(error.message,true);}});
$('#ai-input').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();submitAI();}});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#task-search').focus();}});
window.addEventListener('hashchange',()=>{readRoute();render();});
async function initialize() {
  try{const [s,m,j]=await Promise.all([api('/api/state'),api('/api/models'),api('/api/jobs')]);state=s;modelInfo=m;overviewDate=s.today;readRoute();render();renderModels();$('#service-status').textContent='● 本机服务运行中';deliverNotifications();
    const lastId=localStorage.getItem('desk-last-job'),last=j.jobs.find(x=>x.id===lastId)||[...j.jobs].reverse().find(x=>x.status==='done'&&x.mode!=='test');if(last?.status==='done'){currentJob=last;$('#ai-result').innerHTML=`<button class="inline-link previous-result" data-action="open-job" data-id="${esc(last.id)}">上次建议 →</button>`;}else if(last?.status==='running'){busyAI=true;$('#ai-submit').disabled=true;pollJob(last.id).catch(e=>$('#ai-status').textContent=e.message).finally(()=>{busyAI=false;$('#ai-submit').disabled=false;});}
  }catch(e){$('#page-content').innerHTML=empty('还没有连接到本机服务','请双击“启动个人指挥台.cmd”，再刷新这个页面。','','');$('#service-status').textContent='● 本机连接未就绪';$('#service-status').classList.add('offline');toast(e.message,true);}
}
initialize();
setInterval(()=>{if(state.today)refresh().catch(()=>{});},30000);
setInterval(renderFocus,1000);

function pinnedGoals() {
  const goals=(state.goals||[]).filter(g=>g.pinned&&g.status==='active'&&!g.deleted_at);
  return goals.length?`<div class="north-star-strip">${goals.slice(0,3).map(g=>`<button data-nav="goals" title="${esc(g.vision||g.title)}"><span>◎</span>${esc(g.title)}</button>`).join('')}${goals.length>3?'<button data-nav="goals">全部目标 →</button>':''}</div>`:'';
}
function goalsView() {
  const allGoals=(state.goals||[]).filter(g=>!g.deleted_at),tasks=activeTasks();
  const series=new Map();
  for(const t of tasks.filter(t=>t.kind==='habit')){const root=t.repeat_parent||t.id;if(!series.has(root))series.set(root,[]);series.get(root).push(t);}
  const owners=new Map([...series].map(([root,items])=>[root,currentHabit(items).goal_id]));
  const owner=t=>t.kind==='habit'?owners.get(t.repeat_parent||t.id):t.goal_id;
  const matches=t=>!search||[t.title,t.notes,project(t.project_id)?.name].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()));
  const goals=allGoals.filter(g=>!search||[g.title,g.vision,g.commitment,g.area].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()))||tasks.some(t=>owner(t)===g.id&&matches(t)));
  const cards=items=>items.map(g=>{
    const linked=tasks.filter(t=>owner(t)===g.id),habits=linked.filter(t=>t.kind==='habit');
    const next=linked.filter(t=>t.kind!=='habit'&&t.status!=='done'),finished=linked.filter(t=>t.kind!=='habit'&&t.status==='done');
    const due=g.status==='active'&&g.next_review<=state.today;
    const recent=habits.filter(t=>t.status==='done'&&t.completed_at?.slice(0,10)>=addDays(state.today,-6)&&t.completed_at.slice(0,10)<=state.today).length;
    return `<article class="goal-card${g.status!=='active'?' quiet-goal':''}"><div class="goal-card-heading"><span class="goal-mark" aria-hidden="true">◎</span><button class="icon-button" data-action="edit-goal" data-id="${g.id}" aria-label="编辑目标 ${esc(g.title)}">⋯</button></div><h2>${esc(g.title)}</h2>${g.vision?`<p class="goal-vision">${esc(g.vision)}</p>`:''}${g.commitment?`<div class="goal-commitment"><small>投入计划</small>${esc(g.commitment)}</div>`:''}<div class="goal-card-actions"><button class="${due?'primary-button':'quiet-button'}" data-action="review-goal" data-id="${g.id}">${due?'该回顾了':'回顾'}</button><button class="inline-link" data-action="goal-habit" data-id="${g.id}">＋ 持续投入</button><button class="inline-link" data-action="goal-task" data-id="${g.id}">＋ 下一步</button>${g.status!=='active'?`<span>${g.status==='completed'?'已实现':'暂时搁置'}</span>`:''}</div><div class="growth-section"><div class="growth-section-heading"><h3>持续投入</h3><span>最近 7 天完成 ${recent} 次</span></div>${habits.length?habitCards(habits):'<p class="help-text">添加一项重复行动，把方向落实到每周。</p>'}</div><div class="growth-section"><h3>下一步</h3>${next.length?next.map(t=>taskCard(t,false)).join(''):'<p class="help-text">还没有待推进的下一步。</p>'}</div><details class="goal-details"><summary>回顾与足迹${finished.length?' · 已完成 '+finished.length+' 项':''}</summary>${g.why?`<p>${esc(g.why)}</p>`:''}<div class="goal-next-review">下次回顾 ${fmtDate(g.next_review)}${g.horizon?' · 愿景 '+fmtDate(g.horizon,true):''}</div>${finished.map(t=>taskCard(t,false)).join('')}${[...(g.checkins||[])].reverse().map(c=>`<div class="goal-checkin"><time>${fmtDate(c.date,true)}</time><p>${esc(c.note)}</p></div>`).join('')}</details></article>`;
  }).join('');
  const ids=new Set(allGoals.map(g=>g.id));
  const matchingSeries=new Set(tasks.filter(t=>t.kind==='habit'&&matches(t)).map(t=>t.repeat_parent||t.id));
  const independent=tasks.filter(t=>t.kind==='habit'&&!ids.has(owner(t))&&matchingSeries.has(t.repeat_parent||t.id));
  const active=goals.filter(g=>g.status==='active'),other=goals.filter(g=>g.status!=='active');
  return `<div class="goal-page-actions"><button class="quiet-button" data-action="new-habit">＋ 独立投入</button><button class="primary-button" data-action="new-goal">＋ 设定目标</button></div>`+(active.length?`<div class="goal-grid">${cards(active)}</div>`:'')+(other.length?`<details class="past-goals"><summary>已实现与暂时搁置 · ${other.length}</summary><div class="goal-grid">${cards(other)}</div></details>`:'')+`<section class="independent-growth"><div class="growth-section-heading"><h2>独立投入</h2><span>暂未关联目标的习惯</span></div>${independent.length?habitCards(independent):'<p class="help-text">运动、阅读等习惯可以独立记录，也可以在编辑时关联目标。</p>'}</section>`+(!goals.length&&!independent.length?empty(search?'没有匹配的目标或投入':'从一个方向或一项习惯开始','','',''):'');
}
function openGoal(g=null) {
  const form=$('#goal-form');form.reset();$('#goal-error').textContent='';
  const values={id:'',title:'',vision:'',why:'',commitment:'',area:state.settings?.areas?.[0]||'',status:'active',review_days:7,next_review:addDays(state.today,7),horizon:'',pinned:true,...(g||{})};
  for(const [key,value] of Object.entries(values)){const field=form.elements.namedItem(key);if(!field)continue;if(field.type==='checkbox')field.checked=!!value;else field.value=value;}
  $('#goal-editor-title').textContent=g?'目标详情':'设定长期目标';openDialog('goal-dialog');
}
function openGoalReview(g) {
  if(!g)return toast('目标不存在。',true);
  const form=$('#goal-review-form');form.reset();form.elements.id.value=g.id;$('#goal-review-error').textContent='';$('#goal-review-title').textContent=g.title;
  $('#goal-review-context').innerHTML=g.commitment?`<p class="goal-commitment">${esc(g.commitment)}</p>`:'';openDialog('goal-review-dialog');
}
async function extendedAction(name,button) {
  const id=button?.dataset.id;
  if(name==='new-goal'){openGoal();return true;}
  if(name==='edit-goal'){openGoal(state.goals.find(g=>g.id===id));return true;}
  if(name==='review-goal'){openGoalReview(state.goals.find(g=>g.id===id));return true;}
  if(name==='goal-task'){openTask(null,{project_id:'',goal_id:id,important:true,urgent:false});return true;}
  if(name==='goal-habit'){openTask(null,{project_id:'',goal_id:id,kind:'habit',repeat:'weekly',duration:30,important:true,urgent:false});return true;}
  if(name==='upload-word'||name==='upload-ppt'||name==='upload-file'){$('#'+({'upload-word':'word-upload','upload-ppt':'ppt-upload','upload-file':'other-upload'}[name])).click();return true;}
  if(name==='detach-file'){attachedFiles.delete(id);renderAttachments();return true;}
  if(name==='file-library'){renderFileLibrary();openDialog('files-dialog');return true;}
  if(name==='preview-file'){const f=await api('/api/files/'+id);$('#file-preview').hidden=false;$('#file-preview').open=true;$('#file-preview-title').textContent=f.name;$('#file-preview-text').textContent=f.text;$('#file-preview-warning').textContent=[f.warning,f.truncated?'文档过长，保留前 12 万字。':''].filter(Boolean).join(' ');$('#file-preview').scrollIntoView({block:'nearest'});return true;}
  if(name==='remove-file'){await api('/api/files/'+id,'DELETE',{});attachedFiles.delete(id);await refresh();renderFileLibrary();$('#file-preview').hidden=true;toast('文件已从文件库移除');return true;}
  return false;
}
function renderAttachments() {
  const files=state.files||[];
  attachedFiles=new Set([...attachedFiles].filter(id=>files.some(f=>f.id===id)));
  $('#selected-files').innerHTML=[...attachedFiles].map(id=>{const f=files.find(f=>f.id===id);return `<div class="attachment-chip"><button class="attachment-name" data-action="file-library" title="${esc(f.name)}">${esc(f.name)}</button><button class="icon-button" data-action="detach-file" data-id="${id}" aria-label="取消附件 ${esc(f.name)}">×</button></div>`;}).join('');
}
function renderFileLibrary() {
  $('#files-list').innerHTML=(state.files||[]).map(f=>`<article class="file-row"><label><input type="checkbox" data-file-select="${f.id}" ${attachedFiles.has(f.id)?'checked':''}><span>${esc(f.name)}</span></label><div><button class="inline-link" data-action="preview-file" data-id="${f.id}">文字</button><button class="icon-button" data-action="remove-file" data-id="${f.id}" aria-label="移除文件 ${esc(f.name)}">×</button></div></article>`).join('')||'<p>还没有文件</p>';
}
async function uploadFiles(files) {
  if(uploadingFiles||busyAI)return toast('请等当前处理完成后添加文件。');
  if(attachedFiles.size+files.length>5)return toast('一次最多选择 5 个附件。',true);
  uploadingFiles=true;$('#ai-submit').disabled=true;$$('.attachment-toolbar button').forEach(b=>b.disabled=true);
  try{for(const file of files){$('#ai-status').textContent='正在读取 '+file.name;const body=new FormData();body.append('file',file);
    const response=await fetch('/api/files',{method:'POST',headers:{'X-Personal-Desk':'1'},body});const result=await response.json();if(!response.ok)throw new Error(result.error||'文件未能读取');
    attachedFiles.add(result.id);await refresh();
  }$('#ai-status').textContent='文件已读入';}
  catch(e){$('#ai-status').textContent=e.message;toast(e.message,true);}
  finally{uploadingFiles=false;$('#ai-submit').disabled=busyAI;$$('.attachment-toolbar button').forEach(b=>b.disabled=false);}
}
$('#goal-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,data=Object.fromEntries(new FormData(form)),id=data.id;delete data.id;data.pinned=form.elements.pinned.checked;data.review_days=Number(data.review_days);
  const button=$('button[type=submit]',form);button.disabled=true;try{await api(id?'/api/goals/'+id:'/api/goals',id?'PATCH':'POST',data);closeDialog('goal-dialog');navigate('goals');await refresh();toast('目标已保存');}catch(error){$('#goal-error').textContent=error.message;}finally{button.disabled=false;}
});
$('#goal-review-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,button=$('button[type=submit]',form);button.disabled=true;
  try{await api('/api/goals/'+form.elements.id.value+'/checkin','POST',{note:form.elements.note.value});closeDialog('goal-review-dialog');await refresh();toast('回顾已记录');}catch(error){$('#goal-review-error').textContent=error.message;}finally{button.disabled=false;}
});

$('#category-form').addEventListener('submit',async e=>{e.preventDefault();const button=$('button[type=submit]',e.target);button.disabled=true;try{const p=await api('/api/categories','POST',{name:e.target.elements.name.value});closeDialog('category-dialog');await refresh();openCategory(p.area);}catch(error){$('#category-error').textContent=error.message;}finally{button.disabled=false;}});
