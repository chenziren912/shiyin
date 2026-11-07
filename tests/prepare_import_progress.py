"""Create isolated synthetic inputs, including duplicates and one bad file."""
import json
from pathlib import Path
import shutil
import subprocess
import uuid

root = Path(__file__).resolve().parents[1]
folder = root / '.test-output' / '导入进度素材' / uuid.uuid4().hex[:8]
folder.mkdir(parents=True)
source = folder / '合成源.wma'
subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=90', '-c:a', 'wmav2', '-b:a', '64k', str(source)], check=True)
for mode in ['complete', 'cancel']:
    directory = folder / mode
    directory.mkdir()
    audio = []
    for i in range(1, 30):
        target = directory / f'{i:02d} - 合成进度验证.wma'
        shutil.copyfile(source, target)
        audio.append(str(target))
    bad = directory / '30 - 损坏样例.wma'
    bad.write_bytes(b'not an audio file')
    audio.append(str(bad))
    # The actual number of files must stay 30 after case-insensitive deduplication.
    audio.extend([audio[0], audio[1]])
    videos = []
    for name in ['背景甲', '背景乙']:
        target = directory / (name + '.mp4')
        shutil.copyfile(root / '.test-output' / "中文路径 ' [测试]" / '短背景.mp4', target)
        videos.append(str(target))
    (directory / 'manifest.json').write_text(json.dumps(dict(audio=audio, videos=videos), ensure_ascii=False, indent=2), encoding='utf-8')
print(folder)
