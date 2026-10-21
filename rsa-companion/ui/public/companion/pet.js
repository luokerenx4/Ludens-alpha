/* Interaction model adapted from MeteorNOX / DeepSeek-Balance-Whale-Widget (MIT).
 * Native window movement is owned by OpenAlice's existing Electron main process. */
const bridge = window.companion;
const pet = document.querySelector('#pet');
const portrait = document.querySelector('#portrait');
const body = document.querySelector('#body');
const mirror = document.querySelector('#mirror');
const bubble = document.querySelector('#bubble');
const message = document.querySelector('#message');
let alpha;
let flipped = false;
let held = null;
let interactive = false;
let hideTimer;
let line = 0;
let activityId = null;
const activityActions = document.querySelector('#activity-actions');
const activityOpen = document.querySelector('#activity-open');
function activityHit(point) {
  if (!activityId || !bubble.classList.contains('open')) return false;
  // Only the visible text/button block receives native input, not transparent gutters or bubble tail.
  const rect = activityActions.getBoundingClientRect();
  const text = message.getBoundingClientRect();
  return [rect, text].some(r => point.x >= r.left && point.x < r.right && point.y >= r.top && point.y < r.bottom);
}
bridge?.onActivity(event => {
  if (event.type === 'hide') { if (event.displayId === activityId) hideBubble(); return; }
  if (event.type !== 'show' || typeof event.displayId !== 'string') return;
  clearTimeout(hideTimer);
  activityId = event.displayId;
  renderLogContent(message, event.input);
  poses.activity(event.input);
  activityActions.hidden = false;
  bubble.classList.add('open', 'activity');
  bubble.setAttribute('aria-hidden', 'false');
  update(lastPoint);
});
document.querySelector('#activity-open').addEventListener('click', () => { if (activityId) void bridge?.openActivity(activityId); });
document.querySelector('#activity-dismiss').addEventListener('click', () => { if (activityId) void bridge?.dismissActivity(activityId); hideBubble(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && activityId) { void bridge?.dismissActivity(activityId); hideBubble(); }
});
let sound = { enabled: true, volume: .5, source: null };
let clickAudio;
function configureSound(settings) {
  clickAudio?.pause();
  sound = settings;
  clickAudio = sound.source ? new Audio(sound.source.dataUrl) : null;
  if (clickAudio) clickAudio.volume = sound.volume;
}
bridge?.onSound(configureSound);
function playClickSound() {
  if (!sound.enabled || !clickAudio || sound.volume === 0) return;
  clickAudio.pause();
  clickAudio.currentTime = 0;
  void clickAudio.play().catch(() => console.warn('Pet click sound could not play'));
}
let lastPoint = { x: -1, y: -1 };
const lines = ['我在。', '先观察，再行动。', '嗯？叫卢登斯。', '别戳了，在想了。', '这次有把握。大概。', '蛛腿也要休息。', '再试一次。', '一起看看？'];
const assets = new Map(ludensCatalog.assets.map(asset => [asset.id, asset]));
const effectImage = document.querySelector('#effect');
let requestedState = null, requestVersion = 0;
async function showPose({ state, effect }) {
  const overlay = assets.get(effect);
  effectImage.hidden = !overlay;
  if (overlay) effectImage.src = 'ludens/' + overlay.file;
  if (state === requestedState) return;
  const asset = assets.get(state);
  if (!asset || asset.kind !== 'state') return;
  requestedState = state;
  const version = ++requestVersion;
  try {
    const image = new Image(); image.src = 'ludens/' + asset.file;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (version !== requestVersion) return;
    // Commit art and its alpha mask together; slow decodes cannot overwrite a newer pose.
    portrait.src = image.src; alpha = pixels;
    portrait.alt = '卢登斯 · ' + asset.label;
    pet.dataset.state = state;
    update(lastPoint);
  } catch (error) {
    if (version === requestVersion) requestedState = null;
    console.warn('Ludens pose unavailable:', state, error);
  }
}
const poses = createPetState(value => { void showPose(value); });
bridge?.onPose?.(value => {
  if (!value || (value.state !== null && assets.get(value.state)?.kind !== 'state')) return;
  if (value.effect !== null && assets.get(value.effect)?.kind !== 'effect') return;
  poses.choose(value.state, value.effect);
});
const poseTimer = setInterval(() => poses.refresh(), 1000);
window.addEventListener('pagehide', () => clearInterval(poseTimer));

function hit(point) {
  const rect = portrait.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  let x = (point.x - rect.left) / rect.width;
  const y = (point.y - rect.top) / rect.height;
  if (x < 0 || y < 0 || x >= 1 || y >= 1 || !alpha) return false;
  // During the flip use the currently rendered direction, not its target.
  if (new DOMMatrixReadOnly(getComputedStyle(mirror).transform).a < 0) x = 1 - x;
  const px = Math.min(alpha.width - 1, Math.floor(x * alpha.width));
  return alpha.data[(Math.floor(y * alpha.height) * alpha.width + px) * 4 + 3] > 10;
}
function update(point) {
  lastPoint = point;
  const next = held !== null || hit(point) || activityHit(point);
  if (next !== interactive) { interactive = next; bridge?.interactive(next); }
}
function speak() {
  poses.interact(line % 2 ? '14-petted' : '13-poked');
  playClickSound();
  if (activityId) { activityOpen.focus(); return; }
  clearTimeout(hideTimer);
  message.textContent = lines[line++ % lines.length];
  bubble.classList.add('open');
  bubble.setAttribute('aria-hidden', 'false');
  hideTimer = setTimeout(hideBubble, 5000);
}
function hideBubble() { poses.activity(null); activityId = null; if (bubble.contains(document.activeElement)) pet.focus(); activityActions.hidden = true; delete message.dataset.blockId; bubble.classList.remove('open', 'activity'); bubble.setAttribute('aria-hidden', 'true'); update(lastPoint); }
pet.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !hit({ x: event.clientX, y: event.clientY })) return;
  event.preventDefault();
  held = event.pointerId;
  pet.setPointerCapture(held);
  body.classList.add('pressed');
  poses.interact('15-dragged', Infinity);
  bridge?.beginDrag();
});
async function release(event, cancelled = false) {
  if (held === null) return;
  const pointer = held;
  held = null;
  body.classList.remove('pressed');
  const moved = await bridge?.endDrag(cancelled);
  if (pet.hasPointerCapture(pointer)) pet.releasePointerCapture(pointer);
  poses.interact(!cancelled && moved ? '16-land' : '01-idle', cancelled ? 0 : 900);
  if (!cancelled && !moved) speak();
  if (event) update({ x: event.clientX, y: event.clientY });
}
pet.addEventListener('pointerup', event => { void release(event); });
pet.addEventListener('pointermove', () => { if (held !== null) bridge?.moveDrag(); });
pet.addEventListener('pointercancel', event => { void release(event, true); });
pet.addEventListener('lostpointercapture', event => { void release(event, true); });
window.addEventListener('blur', () => { void release(null, true); });
document.addEventListener('contextmenu', event => { event.preventDefault(); bridge?.menu(); });
pet.addEventListener('dblclick', () => bridge?.open());
pet.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); speak(); }
  if (event.key === 'Escape') { if (activityId) void bridge?.dismissActivity(activityId); hideBubble(); }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); bridge?.menu(); }
});
document.addEventListener('mousemove', event => update({ x: event.clientX, y: event.clientY }));
bridge?.onCursor(update);
bridge?.onFlip(value => { flipped = value; mirror.classList.toggle('flipped', value); });
let hitFrame = 0;
let hitUntil = 0;
document.addEventListener('transitionrun', () => {
  hitUntil = performance.now() + 550;
  if (hitFrame) return;
  function tick() {
    update(lastPoint);
    hitFrame = performance.now() < hitUntil ? requestAnimationFrame(tick) : 0;
  }
  hitFrame = requestAnimationFrame(tick);
});
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
bridge?.reducedMotion(reducedMotion.matches);
reducedMotion.addEventListener('change', event => bridge?.reducedMotion(event.matches));
async function prepare() {
  await portrait.decode();
  const canvas = document.createElement('canvas');
  canvas.width = portrait.naturalWidth; canvas.height = portrait.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(portrait, 0, 0);
  alpha = ctx.getImageData(0, 0, canvas.width, canvas.height);
  await document.querySelector('#bubble img').decode();
  try { if (bridge?.getSound) configureSound(await bridge.getSound()); }
  catch { console.warn('Pet sound settings unavailable'); }
  poses.refresh();
  bridge?.ready();
}
void prepare().catch(error => console.error('Companion asset failed:', error));
