"""Validated, resolution-independent card layout shared with the visual editor."""
import math
import re


def default_layout(font_size=44):
    return {'version': 1, 'cards': [
        dict(id='record', type='record', enabled=True, x=.1115625, y=.13, width=.286875, height=.51, coverRatio=.43, spinSeconds=20),
        dict(id='caption', type='caption', enabled=True, x=.051, y=.70, width=.408, height=.11, fontSize=38, color='#edf2e7', artistColor='#b4b8af', title='', artist=''),
        dict(id='lyrics', type='lyrics', enabled=True, x=.425, y=.15, width=.55, height=.59, fontSize=font_size, color='#e8f5f0', nearColor='#a4b4ad', dimColor='#6d786f', autoColor=True, lineSpacing=2.6, align='center', bold=True),
        dict(id='clock', type='clock', enabled=True, x=.715, y=.06, width=.22, height=.05, fontSize=22, color='#b4b8af', backgroundColor='#142019', format='elapsed-total', style='plain', align='right'),
        dict(id='spectrum', type='spectrum', enabled=True, x=.065, y=.87625, width=.87, height=.075, color='#c2dfa2', thickness=2.8, gain=1, linked=True, visualization='curve', bandCount=48, fftSize=1024, smoothing=2, attack=.06, release=.18, minFrequency=40, maxFrequency=10000, barGap=.25),
        dict(id='progress', type='progress', enabled=True, x=.065, y=.93, width=.87, height=.02, color='#c0e4b4', trackColor='#505c49', thickness=3),
    ]}


def normalize_layout(value=None, font_size=44):
    result = default_layout(font_size)
    incoming = {c['id']: c for c in value.get('cards', []) if isinstance(c, dict) and isinstance(c.get('id'), str)} if isinstance(value, dict) and isinstance(value.get('cards'), list) else {}
    for card in result['cards']:
        source = incoming.get(card['id'], {})
        for key, default in list(card.items()):
            candidate = source.get(key, default)
            if key in ('id', 'type'):
                continue
            if isinstance(default, bool):
                card[key] = candidate if isinstance(candidate, bool) else default
            elif isinstance(default, (int, float)):
                card[key] = float(candidate) if isinstance(candidate, (int, float)) and not isinstance(candidate, bool) and math.isfinite(candidate) else default
            elif key.lower().endswith('color'):
                card[key] = candidate if isinstance(candidate, str) and re.fullmatch(r'#[0-9a-fA-F]{6}', candidate) else default
            elif key in ('title', 'artist'):
                card[key] = str(candidate)[:500]
            else:
                allowed = {'align': ('left', 'center', 'right'), 'format': ('elapsed-total', 'elapsed', 'remaining-total', 'total', 'hours'), 'style': ('plain', 'pill'), 'visualization': ('curve', 'mirror', 'bars')}
                card[key] = candidate if candidate in allowed.get(key, ()) else default
        card['width'] = max(.03, min(1, card['width']))
        card['height'] = max(.01, min(1, card['height']))
        if card['type'] == 'record':
            card['width'] = min(card['width'], .5625)
            card['height'] = card['width'] * 16 / 9
            card['coverRatio'] = max(.1, min(.95, card['coverRatio']))
            card['spinSeconds'] = max(2, min(120, card['spinSeconds']))
        for key, low, high in [('fontSize', 8, 200), ('thickness', .5, 30), ('gain', .1, 4), ('lineSpacing', 1.5, 5)]:
            if key in card:
                card[key] = max(low, min(high, card[key]))
        if card['type'] == 'spectrum':
            for key, low, high in [('bandCount', 16, 192), ('smoothing', 0, 4), ('attack', .01, .5), ('release', .03, 1), ('minFrequency', 20, 1000), ('maxFrequency', 1100, 12000), ('barGap', 0, .9)]:
                card[key] = max(low, min(high, card[key]))
            card['bandCount'] = math.floor(card['bandCount'] + .5)
            card['smoothing'] = math.floor(card['smoothing'] + .5)
            if card['fftSize'] not in (512, 1024, 2048, 4096):
                card['fftSize'] = 1024
            card['fftSize'] = int(card['fftSize'])
        card['x'] = max(0, min(1 - card['width'], card['x']))
        card['y'] = max(0, min(1 - card['height'], card['y']))
    cards = {c['id']: c for c in result['cards']}
    if cards['spectrum']['linked']:
        spectrum, bar = cards['spectrum'], cards['progress']
        spectrum.update(x=bar['x'], width=bar['width'], y=bar['y'] + bar['height'] / 2 - spectrum['height'] * (1 if spectrum['visualization'] == 'mirror' else .85))
    return result


def get_cards(config):
    return {c['id']: c for c in normalize_layout(config.get('layout'), config.get('fontSize', 44))['cards']}


def ass_color(value):
    return '&H' + value[5:7] + value[3:5] + value[1:3] + '&'


def auto_palette(pixels, brightness=100):
    """Same local-background contrast and complementary tint algorithm as the preview."""
    samples, mean = [], [0., 0., 0.]
    factor = max(0, min(100, brightness)) / 100 * .76

    def luminance(rgb):
        return sum((v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4) * weight for v, weight in zip(rgb, (.2126, .7152, .0722)))

    for index in range(0, len(pixels) - 2, 4):
        rgb = [v / 255 for v in pixels[index:index + 3]]
        gray = sum(v * weight for v, weight in zip(rgb, (.2126, .7152, .0722)))
        adjusted = [(gray + (v - gray) * .8) * factor for v in rgb]
        for channel in range(3):
            mean[channel] += adjusted[channel]
        samples.append(luminance(adjusted))
    if not samples:
        return dict(color='#edf4ee', nearColor='#b8c9bf', dimColor='#91a69a', outline='#101810')
    mean = [v / len(samples) for v in mean]
    maximum, minimum = max(mean), min(mean)
    delta = maximum - minimum
    hue = 120 if delta < .015 else ((mean[1] - mean[2]) / delta * 60 if maximum == mean[0] else ((mean[2] - mean[0]) / delta + 2) * 60 if maximum == mean[1] else ((mean[0] - mean[1]) / delta + 4) * 60)
    hue = math.floor(((hue + 540) % 360) / 30 + .5) * 30 % 360

    def tint(lightness):
        chroma = (1 - abs(2 * lightness - 1)) * .22
        x, m = chroma * (1 - abs(hue / 60 % 2 - 1)), lightness - chroma / 2
        return [v + m for v in ((chroma, x, 0), (x, chroma, 0), (0, chroma, x), (0, x, chroma), (x, 0, chroma), (chroma, 0, x))[int(hue // 60)]]

    def score(rgb):
        light = luminance(rgb)
        ratios = sorted((max(v, light) + .05) / (min(v, light) + .05) for v in samples)
        return ratios[math.floor((len(ratios) - 1) * .2)]

    dark = score(tint(.075)) > score(tint(.95))
    def hex_color(lightness):
        return '#' + ''.join(f'{math.floor(v * 255 + .5):02x}' for v in tint(lightness))
    return dict(color=hex_color(.075 if dark else .95), nearColor=hex_color(.15 if dark else .83), dimColor=hex_color(.22 if dark else .72), outline='#f3f5ef' if dark else '#101810')


def format_time(seconds, duration, style='elapsed-total'):
    def stamp(value, hours=False):
        value = max(0, int(value))
        return f'{value // 3600:02d}:{value // 60 % 60:02d}:{value % 60:02d}' if hours else f'{value // 60:02d}:{value % 60:02d}'
    if style == 'elapsed':
        return stamp(seconds)
    if style == 'total':
        return stamp(duration)
    if style == 'remaining-total':
        return '-' + stamp(math.ceil(max(0, duration - seconds))) + ' / ' + stamp(math.ceil(duration))
    return stamp(seconds, style == 'hours') + ' / ' + stamp(duration, style == 'hours')
