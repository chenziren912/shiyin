import json
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / '.test-output' / "中文路径 ' [测试]"
folder = ROOT / '.test-output' / '批量素材' / uuid.uuid4().hex[:8]
folder.mkdir(parents=True)
music = []
for index, genre in enumerate(['Rock', 'Pop', 'Jazz', ''], 1):
    path = folder / ('音乐 ' + str(index) + '.mp3')
    result = subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-y', '-i', str(source / '测试音乐.mp3'), '-t', '2',
                             '-c:a', 'libmp3lame', '-metadata', 'title=批量音乐 ' + str(index), '-metadata', 'artist=拾音测试',
                             '-metadata', 'genre=' + genre, str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', 'replace'))
    if index != 4:
        path.with_suffix('.lrc').write_text('[00:00]A batch of songs\n[00:01]每首歌找到自己的风景', encoding='utf-8')
    music.append(str(path))
videos = []
for name in ['山海', '夜色']:
    path = folder / (name + '.mp4')
    shutil.copyfile(source / '短背景.mp4', path)
    videos.append(str(path))
(folder / 'manifest.json').write_text(json.dumps(dict(audio=music, videos=videos), ensure_ascii=False, indent=2), encoding='utf-8')
print(str(folder))
