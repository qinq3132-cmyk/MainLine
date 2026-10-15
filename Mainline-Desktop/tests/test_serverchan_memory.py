import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import desktop
import server
import background_reminders


KEY = 'SCT' + 'A' * 24  # fixture only, never a real credential


class FakeModels:
    entries = {}
    default = ''

    def complete(self, *args, **kwargs):
        raise ValueError('模型暂时不可用')


class ServerChanMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.store = server.Store(self.folder / 'data')
        self.assistant = server.Assistant(self.store, FakeModels())
        self.project_id = self.store.all('projects')[0]['id']

    def tearDown(self):
        self.assistant.pool.shutdown(wait=False, cancel_futures=True)
        self.temp.cleanup()

    def enable(self):
        return self.assistant.serverchan.save({'sendkey': KEY, 'enabled': True}, server.stamp())

    def test_config_is_local_and_redacted_from_export(self):
        profile = self.enable()
        self.assertNotIn(KEY, json.dumps(profile))
        self.assertNotIn(KEY, json.dumps(self.assistant.serverchan_status()))
        self.assertNotIn(KEY, json.dumps(self.store.export()))
        self.assertIn(KEY, (self.store.dir / 'serverchan-config.json').read_text(encoding='utf-8'))
        with self.assertRaises(ValueError):
            self.assistant.serverchan.save({'sendkey': 'invalid'}, server.stamp())

    def test_only_actionable_reminders_and_dedup_with_failure_counted(self):
        self.enable()
        self.store.task({'title': '今天提交', 'project_id': self.project_id,
                         'deadline': server.now().date().isoformat()})
        self.assistant.tick(allow_ai=False)
        self.assistant.notify('stale-something', '停滞', '不推送')
        with patch.object(server, 'send_serverchan', return_value=False) as send:
            self.assertFalse(self.assistant.flush_push())
            self.assertFalse(self.assistant.flush_push())
            self.assertEqual(send.call_count, 1)
        self.assertEqual(self.store.push_status(server.now().date().isoformat())['used_today'], 1)
        self.assertEqual(self.store.push_status(server.now().date().isoformat())['last_result'], 'failed')

    def test_opted_in_title_never_includes_assignee_or_notes(self):
        self.assistant.serverchan.save({'sendkey': KEY, 'enabled': True, 'include_titles': True}, server.stamp())
        self.store.task({'title': '示例事项', 'project_id': self.project_id,
                         'assignee': '某位同事', 'notes': '私人备注',
                         'followup_date': server.now().date().isoformat()})
        self.assistant.tick(allow_ai=False)
        with patch.object(server, 'send_serverchan', return_value=True) as send:
            self.assertTrue(self.assistant.flush_push())
        sent = ' '.join(send.call_args.args[1:])
        self.assertIn('示例事项', sent)
        self.assertNotIn('某位同事', sent)
        self.assertNotIn('私人备注', sent)

    def test_daily_five_attempt_limit_includes_test(self):
        self.enable()
        with patch.object(server, 'send_serverchan', return_value=True) as send:
            for index in range(5):
                self.assistant.notify(f'due-{index}', '今天到期', f'任务 {index}', 'task')
                self.assertTrue(self.assistant.test_push()['sent'])
            with self.assertRaisesRegex(ValueError, '额度'):
                self.assistant.test_push()
            self.assertEqual(send.call_count, 5)
        self.assertEqual(self.store.push_status(server.now().date().isoformat())['used_today'], 5)

    def test_export_restore_preserves_chat_and_old_exports_do_not_clear_it(self):
        message = {'id': 'm1', 'role': 'user', 'mode': 'chat', 'content': '下周安排会议', 'created_at': server.stamp()}
        self.store.put('messages', message)
        exported = self.store.export()
        self.assertEqual(exported['messages'], [message])
        self.store.restore(exported)
        self.assertEqual(self.store.all('messages'), [message])
        legacy = dict(exported)
        legacy.pop('messages')
        legacy.pop('notifications')
        self.store.restore(legacy)
        self.assertEqual(self.store.all('messages'), [message])

    def test_chat_input_is_saved_even_when_model_fails_and_old_memory_is_recalled(self):
        self.assistant.submit('chat', '下周安排会议')
        self.assistant.pool.shutdown(wait=True)
        messages = self.store.all('messages')
        self.assertTrue(any(m['role'] == 'user' and m['content'] == '下周安排会议' for m in messages))
        for index in range(20):
            self.store.put('messages', {'id': f'old{index}', 'role': 'user', 'mode': 'chat',
                                        'content': f'历史讨论 {index}', 'created_at': f'2026-01-{index+1:02d}T09:00:00'})
        self.store.put('messages', {'id': 'old-meeting', 'role': 'user', 'mode': 'chat',
                                    'content': '之前的会议安排', 'created_at': '2026-01-01T08:00:00'})
        self.assertTrue(any(m['content'] == '之前的会议安排' for m in self.assistant.related_memories('会议安排')))

    def test_first_run_migrates_copy_and_update_backup_without_overwrite(self):
        self.store.put('messages', {'id': 'm1', 'role': 'user', 'mode': 'chat',
                                    'content': '我的日程', 'created_at': server.stamp()})
        target = self.folder / 'desktop-data'
        with patch.object(desktop, 'legacy_data_candidates', return_value=iter([self.store.dir])):
            self.assertTrue(desktop.migrate_legacy_data(target))
            self.assertTrue(desktop.backup_before_update(target))
            self.assertFalse(desktop.migrate_legacy_data(target))
            self.assertFalse(desktop.backup_before_update(target))
        self.assertEqual(server.Store(target).all('messages')[0]['content'], '我的日程')
        self.assertEqual(len(list((target / 'backups').glob('before-update-*.sqlite3'))), 1)
        self.assertEqual(self.store.all('messages')[0]['content'], '我的日程')

    def test_serverchan_api_never_returns_sendkey(self):
        http = server.DeskServer(('127.0.0.1', 0), self.store, FakeModels())
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def request(path, data=None):
            body = json.dumps(data).encode() if data is not None else None
            req = urllib.request.Request(f'http://127.0.0.1:{http.server_port}{path}', data=body,
                                         headers={'X-Personal-Desk': '1', 'Content-Type': 'application/json'})
            with opener.open(req, timeout=5) as response:
                return json.loads(response.read())
        try:
            saved = request('/api/serverchan-config', {'sendkey': KEY, 'enabled': True})
            self.assertTrue(saved['configured'])
            self.assertNotIn(KEY, json.dumps(saved))
            self.assertNotIn(KEY, json.dumps(request('/api/serverchan-config')))
            with patch.object(server, 'send_serverchan', return_value=True):
                result = request('/api/serverchan-test', {})
            self.assertEqual(result['used_today'], 1)
            self.assertNotIn(KEY, json.dumps(result))
        finally:
            http.shutdown()
            http.server_close()
            http.assistant.pool.shutdown(wait=False, cancel_futures=True)

    def test_background_task_command_contains_only_executable_path(self):
        executable = self.folder / 'Mainline.exe'
        executable.write_bytes(b'fixture')
        with patch.object(background_reminders, '_run', return_value=True) as run:
            self.assertTrue(background_reminders.configure(executable, True))
        command = run.call_args_list[0].args[0]
        self.assertIn('--check-reminders', ' '.join(command))
        self.assertNotIn(KEY, ' '.join(command))


if __name__ == '__main__':
    unittest.main()
