'use strict';
// The editor lives outside the periodically refreshed dashboard DOM.
window.Writing = (() => {
  const q = s => document.querySelector(s);
  const dialog = q('#note-dialog'), form = q('#note-form');
  let editor = null, session = null, loading = null, timer = null, flight = null;
  let selectedVersion = null, uploading = false;
  const cacheKey = 'mainline-writing-emergency';
  const error = message => { q('#note-error').textContent = message || ''; };
  const status = message => { q('#writing-save-status').textContent = message; };
  const newId = () => crypto.randomUUID().replaceAll('-', '');
  const escapeHTML = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function script(src, id) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      const timeout = setTimeout(() => { el.remove(); reject(new Error('编辑器加载超时，可在文字模式中继续写作。')); }, 15000);
      el.src = src;
      if (id) el.id = id;
      el.onload = () => { clearTimeout(timeout); resolve(); };
      el.onerror = () => { clearTimeout(timeout); el.remove(); reject(new Error('编辑器未加载，可在文字模式中继续写作。')); };
      document.head.append(el);
    });
  }

  async function loadEditor() {
    if (!loading) loading = (async () => {
      if (!q('#vditor-style')) {
        const link = document.createElement('link'); link.id = 'vditor-style'; link.rel = 'stylesheet';
        link.href = '/vendor/vditor/dist/index.css'; document.head.append(link);
      }
      if (!window.VditorI18n) await script('/vendor/vditor/dist/js/i18n/zh_CN.js');
      if (!window.Vditor) await script('/vendor/vditor/dist/index.min.js');
      if (!window.Lute) await script('/vendor/vditor/dist/js/lute/lute.min.js', 'vditorLuteScript');
    })().catch(e => { loading = null; throw e; });
    return loading;
  }

  function snapshotForExit() {
    if (!session || !dialog.open) return null;
    // Read the DOM too: a native close can arrive before the editor's input callback.
    if (editor && session.editorReady) {
      const value = editor.getValue();
      if (value !== session.editorValue) {
        session.content = value; session.editorValue = value; session.format = 'markdown';
        session.dirty = true; session.sequence++;
      }
    }
    if (!session.dirty) return null;
    return {id:session.id, title:form.elements.title.value, content:session.content,
      project_id:form.elements.project_id.value, format:session.format, base_revision:session.revision};
  }

  function cache() {
    const draft = snapshotForExit();
    if (draft) { try { localStorage.setItem(cacheKey, JSON.stringify(draft)); } catch { /* The SQLite save remains active. */ } }
  }

  function changed() {
    if (!session) return;
    session.dirty = true; session.sequence++;
    q('#writing-count').textContent = session.content.length.toLocaleString('zh-CN') + ' 字';
    status('尚未保存'); error(''); cache();
    clearTimeout(timer);
    timer = setTimeout(() => save().catch(() => {}), 1000);
  }

  async function save(checkpoint = false) {
    clearTimeout(timer);
    if (flight) { await flight; if (session?.dirty) return save(checkpoint); return; }
    const payload = snapshotForExit();
    if (!payload) return;
    const current = session, sequence = current.sequence;
    payload.checkpoint = checkpoint;
    status('正在保存…');
    flight = (async () => {
      const result = await api('/api/writing/save', 'POST', payload);
      if (session !== current) return;
      if (result.conflict) {
        current.conflict = true; current.dirty = current.sequence !== sequence;
        if (!current.dirty) localStorage.removeItem(cacheKey);
        status('当前内容已留作草稿');
        error('这篇笔记在另一处发生了更新，或已归档。当前文字已保存为独立草稿，可以另存为新笔记。');
        q('#writing-save-copy').hidden = false; return;
      }
      if (result.saved) {
        current.revision = result.note.revision;
        current.saved = true;
        state.notes = [...state.notes.filter(n => n.id !== current.id), result.note];
        state.writing_drafts = (state.writing_drafts || []).filter(d => d.id !== current.id);
      } else {
        current.saved = false;
        state.writing_drafts = [...(state.writing_drafts || []).filter(d => d.id !== current.id), payload];
      }
      current.dirty = current.sequence !== sequence;
      if (!current.dirty) {
        localStorage.removeItem(cacheKey);
        status(result.saved ? '已保存到本机 · ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'}) : '草稿已保存 · 标题与正文写好后成为笔记');
      } else { cache(); status('正在保存后续修改…'); }
    })().catch(e => {
      status('保存未完成'); error(e.message + ' 当前文字仍在编辑区，请重试保存。'); cache(); throw e;
    }).finally(() => { flight = null; });
    await flight;
    if (session === current && current.dirty) timer = setTimeout(() => save().catch(() => {}), 500);
  }

  async function flush() {
    await save(true);
    while (session?.dirty) await save(true);
  }

  async function open(note = null, projectId = '', recovered = null) {
    if (dialog.open) await close();
    if (dialog.open) return;
    const drafts = (await api('/api/writing/drafts')).drafts;
    let emergency = null;
    try { emergency = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch { /* Ignore malformed browser cache. */ }
    let draft = recovered || (note && drafts.find(d => d.id === note.id));
    if (emergency && emergency.id === (draft?.id || note?.id)) draft = emergency;
    const source = draft || note;
    session = {id:source?.id || newId(), content:source?.content || '', format:source?.format || (note ? 'plain' : 'markdown'),
      revision:draft ? (draft.base_revision || 0) : (note?.revision || 0), dirty:false, sequence:0, conflict:false, saved:!!note};
    form.reset(); form.elements.id.value = session.id;
    const projects = state.projects.filter(p => projectKind(p) === 'project' && (!p.deleted_at || p.id === source?.project_id));
    q('#note-project').innerHTML = '<option value="">整体笔记</option>' + projects.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.area)} / ${escapeHTML(p.name)}</option>`).join('');
    form.elements.title.value = source?.title || '';
    form.elements.project_id.value = source?.project_id || projectId || '';
    q('#note-archive').hidden = !note;
    q('#writing-save-copy').hidden = true; q('#writing-history').hidden = true;
    q('#writing-fallback').value = session.content; q('#writing-fallback').hidden = false;
    q('#writing-editor').hidden = true;
    error(''); status(draft ? '已恢复草稿' : note ? '已保存到本机' : '开始写作后自动保存');
    q('#writing-count').textContent = session.content.length.toLocaleString('zh-CN') + ' 字';
    dialog.showModal(); preferences();
    if (draft) { session.dirty = true; session.sequence++; cache(); }
    form.elements.title.focus();
    const current = session;
    try {
      await loadEditor();
      if (session !== current || !dialog.open) return;
      editor?.destroy(); editor = null;
      if (!q('#vditorIconScript')) await script('/vendor/vditor/dist/js/icons/ant.js', 'vditorIconScript');
      q('#writing-editor').innerHTML = ''; q('#writing-editor').hidden = false;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('编辑器初始化超时，已保留文字模式。')), 12000);
        editor = new Vditor('writing-editor', {
          cdn:'/vendor/vditor', i18n:window.VditorI18n, lang:'zh_CN', mode:current.format === 'plain' ? 'sv' : 'ir', value:current.content,
          height:'100%', minHeight:380, placeholder:'写下观察、判断，或一个还没有答案的问题……',
          cache:{enable:false}, resize:{enable:false}, outline:{enable:false, position:'right'},
          toolbar:['headings','bold','italic','strike','|','list','ordered-list','quote','link',
            {name:'local-image', tip:'插入本机图片', icon:'<svg viewBox="0 0 24 24"><path d="M3 3h18v18H3V3zm2 2v10l4-4 4 4 3-3 3 3V5H5zm0 14h14l-3-4-3 3-4-4-4 4v1z"/></svg>', click:() => q('#writing-image').click()},
            '|','undo','redo','|','edit-mode','outline'],
          toolbarConfig:{pin:true}, hint:{emoji:{}, emojiPath:'/vendor/vditor/images'},
          preview:{maxWidth:1040, actions:[], hljs:{enable:false}, theme:{current:'', list:[]},
            markdown:{sanitize:true, autoSpace:false, fixTermTypo:false, codeBlockPreview:false, mathBlockPreview:false},
            render:{media:{enable:false}}},
          customRenders:['mermaid','graphviz','echarts','abc','plantuml','mindmap','flowchart','math'].map(language => ({language, render:() => {}})),
          upload:{accept:'image/png,image/jpeg,image/gif,image/webp', max:8*1024*1024, handler:files => insertImages(files)},
          input:value => { if (session === current) { current.content = value; current.editorValue = value; current.format = 'markdown'; changed(); } },
          after:() => { clearTimeout(timeout); resolve(); },
        });
      });
      if (session !== current || !dialog.open) return;
      current.editorReady = true; current.editorValue = editor.getValue();
      q('#writing-fallback').hidden = true;
      // Vendor toolbar controls must never submit the surrounding note form.
      q('#writing-editor').querySelectorAll('button').forEach(button => button.type = 'button');
    } catch (e) {
      if (session !== current || !dialog.open) return;
      q('#writing-editor').hidden = true; q('#writing-fallback').hidden = false;
      q('#writing-fallback').value = current.content; error(e.message);
    }
  }

  async function close() {
    if (uploading) { error('图片正在保存，请稍等。'); return; }
    try { await flush(); } catch { return; }
    clearTimeout(timer); editor?.destroy(); editor = null;
    dialog.close(); session = null; await refresh();
  }

  async function insertImages(files) {
    if (!session || uploading) return '请等待当前图片保存完成。';
    const current = session; uploading = true; status('正在保存本机图片…');
    try {
      for (const file of files) {
        if (file.size > 8 * 1024 * 1024) throw new Error('每张图片最多 8 MB。');
        const body = new FormData(); body.append('file', file);
        const response = await fetch('/api/writing/images', {method:'POST', headers:{'X-Personal-Desk':'1'}, body});
        const image = await response.json(); if (!response.ok) throw new Error(image.error || '图片保存失败。');
        if (session !== current) return null;
        const name = file.name.replace(/[\[\]\\\r\n]/g, '').slice(0, 80) || '图片';
        const markdown = `\n![${name}](${image.url})\n`;
        if (editor && !q('#writing-editor').hidden) { editor.insertValue(markdown); current.content = editor.getValue(); }
        else { const box = q('#writing-fallback'); box.setRangeText(markdown, box.selectionStart, box.selectionEnd, 'end'); current.content = box.value; }
        current.format = 'markdown'; changed();
      }
      await flush(); return null;
    } catch (e) { error(e.message); return e.message; }
    finally { uploading = false; }
  }

  async function exportMarkdown() {
    if (uploading) throw new Error('请等待图片保存完成再导出。');
    await flush();
    if (!session?.saved || session.conflict) throw new Error('请先填写标题与正文，并保存为笔记。');
    if (window.pywebview?.api?.export_note) {
      const result = await window.pywebview.api.export_note(session.id);
      if (result.error) throw new Error(result.error);
      if (result.saved) toast('已导出 Markdown' + (result.images ? ' 和图片。' : '。'));
      return;
    }
    const response = await fetch('/api/writing/export/' + session.id, {headers:{'X-Personal-Desk':'1'}});
    if (!response.ok) throw new Error((await response.json()).error);
    const filename = decodeURIComponent((response.headers.get('Content-Disposition') || '').split("UTF-8''")[1] || '笔记.md');
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function history(draftsOnly = false) {
    await flush(); selectedVersion = null;
    q('#writing-history-preview').hidden = true;
    const [drafts, versions] = await Promise.all([api('/api/writing/drafts'), session ? api('/api/writing/versions/' + session.id) : {versions:[]}]);
    const list = q('#writing-history-list'); list.replaceChildren();
    const add = (record, label, isDraft) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'writing-version';
      button.innerHTML = `<strong>${escapeHTML(label)}</strong><small>${escapeHTML(record.updated_at || record.saved_at || '')}</small>`;
      button.addEventListener('click', () => {
        selectedVersion = {...record, isDraft}; q('#writing-history-preview').hidden = false;
        q('#writing-history-preview textarea').value = record.title + '\n\n' + record.content;
        q('#writing-restore').textContent = isDraft ? '打开这份草稿' : '恢复到编辑区';
      }); list.append(button);
    };
    for (const d of drafts.drafts) add(d, '草稿 · ' + (d.title || '无题'), true);
    if (!draftsOnly) for (const v of versions.versions) add(v, v.title || '历史版本', false);
    let emergency = null; try { emergency = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch { /* Ignore malformed browser cache. */ }
    if (emergency && !drafts.drafts.some(d => d.id === emergency.id)) add(emergency, '待恢复 · ' + (emergency.title || '无题'), true);
    if (!list.children.length) list.textContent = '尚无历史版本。编辑已有笔记时，会保留修改前的内容；持续写作每五分钟保留一个检查点。';
    q('#writing-history').hidden = false;
  }

  async function recoverDrafts() { await open(); await history(true); }

  async function restoreSelected() {
    if (!selectedVersion) return;
    const selected = selectedVersion;
    if (selected.isDraft) { const note = state.notes.find(n => n.id === selected.id); await open(note || null, selected.project_id, selected); return; }
    await flush();
    form.elements.title.value = selected.title;
    if ([...form.elements.project_id.options].some(o => o.value === selected.project_id)) form.elements.project_id.value = selected.project_id;
    session.content = selected.content; session.format = selected.format || 'plain';
    if (editor) editor.setValue(selected.content, true); else q('#writing-fallback').value = selected.content;
    changed(); await flush(); q('#writing-history').hidden = true; toast('已恢复，恢复前的内容也保留在历史版本中。');
  }

  function preferences() {
    let pref = {}; try { pref = JSON.parse(localStorage.getItem('mainline-writing-style') || '{}'); } catch { /* Use defaults. */ }
    for (const key of ['font','spacing','width']) {
      const select = q('#writing-' + key);
      if ([...select.options].some(o => o.value === String(pref[key]))) select.value = pref[key];
    }
    applyPreferences();
  }
  function applyPreferences() {
    const pref = {font:q('#writing-font').value, spacing:q('#writing-spacing').value, width:q('#writing-width').value};
    dialog.style.setProperty('--writing-font', pref.font + 'px'); dialog.style.setProperty('--writing-spacing', pref.spacing);
    dialog.style.setProperty('--writing-width', pref.width + 'px');
    localStorage.setItem('mainline-writing-style', JSON.stringify(pref));
  }

  async function archive() {
    await flush();
    if (!session?.saved || session.conflict) throw new Error('请先完成保存，当前草稿会继续保留。');
    await api('/api/notes/' + session.id, 'DELETE', {}); session.dirty = false; await close(); toast('笔记已归档，可以恢复。');
  }
  const handled = handler => async event => { event?.preventDefault(); try { await handler(); } catch (e) { error(e.message); } };
  form.addEventListener('submit', handled(() => flush()));
  q('#writing-back').addEventListener('click', handled(close));
  q('#note-archive').addEventListener('click', handled(archive));
  q('#writing-export').addEventListener('click', handled(exportMarkdown));
  q('#writing-versions').addEventListener('click', handled(() => history()));
  q('#writing-history-close').addEventListener('click', () => { q('#writing-history').hidden = true; });
  q('#writing-restore').addEventListener('click', handled(restoreSelected));
  q('#writing-save-copy').addEventListener('click', handled(async () => {
    session.id = newId(); session.revision = 0; session.conflict = false; session.saved = false;
    form.elements.id.value = session.id; q('#writing-save-copy').hidden = true;
    changed(); await flush();
  }));
  form.elements.title.addEventListener('input', changed);
  form.elements.project_id.addEventListener('change', changed);
  q('#writing-fallback').addEventListener('input', () => { session.content = q('#writing-fallback').value; session.format = 'markdown'; changed(); });
  q('#writing-image').addEventListener('change', async e => { await insertImages([...e.target.files]); e.target.value = ''; });
  for (const key of ['font','spacing','width']) q('#writing-' + key).addEventListener('change', applyPreferences);
  q('#writing-focus').addEventListener('click', () => {
    dialog.classList.toggle('writing-focused'); q('#writing-focus').setAttribute('aria-pressed', dialog.classList.contains('writing-focused'));
    q('#writing-focus').textContent = dialog.classList.contains('writing-focused') ? '退出专注' : '专注模式';
  });
  dialog.addEventListener('cancel', handled(close));
  dialog.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flush().catch(() => {}); }
  });
  window.addEventListener('beforeunload', () => {
    const draft = snapshotForExit(); if (!draft) return;
    cache(); fetch('/api/writing/save', {method:'POST', headers:{'X-Personal-Desk':'1','Content-Type':'application/json'}, body:JSON.stringify(draft), keepalive:true}).catch(() => {});
  });
  return {open, close, archive, recoverDrafts, snapshotForExit, isUploading:() => uploading,
    showCloseError:() => error(uploading ? '图片正在保存，请稍后再关闭。' : '关闭前保存未完成，请重试保存后再关闭。')};
})();
