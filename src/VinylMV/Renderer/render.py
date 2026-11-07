"""拾音离线渲染器。仅依赖 Python 标准库和外部 FFmpeg。"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
import sys
import tempfile
import unicodedata
import zlib
from spectrum import write_spectrum_events
from lyric_layout import FontMeasure, fit_lyric, wrap_lyric
from composition import get_cards, ass_color, format_time, auto_palette
from encoding_settings import validate_encoding, encoding_arguments, check_encoder


STAMP = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")
OFFSET = re.compile(r"\[offset:([+-]?\d+)\]", re.I)


def parse_lrc(text: str, offset: float = 0.0) -> list[tuple[float, str]]:
    header_offset = OFFSET.search(text)
    offset += int(header_offset.group(1)) / 1000.0 if header_offset else 0
    grouped: dict[float, list[str]] = {}
    for raw in text.splitlines():
        stamps = list(STAMP.finditer(raw))
        if not stamps:
            continue
        words = STAMP.sub("", raw).strip()
        # Empty timed lines intentionally clear the active lyric during instrumental gaps.
        for stamp in stamps:
            if int(stamp.group(2)) >= 60:
                continue
            fraction = stamp.group(3) or "0"
            seconds = int(stamp.group(1)) * 60 + int(stamp.group(2)) + int(fraction) / (10 ** len(fraction))
            seconds = round(max(0.0, seconds + offset), 3)
            bucket = grouped.setdefault(seconds, [])
            if words not in bucket:
                bucket.append(words)
    return [(time, "\n".join(words)) for time, words in sorted(grouped.items())]


def ass_time(seconds: float) -> str:
    ticks = max(0, round(seconds * 100))
    return f"{ticks // 360000}:{ticks // 6000 % 60:02d}:{ticks // 100 % 60:02d}.{ticks % 100:02d}"


def clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def safe_ass(text: str) -> str:
    # Untrusted lyrics must never be interpreted as ASS drawing/override commands.
    return text.replace("\\", "＼").replace("{", "｛").replace("}", "｝").replace("\r", "").replace("\n", "\\N")


def make_ass(config: dict, lines: list[tuple[float, str]], palettes=None) -> str:
    width, height = config["width"], config["height"]
    duration = float(config["duration"])
    scale = height / 1080
    cards = get_cards(config)
    lyric, caption, timer, progress = [cards[key] for key in ('lyrics', 'caption', 'clock', 'progress')]
    font = lyric['fontSize'] * scale
    spacing = max(font * lyric['lineSpacing'], height * lyric['height'] * .156)
    clip = (round(width * lyric['x']), round(height * lyric['y']), round(width * (lyric['x'] + lyric['width'])), round(height * (lyric['y'] + lyric['height'])))
    center_x = round(width * (lyric['x'] + lyric['width'] * {'left': 0, 'center': .5, 'right': 1}[lyric['align']]))
    center_y = round(height * (lyric['y'] + lyric['height'] * .4661016949))
    with FontMeasure() as metrics:
        layouts = [fit_lyric(words, font, clip[2] - clip[0], spacing * .94, metrics.measure) for _, words in lines]
    events: list[str] = []
    palettes = palettes or []
    palette_times = [time for time, _ in palettes]
    def palette_at(time):
        return palettes[max(0, bisect.bisect_right(palette_times, time + .0001) - 1)][1] if palettes else lyric
    def outline_at(time):
        return f"\\3c{ass_color(palette_at(time)['outline'])}\\3a&H30&\\bord{max(.5, 1.2 * scale):.3f}" if palettes else ''

    def add(start: float, end: float, text: str, style: str = "歌词", layer: int = 1):
        if end > start:
            events.append(f"Dialogue: {layer},{ass_time(start)},{ass_time(end)},{style},,0,0,0,,{text}")

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: 歌词,Microsoft YaHei,{font},&H00F0F4E9,&H00FFFFFF,&H80000000,&H00000000,0,0,0,0,100,100,0,0,1,0.5,0,5,0,0,0,1
Style: 标题,Microsoft YaHei,{38 * scale},&H00EDF2E7,&H00FFFFFF,&H80000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: 小字,Microsoft YaHei,{22 * scale},&H00B4B8AF,&H00FFFFFF,&H80000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    if caption['enabled']:
        with FontMeasure() as metrics:
            for text, fraction, size, color, style in [
                (caption['title'] or str(config.get('title') or '未命名歌曲'), .25, caption['fontSize'], caption['color'], '标题'),
                (caption['artist'] or str(config.get('artist') or '未知歌手'), .78, caption['fontSize'] * 22 / 38, caption['artistColor'], '小字')]:
                text = text.replace('\n', ' ')
                size *= scale
                while size > .5 and metrics.measure(text, size) > width * caption['width'] * .97:
                    size *= .95
                x, y = round(width * (caption['x'] + caption['width'] / 2)), round(height * (caption['y'] + caption['height'] * fraction))
                add(0, duration, f"{{\\pos({x},{y})\\fs{size:.3f}\\c{ass_color(color)}}}{safe_ass(text)}", style)

    if not lyric['enabled']:
        pass
    elif not lines:
        empty_text = config.get('emptyLyricsText')
        if empty_text is None:
            empty_text = '纯音乐 · 此刻只听旋律'
        if empty_text.strip():
            with FontMeasure() as metrics:
                wrapped, line_font = fit_lyric(empty_text, font, clip[2] - clip[0], min(spacing * 2.8, height * lyric['height'] * .85), metrics.measure)
            alignment = {'left': 4, 'center': 5, 'right': 6}[lyric['align']]
            boundaries = sorted({0., duration} | {t for t in palette_times if 0 < t < duration})
            for start, end in zip(boundaries, boundaries[1:]):
                override = f"{{\\pos({center_x},{center_y})\\an{alignment}\\clip({','.join(map(str, clip))})\\fs{line_font:.3f}\\b{int(lyric['bold'])}\\c{ass_color(palette_at(start)['color'])}{outline_at(start)}}}"
                add(start, end, override + safe_ass(wrapped), '歌词')
    else:
        times = [line[0] for line in lines]
        boundaries = sorted(set([0.0, duration] + [t for t in times + palette_times if 0 < t < duration]))
        for start, end in zip(boundaries, boundaries[1:]):
            active = bisect.bisect_right(times, start + .0001) - 1
            target = max(0, active)
            lyric_start = times[active] if active >= 0 else 0
            lyric_end = times[active + 1] if active + 1 < len(times) else duration
            transition = min(.32, lyric_end - lyric_start) if active >= 0 and lyric_start > 0 else 0
            elapsed = start - lyric_start
            for index in range(max(0, target - 4), min(len(lines), target + 5)):
                words = lines[index][1]
                if not words:
                    continue
                y = round(center_y + (index - target) * spacing)
                previous_y = y + round(spacing * max(0, 1 - elapsed / transition)) if transition else y
                destination_y = y + round(spacing * max(0, 1 - (end - lyric_start) / transition)) if transition else y
                distance = abs(index - target)
                palette = palette_at(start)
                color = ass_color(palette['color'] if index == active else (palette['nearColor'] if distance <= 1 else palette['dimColor']))
                bold = 1 if index == active and lyric['bold'] else 0
                move_ms = round(min(end - start, max(0, transition - elapsed)) * 1000)
                position = f"\\move({center_x},{previous_y},{center_x},{destination_y},0,{move_ms})" if move_ms > 0 else f"\\pos({center_x},{y})"
                wrapped, line_font = layouts[index]
                alignment = {'left': 4, 'center': 5, 'right': 6}[lyric['align']]
                override = f"{{{position}\\an{alignment}\\clip({','.join(map(str, clip))})\\fs{line_font:.3f}\\c{color}\\b{bold}{outline_at(start)}}}"
                add(start, end, override + safe_ass(wrapped))

    if timer['enabled']:
        if timer['style'] == 'pill':
            shape = rounded_rectangle(width * timer['width'], height * timer['height'], 12 * scale)
            add(0, duration, f"{{\\an7\\pos({width * timer['x']:.3f},{height * timer['y']:.3f})\\bord0\\c{ass_color(timer['backgroundColor'])}\\alpha&H40&\\p1}}{shape}", '小字')
        alignment = {'left': 4, 'center': 5, 'right': 6}[timer['align']]
        x = width * (timer['x'] + timer['width'] * {'left': 0, 'center': .5, 'right': 1}[timer['align']])
        x += (1 if timer['align'] == 'left' else -1 if timer['align'] == 'right' else 0) * width * .0035
        boundaries = sorted({0., duration} | ({duration - second for second in range(1, math.ceil(duration))} if timer['format'] == 'remaining-total' else set(range(1, math.ceil(duration)))))
        for start, end in zip(boundaries, boundaries[1:]):
            text = format_time(start + .00001, duration, timer['format'])
            add(start, end, f"{{\\an{alignment}\\pos({x:.3f},{height * (timer['y'] + timer['height'] / 2):.3f})\\fs{timer['fontSize'] * scale:.3f}\\c{ass_color(timer['color'])}\\clip({width * timer['x']:.3f},{height * timer['y']:.3f},{width * (timer['x'] + timer['width']):.3f},{height * (timer['y'] + timer['height']):.3f})}}{safe_ass(text)}", '小字')
    if progress['enabled']:
        left, right = round(width * progress['x']), round(width * (progress['x'] + progress['width']))
        bar_height = max(.5, progress['thickness'] * scale)
        top = round(height * (progress['y'] + progress['height'] / 2)) - bar_height / 2
        bar_width = right - left
        shape = rounded_rectangle(bar_width, bar_height, bar_height / 2)
        add(0, duration, f"{{\\an7\\pos({left},{top:.3f})\\bord0\\c{ass_color(progress['trackColor'])}\\p1}}{shape}", layer=2)
        add(0, duration, f"{{\\an7\\clip({left},{top:.3f},{right},{top + bar_height:.3f})\\move({left - bar_width},{top:.3f},{left},{top:.3f},0,{round(duration * 1000)})\\bord0\\c{ass_color(progress['color'])}\\p1}}{shape}", layer=3)
    return header + "\n".join(events) + "\n"


def rounded_rectangle(width, height, radius):
    r = max(0, min(radius, width / 2, height / 2))
    k = .55228475 * r
    return (f'm {r:.3f} 0 l {width-r:.3f} 0 b {width-r+k:.3f} 0 {width:.3f} {r-k:.3f} {width:.3f} {r:.3f} '
            f'l {width:.3f} {height-r:.3f} b {width:.3f} {height-r+k:.3f} {width-r+k:.3f} {height:.3f} {width-r:.3f} {height:.3f} '
            f'l {r:.3f} {height:.3f} b {r-k:.3f} {height:.3f} 0 {height-r+k:.3f} 0 {height-r:.3f} '
            f'l 0 {r:.3f} b 0 {r-k:.3f} {r-k:.3f} 0 {r:.3f} 0')


def write_png(path: Path, width: int, height: int, pixels: bytes):
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    rows = b"".join(b"\0" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))


def create_record(path: Path, size: int, mask: bool = False, label_ratio: float = .43):
    pixels = bytearray(size * size * 4)
    center = (size - 1) / 2
    radius = size / 2 - 1
    for y in range(size):
        for x in range(size):
            dx, dy = x - center, y - center
            r = math.hypot(dx, dy) / radius
            if mask:
                alpha = max(0, min(255, round((1 - r) * radius * 255)))
                color = (alpha, alpha, alpha, 255)
            elif r > 1:
                color = (0, 0, 0, 0)
            elif r < .018:
                color = (9, 12, 10, 255)
            elif r < .07:
                color = (186, 195, 167, 255)
            elif r < label_ratio:
                shade = int(18 * (1 - r) + 10 * math.sin(math.atan2(dy, dx) + r * 12))
                color = (76 + shade, 99 + shade, 78 + shade, 255)
            else:
                angle = math.atan2(dy, dx)
                shine = max(0, math.cos(2 * angle - .9)) ** 12 * 27
                groove = 5 * math.cos(r * size * 1.45)
                value = int(max(5, min(65, 17 + shine + groove)))
                if r > .985:
                    value += 20
                color = (value, value + 2, value + 1, 255)
            pos = (y * size + x) * 4
            pixels[pos:pos + 4] = bytes(color)
    write_png(path, size, size, bytes(pixels))


def emit(event: str, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def run_checked(args: list[str], cwd: Path):
    result = subprocess.run(args, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError("FFmpeg 处理失败：" + result.stderr[-2500:])


def analyze_background_colors(ffmpeg, background, config, job):
    lyric = get_cards(config)['lyrics']
    if not lyric['enabled'] or not lyric['autoColor']:
        return []
    if not background:
        return [(0., auto_palette(bytes([25, 37, 31, 255]), config['brightness']))]
    # Decode only two small frames per second, covering the crop underneath the lyrics.
    x, y = min(95, round(lyric['x'] * 96)), min(53, round(lyric['y'] * 54))
    width, height = max(1, min(96 - x, round(lyric['width'] * 96))), max(1, min(54 - y, round(lyric['height'] * 54)))
    graph = f'fps=2:start_time=0:round=up,scale=96:54:force_original_aspect_ratio=increase,crop=96:54,crop={width}:{height}:{x}:{y},scale=48:27,format=rgba'
    args = [ffmpeg, '-v', 'error', '-nostdin', '-stream_loop', '-1', '-i', str(background), '-t', str(config['duration']), '-vf', graph, '-an', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1']
    palettes, frame_size, frame = [], 48 * 27 * 4, 0
    with (Path(job) / 'background-colors.log').open('w', encoding='utf-8') as errors:
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            while True:
                raw = child.stdout.read(frame_size)
                if not raw:
                    break
                if len(raw) != frame_size:
                    raise RuntimeError('背景配色分析数据不完整')
                palette = auto_palette(raw, config['brightness'])
                if not palettes or palette != palettes[-1][1]:
                    palettes.append((frame / 2, palette))
                frame += 1
                if frame % 20 == 0:
                    emit('analysisProgress', phase='background', percent=min(100, frame / 2 / config['duration'] * 100))
            if child.wait() or not palettes:
                raise RuntimeError('无法分析背景颜色，详见背景配色诊断日志')
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdout.close()
    (Path(job) / 'lyric-colors.json').write_text(json.dumps(palettes, ensure_ascii=False), encoding='utf-8')
    return palettes


def render(config: dict, ffmpeg: str, job: Path):
    container = config.get('container', 'mp4')
    encoding = validate_encoding(config.get('encoding'), container)
    if container not in ('mp4', 'mkv', 'mov', 'webm'):
        raise ValueError('不支持的导出文件格式')
    check_encoder(ffmpeg, encoding, container)
    width, height = int(config["width"]), int(config["height"])
    if (width, height) not in [(1920, 1080), (1280, 720), (854, 480)]:
        raise ValueError("不支持的输出分辨率")
    duration = float(config["duration"])
    volume, brightness = float(config["volume"]), float(config["brightness"])
    if not 0 < duration <= 43200 or not 0 <= volume <= 1000 or not 0 <= brightness <= 100:
        raise ValueError("输出参数超出范围")
    if not 8 <= float(config["fontSize"]) <= 200 or int(config["fps"]) not in (24, 30, 60):
        raise ValueError("字幕大小或帧率超出范围")
    audio = Path(config["audioPath"]).resolve(strict=True)
    output = Path(config["outputPath"]).resolve()
    background = Path(config["backgroundPath"]).resolve(strict=True) if config.get("backgroundPath") else None
    cover = Path(config["coverPath"]).resolve(strict=True) if config.get("coverPath") and get_cards(config)['record']['enabled'] else None
    if output == audio or output == background or output == cover or output.exists():
        raise ValueError("输出路径已存在或与输入文件冲突")
    output.parent.mkdir(parents=True, exist_ok=True)
    lines = parse_lrc(str(config.get("lyrics", "")), float(config.get("offset", 0)))
    cards = get_cards(config)
    if cards['lyrics']['enabled'] and cards['lyrics']['autoColor']:
        emit('status', message='正在分析歌词区域的背景颜色')
    palettes = analyze_background_colors(ffmpeg, background, config, job)
    with (job / "lyrics.ass").open("w", encoding="utf-8-sig") as subtitles:
        subtitles.write(make_ass(config, lines, palettes))
        if config.get("showSpectrum", True) and cards['spectrum']['enabled']:
            emit("status", message="正在分析音乐，生成音频可视化")
            write_spectrum_events(subtitles, ffmpeg, audio, config, job,
                                  lambda percent: emit("analysisProgress", percent=percent))
    record = cards['record']
    size = max(8, round(min(width * record['width'], height * record['height'])) // 2 * 2)
    create_record(job / "base.png", size, label_ratio=record['coverRatio'])
    if cover:
        cover_size = max(2, round(size * record['coverRatio']) // 2 * 2)
        create_record(job / "mask.png", cover_size, True)
        run_checked([ffmpeg, "-v", "error", "-y", "-i", "base.png", "-i", str(cover), "-i", "mask.png", "-filter_complex",
                     f"[1:v]scale={cover_size}:{cover_size}:force_original_aspect_ratio=increase,crop={cover_size}:{cover_size},format=rgba[c];[c][2:v]alphamerge[cc];[0:v][cc]overlay=(W-w)/2:(H-h)/2,format=rgba[out]",
                     "-map", "[out]", "-frames:v", "1", "-update", "1", "disc.png"], job)
    else:
        (job / "disc.png").write_bytes((job / "base.png").read_bytes())
    args = [ffmpeg, "-hide_banner", "-nostdin", "-n", "-filter_complex_threads", "2"]
    fps = int(config["fps"])
    if background:
        args += ["-stream_loop", "-1", "-i", str(background)]
    else:
        args += ["-f", "lavfi", "-i", f"color=c=0x19251f:s={width}x{height}:r={fps}"]
    args += ["-i", str(audio)]
    if record['enabled']:
        args += ["-loop", "1", "-framerate", str(fps), "-i", "disc.png"]
    # Work in a private ASCII-named job directory so no user path enters filter syntax.
    graph = (f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps={fps},"
             f"eq=brightness=0:contrast=1:saturation=.8,colorchannelmixer=rr={brightness / 100:.5f}:gg={brightness / 100:.5f}:bb={brightness / 100:.5f},"
             "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.24:t=fill[bg];")
    if record['enabled']:
        graph += (f"[2:v]format=rgba,rotate=angle='2*PI*t/{record['spinSeconds']:.4f}':ow=iw:oh=ih:c=none[record];"
                  f"[bg][record]overlay=x={round(width * (record['x'] + record['width'] / 2) - size / 2)}:y={round(height * (record['y'] + record['height'] / 2) - size / 2)}:shortest=1[top];")
    else:
        graph += '[bg]null[top];'
    graph += ("[top]ass=filename=lyrics.ass[outv];"
              f"[1:a]volume={volume / 100:.5f},alimiter=limit=0.97:level=disabled:latency=1[outa]")
    args += ["-filter_complex", graph, "-map", "[outv]", "-map", "[outa]", "-t", str(duration)]
    args += encoding_arguments(encoding, fps, container)
    args += ["-progress", "pipe:1", "-nostats", str(output)]
    emit("status", message="正在合成画面和音频")
    log = job / "ffmpeg.log"
    with log.open("w", encoding="utf-8") as errors:
        child = subprocess.Popen(args, cwd=str(job), stdout=subprocess.PIPE, stderr=errors, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            for raw in child.stdout:
                key, _, value = raw.strip().partition("=")
                if key == "out_time_us":
                    try:
                        seconds = int(value) / 1_000_000
                        emit("progress", seconds=seconds, percent=min(99.5, seconds / duration * 100))
                    except ValueError:
                        pass
                elif key == "speed":
                    emit("speed", value=value)
            code = child.wait()
            if code:
                raise RuntimeError("视频合成失败：" + log.read_text(encoding="utf-8", errors="replace")[-3000:])
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
    if not output.exists() or output.stat().st_size == 0:
        raise RuntimeError("没有生成有效的视频文件")
    emit("complete", path=str(output), percent=100)


def main():
    parser = argparse.ArgumentParser(description="拾音滚动歌词渲染器")
    parser.add_argument("--config", required=True)
    parser.add_argument("--ffmpeg", required=True)
    args = parser.parse_args()
    config_path = Path(args.config).resolve()
    try:
        render(json.loads(config_path.read_text(encoding="utf-8-sig")), args.ffmpeg, config_path.parent)
        return 0
    except Exception as error:
        emit("error", message=str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
