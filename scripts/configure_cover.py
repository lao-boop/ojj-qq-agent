"""Verify Replicate model schema before enabling cover. Never generates paid audio."""
import getpass
import json
import os
from pathlib import Path
import time
import urllib.request
import urllib.error


def ask(label, default=''):
    return input(f'{label}' + (f' [{default}]' if default else '') + ': ').strip() or default


def main():
    root = Path(__file__).resolve().parent.parent
    target = Path(os.environ.get('QQBOT_CONFIG', root / 'config.json'))
    cfg = json.loads(target.read_text(encoding='utf-8'))
    voice = dict(cfg.get('voice', {}))
    print('翻唱使用 Replicate RVC 服务，保留源音频旋律并转换声线；MiniMax 朗读密钥不能用于此处。')
    token = getpass.getpass('Replicate API token（输入隐藏，回车保留已配置值）: ').strip() or voice.get('token', '')
    if not token or token.startswith('YOUR_'):
        raise ValueError('没有可用 Replicate token，配置未修改。')
    model = ask('Replicate 模型', voice.get('model') or 'zsxkib/realistic-voice-cloning')
    if len(model.split('/')) != 2 or any(not part or not all(c.isalnum() or c in '-_.' for c in part) for part in model.split('/')):
        raise ValueError('模型名称应为 owner/model。')
    req = urllib.request.Request(f'https://api.replicate.com/v1/models/{model}', headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.load(response)
    except urllib.error.HTTPError as err:
        raise ValueError(f'Replicate 配置核验 HTTP {err.code}；请检查账号、token 和模型访问权限，配置未修改。') from None
    version = data.get('latest_version') or {}
    props = version.get('openapi_schema', {}).get('components', {}).get('schemas', {}).get('Input', {}).get('properties', {})
    if not version.get('id') or not all(k in props for k in ('song_input', 'rvc_model')):
        raise ValueError('该模型接口与当前翻唱适配器不兼容，配置未修改。')
    choices = props['rvc_model'].get('enum') or []
    if choices: print('服务返回的可选音色：' + '、'.join(map(str, choices)))
    default = voice.get('rvcModel') if voice.get('rvcModel') in choices else props['rvc_model'].get('default', '')
    if default == 'CUSTOM' and not voice.get('customModelUrl'):
        default = next((name for name in choices if name != 'CUSTOM'), '')
    selected = ask('目标音色（CUSTOM 需要自己的 RVC 模型）', str(default or ''))
    if not selected or (choices and selected not in choices):
        raise ValueError('请选择服务支持的音色，配置未修改。')
    custom = ''
    if selected == 'CUSTOM':
        custom = ask('RVC 模型 HTTPS 下载地址', voice.get('customModelUrl', ''))
        if not custom.startswith('https://') or 'custom_rvc_model_download_url' not in props:
            raise ValueError('自定义音色缺少有效 HTTPS 下载地址或模型不支持，配置未修改。')
    voice.update(enabled=True, token=token, model=model, version=version['id'], rvcModel=selected, customModelUrl=custom, pitchChange='no-change', outputFormat='mp3', sendAsVoice=True)
    cfg['voice'] = voice
    cfg.setdefault('chat', {}).setdefault('agents', {})['enabled'] = True
    backup_dir = Path.home() / '.qq-agent-backups'
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    backup = backup_dir / f'config-before-cover-{time.time_ns()}.json'
    with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as out:
        out.write(target.read_text(encoding='utf-8'))
    temp = target.with_name(f'{target.name}.{os.getpid()}.tmp')
    with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as out:
        json.dump(cfg, out, ensure_ascii=False, indent=2)
        out.write('\n')
    os.replace(temp, target)
    print(f'翻唱配置已保存，原配置备份：{backup}')
    print('已核验模型接口并固定版本；没有发起翻唱。实际调用需要账号有可用额度，重启机器人后测试。')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, urllib.error.URLError) as exc:
        raise SystemExit(str(exc)) from None
