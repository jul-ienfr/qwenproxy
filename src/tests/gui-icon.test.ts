import test from "node:test";
import assert from "node:assert/strict";
import {
  createIcon,
  createTrayIcon,
  createWindowIcon,
  type RgbaIcon,
} from "../gui/icon.ts";

function pixel(icon: RgbaIcon, x: number, y: number) {
  const index = (y * icon.width + x) * 4;
  return {
    r: icon.data[index]!,
    g: icon.data[index + 1]!,
    b: icon.data[index + 2]!,
    a: icon.data[index + 3]!,
  };
}

function hasPixel(icon: RgbaIcon, predicate: (p: ReturnType<typeof pixel>) => boolean): boolean {
  for (let y = 0; y < icon.height; y += 1) {
    for (let x = 0; x < icon.width; x += 1) {
      if (predicate(pixel(icon, x, y))) return true;
    }
  }
  return false;
}

test("GUI icon: renders an RGBA buffer with the requested dimensions", () => {
  for (const size of [16, 32, 64]) {
    const icon = createIcon(size);
    assert.equal(icon.width, size);
    assert.equal(icon.height, size);
    assert.equal(icon.data.length, size * size * 4);
    assert.ok(Buffer.isBuffer(icon.data));
  }
});

test("GUI icon: corners are transparent and the mark is opaque", () => {
  const icon = createIcon(32);
  assert.equal(pixel(icon, 0, 0).a, 0);
  assert.equal(pixel(icon, 31, 0).a, 0);
  assert.equal(pixel(icon, 0, 31).a, 0);
  assert.equal(pixel(icon, 31, 31).a, 0);

  assert.ok(
    hasPixel(icon, (p) => p.a > 200 && p.r > 230 && p.g > 230 && p.b > 230),
    "expected a white mark",
  );
  assert.ok(
    hasPixel(icon, (p) => p.a > 200 && p.b > p.r && p.b > 180),
    "expected a saturated indigo background",
  );
});

test("GUI icon: tray and window helpers use sensible default sizes", () => {
  const tray = createTrayIcon();
  const window = createWindowIcon();
  assert.equal(tray.width, 32);
  assert.equal(window.width, 64);
  assert.ok(tray.data.length > 0);
  assert.ok(window.data.length > 0);
});

test("GUI icon: output is deterministic", () => {
  assert.deepEqual(createIcon(24).data, createIcon(24).data);
});

test("GUI icon: minimum size is clamped without breaking the buffer", () => {
  const icon = createIcon(1);
  assert.equal(icon.width, 8);
  assert.equal(icon.data.length, 8 * 8 * 4);
});
