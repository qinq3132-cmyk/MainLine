import http.server
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_config import LLMConfig
import server

FAKE_TEST_KEY = 'demo-credential-only-for-unit-tests'


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'llm-config.json'
        self.config = LLMConfig(self.path, environ={})
    def tearDown(self):self.temp.cleanup()
    def profile(self, **changes):
        return {'base_url':'https://api.example.com/v1','models':['model-a','model-b'],
                'api_key':FAKE_TEST_KEY,'use_opencode':False,**changes}

    def test_save_redaction_key_preservation_rotation_and_clear(self):
        public=self.config.save(self.profile())
        self.assertTrue(public['api_key_configured']);self.assertNotIn(FAKE_TEST_KEY,json.dumps(public))
        self.config.save({'models':['model-c'],'api_key':''})
        self.assertEqual(self.config.load()['api_key'],FAKE_TEST_KEY)
        self.assertEqual(self.config.load()['default_model'],'model-c')
        self.config.save({'api_key':'another-fake-test-value'})
        self.assertEqual(self.config.load()['api_key'],'another-fake-test-value')
        self.config.save({'clear_api_key':True})
        self.assertFalse(self.config.public()['api_key_configured'])

    def test_invalid_change_does_not_overwrite_config(self):
        self.config.save(self.profile());original=self.path.read_bytes()
        for change in [{'base_url':'https://user:password@example.com/v1'},
                       {'base_url':'https://api.example.com/v1?api_key=test'},
                       {'base_url':'https://api.example.com/v1/chat/completions'},
                       {'models':['a','a']},{'api_key':'bad\nheader'},{'use_opencode':'yes'}]:
            with self.assertRaises(ValueError):self.config.save(change)
            self.assertEqual(self.path.read_bytes(),original)

    def test_environment_overrides_and_references(self):
        self.config.save(self.profile(api_key='{env:CUSTOM_KEY}'))
        from_env=LLMConfig(self.path,environ={'CUSTOM_KEY':FAKE_TEST_KEY})
        self.assertTrue(from_env.public()['api_key_configured'])
        env={'MAINLINE_BASE_URL':'https://api.example.net/v1','MAINLINE_MODEL':'env-model',
             'MAINLINE_API_KEY':FAKE_TEST_KEY}
        loaded=LLMConfig(self.path,environ=env)
        self.assertEqual(loaded.load()['default_model'],'env-model')
        self.assertNotIn(FAKE_TEST_KEY,json.dumps(loaded.public()))
        with self.assertRaisesRegex(ValueError,'环境变量'):loaded.save({'models':['other']})

    def test_standalone_does_not_read_opencode_and_configured_env_path(self):
        self.config.save(self.profile())
        with patch.dict(os.environ,{'MAINLINE_CONFIG':str(self.path)},clear=True),patch.object(server.Path,'home',side_effect=AssertionError('No OpenCode read')):
            model=server.Models(Path(self.temp.name)/'unused.json')
            self.assertEqual(model.default,'manual/model-a')
            self.assertEqual(set(model.entries),{'manual/model-a','manual/model-b'})
            self.assertNotIn(FAKE_TEST_KEY,json.dumps(model.public(),ensure_ascii=False))
            self.assertEqual(model.public()['source'],'独立配置')

    def test_empty_config_allows_optional_opencode(self):
        self.assertTrue(self.config.public()['use_opencode'])
        self.assertEqual(self.config.public()['models'],[])
        self.assertFalse(self.config.public()['api_key_configured'])

    def test_bad_json_does_not_expose_file_contents(self):
        self.path.write_text('{'+FAKE_TEST_KEY,encoding='utf-8')
        with self.assertRaises(ValueError) as caught:self.config.load()
        self.assertNotIn(FAKE_TEST_KEY,str(caught.exception))


class ProviderHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        self.server.observed_header=self.headers.get('Authorization')
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.observed_model=payload['model']
        if len(payload['messages'])==1:
            content='连接成功 '+FAKE_TEST_KEY
        else:
            content=json.dumps({'summary':'整理完成','tasks':[{'title':'下一步行动'}],'updates':[],'questions':[]})
        body=json.dumps({'choices':[{'message':{'content':content},'finish_reason':'stop'}],'usage':{}}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)


class ConfigApiTests(unittest.TestCase):
    def test_ui_configuration_to_real_request_without_opencode(self):
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{},clear=True):
            provider=http.server.ThreadingHTTPServer(('127.0.0.1',0),ProviderHandler)
            threading.Thread(target=provider.serve_forever,daemon=True).start()
            cfg=LLMConfig(Path(folder)/'llm-config.json');cfg.save({'use_opencode':False})
            models=server.Models(cfg.path)
            app=server.DeskServer(('127.0.0.1',0),server.Store(folder),models)
            threading.Thread(target=app.serve_forever,daemon=True).start()
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            def req(path,data=None):
                request=urllib.request.Request(f'http://127.0.0.1:{app.server_port}'+path,
                    data=json.dumps(data).encode() if data is not None else None,
                    headers={'X-Personal-Desk':'1','Content-Type':'application/json'})
                with opener.open(request,timeout=10) as response:return json.loads(response.read())
            def finished(job):
                for _ in range(100):
                    result=req('/api/jobs/'+job['id'])
                    if result['status']!='running':return result
                    time.sleep(.02)
                self.fail('Mock model request did not finish')
            try:
                result=req('/api/llm-config',{'base_url':f'http://127.0.0.1:{provider.server_port}/v1',
                    'models':['fixture-model'],'api_key':FAKE_TEST_KEY,'use_opencode':False})
                self.assertEqual(result['default'],'manual/fixture-model')
                public=req('/api/llm-config');self.assertTrue(public['api_key_configured'])
                self.assertNotIn(FAKE_TEST_KEY,json.dumps(public))
                tested=finished(req('/api/ai',{'mode':'test'}))
                self.assertEqual(tested['status'],'done')
                self.assertNotIn(FAKE_TEST_KEY,json.dumps(tested))
                self.assertEqual(provider.observed_header,'Bearer '+FAKE_TEST_KEY)
                captured=finished(req('/api/ai',{'mode':'capture','text':'安排一次思考'}))
                self.assertEqual(captured['result']['tasks'][0]['title'],'下一步行动')
                for path in ['/api/state','/api/export','/api/models','/api/jobs']:
                    self.assertNotIn(FAKE_TEST_KEY,json.dumps(req(path)))
                self.assertNotIn(FAKE_TEST_KEY,(Path(folder)/'desk.sqlite3').read_bytes().decode('latin1'))
                self.assertEqual(server.Models(cfg.path).default,'manual/fixture-model')
                req('/api/llm-config',{'clear_api_key':True})
                self.assertTrue(req('/api/models')['models'][0]['configured'])
                self.assertEqual(finished(req('/api/ai',{'mode':'test'}))['status'],'done')
                self.assertIsNone(provider.observed_header)
            finally:
                app.shutdown();app.server_close();app.assistant.pool.shutdown(wait=True)
                provider.shutdown();provider.server_close()


if __name__=='__main__':unittest.main()
