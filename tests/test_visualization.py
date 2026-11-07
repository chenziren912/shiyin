"""Real background adaptation and configurable audio visualization checks."""
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/VinylMV/Renderer'))
from composition import normalize_layout, get_cards, auto_palette
from spectrum import SpectrumAnalyzer, frequency_bands, smooth_bands, visualization_path
import render


class VisualTests(unittest.TestCase):
    def test_samples_lyric_region_and_manual_skips_decode(self):
        manual = dict(layout={'cards': [{'id': 'lyrics', 'autoColor': False}]})
        self.assertEqual(render.analyze_background_colors('missing-ffmpeg', 'missing-video', manual, ROOT), [])
        directory = ROOT / '.test-output' / '歌词区域采样' / uuid.uuid4().hex[:8]
        directory.mkdir(parents=True)
        video = directory / '左暗右亮.mp4'
        ffmpeg = shutil.which('ffmpeg')
        subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=24:d=1', '-vf', 'drawbox=x=320:y=0:w=320:h=360:color=white:t=fill', '-c:v', 'libx264', str(video)], check=True, stderr=subprocess.PIPE)
        colors = []
        for x in [.05, .65]:
            config = dict(duration=.5, brightness=100, layout={'cards': [{'id': 'lyrics', 'x': x, 'width': .3}]})
            colors.append(render.analyze_background_colors(ffmpeg, video, config, directory)[0][1]['color'])
        self.assertGreater(int(colors[0][1:3], 16), 220)
        self.assertLess(int(colors[1][1:3], 16), 40)
        config['duration'] = .05
        self.assertTrue(render.analyze_background_colors(ffmpeg, video, config, directory), '不足半秒也能提取首帧')
        (directory / 'result.json').write_text(json.dumps(dict(passed=True, left=colors[0], right=colors[1])), encoding='utf-8')

    def test_palette_switches_with_background_and_brightness(self):
        light = auto_palette(bytes([0, 0, 0, 255]) * 10)
        dark = auto_palette(bytes([255, 255, 255, 255]) * 10)
        self.assertGreater(int(light['color'][1:3], 16), 220)
        self.assertLess(int(dark['color'][1:3], 16), 40)
        self.assertNotEqual(light['outline'], dark['outline'])
        self.assertEqual(auto_palette(bytes([255, 255, 255, 255]), 0), light)
        self.assertNotEqual(auto_palette(bytes([20, 70, 140, 255]))['color'], auto_palette(bytes([140, 70, 20, 255]))['color'])

    def test_configuration_bounds_and_defaults(self):
        cards = get_cards({'layout': {'cards': [{'id': 'spectrum', 'fftSize': 123, 'bandCount': 999, 'attack': -3, 'release': 5, 'smoothing': 8, 'barGap': 5, 'visualization': 'bad'}]}})
        c = cards['spectrum']
        self.assertEqual((c['fftSize'], c['bandCount'], c['attack'], c['release'], c['smoothing'], c['barGap'], c['visualization']), (1024, 192, .01, 1, 4, .9, 'curve'))
        self.assertTrue(cards['lyrics']['autoColor'])
        mirrored = get_cards({'layout': {'cards': [{'id': 'spectrum', 'visualization': 'mirror'}]}})
        self.assertAlmostEqual(mirrored['spectrum']['y'] + mirrored['spectrum']['height'], mirrored['progress']['y'] + mirrored['progress']['height'] / 2)

    def test_js_python_palette_and_validation_match(self):
        cases = [[[0, 0, 0, 255], 100], [[255, 255, 255, 255], 100], [[20, 70, 140, 255, 240, 170, 60, 255], 70]]
        value = {'cards': [{'id': 'spectrum', 'visualization': 'mirror', 'fftSize': 4096, 'bandCount': 71.5, 'barGap': .4}, {'id': 'lyrics', 'autoColor': False}]}
        script = "const fs=require('fs'),c=require('./src/VinylMV/Web/composition.js');const d=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({palettes:d.cases.map(([p,b])=>c.autoPalette(p,b)),layout:c.normalize(d.value)}));"
        result = json.loads(subprocess.check_output(['node', '-e', script], input=json.dumps(dict(cases=cases, value=value)).encode(), cwd=ROOT))
        self.assertEqual(result['palettes'], [auto_palette(p, b) for p, b in cases])
        self.assertEqual(result['layout'], normalize_layout(value))

    def test_frequency_resolution_band_count_and_smoothing(self):
        for size, count in [(512, 16), (2048, 72), (4096, 192)]:
            c = get_cards({'layout': {'cards': [{'id': 'spectrum', 'fftSize': size, 'bandCount': count, 'smoothing': 0}]}})['spectrum']
            samples = [.6 * math.sin(2 * math.pi * 1760 * i / 24000) for i in range(size)]
            bands = frequency_bands(SpectrumAnalyzer(size).decibels(samples), fft_size=size, options=c)
            self.assertEqual(len(bands), count)
            self.assertGreater(max(bands), .8)
            self.assertGreater(max(range(count), key=lambda i: bands[i]), count // 2)
        fast = smooth_bands([1.] * 16, [0.] * 16, .1, {'attack': .01, 'smoothing': 0})
        slow = smooth_bands([1.] * 16, [0.] * 16, .1, {'attack': .5, 'smoothing': 0})
        self.assertGreater(fast[0], slow[0] * 4)

    def test_all_geometries_and_silent_bars(self):
        values = [.5] * 16
        c = get_cards({})['spectrum']
        for kind, starts, beziers in [('curve', 1, 30), ('mirror', 2, 60), ('bars', 16, 0)]:
            c['visualization'] = kind
            drawing = visualization_path(values, 1000, 80, 3, c)
            self.assertEqual(drawing.count('m '), starts)
            self.assertEqual(drawing.count('b '), beziers)
        script = "const s=require('./src/VinylMV/Web/spectrum.js');process.stdout.write(JSON.stringify(['curve','mirror','bars'].map(visualization=>s.path(Array(16).fill(.5),1000,80,{visualization,barGap:.3}))));"
        paths = json.loads(subprocess.check_output(['node', '-e', script], cwd=ROOT))
        self.assertEqual([p.count('M ') for p in paths], [1, 2, 16])
        self.assertEqual([p.count('C ') for p in paths], [15, 30, 0])

    def test_color_boundaries_do_not_restart_lyric_movement(self):
        config = dict(width=854, height=480, duration=4, fontSize=44)
        palettes = [(0., auto_palette(bytes([0, 0, 0, 255]))), (2., auto_palette(bytes([255, 255, 255, 255])))]
        ass = render.make_ass(config, [(0., 'First line'), (1.8, 'The current line')], palettes)
        self.assertIn('\\c' + render.ass_color(palettes[1][1]['color']), ass)
        # A colour boundary inside the 320 ms scroll resumes the partial movement.
        current_events = [line for line in ass.splitlines() if line.endswith('The current line')]
        event = next(line for line in current_events if line.startswith('Dialogue: 1,0:00:02.00'))
        self.assertIn(',0,120)', event)
        manual = render.make_ass(config, [(0., 'Manual')])
        self.assertNotIn('\\3a&H30&', manual)


def integration():
    directory = ROOT / '.test-output' / '自动配色与音频样式' / uuid.uuid4().hex[:8]
    directory.mkdir(parents=True)
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    def run(args):
        return subprocess.check_output(args, stderr=subprocess.PIPE)
    audio, background = directory / '采样音乐.wav', directory / '明暗背景.mp4'
    run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(2*PI*220*t)+0.25*sin(2*PI*1760*t):s=24000:d=6', str(audio)])
    run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=24:d=2', '-f', 'lavfi', '-i', 'color=white:s=640x360:r=24:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(background)])
    outputs = []
    for kind, size, count in [('curve', 512, 16), ('mirror', 2048, 72), ('bars', 4096, 128)]:
        job = directory / kind
        job.mkdir()
        layout = normalize_layout({'cards': [{'id': 'spectrum', 'visualization': kind, 'fftSize': size, 'bandCount': count, 'smoothing': 1, 'barGap': .4, 'gain': 1.4, 'height': .13}]})
        config = dict(audioPath=str(audio), backgroundPath=str(background), outputPath=str(job / (kind + '.mp4')), width=854, height=480, fps=24, fontSize=44, volume=100, brightness=100, duration=6, layout=layout, lyrics='[00:00]Contrast follows the scene\n[00:01.80]字幕随背景自动配色\n[00:03.60]Smooth music in every frame')
        render.render(config, ffmpeg, job)
        palettes = json.loads((job / 'lyric-colors.json').read_text())
        self_checks = [int(palettes[0][1]['color'][1:3], 16) > 220, any(int(p['color'][1:3], 16) < 40 for _, p in palettes), int(palettes[-1][1]['color'][1:3], 16) > 220]
        assert all(self_checks), palettes
        ass = (job / 'lyrics.ass').read_text(encoding='utf-8-sig')
        assert all(render.ass_color(p['color']) in ass for _, p in palettes)
        metadata = json.loads(run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', config['outputPath']]))
        assert abs(float(metadata['format']['duration']) - 6) < .15
        assert next(s for s in metadata['streams'] if s['codec_type'] == 'video')['codec_name'] == 'h264'
        for second, name in [(1, '暗背景'), (3, '亮背景')]:
            run([ffmpeg, '-v', 'error', '-ss', str(second), '-i', config['outputPath'], '-frames:v', '1', '-update', '1', str(job / (name + '.png'))])
        (job / 'config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
        outputs.append(dict(kind=kind, fftSize=size, bands=count, palettes=palettes, output=config['outputPath']))
    (directory / 'result.json').write_text(json.dumps(dict(passed=True, outputs=outputs), ensure_ascii=False, indent=2), encoding='utf-8')
    (directory / 'manifest.json').write_text(json.dumps(dict(audio=str(audio), background=str(background)), ensure_ascii=False), encoding='utf-8')
    print('自动配色与三种音频样式实际导出通过：' + str(directory))


if __name__ == '__main__':
    if '--integration' in sys.argv:
        integration()
    else:
        unittest.main()
