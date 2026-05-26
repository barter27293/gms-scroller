// Build the Windows icon (.ico) for GMS Scroller.
//
// Default behaviour (`npm run build:icon`):
//   - Read existing build/icon.png and convert to build/icon.ico.
//   - Never overwrites your build/icon.png — drop in your own artwork and
//     re-run this script to regenerate the .ico.
//
// Placeholder mode (`npm run build:icon:placeholder` or `node scripts/make-icon.js --generate`):
//   - (Re)generates the procedural placeholder build/icon.png AND the .ico.
//     Use this only if you want to recreate the default placeholder.
//
// Pure-JS — uses pngjs + png-to-ico, no native deps.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pngToIco = require('png-to-ico').default;

const BUILD_DIR = path.join(__dirname, '..', 'build');
const PNG_PATH = path.join(BUILD_DIR, 'icon.png');
const ICO_PATH = path.join(BUILD_DIR, 'icon.ico');

const SIZE = 512;
const RADIUS = 96;
const BG = [13, 79, 92, 255];      // dark teal
const FG = [255, 255, 255, 255];   // white

function setPx(png, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function fillRoundedSquare(png, w, h, radius, color) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = true;
      const corners = [
        [radius, radius],
        [w - radius - 1, radius],
        [radius, h - radius - 1],
        [w - radius - 1, h - radius - 1],
      ];
      for (const [cx, cy] of corners) {
        const inCornerBox =
          (x < radius && y < radius && cx === radius && cy === radius) ||
          (x >= w - radius && y < radius && cx === w - radius - 1 && cy === radius) ||
          (x < radius && y >= h - radius && cx === radius && cy === h - radius - 1) ||
          (x >= w - radius && y >= h - radius && cx === w - radius - 1 && cy === h - radius - 1);
        if (inCornerBox) {
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy > radius * radius) inside = false;
        }
      }
      if (inside) setPx(png, x, y, color);
    }
  }
}

function fillTriangle(png, ax, ay, bx, by, cx, cy, color) {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(png.width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(png.height - 1, Math.ceil(Math.max(ay, by, cy)));
  const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denom;
      const w2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denom;
      const w3 = 1 - w1 - w2;
      if (w1 >= 0 && w2 >= 0 && w3 >= 0) setPx(png, x, y, color);
    }
  }
}

function fillRect(png, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setPx(png, x, y, color);
  }
}

async function writePlaceholderPng() {
  const png = new PNG({ width: SIZE, height: SIZE, colorType: 6 });
  for (let i = 0; i < png.data.length; i += 4) png.data[i + 3] = 0;

  fillRoundedSquare(png, SIZE, SIZE, RADIUS, BG);

  const cx = SIZE / 2;
  const cy = SIZE * 0.42;
  const triH = 200;
  const triW = triH * 0.92;
  fillTriangle(
    png,
    cx - triW / 2, cy - triH / 2,
    cx - triW / 2, cy + triH / 2,
    cx + triW / 2, cy,
    FG
  );

  const lineX = SIZE * 0.22;
  const lineW = SIZE * 0.56;
  const lineH = 22;
  const lineGap = 30;
  const lineYStart = SIZE * 0.72;
  for (let i = 0; i < 3; i++) {
    const w = lineW * (i === 2 ? 0.65 : 1);
    fillRect(png, Math.round(lineX), Math.round(lineYStart + i * (lineH + lineGap)), Math.round(w), lineH, FG);
  }

  await new Promise((resolve, reject) => {
    png.pack().pipe(fs.createWriteStream(PNG_PATH))
      .on('finish', resolve)
      .on('error', reject);
  });
  console.log(`Wrote placeholder ${PNG_PATH}`);
}

async function convertPngToIco() {
  if (!fs.existsSync(PNG_PATH)) {
    throw new Error(
      `Missing source ${PNG_PATH}. Drop your own icon.png there, or run` +
      ` 'npm run build:icon:placeholder' to regenerate the default.`
    );
  }
  const icoBuf = await pngToIco([PNG_PATH]);
  fs.writeFileSync(ICO_PATH, icoBuf);
  console.log(`Wrote ${ICO_PATH}`);
}

async function main() {
  if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

  const generate = process.argv.includes('--generate');
  if (generate) {
    await writePlaceholderPng();
  } else {
    console.log(`Using existing ${PNG_PATH} as source (pass --generate to recreate the placeholder).`);
  }
  await convertPngToIco();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
