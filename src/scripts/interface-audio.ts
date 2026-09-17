type InterfaceSound = 'confirm' | 'move' | 'type';
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
const kinds: InterfaceSound[] = ['confirm', 'move', 'type'];
const sounds: Record<InterfaceSound, Sound> = {
  confirm: { src: 'media/ui-confirm-preview-1bff1150661fda803fda6a4aa90e5d10.mp3', lastStarted: -Infinity, volume: 0.5, interval: 0 },
  move: { src: 'media/ui-move-preview-04b4a0067da6cbf8dcbeab2cdc8b8f64.mp3', lastStarted: -Infinity, volume: 0.35, interval: 45 },
  // The typing preview contains only the first recorded click of the source's click train.
  type: { src: 'media/ui-type-preview-e6f898635cd9d3cd27a585878e1230ee.mp3', lastStarted: -Infinity, volume: 0.3, interval: 55 },
};
let context: AudioContext | undefined;
let pendingConfirmUntil = 0;

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
  pendingConfirmUntil = 0;
  for (const kind of kinds) stopVoice(sounds[kind]);
}

function startVoice(kind: InterfaceSound): void {
  const sound = sounds[kind];
  if (!context || context.state !== 'running' || !sound.buffer || !sound.output) return;
  const now = performance.now();
  if (now - sound.lastStarted < sound.interval) return;
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

function flushConfirmation(): void {
  if (!pendingConfirmUntil) return;
  if (!foreground() || performance.now() > pendingConfirmUntil) {
    pendingConfirmUntil = 0;
    return;
  }
  if (context?.state !== 'running' || !sounds.confirm.buffer) return;
  pendingConfirmUntil = 0;
  startVoice('confirm');
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
    if (kind === 'confirm') flushConfirmation();
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
    if (context?.state === 'running') flushConfirmation();
    else silence();
  }, listenerOptions);
}

function unlock(event: Event): void {
  if (!event.isTrusted || document.hidden || lifetime.signal.aborted) return;
  // The browser authorizes the actual gesture. Extra userActivation/focus checks
  // can reject valid touch/keyboard activation before the document gains focus.
  initializeAudio();
  if (!context) return;
  if (context.state === 'running') { flushConfirmation(); return; }
  // A blocked or interrupted resume must not prevent a later valid gesture.
  void context.resume().then(flushConfirmation, () => { pendingConfirmUntil = 0; });
}

export function playInterfaceSound(kind: InterfaceSound): void {
  if (!foreground() || !context) return;
  if (context.state !== 'running' || !sounds[kind].buffer) {
    // Only the latest click may wait briefly for decode/resume, never old hover or typing events.
    if (kind === 'confirm') pendingConfirmUntil = performance.now() + 300;
    return;
  }
  if (kind === 'confirm') pendingConfirmUntil = 0;
  startVoice(kind);
}

// Fetch small assets early, but open the audio device only inside a user gesture.
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
  stopVoice(sounds.move);
  stopVoice(sounds.type);
}, listenerOptions);

if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  silence();
  for (const kind of kinds) sounds[kind].output?.disconnect();
  if (context) void context.close().catch(() => {});
});
