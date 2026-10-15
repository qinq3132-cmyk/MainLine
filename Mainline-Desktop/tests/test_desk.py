import copy
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class FakeModels:
    entries = {}
    default = ''
    def public(self): return {'models': [], 'default': '', 'error': ''}
    def reload(self): pass


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = server.Store(self.temp.name)
        self.pid = self.store.all('projects')[0]['id']

    def tearDown(self):
        self.temp.cleanup()

    def task(self, **kw):
        return self.store.task({'title': '实验方案', 'project_id': self.pid, **kw})

    def test_notes_preserve_global_and_project_reflections_across_backup_and_legacy_import(self):
        p = self.store.project({'name': '示例研究项目', 'area': '通信组'})
        global_note = self.store.note({'title': '整体反思', 'content': '留出时间做长期判断。'})
        project_note = self.store.note({'title': '项目判断', 'content': '先验证波形生成方案。', 'project_id': p['id']})
        self.assertEqual(self.store.note({'content': '先验证两个方案。'}, project_note['id'])['created_at'], project_note['created_at'])
        with self.assertRaises(ValueError):
            self.store.note({'title': '错误归属', 'content': '内容', 'project_id': self.pid})
        backup = self.store.export()
        self.assertEqual(len(backup['notes']), 2)
        self.store.restore(backup)
        self.assertEqual(len(server.Store(self.temp.name).state()['notes']), 2)
        old_backup = copy.deepcopy(backup)
        del old_backup['notes']
        self.store.restore(old_backup)
        self.assertEqual({n['id'] for n in self.store.all('notes')}, {global_note['id'], project_note['id']})
        archived = self.store.put('notes', {**global_note, 'deleted_at': server.stamp()})
        self.assertTrue(archived['deleted_at'])
        assistant = server.Assistant(self.store, FakeModels())
        try:
            self.assertNotIn('整体反思', json.dumps(assistant.context('整体反思'), ensure_ascii=False))
            self.assertIn('项目判断', json.dumps(assistant.context('项目判断'), ensure_ascii=False))
        finally:
            assistant.pool.shutdown(wait=False, cancel_futures=True)

    def test_project_folder_is_external_scoped_and_preserved_without_copying_files(self):
        p=self.store.project({'name':'示例研究项目','area':'通信组','folder_path':'ignored'})
        self.assertEqual(p['folder_path'],'')
        parent=Path(self.temp.name)/'external-documents';parent.mkdir()
        root=parent/'项目资料'
        linked=self.store.bind_project_folder(p['id'],str(root),create=True)
        self.assertTrue(root.is_dir())
        self.assertEqual(linked['folder_path'],str(root.resolve()))
        self.store.create_project_subfolder(p['id'],'','实验记录')
        self.store.add_project_document(p['id'],'实验记录','记录.txt','本地文件'.encode())
        self.assertEqual(self.store.project_documents(p['id'],'实验记录')['items'][0]['name'],'记录.txt')
        with self.assertRaisesRegex(ValueError,'同名'):
            self.store.add_project_document(p['id'],'实验记录','记录.txt',b'overwrite')
        with self.assertRaises(ValueError):self.store.project_documents(p['id'],'../')
        with self.assertRaises(ValueError):self.store.create_project_subfolder(p['id'],'','..')
        with self.assertRaises(ValueError):self.store.add_project_document(p['id'],'','..\\outside.txt',b'bad')
        self.store.add_project_document(p['id'],'','danger.exe',b'not executable in test')
        with self.assertRaises(ValueError):self.store.open_project_document(p['id'],'danger.exe')
        with patch.object(server.os,'startfile') as opener:
            self.store.open_project_document(p['id'],'实验记录/记录.txt')
            opener.assert_called_once()
        with self.assertRaises(ValueError):self.store.bind_project_folder(self.pid,str(root))
        assistant=server.Assistant(self.store,FakeModels())
        try:self.assertTrue(all('folder_path' not in project for project in assistant.context()['projects']))
        finally:assistant.pool.shutdown(wait=False,cancel_futures=True)
        exported=self.store.export();self.store.restore(exported)
        self.assertEqual(self.store.get('projects',p['id'])['folder_path'],str(root.resolve()))
        self.store.bind_project_folder(p['id'],'')
        self.assertTrue((root/'实验记录'/'记录.txt').is_file())

    def test_two_level_projects_preserve_category_links_owner_and_activity(self):
        category = self.store.all('projects')[0]
        self.assertEqual(self.store.category(category['area'])['id'], category['id'])
        project = self.store.project({'name': '示例研究项目', 'area': category['area'],
                                      'owner': '项目负责人', 'progress': 40})
        activity = self.store.project({'name': '组内聚餐', 'area': category['area'], 'project_type': 'activity'})
        meeting = self.task(title='聚餐订位', kind='event')
        self.store.restore(self.store.export())
        state = server.Store(self.temp.name).state()
        by_id = {p['id']: p for p in state['projects']}
        self.assertEqual(by_id[category['id']]['project_type'], 'category')
        self.assertEqual(by_id[project['id']]['project_type'], 'project')
        self.assertEqual(by_id[project['id']]['owner'], '项目负责人')
        self.assertEqual(by_id[project['id']]['progress'], 40)
        self.assertEqual(by_id[activity['id']]['project_type'], 'activity')
        self.assertEqual(self.store.get('tasks', meeting['id'])['project_id'], category['id'])

    def test_legacy_category_classification_does_not_rewrite_records(self):
        category = self.store.get('projects', self.pid)
        category.pop('project_type', None)
        self.store.put('projects', category)
        task = self.task()
        state = self.store.state()
        self.assertEqual(next(p for p in state['projects'] if p['id']==self.pid)['project_type'], 'category')
        self.assertNotIn('project_type', self.store.get('projects', self.pid))
        self.assertEqual(self.store.get('tasks', task['id'])['project_id'], self.pid)
        with self.assertRaises(ValueError): self.store.project({'name': '无效', 'project_type': 'invalid'})
        with self.assertRaises(ValueError): self.store.project({'name': '无效', 'owner': 123})

    def test_project_progress_preserves_manual_value_and_legacy_backups(self):
        self.assertIsNone(self.store.project({}, self.pid)['progress'])
        self.store.project({'progress': 37.5}, self.pid)
        self.task(status='done')
        self.assertEqual(self.store.project({'goal': '推进实验'}, self.pid)['progress'], 37.5)
        exported = self.store.export()
        self.store.project({'progress': 80}, self.pid)
        self.store.restore(exported)
        self.assertEqual(server.Store(self.temp.name).get('projects', self.pid)['progress'], 37.5)
        for item in exported['projects']:
            item.pop('progress', None)
        self.store.restore(exported)
        self.assertIsNone(self.store.get('projects', self.pid).get('progress'))

    def test_invalid_progress_does_not_overwrite_project_or_import(self):
        self.store.project({'progress': 40}, self.pid)
        for value in [-1, 101, True, '50', float('nan')]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.store.project({'progress': value}, self.pid)
        exported = self.store.export()
        exported['projects'][0]['progress'] = 101
        with self.assertRaises(ValueError):
            self.store.restore(exported)
        self.assertEqual(self.store.get('projects', self.pid)['progress'], 40)

    def test_jsonc_urls_comments_and_trailing_commas(self):
        text = '{"baseURL":"https://example.test/v1", // URL remains intact\n"quoted":"a,}", "list":[1, /* comment */], /* end */}'
        self.assertEqual(server.jsonc(text), {'baseURL': 'https://example.test/v1', 'quoted': 'a,}', 'list': [1]})

    def test_conflict_rejection_and_archive_restore(self):
        day = (server.now().date()+dt.timedelta(days=1)).isoformat()
        a = self.task(scheduled_at=day+'T10:00', duration=90)
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.task(title='会议', scheduled_at=day+'T11:00', duration=30)
        self.assertEqual(len(self.store.all('tasks')), 1)
        self.store.put('tasks', {**a, 'deleted_at': server.stamp()})
        b = self.task(title='占用时间', scheduled_at=day+'T10:30')
        with self.assertRaisesRegex(ValueError, '冲突'):
            self.store.task({'restore': True}, a['id'])
        self.assertTrue(self.store.get('tasks', a['id'])['deleted_at'])
        self.store.put('tasks', {**b, 'deleted_at': server.stamp()})
        restored = self.store.task({'restore': True}, a['id'])
        self.assertEqual(restored['deleted_at'], '')

    def test_recurring_completion_is_idempotent_including_undo(self):
        t = self.task(kind='habit', repeat='daily')
        self.store.task({'status':'done'}, t['id'])
        self.store.task({'status':'done'}, t['id'])
        self.store.task({'status':'todo'}, t['id'])
        self.store.task({'status':'done'}, t['id'])
        children = [x for x in self.store.all('tasks') if x.get('repeat_parent') == t['id']]
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0]['occurrence'], (server.now().date()+dt.timedelta(days=1)).isoformat())
        with self.assertRaisesRegex(ValueError, '尚未到期'):
            self.store.task({'status':'done'}, children[0]['id'])

    def test_monthly_recurrence_preserves_day_31(self):
        first=dt.datetime(2027,1,31,9)
        feb=server.next_repeat(first,'monthly',31)
        march=server.next_repeat(feb,'monthly',31)
        self.assertEqual(feb.day, 28)
        self.assertEqual(march.day, 31)

    def test_weekdays_skip_weekend(self):
        self.assertEqual(server.next_repeat(dt.datetime(2026,10,16,9),'weekdays').date(), dt.date(2026,10,19))

    def test_scheduler_preserves_fixed_times_and_deep_blocks(self):
        moment=dt.datetime(2026,10,14,8)
        with patch.object(server,'now',return_value=moment):
            fixed=self.task(title='固定会议',kind='event',fixed=True,scheduled_at='2026-10-14T09:00',duration=90)
            deep=self.task(title='创业思考',kind='deep',duration=90)
            regular=self.task(title='检查结果',duration=60)
            waiting=self.task(title='等待同学',status='waiting')
            backlog=self.task(title='暂存想法',important=False,urgent=False)
            plan=server.build_plan(self.store.all('tasks'),self.store.settings(),'2026-10-14',7)
            indexed={x['id']:x for x in plan['items']}
            self.assertNotIn(fixed['id'], indexed)
            self.assertNotIn(waiting['id'], indexed)
            self.assertNotIn(backlog['id'], indexed)
            self.assertEqual(indexed[deep['id']]['scheduled_at'], '2026-10-15T09:00')
            self.assertEqual(indexed[regular['id']]['scheduled_at'], '2026-10-14T13:00')
            staged=[{**t, 'scheduled_at': indexed[t['id']]['scheduled_at']} if t['id'] in indexed else t for t in self.store.all('tasks')]
            for t in staged:
                self.assertEqual(self.store.conflicts(t,staged), [])

    def test_capacity_deadline_and_not_before_repeat(self):
        with patch.object(server,'now',return_value=dt.datetime(2026,10,14,8)):
            huge=self.task(duration=600,deadline='2026-10-14')
            plan=server.build_plan(self.store.all('tasks'),self.store.settings(),'2026-10-14',1)
            self.assertEqual(plan['items'], [])
            self.assertEqual(plan['unplaced'][0]['id'],huge['id'])
            t=self.task(title='下次事项',repeat='weekly',duration=30)
            self.store.put('tasks',{**t,'occurrence':'2026-10-19'})
            plan=server.build_plan(self.store.all('tasks'),self.store.settings(),'2026-10-14',7,[t['id']])
            self.assertGreaterEqual(plan['items'][0]['scheduled_at'][:10],'2026-10-19')

    def test_restore_validated_before_overwrite_and_backup(self):
        task=self.task()
        original=self.store.export()
        invalid=copy.deepcopy(original);invalid['settings']['workdays']=[]
        with self.assertRaises(ValueError):self.store.restore(invalid)
        self.assertEqual(self.store.get('tasks',task['id'])['title'],task['title'])
        self.assertFalse((Path(self.temp.name)/'backups').exists())
        self.store.task({'title':'修改后的方案'},task['id'])
        result=self.store.restore(original)
        self.assertEqual(self.store.get('tasks',task['id'])['title'],task['title'])
        self.assertTrue((Path(self.temp.name)/'backups'/result['backup']).is_file())

    def test_import_rejects_markup_in_record_ids(self):
        data=self.store.export();data['projects'][0]['id']='bad" onclick="evil'
        with self.assertRaises(ValueError):self.store.restore(data)

    def test_recurring_forecast_reserves_future_time_and_can_edit_source(self):
        day=(server.now().date()+dt.timedelta(days=1)).isoformat()
        t=self.task(title='每天阅读',repeat='daily',scheduled_at=day+'T14:00',duration=30)
        later=(server.now().date()+dt.timedelta(days=3)).isoformat()
        with self.assertRaisesRegex(ValueError,'冲突'):
            self.task(title='未来会议',scheduled_at=later+'T14:00')
        moved=self.store.task({'scheduled_at':day+'T15:00'},t['id'])
        self.assertEqual(moved['scheduled_at'],day+'T15:00')
        self.assertEqual(len(self.store.all('tasks')),1)

    def test_monthly_forecast_does_not_drift_after_short_month(self):
        t=self.task(repeat='monthly',scheduled_at='2027-01-31T10:00',duration=30)
        preview=server.recurring_previews([t],dt.date(2027,2,1),dt.date(2027,3,31))
        self.assertEqual([x['scheduled_at'] for x in preview],['2027-02-28T10:00','2027-03-31T10:00'])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=server.Store(self.temp.name)
        self.server=server.DeskServer(('127.0.0.1',0),self.store,FakeModels())
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.server.assistant.pool.shutdown(wait=True)
        self.temp.cleanup()

    def request(self,path,method='GET',body=None,headers=None):
        req=urllib.request.Request(self.base+path,data=json.dumps(body).encode() if body is not None else None,method=method,
                                   headers={'X-Personal-Desk':'1','Content-Type':'application/json',**(headers or {})})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=10) as response:return json.loads(response.read())

    def test_health_is_safe_and_model_endpoint_contains_no_key_fields(self):
        health=self.request('/api/health');self.assertEqual(health['app'],'personal-desk')
        self.assertNotIn('key',self.request('/api/models'))

    def test_note_api_creates_edits_archives_and_restores_without_losing_content(self):
        p=self.request('/api/projects','POST',{'name':'示例研究项目','area':'通信组'})
        note=self.request('/api/notes','POST',{'title':'一次思考','content':'第一版判断','project_id':p['id']})
        self.assertEqual(self.request('/api/state')['notes'][0]['id'],note['id'])
        updated=self.request('/api/notes/'+note['id'],'PATCH',{'content':'修订后的判断'})
        self.assertEqual(updated['content'],'修订后的判断')
        self.request('/api/notes/'+note['id'],'DELETE',{})
        self.assertTrue(self.store.get('notes',note['id'])['deleted_at'])
        self.request('/api/notes/'+note['id'],'PATCH',{'restore':True})
        self.assertEqual(self.store.get('notes',note['id'])['content'],'修订后的判断')
        self.assertFalse(self.store.get('notes',note['id'])['deleted_at'])

    def test_project_document_routes_bind_list_and_upload_to_selected_folder(self):
        p=self.request('/api/projects','POST',{'name':'示例研究项目','area':'通信组'})
        root=Path(self.temp.name)/'docs'
        self.request('/api/project-documents/'+p['id']+'/bind','POST',{'path':str(root),'create':True})
        self.request('/api/project-documents/'+p['id']+'/mkdir','POST',{'path':'','name':'阶段一'})
        boundary='sample-boundary-123'
        payload=(f'--{boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n阶段一\r\n'
                 f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="计划.txt"\r\nContent-Type: text/plain\r\n\r\n').encode()+b'hello\r\n'+f'--{boundary}--\r\n'.encode()
        req=urllib.request.Request(self.base+'/api/project-documents/'+p['id']+'/upload',data=payload,method='POST',headers={'X-Personal-Desk':'1','Content-Type':'multipart/form-data; boundary='+boundary})
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=10) as response:self.assertEqual(response.status,201)
        except urllib.error.HTTPError as error:
            self.fail(error.read().decode('utf-8'))
        listing=self.request('/api/project-documents/'+p['id']+'?path='+urllib.parse.quote('阶段一'))
        self.assertEqual(listing['items'][0]['name'],'计划.txt')
        self.assertEqual((root/'阶段一'/'计划.txt').read_bytes(),b'hello')
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request('/api/project-documents/'+p['id']+'?path=..%2F')
        self.assertEqual(error.exception.code,400)

    def test_category_api_is_idempotent_and_prevents_deleting_parent_with_projects(self):
        category = self.request('/api/categories', 'POST', {'name': '新研究组'})
        again = self.request('/api/categories', 'POST', {'name': '新研究组'})
        self.assertEqual(category['id'], again['id'])
        project = self.request('/api/projects', 'POST', {'name': '示例研究项目', 'area': '新研究组',
                                                       'owner': '项目负责人', 'progress': 40})
        self.assertEqual(project['owner'], '项目负责人')
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request('/api/projects/'+category['id'], 'DELETE', {})
        self.assertEqual(error.exception.code, 400)
        self.assertFalse(self.store.get('projects', category['id'])['deleted_at'])

    def test_cross_origin_and_missing_request_header_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('/api/tasks','POST',{'title':'bad'}, {'Origin':'https://untrusted.test'})
        self.assertEqual(error.exception.code,403)
        request=urllib.request.Request(self.base+'/api/state')
        with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request)
        self.assertEqual(error.exception.code,403)
        self.assertEqual(self.store.all('tasks'),[])

    def test_atomic_plan_rejects_stale_schedule_without_partial_writes(self):
        a=self.request('/api/tasks','POST',{'title':'思考A','kind':'deep','duration':60})
        b=self.request('/api/tasks','POST',{'title':'思考B','kind':'deep','duration':60})
        day=(server.now().date()+dt.timedelta(days=1)).isoformat()
        fixed=self.request('/api/tasks','POST',{'title':'会议','kind':'event','fixed':True,'scheduled_at':day+'T10:00'})
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('/api/plan/apply','POST',{'items':[{'id':a['id'],'scheduled_at':day+'T09:00'},{'id':b['id'],'scheduled_at':day+'T10:00'}]})
        self.assertEqual(error.exception.code,400)
        self.assertEqual(self.store.get('tasks',a['id'])['scheduled_at'],'')
        self.assertEqual(self.store.get('tasks',b['id'])['scheduled_at'],'')
        result=self.request('/api/plan/apply','POST',{'items':[{'id':a['id'],'scheduled_at':day+'T09:00'},{'id':b['id'],'scheduled_at':day+'T11:00'}]})
        self.assertEqual(result['count'],2)
        self.assertEqual(self.store.get('tasks',fixed['id'])['scheduled_at'],day+'T10:00')

    def test_task_persistence_and_focus_idempotency(self):
        t=self.request('/api/tasks','POST',{'title':'持续阅读'})
        focus={'id':'focus-session-1','task_id':t['id'],'minutes':25}
        self.request('/api/focus','POST',focus);self.request('/api/focus','POST',focus)
        reloaded=server.Store(self.temp.name)
        self.assertEqual(reloaded.get('tasks',t['id'])['spent_minutes'],25)
        self.assertEqual(len(reloaded.all('focus')),1)

    def test_ai_apply_idempotent_and_fixed_meeting_is_not_moved(self):
        day=(server.now().date()+dt.timedelta(days=1)).isoformat()
        fixed=self.request('/api/tasks','POST',{'title':'固定会议','kind':'event','scheduled_at':day+'T10:00','fixed':True})
        job={'id':'test-job','status':'done','applied':[],'result':{'tasks':[{'title':'新任务'}],
             'updates':[{'id':fixed['id'],'changes':{'scheduled_at':day+'T11:00'},'reason':'移动'}]}}
        self.store.put('jobs',job)
        first=self.request('/api/ai/apply','POST',{'job_id':job['id'],'selected':['task:0','update:0']})
        self.assertEqual(len(first['applied']),1)
        self.assertEqual(len(first['skipped']),1)
        second=self.request('/api/ai/apply','POST',{'job_id':job['id'],'selected':['task:0']})
        self.assertEqual(second['applied'],[])
        self.assertEqual(self.store.get('tasks',fixed['id'])['scheduled_at'],day+'T10:00')

    def test_reminder_deduplication(self):
        t=self.request('/api/tasks','POST',{'title':'检查学生结果','followup_date':server.now().date().isoformat(),'status':'waiting'})
        self.server.assistant.tick(allow_ai=False);self.server.assistant.tick(allow_ai=False)
        n=[x for x in self.store.all('notifications') if x['task_id']==t['id']]
        self.assertEqual(len(n),1)


if __name__=='__main__':unittest.main()
