// Web worker: holds a copy of the label volume and computes 2D slice labels on request.
// Per request kind ('full' slice / zoomed 'view') only the most recent request is processed;
// full-slice requests go first.
import { computeLabels, type LabelRequest } from './labeler';

let volume: Uint8Array | null = null;
const pending: { full: LabelRequest | null; view: LabelRequest | null } = { full: null, view: null };
let scheduled = false;

function run() {
  scheduled = false;
  if (!volume) return;
  const req = pending.full ?? pending.view;
  if (!req) return;
  if (req === pending.full) pending.full = null; else pending.view = null;
  (self as unknown as Worker).postMessage(computeLabels(volume, req));
  if (pending.full || pending.view) { scheduled = true; setTimeout(run, 0); }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: 'volume'; labels: Uint8Array } | { type: 'label'; req: LabelRequest };
  if (msg.type === 'volume') { volume = msg.labels; return; }
  pending[msg.req.kind ?? 'full'] = msg.req;
  if (!scheduled) { scheduled = true; setTimeout(run, 0); }
};
