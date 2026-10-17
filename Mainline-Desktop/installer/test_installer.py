"""Synthetic tests for the installed edition; never modifies real Windows tasks."""
import ast
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


prepare = module('installer_prepare', HERE / 'prepare.py')
reminders = module('installed_reminders', HERE / 'background_reminders.py')


def task_xml(executable, arguments='--check-reminders', enabled=True):
    from xml.sax.saxutils import escape
    return f'''<?xml version="1.0" encoding="UTF-16"?>
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Settings><Enabled>{str(enabled).lower()}</Enabled></Settings>
<Actions><Exec><Command>{escape(str(executable))}</Command><Arguments>{escape(arguments)}</Arguments></Exec></Actions>
</Task>'''.encode('utf-16')


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.exe = self.folder / 'Mainline.exe'
        self.exe.write_bytes(b'Synthetic executable placeholder')
        assets = self.folder / '_internal' / 'public'
        assets.mkdir(parents=True)
        (assets / 'index.html').write_text('Synthetic fixture')

    def query(self, path, **kwargs):
        return subprocess.CompletedProcess([], 0, task_xml(path, **kwargs), b'')

    def test_status_reads_without_mutating_or_repairing(self):
        old = self.folder / 'Mainline-old.exe'
        with patch.object(reminders, '_run', return_value=self.query(old)) as run:
            result = reminders.status(self.exe)
        self.assertEqual(result['background_state'], 'needs_repair')
        self.assertFalse(result['background_enabled'])
        self.assertEqual(run.call_args.args[0], ['/Query', '/TN', reminders.TASK_NAME, '/XML'])
        self.assertEqual(run.call_count, 1)

    def test_oem_redirected_xml_with_utf16_declaration(self):
        target = self.folder / '虚构安装位置' / 'Mainline.exe'
        raw = task_xml(target).decode('utf-16').encode('oem')
        with patch.object(reminders, '_run', return_value=subprocess.CompletedProcess([], 0, raw, b'')):
            result = reminders.status(target)
        self.assertEqual(result['background_state'], 'active')

    def test_explicit_registration_uses_stable_path_and_interactive_user(self):
        absent = subprocess.CompletedProcess([], 1, b'', b'not found')
        success = subprocess.CompletedProcess([], 0, b'', b'')
        with patch.object(reminders, '_run', side_effect=[absent, success, self.query(self.exe)]) as run:
            self.assertTrue(reminders.configure(self.exe, True))
        args = run.call_args_list[1].args[0]
        self.assertEqual(args[0], '/Create')
        self.assertIn('/IT', args)
        self.assertIn('LIMITED', args)
        self.assertIn(f'"{self.exe}" --check-reminders', args)
        self.assertNotIn('/RU', args)
        self.assertNotIn('/RP', args)

    def test_uninstall_leaves_other_version_task_alone(self):
        with patch.object(reminders, '_run', return_value=self.query(self.folder / 'Mainline-v12.exe')) as run:
            reminders.remove_for_uninstall(self.exe)
        self.assertEqual(run.call_count, 1)

    def test_uninstall_removes_only_its_own_task(self):
        absent = subprocess.CompletedProcess([], 1, b'', b'not found')
        success = subprocess.CompletedProcess([], 0, b'', b'')
        with patch.object(reminders, '_run', side_effect=[self.query(self.exe), self.query(self.exe), success, absent]) as run:
            reminders.remove_for_uninstall(self.exe)
        self.assertEqual(run.call_args_list[2].args[0], ['/Delete', '/F', '/TN', reminders.TASK_NAME])

    def test_foreign_task_is_not_overwritten(self):
        with patch.object(reminders, '_run', return_value=self.query(self.folder / 'Unrelated.exe')) as run:
            with self.assertRaises(ValueError):
                reminders.configure(self.exe, True)
        self.assertEqual(run.call_count, 1)

    def test_refuses_arbitrary_executable(self):
        absent = subprocess.CompletedProcess([], 1, b'', b'not found')
        with patch.object(reminders, '_run', return_value=absent):
            with self.assertRaises(ValueError):
                reminders.configure(self.folder / 'Unrelated.exe', True)

    def test_installed_startup_does_not_call_task_scheduler(self):
        source = prepare.SOURCE
        sys.path.insert(0, str(source))
        self.addCleanup(sys.path.remove, str(source))
        with patch.dict(sys.modules, {'background_reminders': reminders}):
            desktop = module('installed_desktop', source / 'desktop.py')
        fake_server = Mock()
        fake_window = Mock()
        fake_window.events.closing = Mock()
        fake_view = SimpleNamespace(create_window=Mock(return_value=fake_window), start=Mock())
        with patch.object(desktop, 'user_data_dir', return_value=self.folder), \
             patch.object(desktop, 'setup_error_log'), patch.object(desktop, 'backup_before_update'), \
             patch.object(desktop, 'migrate_legacy_data', return_value=False), \
             patch.object(desktop, 'free_port', return_value=5179), \
             patch.object(desktop, 'start_backend', return_value=fake_server), \
             patch.object(desktop, 'wait_ready', return_value=True), \
             patch.object(reminders, '_run') as run, \
             patch.dict(sys.modules, {'webview': fake_view}), patch.object(sys, 'argv', ['Mainline.exe']):
            fake_window.events.closing.__iadd__ = Mock(return_value=fake_window.events.closing)
            self.assertEqual(desktop.main(), 0)
        run.assert_not_called()

    def test_uninstall_branch_precedes_database_access(self):
        tree = ast.parse((prepare.SOURCE / 'desktop.py').read_text(encoding='utf-8'))
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        self.assertIn('--uninstall-background-task', ast.unparse(main.body[0]))
        self.assertNotIn('data_dir', ast.unparse(main.body[0]))


if __name__ == '__main__':
    unittest.main()
