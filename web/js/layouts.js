// Layout geometry for the program output. Pure functions: given the output
// size, the people on stage and whether something is being presented, return
// the rectangle of every tile. Shared by the compositor worker and the UI.

export const LAYOUTS = [
  { id: 'solo', label: 'Solo', needs: 'any' },
  { id: 'grid', label: 'Grid', needs: 'cams' },
  { id: 'row', label: 'Side by side', needs: 'cams' },
  { id: 'leader', label: 'Leader', needs: 'cams' },
  { id: 'pip', label: 'Picture in picture', needs: 'screen' },
  { id: 'present', label: 'Presentation', needs: 'screen' },
  { id: 'cinema', label: 'Cinema', needs: 'screen' },
];

const PAD = 0.03; // outer margin, fraction of output height
const GAP = 0.015; // gap between tiles, fraction of output height

function rect(x, y, w, h) {
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// Best grid for n 16:9 tiles inside the area: tries every column count and
// keeps the one with the largest tile.
function grid(n, area, gap, aspect = 16 / 9) {
  if (n === 0) return [];
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (area.w - gap * (cols - 1)) / cols;
    let h = w / aspect;
    if (h * rows + gap * (rows - 1) > area.h) {
      h = (area.h - gap * (rows - 1)) / rows;
      w = h * aspect;
    }
    if (!best || w > best.w) best = { cols, rows, w, h };
  }
  const { cols, rows, w, h } = best;
  const out = [];
  const totalH = rows * h + (rows - 1) * gap;
  const y0 = area.y + (area.h - totalH) / 2;
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, n - r * cols);
    const rowW = inRow * w + (inRow - 1) * gap;
    const x0 = area.x + (area.w - rowW) / 2;
    for (let c = 0; c < inRow; c++) {
      out.push(rect(x0 + c * (w + gap), y0 + r * (h + gap), w, h));
    }
  }
  return out;
}

// Equal-width columns filling the height (tiles are cropped to fit).
function row(n, area, gap) {
  if (n === 0) return [];
  const w = (area.w - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => rect(area.x + i * (w + gap), area.y, w, area.h));
}

// Vertical stack of 16:9 tiles centered in a column.
function column(n, area, gap) {
  if (n === 0) return [];
  let h = Math.min((area.h - gap * (n - 1)) / n, area.w * 9 / 16);
  const w = h * 16 / 9;
  const total = n * h + (n - 1) * gap;
  const y0 = area.y + (area.h - total) / 2;
  const x = area.x + (area.w - w) / 2;
  return Array.from({ length: n }, (_, i) => rect(x, y0 + i * (h + gap), w, h));
}

/**
 * @param {string} layout one of LAYOUTS ids
 * @param {number} cams number of people on stage
 * @param {boolean} hasScreen whether a screen share or media clip is featured
 * @param {number} W output width
 * @param {number} H output height
 * @param {number} spacing multiplier for the outer margin and the gaps
 * @returns {{screen: object|null, cams: object[]}}
 */
export function computeLayout(layout, cams, hasScreen, W, H, spacing = 1) {
  const pad = H * PAD * spacing;
  const gap = H * GAP * spacing;
  const full = rect(0, 0, W, H);
  const inner = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad };
  let id = layout;
  const def = LAYOUTS.find((l) => l.id === id) || LAYOUTS[1];
  if (def.needs === 'screen' && !hasScreen) id = cams <= 1 ? 'solo' : 'grid';
  if (def.needs === 'cams' && hasScreen) id = 'present';

  switch (id) {
    case 'solo':
      if (hasScreen) return { screen: full, cams: [] };
      return { screen: null, cams: cams ? [full] : [] };
    case 'grid':
      return { screen: null, cams: grid(cams, inner, gap) };
    case 'row':
      return { screen: null, cams: cams <= 1 ? grid(cams, inner, gap) : row(cams, inner, gap) };
    case 'leader': {
      if (cams <= 1) return { screen: null, cams: grid(cams, inner, gap) };
      const mainW = inner.w * 0.72;
      const main = grid(1, { ...inner, w: mainW }, gap)[0];
      const side = column(cams - 1, { x: inner.x + mainW + gap, y: inner.y, w: inner.w - mainW - gap, h: inner.h }, gap);
      return { screen: null, cams: [main, ...side] };
    }
    case 'pip': {
      const w = W * 0.22;
      const h = w * 9 / 16;
      const tiles = [];
      for (let i = 0; i < cams; i++) {
        tiles.push(rect(W - pad - w, H - pad - h - i * (h + gap), w, h));
      }
      return { screen: full, cams: tiles };
    }
    case 'present': {
      if (cams === 0) return { screen: grid(1, inner, gap)[0], cams: [] };
      const sideW = inner.w * 0.24;
      const screenArea = { x: inner.x, y: inner.y, w: inner.w - sideW - gap, h: inner.h };
      const screen = grid(1, screenArea, gap)[0];
      const side = column(cams, { x: inner.x + inner.w - sideW, y: inner.y, w: sideW, h: inner.h }, gap);
      return { screen, cams: side };
    }
    case 'cinema': {
      if (cams === 0) return { screen: full, cams: [] };
      const stripH = H * 0.2;
      const screen = rect(0, 0, W, H - stripH);
      const tiles = grid(cams, { x: pad, y: H - stripH + gap, w: W - 2 * pad, h: stripH - gap - pad / 2 }, gap);
      return { screen, cams: tiles };
    }
    default:
      return { screen: null, cams: grid(cams, inner, gap) };
  }
}
