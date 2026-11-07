"""Validated codec-specific encoding and local capability discovery."""
import concurrent.futures
import json
import math
import re
import subprocess
import sys

DEFAULTS = dict(schemaVersion=2, codec='h264', encoder='software', rateControl='crf', crf=20,
                bitrateMbps=8, maxBitrateMbps=0, bufferSeconds=2, preset='veryfast', profile='auto',
                pixelFormat='auto', tune='auto', keyframeSeconds=0, bFrames=3, threads=0,
                audioCodec='auto', audioBitrateKbps=256, sampleRate=0, channels=0, fastStart=True,
                proresProfile=3, ffv1Level=3, lookahead=0, spatialAq=False, multipass='disabled', vorbisQuality=5)
PRESETS = ('ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow')
SOFTWARE = dict(h264='libx264', hevc='libx265', av1='libsvtav1', vp9='libvpx-vp9', vp8='libvpx', prores='prores_ks', ffv1='ffv1')
VIDEO_CONTAINERS = dict(h264=('mp4', 'mkv', 'mov'), hevc=('mp4', 'mkv', 'mov'), av1=('mp4', 'mkv', 'webm'),
                        vp9=('mp4', 'mkv', 'webm'), vp8=('mkv', 'webm'), prores=('mov', 'mkv'), ffv1=('mkv',))
AUDIO_CONTAINERS = dict(mp4=('aac', 'mp3', 'alac'), mov=('aac', 'mp3', 'alac', 'pcm16', 'pcm24'),
                        mkv=('aac', 'opus', 'mp3', 'flac', 'pcm16', 'pcm24', 'vorbis'), webm=('opus', 'vorbis'))
AUDIO = dict(aac='aac', opus='libopus', mp3='libmp3lame', flac='flac', alac='alac', pcm16='pcm_s16le', pcm24='pcm_s24le', vorbis='libvorbis')


def pixel_formats(s):
    if s['codec'] == 'prores':
        return ('yuv444p10le',) if s['proresProfile'] >= 4 else ('yuv422p10le',)
    if s['codec'] == 'ffv1':
        return ('yuv420p',) if s['ffv1Level'] == 1 else ('yuv420p', 'yuv422p10le', 'yuv444p10le')
    return ('yuv420p', 'yuv420p10le') if s['codec'] in ('hevc', 'av1', 'vp9') else ('yuv420p',)


def validate_encoding(value=None, container=None):
    if value is not None and not isinstance(value, dict):
        raise ValueError('编码设置格式无效')
    s = dict(DEFAULTS)
    if value:
        s.update({key: val for key, val in value.items() if key in s})
    # Older batch preferences used H.264/H.265 as the WebM quality template.
    if container == 'webm' and (not value or 'schemaVersion' not in value) and s['codec'] in ('h264', 'hevc'):
        s.update(codec='vp9', encoder='software', profile='auto', audioCodec='auto')
    choices = dict(schemaVersion=(2,), codec=tuple(SOFTWARE), encoder=('software', 'nvenc', 'qsv', 'amf'),
                   rateControl=('crf', 'vbr', 'cbr'), preset=PRESETS, profile=('auto', 'baseline', 'main', 'high', 'main10'),
                   pixelFormat=('auto', 'yuv420p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le'),
                   tune=('auto', 'film', 'animation', 'grain', 'stillimage', 'zerolatency'), audioCodec=('auto',) + tuple(AUDIO),
                   sampleRate=(0, 22050, 32000, 44100, 48000, 88200, 96000), channels=(0, 1, 2),
                   proresProfile=(0, 1, 2, 3, 4, 5), ffv1Level=(1, 3), multipass=('disabled', 'qres', 'fullres'))
    for key, allowed in choices.items():
        if isinstance(s[key], bool) or s[key] not in allowed:
            raise ValueError('编码选项无效：' + key)
    for key, low, high, name in [('crf', 0, 63 if s['codec'] in ('av1', 'vp9', 'vp8') and s['encoder'] == 'software' else 51, '画质值'),
                                ('bitrateMbps', .1, 200, '目标码率'), ('maxBitrateMbps', 0, 300, '峰值码率'),
                                ('bufferSeconds', .1, 30, '缓冲时长'), ('keyframeSeconds', 0, 30, '关键帧间隔'),
                                ('bFrames', 0, 8, '双向预测帧'), ('threads', 0, 64, '编码线程数'),
                                ('audioBitrateKbps', 32, 512, '音频码率'), ('lookahead', 0, 32, '前瞻帧数'), ('vorbisQuality', 0, 10, 'Vorbis 音频质量')]:
        number = s[key]
        if isinstance(number, bool) or not isinstance(number, (float, int)) or not math.isfinite(number) or not low <= number <= high:
            raise ValueError(name + '超出有效范围')
    if any(s[key] != int(s[key]) for key in ('bFrames', 'threads', 'audioBitrateKbps', 'lookahead')):
        raise ValueError('帧数、线程数和音频码率必须为整数')
    if not isinstance(s['fastStart'], bool) or not isinstance(s['spatialAq'], bool):
        raise ValueError('开关选项无效')
    if s['encoder'] != 'software' and s['codec'] not in ('h264', 'hevc', 'av1'):
        raise ValueError('所选视频编码不支持此硬件编码器')
    if s['encoder'] == 'software' and s['codec'] == 'av1' and s['rateControl'] == 'cbr':
        raise ValueError('AV1 软件编码请使用恒定画质或动态平均码率')
    profiles = ('auto', 'baseline', 'main', 'high') if s['codec'] == 'h264' else ('auto', 'main', 'main10') if s['codec'] == 'hevc' else ('auto',)
    if s['profile'] not in profiles:
        raise ValueError('所选视频编码不支持此编码规格')
    if s['pixelFormat'] != 'auto' and s['pixelFormat'] not in pixel_formats(s):
        raise ValueError('所选视频编码或规格不支持此像素格式')
    if s['codec'] == 'hevc' and s['profile'] == 'main' and s['pixelFormat'] == 'yuv420p10le':
        raise ValueError('10 位 H.265 请使用自动或主要 10 位规格')
    tunes = ('auto', 'film', 'animation', 'grain', 'stillimage', 'zerolatency') if s['codec'] == 'h264' else ('auto', 'animation', 'grain', 'zerolatency') if s['codec'] == 'hevc' else ('auto',)
    if s['tune'] not in (tunes if s['encoder'] == 'software' else ('auto',)):
        raise ValueError('所选编码器不支持此调优方式')
    if s['codec'] not in ('prores', 'ffv1') and not (s['codec'] == 'av1' and s['encoder'] == 'software') and s['rateControl'] == 'vbr' and s['maxBitrateMbps'] and s['maxBitrateMbps'] < s['bitrateMbps']:
        raise ValueError('峰值码率不能小于目标码率')
    if s['codec'] == 'h264' and s['profile'] == 'baseline':
        s['bFrames'] = 0
    if container is not None:
        if container not in AUDIO_CONTAINERS:
            raise ValueError('不支持的导出文件格式')
        if container not in VIDEO_CONTAINERS[s['codec']]:
            raise ValueError('视频编码与文件格式不兼容，请在编码设置中重新选择')
        audio = audio_codec(s, container)
        if audio not in AUDIO_CONTAINERS[container]:
            raise ValueError('音频编码与文件格式不兼容，请在编码设置中重新选择')
        if audio == 'mp3' and (s['audioBitrateKbps'] > 320 or s['sampleRate'] > 48000):
            raise ValueError('MP3 最高支持 320 kbps 和 48 kHz')
        if audio == 'opus' and s['channels'] == 1 and s['audioBitrateKbps'] > 256:
            raise ValueError('单声道 Opus 码率不能超过 256 kbps')
    return s


def audio_codec(s, container):
    return ('opus' if container == 'webm' else 'aac') if s['audioCodec'] == 'auto' else s['audioCodec']


def encoder_name(s):
    return SOFTWARE[s['codec']] if s['encoder'] == 'software' else s['codec'] + '_' + s['encoder']


def check_encoder(ffmpeg, settings, container='mp4'):
    s = validate_encoding(settings, container)
    result = run_ffmpeg([ffmpeg, '-hide_banner', '-encoders'], timeout=15)
    for name in (encoder_name(s), AUDIO[audio_codec(s, container)]):
        if result.returncode or not re.search(r'\b' + re.escape(name) + r'\s', result.stdout):
            raise ValueError('当前 FFmpeg 缺少编码器 ' + name + '，请更换编码设置或更新 FFmpeg。')


def run_ffmpeg(args, timeout=8, cwd=None):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8', errors='replace',
                          timeout=timeout, cwd=cwd, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def probe_capabilities(ffmpeg):
    result = run_ffmpeg([ffmpeg, '-hide_banner', '-encoders'], timeout=15)
    if result.returncode:
        raise ValueError('无法读取 FFmpeg 编码器列表')
    listed = set(re.findall(r'^\s*[VAS][A-Z.]{5}\s+(\S+)\s', result.stdout, re.M))
    hardware = [codec + '_' + backend for codec in ('h264', 'hevc', 'av1') for backend in ('nvenc', 'qsv', 'amf')]
    def probe(name):
        if name not in listed:
            return name, dict(available=False, detail='此 FFmpeg 未包含该编码器')
        try:
            test = run_ffmpeg([ffmpeg, '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=s=320x180:r=25',
                               '-frames:v', '2', '-an', '-c:v', name, '-f', 'null', '-'], timeout=8)
            return name, dict(available=test.returncode == 0, detail='短帧编码验证通过' if test.returncode == 0 else '显卡、驱动或编码功能不可用')
        except subprocess.TimeoutExpired:
            return name, dict(available=False, detail='硬件验证超时，可更新驱动后重新检测')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        verified = dict(pool.map(probe, hardware))
    for name in list(SOFTWARE.values()) + list(AUDIO.values()):
        verified[name] = dict(available=name in listed, detail='已包含在本机 FFmpeg' if name in listed else '此 FFmpeg 未包含该编码器')
    return dict(encoders=verified)


def encoding_arguments(settings, fps, container='mp4'):
    s = validate_encoding(settings, container)
    name, codec, backend = encoder_name(s), s['codec'], s['encoder']
    index = PRESETS.index(s['preset'])
    pixel = s['pixelFormat']
    if pixel == 'auto':
        pixel = 'yuv420p10le' if s['profile'] == 'main10' else pixel_formats(s)[0]
    if backend != 'software':
        pixel = 'p010le' if pixel == 'yuv420p10le' else 'nv12'
    args = ['-c:v', name, '-pix_fmt', pixel]
    quality = str(round(s['crf']))
    mode = s['rateControl']
    maximum = s['bitrateMbps'] if mode == 'cbr' else s['maxBitrateMbps']
    if codec == 'prores':
        args += ['-profile:v', str(s['proresProfile'])]
    elif codec == 'ffv1':
        args += ['-level', str(s['ffv1Level'])]
        if s['ffv1Level'] == 3:
            args += ['-slicecrc', '1']
    else:
        if backend == 'nvenc':
            args += ['-preset', 'p' + str((1, 1, 2, 3, 4, 4, 5, 6, 7)[index]), '-rc', 'cbr' if mode == 'cbr' else 'vbr',
                     '-multipass', s['multipass'], '-rc-lookahead', str(s['lookahead']), '-spatial-aq', '1' if s['spatialAq'] else '0']
            if mode == 'crf':
                args += ['-cq', quality, '-b:v', '0']
        elif backend == 'qsv':
            args += ['-preset', PRESETS[max(2, index)]]
            if mode == 'crf':
                args += ['-global_quality', quality]
        elif backend == 'amf':
            args += ['-quality', 'speed' if index < 4 else 'balanced' if index < 6 else 'quality', '-rc', 'cqp' if mode == 'crf' else 'cbr' if mode == 'cbr' else 'vbr_peak']
            if mode == 'crf':
                args += ['-qp_i', quality, '-qp_p', quality]
        elif codec in ('h264', 'hevc'):
            args += ['-preset', s['preset']]
            if s['tune'] != 'auto':
                args += ['-tune', s['tune']]
            if mode == 'crf':
                args += ['-crf', str(s['crf'])]
        elif codec == 'av1':
            args += ['-preset', str((12, 11, 10, 9, 8, 7, 6, 5, 4)[index])]
            if mode == 'crf':
                args += ['-crf', quality]
            if s['threads']:
                args += ['-svtav1-params', 'lp=' + str(int(s['threads']))]
        elif codec in ('vp9', 'vp8'):
            args += ['-deadline', 'good', '-cpu-used', str((8, 8, 7, 6, 5, 4, 3, 2, 1)[index])]
            if codec == 'vp9':
                args += ['-row-mt', '1']
            if mode == 'crf':
                args += ['-crf', quality, '-b:v', str(round(maximum * 1_000_000)) if codec == 'vp9' else str(round(s['bitrateMbps'] * 1_000_000))]
        if mode != 'crf':
            args += ['-b:v', str(round(s['bitrateMbps'] * 1_000_000))]
        if maximum and not (backend == 'qsv' and mode == 'crf' or codec == 'av1' and backend == 'software' and mode == 'vbr'):
            args += ['-maxrate', str(round(maximum * 1_000_000)), '-bufsize', str(round(maximum * s['bufferSeconds'] * 1_000_000))]
        if mode == 'cbr':
            args += ['-minrate', str(round(maximum * 1_000_000))]
        if s['profile'] != 'auto':
            profile = 'constrained_baseline' if backend == 'amf' and s['profile'] == 'baseline' else s['profile']
            args += ['-profile:v', profile]
        if s['keyframeSeconds']:
            args += ['-g', str(max(1, round(fps * s['keyframeSeconds'])))]
        if codec in ('h264', 'hevc') and backend != 'amf':
            args += ['-bf', str(int(s['bFrames']))]
        if codec == 'h264' and backend == 'software' and mode == 'cbr':
            args += ['-x264-params', 'nal-hrd=vbr:filler=1:force-cfr=1']
        if codec == 'hevc' and backend == 'software':
            extra = ['log-level=error']
            if mode == 'cbr':
                extra += ['strict-cbr=1']
            if s['threads']:
                extra += ['pools=' + str(int(s['threads'])), 'frame-threads=1']
            args += ['-x265-params', ':'.join(extra)]
    if s['threads'] and backend == 'software':
        args += ['-threads:v', str(int(s['threads']))]
    if codec == 'hevc' and container in ('mp4', 'mov'):
        args += ['-tag:v', 'hvc1']
    acodec = audio_codec(s, container)
    args += ['-c:a', AUDIO[acodec]]
    if acodec == 'vorbis':
        args += ['-q:a', str(s['vorbisQuality'])]
    elif acodec not in ('flac', 'alac', 'pcm16', 'pcm24'):
        args += ['-b:a', str(int(s['audioBitrateKbps'])) + 'k']
    if acodec == 'opus':
        args += ['-ar', '48000', '-ac', str(int(s['channels']) or 2)]
    else:
        if s['sampleRate']:
            args += ['-ar', str(int(s['sampleRate']))]
        if s['channels']:
            args += ['-ac', str(int(s['channels']))]
    if s['fastStart'] and container in ('mp4', 'mov'):
        args += ['-movflags', '+faststart']
    return args


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--probe':
    print(json.dumps(probe_capabilities(sys.argv[2]), ensure_ascii=False))
