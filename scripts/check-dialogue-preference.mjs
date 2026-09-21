import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

class Node {
  constructor() { this.dataset = {}; this.style = {}; this.hidden = false; this.isConnected = true; this.children = []; this.childNodes = []; this.events = new Map(); this.nodes = {}; this.scrolls = 0; this.attributes = new Set(); }
  toggleAttribute(name, force = !this.attributes.has(name)) {
    if (force) this.attributes.add(name); else this.attributes.delete(name);
    return force;
  }
  addEventListener(type, callback) { this.events.set(type, [...(this.events.get(type) || []), callback]); }
  dispatchEvent(event) { for (const callback of this.events.get(event.type) || []) callback(event); return true; }
  querySelector(selector) { return this.nodes[selector] ?? null; }
  querySelectorAll(selector) { return this.nodes[selector] ?? []; }
  closest() { return null; }
  matches(selector) { return selector === 'input[data-preference]' && this instanceof Input; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  scrollIntoView() { this.scrolls++; }
  focus() {}
}
class Input extends Node {}
const document = new Node();
document.documentElement = new Node();
document.getElementById = () => null;
const window = new Node();
window.matchMedia = () => Object.assign(new Node(), { matches: false });
const toggle = new Input(); toggle.dataset.preference = 'dialogue'; toggle.checked = false;
const theme = new Input(); theme.dataset.preference = 'theme'; theme.value = 'dark';
const status = new Node();
document.nodes['input[data-preference]'] = [toggle, theme];
document.nodes['[data-preferences-status]'] = status;
const root = new Node(); const content = new Node(); const source = new Node();
const paragraphs = [new Node(), new Node(), new Node()]; source.children = paragraphs;
content.nodes['[data-dialogue-blocks]'] = [source];
content.nodes['video, audio'] = [];
const option = new Node(); const enter = new Node(); option.nodes['[data-dialogue-enter]'] = enter;
root.nodes['[data-dialogue-option]'] = option;
root.nodes['[data-dialogue-content]'] = content;
for (const key of ['heading', 'exit', 'controls', 'back', 'next', 'progress']) root.nodes[`[data-dialogue-${key}]`] = new Node();
root.nodes['[data-dialogue-next]'].nodes['[data-dialogue-next-label]'] = new Node();
document.nodes['[data-dialogue-reader]'] = [root];
const storage = new Map();
const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const sandbox = { document, window, localStorage, exports: {}, HTMLElement: Node, Element: Node, HTMLInputElement: Input, Text: class {}, AbortController, CustomEvent, URLSearchParams, URL, location: { hash: '', search: '', href: 'https://gwenlium.dev/about/' } };
// These preference checks isolate window motion and sound; browser smoke checks exercise both.
sandbox.require = (name) => {
  if (name === './window-motion') return { cancelWindowAnimation() {}, async animateWindow() { return true; } };
  if (name === './interface-audio') return { playInterfaceSound() {} };
  throw new Error(`Unexpected module: ${name}`);
};
vm.createContext(sandbox);
function run(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/if \(import\.meta\.hot\)[\s\S]*?(?=\nexport \{\};|$)/, '');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(`(function(){${code}\n})()`, sandbox);
}
run('src/scripts/preferences.ts'); run('src/scripts/dialogue-reader.ts');
assert(paragraphs.every(node => !node.hidden));
toggle.checked = true; document.dispatchEvent({ type: 'change', target: toggle });
assert.equal(JSON.parse(storage.get('gwenlium:preferences')).dialogue, 'on');
assert.deepEqual(paragraphs.map(node => node.hidden), [false, true, true]);
assert.equal(root.nodes['[data-dialogue-heading]'].scrolls, 0, 'global toggle must not jump the page');
root.nodes['[data-dialogue-next]'].dispatchEvent({ type: 'click' });
assert.deepEqual(paragraphs.map(node => node.hidden), [true, false, true]);
document.dispatchEvent({ type: 'change', target: theme });
assert.deepEqual(paragraphs.map(node => node.hidden), [true, false, true], 'theme change must preserve reading position');
toggle.checked = false; document.dispatchEvent({ type: 'change', target: toggle });
assert(paragraphs.every(node => !node.hidden));
assert.equal(option.hidden, true);
storage.set('gwenlium:preferences', JSON.stringify({ dialogue: 'on' }));
window.dispatchEvent({ type: 'storage', key: 'gwenlium:preferences' });
assert.equal(toggle.checked, true);
assert.deepEqual(paragraphs.map(node => node.hidden), [false, true, true]);
const nextDocument = { documentElement: new Node() };
document.dispatchEvent({ type: 'astro:before-swap', newDocument: nextDocument });
assert(paragraphs.every(node => !node.hidden), 'navigation cleanup restores blocks');
document.dispatchEvent({ type: 'astro:page-load' });
assert.deepEqual(paragraphs.map(node => node.hidden), [false, true, true]);
localStorage.setItem = () => { throw new Error('storage blocked'); };
toggle.checked = false; document.dispatchEvent({ type: 'change', target: toggle });
assert(paragraphs.every(node => !node.hidden));
console.log('Global dialogue preference verified: live toggle, saved state, navigation, cross-tab sync, no scroll jump, and blocked storage.');
