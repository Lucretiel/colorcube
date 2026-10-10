// DOM wiring: side panel, legend, slice controls, map panel, keyboard shortcuts, help.
import { escapeHtml, type App } from './app';
import type { LevelInfo } from './data';
import type { Orientation } from './slice';

/** Element by id; throws on a missing id instead of returning a null typed as T. */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
  return null;
}

export class UI {
  private legendRows: HTMLLIElement[] = [];
  private order: number[] = [];
  private axisEls: HTMLDivElement[] = [];
  private axisPos: { x: number; y: number; vis: boolean }[] = [];
  private loadingLevel = false;
  /** generation of the current level load: progress/errors of a superseded or failed load are ignored */
  private loadToken = 0;
  private errorTimer = 0;
  private levels: LevelInfo[] = [];

  constructor(private app: App) {
    document.addEventListener('input', (e) => { if ((e.target as HTMLElement).matches?.('input[type=range]')) this.fill(e.target as HTMLInputElement); });
    this.bindView();
    this.bindSlice();
    this.bindLegend();
    this.bindPanels();
    this.bindMap();
    this.bindKeys();
    this.buildAxisLabels();
    app.onState(() => this.refresh());
    app.onChange(() => this.refreshStatus());
    app.onFrame(() => this.placeAxisLabels());
    // a failed level switch leaves the previous level usable: click (or wait) to dismiss the message
    $('loading').addEventListener('click', () => { if ($('loading').classList.contains('error') && this.app.level) this.setLoading(null); });
  }

  // ------------------------------------------------------------ loading
  setLoading(f: number | null, text = '') {
    const el = $('loading');
    if (f === null) { el.classList.add('done'); return; }
    el.classList.remove('done');
    $('loading-text').textContent = text;
    $('loading-bar').style.width = `${Math.round(f * 100)}%`;
  }

  setLevels(levels: LevelInfo[], current: string) {
    this.levels = levels;
    const sel = $<HTMLSelectElement>('level');
    sel.innerHTML = levels.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.title)}</option>`).join('');
    sel.value = current;
    this.showLevelDesc();
    sel.onchange = async () => {
      const info = levels.find((l) => l.id === sel.value);
      if (!info || this.loadingLevel) return;
      this.showLevelDesc();
      await this.loadLevel(info);
    };
  }
  private showLevelDesc() {
    const id = $<HTMLSelectElement>('level').value;
    $('level-desc').textContent = this.levels.find((l) => l.id === id)?.description ?? '';
  }

  async loadLevel(info: LevelInfo) {
    const token = ++this.loadToken;
    this.loadingLevel = true;
    const sel = $<HTMLSelectElement>('level');
    sel.disabled = true;
    clearTimeout(this.errorTimer);
    $('loading').classList.remove('error');
    document.body.classList.add('busy');
    try {
      await this.app.setLevel(info, (f, what) => { if (token === this.loadToken) this.setLoading(f, `Loading ${info.title}: ${what}…`); });
      this.buildLegend();
      this.setLoading(null);
      store('cc.level', info.id);
    } catch (err) {
      console.error(err);
      this.loadToken++; // stray progress callbacks of this load must not overwrite the message
      const cur = this.app.level;
      this.setLoading(1, `Failed to load ${info.title}: ${(err as Error).message}` +
        (cur ? ` — still showing ${cur.info.title}. (Click to dismiss.)` : ''));
      $('loading').classList.add('error');
      if (cur) {
        // the previous level is still loaded and usable: restore the selector and fade the message out
        sel.value = cur.info.id;
        this.showLevelDesc();
        this.errorTimer = window.setTimeout(() => { if ($('loading').classList.contains('error')) this.setLoading(null); }, 6000);
      }
    } finally {
      this.loadingLevel = false;
      $<HTMLSelectElement>('level').disabled = false;
      document.body.classList.remove('busy');
    }
  }

  // ------------------------------------------------------------ view controls
  private bindView() {
    const ex = $<HTMLInputElement>('explode');
    ex.addEventListener('input', () => this.app.setExplode(+ex.value, true));
    const sh = $<HTMLInputElement>('shade');
    sh.addEventListener('input', () => this.app.setShade(+sh.value));
    $<HTMLInputElement>('labels-on').addEventListener('change', (e) => this.app.setLabelsOn((e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('spin').addEventListener('change', (e) => this.app.setSpin((e.target as HTMLInputElement).checked));
    $('reset-cam').addEventListener('click', () => this.app.resetCamera());
  }

  private bindSlice() {
    $('orient').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b?.dataset.o) this.app.setOrientation(b.dataset.o as Orientation);
    });
    const pos = $<HTMLInputElement>('slice-pos'), mpos = $<HTMLInputElement>('map-pos');
    const onPos = (el: HTMLInputElement) => () => this.app.setSliderValue(+el.value);
    pos.addEventListener('input', onPos(pos));
    mpos.addEventListener('input', onPos(mpos));
    const az = $<HTMLInputElement>('slice-az'), el = $<HTMLInputElement>('slice-el');
    const onAng = () => this.app.setAngles(+az.value, +el.value);
    az.addEventListener('input', onAng); el.addEventListener('input', onAng);
    $<HTMLInputElement>('slice-show').addEventListener('change', (e) => this.app.setShowSlice((e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('slice-clip').addEventListener('change', (e) => this.app.setClip((e.target as HTMLInputElement).checked));
    $('slice-flip').addEventListener('click', () => this.app.flipClip());
  }

  // ------------------------------------------------------------ legend
  private bindLegend() {
    const filter = $<HTMLInputElement>('filter');
    filter.addEventListener('input', () => this.applyFilter());
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { filter.value = ''; this.applyFilter(); filter.blur(); e.stopPropagation(); }
      if (e.key === 'Enter') {
        const first = this.legendRows.find((r) => !r.hidden);
        if (first) this.app.solo(+first.dataset.i!);
      }
    });
    $('show-all').addEventListener('click', () => this.app.showAll());
    const list = $('legend');
    list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (!li) return;
      const i = +li.dataset.i!;
      if ((e.target as HTMLElement).closest('.eye') || e.shiftKey) this.app.toggleName(i);
      else this.app.solo(i);
    });
    list.addEventListener('pointerover', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      this.app.setHoverName(li ? +li.dataset.i! : -1);
    });
    list.addEventListener('pointerleave', () => this.app.setHoverName(-1));
  }

  private buildLegend() {
    const lvl = this.app.level;
    if (!lvl) return;
    const names = lvl.meta.names;
    const blobsPerName = new Map<number, number>();
    for (const c of lvl.meta.components) blobsPerName.set(c.nameIndex, (blobsPerName.get(c.nameIndex) ?? 0) + 1);
    this.order = names.map((_, i) => i).sort((a, b) => names[b].voxels - names[a].voxels);
    const list = $('legend');
    list.innerHTML = '';
    this.legendRows = this.order.map((i) => {
      const n = names[i];
      const li = document.createElement('li');
      li.dataset.i = String(i);
      li.setAttribute('role', 'option');
      const [r, g, b] = n.meanColor;
      const pct = n.fraction * 100;
      const blobs = blobsPerName.get(i) ?? 0;
      li.title = `${n.name}: ${pct.toFixed(3)}% of the cube · ${blobs} blob${blobs === 1 ? '' : 's'} · ${n.answers.toLocaleString()} survey answers`;
      li.innerHTML = `<span class="sw" style="background:rgb(${r},${g},${b})"></span>` +
        `<span class="nm">${escapeHtml(n.name)}</span>` +
        `<span class="bar" style="--w:${Math.min(100, Math.sqrt(pct / 20) * 100).toFixed(1)}%"></span>` +
        `<span class="pct">${pct >= 1 ? pct.toFixed(1) : pct >= 0.1 ? pct.toFixed(2) : pct.toFixed(3)}%</span>` +
        `<button class="eye" title="Hide / show (Shift-click)" aria-label="toggle ${escapeHtml(n.name)}"></button>`;
      list.appendChild(li);
      return li;
    });
    $('name-count').textContent = `${names.length}`;
    this.applyFilter();
    this.refresh();
  }

  private applyFilter() {
    const q = $<HTMLInputElement>('filter').value.trim().toLowerCase();
    const names = this.app.level?.meta.names ?? [];
    for (const li of this.legendRows) li.hidden = !!q && !names[+li.dataset.i!].name.toLowerCase().includes(q);
  }

  // ------------------------------------------------------------ panels
  private bindPanels() {
    const side = $('side'), open = $('side-open');
    const setSide = (collapsed: boolean) => {
      side.classList.toggle('collapsed', collapsed);
      document.body.classList.toggle('side-open', !collapsed);
      open.hidden = !collapsed;
      store('cc.side', collapsed ? '0' : '1');
      this.app.layoutMap();
    };
    $('side-toggle').addEventListener('click', () => setSide(true));
    open.addEventListener('click', () => setSide(false));
    this.toggleSide = () => setSide(!side.classList.contains('collapsed'));
    if (store('cc.side') === '0' || window.innerWidth < 700) setSide(true);
    let wasNarrow = window.innerWidth < 700;
    window.addEventListener('resize', () => {
      const narrow = window.innerWidth < 700;
      if (narrow && !wasNarrow && !side.classList.contains('collapsed')) setSide(true);
      wasNarrow = narrow;
    });

    $('map-toggle').addEventListener('click', () => this.app.setMapVisible(false));
    $('map-open').addEventListener('click', () => this.app.setMapVisible(true));
    if (window.innerWidth < 520) this.app.setMapVisible(false);

    // resize from the top-left corner (panel is docked bottom-right)
    const panel = $('map-panel');
    const saved = store('cc.mapsize');
    if (saved) { const [w, h] = saved.split('x').map(Number); if (w && h) { panel.style.width = `${w}px`; panel.style.height = `${h}px`; } }
    const grip = $('map-resize');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const r0 = panel.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      const move = (ev: PointerEvent) => {
        const w = Math.max(260, Math.min(window.innerWidth - 24, r0.width - (ev.clientX - x0)));
        const h = Math.max(240, Math.min(window.innerHeight - 24, r0.height - (ev.clientY - y0)));
        panel.style.width = `${w}px`; panel.style.height = `${h}px`;
        this.app.layoutMap();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
        const r = panel.getBoundingClientRect();
        store('cc.mapsize', `${Math.round(r.width)}x${Math.round(r.height)}`);
      };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
    });

    $('help-btn').addEventListener('click', () => this.toggleHelp(true));
    $('help-close').addEventListener('click', () => this.toggleHelp(false));
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) this.toggleHelp(false); });
    $('map-download').addEventListener('click', () => this.download());
  }
  private toggleSide: () => void = () => {};
  private toggleHelp(on?: boolean) { const h = $('help'); h.hidden = on === undefined ? !h.hidden : !on; }

  async download() {
    const lvl = this.app.level;
    if (!lvl) return;
    const desc = this.app.slice.describe();
    const blob = await this.app.map.exportPNG(this.app.renderer, 2400, `${desc} · ${lvl.info.title}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `colorcube-${lvl.info.id}-${desc.replace(/[^\w=+]+/g, '_').replace(/_+$/, '')}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.app.requestRender();
  }

  // ------------------------------------------------------------ map interactions
  private bindMap() {
    const host = this.app.map.host;
    let drag: { x: number; y: number; px: number; py: number; moved: boolean; id: number } | null = null;
    // the second click of a double-click (which resets the zoom) must not undo the first click's solo
    let lastClick = { t: -1e9, x: 0, y: 0 };
    host.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      host.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, px: this.app.map.pan.x, py: this.app.map.pan.y, moved: false, id: e.pointerId };
    });
    host.addEventListener('pointermove', (e) => {
      if (drag && e.pointerId === drag.id) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; host.classList.add('panning'); this.app.mapLeave(); }
        if (drag.moved) {
          const s = this.app.map.view().s;
          this.app.map.pan.x = drag.px - dx / s; this.app.map.pan.y = drag.py + dy / s;
          this.app.layoutMap();
          return;
        }
      }
      this.app.mapHover(e.clientX, e.clientY);
    });
    host.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        const now = performance.now();
        const second = now - lastClick.t < 320 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 6;
        if (!second) this.app.mapClick(e.clientX, e.clientY, e.shiftKey);
        lastClick = second ? { t: -1e9, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
      }
      drag = null; host.classList.remove('panning');
    });
    host.addEventListener('pointerleave', () => { if (!drag) this.app.mapLeave(); });
    host.addEventListener('wheel', (e) => {
      e.preventDefault();
      const m = this.app.map;
      const hr = m.hostRect, sx = e.clientX - hr.left, sy = e.clientY - hr.top;
      const v0 = m.view();
      const [mx, my] = m.toMap(v0, sx, sy);
      // normalise line / page deltas to pixels; ~0.3 zoom steps per 250 px notch
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? hr.height : 1);
      m.zoom = Math.max(1, Math.min(24, m.zoom * Math.exp(-dy * 0.0012)));
      const s1 = m.view().s;
      const I = m.inner, b = m.bounds;
      m.pan.x = mx - (sx - I.x - I.w / 2) / s1 - (b.x0 + b.x1) / 2;
      m.pan.y = my + (sy - I.y - I.h / 2) / s1 - (b.y0 + b.y1) / 2;
      if (m.zoom === 1) { m.pan.x = 0; m.pan.y = 0; }
      this.app.layoutMap();
      this.app.mapHover(e.clientX, e.clientY);
    }, { passive: false });
    host.addEventListener('dblclick', () => { const m = this.app.map; m.zoom = 1; m.pan.x = 0; m.pan.y = 0; this.app.layoutMap(); });
  }

  // ------------------------------------------------------------ keyboard
  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox') || t?.tagName === 'SELECT' || t?.tagName === 'TEXTAREA') return;
      // a focused slider keeps its native keys (its input event drives the app); letters stay global
      if (t?.tagName === 'INPUT' && (t as HTMLInputElement).type === 'range' &&
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const a = this.app;
      const k = e.key;
      let handled = true;
      switch (k) {
        case 'e': case 'E': a.toggleExplode(); break;
        case '[': a.setExplode(a.explodeTarget - 0.1); break;
        case ']': a.setExplode(a.explodeTarget + 0.1); break;
        case '1': a.setOrientation('r'); break;
        case '2': a.setOrientation('g'); break;
        case '3': a.setOrientation('b'); break;
        case '4': a.setOrientation('gray'); break;
        case '5': a.setOrientation('hues'); break;
        case '6': a.setOrientation('free'); break;
        case 'ArrowUp': a.nudgeSlice(e.shiftKey ? 10 : 1); break;
        case 'ArrowDown': a.nudgeSlice(e.shiftKey ? -10 : -1); break;
        case 'ArrowLeft': case 'ArrowRight': {
          if (a.slice.orientation !== 'free') { handled = false; break; }
          a.setAngles(a.slice.az + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 2), a.slice.el);
          break;
        }
        case 'c': case 'C': a.setClip(!a.clipOn); break;
        case 'f': case 'F': a.flipClip(); break;
        case 'v': case 'V': a.setShowSlice(!a.showSlice3D); break;
        case 'd': case 'D': void this.download(); break;
        case 's': case 'S': a.setShade(a.shared.uShade.value > 0 ? 0 : 0.55); break;
        case 'l': case 'L': a.setLabelsOn(!a.labelsOn); break;
        case 'a': case 'A': a.setSpin(!a.controls.autoRotate); break;
        case 'r': case 'R': a.resetCamera(); break;
        case 'p': case 'P': this.toggleSide(); break;
        case 'm': case 'M': a.setMapVisible(!a.mapVisible); break;
        case '/': $<HTMLInputElement>('filter').focus(); break;
        case '?': case 'h': case 'H': this.toggleHelp(); break;
        case 'Escape':
          if (!$('help').hidden) this.toggleHelp(false); else a.showAll();
          break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); if (t?.tagName === 'INPUT') t.blur(); }
    });
  }

  // ------------------------------------------------------------ axis letters in 3D
  private buildAxisLabels() {
    const layer = $('labels3d');
    ['R', 'G', 'B'].forEach((t, i) => {
      const d = document.createElement('div');
      d.className = `axis-label axis-${'rgb'[i]}`;
      d.textContent = t;
      layer.appendChild(d);
      this.axisEls.push(d);
    });
  }
  private placeAxisLabels() {
    this.app.axisLabelPositions(this.axisPos);
    const avoid = this.app.avoidRects;
    this.axisPos.forEach((p, i) => {
      const el = this.axisEls[i];
      const covered = avoid.some((r) => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1);
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
      el.style.opacity = p.vis && !covered ? '' : '0';
    });
  }

  // ------------------------------------------------------------ refresh
  refresh() {
    const a = this.app, s = a.slice;
    const set = (id: string, v: string) => { const el = $<HTMLInputElement>(id); if (el.value !== v && document.activeElement !== el) el.value = v; };
    set('explode', String(a.explodeTarget));
    $('explode-out').textContent = a.explodeTarget.toFixed(2);
    set('shade', String(a.shared.uShade.value));
    $('shade-out').textContent = a.shared.uShade.value.toFixed(2);
    $<HTMLInputElement>('labels-on').checked = a.labelsOn;
    $<HTMLInputElement>('spin').checked = a.controls.autoRotate;
    $<HTMLInputElement>('slice-show').checked = a.showSlice3D;
    const clip = $<HTMLInputElement>('slice-clip');
    const canClip = a.showSlice3D;
    clip.checked = a.clipOn;
    clip.disabled = !canClip;
    const clipLbl = clip.closest('label')!;
    clipLbl.classList.toggle('disabled', !canClip);
    clipLbl.title = canClip ? 'Cut the blobs at the slice plane (C)' : 'Cutting needs the slice shown in 3D (V)';
    $('slice-flip').classList.toggle('active', a.clipSide < 0);
    for (const b of $('orient').querySelectorAll('button')) {
      const on = b.dataset.o === s.orientation;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
    for (const id of ['slice-pos', 'map-pos']) {
      const el = $<HTMLInputElement>(id);
      el.min = String(s.sliderMin); el.max = String(s.sliderMax);
      if (document.activeElement !== el) el.value = String(s.sliderValue);
      el.style.setProperty('--fill', `${(100 * (s.sliderValue - s.sliderMin)) / Math.max(1, s.sliderMax - s.sliderMin)}%`);
    }
    const lbl = { r: 'R', g: 'G', b: 'B', gray: 'R+G+B', hues: 'Hue', free: 'Offset' }[s.orientation];
    $('slice-pos-lbl').textContent = lbl;
    $('slice-pos-out').textContent = s.orientation === 'hues' ? `${s.sliderValue}°` : String(s.sliderValue);
    $('free-angles').hidden = s.orientation !== 'free';
    set('slice-az', String(s.az)); set('slice-el', String(s.el));
    $('slice-az-out').textContent = `${Math.round(s.az)}°`;
    $('slice-el-out').textContent = `${Math.round(s.el)}°`;
    $('map-desc').textContent = s.describe();
    $('map-panel').hidden = !a.mapVisible;
    $('map-open').hidden = a.mapVisible;
    // legend visibility state
    for (const li of this.legendRows) {
      const i = +li.dataset.i!;
      li.classList.toggle('off', a.nameVisible[i] === false);
    }
    $('show-all').classList.toggle('attention', a.anyHidden);
    document.body.classList.toggle('exploded', a.explodeTarget > 0.02);
    for (const id of ['explode', 'shade', 'slice-az', 'slice-el']) this.fill($<HTMLInputElement>(id));
    this.refreshStatus();
  }

  private fill(el: HTMLInputElement) {
    const min = +el.min || 0, max = +el.max || 100;
    el.style.setProperty('--fill', `${(100 * (+el.value - min)) / Math.max(1e-9, max - min)}%`);
  }

  private refreshStatus() {
    const m = this.app.map;
    const n = m.labels.length;
    $('map-status').textContent = m.pendingLabels ? 'labelling…' : `${n} label${n === 1 ? '' : 's'} · ${m.labelMs.toFixed(0)} ms`;
    $('map-desc').textContent = this.app.slice.describe();
  }
}
