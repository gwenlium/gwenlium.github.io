type InterfaceSound = 'confirm' | 'close' | 'finish' | 'move' | 'type';
type Sound = {
  src: string;
  data?: Promise<ArrayBuffer | undefined>;
  buffer?: AudioBuffer;
  output?: GainNode;
  voice?: AudioBufferSourceNode;
  lastStarted: number;
  volume: number;
  interval: number;
};

const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
const kinds: InterfaceSound[] = ['confirm', 'close', 'finish', 'move', 'type'];
const sounds: Record<InterfaceSound, Sound> = {
  confirm: { src: 'media/ui-confirm-preview-1bff1150661fda803fda6a4aa90e5d10.mp3', lastStarted: -Infinity, volume: 0.5, interval: 0 },
  close: { src: 'media/ui-close-preview-118db8c6fb2f8447298b044e352b6186.mp3', lastStarted: -Infinity, volume: 0.5, interval: 0 },
  finish: { src: 'media/ui-finish-preview-50fc0240359eaa2fc6a9734c964812cd.mp3', lastStarted: -Infinity, volume: 0.5, interval: 0 },
  move: { src: 'media/ui-move-preview-04b4a0067da6cbf8dcbeab2cdc8b8f64.mp3', lastStarted: -Infinity, volume: 0.35, interval: 45 },
  // The typing preview contains only the first recorded click of the source's click train.
  type: { src: 'media/ui-type-preview-e6f898635cd9d3cd27a585878e1230ee.mp3', lastStarted: -Infinity, volume: 0.3, interval: 55 },
};
let context: AudioContext | undefined;
let pendingAction: 'confirm' | 'close' | 'finish' | undefined;
let pendingActionUntil = 0;
let navigating = false;

function foreground(): boolean {
  return !lifetime.signal.aborted && document.visibilityState === 'visible' && document.hasFocus();
}

function stopVoice(sound: Sound): void {
  const voice = sound.voice;
  if (!voice) return;
  sound.voice = undefined;
  voice.onended = null;
  voice.stop();
  voice.disconnect();
}

function silence(): void {
  pendingAction = undefined;
  for (const kind of kinds) stopVoice(sounds[kind]);
}

function startVoice(kind: InterfaceSound): void {
  const sound = sounds[kind];
  if (!context || context.state !== 'running' || !sound.buffer || !sound.output) return;
  const now = performance.now();
  if (now - sound.lastStarted < sound.interval) return;
  if (kind === 'close' || kind === 'finish') stopVoice(sounds.confirm);
  stopVoice(sound);
  const voice = context.createBufferSource();
  voice.buffer = sound.buffer;
  voice.connect(sound.output);
  voice.onended = () => {
    if (sound.voice === voice) sound.voice = undefined;
    voice.disconnect();
  };
  voice.start();
  sound.voice = voice;
  sound.lastStarted = now;
}

function flushAction(): void {
  if (!pendingAction) return;
  if (!foreground() || performance.now() > pendingActionUntil) {
    pendingAction = undefined;
    return;
  }
  if (context?.state !== 'running' || !sounds[pendingAction].buffer) return;
  const kind = pendingAction;
  pendingAction = undefined;
  startVoice(kind);
}

async function fetchRecording(kind: InterfaceSound): Promise<ArrayBuffer | undefined> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${sounds[kind].src}`, listenerOptions);
    return response.ok ? await response.arrayBuffer() : undefined;
  } catch {
    // Unavailable recordings cannot be played; never substitute unrelated audio.
    return undefined;
  }
}

async function decodeRecording(audio: AudioContext, kind: InterfaceSound): Promise<void> {
  try {
    const data = await sounds[kind].data;
    if (!data || lifetime.signal.aborted) return;
    const buffer = await audio.decodeAudioData(data);
    if (lifetime.signal.aborted) return;
    sounds[kind].buffer = buffer;
    if (kind === pendingAction) flushAction();
  } catch {
    // An aborted context or unsupported recording must not break the controls.
  }
}

function initializeAudio(): void {
  if (context || lifetime.signal.aborted || typeof AudioContext === 'undefined') return;
  try {
    context = new AudioContext({ latencyHint: 'interactive' });
  } catch {
    return;
  }
  for (const kind of kinds) {
    const output = context.createGain();
    output.gain.value = sounds[kind].volume;
    output.connect(context.destination);
    sounds[kind].output = output;
    void decodeRecording(context, kind);
  }
  context.addEventListener('statechange', () => {
    if (context?.state === 'running') flushAction();
    else silence();
  }, listenerOptions);
}

function unlock(event: Event): void {
  if (!event.isTrusted || document.hidden || lifetime.signal.aborted) return;
  // The browser authorizes the actual gesture. Extra userActivation/focus checks
  // can reject valid touch/keyboard activation before the document gains focus.
  initializeAudio();
  if (!context) return;
  if (context.state === 'running') { flushAction(); return; }
  // A blocked or interrupted resume must not prevent a later valid gesture.
  void context.resume().then(flushAction, () => { pendingAction = undefined; });
}

export function playInterfaceSound(kind: InterfaceSound): void {
  if (!foreground()) return;
  // Full page loads (including 404s) lose the previous audio context, not necessarily
  // the browser's playback permission. A blocked context still waits for unlock().
  initializeAudio();
  if (!context) return;
  if (context.state !== 'running' || !sounds[kind].buffer) {
    // Only the latest click may wait briefly for decode/resume, never old hover or typing events.
    if (kind !== 'move' && kind !== 'type') {
      pendingAction = kind;
      pendingActionUntil = performance.now() + 300;
    }
    return;
  }
  if (kind !== 'move' && kind !== 'type') pendingAction = undefined;
  startVoice(kind);
}

document.addEventListener('gwenlium:window-command', event => {
  const detail = (event as CustomEvent<{ id?: string; action?: string }>).detail;
  if (navigating || typeof detail?.id !== 'string' || (detail.action !== 'close' && detail.action !== 'minimize')) return;
  const root = document.querySelector<HTMLElement>(`[data-desktop-window][data-window-id="${CSS.escape(detail.id)}"]`);
  if (root && !root.hidden && !root.inert) playInterfaceSound('close');
}, { ...listenerOptions, capture: true });
document.addEventListener('close', event => {
  if (!navigating && event.target instanceof HTMLDialogElement && event.target.isConnected && !event.target.open) playInterfaceSound('close');
}, { ...listenerOptions, capture: true });

// Fetch small assets early; the browser's autoplay policy governs playback.
for (const kind of kinds) sounds[kind].data = fetchRecording(kind);
for (const event of ['pointerdown', 'pointerup', 'keydown', 'click']) {
  document.addEventListener(event, unlock, { ...listenerOptions, capture: true });
}
window.addEventListener('blur', silence, listenerOptions);
window.addEventListener('pagehide', silence, listenerOptions);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') silence();
}, listenerOptions);
document.addEventListener('astro:before-swap', () => {
  navigating = true;
  stopVoice(sounds.move);
  stopVoice(sounds.type);
}, listenerOptions);
document.addEventListener('astro:page-load', () => { navigating = false; }, listenerOptions);

if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  silence();
  for (const kind of kinds) sounds[kind].output?.disconnect();
  if (context) void context.close().catch(() => {});
});
