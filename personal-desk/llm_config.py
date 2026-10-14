"""Standalone, local-only model configuration. Credentials never enter task data."""
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.parse


class LLMConfig:
    def __init__(self, path, environ=None):
        self.env = os.environ if environ is None else environ
        self.path = Path(self.env.get('MAINLINE_CONFIG') or path).expanduser()

    @property
    def environment_active(self):
        return any(self.env.get(name) for name in ['MAINLINE_BASE_URL', 'MAINLINE_MODEL', 'MAINLINE_API_KEY'])

    def read(self):
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding='utf-8-sig'))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (OSError, ValueError):
            raise ValueError('独立模型配置无法读取，请检查 JSON 文件。') from None

    def normalize(self, data):
        if not isinstance(data, dict):
            raise ValueError('模型配置格式不正确。')
        result = {'provider_name': str(data.get('provider_name') or '自定义接口').strip()[:100],
                  'base_url': str(data.get('base_url') or '').strip().rstrip('/'),
                  'api_key': data.get('api_key') or '', 'models': [],
                  'use_opencode': data.get('use_opencode', True)}
        if type(result['use_opencode']) is not bool or not isinstance(result['api_key'], str):
            raise ValueError('模型配置格式不正确。')
        if len(result['api_key']) > 8192 or any(c in result['api_key'] for c in '\r\n'):
            raise ValueError('API Key 格式不正确。')
        if result['base_url']:
            url = urllib.parse.urlsplit(result['base_url'])
            if url.scheme not in {'https', 'http'} or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError('服务地址需要是 HTTP/HTTPS 根地址，不能含密钥、查询参数或登录信息。')
            if result['base_url'].endswith('/chat/completions'):
                raise ValueError('请填写 API 根地址，不要包含 /chat/completions。')
        models = data.get('models', [])
        if not isinstance(models, list) or len(models) > 100:
            raise ValueError('模型列表格式不正确，最多 100 个。')
        ids = set()
        for item in models:
            if isinstance(item, str):
                item = {'id': item}
            if not isinstance(item, dict) or not isinstance(item.get('id'), str):
                raise ValueError('请填写有效的模型 ID。')
            mid = item['id'].strip()
            if not mid or len(mid) > 200 or any(ord(c) < 32 for c in mid) or mid in ids:
                raise ValueError('模型 ID 不能为空、重复或包含控制字符。')
            ids.add(mid)
            result['models'].append({'id': mid, 'name': str(item.get('name') or mid)[:200]})
        if bool(result['base_url']) != bool(result['models']):
            raise ValueError('请同时填写服务地址和模型 ID。')
        default = data.get('default_model') or (result['models'][0]['id'] if result['models'] else '')
        if default and default not in ids:
            raise ValueError('默认模型需要出现在模型列表中。')
        result['default_model'] = default
        return result

    def load(self):
        data = self.read()
        for env_name, key in [('MAINLINE_BASE_URL', 'base_url'), ('MAINLINE_API_KEY', 'api_key')]:
            if self.env.get(env_name):
                data[key] = self.env[env_name]
        if self.env.get('MAINLINE_MODEL'):
            data['models'] = [self.env['MAINLINE_MODEL']]
            data['default_model'] = self.env['MAINLINE_MODEL']
        return self.normalize(data)

    def key(self, profile):
        return re.sub(r'\{env:([^}]+)\}', lambda match:self.env.get(match.group(1), ''), profile['api_key'])

    def public(self):
        profile = self.load()
        return {k: v for k, v in profile.items() if k != 'api_key'} | {
            'api_key_configured': bool(self.key(profile)), 'environment_active': self.environment_active}

    def save(self, changes):
        if self.environment_active:
            raise ValueError('当前由 MAINLINE 环境变量提供配置，请修改环境变量后重新读取。')
        old = self.read()
        data = {**old, **{k:v for k,v in changes.items() if k in {
            'provider_name', 'base_url', 'models', 'default_model', 'use_opencode'}}}
        if 'models' in changes and 'default_model' not in changes:
            data['default_model'] = ''
        if changes.get('clear_api_key'):
            data['api_key'] = ''
        elif changes.get('api_key'):
            data['api_key'] = changes['api_key']
        profile = self.normalize(data)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                             prefix='.llm-', suffix='.tmp', delete=False) as output:
                temporary = Path(output.name)
                json.dump(profile, output, ensure_ascii=False, indent=2)
                output.write('\n')
            if os.name != 'nt':
                temporary.chmod(0o600)
            os.replace(temporary, self.path)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()
        return self.public()
