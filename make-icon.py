"""生成 dsh-github 的插件图标（256×256 PNG）：深色底 + 白色 git 分支图形。"""
from PIL import Image, ImageDraw

S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 深色渐变底
grad = Image.new("RGB", (S, S), (36, 41, 47))
d = ImageDraw.Draw(grad)
for i in range(S * 2):
    t = i / (S * 2 - 1)
    r = int(36 + (13 - 36) * t)
    g = int(41 + (17 - 41) * t)
    b = int(47 + (23 - 47) * t)
    d.line([(0, i), (i, 0)], fill=(r, g, b), width=1)

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=56, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
W = 12
WHITE = (255, 255, 255)

# 主干：左上节点 → 下方节点
d.line([(96, 76), (96, 180)], fill=WHITE, width=W)
# 分支：从主干中部弯向右侧节点
d.line([(96, 122), (150, 150)], fill=WHITE, width=W)
d.line([(150, 150), (150, 180)], fill=WHITE, width=W)

# 三个节点
for (cx, cy) in [(96, 66), (96, 190), (150, 190)]:
    d.ellipse([cx - 21, cy - 21, cx + 21, cy + 21], fill=WHITE)
    d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=(36, 41, 47))

img.save(r"C:\Users\Administrator\Documents\deepseek-harness\default-workspace\plugins\dsh-github\docs\icon.png", "PNG")
print("ok", img.size)
