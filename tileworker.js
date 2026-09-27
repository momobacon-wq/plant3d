// Tile loading off the main thread: fetch (CDN with fallback), AES-GCM decrypt, gunzip, meshopt decode
// and bake instances into quantised batch arrays. The main thread only wraps the arrays in meshes, so
// touch gestures stay smooth while tiles stream in.
import { MeshoptDecoder } from './vendor/meshopt_decoder.mjs';

let key = null, urlMap = {};
const bundles = new Map();

async function fetchOnce(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
async function fetchBytes(url) {
  for (const p in urlMap) if (url.startsWith(p)) {
    try { return await fetchOnce(urlMap[p] + url.slice(p.length)); } catch (e) { /* fall back to Pages */ }
    break;
  }
  return fetchOnce(url);
}
async function openSealed(buf) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
  const ds = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}
function bundle(url) {
  let p = bundles.get(url);
  if (!p) { p = fetchBytes(url); p.catch(() => bundles.delete(url)); bundles.set(url, p); }
  return p;
}

// NWT2 tile -> batches (opaque / transparent), positions quantised to the tile box
function parseTile(bytes, bx) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x3254574e) throw new Error('bad tile');
  const jl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jl)));
  const p4 = n => (n + 3) & ~3;
  let o = 8 + p4(jl);
  const instOff = o; o += head.nInst * 56;
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
  const items = head.items;
  const batchOf = li => (items[li][4] < 250 ? 1 : 0);
  const cnt = [{ v: 0, i: 0 }, { v: 0, i: 0 }];
  for (let k = 0; k < head.nInst; k++) {
    const li = dv.getInt32(instOff + k * 56, true), ml = dv.getInt32(instOff + k * 56 + 4, true);
    const b = cnt[batchOf(li)]; b.v += meshes[ml].nv; b.i += meshes[ml].ni;
  }
  const tmin = [bx[0], bx[1], bx[2]];
  const sc = [0, 1, 2].map(a => Math.max(bx[3 + a] - tmin[a], 1e-3) / 65535);
  const B = cnt.map(c => c.v ? { pos: new Uint16Array(c.v * 3), nrm: new Int8Array(c.v * 4), col: new Uint8Array(c.v * 4), idx: new Uint32Array(c.i), nv: 0, ni: 0, ranges: [], lastItem: -1 } : null);
  const m = new Float32Array(12);
  for (let k = 0; k < head.nInst; k++) {
    const io = instOff + k * 56;
    const li = dv.getInt32(io, true), ml = dv.getInt32(io + 4, true);
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
      // world normal pre-multiplied by the quantisation scale (cancels the mesh scale in the normal matrix)
      const a = (nx * m[0] + ny * m[3] + nz * m[6]) * sc[0], b = (nx * m[1] + ny * m[4] + nz * m[7]) * sc[1], c = (nx * m[2] + ny * m[5] + nz * m[8]) * sc[2];
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
  const out = [];
  for (let bi = 0; bi < 2; bi++) {
    const bt = B[bi]; if (!bt) continue;
    out.push({ transparent: bi === 1, tmin, sc, pos: bt.pos, nrm: bt.nrm, col: bt.col, idx: bt.idx, ranges: Int32Array.from(bt.ranges) });
  }
  return out;
}

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'init') { key = msg.key; urlMap = msg.urlMap || {}; await MeshoptDecoder.ready; return; }
  try {
    await MeshoptDecoder.ready;
    const sealed = msg.bundle ? (await bundle(msg.url)).subarray(msg.off, msg.off + msg.len) : await fetchBytes(msg.url);
    const batches = parseTile(await openSealed(sealed), msg.box);
    const transfer = [];
    for (const b of batches) transfer.push(b.pos.buffer, b.nrm.buffer, b.col.buffer, b.idx.buffer, b.ranges.buffer);
    self.postMessage({ id: msg.id, batches }, transfer);
  } catch (e) {
    self.postMessage({ id: msg.id, error: String(e && e.message || e) });
  }
};
