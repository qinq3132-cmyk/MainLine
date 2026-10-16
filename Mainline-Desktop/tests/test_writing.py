"""Writing persistence checks using invented notes and generated image bytes only."""
import base64
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
import urllib.error
import urllib.request
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from note_store import MAX_NOTE_LENGTH

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=')


class WritingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = server.Store(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def payload(self, **changes):
        return {'id':'synthetic-note', 'title':'虚构项目的观察', 'content':'## 想法\n\n先记录，再验证。\n',
                'project_id':'', 'format':'markdown', 'base_revision':0, **changes}

    def test_legacy_body_and_identity_are_preserved_with_revision_before_edit(self):
        old = self.store.put('notes', {'id':'legacy', 'title':'原始笔记', 'content':'第一段\n  保留空格。\n',
            'project_id':'', 'created_at':'2026-01-01T09:00:00', 'updated_at':'2026-01-01T09:00:00', 'deleted_at':''})
        result = self.store.save_writing(self.payload(id=old['id'], content='新的判断。'))
        self.assertEqual(result['note']['id'], old['id'])
        self.assertEqual(result['note']['created_at'], old['created_at'])
        self.assertEqual(self.store.writing_versions(old['id'])[0]['content'], old['content'])

    def test_incomplete_draft_survives_restart_and_promotes_without_duplicate(self):
        result = self.store.save_writing(self.payload(title=''))
        self.assertFalse(result['saved'])
        self.store = server.Store(self.temp.name)
        self.assertEqual(self.store.writing_drafts()[0]['content'], self.payload()['content'])
        note = self.store.save_writing(self.payload())['note']
        self.assertEqual(note['id'], 'synthetic-note')
        self.assertFalse(self.store.writing_drafts())
        again = self.store.save_writing(self.payload(base_revision=note['revision']))
        self.assertEqual(again['note']['revision'], note['revision'])
        self.assertEqual(len(self.store.all('notes')), 1)

    def test_stale_writer_cannot_overwrite_new_content_and_retains_draft(self):
        note = self.store.save_writing(self.payload())['note']
        self.store.save_writing(self.payload(base_revision=note['revision'], content='另一处的新内容。'))
        conflict = self.store.save_writing(self.payload(base_revision=note['revision'], content='尚未同步的想法。'))
        self.assertTrue(conflict['conflict'])
        self.assertEqual(self.store.get('notes', note['id'])['content'], '另一处的新内容。')
        self.assertEqual(self.store.writing_drafts()[0]['content'], '尚未同步的想法。')

    def test_images_export_with_portable_paths_and_reopen_from_sqlite_backup(self):
        image = self.store.add_note_image('测试图片.png', PNG)
        body = '看这张图。\n\n![说明](' + image['url'] + ')\n'
        note = self.store.save_writing(self.payload(content=body))['note']
        raw, name, mime = self.store.export_note(note['id'])
        self.assertTrue(name.endswith('.zip'))
        self.assertEqual(mime, 'application/zip')
        with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
            md = next(n for n in bundle.namelist() if n.endswith('.md'))
            text = bundle.read(md).decode('utf-8')
            self.assertNotIn('/note-assets/', text)
            image_path = 'images/' + image['id'] + '.png'
            self.assertIn(image_path, text)
            self.assertEqual(bundle.read(image_path), PNG)
        backup = self.store.backup()
        with closing(sqlite3.connect(self.store.dir / 'backups' / backup)) as db:
            self.assertEqual(db.execute('SELECT body FROM note_images').fetchone()[0], PNG)
        self.assertEqual(server.Store(self.temp.name).note_image(image['id'])[1], PNG)

    def test_full_export_restore_carries_images_versions_drafts_and_long_notes(self):
        image = self.store.add_note_image('图片.png', PNG)
        note = self.store.save_writing(self.payload(content='长内容。' * 10000))['note']
        self.store.save_writing(self.payload(base_revision=note['revision'], content='调整后的内容。', checkpoint=True))
        self.store.save_writing(self.payload(id='unfinished', title=''))
        exported = self.store.export()
        with tempfile.TemporaryDirectory() as other:
            restored = server.Store(other)
            restored.restore(exported)
            self.assertEqual(restored.note_image(image['id'])[1], PNG)
            self.assertEqual(len(restored.writing_versions(note['id'])), 1)
            self.assertEqual(restored.writing_drafts()[0]['id'], 'unfinished')
            legacy = dict(exported); del legacy['writing']
            restored.restore(legacy)
            self.assertEqual(restored.note_image(image['id'])[1], PNG)

    def test_invalid_image_and_oversized_body_never_replace_note(self):
        with self.assertRaises(ValueError): self.store.add_note_image('bad.png', b'<svg onload="bad">')
        with self.assertRaises(ValueError): self.store.save_writing(self.payload(content='x' * (MAX_NOTE_LENGTH + 1)))
        self.assertFalse(self.store.all('notes'))


class WritingApiTests(unittest.TestCase):
    def test_image_upload_local_read_and_export_auth(self):
        class Models:
            entries = {}; default = ''
        with tempfile.TemporaryDirectory() as folder:
            store = server.Store(folder)
            srv = server.DeskServer(('127.0.0.1', 0), store, Models())
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            base = f'http://127.0.0.1:{srv.server_port}'
            try:
                boundary = 'mainline-synthetic-boundary'
                body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
                        + PNG + f'\r\n--{boundary}--\r\n'.encode())
                req = urllib.request.Request(base+'/api/writing/images', data=body, headers={
                    'X-Personal-Desk':'1', 'Content-Type':'multipart/form-data; boundary='+boundary})
                with opener.open(req) as response: image = json.load(response)
                with opener.open(base+image['url']) as response:
                    self.assertEqual(response.read(), PNG)
                    self.assertEqual(response.headers['Content-Type'], 'image/png')
                    self.assertEqual(response.headers['Cross-Origin-Resource-Policy'], 'same-origin')
                with self.assertRaises(urllib.error.HTTPError):
                    opener.open(urllib.request.Request(base+image['url'], headers={'Sec-Fetch-Site':'cross-site'}))
                note = store.note({'title':'测试导出', 'content':'纯文字'})
                with self.assertRaises(urllib.error.HTTPError): opener.open(base+'/api/writing/export/'+note['id'])
                req = urllib.request.Request(base+'/api/writing/export/'+note['id'], headers={'X-Personal-Desk':'1'})
                with opener.open(req) as response: self.assertIn('纯文字', response.read().decode('utf-8'))
            finally:
                srv.shutdown(); srv.server_close(); srv.assistant.pool.shutdown(wait=True)


class DesktopWritingTests(unittest.TestCase):
    def test_native_export_uses_save_dialog_and_writes_portable_markdown(self):
        import desktop
        with tempfile.TemporaryDirectory() as folder:
            store = server.Store(folder)
            note = store.note({'title':'虚构桌面导出', 'content':'本地文字。'})
            target = Path(folder) / 'writing.md'
            bridge = desktop.DesktopBridge()
            bridge._store = store
            bridge._window = SimpleNamespace(create_file_dialog=lambda *a, **kw: str(target))
            webview = SimpleNamespace(FileDialog=SimpleNamespace(SAVE='save'))
            with patch.dict(sys.modules, {'webview': webview}):
                result = bridge.export_note(note['id'])
            self.assertTrue(result['saved'])
            self.assertIn('本地文字。', target.read_text(encoding='utf-8'))

    def test_normal_desktop_close_flushes_pending_text_to_local_store(self):
        import desktop
        class Event(list):
            def __iadd__(self, callback):
                self.append(callback)
                return self
        with tempfile.TemporaryDirectory() as folder:
            store = server.Store(folder)
            draft = {'id':'native-pending', 'title':'虚构关闭测试', 'content':'关闭前的最后一段文字。',
                     'project_id':'', 'format':'markdown', 'base_revision':0}
            event = Event()
            destroyed = threading.Event()
            window = SimpleNamespace(events=SimpleNamespace(closing=event),
                evaluate_js=lambda code: {'uploading':False, 'draft':draft}, destroy=destroyed.set)
            assistant = SimpleNamespace(stop=threading.Event(), pool=SimpleNamespace(shutdown=lambda **kw: None))
            srv = SimpleNamespace(store=store, assistant=assistant, shutdown=lambda:None, server_close=lambda:None)
            def native_loop():
                self.assertEqual(event[0](), False, 'Initial native close must release the GUI thread')
                self.assertTrue(destroyed.wait(3), 'Close worker must save and then destroy the window')
                self.assertIsNone(event[0](), 'The second close must be allowed')
            webview = SimpleNamespace(create_window=lambda *a, **kw: window, start=native_loop)
            with patch.dict(sys.modules, {'webview':webview}), patch.dict('os.environ', {'MAINLINE_DATA_DIR':folder}), \
                    patch.object(desktop, 'setup_error_log'), patch.object(desktop, 'free_port', return_value=0), \
                    patch.object(desktop, 'start_backend', return_value=srv), patch.object(desktop, 'wait_ready', return_value=True):
                self.assertEqual(desktop.main(), 0)
            self.assertEqual(store.get('notes', 'native-pending')['content'], draft['content'])


if __name__ == '__main__':
    unittest.main()
