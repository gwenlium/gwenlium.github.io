type RecordedSound = 'confirm' | 'move' | 'type';
type InterfaceSound = RecordedSound | 'close' | 'minimize';
type Sound = {
  src: string;
  buffer?: AudioBuffer;
  output?: GainNode;
  voice?: AudioBufferSourceNode;
  lastStarted: number;
  volume: number;
  interval: number;
};

const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
const kinds: RecordedSound[] = ['confirm', 'move', 'type'];
const sounds: Record<RecordedSound, Sound> = {
  confirm: { src: 'media/ui-confirm-preview-1bff1150661fda803fda6a4aa90e5d10.mp3', lastStarted: -Infinity, volume: 0.5, interval: 0 },
  move: { src: 'media/ui-move-preview-04b4a0067da6cbf8dcbeab2cdc8b8f64.mp3', lastStarted: -Infinity, volume: 0.35, interval: 45 },
  // The typing preview contains only the first recorded click of the source's click train.
  type: { src: 'media/ui-type-preview-e6f898635cd9d3cd27a585878e1230ee.mp3', lastStarted: -Infinity, volume: 0.3, interval: 55 },
};
let context: AudioContext | undefined;
let resuming: Promise<void> | undefined;
let unlocked = false;
let swapping = false;
let pendingConfirmUntil = 0;
let pendingConfirmation: InterfaceSound = 'confirm';

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
  const sound = sounds[kind === 'close' || kind === 'minimize' ? 'confirm' : kind];
  if (!context || context.state !== 'running' || !sound.buffer || !sound.output) return;
  const now = performance.now();
  if (now - sound.lastStarted < sound.interval) return;
  stopVoice(sound);
  const voice = context.createBufferSource();
  voice.buffer = sound.buffer;
  voice.connect(sound.output);
  sound.output.gain.cancelScheduledValues(context.currentTime);
  sound.output.gain.setValueAtTime(sound.volume, context.currentTime);
  if (kind === 'close' || kind === 'minimize') {
    const duration = kind === 'close' ? .32 : .16;
    voice.playbackRate.setValueAtTime(kind === 'close' ? .85 : 1.4, context.currentTime);
    voice.playbackRate.exponentialRampToValueAtTime(kind === 'close' ? .45 : .8, context.currentTime + duration * .7);
    sound.output.gain.setValueAtTime(sound.volume, context.currentTime + duration - .025);
    sound.output.gain.linearRampToValueAtTime(0, context.currentTime + duration);
  }
  voice.onended = () => {
    if (sound.voice === voice) sound.voice = undefined;
    voice.disconnect();
  };
  voice.start();
  if (kind === 'close' || kind === 'minimize') voice.stop(context.currentTime + (kind === 'close' ? .32 : .16));
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
  startVoice(pendingConfirmation);
}

async function preload(audio: AudioContext, kind: RecordedSound): Promise<void> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${sounds[kind].src}`, listenerOptions);
    if (!response.ok) return;
    const buffer = await audio.decodeAudioData(await response.arrayBuffer());
    if (lifetime.signal.aborted) return;
    sounds[kind].buffer = buffer;
    if (kind === 'confirm') flushConfirmation();
  } catch {
    // Missing/unsupported recordings and aborted loads leave this sound silent.
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
    void preload(context, kind);
  }
  context.addEventListener('statechange', () => {
    if (context?.state === 'running') flushConfirmation();
    else silence();
  }, listenerOptions);
}

function unlock(event: Event): void {
  if (!event.isTrusted || !foreground()) return;
  if (navigator.userActivation && !navigator.userActivation.isActive) return;
  if (event instanceof PointerEvent) {
    if (event.type === 'pointerdown' && event.pointerType !== 'mouse') return;
    if (event.type === 'pointerup' && event.pointerType === 'mouse') return;
  }
  if (event instanceof KeyboardEvent && (event.key === 'Escape' || event.metaKey || event.ctrlKey || event.altKey)) return;
  initializeAudio();
  if (!context) return;
  unlocked = true;
  if (context.state === 'running') {
    flushConfirmation();
    return;
  }
  if (resuming) return;
  try {
    const attempt = context.resume();
    resuming = attempt;
    void attempt.then(() => {
      if (resuming === attempt) resuming = undefined;
      flushConfirmation();
    }, () => {
      if (resuming === attempt) resuming = undefined;
      pendingConfirmUntil = 0;
    });
  } catch {
    pendingConfirmUntil = 0;
  }
}

export function playInterfaceSound(kind: InterfaceSound): void {
  if (!foreground() || swapping || !unlocked || !context) return;
  const source = kind === 'close' || kind === 'minimize' ? 'confirm' : kind;
  if (context.state !== 'running' || !sounds[source].buffer) {
    // Only the current action may wait for unlock/preload; never replay old movement or typing.
    if (source === 'confirm' && (resuming || context.state === 'running')) {
      pendingConfirmation = kind;
      pendingConfirmUntil = performance.now() + 300;
    }
    return;
  }
  if (source === 'confirm') pendingConfirmUntil = 0;
  startVoice(kind);
}

for (const event of ['pointerdown', 'pointerup', 'keydown', 'click']) {
  document.addEventListener(event, unlock, { ...listenerOptions, capture: true });
}
window.addEventListener('blur', silence, listenerOptions);
window.addEventListener('pagehide', silence, listenerOptions);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') silence();
}, listenerOptions);
document.addEventListener('astro:before-swap', () => {
  swapping = true;
  stopVoice(sounds.move);
  stopVoice(sounds.type);
  // Let a navigation's confirmation finish, including a pending first unlock.
}, listenerOptions);
document.addEventListener('astro:page-load', () => { swapping = false; }, listenerOptions);

initializeAudio();
if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  silence();
  for (const kind of kinds) sounds[kind].output?.disconnect();
  if (context) void context.close().catch(() => {});
});
