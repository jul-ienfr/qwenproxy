/**
 * Programmatic RGBA icons for the desktop shell.
 *
 * The GUI must work from a plain npm install with no binary assets: the tray
 * icon and the window icon are drawn here as raw RGBA pixels, which is the
 * format expected by `@webviewjs/webview` (`{ data, width, height }`).
 *
 * Shapes are rendered at 4x and box-filtered down so 16 px tray icons still
 * have clean diagonal edges.
 */

export interface RgbaIcon {
  data: Buffer;
  width: number;
  height: number;
}

const SUPERSAMPLE = 4;

const BRAND = { r: 79, g: 70, b: 229 }; // indigo-600
const BRAND_DARK = { r: 49, g: 46, b: 129 }; // indigo-900
const WHITE = { r: 255, g: 255, b: 255 };

type Color = { r: number; g: number; b: number };

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

class RgbaCanvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  /** Source-over blend of one pixel. Coordinates outside the canvas are ignored. */
  blend(x: number, y: number, color: Color, alpha: number): void {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const srcA = Math.max(0, Math.min(1, alpha));
    if (srcA <= 0) return;

    const index = (py * this.width + px) * 4;
    const dstA = this.data[index + 3]! / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;

    this.data[index] = clampByte(
      (color.r * srcA + this.data[index]! * dstA * (1 - srcA)) / outA,
    );
    this.data[index + 1] = clampByte(
      (color.g * srcA + this.data[index + 1]! * dstA * (1 - srcA)) / outA,
    );
    this.data[index + 2] = clampByte(
      (color.b * srcA + this.data[index + 2]! * dstA * (1 - srcA)) / outA,
    );
    this.data[index + 3] = clampByte(outA * 255);
  }

  fillRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    color: Color,
    alpha = 1,
  ): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + width));
    const y1 = Math.min(this.height, Math.ceil(y + height));
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));

    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        const nearestX = Math.max(x + r, Math.min(cx, x + width - r));
        const nearestY = Math.max(y + r, Math.min(cy, y + height - r));
        const dx = cx - nearestX;
        const dy = cy - nearestY;
        if (dx * dx + dy * dy <= r * r) {
          this.blend(px, py, color, alpha);
        }
      }
    }
  }

  fillCircle(
    centerX: number,
    centerY: number,
    radius: number,
    color: Color,
    alpha = 1,
  ): void {
    const x0 = Math.max(0, Math.floor(centerX - radius - 1));
    const y0 = Math.max(0, Math.floor(centerY - radius - 1));
    const x1 = Math.min(this.width, Math.ceil(centerX + radius + 1));
    const y1 = Math.min(this.height, Math.ceil(centerY + radius + 1));

    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const dx = px + 0.5 - centerX;
        const dy = py + 0.5 - centerY;
        if (dx * dx + dy * dy <= radius * radius) {
          this.blend(px, py, color, alpha);
        }
      }
    }
  }

  /** Draws a thick line segment with round caps. */
  strokeSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    color: Color,
    alpha = 1,
  ): void {
    const radius = width / 2;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - radius - 1));
    const maxX = Math.min(this.width, Math.ceil(Math.max(x0, x1) + radius + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1));
    const maxY = Math.min(this.height, Math.ceil(Math.max(y0, y1) + radius + 1));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSq = dx * dx + dy * dy;

    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        const t =
          lengthSq === 0
            ? 0
            : Math.max(
                0,
                Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / lengthSq),
              );
        const projX = x0 + dx * t;
        const projY = y0 + dy * t;
        const ex = cx - projX;
        const ey = cy - projY;
        if (ex * ex + ey * ey <= radius * radius) {
          this.blend(px, py, color, alpha);
        }
      }
    }
  }
}

function downsample(source: RgbaCanvas, width: number, height: number): Buffer {
  const output = Buffer.alloc(width * height * 4);
  const scaleX = source.width / width;
  const scaleY = source.height / height;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startX = Math.floor(x * scaleX);
      const endX = Math.max(startX + 1, Math.floor((x + 1) * scaleX));
      const startY = Math.floor(y * scaleY);
      const endY = Math.max(startY + 1, Math.floor((y + 1) * scaleY));
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let samples = 0;

      for (let sy = startY; sy < endY && sy < source.height; sy += 1) {
        for (let sx = startX; sx < endX && sx < source.width; sx += 1) {
          const index = (sy * source.width + sx) * 4;
          const a = source.data[index + 3]! / 255;
          red += source.data[index]! * a;
          green += source.data[index + 1]! * a;
          blue += source.data[index + 2]! * a;
          alpha += a;
          samples += 1;
        }
      }

      const outIndex = (y * width + x) * 4;
      if (samples === 0 || alpha === 0) continue;
      output[outIndex] = clampByte(red / alpha);
      output[outIndex + 1] = clampByte(green / alpha);
      output[outIndex + 2] = clampByte(blue / alpha);
      output[outIndex + 3] = clampByte((alpha / samples) * 255);
    }
  }

  return output;
}

/**
 * Draws the QwenProxy mark: an indigo rounded square, a white ring and a short
 * diagonal tail (a "Q"), plus a small darker corner for depth.
 */
export function createIcon(size = 32): RgbaIcon {
  const safeSize = Math.max(8, Math.round(size));
  const canvas = new RgbaCanvas(safeSize * SUPERSAMPLE, safeSize * SUPERSAMPLE);
  const s = safeSize * SUPERSAMPLE;

  const padding = s * 0.055;
  const backgroundSize = s - padding * 2;
  canvas.fillRoundedRect(
    padding,
    padding,
    backgroundSize,
    backgroundSize,
    backgroundSize * 0.24,
    BRAND,
  );

  // Subtle bottom shadow band keeps the icon readable on light taskbars.
  canvas.fillRoundedRect(
    padding + backgroundSize * 0.1,
    padding + backgroundSize * 0.68,
    backgroundSize * 0.8,
    backgroundSize * 0.2,
    backgroundSize * 0.1,
    BRAND_DARK,
    0.35,
  );

  const centerX = s * 0.5;
  const centerY = s * 0.47;
  const outerRadius = s * 0.265;
  const ringWidth = s * 0.105;

  canvas.fillCircle(centerX, centerY, outerRadius, WHITE);
  canvas.fillCircle(
    centerX,
    centerY,
    Math.max(0, outerRadius - ringWidth),
    BRAND,
  );

  const tailStart = outerRadius * 0.55;
  canvas.strokeSegment(
    centerX + tailStart,
    centerY + tailStart,
    s * 0.76,
    s * 0.76,
    ringWidth,
    WHITE,
  );

  return {
    data: downsample(canvas, safeSize, safeSize),
    width: safeSize,
    height: safeSize,
  };
}

/** Windows taskbar icons look best at 32 px; the window icon at 64 px. */
export function createTrayIcon(): RgbaIcon {
  return createIcon(32);
}

export function createWindowIcon(): RgbaIcon {
  return createIcon(64);
}
