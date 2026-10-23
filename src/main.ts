import './style.css';
import type { User } from '@supabase/supabase-js';
import {
  type Config, isAdmin, signIn, signOut, supabase, uploadAsset, downloadAsset,
  listProjects, loadProject, saveProject, deleteProject,
} from './cloud';

const MAX_CODES = 200;
const MAX_LAYERS = 10;

interface Layer { id: number; name: string; img: HTMLImageElement; x: number; y: number; w: number; blob?: Blob; path?: string }
type Bg = { el: HTMLImageElement | HTMLVideoElement; video: boolean; name: string; blob: Blob; path?: string } | null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const num = (id: string): number => Number($<HTMLInputElement>(id).value);
const val = (id: string): string => $<HTMLInputElement>(id).value;
const clamp = (n: number, a: number, b: number): number => Math.min(b, Math.max(a, n));

const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d')!;
const statusEl = $('status');

let bg: Bg = null;
let layers: Layer[] = [];
let selected: number | null = null;
let nextId = 1;
let sequence: string[] = [];
let seqDirty = true;
let t0 = performance.now();
let recording = false;
let recStart = 0;
let recorder: MediaRecorder | null = null;
let box: Layer | null = null;

const settings = () => ({
  duration: clamp(Math.round(num('duration')) || 1, 1, 300),
  random: val('order') === 'random',
});

/* ---------- Códigos ---------- */
const codeInputs: HTMLInputElement[] = [];
const codesBox = $('codes');

for (let i = 0; i < MAX_CODES; i++) {
  const row = document.createElement('div');
  row.className = 'code-row';
  const n = document.createElement('span');
  n.textContent = String(i + 1);
  const inp = document.createElement('input');
  inp.maxLength = 8;
  inp.spellcheck = false;
  inp.autocomplete = 'off';
  inp.addEventListener('input', () => {
    inp.value = inp.value.replace(/\s/g, '').toUpperCase();
    codesChanged();
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); codeInputs[i + 1]?.focus(); }
  });
  inp.addEventListener('paste', (e) => {
    const tokens = (e.clipboardData?.getData('text') ?? '').split(/[\s,;]+/).filter(Boolean);
    if (tokens.length < 2) return;
    e.preventDefault();
    tokens.forEach((t, k) => {
      const target = codeInputs[i + k];
      if (target) target.value = t.slice(0, 8).toUpperCase();
    });
    codesChanged();
  });
  row.append(n, inp);
  codesBox.append(row);
  codeInputs.push(inp);
}

const getCodes = (): string[] => codeInputs.map((i) => i.value.trim()).filter(Boolean);

function codesChanged(): void {
  $('codeCount').textContent = `${getCodes().length} / ${MAX_CODES}`;
  seqDirty = true;
}

$('clearCodes').addEventListener('click', () => {
  if (!getCodes().length || confirm('¿Borrar todos los códigos?')) {
    codeInputs.forEach((i) => (i.value = ''));
    codesChanged();
  }
});

function parsePasted(text: string): { codes: string[]; ignored: number } {
  const codes: string[] = [];
  let ignored = 0;
  let first = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split('\t').map((c) => c.trim()).filter(Boolean);
    const parts = line.split(/[\s,;]+/).filter(Boolean);
    const tokens = cols.length > 1 ? [cols[cols.length - 1]] : parts.length === 2 && /^\d+$/.test(parts[0]) ? [parts[1]] : parts;
    const isHeader = first && /^c[oó]digos?$/i.test(parts[parts.length - 1] ?? '');
    first = false;
    if (isHeader) continue;
    for (const t of tokens) {
      const c = t.toUpperCase();
      if (c.length >= 1 && c.length <= 8) codes.push(c);
      else ignored++;
    }
  }
  return { codes, ignored };
}

const pasteBox = $<HTMLTextAreaElement>('paste');

function loadPasted(): void {
  const { codes, ignored } = parsePasted(pasteBox.value);
  pasteBox.value = '';
  const msg = $('pasteMsg');
  if (!codes.length) {
    msg.textContent = 'No se encontraron códigos válidos (de 1 a 8 caracteres).';
    return;
  }
  const used = codes.slice(0, MAX_CODES);
  codeInputs.forEach((inp, i) => (inp.value = used[i] ?? ''));
  codesChanged();
  let text = `${used.length} códigos cargados y numerados.`;
  if (codes.length > MAX_CODES) text += ` Sobraron ${codes.length - MAX_CODES}: el límite es ${MAX_CODES}.`;
  if (ignored) text += ` Se ignoraron ${ignored} por tener más de 8 caracteres.`;
  msg.textContent = text;
}

pasteBox.addEventListener('paste', () => setTimeout(loadPasted, 0));

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

function rebuild(): void {
  const codes = getCodes();
  sequence = settings().random ? shuffle(codes) : codes;
  seqDirty = false;
  updateRate();
}

function updateRate(): void {
  const n = getCodes().length;
  const d = settings().duration;
  const el = $('rate');
  if (!n) {
    el.textContent = '';
    return;
  }
  const per = n / d;
  el.textContent = `${n} códigos en ${d} s: cada uno se ve ${(d / n).toFixed(2)} s (${per.toFixed(1)} por segundo).`;
  if (per > 30) el.textContent += ` Es demasiado rápido: usá ${Math.ceil(n / 30)} s o más.`;
}

['duration', 'order'].forEach((id) => $(id).addEventListener('input', () => (seqDirty = true)));

function applyRes(): void {
  const [w, h] = val('res').split('x').map(Number);
  canvas.width = w;
  canvas.height = h;
}

$('res').addEventListener('change', applyRes);

/* ---------- Fondo (capa 0) ---------- */
const loadImage = (file: Blob) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('imagen no válida'));
    img.src = URL.createObjectURL(file);
  });

async function setBg(blob: Blob, name: string, video: boolean, path?: string): Promise<void> {
  if (video) {
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.src = URL.createObjectURL(blob);
    await v.play().catch(() => undefined);
    bg = { el: v, video, name, blob, path };
  } else {
    bg = { el: await loadImage(blob), video, name, blob, path };
  }
  $('bgName').textContent = name;
}

$('bgFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    await setBg(f, f.name, f.type.startsWith('video/'));
  } catch {
    statusEl.textContent = `No se pudo abrir el archivo ${f.name}.`;
  }
});

$('bgClear').addEventListener('click', () => {
  bg = null;
  $('bgName').textContent = '';
});

/* ---------- Imágenes (capa 1) ---------- */
function bounds(l: Layer) {
  const W = canvas.width, H = canvas.height;
  const w = (l.w / 100) * W;
  const h = (w * l.img.naturalHeight) / l.img.naturalWidth;
  return { x: (l.x / 100) * W - w / 2, y: (l.y / 100) * H - h / 2, w, h };
}

function syncSliders(l: Layer): void {
  document.querySelectorAll<HTMLInputElement>(`[data-id="${l.id}"] input[data-k]`).forEach((inp) => {
    inp.value = String(l[inp.dataset.k as 'w' | 'x' | 'y']);
  });
}

function select(id: number | null): void {
  if (selected === id) return;
  selected = id;
  renderLayers();
}

function renderLayers(): void {
  $('layerCount').textContent = `${layers.length} / ${MAX_LAYERS}`;
  const box = $('layers');
  box.innerHTML = '';
  layers.forEach((l, i) => {
    const d = document.createElement('div');
    d.className = 'layer' + (l.id === selected ? ' sel' : '');
    d.dataset.id = String(l.id);
    d.innerHTML = `<div class="lh"><strong>Imagen ${i + 1}</strong><span class="nm"></span>
      <button data-a="up">Subir</button><button data-a="down">Bajar</button><button data-a="del">Quitar</button></div>
      <label>Tamaño<input type="range" data-k="w" min="5" max="200" step="0.5"></label>
      <label>Horizontal<input type="range" data-k="x" min="0" max="100" step="0.5"></label>
      <label>Vertical<input type="range" data-k="y" min="0" max="100" step="0.5"></label>`;
    d.querySelector('.nm')!.textContent = l.name;
    d.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) => {
      const k = inp.dataset.k as 'w' | 'x' | 'y';
      inp.value = String(l[k]);
      inp.addEventListener('input', () => (l[k] = Number(inp.value)));
    });
    d.addEventListener('click', (ev) => {
      const a = (ev.target as HTMLElement).dataset.a;
      if (a === 'del') {
        URL.revokeObjectURL(l.img.src);
        layers = layers.filter((x) => x !== l);
        if (selected === l.id) selected = null;
        renderLayers();
      } else if (a === 'up' || a === 'down') {
        const j = a === 'up' ? i + 1 : i - 1;
        if (j >= 0 && j < layers.length) {
          [layers[i], layers[j]] = [layers[j], layers[i]];
          renderLayers();
        }
      } else select(l.id);
    });
    box.append(d);
  });
}

$('layerFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []).slice(0, MAX_LAYERS - layers.length);
  input.value = '';
  for (const f of files) {
    try {
      const img = await loadImage(f);
      layers.push({ id: nextId++, name: f.name, img, x: 50, y: 50, w: 50, blob: f });
    } catch {
      statusEl.textContent = `No se pudo abrir la imagen ${f.name}.`;
    }
  }
  selected = layers.length ? layers[layers.length - 1].id : null;
  renderLayers();
});

/* ---------- Imagen detrás del código ---------- */
const boxKeys = { bW: 'w', bX: 'x', bY: 'y' } as const;

function syncBox(): void {
  if (!box) return;
  for (const [id, k] of Object.entries(boxKeys)) $<HTMLInputElement>(id).value = String(box[k]);
}

function setBox(img: HTMLImageElement, name: string, blob: Blob, path?: string): void {
  if (box?.img.src.startsWith('blob:')) URL.revokeObjectURL(box.img.src);
  box = { id: 0, name, img, x: 50, y: 55, w: 80, blob, path };
  $('boxCtl').hidden = false;
  syncBox();
  selected = null;
  select(0);
}

function defaultFrame(): Promise<{ img: HTMLImageElement; blob: Blob }> {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 360;
  const g = c.getContext('2d')!;
  g.shadowColor = '#3b6cff';
  g.shadowBlur = 30;
  g.fillStyle = 'rgba(6,12,32,0.92)';
  g.strokeStyle = '#5b8cff';
  g.lineWidth = 8;
  g.beginPath();
  g.roundRect(24, 24, 852, 312, 36);
  g.fill();
  g.stroke();
  return new Promise((res, rej) => {
    c.toBlob(async (blob) => {
      if (!blob) return rej(new Error('sin imagen'));
      res({ img: await loadImage(blob), blob });
    }, 'image/png');
  });
}

for (const [id, k] of Object.entries(boxKeys)) {
  $(id).addEventListener('input', () => { if (box) box[k] = Number($<HTMLInputElement>(id).value); });
}

$('boxFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    setBox(await loadImage(f), f.name, f);
  } catch {
    statusEl.textContent = `No se pudo abrir la imagen ${f.name}.`;
  }
});

$('boxDefault').addEventListener('click', async () => {
  const d = await defaultFrame();
  setBox(d.img, 'Marco por defecto', d.blob);
});

$('boxClear').addEventListener('click', () => {
  box = null;
  $('boxCtl').hidden = true;
  if (selected === 0) selected = null;
  renderLayers();
});

/* ---------- Mover y cambiar tamaño en la vista previa ---------- */
let drag: { id: number; dx: number; dy: number } | null = null;

function toCanvas(e: { clientX: number; clientY: number }) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
}

canvas.addEventListener('pointerdown', (e) => {
  const p = toCanvas(e);
  if (box) {
    const b = bounds(box);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
      drag = { id: 0, dx: p.x - (box.x / 100) * canvas.width, dy: p.y - (box.y / 100) * canvas.height };
      canvas.setPointerCapture(e.pointerId);
      select(0);
      return;
    }
  }
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i], b = bounds(l);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
      drag = { id: l.id, dx: p.x - (l.x / 100) * canvas.width, dy: p.y - (l.y / 100) * canvas.height };
      canvas.setPointerCapture(e.pointerId);
      select(l.id);
      return;
    }
  }
  select(null);
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const l = drag.id === 0 ? box : layers.find((x) => x.id === drag!.id);
  if (!l) return;
  const p = toCanvas(e);
  l.x = clamp(((p.x - drag.dx) / canvas.width) * 100, 0, 100);
  l.y = clamp(((p.y - drag.dy) / canvas.height) * 100, 0, 100);
  if (l === box) syncBox(); else syncSliders(l);
});

canvas.addEventListener('pointerup', () => (drag = null));

canvas.addEventListener('wheel', (e) => {
  const l = selected === 0 ? box : layers.find((x) => x.id === selected);
  if (!l) return;
  e.preventDefault();
  l.w = clamp(l.w - e.deltaY * 0.05, 5, 200);
  if (l === box) syncBox(); else syncSliders(l);
}, { passive: false });

/* ---------- Dibujo ---------- */
function draw(code: string): void {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  if (bg) {
    const el = bg.el;
    const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (sw && sh) {
      const s = Math.max(W / sw, H / sh);
      ctx.drawImage(el, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
    }
  }

  for (const l of layers) {
    const b = bounds(l);
    ctx.drawImage(l.img, b.x, b.y, b.w, b.h);
  }

  if (box) {
    const b = bounds(box);
    ctx.drawImage(box.img, b.x, b.y, b.w, b.h);
  }

  let size = (num('tSize') / 100) * W;
  const font = (s: number) => `900 ${s}px "Arial Black", Impact, Arial, sans-serif`;
  ctx.font = font(size);
  const text = code || 'CÓDIGO';
  const tw = ctx.measureText(text).width;
  if (tw > W * 0.92) {
    size *= (W * 0.92) / tw;
    ctx.font = font(size);
  }
  ctx.fillStyle = val('tColor');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, (num('tX') / 100) * W, (num('tY') / 100) * H);

  const sel = selected === 0 ? box : layers.find((l) => l.id === selected);
  if (!recording && sel) {
    const b = bounds(sel);
    ctx.save();
    ctx.strokeStyle = '#3b6cff';
    ctx.lineWidth = W / 270;
    ctx.setLineDash([W / 54, W / 108]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }
}

function frame(now: number): void {
  if (seqDirty) rebuild();
  const s = settings();
  const raw = (recording ? now - recStart : now - t0) / 1000;
  const t = recording ? raw : raw % s.duration;
  const n = sequence.length;
  const code = n ? sequence[Math.min(n - 1, Math.floor((t / s.duration) * n))] : '';
  draw(code);
  if (recording) {
    statusEl.textContent = `Generando video... ${Math.min(t, s.duration).toFixed(1)} / ${s.duration} s`;
    if (t >= s.duration) recorder?.stop();
  }
  requestAnimationFrame(frame);
}

$('reset').addEventListener('click', () => {
  t0 = performance.now();
  seqDirty = true;
});

/* ---------- Generar video ---------- */
$('generate').addEventListener('click', () => {
  if (recording) return;
  if (!getCodes().length) {
    statusEl.textContent = 'Cargá al menos un código antes de generar el video.';
    return;
  }
  const total = getCodes().length;
  const secs = settings().duration;
  if (total / secs > 30) {
    statusEl.textContent = `Con ${total} códigos necesitás al menos ${Math.ceil(total / 30)} segundos para que todos se vean bien. Subí la duración.`;
    return;
  }
  if (typeof MediaRecorder === 'undefined') {
    statusEl.textContent = 'Este navegador no puede grabar video. Probá con Chrome o Edge.';
    return;
  }
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const rec = new MediaRecorder(canvas.captureStream(60), { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    recording = false;
    document.body.classList.remove('busy');
    ($('generate') as HTMLButtonElement).disabled = false;
    const type = rec.mimeType || 'video/webm';
    const url = URL.createObjectURL(new Blob(chunks, { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `codigos-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    statusEl.textContent = 'Video listo y descargado. ';
    const again = document.createElement('a');
    again.href = url;
    again.download = a.download;
    again.textContent = 'Descargar de nuevo';
    statusEl.append(again);
  };
  rebuild();
  if (bg?.el instanceof HTMLVideoElement) {
    bg.el.currentTime = 0;
    void bg.el.play();
  }
  recorder = rec;
  recording = true;
  recStart = performance.now();
  document.body.classList.add('busy');
  ($('generate') as HTMLButtonElement).disabled = true;
  rec.start();
});

/* ---------- Cuenta y proyectos (Supabase) ---------- */
let user: User | null = null;
let currentId: string | null = null;
const field = (id: string) => $<HTMLInputElement>(id);
const projMsg = $('projMsg');
const errMsg = (e: unknown): string => (e as { message?: string } | null)?.message ?? 'error desconocido';

async function ensurePath(a: { name: string; blob?: Blob; path?: string }): Promise<string> {
  if (a.path) return a.path;
  if (!a.blob || !user) throw new Error('falta el archivo');
  a.path = await uploadAsset(user.id, a.blob, a.name);
  return a.path;
}

async function buildConfig(): Promise<Config> {
  const cfg: Config = {
    codes: codeInputs.map((i) => i.value),
    duration: settings().duration,
    order: val('order'),
    res: val('res'),
    text: { size: num('tSize'), x: num('tX'), y: num('tY'), color: val('tColor') },
    bg: null,
    layers: [],
    box: null,
  };
  if (bg) cfg.bg = { name: bg.name, path: await ensurePath(bg), video: bg.video };
  for (const l of layers) cfg.layers.push({ name: l.name, path: await ensurePath(l), x: l.x, y: l.y, w: l.w });
  if (box) cfg.box = { name: box.name, path: await ensurePath(box), x: box.x, y: box.y, w: box.w };
  return cfg;
}

async function openProject(id: string): Promise<void> {
  projMsg.textContent = 'Abriendo proyecto...';
  try {
    const { name, config: c } = await loadProject(id);
    codeInputs.forEach((inp, i) => (inp.value = c.codes?.[i] ?? ''));
    codesChanged();
    field('duration').value = String(c.duration ?? 8);
    field('order').value = c.order ?? 'random';
    field('res').value = c.res ?? '1080x1920';
    applyRes();
    field('tSize').value = String(c.text?.size ?? 18);
    field('tX').value = String(c.text?.x ?? 50);
    field('tY').value = String(c.text?.y ?? 55);
    field('tColor').value = c.text?.color ?? '#ffffff';
    if (c.bg) {
      await setBg(await downloadAsset(c.bg.path), c.bg.name, c.bg.video, c.bg.path);
    } else {
      bg = null;
      $('bgName').textContent = '';
    }
    layers = [];
    for (const l of c.layers ?? []) {
      const blob = await downloadAsset(l.path);
      layers.push({ id: nextId++, name: l.name, img: await loadImage(blob), x: l.x, y: l.y, w: l.w, blob, path: l.path });
    }
    box = null;
    $('boxCtl').hidden = true;
    if (c.box) {
      const blob = await downloadAsset(c.box.path);
      setBox(await loadImage(blob), c.box.name, blob, c.box.path);
      if (box) Object.assign(box, { x: c.box.x, y: c.box.y, w: c.box.w });
      syncBox();
    }
    selected = null;
    renderLayers();
    currentId = id;
    field('projName').value = name;
    $<HTMLSelectElement>('projSel').value = id;
    localStorage.setItem('lastProject', id);
    seqDirty = true;
    projMsg.textContent = 'Proyecto abierto.';
  } catch (x) {
    projMsg.textContent = 'No se pudo abrir el proyecto: ' + errMsg(x);
  }
}

async function refreshProjects(restoreLast = false): Promise<void> {
  try {
    const list = await listProjects();
    const sel = $<HTMLSelectElement>('projSel');
    sel.innerHTML = '<option value="">Nuevo proyecto</option>';
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = isAdmin(user?.email) && p.owner_email ? `${p.name} (${p.owner_email})` : p.name;
      sel.append(o);
    }
    sel.value = list.some((p) => p.id === currentId) ? currentId! : '';
    const last = localStorage.getItem('lastProject');
    if (restoreLast && !currentId && last && list.some((p) => p.id === last)) await openProject(last);
  } catch (x) {
    projMsg.textContent = 'No se pudieron cargar los proyectos: ' + errMsg(x);
  }
}

$('projSel').addEventListener('change', async () => {
  const v = $<HTMLSelectElement>('projSel').value;
  if (!v) {
    currentId = null;
    field('projName').value = '';
    projMsg.textContent = 'Nuevo proyecto: al guardar se crea una copia con lo que ves ahora.';
    return;
  }
  await openProject(v);
});

$('save').addEventListener('click', async () => {
  if (!user) return;
  const btn = $<HTMLButtonElement>('save');
  btn.disabled = true;
  projMsg.textContent = 'Guardando...';
  try {
    const name = field('projName').value.trim() || 'Sin nombre';
    currentId = await saveProject(currentId, name, await buildConfig());
    localStorage.setItem('lastProject', currentId);
    await refreshProjects();
    projMsg.textContent = 'Proyecto guardado.';
  } catch (x) {
    projMsg.textContent = 'No se pudo guardar: ' + errMsg(x);
  } finally {
    btn.disabled = false;
  }
});

$('projDel').addEventListener('click', async () => {
  if (!currentId || !confirm('¿Eliminar este proyecto y sus archivos?')) return;
  try {
    await deleteProject(currentId);
    currentId = null;
    field('projName').value = '';
    await refreshProjects();
    projMsg.textContent = 'Proyecto eliminado.';
  } catch (x) {
    projMsg.textContent = 'No se pudo eliminar: ' + errMsg(x);
  }
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginErr');
  err.textContent = '';
  try {
    await signIn(field('email').value.trim(), field('password').value);
    field('password').value = '';
  } catch (x) {
    const m = errMsg(x);
    err.textContent = m.includes('Invalid login') ? 'Correo o contraseña incorrectos.' : 'No se pudo entrar: ' + m;
  }
});

$('logout').addEventListener('click', () => void signOut());

supabase.auth.onAuthStateChange((_ev, session) => {
  user = session?.user ?? null;
  document.body.dataset.auth = user ? 'in' : 'out';
  if (user) {
    $('who').textContent = isAdmin(user.email) ? `${user.email} (administrador)` : (user.email ?? '');
    setTimeout(() => void refreshProjects(true), 0);
  } else {
    currentId = null;
  }
});

renderLayers();
requestAnimationFrame(frame);
