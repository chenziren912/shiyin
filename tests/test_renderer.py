import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src/VinylMV/Renderer"))
from lyric_layout import FontMeasure, fit_lyric
from spectrum import SpectrumAnalyzer, frequency_bands, curve_points, curve_segments, ribbon_path, smooth_bands
from composition import normalize_layout, get_cards, format_time, ass_color
import math
SPEC = importlib.util.spec_from_file_location("renderer", ROOT / "src/VinylMV/Renderer/render.py")
renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renderer)


class LyricsTests(unittest.TestCase):
    def test_repeated_timestamps_and_translation(self):
        self.assertEqual(renderer.parse_lrc("[00:01.20][00:04.5]你好\n[00:01.20]Hello"), [(1.2, "你好\nHello"), (4.5, "你好")])

    def test_offsets_and_instrumental_gaps(self):
        self.assertEqual(renderer.parse_lrc("[offset:-300]\n[00:00.1]开头\n[00:02.000]\n[00:03]结尾", .1), [(0.0, "开头"), (1.8, ""), (2.8, "结尾")])

    def test_invalid_seconds_and_metadata_are_ignored(self):
        self.assertEqual(renderer.parse_lrc("[ar:作者]\n[00:99]无效\n[00:12.123]有效"), [(12.123, "有效")])

    def test_lyric_text_cannot_inject_ass_overrides(self):
        self.assertNotIn("{", renderer.safe_ass(r"{\p1}m 0 0"))
        self.assertEqual(renderer.safe_ass("中文\n第二行"), "中文\\N第二行")

    def test_long_unicode_lines_wrap_without_losing_text(self):
        original = "月光落在安静湖面让每一首歌都有自己的画面"
        wrapped = renderer.wrap_lyric(original, 20)
        self.assertIn("\n", wrapped)
        self.assertEqual(wrapped.replace("\n", ""), original)

    def test_clock_handles_long_songs(self):
        self.assertEqual(renderer.clock(3601.9), "60:01")
        self.assertEqual(renderer.ass_time(3601.25), "1:00:01.25")

    def test_english_words_are_never_split(self):
        original = 'I would still be holding you like this'
        wrapped = renderer.wrap_lyric(original, 16)
        self.assertEqual(wrapped.split(), original.split())
        self.assertNotIn('th\nis', wrapped)
        self.assertEqual(renderer.wrap_lyric('extraordinary', 4), 'extraordinary')

    def test_font_measured_lyrics_fit_wider_pane(self):
        examples = ['I would still be holding you like this',
                    'All these fairy tales are full of stories',
                    'Extraordinarilylongunbrokenword' * 3,
                    '月光落在安静湖面让每一首歌都有自己的画面\nEvery single word stays complete']
        with FontMeasure() as metrics:
            for original in examples:
                wrapped, size = fit_lyric(original, 80, 1920 * .55, 80 * 2.6 * .94, metrics.measure)
                for line in wrapped.split('\n'):
                    self.assertLessEqual(metrics.measure(line, size), 1920 * .55)
                self.assertEqual(''.join(wrapped.split()), ''.join(original.split()))
                self.assertLessEqual(len(wrapped.split('\n')) * size * 1.4, 80 * 2.6 * .94)

    def test_output_layout_moves_up_and_removes_branding(self):
        ass = renderer.make_ass({'width': 1920, 'height': 1080, 'fontSize': 44, 'duration': 8}, [(0, 'I would still be holding you like this')])
        self.assertNotIn('拾音 · 滚动歌词', ass)
        self.assertIn('\\clip(816,162,1872,799)', ass)
        self.assertIn('\\pos(1344,459)', ass)

    def test_missing_lyrics_blank_and_message_are_distinct(self):
        config = {'width': 1920, 'height': 1080, 'fontSize': 44, 'duration': 8, 'layout': {'cards': [{'id': 'progress', 'enabled': False}]}}
        self.assertIn('纯音乐 · 此刻只听旋律', renderer.make_ass(config, []))
        self.assertIn('纯音乐 · 此刻只听旋律', renderer.make_ass({**config, 'emptyLyricsText': None}, []))
        blank = renderer.make_ass({**config, 'emptyLyricsText': ''}, [])
        self.assertNotIn(',歌词,,', blank)
        message = '该歌曲暂无可用歌词\n请欣赏音乐'
        ass = renderer.make_ass({**config, 'emptyLyricsText': message}, [])
        self.assertIn('该歌曲暂无可用歌词\\N请欣赏音乐', ass)
        self.assertIn('0:00:00.00,0:00:08.00,歌词', ass)
        self.assertNotIn('\\move(', '\n'.join(line for line in ass.splitlines() if ',歌词,,' in line))
        self.assertIn('\\clip(816,162,1872,799)', ass)
        self.assertNotIn('纯音乐', ass)
        # Existing timed lyrics take precedence over the missing-lyrics message.
        self.assertNotIn('该歌曲暂无', renderer.make_ass({**config, 'emptyLyricsText': message}, [(0, '已有歌词')]))

    def test_fixed_message_honors_card_visibility_and_escapes_commands(self):
        config = {'width': 1920, 'height': 1080, 'fontSize': 44, 'duration': 8, 'emptyLyricsText': r'{\p1}提示'}
        ass = renderer.make_ass(config, [], [(0, {'color': '#abcdef', 'outline': '#111111'})])
        self.assertIn('｛＼p1｝提示', ass)
        self.assertIn(renderer.ass_color('#abcdef'), ass)
        hidden = renderer.make_ass({**config, 'layout': {'cards': [{'id': 'lyrics', 'enabled': False}]}}, [])
        self.assertNotIn('｛＼p1｝提示', hidden)


class SpectrumTests(unittest.TestCase):
    def test_fft_follows_real_frequency_and_silence_is_flat(self):
        analyzer = SpectrumAnalyzer()
        quiet = frequency_bands(analyzer.decibels([0] * 1024))
        self.assertEqual(max(quiet), 0)
        peaks = []
        for frequency in (220, 1760):
            samples = [.6 * math.sin(2 * math.pi * frequency * index / 24000) for index in range(1024)]
            bands = frequency_bands(analyzer.decibels(samples))
            peaks.append(max(range(48), key=lambda index: bands[index]))
            self.assertGreater(max(bands), .8)
        self.assertGreater(peaks[1], peaks[0] + 10)

    def test_curve_is_continuous_cubic_and_stays_in_band(self):
        levels = smooth_bands([1 if i % 5 == 0 else .1 for i in range(48)], [0] * 48, .1)
        points = curve_points(levels, 1670.4, 81)
        segments = curve_segments(points)
        self.assertEqual(len(segments), 47)
        for previous, following in zip(segments, segments[1:]):
            self.assertAlmostEqual(previous[5] - previous[3], following[1] - previous[5])
        self.assertTrue(all(0 <= y <= 81 for _, y in points))
        self.assertEqual(ribbon_path(levels, 1670.4, 81, 2.8).count('b '), 94)


class CompositionTests(unittest.TestCase):
    def test_invalid_layout_is_bounded_and_record_stays_round(self):
        result = normalize_layout({'cards': [None, {'id': []}, {'id': 'record', 'x': -3, 'width': 2, 'coverRatio': 8}, {'id': 'clock', 'fontSize': float('nan'), 'color': 'bad', 'format': 'unsafe'}]})
        cards = {c['id']: c for c in result['cards']}
        self.assertEqual(cards['record']['x'], 0)
        self.assertEqual(cards['record']['width'], .5625)
        self.assertEqual(cards['record']['height'], 1)
        self.assertEqual(cards['record']['coverRatio'], .95)
        self.assertEqual(cards['clock']['fontSize'], 22)
        self.assertEqual(cards['clock']['format'], 'elapsed-total')

    def test_linked_curve_tracks_progress_and_can_be_independent(self):
        value = {'cards': [{'id': 'progress', 'x': .1, 'y': .7, 'width': .7}, {'id': 'spectrum', 'height': .1}]}
        cards = get_cards({'layout': value})
        self.assertEqual(cards['spectrum']['x'], .1)
        self.assertAlmostEqual(cards['spectrum']['y'] + .1 * .85, .71)
        value['cards'][1].update(linked=False, x=.2, y=.3)
        self.assertEqual(get_cards({'layout': value})['spectrum']['y'], .3)

    def test_time_formats_and_ass_colors(self):
        self.assertEqual(format_time(4.8, 8, 'remaining-total'), '-00:04 / 00:08')
        self.assertEqual(format_time(3601, 3700, 'hours'), '01:00:01 / 01:01:40')
        self.assertEqual(format_time(4.8, 8, 'elapsed'), '00:04')
        self.assertEqual(ass_color('#ffcc66'), '&H66ccff&')

    def test_deleted_cards_are_omitted_from_subtitles(self):
        value = normalize_layout()
        for c in value['cards']:
            c['enabled'] = False
        ass = renderer.make_ass({'layout': value, 'width': 854, 'height': 480, 'duration': 1, 'fontSize': 44}, [(0, 'This lyric must be hidden')])
        self.assertNotIn('Dialogue:', ass)

    def test_custom_clock_style_and_lyrics_use_saved_layout(self):
        value = normalize_layout({'cards': [{'id': 'clock', 'format': 'remaining-total', 'style': 'pill', 'color': '#ffcc66'}, {'id': 'lyrics', 'x': .1, 'width': .6, 'color': '#112233', 'align': 'left'}]})
        ass = renderer.make_ass({'layout': value, 'width': 1920, 'height': 1080, 'duration': 8.3, 'fontSize': 44}, [(0, 'Whole words stay together')])
        self.assertIn('\\c&H66ccff&', ass)
        self.assertIn('\\c&H332211&', ass)
        self.assertIn('\\an4\\clip(192,162,1344,799)', ass)
        self.assertIn('-00:09 / 00:09', ass)
        self.assertIn('0:00:00.30', ass)


def integration():
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RuntimeError("集成测试需要 FFmpeg 与 ffprobe")
    folder = ROOT / ".test-output" / "中文路径 ' [测试]"
    folder.mkdir(parents=True, exist_ok=True)
    job = folder / "job"
    job.mkdir(exist_ok=True)

    def run(args):
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout

    run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-af", "volume=3", "-metadata", "title=湖畔来信", "-metadata", "artist=拾音测试", "-c:a", "libmp3lame", str(folder / "测试音乐.mp3")])
    run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(folder / "短背景.mp4")])
    renderer.create_record(folder / "封面.png", 256)
    lyrics = "[00:00.00]月光落在安静湖面\n[00:02.00]把声音留在画面里\n[00:04.00]一张唱片缓缓转动\n[00:06.00]每一句歌词都有回声"
    (folder / "测试音乐.lrc").write_text(lyrics, encoding="utf-8")
    config = {
        "audioPath": str(folder / "测试音乐.mp3"), "backgroundPath": str(folder / "短背景.mp4"),
        "coverPath": str(folder / "封面.png"), "title": "湖畔来信", "artist": "拾音测试",
        "lyrics": lyrics, "duration": 8, "volume": 1000, "brightness": 45,
        "fontSize": 44, "width": 854, "height": 480, "fps": 30, "offset": 0,
        "outputPath": str(folder / "滚动歌词测试.mp4")
    }
    output = Path(config["outputPath"])
    if output.exists():
        output.unlink()
    renderer.render(config, ffmpeg, job)
    metadata = json.loads(run([ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(output)]))
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
    assert video["codec_name"] == "h264" and (video["width"], video["height"]) == (854, 480)
    assert audio["codec_name"] == "aac"
    assert abs(float(metadata["format"]["duration"]) - 8) < .15
    run([ffmpeg, "-v", "error", "-y", "-ss", "4.8", "-i", str(output), "-frames:v", "1", "-update", "1", str(folder / "视频画面.png")])
    # Validate that a silent, pure-color, cover-free render also finishes correctly.
    config.update(backgroundPath=None, coverPath=None, volume=0, lyrics="", duration=1, outputPath=str(folder / "纯音乐测试.mp4"))
    if Path(config["outputPath"]).exists():
        Path(config["outputPath"]).unlink()
    renderer.render(config, ffmpeg, job)
    # All visual cards can be removed; an unused missing cover must not block export.
    empty_layout = normalize_layout()
    for card in empty_layout['cards']:
        card['enabled'] = False
    config.update(layout=empty_layout, coverPath=str(folder / '不存在的封面.png'), outputPath=str(folder / '全部卡片删除测试.mp4'))
    if Path(config['outputPath']).exists():
        Path(config['outputPath']).unlink()
    renderer.render(config, ffmpeg, job)
    print("集成测试通过：中文及特殊字符路径、短背景循环、封面、1000% 音量、静音和纯音乐模式。")


if __name__ == "__main__":
    if "--integration" in sys.argv:
        integration()
    else:
        unittest.main()
