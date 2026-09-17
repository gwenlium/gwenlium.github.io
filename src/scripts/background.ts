type BackgroundMode = 'dots' | 'polygons' | 'circuits' | 'checker' | 'wave' | 'off';
type Circuit = { points: Float32Array; distances: Float32Array; length: number };

const modes: Record<string, BackgroundMode | undefined> = {
  dots: 'dots', polygons: 'polygons', circuits: 'circuits', checker: 'checker', wave: 'wave', off: 'off',
};
const root = document.documentElement;
const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
const forcedColors = matchMedia('(forced-colors: active)');
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
const viewports: BackgroundViewport[] = [];
const frameInterval = 1000 / 30;
const tau = Math.PI * 2;
let mode: BackgroundMode = 'off';
let reduced = true;
let ink = '';
let line = '';
let accent = '';
let tint = '';
let frame = 0;
let lastFrame = 0;
let elapsed = 18;
let parallaxY = 0;
let activeWindow: HTMLElement | null = null;
let scrollSource: HTMLElement | null = null;
const scrollResizeObserver = new ResizeObserver(() => updateParallax());

function polygonEdgeDistance(sides: number, radius: number, rotation: number, direction: number): number {
  const sector = tau / sides;
  let offset = direction - rotation - Math.PI / sides;
  offset -= Math.round(offset / sector) * sector;
  return radius * Math.cos(Math.PI / sides) / Math.cos(offset);
}

// One clock and one RAF; navigation never restarts the desktop renderer.
class BackgroundViewport {
  width = 0;
  height = 0;
  visible = true;
  private ratio = 1;
  private geometry = new Float32Array(0);
  private waveColumns = 0;
  private waveRows = 0;
  private wavePoints = new Float32Array(0);
  private circuits: Circuit[] = [];
  private traces = new Path2D();
  private terminals = new Path2D();
  private polygonLines = new Path2D();
  private checker: CanvasPattern | null = null;
  private readonly resizeObserver: ResizeObserver;

  constructor(readonly canvas: HTMLCanvasElement, private readonly context: CanvasRenderingContext2D) {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    visibility.observe(canvas);
    this.resize();
  }

  resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.round(bounds.width);
    const height = Math.round(bounds.height);
    // Bound pixel memory as well as DPR, including ultrawide / high-density screens.
    const ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(2_400_000 / Math.max(1, width * height)));
    if (width !== this.width || height !== this.height || ratio !== this.ratio) {
      this.width = width;
      this.height = height;
      this.ratio = ratio;
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.rebuild();
    }
    // Static modes also need repainting on resize and when a page becomes visible again.
    this.draw(reduced ? 18 : elapsed);
    schedule();
  }

  rebuild(): void {
    if (!this.width || !this.height || mode === 'off') return;
    const { width, height } = this;
    const values: number[] = [];
    this.circuits = [];
    this.traces = new Path2D();
    this.terminals = new Path2D();
    this.polygonLines = new Path2D();
    this.checker = null;

    if (mode === 'checker') {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 48;
      const ctx = tile.getContext('2d');
      if (ctx) {
        ctx.fillStyle = tint;
        ctx.globalAlpha = .2;
        ctx.fillRect(0, 0, 24, 24);
        ctx.fillRect(24, 24, 24, 24);
        // Bake the glow into the repeated tile, including neighboring edges so it stays seamless.
        ctx.strokeStyle = accent;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 8;
        ctx.globalAlpha = .6;
        ctx.beginPath();
        for (let offset = -23.5; offset <= 72.5; offset += 24) {
          ctx.moveTo(offset, -24);
          ctx.lineTo(offset, 72);
          ctx.moveTo(-24, offset);
          ctx.lineTo(72, offset);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = .35;
        ctx.stroke();
        this.checker = this.context.createPattern(tile, 'repeat');
      }
      return;
    }

    if (mode === 'dots') {
      const spacing = Math.max(37, Math.sqrt(width * (height + 128) / 1250), Math.max(width, height + 128) / 40);
      const columns = Math.ceil(width / spacing);
      const rows = Math.ceil((height + 128) / spacing);
      const left = (width - (columns - 1) * spacing) / 2;
      const top = (height - (rows - 1) * spacing) / 2;
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const x = left + column * spacing;
          const y = top + row * spacing;
          values.push(x, y, Math.hypot(x - width * .72, y - height * .36) / spacing,
            Math.hypot(x - width * .14, y - height * .88) / spacing);
        }
      }
    } else if (mode === 'polygons') {
      const spacing = Math.max(104, Math.sqrt(width * height / 150), Math.max(width, height) / 16);
      const padding = Math.max(width, height) * .09 + spacing + 48;
      const columns = Math.ceil((width + padding * 2) / spacing);
      const rows = Math.ceil((height + padding * 2) / spacing);
      const edges = new Float32Array(rows * columns * 4);
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const x = column * spacing - width / 2 - padding;
          const y = row * spacing - height / 2 - padding;
          const sides = 3 + Math.floor(Math.random() * 4);
          const rotation = sides % 2 ? -Math.PI / 2 : Math.PI / sides;
          const radius = spacing * .44;
          const cell = (row * columns + column) * 4;
          edges[cell] = x + polygonEdgeDistance(sides, radius, rotation, 0);
          edges[cell + 1] = x - polygonEdgeDistance(sides, radius, rotation, Math.PI);
          edges[cell + 2] = y + polygonEdgeDistance(sides, radius, rotation, Math.PI / 2);
          edges[cell + 3] = y - polygonEdgeDistance(sides, radius, rotation, Math.PI * 1.5);
          if (column > 0) {
            this.polygonLines.moveTo(edges[cell - 4], y);
            this.polygonLines.lineTo(edges[cell + 1], y);
          }
          if (row > 0) {
            this.polygonLines.moveTo(x, edges[cell - columns * 4 + 2]);
            this.polygonLines.lineTo(x, edges[cell + 3]);
          }
          for (let vertex = 0; vertex < 6; vertex++) {
            if (vertex >= sides) { values.push(0, 0); continue; }
            const angle = rotation + vertex * tau / sides;
            values.push(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
          }
          values.push(sides, Math.random() * tau, Math.floor(Math.random() * 9), (row + column) % 4 === 0 ? 1 : 0);
        }
      }
    } else if (mode === 'wave') {
      const spacing = Math.max(44, Math.sqrt(width * (height + 256) / 1000));
      this.waveColumns = Math.ceil((width + 256) / spacing) + 1;
      this.waveRows = Math.ceil((height + 256) / spacing) + 1;
      for (let row = 0; row < this.waveRows; row++) {
        for (let column = 0; column < this.waveColumns; column++) {
          values.push(column * spacing - 128, row * spacing - 128);
        }
      }
      this.wavePoints = new Float32Array(values.length);
    } else {
      const count = Math.min(24, Math.max(8, Math.round(height / 55)));
      const cell = 38;
      for (let index = 0; index < count; index++) {
        const reverse = index % 2 === 1;
        const startY = -64 + (index + .5) * (height + 128) / count;
        const bendY = startY + (index % 3 - 1) * cell * 2;
        const endY = bendY + (reverse ? -cell : cell);
        const bendX = Math.round((width * (.16 + (index % 4) * .07)) / cell) * cell;
        const endX = Math.round((width * (.52 + (index % 5) * .065)) / cell) * cell;
        const points = new Float32Array([-cell, startY, bendX, startY, bendX, bendY, endX, bendY, endX, endY, endX + cell * 2, endY]);
        const distances = new Float32Array(6);
        if (reverse) {
          for (let point = 0; point < points.length; point += 2) points[point] = width - points[point];
        }
        this.traces.moveTo(points[0], points[1]);
        for (let point = 1; point < 6; point++) {
          const offset = point * 2;
          distances[point] = distances[point - 1] + Math.abs(points[offset] - points[offset - 2]) + Math.abs(points[offset + 1] - points[offset - 1]);
          this.traces.lineTo(points[offset], points[offset + 1]);
        }
        this.terminals.moveTo(points[10] + 3, points[11]);
        this.terminals.arc(points[10], points[11], 3, 0, tau);
        this.circuits.push({ points, distances, length: distances[5] });
      }
    }
    this.geometry = new Float32Array(values);
  }

  draw(time: number): void {
    if (!this.width || !this.height || !this.visible || mode === 'off' || forcedColors.matches) return;
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    ctx.translate(0, parallaxY);
    if (mode === 'dots') this.drawDots(time);
    else if (mode === 'polygons') this.drawPolygons(time);
    else if (mode === 'circuits') this.drawCircuits(time);
    else if (mode === 'wave') this.drawWave(time);
    else if (this.checker) {
      ctx.fillStyle = this.checker;
      ctx.fillRect(0, -64, this.width, this.height + 128);
    }
    ctx.restore();
  }

  private drawDots(time: number): void {
    const ctx = this.context;
    const points = this.geometry;
    ctx.fillStyle = ink;
    for (let index = 0; index < points.length; index += 4) {
      const wave = (.5 + .5 * Math.sin(points[index + 2] * .58 - time * .8))
        * (.72 + .28 * Math.sin(points[index + 3] * .36 + time * .32));
      const radius = .65 + 2.65 * wave * wave;
      ctx.globalAlpha = .18 + wave * .47;
      ctx.beginPath();
      ctx.arc(points[index], points[index + 1], radius, 0, tau);
      ctx.fill();
    }
  }

  private drawPolygons(time: number): void {
    const ctx = this.context;
    const polygons = this.geometry;
    ctx.save();
    ctx.translate(this.width / 2 + Math.sin(time * .065) * 22, this.height / 2 + Math.cos(time * .055) * 17);
    ctx.rotate(Math.sin(time * .035) * .065);
    ctx.lineWidth = .9;
    ctx.strokeStyle = line;
    ctx.globalAlpha = .18;
    ctx.stroke(this.polygonLines);
    ctx.strokeStyle = ink;
    for (let index = 0; index < polygons.length; index += 16) {
      const fade = .5 + .5 * Math.sin(polygons[index + 13] + time * .3);
      const sides = polygons[index + 12];
      ctx.shadowColor = polygons[index + 14] % 2 === 0 ? accent : tint;
      ctx.shadowBlur = polygons[index + 15] ? 12 + fade * 8 : 0;
      ctx.beginPath();
      ctx.moveTo(polygons[index], polygons[index + 1]);
      for (let vertex = 1; vertex < sides; vertex++) {
        ctx.lineTo(polygons[index + vertex * 2], polygons[index + vertex * 2 + 1]);
      }
      ctx.closePath();
      if (polygons[index + 14] < 2) {
        ctx.fillStyle = polygons[index + 14] === 0 ? accent : tint;
        ctx.globalAlpha = fade * .13;
        ctx.fill();
      }
      ctx.globalAlpha = polygons[index + 15] ? .3 + fade * .3 : .035 + fade * .22;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawWave(time: number): void {
    const ctx = this.context;
    const projected = this.wavePoints;
    for (let index = 0; index < this.geometry.length; index += 2) {
      const x = this.geometry[index];
      const y = this.geometry[index + 1];
      projected[index] = x + Math.sin(y * .018 + time * .35) * 12;
      projected[index + 1] = y + Math.sin(x * .012 + time * .5) * 20 + Math.cos(y * .017 - time * .35) * 10;
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = .9;
    ctx.globalAlpha = .3;
    ctx.beginPath();
    for (let row = 0; row < this.waveRows; row++) {
      let point = row * this.waveColumns * 2;
      ctx.moveTo(projected[point], projected[point + 1]);
      for (let column = 1; column < this.waveColumns; column++) {
        point += 2;
        ctx.lineTo(projected[point], projected[point + 1]);
      }
    }
    for (let column = 0; column < this.waveColumns; column++) {
      let point = column * 2;
      ctx.moveTo(projected[point], projected[point + 1]);
      for (let row = 1; row < this.waveRows; row++) {
        point += this.waveColumns * 2;
        ctx.lineTo(projected[point], projected[point + 1]);
      }
    }
    ctx.stroke();
  }

  private drawCircuits(time: number): void {
    const ctx = this.context;
    ctx.lineWidth = 1;
    ctx.strokeStyle = line;
    ctx.globalAlpha = .42;
    ctx.stroke(this.traces);
    ctx.stroke(this.terminals);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let index = 0; index < this.circuits.length; index++) {
      const circuit = this.circuits[index];
      const head = (time * (19 + index % 4 * 3) + index * 83) % (circuit.length + 130);
      const tail = head - 42;
      const points = circuit.points;
      const distances = circuit.distances;
      ctx.strokeStyle = index % 3 === 0 ? accent : ink;
      ctx.globalAlpha = .78;
      ctx.beginPath();
      for (let segment = 1; segment < distances.length; segment++) {
        const start = distances[segment - 1];
        const end = distances[segment];
        if (end <= start || head < start || tail > end) continue;
        const from = Math.max(0, (tail - start) / (end - start));
        const to = Math.min(1, (head - start) / (end - start));
        const offset = segment * 2;
        const x = points[offset - 2];
        const y = points[offset - 1];
        const dx = points[offset] - x;
        const dy = points[offset + 1] - y;
        ctx.moveTo(x + dx * from, y + dy * from);
        ctx.lineTo(x + dx * to, y + dy * to);
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    visibility.unobserve(this.canvas);
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}

const visibility = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const viewport = viewports.find((item) => item.canvas === entry.target);
    if (!viewport) continue;
    viewport.visible = entry.isIntersecting;
    if (viewport.visible) viewport.draw(reduced ? 18 : elapsed);
  }
  schedule();
});

function canAnimate(): boolean {
  if (document.hidden || reduced || forcedColors.matches || mode === 'off' || mode === 'checker') return false;
  for (const viewport of viewports) {
    if (viewport.visible && viewport.width && viewport.height) return true;
  }
  return false;
}

function stop(): void {
  cancelAnimationFrame(frame);
  frame = 0;
  lastFrame = 0;
}

function schedule(): void {
  if (!canAnimate()) stop();
  else if (!frame) frame = requestAnimationFrame(animate);
}

function animate(timestamp: number): void {
  frame = 0;
  if (!canAnimate()) return;
  if (!lastFrame || timestamp - lastFrame >= frameInterval) {
    if (lastFrame) elapsed += Math.min((timestamp - lastFrame) / 1000, .1);
    lastFrame = timestamp;
    for (const viewport of viewports) viewport.draw(elapsed);
  }
  frame = requestAnimationFrame(animate);
}

function visibleWindow(element: HTMLElement): boolean {
  return element.isConnected && !element.closest('[hidden], [inert]')
    && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
}

function activateWindow(event: Event): void {
  if (!(event.target instanceof Element)) return;
  const next = event.target.closest<HTMLElement>('[data-desktop-window]');
  if (next && visibleWindow(next)) activeWindow = next;
  else if (event.target.closest('#page-scroll')) activeWindow = null;
  else return;
  updateParallax();
}

function onScroll(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.id === 'page-scroll') activeWindow = null;
  else {
    const window = target.parentElement;
    if (!target.matches('.window-body, .player-body')
      || !window?.matches('[data-desktop-window]:is([data-window-floating], [data-window-sized])') || !visibleWindow(window)) return;
    activeWindow = window;
  }
  updateParallax();
}

function updateParallax(): void {
  if (activeWindow && !visibleWindow(activeWindow)) {
    activeWindow = null;
    let layer = -Infinity;
    for (const candidate of document.querySelectorAll<HTMLElement>('[data-desktop-window]')) {
      const nextLayer = Number(candidate.style.getPropertyValue('--window-layer'));
      if (nextLayer >= layer && visibleWindow(candidate)) {
        activeWindow = candidate;
        layer = nextLayer;
      }
    }
  }
  // Resizing detaches a window from page-scroll; its body then owns the scroll offset.
  const nextSource = activeWindow?.matches('[data-window-floating], [data-window-sized]')
    ? activeWindow.querySelector<HTMLElement>(':scope > .window-body, :scope > .player-body')
    : document.getElementById('page-scroll');
  if (scrollSource !== nextSource) {
    scrollResizeObserver.disconnect();
    scrollSource = nextSource;
    if (scrollSource) scrollResizeObserver.observe(scrollSource);
  }
  const scrollTop = scrollSource?.scrollTop ?? 0;
  const nextParallax = reduced || mode === 'off' || forcedColors.matches ? 0 : -Math.min(Math.max(scrollTop, 0), 1600) * .028;
  if (nextParallax === parallaxY) return;
  parallaxY = nextParallax;
  // The soft color field moves more slowly than the pattern, without extra canvases.
  root.style.setProperty('--background-parallax-y', `${parallaxY}px`);
  if (mode === 'checker' && !document.hidden) {
    for (const viewport of viewports) viewport.draw(elapsed);
  }
}

function applySettings(): void {
  const next = root.dataset.backgroundActive || 'dots';
  const nextMode = Object.hasOwn(modes, next) ? modes[next] ?? 'off' : 'off';
  const changed = mode !== nextMode;
  mode = nextMode;
  reduced = root.dataset.motion !== 'full';
  const styles = getComputedStyle(root);
  const nextInk = styles.getPropertyValue('--accent-ink').trim();
  const nextLine = styles.getPropertyValue('--line').trim();
  const nextAccent = styles.getPropertyValue('--focus').trim();
  const nextTint = styles.getPropertyValue('--sage').trim();
  const colorsChanged = ink !== nextInk || line !== nextLine || accent !== nextAccent || tint !== nextTint;
  ink = nextInk;
  line = nextLine;
  accent = nextAccent;
  tint = nextTint;
  updateParallax();
  for (const viewport of viewports) {
    if (changed || (mode === 'checker' && colorsChanged)) viewport.rebuild();
    viewport.draw(reduced ? 18 : elapsed);
  }
  schedule();
}

function refresh(): void {
  updateParallax();
  for (const viewport of viewports) viewport.resize();
  schedule();
}

function syncViewports(): void {
  for (let index = viewports.length - 1; index >= 0; index--) {
    if (!viewports[index].canvas.isConnected) {
      viewports[index].destroy();
      viewports.splice(index, 1);
    }
  }
  // Swaps can replace styles without changing attributes; refresh before attaching new canvases.
  applySettings();
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('[data-background-canvas]')) {
    if (viewports.some((viewport) => viewport.canvas === canvas)) continue;
    const context = canvas.getContext('2d');
    if (context) viewports.push(new BackgroundViewport(canvas, context));
  }
  schedule();
}

const settingsObserver = new MutationObserver(applySettings);
settingsObserver.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-page-theme', 'data-motion', 'data-background-active'] });
// Follow ownership and visibility across portals and swaps, including body replacement.
const documentObserver = new MutationObserver((records) => {
  for (const viewport of viewports) {
    if (!viewport.canvas.isConnected) {
      syncViewports();
      return;
    }
  }
  if (records.some((record) => record.type === 'attributes' && record.target instanceof HTMLElement
    && record.target.matches('[data-desktop-window]')
    && record.oldValue !== record.target.getAttribute(record.attributeName!))
    || (activeWindow && !activeWindow.isConnected)) updateParallax();
});
documentObserver.observe(root, {
  childList: true, subtree: true, attributes: true, attributeOldValue: true,
  attributeFilter: ['data-window-floating', 'data-window-sized', 'hidden', 'inert'],
});

document.addEventListener('astro:after-swap', syncViewports, listenerOptions);
document.addEventListener('astro:page-load', syncViewports, listenerOptions);
document.addEventListener('visibilitychange', refresh, listenerOptions);
forcedColors.addEventListener('change', applySettings, listenerOptions);
darkScheme.addEventListener('change', applySettings, listenerOptions);
window.addEventListener('pagehide', stop, listenerOptions);
window.addEventListener('pageshow', refresh, listenerOptions);
document.addEventListener('gwenlium:viewport-scroll', updateParallax, listenerOptions);
document.addEventListener('gwenlium:windows-changed', updateParallax, listenerOptions);
document.addEventListener('pointerdown', activateWindow, listenerOptions);
document.addEventListener('focusin', activateWindow, listenerOptions);
// Element scroll does not bubble, including bodies moved out of the page viewport.
document.addEventListener('scroll', onScroll, { ...listenerOptions, capture: true, passive: true });
window.addEventListener('resize', refresh, listenerOptions);
window.visualViewport?.addEventListener('resize', refresh, listenerOptions);

syncViewports();

if (import.meta.hot) import.meta.hot.dispose(() => {
  stop();
  lifetime.abort();
  settingsObserver.disconnect();
  documentObserver.disconnect();
  scrollResizeObserver.disconnect();
  activeWindow = scrollSource = null;
  visibility.disconnect();
  for (const viewport of viewports) viewport.destroy();
  viewports.length = 0;
});

export {};
