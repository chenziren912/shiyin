"""Word-aware lyric wrapping using the installed Windows font, without pip packages."""
import ctypes
import os
import re
import unicodedata


EAST_ASIAN = r"\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6\U0001f000-\U0001faff"
TOKENS = re.compile(r"\s+|[" + EAST_ASIAN + r"]|[^\s" + EAST_ASIAN + r"]+")


def wrap_words(text, maximum, measure):
    """Spaces and CJK characters are break opportunities; Latin words stay whole."""
    output = []
    for original in text.split("\n"):
        current, separator = "", ""
        for token in TOKENS.findall(original):
            if token.isspace():
                separator = " " if current else ""
                continue
            candidate = current + separator + token
            if current and measure(candidate) > maximum:
                output.append(current)
                current = token
            else:
                current = candidate
            separator = ""
        output.append(current)
    return "\n".join(output)


def wrap_lyric(text, limit=28):
    return wrap_words(text, limit, lambda value: sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in value))


class FontMeasure:
    """GDI measures the same Microsoft YaHei family selected in CSS and ASS."""
    def __enter__(self):
        self.gdi = None
        self.dc = None
        self.font = None
        self.original = None
        self.size = None
        if os.name == "nt":
            from ctypes import wintypes
            self.gdi = ctypes.WinDLL("gdi32", use_last_error=True)
            self.gdi.CreateCompatibleDC.argtypes = [wintypes.HDC]
            self.gdi.CreateCompatibleDC.restype = wintypes.HDC
            self.gdi.CreateFontW.argtypes = [ctypes.c_int] * 5 + [wintypes.DWORD] * 8 + [wintypes.LPCWSTR]
            self.gdi.CreateFontW.restype = wintypes.HANDLE
            self.gdi.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
            self.gdi.SelectObject.restype = wintypes.HANDLE
            self.gdi.DeleteObject.argtypes = [wintypes.HANDLE]
            self.gdi.DeleteDC.argtypes = [wintypes.HDC]
            self.gdi.GetTextExtentPoint32W.argtypes = [wintypes.HDC, wintypes.LPCWSTR, ctypes.c_int, ctypes.POINTER(wintypes.SIZE)]
            self.dc = self.gdi.CreateCompatibleDC(None)
            if not self.dc:
                raise RuntimeError("无法初始化歌词字体测量")
        return self

    def measure(self, text, size):
        if self.gdi is None:
            return sum(size * (1 if unicodedata.east_asian_width(c) in "WF" else .62) for c in text)
        pixel_size = max(1, round(size))
        if self.size != pixel_size:
            font = self.gdi.CreateFontW(-pixel_size, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 4, 0, "Microsoft YaHei")
            if not font:
                raise RuntimeError("无法加载歌词字体")
            previous = self.gdi.SelectObject(self.dc, font)
            if self.original is None:
                self.original = previous
            if self.font:
                self.gdi.DeleteObject(self.font)
            self.font, self.size = font, pixel_size
        from ctypes import wintypes
        extent = wintypes.SIZE()
        length = len(text.encode("utf-16-le")) // 2
        if not self.gdi.GetTextExtentPoint32W(self.dc, text, length, ctypes.byref(extent)):
            raise RuntimeError("无法测量歌词宽度")
        return extent.cx

    def __exit__(self, *_):
        if self.dc:
            if self.original:
                self.gdi.SelectObject(self.dc, self.original)
            if self.font:
                self.gdi.DeleteObject(self.font)
            self.gdi.DeleteDC(self.dc)


def fit_lyric(text, size, maximum, maximum_height, measure):
    # A little breathing room also covers small GDI/libass font metric differences.
    maximum *= .97
    maximum_lines = max(2, len(text.split("\n")))
    for _ in range(160):
        wrapped = wrap_words(text, maximum, lambda value: measure(value, size))
        lines = wrapped.split("\n")
        if (len(lines) <= maximum_lines and len(lines) * size * 1.4 <= maximum_height
                and all(measure(line, size) <= maximum for line in lines)):
            return wrapped, size
        size *= .94
    return wrapped, size
