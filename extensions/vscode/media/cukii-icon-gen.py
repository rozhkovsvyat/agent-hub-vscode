import math
from pathlib import Path

W = H = 64
CX = CY = 32.0
BASE_R = 25.0
N = 64

BITE_CIRCLES = [
    (49.5, 14.0, 10.0),
    (38.5, 8.5, 6.0),
]

CRUMBS = [
    (22.0, 26.0, 2.70),
    (35.5, 40.0, 3.20),
    (23.0, 42.5, 2.95),
]

TARGET_DEVIATION_PCT = 4.25
roughness_scale = 1.0

def waveform(theta):
    return (
        0.0100 * math.sin(7.0 * theta + 0.31)
        + 0.0070 * math.sin(11.0 * theta - 0.74)
        + 0.0050 * math.sin(13.0 * theta + 1.18)
        + 0.0040 * math.sin(17.0 * theta - 0.42)
    )

def radius(theta):
    angle_deg = math.degrees(theta) % 360.0
    variation = roughness_scale * waveform(theta)

    # Сохраняем прежнее ограничение на внешнее разрастание силуэта.
    outward_limit = 0.0275
    if 135.0 <= angle_deg <= 225.0:
        outward_limit = 0.0225

    return BASE_R * (1.0 + min(variation, outward_limit))

def point_at(theta):
    r = radius(theta)
    return (CX + r * math.cos(theta), CY + r * math.sin(theta))

def cubic_segments(pts):
    segments = []
    count = len(pts)
    for i in range(count):
        p0 = pts[(i - 1) % count]
        p1 = pts[i]
        p2 = pts[(i + 1) % count]
        p3 = pts[(i + 2) % count]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6.0, p1[1] + (p2[1] - p0[1]) / 6.0)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6.0, p2[1] - (p3[1] - p1[1]) / 6.0)
        segments.append((p1, c1, c2, p2))
    return segments

def bezier(p0, p1, p2, p3, t):
    u = 1.0 - t
    return (
        u**3 * p0[0] + 3.0 * u**2 * t * p1[0] + 3.0 * u * t**2 * p2[0] + t**3 * p3[0],
        u**3 * p0[1] + 3.0 * u**2 * t * p1[1] + 3.0 * u * t**2 * p2[1] + t**3 * p3[1],
    )

def build_outline(samples_per_segment=64):
    points = [point_at(2.0 * math.pi * i / N) for i in range(N)]
    segments = cubic_segments(points)
    boundary_samples = [
        bezier(*segment, j / samples_per_segment)
        for segment in segments
        for j in range(samples_per_segment + 1)
    ]
    return points, segments, boundary_samples

for _ in range(10):
    points, segments, boundary_samples = build_outline()
    max_deviation_pct = max(
        abs(math.hypot(x - CX, y - CY) - BASE_R) / BASE_R * 100.0
        for x, y in boundary_samples
    )
    roughness_scale *= TARGET_DEVIATION_PCT / max_deviation_pct

points, segments, boundary_samples = build_outline()
validation_points, _, validation_samples = build_outline(samples_per_segment=256)

def fmt(v):
    return f"{v:.4f}".rstrip("0").rstrip(".")

path_parts = [f"M {fmt(points[0][0])} {fmt(points[0][1])}"]
for _, c1, c2, end in segments:
    path_parts.append(
        f"C {fmt(c1[0])} {fmt(c1[1])} {fmt(c2[0])} {fmt(c2[1])} {fmt(end[0])} {fmt(end[1])}"
    )
path_parts.append("Z")
COOKIE_PATH = " ".join(path_parts)

radii = [math.hypot(x - CX, y - CY) for x, y in boundary_samples]
max_deviation_pct = max(abs(r - BASE_R) / BASE_R * 100.0 for r in radii)

sector_max = [0.0, 0.0, 0.0, 0.0]
for x, y in boundary_samples:
    angle = math.degrees(math.atan2(y - CY, x - CX)) % 360.0
    sector = int(angle // 90.0) % 4
    sector_max[sector] = max(sector_max[sector], math.hypot(x - CX, y - CY))

lower_left_max = max(
    math.hypot(x - CX, y - CY)
    for x, y in boundary_samples
    if 135.0 <= (math.degrees(math.atan2(y - CY, x - CX)) % 360.0) <= 225.0
)
lower_left_excess_pct = (lower_left_max - BASE_R) / BASE_R * 100.0

def is_right_edge_below_bite(x, y):
    angle = math.degrees(math.atan2(y - CY, x - CX))
    return -20.0 <= angle <= 60.0

right_edge_cut = 0.0
for x, y in validation_samples:
    if not is_right_edge_below_bite(x, y):
        continue
    for bx, by, br in BITE_CIRCLES:
        penetration = br - math.hypot(x - bx, y - by)
        right_edge_cut = max(right_edge_cut, penetration)

assert 4.0 <= max_deviation_pct <= 4.5
assert all((r - BASE_R) / BASE_R <= 0.03 for r in sector_max)
assert lower_left_excess_pct <= 3.0
assert right_edge_cut <= 1e-6

for x, y, r in CRUMBS:
    clearance = min(math.hypot(x - bx, y - by) for bx, by in boundary_samples) - r
    assert clearance >= 4.0, (x, y, r, clearance)

for i, (x1, y1, r1) in enumerate(CRUMBS):
    for x2, y2, r2 in CRUMBS[i + 1:]:
        edge_gap = math.hypot(x2 - x1, y2 - y1) - r1 - r2
        assert edge_gap >= 3.0, (edge_gap,)

bx1, by1, br1 = BITE_CIRCLES[0]
bx2, by2, br2 = BITE_CIRCLES[1]
bite_distance = math.hypot(bx2 - bx1, by2 - by1)

assert abs(br1 - br2) < bite_distance < br1 + br2
assert br1 + br2 - bite_distance >= 1.0
assert sum(math.pi * r * r for _, _, r in BITE_CIRCLES) < math.pi * BASE_R * BASE_R * 0.25

for x, y, r in BITE_CIRCLES:
    assert 0 < x - r and x + r < W and 0 < y - r and y + r < H
    assert abs(math.hypot(x - CX, y - CY) - BASE_R) < r

bite_mask_circles = "\n".join(
    f'    <circle cx="{fmt(x)}" cy="{fmt(y)}" r="{fmt(r)}" fill="black"/>'
    for x, y, r in BITE_CIRCLES
)
color_crumb_circles = "\n".join(
    f'  <circle cx="{fmt(x)}" cy="{fmt(y)}" r="{fmt(r)}" fill="#5C3A28"/>'
    for x, y, r in CRUMBS
)
mono_crumb_circles = "\n".join(
    f'    <circle cx="{fmt(x)}" cy="{fmt(y)}" r="{fmt(r * 1.4)}" fill="black"/>'
    for x, y, r in CRUMBS
)

color_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <mask id="bite-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="white"/>
{bite_mask_circles}
    </mask>
  </defs>
  <rect width="64" height="64" rx="14" fill="#F4EDE4"/>
  <path d="{COOKIE_PATH}" fill="#E3A867" stroke="#C9873F" stroke-width="3" stroke-linejoin="round" mask="url(#bite-mask)"/>
{color_crumb_circles}
</svg>
'''

mono_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <mask id="cutout-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="white"/>
{bite_mask_circles}
{mono_crumb_circles}
    </mask>
  </defs>
  <path d="{COOKIE_PATH}" fill="currentColor" mask="url(#cutout-mask)"/>
</svg>
'''

Path("out-color.svg").write_text(color_svg, encoding="utf-8")
Path("out-mono.svg").write_text(mono_svg, encoding="utf-8")

# --- Аутлайн-версии ------------------------------------------------------
# Штриховой вариант нельзя получить маской: маска обрезает и сам штрих, поэтому
# по кромке укуса линия исчезает и печенька выглядит недорисованной. Нужна
# настоящая граница фигуры «тело минус два круга укуса».
#
# Булево вычитание не понадобилось: центры обоих кругов укуса лежат практически
# на контуре (|B-C| = 25.1 и 24.4 при BASE_R = 25), поэтому область остаётся
# звёздчато-выпуклой — луч из центра пересекает границу ровно один раз. Радиус
# границы считается точно: min(радиус тела, ближайшее пересечение с укусом).


def outline_radius(theta):
    r = radius(theta)
    ux, uy = math.cos(theta), math.sin(theta)
    for bx, by, br in BITE_CIRCLES:
        dx, dy = bx - CX, by - CY
        d = ux * dx + uy * dy
        disc = d * d - (dx * dx + dy * dy - br * br)
        if disc <= 0.0:
            continue
        near = d - math.sqrt(disc)
        if 0.0 < near < r:
            r = near
    return r


def _perp_distance(px, py, ax, ay, bx, by):
    seg = math.hypot(bx - ax, by - ay)
    if seg == 0.0:
        return math.hypot(px - ax, py - ay)
    return abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / seg


def rdp(points, tol):
    """Дуглас–Пекер. Прореживание по соседним тройкам тут не годится: оно
    съедает шероховатость и превращает контур в многоугольник."""
    if len(points) < 3:
        return list(points)
    ax, ay = points[0]
    bx, by = points[-1]
    worst_index, worst_distance = 0, -1.0
    for i in range(1, len(points) - 1):
        distance = _perp_distance(points[i][0], points[i][1], ax, ay, bx, by)
        if distance > worst_distance:
            worst_index, worst_distance = i, distance
    if worst_distance <= tol:
        return [points[0], points[-1]]
    return rdp(points[: worst_index + 1], tol)[:-1] + rdp(points[worst_index:], tol)


OUTLINE_SAMPLES = 1440
outline_points = [
    (
        CX + outline_radius(2.0 * math.pi * i / OUTLINE_SAMPLES) * math.cos(2.0 * math.pi * i / OUTLINE_SAMPLES),
        CY + outline_radius(2.0 * math.pi * i / OUTLINE_SAMPLES) * math.sin(2.0 * math.pi * i / OUTLINE_SAMPLES),
    )
    for i in range(OUTLINE_SAMPLES)
]
outline_poly = rdp(outline_points + [outline_points[0]], 0.035)[:-1]
OUTLINE_PATH = (
    "M " + " L ".join(f"{fmt(x)} {fmt(y)}" for x, y in outline_poly) + " Z"
)

# Укус обязан быть вырезан из контура, а не нарисован поверх него.
for x, y in outline_poly:
    for bx, by, br in BITE_CIRCLES:
        assert math.hypot(x - bx, y - by) >= br - 0.15, (x, y)

outline_crumbs_mono = "\n".join(
    f'  <circle cx="{fmt(x)}" cy="{fmt(y)}" r="{fmt(r * 0.85)}" fill="currentColor"/>'
    for x, y, r in CRUMBS
)
outline_crumbs_color = "\n".join(
    f'  <circle cx="{fmt(x)}" cy="{fmt(y)}" r="{fmt(r * 0.85)}" fill="#C9873F"/>'
    for x, y, r in CRUMBS
)

# Штрих 4, а не тоньше: на 24px (размер activity bar) 2.75 уже теряется.
outline_mono_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="{OUTLINE_PATH}" fill="none" stroke="currentColor" stroke-width="4"
        stroke-linejoin="round" stroke-linecap="round"/>
{outline_crumbs_mono}
</svg>
'''

# Лёгкая заливка тела: чистый контур на 16px вырождается в тонкое кольцо.
outline_color_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#F4EDE4"/>
  <path d="{OUTLINE_PATH}" fill="#F7E3CB" stroke="#C9873F" stroke-width="4"
        stroke-linejoin="round" stroke-linecap="round"/>
{outline_crumbs_color}
</svg>
'''

Path("out-outline-mono.svg").write_text(outline_mono_svg, encoding="utf-8")
Path("out-outline-color.svg").write_text(outline_color_svg, encoding="utf-8")
print(f"Аутлайн: точек контура {len(outline_poly)} из {OUTLINE_SAMPLES}")

print(f"Максимальное отклонение радиуса: {max_deviation_pct:.3f}%")
print(
    "Максимальные радиусы по секторам 0–90, 90–180, 180–270, 270–360:",
    ", ".join(f"{r:.3f}" for r in sector_max),
)
print(
    f"Левый нижний сектор (135–225): max r={lower_left_max:.3f}, "
    f"превышение={lower_left_excess_pct:.3f}%"
)
print(f"Максимальный вырез по правому краю ниже укуса: {right_edge_cut:.3f}")
print("Укус:", ", ".join(f"({x:g}, {y:g}), r={r:g}" for x, y, r in BITE_CIRCLES))
print("Крошки:", ", ".join(f"({x:g}, {y:g}), r={r:g}" for x, y, r in CRUMBS))
print("Проверки пройдены.")