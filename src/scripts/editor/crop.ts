import { mediaKindOf } from '../../lib/embed.mjs';
import { preparePreview, previewInputKind } from './prepare-media';
import { originalOf, publicName, rememberOriginal } from './media';
import type { SiteEditorStore } from './store';
import { button, errorText, node, openDialog } from './ui';

type Box = { x: number; y: number; width: number; height: number };
type Turn = 0 | 90 | 180 | 270;
type Corner = 'nw' | 'ne' | 'sw' | 'se';

const ratios: [string, number | undefined][] = [['Free', undefined], ['Square', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9]];
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Still pictures can be cropped; animations, video, audio and embeds cannot. */
export function canCrop(url: string): boolean {
  return mediaKindOf(url) === 'image' && !/\.gif(?:[?#]|$)/i.test(url);
}

/**
 * Crop or turn a picture. Starts from the original when it was added during this visit;
 * otherwise asks for it, because the version on the site is already smaller and signed.
 * Resolves with the new picture's address, or nothing when cancelled.
 */
export function cropPicture(store: SiteEditorStore, url: string, onStatus: (text: string) => void): Promise<string | undefined> {
  const original = originalOf(url);
  if (original) return cropDialog(store, original, onStatus);
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const input = node('input');
  input.type = 'file';
  input.accept = '.jpg,.jpeg,.png,.webp';
  input.addEventListener('change', () => { const file = input.files?.[0]; resolve(file ? cropDialog(store, file, onStatus) : undefined); });
  input.addEventListener('cancel', () => resolve(undefined));
  onStatus('Choose the original of this picture to crop it.');
  input.click();
  return promise;
}

async function cropDialog(store: SiteEditorStore, file: File, onStatus: (text: string) => void): Promise<string | undefined> {
  try {
    if (await previewInputKind(file) !== 'image') { onStatus('Cropping and turning work for still pictures, not animations, video or audio.'); return; }
  } catch (error) { onStatus(errorText(error, 'That picture could not be opened.')); return; }
  const address = URL.createObjectURL(file);
  const source = new Image();
  source.src = address;
  try { await source.decode(); } catch {
    URL.revokeObjectURL(address);
    onStatus('This browser cannot show that picture.');
    return;
  }
  onStatus('');

  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const { dialog, body, footer, status } = openDialog('Crop and turn', { wide: true });
  dialog.classList.add('crop-dialog');
  let turn: Turn = 0;
  let ratio: number | undefined;
  let box: Box = { x: 0, y: 0, width: 1, height: 1 };
  let result: string | undefined;

  const surface = node('div', undefined, 'crop-surface');
  const canvas = node('canvas', undefined, 'crop-canvas');
  const frame = node('div', undefined, 'crop-box');
  frame.tabIndex = 0;
  frame.setAttribute('role', 'group');
  frame.setAttribute('aria-label', 'Kept part. Drag it, or use the arrow keys; hold Shift to resize.');
  for (const corner of ['nw', 'ne', 'sw', 'se'] as Corner[]) {
    const handle = node('span', undefined, `crop-handle crop-handle--${corner}`);
    handle.dataset.corner = corner;
    frame.append(handle);
  }
  surface.append(canvas, frame);
  const stage = node('div', undefined, 'crop-stage');
  stage.append(surface);

  const size = node('span', '', 'crop-size');
  const tools = node('div', undefined, 'crop-tools');
  const turnLeft = button('↺ Turn left', () => rotate(-90), 'writer-mini');
  const turnRight = button('↻ Turn right', () => rotate(90), 'writer-mini');
  const shapes = node('div', undefined, 'writer-segmented crop-ratios');
  shapes.setAttribute('role', 'group');
  shapes.setAttribute('aria-label', 'Shape');
  const shapeButtons = ratios.map(([label, value]) => {
    const choice = button(label, () => fit(value), 'writer-segmented__option');
    choice.setAttribute('aria-pressed', String(value === ratio));
    shapes.append(choice);
    return { choice, value };
  });
  tools.append(turnLeft, turnRight, shapes, size);
  body.append(stage, tools);

  const reset = button('Start over', () => { turn = 0; box = { x: 0, y: 0, width: 1, height: 1 }; fit(undefined); draw(); }, 'owner-button');
  const use = button('Use this', () => void save(), 'owner-button owner-button--primary');
  footer.append(button('Cancel', () => dialog.close()), reset, use);

  // The picture as it will be turned, in real pixels.
  const turned = () => (turn % 180 ? { width: source.naturalHeight, height: source.naturalWidth } : { width: source.naturalWidth, height: source.naturalHeight });

  function draw() {
    const real = turned();
    const scale = Math.min(1, 1200 / real.width, 900 / real.height) * Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(real.width * Math.min(1, scale)));
    canvas.height = Math.max(1, Math.round(real.height * Math.min(1, scale)));
    const context = canvas.getContext('2d')!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(turn * Math.PI / 180);
    const width = turn % 180 ? canvas.height : canvas.width;
    const height = turn % 180 ? canvas.width : canvas.height;
    context.drawImage(source, -width / 2, -height / 2, width, height);
    place();
  }

  function place() {
    frame.style.left = `${box.x * 100}%`;
    frame.style.top = `${box.y * 100}%`;
    frame.style.width = `${box.width * 100}%`;
    frame.style.height = `${box.height * 100}%`;
    // Same sizes as the preparation: edits decode at up to 4096 px, results are at most 1600 px.
    const real = turned();
    const decoded = Math.min(1, 4096 / real.width, 4096 / real.height);
    const kept = { width: box.width * real.width * decoded, height: box.height * real.height * decoded };
    const out = Math.min(1, 1600 / kept.width, 1600 / kept.height);
    size.textContent = `${Math.max(1, Math.round(kept.width * out))} × ${Math.max(1, Math.round(kept.height * out))}`;
    for (const { choice, value } of shapeButtons) choice.setAttribute('aria-pressed', String(value === ratio));
  }

  // The chosen shape as a width-to-height ratio of fractions of the turned picture.
  const fractionRatio = () => { const real = turned(); return ratio! * real.height / real.width; };

  function fit(value: number | undefined) {
    ratio = value;
    if (ratio) {
      const shape = fractionRatio();
      const width = shape > 1 ? 1 : shape;
      const height = shape > 1 ? 1 / shape : 1;
      box = { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
    }
    place();
  }

  function rotate(by: number) {
    turn = (((turn + by) % 360 + 360) % 360) as Turn;
    box = { x: 0, y: 0, width: 1, height: 1 };
    draw();
    fit(ratio);
  }

  function move(start: Box, dx: number, dy: number): Box {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.width), y: clamp(start.y + dy, 0, 1 - start.height) };
  }

  function resize(start: Box, corner: Corner, dx: number, dy: number, rect: DOMRect): Box {
    const west = corner.includes('w');
    const north = corner.includes('n');
    const anchorX = west ? start.x + start.width : start.x;
    const anchorY = north ? start.y + start.height : start.y;
    const roomX = west ? anchorX : 1 - anchorX;
    const roomY = north ? anchorY : 1 - anchorY;
    const minX = Math.min(roomX, 32 / rect.width);
    const minY = Math.min(roomY, 32 / rect.height);
    let width = start.width + (west ? -dx : dx);
    let height = start.height + (north ? -dy : dy);
    if (ratio) {
      const shape = fractionRatio();
      width = clamp(Math.max(width, height * shape), Math.max(minX, minY * shape), Math.min(roomX, roomY * shape));
      height = width / shape;
    } else {
      width = clamp(width, minX, roomX);
      height = clamp(height, minY, roomY);
    }
    return { x: west ? anchorX - width : anchorX, y: north ? anchorY - height : anchorY, width, height };
  }

  let drag: { corner?: Corner; x: number; y: number; start: Box; rect: DOMRect } | undefined;
  frame.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const corner = (event.target as HTMLElement).dataset.corner as Corner | undefined;
    drag = { corner, x: event.clientX, y: event.clientY, start: { ...box }, rect: surface.getBoundingClientRect() };
    frame.setPointerCapture(event.pointerId);
    frame.focus({ preventScroll: true });
    event.preventDefault();
  });
  frame.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = (event.clientX - drag.x) / drag.rect.width;
    const dy = (event.clientY - drag.y) / drag.rect.height;
    box = drag.corner ? resize(drag.start, drag.corner, dx, dy, drag.rect) : move(drag.start, dx, dy);
    place();
  });
  const release = () => { drag = undefined; };
  frame.addEventListener('pointerup', release);
  frame.addEventListener('pointercancel', release);
  frame.addEventListener('keydown', event => {
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    const [dx, dy] = [step[0] * 0.02, step[1] * 0.02];
    box = event.shiftKey ? resize(box, 'se', dx, dy, surface.getBoundingClientRect()) : move(box, dx, dy);
    place();
  });

  async function save() {
    const cropped = box.x > 0.0005 || box.y > 0.0005 || box.width < 0.9995 || box.height < 0.9995;
    if (!cropped && !turn) { dialog.close(); return; }
    use.disabled = reset.disabled = true;
    status.textContent = 'Preparing the picture…';
    try {
      const round = (value: number) => Math.round(clamp(value, 0, 1) * 1e6) / 1e6;
      const x = round(box.x);
      const y = round(box.y);
      const crop = cropped ? { x, y, width: Math.min(round(box.width), 1 - x), height: Math.min(round(box.height), 1 - y) } : undefined;
      const { creator } = await store.media();
      const prepared = await preparePreview(file, { creator, name: publicName(file), ...(turn ? { rotate: turn } : {}), ...(crop ? { crop } : {}) });
      result = await store.addMedia(prepared);
      rememberOriginal(result, file);
      dialog.close();
    } catch (error) {
      status.textContent = errorText(error, 'The picture could not be prepared.');
      use.disabled = reset.disabled = false;
    }
  }

  dialog.addEventListener('close', () => {
    URL.revokeObjectURL(address);
    canvas.width = canvas.height = 1;
    if (result) onStatus('Picture cropped. Publish to put it on the site.');
    resolve(result);
  }, { once: true });
  draw();
  frame.focus({ preventScroll: true });
  return promise;
}
