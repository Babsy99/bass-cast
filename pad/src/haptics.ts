// Haptics: navigator.vibrate where it exists (Android). iOS Safari has no vibrate API; on iOS 18+
// toggling an <input type="checkbox" switch> produces a system haptic tick, so we use that as best effort.
let sw: HTMLLabelElement | null = null;
function iosTick() {
  if (!sw) {
    sw = document.createElement('label');
    sw.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;pointer-events:none';
    const i = document.createElement('input');
    i.type = 'checkbox'; i.setAttribute('switch', '');
    sw.appendChild(i); document.body.appendChild(sw);
  }
  sw.click();
}
export function haptic(p: 'tick' | 'thunk' | 'buzz' | 'double') {
  const pat: Record<string, number | number[]> = { tick: 8, thunk: 25, buzz: 45, double: [20, 60, 20] };
  if (typeof navigator.vibrate === 'function') { navigator.vibrate(pat[p]); return 'vibrate'; }
  iosTick();
  if (p === 'double') setTimeout(iosTick, 90);
  return 'ios-switch';
}
