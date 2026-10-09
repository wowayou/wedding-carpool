// ---------- 在线的人：名单，以及「谁正在编辑哪一格」的标记 ----------

import { elementOf } from './paths.js';
import { me, state } from './state.js';
import { $, esc } from './util.js';

export const PEER_COLORS = ['#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#2563eb'];
export const peerColor = (id) => PEER_COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % PEER_COLORS.length];

export function renderPeers() {
  $('#peers').innerHTML = state.peers.map((p) => {
    const self = p.clientId === me.clientId;
    return `<span class="peer-chip" title="${esc(p.name)}${self ? '（你）' : ''}"><i style="background:${peerColor(p.clientId)}">${esc(p.name.slice(0, 1))}</i>${esc(p.name)}${self ? '（你）' : ''}</span>`;
  }).join('');
}

export function markPeers() {
  document.querySelectorAll('#form .peer-on').forEach((el) => { el.classList.remove('peer-on'); el.style.removeProperty('--peer'); el.removeAttribute('title'); });
  document.querySelectorAll('#form .peer-tag').forEach((el) => el.remove());
  for (const p of state.peers) {
    if (p.clientId === me.clientId || !p.focus) continue;
    const el = elementOf(p.focus);
    if (!el) continue;
    const color = peerColor(p.clientId);
    el.classList.add('peer-on');
    el.style.setProperty('--peer', color);
    el.title = `${p.name} 正在编辑`;
    const tag = document.createElement('span');
    tag.className = 'peer-tag';
    tag.style.setProperty('--peer', color);
    tag.textContent = `${p.name} 正在编辑`;
    (el.closest('.f, .rail-row, .station') || el.parentElement).append(tag);
  }
}

