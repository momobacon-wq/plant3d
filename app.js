import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const $ = id => document.getElementById(id);
const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
// Triangles kept on the GPU at once. 高畫質 doubles it; if the tab dies while it is on (iOS kills a
// page that runs out of memory and reloads it) the next load falls back to the standard budget.
const HQ_KEY = 'nwv.hq', HQ_RUN = 'nwv.hqrun';
let hq = false, hqCrashed = false;
try {
  hq = localStorage.getItem(HQ_KEY) === '1';
  if (hq && sessionStorage.getItem(HQ_RUN)) { hq = false; hqCrashed = true; localStorage.removeItem(HQ_KEY); }
} catch { }
const triBudget = () => (IS_MOBILE ? 6e6 : 20e6) * (hq ? 2 : 1);
function markHqRun(on = hq && document.visibilityState === 'visible') {
  try { if (on) sessionStorage.setItem(HQ_RUN, '1'); else sessionStorage.removeItem(HQ_RUN); } catch { }
}
markHqRun();
// a page evicted while in the background, reloaded or closed is not a crash
addEventListener('pagehide', () => markHqRun(false));
document.addEventListener('visibilitychange', () => markHqRun());
const MAX_FINE = 6, MAX_COARSE = 16;   // concurrent fine downloads / coarse decodes
const HILITE = [255, 60, 30, 255];
const REMEMBER_KEY = 'nwv.pass';
const HIDE_KEY = 'nwv.hidden';

// ---------------- crypto ----------------
let aesKey = null;
async function deriveKey(pass, manifest) {
  const salt = Uint8Array.from(atob(manifest.salt), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: manifest.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
// Data files are served through jsDelivr (pinned to a commit, fast edge cache in Taiwan); fall back
// to the GitHub Pages copy if the CDN fails.
let urlMap = {};
async function fetchOnce(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
async function fetchBytes(url) {
  for (const p in urlMap) if (url.startsWith(p)) {
    try { return await fetchOnce(urlMap[p] + url.slice(p.length)); } catch (e) { console.warn('CDN failed, falling back', e); }
    break;
  }
  return fetchOnce(url);
}
async function fetchSealed(url) { return openSealed(await fetchBytes(url)); }
async function openSealed(buf) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, aesKey, buf.subarray(12));
  const ds = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

// ---------------- scene ----------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_MOBILE, powerPreference: 'high-performance' });
const BASE_DPR = Math.min(devicePixelRatio, IS_MOBILE ? 2 : 1.5);
renderer.setPixelRatio(BASE_DPR);
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb9c4cf);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50000);
camera.up.set(0, 0, 1);                                      // Navisworks is Z-up
scene.add(new THREE.HemisphereLight(0xffffff, 0x60646a, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
camera.add(sun); sun.position.set(0.3, 0.5, 1); scene.add(camera);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.12;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
const modelRoot = new THREE.Group(); scene.add(modelRoot);

function updateViewOffset() {
  const panel = $('info');
  const shift = panel.classList.contains('show') && innerWidth < 700 ? panel.offsetHeight * 0.5 : 0;
  if (shift) camera.setViewOffset(innerWidth, innerHeight, 0, shift, innerWidth, innerHeight); else camera.clearViewOffset();
  dirty = true;
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); updateViewOffset();
}
addEventListener('resize', resize);

let dirty = true;
// Orbit zoom only shrinks the distance to the pivot, so it stalls as it gets close. When the user
// zooms in that far, push the pivot ahead along the view direction so zooming keeps flying forward.
const PUSH_MIN = 1.5;          // metres
let lastDist = null;
let interacting = false, idleTimer = 0;
function setDpr(r) { if (renderer.getPixelRatio() !== r) { renderer.setPixelRatio(r); renderer.setSize(innerWidth, innerHeight, false); dirty = true; } }
controls.addEventListener('start', () => { interacting = true; clearTimeout(idleTimer); if (IS_MOBILE) setDpr(1); });
controls.addEventListener('end', () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { interacting = false; setDpr(BASE_DPR); wantSchedule = true; }, 400);
});
controls.addEventListener('change', () => {
  const d = camera.position.distanceTo(controls.target);
  if (lastDist !== null && d < lastDist - 1e-6 && d < PUSH_MIN && !anim) {
    const dir = controls.target.clone().sub(camera.position).normalize();
    controls.target.addScaledVector(dir, PUSH_MIN * 2 - d);
  }
  lastDist = camera.position.distanceTo(controls.target);
  dirty = true; wantSchedule = true;
});

// clipping (section box)
const clipPlanes = [];
let sectionOn = false, sectionBox = null;
function setSection(box) {
  sectionBox = box;
  clipPlanes.length = 0;
  if (box && sectionOn) {
    clipPlanes.push(
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -box.min.x), new THREE.Plane(new THREE.Vector3(-1, 0, 0), box.max.x),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -box.min.y), new THREE.Plane(new THREE.Vector3(0, -1, 0), box.max.y),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -box.min.z), new THREE.Plane(new THREE.Vector3(0, 0, -1), box.max.z));
  }
  for (const m of [matOpaque, matTrans, matOverlay]) { m.clippingPlanes = clipPlanes.length ? clipPlanes : null; m.needsUpdate = true; }
  $('btnSection').classList.toggle('on', sectionOn);
  dirty = true;
}

const matOpaque = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
const matTrans = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false });
let xray = false;
function setXray(on) {
  xray = on;
  matOpaque.transparent = on; matOpaque.opacity = on ? 0.25 : 1; matOpaque.depthWrite = !on; matOpaque.needsUpdate = true;
  $('btnXray').classList.toggle('on', on); dirty = true;
}

// ---------------- data ----------------
let index = null;          // decrypted index.json
let named = [];            // [id, end, name, cls, parentNamedId, x0,y0,z0,x1,y1,z1, props]
const namedById = new Map();
// Each tile has a coarse layer (always loaded, small) and a fine layer (loaded by priority within
// triBudget()). While the fine layer is on screen the coarse one is hidden.
const tiles = [];          // {meta, box, L:{c:Layer, f:Layer}};  Layer = {state, group, batches, tris}
let loadedTris = 0, inflight = 0, inflightC = 0;
const hasCoarse = t => !!(t.meta.c || t.meta.cl);
let hilite = null;         // {a, b} item id range

// Tiles are fetched, decrypted and baked in a small worker pool (tileworker.js); the main thread
// only wraps the returned arrays in meshes.
const workers = [];
let workerSeq = 0;
const pending = new Map();
function startWorkers() {
  const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  for (let i = 0; i < n; i++) {
    const w = new Worker('./tileworker.js', { type: 'module' });
    w.busy = 0;
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id); if (!p) return;
      pending.delete(data.id); w.busy--;
      if (data.error) p.reject(new Error(data.error)); else p.resolve(data.batches);
    };
    w.postMessage({ type: 'init', key: aesKey, urlMap });
    workers.push(w);
  }
}
function workerCall(msg) {
  const w = workers.reduce((p, q) => (q.busy < p.busy ? q : p));
  const id = ++workerSeq;
  w.busy++;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); w.postMessage({ ...msg, id }); });
}
function batchMesh(bt) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(bt.pos, 3));
  g.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(bt.nrm, 4), 3, 0, true));
  g.setAttribute('color', new THREE.BufferAttribute(bt.col, 4, true));
  g.setIndex(new THREE.BufferAttribute(bt.idx, 1));
  g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(65535, 65535, 65535));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  const mesh = new THREE.Mesh(g, bt.transparent ? matTrans : matOpaque);
  mesh.position.set(bt.tmin[0], bt.tmin[1], bt.tmin[2]); mesh.scale.set(bt.sc[0], bt.sc[1], bt.sc[2]);
  mesh.matrixAutoUpdate = false; mesh.updateMatrix();
  const b = { mesh, ranges: bt.ranges, col: bt.col, orig: null, full: null };
  applyHide(b);
  return b;
}

// ---------------- hiding ----------------
// Item-id ranges that are not drawn: the GE / HST maintenance and clearance volumes (hidden.bin, the
// solid red "space reservation" boxes, and the /HAZZ hazardous-area zones around gas vents; shown again
// with 保留空間) plus items hidden from the info panel.
// A batch keeps one index buffer: visible triangles are packed to the front and the draw range cut,
// so raycasting and the GPU both skip the hidden ones.
let volRanges = [], showVols = false, userHidden = [], hideList = [];
try { userHidden = JSON.parse(localStorage.getItem(HIDE_KEY) || '[]'); } catch { }
function rebuildHideList() {
  const all = (showVols ? [] : volRanges).concat(userHidden).map(r => r.slice()).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of all) {
    if (out.length && a <= out[out.length - 1] + 1) out[out.length - 1] = Math.max(out[out.length - 1], b);
    else out.push(a, b);
  }
  hideList = out;
}
function isHidden(id) {
  let lo = 0, hi = hideList.length / 2 - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (hideList[m * 2 + 1] < id) lo = m + 1; else if (hideList[m * 2] > id) hi = m - 1; else return true;
  }
  return false;
}
function applyHide(b) {
  const g = b.mesh.geometry, attr = g.index, r = b.ranges;
  let mask = null;
  if (hideList.length) for (let i = 0; i < r.length; i += 3) if (isHidden(r[i])) {
    if (!mask) mask = new Uint8Array(g.getAttribute('position').count);
    mask.fill(1, r[i + 1], r[i + 1] + r[i + 2]);
  }
  if (!mask) {
    if (b.full) { attr.array.set(b.full); attr.needsUpdate = true; b.full = null; g.setDrawRange(0, Infinity); }
    return;
  }
  if (!b.full) b.full = attr.array.slice();
  const f = b.full, idx = attr.array;
  let n = 0;
  for (let t = 0; t < f.length; t += 3) if (!mask[f[t]]) { idx[n++] = f[t]; idx[n++] = f[t + 1]; idx[n++] = f[t + 2]; }
  attr.needsUpdate = true; g.setDrawRange(0, n);
}
function refreshHidden() {
  rebuildHideList();
  for (const t of tiles) for (const lod of ['c', 'f']) if (t.L[lod].state === 'ready') for (const b of t.L[lod].batches) applyHide(b);
  if (hilite) { const m = markerAt, h = hilite; highlight(h.a, h.b); markerAt = m; }
  $('btnVols').classList.toggle('on', showVols);
  $('btnUnhide').style.display = userHidden.length ? '' : 'none';
  $('btnUnhide').textContent = `顯示已隱藏 (${userHidden.length})`;
  try { localStorage.setItem(HIDE_KEY, JSON.stringify(userHidden)); } catch { }
  dirty = true;
}

function layerTris(t, lod) { return lod === 'f' ? t.meta.t : t.meta.ct; }

async function loadLayer(t, lod) {
  const L = t.L[lod];
  L.state = 'loading'; if (lod === 'f') inflight++; else inflightC++;
  try {
    const box = [t.box.min.x, t.box.min.y, t.box.min.z, t.box.max.x, t.box.max.y, t.box.max.z];
    const res = lod === 'f' ? await workerCall({ url: `${t.meta.u || 'data/tiles/'}${t.meta.f}`, box })
      : t.meta.cl ? await workerCall({ bundle: true, url: `data/tiles/${index.coarseBundles[t.meta.cb]}`, off: t.meta.co, len: t.meta.cl, box })
      : await workerCall({ url: `data/tiles/${t.meta.c}`, box });
    if (L.state !== 'loading') return;             // cancelled meanwhile
    L.batches = res.map(batchMesh);
    L.group = new THREE.Group();
    for (const b of L.batches) L.group.add(b.mesh);
    modelRoot.add(L.group);
    L.state = 'ready'; loadedTris += layerTris(t, lod);
    if (lod === 'f' && t.L.c.group) t.L.c.group.visible = false;
    if (lod === 'c' && t.L.f.state === 'ready') L.group.visible = false;
    if (hilite) applyHilite(L, hilite);
  } catch (e) {
    console.error(e); L.state = 'error';
  } finally {
    if (lod === 'f') inflight--; else inflightC--;
    dirty = true; updateStatus(); queueMicrotask(schedule);
  }
}

function unloadLayer(t, lod) {
  const L = t.L[lod];
  if (L.state === 'loading') { L.state = 'idle'; return; }
  modelRoot.remove(L.group);
  for (const b of L.batches) { dropOverlay(b); b.mesh.geometry.dispose(); }
  L.group = null; L.batches = null; L.state = 'idle'; loadedTris -= layerTris(t, lod);
  if (lod === 'f' && t.L.c.group) t.L.c.group.visible = true;
}

function* readyLayers() {
  for (const t of tiles) for (const lod of ['c', 'f']) { const L = t.L[lod]; if (L.state === 'ready' && L.group.visible) yield L; }
}

// Coarse layers first (whole plant silhouette), then fine layers nearest to the orbit target.
const _v = new THREE.Vector3(), _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4();
let wantSchedule = true, budgetFull = false;
function schedule() {
  wantSchedule = false;
  camera.updateMatrixWorld();
  _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); _frustum.setFromProjectionMatrix(_pm);
  const focus = controls.target;
  const viewDist = camera.position.distanceTo(focus);
  for (const t of tiles) {
    const inView = _frustum.intersectsBox(t.box);
    // tile boxes overlap a lot (long pipe runs stretch them), so a big box is pushed back by a share of
    // its size: its triangles are spread out and few of them are near
    t.sz ??= Math.max(t.meta.b[3] - t.meta.b[0], t.meta.b[4] - t.meta.b[1], t.meta.b[5] - t.meta.b[2]);
    const d = (inView ? Math.min(t.box.distanceToPoint(focus), t.box.distanceToPoint(camera.position)) : t.box.distanceToPoint(focus)) + t.sz * 0.3;
    const inSection = !sectionOn || !sectionBox || sectionBox.intersectsBox(t.box);
    t.prio = inSection ? (inView ? 1 : 3) * (d + viewDist * 0.05 + 1) : Infinity;
  }
  const order = tiles.slice().sort((a, b) => a.prio - b.prio);
  let budget = 0;
  for (const t of tiles) if (hasCoarse(t)) budget += t.meta.ct;
  const keep = new Set(), limit = triBudget();
  budgetFull = false;
  for (const t of order) {
    if (t.prio === Infinity) break;
    if (budget + t.meta.t > limit) { budgetFull = true; break; }
    budget += t.meta.t; keep.add(t);
  }
  for (const t of tiles) if (t.L.f.state !== 'idle' && t.L.f.state !== 'error' && !keep.has(t)) unloadLayer(t, 'f');
  if (interacting) { updateStatus(); return; }   // resume when the gesture ends
  for (const t of order) {                       // coarse first, nearest first
    if (inflightC >= MAX_COARSE) break;
    if (hasCoarse(t) && t.L.c.state === 'idle') loadLayer(t, 'c');
  }
  for (const t of order) {
    if (inflight >= MAX_FINE) break;
    if (keep.has(t) && t.L.f.state === 'idle') loadLayer(t, 'f');
  }
  updateStatus();
}

function updateStatus() {
  const f = tiles.filter(t => t.L.f.state === 'ready').length;
  const c = tiles.filter(t => t.L.c.state === 'ready').length, cn = tiles.filter(hasCoarse).length;
  $('status').textContent = `${c < cn ? `概覽 ${c}/${cn} · ` : ''}精細 ${f}/${tiles.length} 區 · ${(loadedTris / 1e6).toFixed(1)}M 面${inflight || inflightC ? ' · 載入中' : budgetFull ? '（上限）' : ''}`;
}


// ---------------- highlight ----------------
// Highlight = recolour the item vertices + an always-on-top translucent overlay of the same
// triangles, so equipment inside cladding or buildings is still visible.
const matOverlay = new THREE.MeshBasicMaterial({ color: 0xff5a1e, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
function applyHilite(L, h) {
  for (const b of L.batches) {
    const r = b.ranges, attr = b.mesh.geometry.getAttribute('color');
    const vr = [];
    for (let i = 0; i < r.length; i += 3) {
      const id = r[i];
      if (id < h.a || id > h.b) continue;
      if (!b.orig) b.orig = b.col.slice();
      const v0 = r[i + 1] * 4, v1 = (r[i + 1] + r[i + 2]) * 4;
      for (let k = v0; k < v1; k += 4) { b.col[k] = HILITE[0]; b.col[k + 1] = HILITE[1]; b.col[k + 2] = HILITE[2]; b.col[k + 3] = 255; }
      vr.push(r[i + 1], r[i + 1] + r[i + 2]);
    }
    if (!vr.length) continue;
    attr.needsUpdate = true;
    const idx = b.mesh.geometry.index.array, sel = [], nIdx = Math.min(idx.length, b.mesh.geometry.drawRange.count);
    for (let t = 0; t < nIdx; t += 3) {
      const v = idx[t];
      for (let j = 0; j < vr.length; j += 2) if (v >= vr[j] && v < vr[j + 1]) { sel.push(idx[t], idx[t + 1], idx[t + 2]); break; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', b.mesh.geometry.getAttribute('position'));
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(sel), 1));
    g.boundingBox = b.mesh.geometry.boundingBox; g.boundingSphere = b.mesh.geometry.boundingSphere;
    const o = new THREE.Mesh(g, matOverlay);
    o.renderOrder = 999; o.matrixAutoUpdate = false; o.matrix.copy(b.mesh.matrix); o.matrixWorldNeedsUpdate = true;
    L.group.add(o); b.overlay = o;
  }
}
function dropOverlay(b) { if (b.overlay) { b.overlay.parent?.remove(b.overlay); b.overlay.geometry.deleteAttribute('position'); b.overlay.geometry.dispose(); b.overlay = null; } }
function clearHilite() {
  hilite = null; markerAt = null;
  for (const t of tiles) for (const lod of ['c', 'f']) if (t.L[lod].state === 'ready') for (const b of t.L[lod].batches) {
    if (b.orig) { b.col.set(b.orig); b.orig = null; b.mesh.geometry.getAttribute('color').needsUpdate = true; }
    dropOverlay(b);
  }
  dirty = true;
}
function highlight(a, b) {
  clearHilite(); hilite = { a, b };
  for (const t of tiles) for (const lod of ['c', 'f']) if (t.L[lod].state === 'ready') applyHilite(t.L[lod], hilite);
  dirty = true;
}

// ---------------- camera moves ----------------
let anim = null;
function flyToBox(box, pad = 1.6, minDist = 0) {
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5) * pad;
  const vf = THREE.MathUtils.degToRad(camera.fov / 2), hf = Math.atan(Math.tan(vf) * camera.aspect);
  const dist = Math.max(r / Math.sin(Math.min(vf, hf)), minDist);
  let dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(1, -1, 0.7);
  dir.normalize();
  if (Math.abs(dir.z) > 0.95) dir.set(0.6, -0.6, 0.5).normalize();
  const toPos = c.clone().addScaledVector(dir, dist);
  anim = { t0: performance.now(), dur: 700, p0: camera.position.clone(), q0: controls.target.clone(), p1: toPos, q1: c };
  setNearFar(dist);
}
function setNearFar(dist) {
  camera.near = Math.max(dist / 2000, 0.02); camera.far = Math.max(dist * 60, 5000); camera.updateProjectionMatrix();
}
// Box holding the bulk of the plant: centred on the triangle-weighted median of tile centres, radius
// covering 75% of the triangles - long pipelines and far survey points do not shrink the view.
function mainBox() {
  const tot = tiles.reduce((s, t) => s + t.meta.t, 0);
  const c = new THREE.Vector3();
  for (const ax of ["x", "y", "z"]) {
    const arr = tiles.map(t => [(t.box.min[ax] + t.box.max[ax]) / 2, t.meta.t]).sort((p, q) => p[0] - q[0]);
    let acc = 0; for (const [v, w] of arr) { acc += w; if (acc >= tot / 2) { c[ax] = v; break; } }
  }
  const d = tiles.map(t => [t.box.distanceToPoint(c), t.meta.t]).sort((p, q) => p[0] - q[0]);
  let acc = 0, r = 50;
  for (const [v, w] of d) { acc += w; if (acc >= tot * 0.75) { r = Math.max(v, 50); break; } }
  const b = new THREE.Box3(c.clone().subScalar(r), c.clone().addScalar(r));
  b.min.z = Math.max(b.min.z, c.z - 30); b.max.z = Math.min(b.max.z, c.z + 60);
  return b;
}
function modelBox() {
  const b = new THREE.Box3();
  for (const t of tiles) b.union(t.box);
  return b;
}

// ---------------- search ----------------
const norm = s => s.toUpperCase().replace(/[\s_\-:./]/g, '');
let searchKeys = [];
function buildSearch() {
  searchKeys = named.map(r => norm(r[2]));
}
function nameOf(id) { const r = namedById.get(id); return r ? r[2] : ''; }
function runSearch(q) {
  const res = $('results');
  const nq = norm(q);
  if (nq.length < 2) { res.classList.remove('show'); res.innerHTML = ''; return; }
  const hits = [];
  for (let i = 0; i < named.length && hits.length < 400; i++) {
    const k = searchKeys[i], p = k.indexOf(nq);
    if (p >= 0) hits.push([p === 0 ? 0 : 1, k.length, i]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const shown = hits.slice(0, 60);
  res.innerHTML = shown.map(([, , i]) => {
    const r = named[i];
    const parent = r[4] >= 0 ? nameOf(r[4]) : '';
    return `<div class="r" data-i="${i}"><div class="n">${esc(r[2])}</div><div class="s">${esc(r[3] || '')}${parent ? ' · ' + esc(parent) : ''}</div></div>`;
  }).join('') + (hits.length > shown.length ? `<div class="more">還有 ${hits.length >= 400 ? '400+' : hits.length - shown.length} 筆，請輸入更完整的位號</div>` : '') +
    (hits.length === 0 ? '<div class="more">找不到符合的位號</div>' : '');
  res.classList.add('show');
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function rowBox(r) { return new THREE.Box3(new THREE.Vector3(r[5], r[6], r[7]), new THREE.Vector3(r[8], r[9], r[10])); }

let markerAt = null, markerName = '';
function selectNamed(r, fly = true) {
  if (isHidden(r[0]) || isHidden(r[1])) {
    userHidden = userHidden.filter(([a, b]) => b < r[0] || a > r[1]);
    rebuildHideList();
    if (isHidden(r[0]) || isHidden(r[1])) showVols = true;
    refreshHidden();
  }
  highlight(r[0], r[1]);
  markerAt = rowBox(r).getCenter(new THREE.Vector3()); markerName = r[2];
  const box = rowBox(r);
  if (fly) sectionOn = true;
  const sec = box.clone().expandByScalar(Math.max(box.getSize(_v).length() * 0.5, 3));
  if (sectionOn) setSection(sec);
  if (fly) flyToBox(box, 1.6, sec.getSize(_v).length() * 0.6);
  showInfo(r);
  wantSchedule = true;
}

// properties live in chunk files (sorted by item id) and are fetched when first needed
const propCache = new Map();
async function propsFor(id) {
  const pc = index.props; if (!pc || !pc.length) return null;
  let lo = 0, hi = pc.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pc[m][0] <= id) lo = m; else hi = m - 1; }
  if (pc[lo][0] > id) return null;
  let p = propCache.get(lo);
  if (!p) { p = fetchSealed(`data/props/${pc[lo][1]}`).then(b => JSON.parse(new TextDecoder().decode(b))); propCache.set(lo, p); }
  try { return (await p)[id] || null; } catch (e) { propCache.delete(lo); throw e; }
}
function showInfo(r) {
  $('infoTitle').textContent = r[2];
  const chain = [];
  for (let p = r[4]; p >= 0; p = namedById.get(p)?.[4] ?? -1) chain.unshift(p);
  const o = index.origin, box = rowBox(r), sz = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const rows = [
    ['類別', esc(r[3] || '')],
    ['所屬', `<span class="path">${chain.map(id => `<span data-id="${id}">${esc(nameOf(id))}</span>`).join(' › ') || '—'}</span>`],
    ['尺寸', `${sz.x.toFixed(2)} × ${sz.y.toFixed(2)} × ${sz.z.toFixed(2)} ${index.units === 'Meters' ? 'm' : index.units}`],
    ['中心', `E ${(c.x + o[0]).toFixed(2)}　N ${(c.y + o[1]).toFixed(2)}　EL ${(c.z + o[2]).toFixed(2)}`],
  ];
  $('infoBody').innerHTML = `<div class="actions"><button id="infoWhere">看在全廠哪裡</button><button id="infoFly">移到這裡</button><button id="infoSect">剖面盒框住</button><button id="infoHide">隱藏</button></div>
    <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}<tbody id="propRows"></tbody></table>`;
  $('infoWhere').onclick = () => { sectionOn = false; setSection(null); flyToBox(mainBox(), 1.0); wantSchedule = true; };
  $('infoFly').onclick = () => { const b = rowBox(r), sec = b.clone().expandByScalar(Math.max(b.getSize(_v).length() * 0.5, 3)); sectionOn = true; setSection(sec); flyToBox(b, 1.6, sec.getSize(_v).length() * 0.6); wantSchedule = true; };
  $('infoSect').onclick = () => { sectionOn = true; setSection(rowBox(r).expandByScalar(Math.max(rowBox(r).getSize(_v).length() * 0.3, 3))); flyToBox(rowBox(r)); wantSchedule = true; };
  $('infoHide').onclick = () => {
    userHidden.push([r[0], r[1]]); clearHilite(); refreshHidden();
    $('info').classList.remove('show'); updateViewOffset();
  };
  $('infoBody').querySelectorAll('.path span[data-id]').forEach(el => el.onclick = () => { const x = namedById.get(+el.dataset.id); if (x) selectNamed(x); });
  $('info').classList.add('show');
  updateViewOffset();
  const want = r[0];
  propsFor(want).then(props => {
    const tb = $('propRows');
    if (!props || !tb || $('infoTitle').textContent !== r[2]) return;
    const out = [];
    for (const cat in props) for (const k in props[cat]) out.push(`<tr><td>${esc(k)}</td><td>${esc(props[cat][k])}</td></tr>`);
    tb.innerHTML = out.join('');
  }).catch(e => console.error(e));
}

// ---------------- picking ----------------
const raycaster = new THREE.Raycaster();
function pick(clientX, clientY) {
  const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const meshes = [];
  const owner = new Map();
  for (const t of tiles) if (raycaster.ray.intersectsBox(t.box)) for (const lod of ['c', 'f']) { const L = t.L[lod]; if (L.state === 'ready' && L.group.visible) for (const b of L.batches) { meshes.push(b.mesh); owner.set(b.mesh, b); } }
  let hits = raycaster.intersectObjects(meshes, false);
  if (clipPlanes.length) hits = hits.filter(h => clipPlanes.every(p => p.distanceToPoint(h.point) >= -1e-3));
  if (!hits.length) return null;
  const h = hits[0];
  const b = owner.get(h.object);
  const v = h.face.a, r = b.ranges;
  let lo = 0, hi = r.length / 3 - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (r[mid * 3 + 1] <= v) lo = mid; else hi = mid - 1; }
  return { itemId: r[lo * 3], point: h.point };
}
// nearest named ancestor of a geometry item: named rows are sorted by id and nested by [id,end]
function namedFor(itemId) {
  let best = null;
  let lo = 0, hi = named.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (named[m][0] <= itemId) lo = m + 1; else hi = m - 1; }
  for (let i = hi; i >= 0; i--) {
    const r = named[i];
    if (r[1] >= itemId) { best = r; break; }
  }
  return best;
}

// Zoom speed follows the distance of whatever is under the cursor / pinch centre: at the start of a
// zoom gesture the orbit pivot is moved onto the view axis at that depth (the camera does not turn),
// so pinching towards far equipment covers ground quickly and near equipment slows down.
let lastRetarget = 0;
function retargetAt(clientX, clientY) {
  const now = performance.now();
  if (now - lastRetarget < 250 || anim) return;
  lastRetarget = now;
  const hit = pick(clientX, clientY);
  if (!hit) return;
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  const depth = hit.point.clone().sub(camera.position).dot(fwd);
  if (!(depth > 0)) return;
  controls.target.copy(camera.position).addScaledVector(fwd, Math.max(depth, PUSH_MIN * 1.5));
  lastDist = null;
}
canvas.addEventListener('wheel', e => retargetAt(e.clientX, e.clientY), { passive: true });
const touchPts = new Map();
canvas.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  touchPts.set(e.pointerId, [e.clientX, e.clientY]);
  if (touchPts.size === 2) { const [a, b] = [...touchPts.values()]; lastRetarget = 0; retargetAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); }
});
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, e => touchPts.delete(e.pointerId));

let downAt = null, lastTap = 0;
canvas.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8 || performance.now() - downAt.t > 400) return;
  const now = performance.now();
  const hit = pick(e.clientX, e.clientY);
  if (now - lastTap < 350) {             // double tap: orbit around that point
    if (hit) { anim = { t0: now, dur: 400, p0: camera.position.clone(), q0: controls.target.clone(), p1: camera.position.clone().add(hit.point.clone().sub(controls.target)), q1: hit.point.clone() }; }
    lastTap = 0; return;
  }
  lastTap = now;
  if (!hit) return;
  const r = namedFor(hit.itemId);
  if (r) selectNamed(r, false);
});

// ---------------- UI ----------------
let searchTimer = 0;
$('q').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(e.target.value), 120); });
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') { const first = $('results').querySelector('.r'); if (first) first.click(); } });
$('q').addEventListener('focus', () => { if ($('q').value) runSearch($('q').value); });
$('results').addEventListener('click', e => {
  const el = e.target.closest('.r'); if (!el) return;
  const r = named[+el.dataset.i];
  $('results').classList.remove('show'); $('q').blur();
  selectNamed(r);
});
canvas.addEventListener('pointerdown', () => { $('results').classList.remove('show'); $('q').blur(); });
$('infoClose').onclick = () => { $('info').classList.remove('show'); updateViewOffset(); };
$('btnHome').onclick = () => { flyToBox(mainBox(), 1.0); };
$('btnSection').onclick = () => {
  sectionOn = !sectionOn;
  if (sectionOn && !sectionBox) {
    const c = controls.target, r = Math.max(camera.position.distanceTo(c) * 0.5, 5);
    sectionBox = new THREE.Box3(c.clone().subScalar(r), c.clone().addScalar(r));
  }
  setSection(sectionBox); wantSchedule = true;
};
$('btnXray').onclick = () => setXray(!xray);
$('btnClear').onclick = () => { clearHilite(); sectionOn = false; setSection(null); $('info').classList.remove('show'); updateViewOffset(); wantSchedule = true; };

// ring marker on the selected item, so even a 20 cm support is easy to spot
function placeMarker() {
  const m = $('marker');
  if (!markerAt) { m.style.display = 'none'; return; }
  const p = markerAt.clone().project(camera);
  if (p.z > 1 || p.z < -1) { m.style.display = 'none'; return; }
  m.style.display = 'block';
  m.style.transform = `translate(${(p.x + 1) / 2 * innerWidth - 22}px, ${(1 - p.y) / 2 * innerHeight - 22}px)`;
  $('markerLabel').textContent = markerName;
}
// ---------------- minimap ----------------
// A top-down picture of the plant rendered once (after the coarse layer is in), with the selected
// item and the current camera drawn on top. Tapping it moves the view there.
const mm = { img: null, box: null, ready: false };
function buildMinimap() {
  if (mm.ready) return;
  const box = mainBox(), c = box.getCenter(new THREE.Vector3());
  const s = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * 0.75;
  mm.box = { x0: c.x - s, x1: c.x + s, y0: c.y - s, y1: c.y + s };
  const N = 512;
  const cam = new THREE.OrthographicCamera(-s, s, s, -s, 1, 6000);
  cam.up.set(0, 1, 0); cam.position.set(c.x, c.y, c.z + 3000); cam.lookAt(c.x, c.y, c.z);
  const rt = new THREE.WebGLRenderTarget(N, N); rt.texture.colorSpace = THREE.SRGBColorSpace;
  const clip = renderer.localClippingEnabled, wasX = xray;
  renderer.localClippingEnabled = false; if (wasX) setXray(false);
  const hidden = [];
  for (const t of tiles) for (const b of (t.L.f.batches || []).concat(t.L.c.batches || [])) if (b.overlay) { b.overlay.visible = false; hidden.push(b.overlay); }
  renderer.setRenderTarget(rt); renderer.render(scene, cam); renderer.setRenderTarget(null);
  renderer.localClippingEnabled = clip; if (wasX) setXray(true); for (const o of hidden) o.visible = true;
  const px = new Uint8Array(N * N * 4); renderer.readRenderTargetPixels(rt, 0, 0, N, N, px); rt.dispose();
  const off = document.createElement('canvas'); off.width = off.height = N;
  const ctx = off.getContext('2d'), img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) img.data.set(px.subarray((N - 1 - y) * N * 4, (N - y) * N * 4), y * N * 4);
  ctx.putImageData(img, 0, 0);
  mm.img = off; mm.ready = true; dirty = true;
}
function mmToPx(x, y, W, H) { return [(x - mm.box.x0) / (mm.box.x1 - mm.box.x0) * W, (1 - (y - mm.box.y0) / (mm.box.y1 - mm.box.y0)) * H]; }
function drawMinimap() {
  const cv = $('minimap');
  if (!mm.ready || cv.classList.contains('off')) return;
  const dpr = Math.min(devicePixelRatio, 2), W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.drawImage(mm.img, 0, 0, W, H);
  const clampP = ([x, y]) => [Math.min(Math.max(x, 6 * dpr), W - 6 * dpr), Math.min(Math.max(y, 6 * dpr), H - 6 * dpr)];
  // camera: position dot + viewing wedge
  const [cx, cy] = clampP(mmToPx(camera.position.x, camera.position.y, W, H));
  const d = controls.target.clone().sub(camera.position);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(-d.y, d.x));
  ctx.fillStyle = 'rgba(40,120,255,0.35)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 26 * dpr, -0.45, 0.45); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#2878ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr;
  ctx.beginPath(); ctx.arc(0, 0, 5 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  if (markerAt) {
    const [mx, my] = clampP(mmToPx(markerAt.x, markerAt.y, W, H));
    const pulse = 6 + 3 * Math.sin(performance.now() / 200);
    ctx.fillStyle = '#ff3b1e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath(); ctx.arc(mx, my, pulse * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}
$('minimap').addEventListener('pointerup', e => {
  if (!mm.ready) return;
  const r = e.currentTarget.getBoundingClientRect();
  const x = mm.box.x0 + (e.clientX - r.left) / r.width * (mm.box.x1 - mm.box.x0);
  const y = mm.box.y1 - (e.clientY - r.top) / r.height * (mm.box.y1 - mm.box.y0);
  const q1 = new THREE.Vector3(x, y, controls.target.z);
  if (sectionOn && sectionBox && !sectionBox.containsPoint(q1)) { sectionOn = false; setSection(null); }
  anim = { t0: performance.now(), dur: 600, p0: camera.position.clone(), q0: controls.target.clone(), p1: camera.position.clone().add(q1.clone().sub(controls.target)), q1 };
  wantSchedule = true;
});
$('btnHQ').classList.toggle('on', hq);
$('btnHQ').onclick = () => {
  hq = !hq; markHqRun();
  try { if (hq) localStorage.setItem(HQ_KEY, '1'); else localStorage.removeItem(HQ_KEY); } catch { }
  $('btnHQ').classList.toggle('on', hq); wantSchedule = true;
};
$('btnVols').onclick = () => { showVols = !showVols; refreshHidden(); };
$('btnUnhide').onclick = () => { userHidden = []; refreshHidden(); };
$('btnMap').onclick = () => {
  const cv = $('minimap'); cv.classList.toggle('off');
  $('btnMap').classList.toggle('on', !cv.classList.contains('off')); dirty = true;
};

// ---------------- loop ----------------
let lastSchedule = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (anim) {
    const k = Math.min((now - anim.t0) / anim.dur, 1), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(anim.p0, anim.p1, e); controls.target.lerpVectors(anim.q0, anim.q1, e);
    if (k >= 1) anim = null;
    dirty = true; wantSchedule = true;
  }
  if (controls.update()) dirty = true;
  if (markerAt && mm.ready && now - (frame.lastPulse || 0) > 50) { frame.lastPulse = now; drawMinimap(); }
  if (!mm.ready && tiles.length && tiles.every(t => !hasCoarse(t) || t.L.c.state === 'ready' || t.L.c.state === 'error')) buildMinimap();
  if (wantSchedule && now - lastSchedule > 300) { lastSchedule = now; schedule(); }
  if (dirty) {
    setNearFar(camera.position.distanceTo(controls.target));
    renderer.render(scene, camera); dirty = false;
    placeMarker();
    drawMinimap();
  }
}

// ---------------- boot ----------------
async function unlock(pass, remember) {
  $('lockMsg').className = ''; $('lockMsg').textContent = '驗證中…'; $('unlockBtn').disabled = true;
  try {
    const manifest = await (await fetch('data/manifest.json', { cache: 'no-store' })).json();
    urlMap = manifest.map || {};
    aesKey = await deriveKey(pass, manifest);
    let bytes;
    const vols = fetchSealed('hidden.bin').then(b => JSON.parse(new TextDecoder().decode(b))).catch(e => { console.warn('no hidden.bin', e); return []; });
    try { bytes = await fetchSealed('data/index.bin'); }
    catch (e) { if (e.name === 'OperationError') throw new Error('密鑰錯誤'); throw e; }
    index = JSON.parse(new TextDecoder().decode(bytes));
    volRanges = await vols; rebuildHideList();
    startWorkers();
    try { if (remember) localStorage.setItem(REMEMBER_KEY, pass); else localStorage.removeItem(REMEMBER_KEY); } catch { }
    start();
  } catch (e) {
    $('lockMsg').className = 'err'; $('lockMsg').textContent = e.message || String(e);
    try { localStorage.removeItem(REMEMBER_KEY); } catch { }
  } finally { $('unlockBtn').disabled = false; }
}

window.__nwv = { camera, controls, tiles, get named() { return named; }, get hilite() { return hilite; } };
function start() {
  $('lock').style.display = 'none';
  document.title = index.doc.replace(/\.nwd$/i, '');
  named = index.named;
  for (const r of named) namedById.set(r[0], r);
  buildSearch();
  for (const m of index.tiles) tiles.push({ meta: m, box: new THREE.Box3(new THREE.Vector3(m.b[0], m.b[1], m.b[2]), new THREE.Vector3(m.b[3], m.b[4], m.b[5])), L: { c: { state: 'idle' }, f: { state: 'idle' } } });
  resize();
  const box = mainBox();
  const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
  const vf0 = THREE.MathUtils.degToRad(camera.fov / 2), hf0 = Math.atan(Math.tan(vf0) * camera.aspect);
  const d0 = r / Math.sin(Math.min(vf0, hf0));
  controls.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(1, -1, 0.75).normalize().multiplyScalar(d0));
  setNearFar(camera.position.distanceTo(c));
  controls.update();
  wantSchedule = true;
  refreshHidden();
  requestAnimationFrame(frame);
  if (hqCrashed) setTimeout(() => alert('上次開「高畫質」時頁面記憶體不足被重新載入，已自動切回標準畫質。'), 300);
}

$('lockForm').addEventListener('submit', e => { e.preventDefault(); unlock($('pass').value, $('remember').checked); });
try { const saved = localStorage.getItem(REMEMBER_KEY); if (saved) { $('remember').checked = true; unlock(saved, true); } } catch { }
