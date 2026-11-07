"""Analyse real audio and draw a continuous cubic Bezier spectrum using stdlib only."""
from array import array
import math
from pathlib import Path
import subprocess
import sys
from composition import get_cards, ass_color


SAMPLE_RATE = 24000
FFT_SIZE = 1024
BAND_COUNT = 48
LOW_FREQUENCY = 40
HIGH_FREQUENCY = 10000
MIN_DB = -72
MAX_DB = -12


class SpectrumAnalyzer:
    def __init__(self, size=FFT_SIZE, sample_rate=SAMPLE_RATE):
        if size < 2 or size & (size - 1):
            raise ValueError("FFT 长度必须为 2 的幂")
        self.size = size
        self.sample_rate = sample_rate
        bits = size.bit_length() - 1
        self.reverse = [int(f"{i:0{bits}b}"[::-1], 2) for i in range(size)]
        # Same Blackman window used by Web Audio's AnalyserNode.
        self.window = [.42 - .5 * math.cos(2 * math.pi * i / size) + .08 * math.cos(4 * math.pi * i / size) for i in range(size)]
        self.stages = []
        step = 2
        while step <= size:
            self.stages.append((step, [complex(math.cos(-2 * math.pi * j / step), math.sin(-2 * math.pi * j / step)) for j in range(step // 2)]))
            step *= 2

    def decibels(self, samples):
        if len(samples) != self.size:
            raise ValueError("音频分析窗口长度不正确")
        values = [complex(samples[index] * self.window[index], 0) for index in self.reverse]
        for step, factors in self.stages:
            half = step // 2
            for start in range(0, self.size, step):
                for offset, factor in enumerate(factors):
                    even = values[start + offset]
                    odd = values[start + offset + half] * factor
                    values[start + offset] = even + odd
                    values[start + offset + half] = even - odd
        return [20 * math.log10(max(abs(value) / self.size, 1e-12)) for value in values[:self.size // 2]]


def frequency_bands(decibels, sample_rate=SAMPLE_RATE, fft_size=FFT_SIZE, options=None):
    options = options or {}
    count, minimum = options.get('bandCount', BAND_COUNT), options.get('minFrequency', LOW_FREQUENCY)
    maximum = min(options.get('maxFrequency', HIGH_FREQUENCY), sample_rate / 2)
    bands = []
    for index in range(count):
        low = minimum * (maximum / minimum) ** (index / count)
        high = minimum * (maximum / minimum) ** ((index + 1) / count)
        first = min(len(decibels) - 1, max(1, math.floor(low * fft_size / sample_rate)))
        last = min(len(decibels), max(first + 1, math.ceil(high * fft_size / sample_rate)))
        peak = max(decibels[first:last], default=-math.inf)
        bands.append(max(0, min(1, (peak - MIN_DB) / (MAX_DB - MIN_DB))) if math.isfinite(peak) else 0)
    return bands


def smooth_bands(bands, previous, seconds, options=None):
    options = options or {}
    values = list(bands)
    for _ in range(options.get('smoothing', 2)):
        previous_values = values
        values = []
        for index in range(len(previous_values)):
            def at(offset):
                return previous_values[max(0, min(len(previous_values) - 1, index + offset))]
            values.append((at(-2) + 4 * at(-1) + 6 * at(0) + 4 * at(1) + at(2)) / 16)
    elapsed = max(0, min(.25, seconds))
    for index, value in enumerate(values):
        alpha = 1 - math.exp(-elapsed / (options.get('attack', .06) if value > previous[index] else options.get('release', .18)))
        previous[index] += (value - previous[index]) * alpha
    return previous


def curve_points(values, width, height):
    baseline = height * .85
    points = []
    for index, value in enumerate(values):
        position = index / (len(values) - 1)
        taper = 0 if index in (0, len(values) - 1) else math.sin(math.pi * position) ** .4
        points.append((position * width, baseline - max(0, min(1, value)) * taper * height * .72))
    return points


def curve_segments(points):
    differences = [points[i + 1][1] - point[1] for i, point in enumerate(points[:-1])]
    slopes = [0]
    for before, after in zip(differences, differences[1:]):
        slopes.append(0 if before * after <= 0 else 2 * before * after / (before + after))
    slopes.append(0)
    segments = []
    for index, point in enumerate(points[1:]):
        previous = points[index]
        third = (point[0] - previous[0]) / 3
        segments.append((previous[0] + third, previous[1] + slopes[index] / 3, point[0] - third, point[1] - slopes[index + 1] / 3, point[0], point[1]))
    return segments


def ribbon_path(values, width, height, thickness, points=None):
    """A thin closed ribbon gives libass one line with genuinely curved edges."""
    points = points or curve_points(values, width, height)
    segments = curve_segments(points)
    half = thickness / 2
    # ASS p4 uses eight drawing units per video pixel, preserving subpixel width.
    def pair(x, y):
        return f"{round(x * 8)} {round(y * 8)}"
    commands = ["m " + pair(points[0][0], points[0][1] - half)]
    for x1, y1, x2, y2, x, y in segments:
        commands.append("b " + " ".join((pair(x1, y1 - half), pair(x2, y2 - half), pair(x, y - half))))
    commands.append("l " + pair(points[-1][0], points[-1][1] + half))
    for index in range(len(segments) - 1, -1, -1):
        x1, y1, x2, y2, _, _ = segments[index]
        commands.append("b " + " ".join((pair(x2, y2 + half), pair(x1, y1 + half), pair(points[index][0], points[index][1] + half))))
    return " ".join(commands)


def visualization_path(values, width, height, thickness, options):
    if options['visualization'] == 'bars':
        step, baseline = width / len(values), height * .85
        gap = step * options['barGap']
        drawings = []
        for index, value in enumerate(values):
            left, right = round((index * step + gap / 2) * 8), round(((index + 1) * step - gap / 2) * 8)
            top, bottom = round((baseline - max(0, min(1, value)) * height * .72) * 8), round(baseline * 8)
            drawings.append(f'm {left} {bottom} l {left} {top} {right} {top} {right} {bottom}')
        return ' '.join(drawings)
    if options['visualization'] == 'mirror':
        points = [(x, height / 2 - (height * .85 - y) * .5 / .72 * .88) for x, y in curve_points(values, width, height)]
        return ribbon_path(values, width, height, thickness, points) + ' ' + ribbon_path(values, width, height, thickness, [(x, height - y) for x, y in points])
    return ribbon_path(values, width, height, thickness)


def ass_time(seconds):
    ticks = max(0, round(seconds * 100))
    return f"{ticks // 360000}:{ticks // 6000 % 60:02d}:{ticks // 100 % 60:02d}.{ticks % 100:02d}"


def write_spectrum_events(output, ffmpeg, audio, config, job, progress=None):
    duration, fps = float(config["duration"]), int(config["fps"])
    width, height = int(config["width"]), int(config["height"])
    cards = get_cards(config)
    card, progress_card = cards['spectrum'], cards['progress']
    left, right = round(width * card['x']), round(width * (card['x'] + card['width']))
    curve_width, curve_height = right - left, height * card['height']
    top = (round(height * (progress_card['y'] + progress_card['height'] / 2)) - curve_height * (1 if card['visualization'] == 'mirror' else .85)) if card['linked'] else height * card['y']
    analyzer = SpectrumAnalyzer(card['fftSize'])
    history = [0.0] * card['fftSize']
    previous = [0.0] * card['bandCount']
    position = 0
    total_frames = math.ceil(duration * fps)
    args = [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-i", str(audio), "-map", "0:a:0", "-vn", "-t", str(duration), "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]
    error_log = Path(job) / "spectrum-decode.log"
    with error_log.open("w", encoding="utf-8") as errors:
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            for frame in range(total_frames):
                current = round(frame * SAMPLE_RATE / fps)
                count = current - position
                if count:
                    raw = child.stdout.read(count * 4)
                    if len(raw) % 4:
                        raise RuntimeError("音频分析数据不完整")
                    samples = array("f")
                    samples.frombytes(raw)
                    if sys.byteorder != "little":
                        samples.byteswap()
                    history = (history + list(samples) + [0.0] * (count - len(samples)))[-card['fftSize']:]
                    position = current
                levels = smooth_bands(frequency_bands(analyzer.decibels(history), fft_size=card['fftSize'], options=card), previous, 1 / fps, card)
                drawing = visualization_path([min(1, value * card['gain']) for value in levels], curve_width, curve_height, card['thickness'] * height / 1080, card)
                override = f"{{\\an7\\pos({left:.3f},{top:.3f})\\bord0\\shad0\\b0\\c{ass_color(card['color'])}\\alpha&H18&\\p4}}"
                # The progress bar (layers 2/3) covers the shared resting baseline.
                output.write(f"Dialogue: 1,{ass_time(frame / fps)},{ass_time(min(duration, (frame + 1) / fps))},歌词,,0,0,0,,{override}{drawing}\n")
                if progress and (frame % max(1, fps) == 0 or frame == total_frames - 1):
                    progress((frame + 1) / total_frames * 100)
            # Consume the short tail so the decoder can exit even if stdout is full.
            while child.stdout.read(65536):
                pass
            if child.wait() != 0:
                raise RuntimeError("无法分析音频，详见音频分析诊断日志")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdout.close()
