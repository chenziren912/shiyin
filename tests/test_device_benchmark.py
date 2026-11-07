import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/VinylMV/Renderer'))
import device_benchmark as benchmark


class BenchmarkTests(unittest.TestCase):
    def test_only_hardware_codecs_offer_hardware_candidates(self):
        self.assertEqual(list(benchmark.candidates({'codec': 'h264'})), ['software', 'nvenc', 'qsv', 'amf'])
        self.assertEqual(list(benchmark.candidates({'codec': 'vp9'})), ['software'])

    def test_invalid_dimensions_fail_before_running_ffmpeg(self):
        with patch.object(benchmark, 'run_ffmpeg') as run:
            with self.assertRaisesRegex(ValueError, '分辨率'):
                benchmark.measure('ffmpeg', dict(width=12, height=13, fps=24), lambda _: None)
            run.assert_not_called()

    def test_webm_uses_real_container_bitrate_and_opus(self):
        calls = []
        def ffmpeg(args, **kwargs):
            calls.append(args)
            if '-encoders' in args:
                return SimpleNamespace(returncode=0, stdout=' libvpx-vp9 encoder\n libopus encoder\n')
            Path(args[-1]).write_bytes(b'output')
            return SimpleNamespace(returncode=0, stdout='')
        with patch.object(benchmark, 'run_ffmpeg', ffmpeg):
            result = benchmark.measure('ffmpeg', dict(width=854, height=480, fps=24, container='webm',
                showSpectrum=False, encoding=dict(codec='vp9', rateControl='vbr', bitrateMbps=2, threads=2)), lambda _: None)
        self.assertTrue(result[0]['available'])
        encoded = calls[-1]
        self.assertTrue(encoded[-1].endswith('.webm'))
        self.assertEqual(encoded[encoded.index('-c:v')+1], 'libvpx-vp9')
        self.assertEqual(encoded[encoded.index('-c:a')+1], 'libopus')
        self.assertEqual(encoded[encoded.index('-b:v')+1], '2000000')
        self.assertEqual(encoded[encoded.index('-frames:v')+1], '72')

    def test_hardware_never_silently_clamps_user_quality(self):
        def ffmpeg(args, **kwargs):
            if '-encoders' in args:
                return SimpleNamespace(returncode=0, stdout=' libsvtav1 encoder\n av1_nvenc encoder\n av1_qsv encoder\n av1_amf encoder\n')
            Path(args[-1]).write_bytes(b'output')
            return SimpleNamespace(returncode=0, stdout='')
        with patch.object(benchmark, 'run_ffmpeg', ffmpeg):
            result = benchmark.measure('ffmpeg', dict(width=854, height=480, fps=24, container='webm',
                showSpectrum=False, encoding=dict(codec='av1', rateControl='crf', crf=60, threads=2)), lambda _: None)
        self.assertTrue(result[0]['available'])
        self.assertEqual(result[0]['settings']['crf'], 60)
        self.assertTrue(all(not r['available'] for r in result[1:]))

    def test_curve_analysis_and_compositing_are_both_included(self):
        calls, configs = [], []
        def ffmpeg(args, **kwargs):
            calls.append((args, kwargs))
            if '-encoders' in args:
                return SimpleNamespace(returncode=0, stdout=' libx264 encoder\n')
            self.assertTrue((Path(kwargs['cwd']) / 'spectrum.ass').is_file())
            Path(args[-1]).write_bytes(b'output')
            return SimpleNamespace(returncode=0, stdout='')
        def spectrum(output, ffmpeg, audio, config, folder, progress):
            configs.append(config)
            output.write('Dialogue: curve analysis was executed\n')
            progress(100)
        profile = dict(width=854, height=480, fps=24, container='mp4', showSpectrum=True,
                       layout=dict(cards=[dict(id='spectrum', visualization='mirror', bandCount=96, fftSize=4096)]))
        with patch.object(benchmark, 'run_ffmpeg', ffmpeg), patch.object(benchmark, 'write_spectrum_events', spectrum), \
                patch.object(benchmark.time, 'perf_counter', side_effect=[10., 12., 20., 23.]):
            result = benchmark.measure('ffmpeg', profile, lambda _: None)[0]
        self.assertTrue(result['available'])
        self.assertEqual(result['spectrumFrames'], 72)
        self.assertGreater(result['analysisSeconds'], 0)
        self.assertEqual((result['analysisSeconds'], result['encodeSeconds'], result['seconds'], result['fps']), (2., 3., 5., 14.4))
        self.assertAlmostEqual(result['seconds'], result['analysisSeconds'] + result['encodeSeconds'], delta=.0002)
        self.assertAlmostEqual(result['fps'], 72 / result['seconds'], delta=.05)
        card = next(c for c in configs[0]['layout']['cards'] if c['id'] == 'spectrum')
        self.assertEqual((card['visualization'], card['bandCount'], card['fftSize']), ('mirror', 96, 4096))
        args = next(args for args, kwargs in calls if '-vf' in args)
        self.assertEqual(args[args.index('-vf') + 1], 'ass=filename=spectrum.ass')

    def test_disabled_curve_never_decodes_or_composites_curve(self):
        def ffmpeg(args, **kwargs):
            if '-encoders' in args:
                return SimpleNamespace(returncode=0, stdout=' libx264 encoder\n')
            self.assertNotIn('-vf', args)
            Path(args[-1]).write_bytes(b'output')
            return SimpleNamespace(returncode=0, stdout='')
        for extra in (dict(showSpectrum=False), dict(layout=dict(cards=[dict(id='spectrum', enabled=False)]))):
            with self.subTest(extra=extra), patch.object(benchmark, 'run_ffmpeg', ffmpeg), patch.object(benchmark, 'write_spectrum_events') as spectrum:
                result = benchmark.measure('ffmpeg', dict(width=854, height=480, fps=24, container='mp4', **extra), lambda _: None)[0]
                spectrum.assert_not_called()
                self.assertEqual((result['analysisSeconds'], result['spectrumFrames']), (0, 0))


def integration():
    root = Path(__file__).resolve().parents[1] / '.test-output' / '音频曲线测速' / str(time.time_ns())
    root.mkdir(parents=True)
    evidence = []
    for style, fft, bands in [('curve', 512, 48), ('mirror', 2048, 96), ('bars', 4096, 192), ('off', 1024, 48)]:
        folder = root / style
        folder.mkdir()
        profile = dict(width=854, height=480, fps=24, container='mp4', showSpectrum=style != 'off',
                       layout=dict(cards=[dict(id='spectrum', visualization=style if style != 'off' else 'curve', fftSize=fft, bandCount=bands)]),
                       encoding=dict(codec='h264', rateControl='vbr', bitrateMbps=2, preset='ultrafast', threads=2))
        def retain(event):
            if event.get('result', {}).get('available'):
                sample = next(folder.glob('vinyl-benchmark-*/sample.mp4'))
                shutil.copy2(sample, folder / (event['result']['encoder'] + '.mp4'))
                if style != 'off':
                    shutil.copy2(sample.with_name('spectrum.ass'), folder / 'spectrum.ass')
        results = benchmark.measure('ffmpeg', profile, retain, folder)
        cpu = next(r for r in results if r['encoder'] == 'software')
        assert cpu['available'], results
        assert cpu['analysisSeconds'] > 0 if style != 'off' else cpu['analysisSeconds'] == 0
        assert cpu['spectrumFrames'] == (72 if style != 'off' else 0)
        assert abs(cpu['seconds'] - cpu['analysisSeconds'] - cpu['encodeSeconds']) < .0002
        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(folder / 'software.mp4')]))
        video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
        assert (video['width'], video['height'], video['codec_name'], int(video['nb_frames'])) == (854, 480, 'h264', 72)
        if style != 'off':
            drawings = [line for line in (folder / 'spectrum.ass').read_text(encoding='utf-8-sig').splitlines() if r'\p4}' in line]
            assert len(drawings) == 72
            assert len({line.split(r'\p4}', 1)[1] for line in drawings}) > 1
        else:
            assert not (folder / 'spectrum.ass').exists()
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '1.4', '-i', str(folder / 'software.mp4'), '-frames:v', '1', '-update', '1', str(folder / 'frame.png')], check=True)
        evidence.append(dict(style=style, profile=profile, results=results, video=video))
        print('实际音频可视化测速通过：' + style, flush=True)
    (root / 'result.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    print('音频曲线测速证据：' + str(root), flush=True)


if __name__ == '__main__':
    if '--integration' in sys.argv:
        integration()
    else:
        unittest.main()
