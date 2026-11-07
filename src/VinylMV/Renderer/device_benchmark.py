"""Local short-clip measurements using exactly the application's encoder arguments."""
import argparse
from array import array
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile
import time
import sys
import wave

from composition import normalize_layout
from encoding_settings import validate_encoding, encoding_arguments, SOFTWARE, run_ffmpeg
from render import make_ass
from spectrum import write_spectrum_events


def candidates(settings):
    yield 'software'
    if settings.get('codec', 'h264') in ('h264', 'hevc', 'av1'):
        yield from ('nvenc', 'qsv', 'amf')


def prepare_sample(ffmpeg, profile, folder, emit, total):
    """Use the same PCM decoder, FFT, smoothing and ASS drawing as a real export."""
    folder = Path(folder)
    audio = folder / 'sample.wav'
    samples = array('h')
    sample_rate = 48000
    for index in range(sample_rate * 3):
        t = index / sample_rate
        envelope = .35 + .65 * max(0, math.sin(2 * math.pi * 1.7 * t))
        value = envelope * (.5 * math.sin(2 * math.pi * 110 * t) + .28 * math.sin(2 * math.pi * 880 * t) +
                            .18 * math.sin(2 * math.pi * (1000 * t + 650 * t * t)))
        samples.append(round(value * 30000))
    if sys.byteorder != 'little':
        samples.byteswap()
    with wave.open(str(audio), 'wb') as output:
        output.setparams((1, 2, sample_rate, 0, 'NONE', 'not compressed'))
        output.writeframes(samples.tobytes())
    layout = normalize_layout(profile.get('layout'))
    card = next(c for c in layout['cards'] if c['id'] == 'spectrum')
    enabled = profile.get('showSpectrum', True) and card['enabled']
    if not enabled:
        return audio, 0., 0
    # Only the spectrum and its linked progress baseline belong to this sample.
    for item in layout['cards']:
        if item['id'] not in ('spectrum', 'progress'):
            item['enabled'] = False
    config = dict(width=profile['width'], height=profile['height'], fps=profile['fps'], duration=3,
                  layout=layout, fontSize=44, emptyLyricsText='')
    started = time.perf_counter()
    emit(dict(event='progress', phase='spectrum', completed=0, total=total, message='正在解码音频并分析音频曲线'))
    with (folder / 'spectrum.ass').open('w', encoding='utf-8-sig') as output:
        output.write(make_ass(config, []))
        write_spectrum_events(output, ffmpeg, audio, config, folder,
            lambda percent: emit(dict(event='progress', phase='spectrum', completed=0, total=total,
                                      message=f'正在分析音频曲线 {percent:.0f}%')))
    return audio, time.perf_counter() - started, profile['fps'] * 3


def measure(ffmpeg, profile, emit, workspace=None):
    width, height, fps = profile['width'], profile['height'], profile['fps']
    if (width, height) not in ((854, 480), (1280, 720), (1920, 1080)) or fps not in (24, 30, 60):
        raise ValueError('测速分辨率或帧率无效')
    settings, container = profile.get('encoding') or {}, profile['container']
    backends = list(candidates(settings))
    listed = run_ffmpeg([ffmpeg, '-hide_banner', '-encoders'], timeout=25)
    if listed.returncode:
        raise ValueError('无法读取本机编码器')
    results = []
    with tempfile.TemporaryDirectory(prefix='vinyl-benchmark-', dir=workspace) as temporary:
        audio, analysis_seconds, spectrum_frames = prepare_sample(ffmpeg, profile, temporary, emit, len(backends))
        for index, backend in enumerate(backends):
            emit(dict(event='progress', completed=index, total=len(backends), encoder=backend, message='正在测试 ' + backend))
            value = dict(settings, encoder=backend)
            name = SOFTWARE.get(value.get('codec', 'h264'), '') if backend == 'software' else value.get('codec', 'h264') + '_' + backend
            result = dict(encoder=backend, name=name, available=False, fps=0, seconds=0, detail='',
                          analysisSeconds=round(analysis_seconds, 4), encodeSeconds=0, spectrumFrames=spectrum_frames)
            try:
                checked = validate_encoding(value, container)
                if not re.search(r'\b' + re.escape(name) + r'\s', listed.stdout):
                    raise ValueError('本机 FFmpeg 未包含此编码器')
                frames = fps * 3
                output = Path(temporary) / ('sample.' + container)
                args = [ffmpeg, '-v', 'error', '-nostdin', '-y', '-filter_threads', '2', '-filter_complex_threads', '2',
                        '-f', 'lavfi', '-i', f'testsrc2=size={width}x{height}:rate={fps}',
                        '-i', str(audio), '-map', '0:v:0', '-map', '1:a:0', '-frames:v', str(frames), '-t', '3']
                if spectrum_frames:
                    args += ['-vf', 'ass=filename=spectrum.ass']
                args += encoding_arguments(checked, fps, container) + [str(output)]
                started = time.perf_counter()
                attempt = run_ffmpeg(args, timeout=40, cwd=temporary)
                encode_seconds = time.perf_counter() - started
                seconds = analysis_seconds + encode_seconds
                if attempt.returncode or not output.exists() or output.stat().st_size == 0:
                    raise ValueError('此参数下编码失败，可能是设备、驱动或格式不支持')
                result.update(available=True, fps=round(frames / seconds, 3), seconds=round(seconds, 4),
                              encodeSeconds=round(encode_seconds, 4), frames=frames, settings=checked,
                              detail='三秒音频曲线分析、合成与编码通过' if spectrum_frames else '三秒短片编码通过（音频曲线关闭）')
            except subprocess.TimeoutExpired:
                result['detail'] = '此参数下测速超时，未加入自动分配'
            except ValueError as error:
                result['detail'] = str(error)
            results.append(result)
            emit(dict(event='progress', completed=index + 1, total=len(backends), result=result, message='已测试 ' + backend))
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    def emit(value):
        print(json.dumps(value, ensure_ascii=False), flush=True)
    try:
        profile = json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
        emit(dict(event='complete', results=measure(args.ffmpeg, profile, emit, Path(args.config).resolve().parent)))
        return 0
    except Exception as error:
        emit(dict(event='error', message=str(error)))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
