"""Generate synthetic format fixtures and optionally render from the original files."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/VinylMV/Renderer'))
import render


def run(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8', errors='replace')
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return result.stdout


def fixtures():
    folder = ROOT / '.test-output' / '多格式素材' / uuid.uuid4().hex[:8]
    folder.mkdir(parents=True)
    source = ROOT / '.test-output' / "中文路径 ' [测试]"
    audio = source / '测试音乐.mp3'
    background = source / '短背景.mp4'
    cover = source / '封面.png'
    ffmpeg = shutil.which('ffmpeg')
    manifest = dict(audio=[], video=[])
    audio_cases = [
        ('wav', 'wav', 'pcm_s24le', False, False), ('flac', 'flac', 'flac', False, True),
        ('m4a', 'm4a', 'aac', False, False), ('alac', 'm4a', 'alac', True, True),
        ('aac', 'aac', 'aac', True, False), ('ogg', 'ogg', 'libvorbis', False, False),
        ('opus', 'opus', 'libopus', False, False), ('wma', 'wma', 'wmav2', True, False),
        ('aiff', 'aiff', 'pcm_s16be', True, False), ('wv', 'wv', 'wavpack', True, False),
        ('ac3', 'ac3', 'ac3', True, False), ('mka', 'mka', 'flac', True, False),
        ('mp2', 'mp2', 'mp2', True, False)]
    for name, ext, codec, converted, with_cover in audio_cases:
        target = folder / ('音乐-' + name + '.' + ext)
        args = [ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(audio)]
        if with_cover:
            args += ['-i', str(cover), '-map', '0:a:0', '-map', '1:v:0', '-c:v', 'png', '-disposition:v', 'attached_pic']
        else:
            args += ['-map', '0:a:0']
        args += ['-c:a', codec]
        if codec == 'wavpack':
            args += ['-af', 'asetnsamples=n=4096:p=1']
        if ext == 'aiff':
            args += ['-write_id3v2', '1']
        args += ['-metadata', 'title=湖畔来信', '-metadata', 'artist=拾音测试', str(target)]
        run(args)
        target.with_suffix('.lrc').write_text((source / '测试音乐.lrc').read_text(encoding='utf-8'), encoding='utf-8')
        manifest['audio'].append(dict(path=str(target), converted=converted, cover=with_cover,
                                      tagged=name not in ('aac', 'ac3', 'mp2')))
    video_cases = [('mkv', 'libx264'), ('mov', 'mpeg4'), ('avi', 'mpeg4'), ('wmv', 'wmv2'),
                   ('flv', 'flv'), ('ts', 'mpeg2video'), ('mpg', 'mpeg2video'), ('webm', 'libvpx-vp9'),
                   ('ogv', 'libtheora'), ('3gp', 'h263'), ('mp4', 'libx265')]
    for ext, codec in video_cases:
        target = folder / ('背景-' + ext + '.' + ext)
        args = [ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(background), '-an', '-vf', 'scale=320:180', '-c:v', codec, '-threads', '2']
        if ext == '3gp':
            args[args.index('scale=320:180')] = 'scale=176:144'
        if codec == 'libx265':
            args += ['-preset', 'ultrafast', '-x265-params', 'log-level=error:pools=2:frame-threads=1']
        run(args + [str(target)])
        manifest['video'].append(dict(path=str(target), converted=True))
    # Wrong-kind and malformed inputs must be rejected before they become a project source.
    invalid = folder / '损坏的音乐.flac'
    invalid.write_bytes(b'not an audio file')
    manifest['invalid'] = str(invalid)
    (folder / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(str(folder), flush=True)


def exports(folder):
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    results = []
    for audio, video in [('音乐-flac.flac', '背景-mkv.mkv'), ('音乐-wma.wma', '背景-wmv.wmv'),
                         ('音乐-alac.m4a', '背景-mp4.mp4'), ('音乐-opus.opus', '背景-ts.ts')]:
        job = folder / ('render-' + Path(audio).stem)
        job.mkdir()
        output = job / '原始素材导出.mp4'
        config = dict(audioPath=str(folder / audio), backgroundPath=str(folder / video),
                      title='多格式验证', artist='拾音测试', lyrics='[00:00]Words stay together\n[00:01]多格式音乐与视频',
                      duration=2, volume=100, brightness=45, fontSize=44, width=854, height=480, fps=24,
                      showSpectrum=True, encoding=dict(preset='ultrafast', threads=2), outputPath=str(output))
        render.render(config, ffmpeg, job)
        probe = json.loads(run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
        assert next(s for s in probe['streams'] if s['codec_type'] == 'video')['codec_name'] == 'h264'
        assert next(s for s in probe['streams'] if s['codec_type'] == 'audio')['codec_name'] == 'aac'
        assert abs(float(probe['format']['duration']) - 2) < .15
        results.append(dict(audio=audio, video=video, output=str(output)))
    (folder / 'export-result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print('四组原始多格式素材的曲线分析与实际导出通过。')


if __name__ == '__main__':
    exports(Path(sys.argv[2])) if len(sys.argv) > 2 and sys.argv[1] == '--render' else fixtures()
