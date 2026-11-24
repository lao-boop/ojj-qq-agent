"""Check the upper outline of a side-view animal in a flat-color illustration."""
import io
import statistics
import sys

from PIL import Image


def contour(image, scarf):
    image = image.convert("RGB")
    image.thumbnail((320, 320))
    width, height = image.size
    if min(width, height) < 32:
        return "inconclusive"
    pixels = image.load()
    border = [pixels[x, y] for x in range(0, width, 3) for y in (0, height - 1)]
    bg = tuple(statistics.median(c) for c in zip(*border))

    def distance(a, b):
        return sum((v - w) ** 2 for v, w in zip(a, b))

    if sum(distance(p, bg) < 40**2 for p in border) < len(border) * .85:
        return "inconclusive"
    if distance(bg, scarf) < 100**2:
        return "inconclusive"
    colored = 0
    consecutive = longest = 0
    for x in range(width):
        top = None
        touches = False
        for y in range(height):
            pixel = pixels[x, y]
            if top is None and distance(pixel, bg) > 55**2:
                top = y
            if distance(pixel, scarf) < 88**2 and distance(pixel, bg) > 90**2:
                colored += 1
                if top is not None and y - top <= 2:
                    touches = True
        consecutive = consecutive + 1 if touches else 0
        longest = max(consecutive, longest)
    if colored < max(25, width * height * .001):
        return "inconclusive"
    return "touches" if longest >= max(3, round(width * .01)) else "below"


if __name__ == "__main__":
    scarf = bytes.fromhex(sys.argv[1].removeprefix("#"))
    with Image.open(io.BytesIO(sys.stdin.buffer.read())) as image:
        print(contour(image, scarf))
