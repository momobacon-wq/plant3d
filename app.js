import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.mjs';

const $ = id => document.getElementById(id);
const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const TRI_BUDGET = IS_MOBILE ? 6e6 : 20e6;     // triangles kept on the GPU at once
const MAX_PARALLEL = 3;
const HILITE = [255, 60, 30, 255];
const REMEMBER_KEY = 'nwv.pass';

// ---------------- crypto ----------------
let aesKey = null;
async function deriveKey(pass, manifest) {
  const salt = Uint8Array.from(atob(manifest.salt), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: manifest.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function fetchSealed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, aesKey, buf.subarray(12));
  const ds = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

// ---------------- scene ----------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_MOBILE, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, IS_MOBILE ? 2 : 1.5));
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
controls.addEventListener('change', () => { dirty = true; wantSchedule = true; });

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
// TRI_BUDGET). While the fine layer is on screen the coarse one is hidden.
const tiles = [];          // {meta, box, L:{c:Layer, f:Layer}};  Layer = {state, group, batches, tris}
let loadedTris = 0, inflight = 0;
let hilite = null;         // {a, b} item id range

// NWT2 tile -> baked meshes (one per opaque / transparent batch), positions quantised to the tile box.
function parseTile(bytes, box) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x3254574e) throw new Error('bad tile');
  const jl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jl)));
  const p4 = n => (n + 3) & ~3;
  let o = 8 + p4(jl);
  const instOff = o; o += head.nInst * 56;
  // decode unique meshes into local float positions + unit normals
  const meshes = head.meshes.map(([nv, ni, vbl, ibl, mx, my, mz, ex, ey, ez]) => {
    const vb = new Uint8Array(nv * 8);
    MeshoptDecoder.decodeVertexBuffer(vb, nv, 8, bytes.subarray(o, o + vbl)); o += p4(vbl);
    const ib = new Uint8Array(ni * 4);
    MeshoptDecoder.decodeIndexBuffer(ib, ni, 4, bytes.subarray(o, o + ibl)); o += p4(ibl);
    const q = new Uint16Array(vb.buffer), s8 = new Int8Array(vb.buffer);
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      pos[v * 3] = mx + q[v * 4] / 65535 * ex; pos[v * 3 + 1] = my + q[v * 4 + 1] / 65535 * ey; pos[v * 3 + 2] = mz + q[v * 4 + 2] / 65535 * ez;
      let x = s8[v * 8 + 6] / 127, y = s8[v * 8 + 7] / 127, z = 1 - Math.abs(x) - Math.abs(y);
      if (z < 0) { const px = x; x = (1 - Math.abs(y)) * (px >= 0 ? 1 : -1); y = (1 - Math.abs(px)) * (y >= 0 ? 1 : -1); }
      const l = Math.hypot(x, y, z) || 1; nrm[v * 3] = x / l; nrm[v * 3 + 1] = y / l; nrm[v * 3 + 2] = z / l;
    }
    return { nv, ni, pos, nrm, idx: new Uint32Array(ib.buffer) };
  });
  // two passes over the instances: count, then bake
  const items = head.items;
  const batchOf = li => (items[li][4] < 250 ? 1 : 0);
  const cnt = [{ v: 0, i: 0 }, { v: 0, i: 0 }];
  for (let k = 0; k < head.nInst; k++) {
    const li = dv.getInt32(instOff + k * 56, true), ml = dv.getInt32(instOff + k * 56 + 4, true);
    const b = cnt[batchOf(li)]; b.v += meshes[ml].nv; b.i += meshes[ml].ni;
  }
  const tmin = [box.min.x, box.min.y, box.min.z];
  const sc = [0, 1, 2].map(a => Math.max([box.max.x, box.max.y, box.max.z][a] - tmin[a], 1e-3) / 65535);
  const out = [];
  const B = cnt.map(c => c.v ? { pos: new Uint16Array(c.v * 3 + (c.v * 3) % 2), nrm: new Int8Array(c.v * 4), col: new Uint8Array(c.v * 4), idx: new Uint32Array(c.i), nv: 0, ni: 0, ranges: [], lastItem: -1 } : null);
  for (let k = 0; k < head.nInst; k++) {
    const io = instOff + k * 56;
    const li = dv.getInt32(io, true), ml = dv.getInt32(io + 4, true);
    const m = new Float32Array(12);
    for (let j = 0; j < 12; j++) m[j] = dv.getFloat32(io + 8 + j * 4, true);
    const mesh = meshes[ml], bt = B[batchOf(li)], it = items[li];
    if (bt.lastItem !== li) { bt.ranges.push(it[0], bt.nv, 0); bt.lastItem = li; }
    const v0 = bt.nv;
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    for (let v = 0; v < mesh.nv; v++) {
      const x = mesh.pos[v * 3], y = mesh.pos[v * 3 + 1], z = mesh.pos[v * 3 + 2];
      const w0 = x * m[0] + y * m[3] + z * m[6] + m[9], w1 = x * m[1] + y * m[4] + z * m[7] + m[10], w2 = x * m[2] + y * m[5] + z * m[8] + m[11];
      const d = (bt.nv + v) * 3;
      bt.pos[d] = Math.min(65535, Math.max(0, Math.round((w0 - tmin[0]) / sc[0])));
      bt.pos[d + 1] = Math.min(65535, Math.max(0, Math.round((w1 - tmin[1]) / sc[1])));
      bt.pos[d + 2] = Math.min(65535, Math.max(0, Math.round((w2 - tmin[2]) / sc[2])));
      const nx = mesh.nrm[v * 3], ny = mesh.nrm[v * 3 + 1], nz = mesh.nrm[v * 3 + 2];
      // world normal, then pre-multiplied by the quantisation scale (cancels the mesh scale in the normal matrix)
      let a = (nx * m[0] + ny * m[3] + nz * m[6]) * sc[0], b = (nx * m[1] + ny * m[4] + nz * m[7]) * sc[1], c = (nx * m[2] + ny * m[5] + nz * m[8]) * sc[2];
      const l = Math.hypot(a, b, c) || 1;
      const n4 = (bt.nv + v) * 4;
      bt.nrm[n4] = Math.round(a / l * 127); bt.nrm[n4 + 1] = Math.round(b / l * 127); bt.nrm[n4 + 2] = Math.round(c / l * 127);
      bt.col[n4] = it[1]; bt.col[n4 + 1] = it[2]; bt.col[n4 + 2] = it[3]; bt.col[n4 + 3] = it[4];
    }
    for (let i = 0; i < mesh.ni; i += 3) {
      const a = mesh.idx[i] + v0, b = mesh.idx[i + 1] + v0, c = mesh.idx[i + 2] + v0;
      if (det < 0) { bt.idx[bt.ni++] = a; bt.idx[bt.ni++] = c; bt.idx[bt.ni++] = b; }
      else { bt.idx[bt.ni++] = a; bt.idx[bt.ni++] = b; bt.idx[bt.ni++] = c; }
    }
    bt.nv += mesh.nv;
    bt.ranges[bt.ranges.length - 1] += mesh.nv;
  }
  for (let bi = 0; bi < 2; bi++) {
    const bt = B[bi]; if (!bt) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(bt.pos.subarray(0, bt.nv * 3), 3));
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(bt.nrm, 4), 3, 0, true));
    g.setAttribute('color', new THREE.BufferAttribute(bt.col, 4, true));
    g.setIndex(new THREE.BufferAttribute(bt.idx, 1));
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(65535, 65535, 65535));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, bi ? matTrans : matOpaque);
    mesh.position.set(tmin[0], tmin[1], tmin[2]); mesh.scale.set(sc[0], sc[1], sc[2]);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    out.push({ mesh, ranges: Int32Array.from(bt.ranges), col: bt.col, orig: null });
  }
  return out;
}

function layerTris(t, lod) { return lod === 'f' ? t.meta.t : t.meta.ct; }

async function loadLayer(t, lod) {
  const L = t.L[lod];
  L.state = 'loading'; inflight++;
  try {
    const bytes = await fetchSealed(lod === 'f' ? `${t.meta.u || 'data/tiles/'}${t.meta.f}` : `data/tiles/${t.meta.c}`);
    if (L.state !== 'loading') return;             // cancelled meanwhile
    L.batches = parseTile(bytes, t.box);
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
    inflight--; dirty = true; updateStatus(); queueMicrotask(schedule);
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
let wantSchedule = true;
function schedule() {
  wantSchedule = false;
  camera.updateMatrixWorld();
  _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); _frustum.setFromProjectionMatrix(_pm);
  const focus = controls.target;
  const viewDist = camera.position.distanceTo(focus);
  for (const t of tiles) {
    const d = t.box.distanceToPoint(focus);
    const inView = _frustum.intersectsBox(t.box);
    const inSection = !sectionOn || !sectionBox || sectionBox.intersectsBox(t.box);
    t.prio = inSection ? (inView ? 1 : 3) * (d + viewDist * 0.05 + 1) : Infinity;
  }
  const order = tiles.slice().sort((a, b) => a.prio - b.prio);
  let budget = 0;
  for (const t of tiles) if (t.meta.c) budget += t.meta.ct;
  const keep = new Set();
  for (const t of order) {
    if (t.prio === Infinity) break;
    if (budget + t.meta.t > TRI_BUDGET) break;
    budget += t.meta.t; keep.add(t);
  }
  for (const t of tiles) if (t.L.f.state !== 'idle' && t.L.f.state !== 'error' && !keep.has(t)) unloadLayer(t, 'f');
  for (const t of order) {                       // coarse first, nearest first
    if (inflight >= MAX_PARALLEL) break;
    if (t.meta.c && t.L.c.state === 'idle') loadLayer(t, 'c');
  }
  for (const t of order) {
    if (inflight >= MAX_PARALLEL) break;
    if (keep.has(t) && t.L.f.state === 'idle') loadLayer(t, 'f');
  }
  updateStatus();
}

function updateStatus() {
  const f = tiles.filter(t => t.L.f.state === 'ready').length;
  const c = tiles.filter(t => t.L.c.state === 'ready').length, cn = tiles.filter(t => t.meta.c).length;
  $('status').textContent = `${c < cn ? `概覽 ${c}/${cn} · ` : ''}精細 ${f}/${tiles.length} 區 · ${(loadedTris / 1e6).toFixed(1)}M 面${inflight ? ' · 載入中' : ''}`;
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
    const idx = b.mesh.geometry.index.array, sel = [];
    for (let t = 0; t < idx.length; t += 3) {
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

let markerAt = null;
function selectNamed(r, fly = true) {
  highlight(r[0], r[1]);
  markerAt = rowBox(r).getCenter(new THREE.Vector3());
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
  $('infoBody').innerHTML = `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}<tbody id="propRows"></tbody></table>
    <div class="actions"><button id="infoFly">移到這裡</button><button id="infoSect">剖面盒框住</button></div>`;
  $('infoFly').onclick = () => flyToBox(rowBox(r));
  $('infoSect').onclick = () => { sectionOn = true; setSection(rowBox(r).expandByScalar(Math.max(rowBox(r).getSize(_v).length() * 0.3, 3))); flyToBox(rowBox(r)); wantSchedule = true; };
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
}
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
  if (wantSchedule && now - lastSchedule > 300) { lastSchedule = now; schedule(); }
  if (dirty) {
    setNearFar(camera.position.distanceTo(controls.target));
    renderer.render(scene, camera); dirty = false;
    placeMarker();
  }
}

// ---------------- boot ----------------
async function unlock(pass, remember) {
  $('lockMsg').className = ''; $('lockMsg').textContent = '驗證中…'; $('unlockBtn').disabled = true;
  try {
    const manifest = await (await fetch('data/manifest.json', { cache: 'no-store' })).json();
    aesKey = await deriveKey(pass, manifest);
    let bytes;
    try { bytes = await fetchSealed('data/index.bin'); }
    catch (e) { if (e.name === 'OperationError') throw new Error('密鑰錯誤'); throw e; }
    index = JSON.parse(new TextDecoder().decode(bytes));
    try { if (remember) localStorage.setItem(REMEMBER_KEY, pass); else localStorage.removeItem(REMEMBER_KEY); } catch { }
    start();
  } catch (e) {
    $('lockMsg').className = 'err'; $('lockMsg').textContent = e.message || String(e);
    try { localStorage.removeItem(REMEMBER_KEY); } catch { }
  } finally { $('unlockBtn').disabled = false; }
}

window.__nwv = { tiles, get named() { return named; }, get hilite() { return hilite; } };
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
  requestAnimationFrame(frame);
}

$('lockForm').addEventListener('submit', e => { e.preventDefault(); unlock($('pass').value, $('remember').checked); });
try { const saved = localStorage.getItem(REMEMBER_KEY); if (saved) { $('remember').checked = true; unlock(saved, true); } } catch { }
