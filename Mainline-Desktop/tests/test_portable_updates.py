import datetime as dt
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import desktop


class PortableUpdates(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = server.Store(self.tmp.name)

    def test_skip_preserves_history_and_advances_once(self):
        today = server.now().date()
        task = self.store.task({'title':'Synthetic exercise','repeat':'daily','scheduled_at':(today-dt.timedelta(days=1)).isoformat()+'T08:00'})
        skipped = self.store.task({'status':'skipped'}, task['id'])
        self.assertEqual(skipped['completed_at'], '')
        self.assertTrue(skipped['skipped_at'])
        self.assertFalse(skipped['deleted_at'])
        self.store.task({'status':'skipped'}, task['id'])
        items = self.store.all('tasks')
        self.assertEqual(len(items), 2)
        pending = next(t for t in items if t['id'] != task['id'])
        self.assertEqual(pending['occurrence'], (today+dt.timedelta(days=1)).isoformat())
        self.assertEqual(pending['status'], 'todo')
        self.assertEqual(pending['skipped_at'], '')
        self.assertEqual(sum(t['status']=='done' for t in items), 0)

    def test_future_and_nonrecurring_cannot_be_skipped(self):
        future = (server.now().date()+dt.timedelta(days=1)).isoformat()
        for data in [{'title':'Synthetic one-off'}, {'title':'Synthetic future','repeat':'weekly','deadline':future}]:
            task = self.store.task(data)
            with self.assertRaises(ValueError):
                self.store.task({'status':'skipped'},task['id'])
            self.assertEqual(self.store.get('tasks',task['id'])['status'],'todo')

    def test_document_backup_restore_export_and_native_open(self):
        raw = b'%PDF-1.4\nSynthetic fixture\n%%EOF'
        asset = self.store.add_note_document('fictional.pdf', raw)
        note = self.store.note({'title':'Synthetic documents','format':'markdown','content':'[Attachment]('+asset['url']+')'})
        body, name, mime = self.store.export_note(note['id'])
        self.assertTrue(name.endswith('.zip'))
        with zipfile.ZipFile(io.BytesIO(body)) as z:
            documents = [n for n in z.namelist() if n.startswith('documents/')]
            self.assertEqual(z.read(documents[0]),raw)
        backup = self.store.validate_writing_backup(self.store.writing_export())
        other = server.Store(Path(self.tmp.name)/'restored')
        with other.connect() as db:
            other.import_writing(db,backup)
        self.assertEqual(other.note_image(asset['id'])[1],raw)
        bridge = desktop.DesktopBridge(); bridge._store = other
        with patch('os.startfile') as opened:
            self.assertTrue(bridge.open_note_document(asset['id'])['opened'])
        self.assertEqual(Path(opened.call_args.args[0]).read_bytes(),raw)
        self.assertIn('error',bridge.open_note_document('../bad'))

    def test_rejects_invalid_and_executable_attachments(self):
        for name,raw in [('payload.exe',b'MZ'),('fake.pdf',b'MZ'),('fake.docx',b'not a zip')]:
            with self.assertRaises(ValueError):
                self.store.add_note_document(name,raw)


if __name__ == '__main__':
    unittest.main()
