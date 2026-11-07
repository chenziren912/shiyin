"""Actual MV exports using synthetic audio/video, verified with ffprobe."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/VinylMV/Renderer'))
from composition import default_layout
from encoding_settings import probe_capabilities
import render
render.emit = lambda *args, **kwargs: None

folder = ROOT / '.test-output' / '扩展编码验证' / uuid.uuid4().hex[:8]
folder.mkdir(parents=True)
source = ROOT / '.test-output' / "中文路径 ' [测试]"
layout = default_layout()
for card in layout['cards']:
    card['enabled'] = False
caps = probe_capabilities(shutil.which('ffmpeg'))
cases = []
for codec, container in [('h264', 'mp4'), ('hevc', 'mp4'), ('av1', 'mp4'), ('vp9', 'webm'), ('vp8', 'webm')]:
    for mode in ('crf', 'vbr', 'cbr'):
        if codec == 'av1' and mode == 'cbr':
            continue
        cases.append((container, dict(codec=codec, rateControl=mode)))
cases += [('mov', dict(codec='prores', proresProfile=profile)) for profile in (0, 3, 4, 5)]
cases += [('mkv', dict(codec='ffv1', ffv1Level=level)) for level in (1, 3)]
cases += [('mp4', dict(codec='hevc', profile='main10')),
          ('webm', dict(codec='vp9', pixelFormat='yuv420p10le')),
          ('webm', dict(codec='av1', pixelFormat='yuv420p10le'))]
for audio, container in [('mp3', 'mp4'), ('alac', 'mp4'), ('flac', 'mkv'), ('pcm16', 'mov'), ('pcm24', 'mov'), ('opus', 'mkv'), ('vorbis', 'webm')]:
    cases.append((container, dict(codec='vp9' if container == 'webm' else 'h264', audioCodec=audio)))
for codec in ('h264', 'hevc', 'av1'):
    for backend in ('nvenc', 'qsv', 'amf'):
        if caps['encoders'][codec + '_' + backend]['available']:
            for mode in ('crf', 'vbr', 'cbr'):
                cases.append(('mp4', dict(codec=codec, encoder=backend, rateControl=mode)))
results = []
for index, (container, settings) in enumerate(cases):
    job = folder / str(index)
    job.mkdir()
    output = job / ('视频.' + container)
    options = dict(schemaVersion=2, crf=28, bitrateMbps=1, maxBitrateMbps=2, preset='ultrafast', threads=2, bFrames=0, audioBitrateKbps=128)
    options.update(settings)
    if '--defaults' in sys.argv:
        options = dict(schemaVersion=2, **settings)
    config = dict(audioPath=str(source / '测试音乐.mp3'), backgroundPath=str(source / '短背景.mp4'),
                  duration=.6, volume=100, brightness=45, fontSize=44, width=854, height=480, fps=24,
                  lyrics='', layout=layout, showSpectrum=False, container=container, outputPath=str(output), encoding=options)
    render.render(config, shutil.which('ffmpeg'), job)
    probe = json.loads(subprocess.check_output([shutil.which('ffprobe'), '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
    video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
    audio = next(s for s in probe['streams'] if s['codec_type'] == 'audio')
    assert video['codec_name'] == settings['codec'], video
    expected_audio = settings.get('audioCodec', 'opus' if container == 'webm' else 'aac')
    expected_audio = dict(pcm16='pcm_s16le', pcm24='pcm_s24le').get(expected_audio, expected_audio)
    assert audio['codec_name'] == expected_audio, audio
    assert abs(float(probe['format']['duration']) - .6) < .25
    if options.get('pixelFormat', '').endswith('10le') or options.get('profile') == 'main10':
        assert '10' in video['pix_fmt'], video
    results.append(dict(settings=settings, container=container, video=video['codec_name'], pixelFormat=video['pix_fmt'], audio=audio['codec_name'], output=str(output)))
(folder / 'result.json').write_text(json.dumps(dict(results=results, capabilities=caps), ensure_ascii=False, indent=2), encoding='utf-8')
print('扩展编码真实 MV 导出通过：' + str(len(results)) + ' 组，证据 ' + str(folder))
