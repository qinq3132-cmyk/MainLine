import copy
import datetime as dt
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.request
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import documents
import server


def zipped(parts):
    buf=io.BytesIO()
    with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:
        for name,text in parts.items():z.writestr(name,text)
    return buf.getvalue()


def word_fixture():
    return zipped({'word/document.xml':f'''<w:document xmlns:w="{documents.W[1:-1]}"><w:body><w:p><w:r><w:t>周五前整理实验方案</w:t></w:r><w:del><w:r><w:t>已删除的旧方向</w:t></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>下周三讨论芯片实验</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'''})


def ppt_fixture():
    return zipped({
        'ppt/presentation.xml':f'<p:presentation xmlns:p="{documents.P[1:-1]}" xmlns:r="{documents.R[1:-1]}"><p:sldIdLst><p:sldId id="7" r:id="r7"/><p:sldId id="2" r:id="r2"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="r7" Target="slides/slide7.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>',
        'ppt/slides/slide7.xml':f'<p:sld xmlns:p="{documents.P[1:-1]}" xmlns:a="{documents.A[1:-1]}"><a:t>每周保留两小时深度思考</a:t></p:sld>',
        'ppt/slides/slide2.xml':f'<p:sld xmlns:p="{documents.P[1:-1]}" xmlns:a="{documents.A[1:-1]}"><a:t>周四和同学检查实验数据</a:t></p:sld>',
        'ppt/slides/_rels/slide7.xml.rels':'<Relationships><Relationship Id="n1" Target="../notesSlides/notesSlide7.xml" Type="x/notesSlide"/></Relationships>',
        'ppt/notesSlides/notesSlide7.xml':f'<p:notes xmlns:p="{documents.P[1:-1]}" xmlns:a="{documents.A[1:-1]}"><p:sp><a:t>讲稿里的下一步</a:t></p:sp><p:sp><p:ph type="sldNum"/><a:t>999</a:t></p:sp></p:notes>'})


class DocumentTests(unittest.TestCase):
    def test_word_body_tables_and_deleted_text(self):
        result=documents.extract('研究计划.docx',word_fixture())
        self.assertIn('[正文 第1段]',result['text'])
        self.assertIn('下周三讨论芯片实验',result['text'])
        self.assertNotIn('已删除',result['text'])
        self.assertEqual(result['kind'],'Word')

    def test_ppt_actual_slide_order_and_speaker_notes(self):
        result=documents.extract('计划.pptx',ppt_fixture())
        self.assertTrue(result['text'].startswith('[第1页幻灯片]\n每周'))
        self.assertIn('[第1页讲稿备注]\n讲稿里的下一步',result['text'])
        self.assertNotIn('999',result['text'])
        self.assertEqual(result['units'],2)

    def test_excel_shared_inline_and_formula(self):
        data=zipped({'xl/workbook.xml':f'<workbook xmlns="{documents.S[1:-1]}" xmlns:r="{documents.R[1:-1]}"><sheets><sheet name="计划" r:id="s1"/></sheets></workbook>',
                     'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/></Relationships>',
                     'xl/sharedStrings.xml':f'<sst xmlns="{documents.S[1:-1]}"><si><t>方向</t></si></sst>',
                     'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{documents.S[1:-1]}"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>科研</t></is></c><c r="C1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>'})
        result=documents.extract('计划.xlsx',data)
        self.assertIn('A1: 方向 | B1: 科研 | C1: =1+2 → 3',result['text'])

    def test_invalid_legacy_empty_and_oversize(self):
        for name,data in [('a.doc',b'old'),('a.pptx',b'corrupt'),('a.txt',b''),('a.txt',b'a'*(documents.MAX_BYTES+1))]:
            with self.assertRaises(ValueError):documents.extract(name,data)
        result=documents.extract('a.txt',b'a'*(documents.MAX_TEXT+5))
        self.assertTrue(result['truncated']);self.assertEqual(len(result['text']),documents.MAX_TEXT)


class GoalFileTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.store=server.Store(self.temp.name)
    def tearDown(self):self.temp.cleanup()

    def test_recurring_investment_keeps_goal_link_and_history_after_restore(self):
        goal = self.store.goal({'title': '科研积累'})
        habit = self.store.task({'title': '每周阅读', 'kind': 'habit', 'repeat': 'weekly', 'goal_id': goal['id']})
        independent = self.store.task({'title': '运动', 'kind': 'habit', 'repeat': 'daily'})
        self.store.task({'status': 'done'}, habit['id'])
        self.store.restore(self.store.export())
        linked = [t for t in self.store.all('tasks') if t.get('goal_id') == goal['id']]
        self.assertEqual(len(linked), 2)
        self.assertEqual(sum(t['status'] == 'done' for t in linked), 1)
        self.assertEqual(sum(t['status'] == 'todo' for t in linked), 1)
        self.assertEqual(self.store.get('tasks', independent['id'])['goal_id'], '')

    def test_goal_checkin_and_task_link_survive_reload_and_backup(self):
        g=self.store.goal({'title':'形成持续的科研方向','vision':'长期积累','commitment':'每周两小时','review_days':14})
        t=self.store.task({'title':'梳理核心问题','goal_id':g['id']})
        with self.assertRaises(ValueError):self.store.task({'title':'无效目标','goal_id':'missing'})
        checked=self.store.goal_checkin(g['id'],'完成了问题清单，下一步找文献')
        self.assertEqual(len(checked['checkins']),1)
        self.assertEqual(checked['next_review'],(server.now().date()+dt.timedelta(days=14)).isoformat())
        self.store.goal({'title':'修订目标'},g['id'])
        self.assertEqual(len(self.store.get('goals',g['id'])['checkins']),1)
        backup=self.store.export();self.store.restore(backup)
        reloaded=server.Store(self.temp.name)
        self.assertEqual(reloaded.get('tasks',t['id'])['goal_id'],g['id'])
        self.assertEqual(len(reloaded.get('goals',g['id'])['checkins']),1)

    def test_goal_reminders_are_deduplicated_and_pause_suppresses(self):
        g=self.store.goal({'title':'写作','next_review':server.now().date().isoformat()})
        models=type('Models',(),{'entries':{}})()
        assistant=server.Assistant(self.store,models)
        assistant.tick(allow_ai=False);assistant.tick(allow_ai=False)
        reminders=[n for n in self.store.all('notifications') if n.get('goal_id')==g['id']]
        self.assertEqual(len(reminders),1)
        self.store.goal_checkin(g['id'],'完成本周写作')
        assistant.tick(allow_ai=False)
        self.assertEqual(len(self.store.all('notifications')),1)
        self.assertTrue(self.store.all('notifications')[0]['read'])
        self.store.goal({'status':'paused','next_review':'2026-01-01'},g['id'])
        assistant.tick(allow_ai=False)
        self.assertEqual(len(self.store.all('notifications')),1)

    def test_file_metadata_text_export_and_backward_compatibility(self):
        f=self.store.add_file('../../计划.docx',word_fixture())
        self.assertEqual(f['name'],'计划.docx');self.assertNotIn('text',f);self.assertNotIn('stored_filename',f)
        self.assertEqual(self.store.state()['files'][0],f)
        backup=self.store.export()
        self.assertIn('周五',backup['files'][0]['text']);self.assertNotIn('stored_filename',backup['files'][0])
        self.store.restore(backup)
        g=self.store.goal({'title':'长期方向'})
        legacy=self.store.export();del legacy['goals'];del legacy['files']
        self.store.restore(legacy)
        self.assertEqual(self.store.get('goals',g['id'])['title'],'长期方向')
        self.assertEqual(len(self.store.all('files')),1)
        broken=copy.deepcopy(backup);broken['files'][0]['text']='x'*120001
        with self.assertRaises(ValueError):self.store.restore(broken)

    def test_document_content_and_goal_context_reach_model(self):
        f=self.store.add_file('科研.docx',word_fixture());g=self.store.goal({'title':'持续科研'})
        class Models:
            entries={'fake':{}};default='fake';seen=None
            def complete(self, model, messages, **kwargs):
                self.seen=messages
                return {'summary':'已读取科研.docx 的正文','tasks':[],'updates':[],'questions':[]},{}
        models=Models();assistant=server.Assistant(self.store,models)
        with patch.object(assistant.pool,'submit'):
            job=assistant.submit('capture',file_ids=[f['id']])
        assistant.run(self.store.get('jobs',job['id']))
        text=json.dumps(models.seen,ensure_ascii=False)
        self.assertIn('周五前整理实验方案',text);self.assertIn(g['title'],text)
        self.assertEqual(self.store.get('jobs',job['id'])['status'],'done')
        with self.assertRaises(ValueError):assistant.submit('capture',file_ids=['missing'])


class UploadApiTests(unittest.TestCase):
    def test_real_multipart_upload_and_goals_routes(self):
        with tempfile.TemporaryDirectory() as folder:
            models=type('Models',(),{'entries':{},'default':''})()
            app=server.DeskServer(('127.0.0.1',0),server.Store(folder),models)
            thread=threading.Thread(target=app.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{app.server_port}'
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            def req(path,method='GET',data=None,ctype='application/json'):
                r=urllib.request.Request(base+path,data=data,method=method,headers={'X-Personal-Desk':'1','Content-Type':ctype})
                with opener.open(r,timeout=10) as response:return json.loads(response.read())
            try:
                boundary='desk-upload-test'
                body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="plan.docx"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+word_fixture()+f'\r\n--{boundary}--\r\n'.encode())
                f=req('/api/files','POST',body,'multipart/form-data; boundary='+boundary)
                self.assertNotIn('text',f)
                self.assertIn('周五',req('/api/files/'+f['id'])['text'])
                g=req('/api/goals','POST',json.dumps({'title':'持续阅读'}).encode())
                checked=req('/api/goals/'+g['id']+'/checkin','POST',json.dumps({'note':'读了两篇文献'}).encode())
                self.assertEqual(len(checked['checkins']),1)
                req('/api/files/'+f['id'],'DELETE',b'{}')
                self.assertEqual(req('/api/state')['files'],[])
            finally:app.shutdown();app.server_close();thread.join(2)


if __name__=='__main__':unittest.main()
