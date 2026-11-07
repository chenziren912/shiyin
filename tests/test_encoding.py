import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/VinylMV/Renderer'))
from encoding_settings import validate_encoding, encoding_arguments
from composition import default_layout
import render


class EncodingTests(unittest.TestCase):
    def test_defaults_preserve_original_quality_and_speed(self):
        settings = validate_encoding(None)
        self.assertEqual(settings['crf'], 20)
        self.assertEqual(settings['preset'], 'veryfast')
        args = encoding_arguments(settings, 30)
        self.assertEqual(args[args.index('-c:v') + 1], 'libx264')
        self.assertIn('+faststart', args)
        self.assertNotIn('-b:v', args)

    def test_invalid_values_and_parameter_injection_are_rejected(self):
        for value in [{'codec': 'other'}, {'preset': 'slow -y'}, {'crf': float('nan')}, {'crf': True},
                      {'bitrateMbps': 0}, {'threads': 1.5}, {'channels': 3}, {'fastStart': 1},
                      {'rateControl': 'vbr', 'bitrateMbps': 8, 'maxBitrateMbps': 4}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_encoding(value)

    def test_modes_do_not_leave_conflicting_crf_and_bitrate_options(self):
        for codec in ('h264', 'hevc'):
            for mode in ('crf', 'vbr', 'cbr'):
                args = encoding_arguments({'codec': codec, 'rateControl': mode, 'bitrateMbps': 2, 'maxBitrateMbps': 3}, 24)
                self.assertEqual('-crf' in args, mode == 'crf')
                self.assertEqual('-b:v' in args, mode != 'crf')
                self.assertEqual('-minrate' in args, mode == 'cbr')
                if codec == 'h264' and mode == 'cbr':
                    self.assertIn('nal-hrd=vbr:filler=1:force-cfr=1', args)

    def test_baseline_compatibility_and_hevc_profiles(self):
        args = encoding_arguments({'profile': 'baseline', 'bFrames': 5}, 30)
        self.assertEqual(args[args.index('-bf') + 1], '0')
        with self.assertRaises(ValueError):
            validate_encoding({'codec': 'hevc', 'profile': 'high'})

    def test_gop_threads_audio_and_faststart_options(self):
        args = encoding_arguments({'keyframeSeconds': 2, 'threads': 2, 'audioBitrateKbps': 128, 'channels': 2, 'sampleRate': 48000, 'fastStart': False}, 24)
        self.assertEqual(args[args.index('-g') + 1], '48')
        self.assertIn('48000', args)
        self.assertNotIn('-movflags', args)

    def test_container_compatibility(self):
        for container in ('mkv', 'webm'):
            args = encoding_arguments({}, 24, container)
            self.assertNotIn('-movflags', args)
        webm = encoding_arguments({'sampleRate': 44100, 'preset': 'ultrafast'}, 24, 'webm')
        self.assertIn('libvpx-vp9', webm)
        self.assertIn('libopus', webm)
        self.assertNotIn('libx264', webm)
        self.assertNotIn('-bf', webm)
        self.assertIn('48000', webm)
        self.assertIn('+faststart', encoding_arguments({}, 24, 'mov'))
        with self.assertRaises(ValueError):
            encoding_arguments({}, 24, 'exe')

    def test_explicit_new_settings_reject_incompatible_combinations(self):
        for settings, container in [({'schemaVersion': 2}, 'webm'), ({'codec': 'ffv1'}, 'mp4'),
                                     ({'codec': 'prores'}, 'webm'), ({'audioCodec': 'flac'}, 'mp4'),
                                     ({'audioCodec': 'mp3', 'audioBitrateKbps': 512}, 'mkv'),
                                     ({'encoder': 'nvenc', 'codec': 'vp9'}, 'webm'),
                                     ({'codec': 'av1', 'rateControl': 'cbr'}, 'mp4')]:
            with self.subTest(settings=settings, container=container), self.assertRaises(ValueError):
                encoding_arguments(settings, 24, container)

    def test_editing_and_lossless_encoders_do_not_get_rate_or_speed_flags(self):
        for codec, container in [('prores', 'mov'), ('ffv1', 'mkv')]:
            args = encoding_arguments({'codec': codec}, 24, container)
            for unused in ('-crf', '-b:v', '-bf', '-preset', '-maxrate'):
                self.assertNotIn(unused, args)
        args = encoding_arguments({'codec': 'prores', 'proresProfile': 4}, 24, 'mov')
        self.assertIn('yuv444p10le', args)

    def test_lossless_audio_and_opus_use_appropriate_parameters(self):
        for codec in ('flac', 'pcm16', 'pcm24'):
            self.assertNotIn('-b:a', encoding_arguments({'audioCodec': codec}, 24, 'mkv'))
        self.assertNotIn('-b:a', encoding_arguments({'audioCodec': 'alac'}, 24, 'mov'))
        args = encoding_arguments({'codec': 'av1', 'audioCodec': 'opus'}, 24, 'webm')
        self.assertIn('48000', args)
        args = encoding_arguments({'codec': 'vp9', 'audioCodec': 'vorbis', 'vorbisQuality': 6}, 24, 'webm')
        self.assertIn('-q:a', args)
        self.assertNotIn('-b:a', args)
        with self.assertRaises(ValueError):
            encoding_arguments({'audioCodec': 'opus', 'channels': 1, 'audioBitrateKbps': 512}, 24, 'mkv')

    def test_hardware_parameters_are_backend_specific(self):
        for backend, flag in [('nvenc', '-cq'), ('qsv', '-global_quality'), ('amf', '-qp_i')]:
            args = encoding_arguments({'encoder': backend}, 24)
            self.assertIn('h264_' + backend, args)
            self.assertIn(flag, args)
            self.assertNotIn('-crf', args)
            self.assertNotIn('-threads:v', args)
        args = encoding_arguments({'encoder': 'nvenc', 'lookahead': 16, 'spatialAq': True, 'multipass': 'qres'}, 24)
        self.assertIn('qres', args)
        self.assertIn('-spatial-aq', args)

    def test_ten_bit_and_quality_bounds(self):
        self.assertIn('yuv420p10le', encoding_arguments({'codec': 'hevc', 'profile': 'main10'}, 24))
        self.assertIn('p010le', encoding_arguments({'codec': 'hevc', 'encoder': 'qsv', 'profile': 'main10'}, 24))
        for value in [{'codec': 'h264', 'crf': 52}, {'codec': 'h264', 'pixelFormat': 'yuv420p10le'},
                      {'encoder': 'nvenc', 'tune': 'grain'}, {'codec': 'av1', 'profile': 'high'}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_encoding(value)

    def test_inactive_fields_do_not_reject_compatible_exports(self):
        args = encoding_arguments({'codec': 'av1', 'rateControl': 'vbr', 'bitrateMbps': 8, 'maxBitrateMbps': 2}, 24)
        self.assertNotIn('-maxrate', args)
        encoding_arguments({'codec': 'prores', 'rateControl': 'vbr', 'bitrateMbps': 8, 'maxBitrateMbps': 2}, 24, 'mov')
        with self.assertRaises(ValueError):
            encoding_arguments({'codec': 'ffv1', 'ffv1Level': 1, 'pixelFormat': 'yuv422p10le'}, 24, 'mkv')
        with self.assertRaises(ValueError):
            validate_encoding({'codec': 'av1', 'encoder': 'nvenc', 'crf': 60})


def integration():
    import uuid
    folder = ROOT / '.test-output' / '编码设置验证' / uuid.uuid4().hex[:8]
    folder.mkdir(parents=True)
    media = ROOT / '.test-output' / "中文路径 ' [测试]"
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    layout = default_layout()
    for card in layout['cards']:
        card['enabled'] = False
    results = []
    for codec in ('h264', 'hevc'):
        for mode in ('crf', 'vbr', 'cbr'):
            job = folder / (codec + '-' + mode)
            job.mkdir()
            output = job / '视频.mp4'
            settings = dict(codec=codec, rateControl=mode, crf=28, bitrateMbps=1, maxBitrateMbps=2,
                            preset='ultrafast', keyframeSeconds=1, bFrames=0, threads=1,
                            audioBitrateKbps=128, sampleRate=48000, channels=2, fastStart=mode != 'vbr')
            config = dict(audioPath=str(media / '测试音乐.mp3'), backgroundPath=str(media / '短背景.mp4'),
                          duration=3, volume=100, brightness=45, fontSize=44, width=854, height=480, fps=24,
                          lyrics='', showSpectrum=False, layout=layout, encoding=settings, outputPath=str(output))
            render.render(config, ffmpeg, job)
            metadata = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
            video = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
            audio = next(s for s in metadata['streams'] if s['codec_type'] == 'audio')
            assert video['codec_name'] == ('h264' if codec == 'h264' else 'hevc')
            assert video['r_frame_rate'] == '24/1'
            assert audio['sample_rate'] == '48000' and audio['channels'] == 2
            assert audio['codec_name'] == 'aac' and 10000 < int(audio['bit_rate']) < 200000
            assert '128 kb/s' in (job / 'ffmpeg.log').read_text(encoding='utf-8')
            frames = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'json', str(output)]))['frames']
            times = [float(f['pts_time']) for f in frames]
            assert len(times) >= 3 and max(b-a for a,b in zip(times,times[1:])) <= 1.01
            data = output.read_bytes()
            assert (data.index(b'moov') < data.index(b'mdat')) == settings['fastStart']
            results.append(dict(codec=codec, mode=mode, bitrate=video.get('bit_rate'), output=str(output)))
    (folder / 'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print('六组真实编码导出通过：H.264/H.265 × 恒定画质/动态平均码率/固定目标码率；音频、关键帧与快速起播均通过。')


if __name__ == '__main__':
    integration() if '--integration' in sys.argv else unittest.main()
