"""Local Server酱 settings and a deliberately bounded push transport."""
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.parse
import urllib.request


DAILY_LIMIT = 5
ENDPOINT = 'https://sctapi.ftqq.com/'


class ServerChanConfig:
    def __init__(self, path):
        self.path = Path(path)

    def load(self):
        try:
            raw = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {}
        except (OSError, ValueError):
            raise ValueError('微信提醒配置无法读取。') from None
        if not isinstance(raw, dict):
            raise ValueError('微信提醒配置格式不正确。')
        return {'sendkey': str(raw.get('sendkey') or ''), 'enabled': raw.get('enabled') is True,
                'include_titles': raw.get('include_titles') is True,
                'enabled_at': str(raw.get('enabled_at') or '')}

    def public(self):
        config = self.load()
        return {'configured': bool(config['sendkey']), 'enabled': config['enabled'],
                'include_titles': config['include_titles'], 'daily_limit': DAILY_LIMIT}

    def save(self, changes, timestamp):
        if not isinstance(changes, dict):
            raise ValueError('微信提醒设置格式不正确。')
        old = self.load()
        sendkey = str(changes.get('sendkey') or '').strip()
        if sendkey and not re.fullmatch(r'SCT[A-Za-z0-9]{8,200}', sendkey):
            raise ValueError('SendKey 格式不正确，请粘贴以 SCT 开头的密钥。')
        if changes.get('clear_sendkey'):
            old['sendkey'] = ''
        elif sendkey:
            old['sendkey'] = sendkey
        for key in ('enabled', 'include_titles'):
            if key in changes:
                if type(changes[key]) is not bool:
                    raise ValueError('微信提醒设置格式不正确。')
                old[key] = changes[key]
        if old['enabled'] and not old['sendkey']:
            raise ValueError('请先填写 SendKey，再开启微信提醒。')
        if old['enabled'] and not self.load()['enabled']:
            old['enabled_at'] = timestamp
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                             prefix='.serverchan-', suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(old, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
            if os.name != 'nt':
                temporary.chmod(0o600)
            os.replace(temporary, self.path)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()
        return self.public()


def send(sendkey, title, description):
    """One attempt. Never put SendKey or provider response in an exception/log."""
    if not re.fullmatch(r'SCT[A-Za-z0-9]{8,200}', sendkey):
        return False
    safe_title = re.sub(r'[\r\n]+', ' ', title).strip()[:32]
    body = urllib.parse.urlencode({'title': safe_title, 'desp': description[:4000]}).encode('utf-8')
    request = urllib.request.Request(ENDPOINT + sendkey + '.send', data=body,
                                     headers={'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.loads(response.read(100000))
        return isinstance(result, dict) and result.get('code') == 0
    except Exception:
        return False
