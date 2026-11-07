"""开发时生成程序图标；应用运行不需要 Pillow。"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
target = root / "src" / "VinylMV" / "Assets"
target.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8, 8, 248, 248), radius=58, fill="#bddc9c")
draw.ellipse((37, 37, 219, 219), fill="#243920")
for radius in range(54, 89, 7):
    draw.ellipse((128-radius, 128-radius, 128+radius, 128+radius), outline="#47603a", width=2)
draw.ellipse((88, 88, 168, 168), fill="#bddc9c")
draw.ellipse((116, 116, 140, 140), fill="#243920")
draw.arc((52, 52, 204, 204), 210, 245, fill="#e4f0d5", width=7)
draw.arc((52, 52, 204, 204), 30, 65, fill="#e4f0d5", width=7)
image.save(target / "app.ico", sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
