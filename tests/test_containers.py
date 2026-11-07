"""Real extra-container exports; synthetic media only."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/VinylMV/Renderer'))
from composition import default_layout
import render

folder = ROOT / '.test-output' / '导出容器验证' / uuid.uuid4().hex[:8]
folder.mkdir(parents=True)
source = ROOT / '.test-output' / "中文路径 ' [测试]"
layout = default_layout()
for card in layout['cards']:
    card['enabled'] = False
cases = [('webm', 'h264', mode) for mode in ('crf','vbr','cbr')] + [('mkv','hevc','crf'), ('mov','hevc','crf')]
results = []
for container, codec, mode in cases:
    job = folder / (container + '-' + mode)
    job.mkdir()
    output = job / ('视频.' + container)
    config = dict(audioPath=str(source / '测试音乐.mp3'), backgroundPath=str(source / '短背景.mp4'),
                  duration=1, volume=100, brightness=45, fontSize=44, width=854, height=480, fps=24,
                  lyrics='', layout=layout, showSpectrum=False, container=container, outputPath=str(output),
                  encoding=dict(codec=codec, rateControl=mode, crf=28, bitrateMbps=1, maxBitrateMbps=2, preset='ultrafast', threads=2))
    render.render(config, shutil.which('ffmpeg'), job)
    probe = json.loads(subprocess.check_output([shutil.which('ffprobe'), '-v','error','-show_streams','-show_format','-of','json',str(output)]))
    video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
    audio = next(s for s in probe['streams'] if s['codec_type'] == 'audio')
    assert video['codec_name'] == ('vp9' if container == 'webm' else 'hevc')
    assert audio['codec_name'] == ('opus' if container == 'webm' else 'aac')
    assert abs(float(probe['format']['duration']) - 1) < .2
    results.append(dict(container=container, mode=mode, output=str(output)))
(folder / 'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print('WebM 三种码率模式、H.265 的 MKV/MOV 实际导出通过：' + str(folder))
