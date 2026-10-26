import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('cover_setup', ROOT / 'scripts' / 'configure_cover.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class CoverSetupTests(unittest.TestCase):
    def test_live_schema_selects_real_preset_and_preserves_other_services(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); target = root / 'config.json'
            cfg = {'llm': {'apiKey': 'unchanged'}, 'tts': {'provider': 'minimax'}, 'voice': {'rvcModel': 'CUSTOM'}}
            target.write_text(json.dumps(cfg))
            response = {'latest_version': {'id': 'fixed-version', 'openapi_schema': {'components': {'schemas': {'Input': {'properties': {'song_input': {}, 'rvc_model': {'enum': ['CUSTOM', 'AvailableVoice'], 'default': 'CUSTOM'}}}}}}}}
            capture = io.StringIO()
            with patch.dict(os.environ, {'QQBOT_CONFIG': str(target)}), patch.object(setup.Path, 'home', return_value=root), patch.object(setup.getpass, 'getpass', return_value='fake-token'), patch('builtins.input', return_value=''), patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as request, contextlib.redirect_stdout(capture):
                setup.main()
            updated = json.loads(target.read_text())
            self.assertEqual(updated['llm'], cfg['llm'])
            self.assertEqual(updated['tts'], cfg['tts'])
            self.assertEqual(updated['voice']['rvcModel'], 'AvailableVoice')
            self.assertEqual(updated['voice']['version'], 'fixed-version')
            self.assertTrue(updated['voice']['enabled'])
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('fake-token', capture.getvalue())
            self.assertEqual(request.call_count, 1)

    def test_incompatible_model_does_not_enable_or_overwrite_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'config.json'; target.write_text('{"voice":{"enabled":false}}')
            original = target.read_bytes()
            with patch.dict(os.environ, {'QQBOT_CONFIG': str(target)}), patch.object(setup.getpass, 'getpass', return_value='fake-token'), patch('builtins.input', return_value=''), patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"latest_version":{"id":"x"}}')), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, '不兼容'): setup.main()
            self.assertEqual(target.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
