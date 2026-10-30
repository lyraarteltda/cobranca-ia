/**
 * Cobrança IA — Main Application Logic
 *
 * The month's collection run, ready to send. The member registers their Pix
 * (key + receiver name + city) and imports the list of charges (client,
 * WhatsApp, amount, due date, reference). Everything that is a number or a
 * code is computed HERE, deterministically:
 *   - status by due date and the current step of the member's dunning ladder
 *     ("régua": D-3 reminder, due today, D+1, D+5, D+15, D+30 — editable);
 *   - optional late fee / pro-rata interest → updated amount;
 *   - a real Pix "copia e cola" (BR Code EMV, static, with amount + txid,
 *     CRC16-CCITT) and its QR Code for every charge;
 *   - a wa.me link that opens the client's chat with message + Pix filled in;
 *   - month control (received / open / late), per-client payment history,
 *     XLSX/CSV export and "repeat the fixed charges next month".
 * The model (BYOK, OpenRouter — Hard Rules #1/#19) only writes the wording of
 * each message, in batch, from first name / amount / due date / days late.
 * The client's phone and the member's Pix key never go to the AI, and any
 * amount or date the model writes that is not the real one is rejected
 * (the message falls back to the deterministic template).
 * The only backend is the shared n8n gate/webhooks. No Supabase in the browser.
 */
const App = (function () {
  'use strict';

  // ── slot names (COR-025: never `*KEY = '<hyphenated literal>'`) ──
  var DATA_SLOT = 'cobranca_dados';
  var MAX_ITEMS = 2000;
  var MAX_ROWS = 2000;
  var AI_CHUNK = 10;

  var DEFAULT_REGUA = [
    { d: -3, n: 'Lembrete' },
    { d: 0, n: 'Vence hoje' },
    { d: 1, n: 'Venceu ontem' },
    { d: 5, n: 'Atraso' },
    { d: 15, n: 'Atraso sério' },
    { d: 30, n: 'Última tentativa' }
  ];
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var TIPO_LABEL = { cpf: 'CPF', cnpj: 'CNPJ', fone: 'Celular', email: 'E-mail', evp: 'Chave aleatória' };
  var SRC_LABEL = { ia: 'Escrita pela IA', modelo: 'Mensagem-modelo', voce: 'Editada por você' };

  var state = { wired: false, d: null, filter: 'abertas', q: '', editId: '', pendingRaw: null, running: false, ctl: null, month: '', wiping: false };

  // ───────────────────────── helpers ─────────────────────────
  function $(id) { return document.getElementById(id); }
  var toastT = null;
  function toast(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clean(v) {
    var s = String(v == null ? '' : v).trim();
    return /^(null|undefined|n\/a|-|—)$/i.test(s) ? '' : s; // COR-015
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function slug(s) { return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'cobrancas'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  var NF2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var NF0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  function brl(v) { return 'R$ ' + NF2.format(v || 0); }
  function r2(x) { return Math.round((x || 0) * 100) / 100; }
  function pad2(n) { return ('0' + n).slice(-2); }
  function firstName(s) { var p = String(s || '').trim().split(/\s+/)[0] || ''; return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(); }

  // ── dates as 'YYYY-MM-DD' (local calendar, no time zone drift) ──
  function ymdOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayYmd() { return ymdOf(new Date()); }
  function parseYmd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function addDays(ymd, n) { var d = parseYmd(ymd); d.setDate(d.getDate() + n); return ymdOf(d); }
  function daysLate(venc, ref) {
    var a = parseYmd(venc), b = parseYmd(ref || todayYmd()); if (!a || !b) return 0;
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
  }
  function dmy(ymd) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function dm(ymd) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ''); return m ? m[3] + '/' + m[2] : ''; }
  function monthKey(ymd) { return String(ymd || '').slice(0, 7); }
  function monthLabel(key) { var m = /^(\d{4})-(\d{2})$/.exec(key || ''); return m ? MONTHS[+m[2] - 1] + ' de ' + m[1] : ''; }
  function addMonth(ymd) {
    var d = parseYmd(ymd), day = d.getDate(), t = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    var last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(day, last)); return ymdOf(t);
  }

  // ───────────────────────── storage ─────────────────────────
  function defaults() {
    return { cfg: { tipo: '', chave: '', nome: '', cidade: '', assina: '', negocio: '', tom: 'cordial', multa: 0, juros: 0, regua: DEFAULT_REGUA.slice() }, items: [] };
  }
  function load() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(DATA_SLOT) || 'null'); } catch (e) { d = null; }
    var base = defaults();
    if (!d || typeof d !== 'object') return base;
    d.cfg = Object.assign(base.cfg, d.cfg || {});
    if (!Array.isArray(d.cfg.regua) || !d.cfg.regua.length) d.cfg.regua = DEFAULT_REGUA.slice();
    d.items = Array.isArray(d.items) ? d.items.filter(function (x) { return x && x.id && x.venc; }) : [];
    return d;
  }
  var saveTimer = null;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
  function saveNow() {
    clearTimeout(saveTimer);
    if (state.wiping || !state.d) return;
    try { localStorage.setItem(DATA_SLOT, JSON.stringify(state.d)); }
    catch (e) { toast('Não consegui salvar neste navegador (armazenamento cheio ou bloqueado).'); }
  }
  function getItem(id) { return state.d.items.filter(function (x) { return x.id === id; })[0] || null; }

  // ───────────────────────── Pix (BR Code EMV, static) ─────────────────────────
  function crc16(s) {
    var crc = 0xFFFF;
    for (var i = 0; i < s.length; i++) {
      crc ^= s.charCodeAt(i) << 8;
      for (var j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return ('000' + crc.toString(16).toUpperCase()).slice(-4);
  }
  function tlv(id, v) { v = String(v); return id + pad2(v.length) + v; }
  function pixText(s, max) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-\/]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
  }
  function cpfOk(c) {
    if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
    for (var t = 9; t < 11; t++) { var s = 0; for (var i = 0; i < t; i++) s += +c[i] * (t + 1 - i); if (((s * 10) % 11) % 10 !== +c[t]) return false; }
    return true;
  }
  function cnpjOk(c) {
    if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
    function dv(n) { var w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], s = 0; for (var i = 0; i < n; i++) s += +c[i] * w[i]; var r = s % 11; return r < 2 ? 0 : 11 - r; }
    return dv(12) === +c[12] && dv(13) === +c[13];
  }
  function guessTipo(raw) {
    var s = String(raw || '').trim(), dg = s.replace(/\D/g, '');
    if (/@/.test(s)) return 'email';
    if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) return 'evp';
    if (/^\+/.test(s)) return 'fone';
    if (dg.length === 14) return 'cnpj';
    if (dg.length === 11 && cpfOk(dg)) return 'cpf';
    if (dg.length === 11 || dg.length === 13) return 'fone';
    return '';
  }
  // → { ok, key, err }
  function normalizeKey(tipo, raw) {
    var s = String(raw || '').trim(), dg = s.replace(/\D/g, '');
    if (!s) return { ok: false, err: 'Digite a chave Pix.' };
    if (tipo === 'cpf') return cpfOk(dg) ? { ok: true, key: dg } : { ok: false, err: 'CPF inválido — confira os 11 dígitos.' };
    if (tipo === 'cnpj') return cnpjOk(dg) ? { ok: true, key: dg } : { ok: false, err: 'CNPJ inválido — confira os 14 dígitos.' };
    if (tipo === 'fone') {
      if (dg.length === 13 && dg.indexOf('55') === 0) dg = dg.slice(2);
      if (dg.length !== 11) return { ok: false, err: 'Celular com DDD: 11 dígitos (ex.: 11999998888).' };
      return { ok: true, key: '+55' + dg };
    }
    if (tipo === 'email') { var e = s.toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 77 ? { ok: true, key: e } : { ok: false, err: 'E-mail inválido.' }; }
    if (tipo === 'evp') { var u = s.toLowerCase().replace(/\s/g, ''); if (/^[0-9a-f]{32}$/.test(u)) u = u.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'); return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u) ? { ok: true, key: u } : { ok: false, err: 'Chave aleatória tem 32 caracteres (com hífens: 36).' }; }
    return { ok: false, err: 'Escolha o tipo da chave.' };
  }
  function txidOf(item) { return ('COB' + String(item.id).replace(/[^A-Za-z0-9]/g, '')).toUpperCase().slice(0, 25); }
  // Static BR Code (Manual de Padrões para Iniciação do Pix, BCB): 00 payload format,
  // 26 merchant account (GUI br.gov.bcb.pix + key), 52 MCC, 53 BRL, 54 amount,
  // 58 BR, 59 name, 60 city, 62/05 txid, 63 CRC16-CCITT-FALSE over everything + "6304".
  function brCode(o) {
    var mai = tlv('00', 'br.gov.bcb.pix') + tlv('01', o.key);
    var p = tlv('00', '01') + tlv('26', mai) + tlv('52', '0000') + tlv('53', '986');
    if (o.amount > 0) p += tlv('54', o.amount.toFixed(2));
    p += tlv('58', 'BR') + tlv('59', pixText(o.name, 25) || 'RECEBEDOR') + tlv('60', pixText(o.city, 15) || 'BRASIL');
    p += tlv('62', tlv('05', o.txid || '***'));
    p += '6304';
    return p + crc16(p);
  }
  function pixReady() {
    var c = state.d.cfg; var k = normalizeKey(c.tipo, c.chave);
    return k.ok && pixText(c.nome, 25).length >= 2 && pixText(c.cidade, 15).length >= 2 ? k.key : '';
  }
  function pixFor(item) {
    var key = pixReady(); if (!key) return '';
    return brCode({ key: key, name: state.d.cfg.nome, city: state.d.cfg.cidade, amount: amounts(item).total, txid: txidOf(item) });
  }

  // ───────────────────────── QR ─────────────────────────
  function qrMatrix(text) {
    if (typeof window.qrcode !== 'function') return null;
    var q = window.qrcode(0, 'M'); q.addData(text); q.make();
    var n = q.getModuleCount(), m = [];
    for (var r = 0; r < n; r++) { var row = []; for (var c = 0; c < n; c++) row.push(q.isDark(r, c)); m.push(row); }
    return m;
  }
  function drawQR(ctx, text, x, y, size, ink, paper) {
    var m = qrMatrix(text); if (!m) return false;
    var n = m.length, quiet = 4, cell = Math.floor(size / (n + quiet * 2)), off = Math.floor((size - cell * n) / 2);
    ctx.fillStyle = paper || '#ffffff'; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = ink || '#000000';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (m[r][c]) ctx.fillRect(x + off + c * cell, y + off + r * cell, cell, cell);
    return true;
  }
  function paintQR(canvas, text) {
    var ctx = canvas.getContext('2d'), w = canvas.width;
    ctx.clearRect(0, 0, w, w);
    if (!text) return;
    drawQR(ctx, text, 0, 0, w, '#111418', '#ffffff');
  }

  // ───────────────────────── régua / amounts ─────────────────────────
  function regua() { return state.d.cfg.regua.slice().sort(function (a, b) { return a.d - b.d; }); }
  function stageOf(item) {
    if (item.pago) return null;
    var d = daysLate(item.venc), st = null;
    regua().forEach(function (s) { if (s.d <= d) st = s; });
    return st;
  }
  function amounts(item) {
    var v = r2(item.valor), d = daysLate(item.venc), c = state.d.cfg;
    var multa = 0, juros = 0;
    if (!item.pago && d > 0) {
      multa = r2(v * (+c.multa || 0) / 100);
      juros = r2(v * (+c.juros || 0) / 100 / 30 * d);
    }
    return { valor: v, multa: multa, juros: juros, total: r2(v + multa + juros), dias: d };
  }
  function situacao(item) {
    if (item.pago) return { cls: 'paga', txt: 'Paga em ' + dm(item.pago.dt) };
    var d = daysLate(item.venc);
    if (d < 0) return { cls: 'futura', txt: d === -1 ? 'Vence amanhã' : 'Vence em ' + (-d) + ' dias' };
    if (d === 0) return { cls: 'hoje', txt: 'Vence hoje' };
    return { cls: 'atrasada', txt: 'Atrasada ' + plural(d, 'dia', 'dias') };
  }
  function situacaoAI(d) {
    if (d < 0) return d === -1 ? 'vence amanhã' : 'vence em ' + (-d) + ' dias';
    if (d === 0) return 'vence hoje';
    return d === 1 ? 'venceu ontem (1 dia de atraso)' : 'atrasada há ' + d + ' dias';
  }
  function inQueue(item) { var st = stageOf(item); return !!(st && !(item.sent && item.sent[st.d])); }
  function sentToday(item) {
    if (!item.sent) return false; var t = todayYmd();
    return Object.keys(item.sent).some(function (k) { return ymdOf(new Date(item.sent[k])) === t; });
  }
  function history(item) {
    // past charges of the same client (by phone or name) — paid late / on time
    var key = item.fone || fold(item.cliente), past = state.d.items.filter(function (x) { return x.id !== item.id && (x.fone || fold(x.cliente)) === key && x.venc < item.venc; });
    var paid = past.filter(function (x) { return x.pago; }), late = paid.filter(function (x) { return daysLate(x.venc, x.pago.dt) > 0; });
    return { n: past.length, pagas: paid.length, atrasadas: late.length };
  }

  // ───────────────────────── message templates (deterministic) ─────────────────────────
  function cat(d) { return d < 0 ? 'pre' : d === 0 ? 'dia' : d <= 6 ? 'leve' : d <= 20 ? 'firme' : 'serio'; }
  function greet(nome, tom) { return tom === 'formal' ? 'Olá, ' + nome + '. Tudo bem?' : tom === 'proximo' ? 'Oi, ' + nome + '! Tudo certo?' : 'Olá, ' + nome + ', tudo bem?'; }
  function templateText(item) {
    var c = state.d.cfg, a = amounts(item), n = firstName(item.cliente) || 'tudo bem', tom = c.tom || 'cordial';
    var ref = item.ref ? ' referente a ' + item.ref : '', v = brl(a.valor), venc = dmy(item.venc), k = cat(a.dias);
    var parts = [greet(n, tom)];
    if (k === 'pre') parts.push('Passando para lembrar que o pagamento de ' + v + ref + ' vence em ' + venc + '. Para facilitar, o Pix já está aqui embaixo com o valor certinho.');
    else if (k === 'dia') parts.push('Hoje é o dia do pagamento de ' + v + ref + '. Deixei o Pix logo abaixo com o valor certo — é só copiar e colar no app do banco.');
    else if (k === 'leve') parts.push('Notei que o pagamento de ' + v + ref + ', com vencimento em ' + venc + ', ainda não apareceu por aqui. Pode ter sido só correria — o Pix está logo abaixo.' + (a.total > a.valor ? ' Com a multa e os juros previstos, o valor atualizado fica em ' + brl(a.total) + '.' : ''));
    else if (k === 'firme') parts.push('O pagamento de ' + v + ref + ' está em aberto desde ' + venc + ' (' + plural(a.dias, 'dia', 'dias') + ').' + (a.total > a.valor ? ' Com multa e juros, o valor atualizado é ' + brl(a.total) + '.' : '') + ' Consegue regularizar ainda esta semana? Se houver alguma dificuldade, me conta que a gente combina a melhor forma.');
    else parts.push('Ainda não identifiquei o pagamento de ' + v + ref + ', vencido em ' + venc + ' (' + plural(a.dias, 'dia', 'dias') + ' de atraso).' + (a.total > a.valor ? ' O valor atualizado é ' + brl(a.total) + '.' : '') + ' Preciso que você me dê um retorno até o fim desta semana com a data de pagamento, para eu organizar os próximos passos. Se já pagou, me envie o comprovante e desconsidere esta mensagem.');
    if (k === 'pre' || k === 'dia') parts.push('Se já pagou, pode desconsiderar. Obrigado!');
    if (c.assina) parts.push(c.assina);
    return parts.join('\n\n');
  }
  function messageOf(item) {
    var st = stageOf(item);
    if (item.msg && st && item.msg.st === st.d && clean(item.msg.texto)) return { texto: item.msg.texto, src: item.msg.src };
    return { texto: templateText(item), src: 'modelo' };
  }
  function pixBlock(item) {
    var code = pixFor(item); if (!code) return '';
    return 'Pix copia e cola (' + brl(amounts(item).total) + '):\n' + code;
  }
  function fullMessage(item, texto) {
    var pb = pixBlock(item);
    return String(texto || '').trim() + (pb ? '\n\n' + pb : '');
  }
  function waLink(item, texto) {
    if (!item.fone) return '';
    return 'https://wa.me/' + item.fone + '?text=' + encodeURIComponent(fullMessage(item, texto));
  }

  // ───────────────────────── phones / money / dates parsing ─────────────────────────
  function normPhone(v) {
    var dg = String(v || '').replace(/\D/g, '').replace(/^0+/, '');
    if (dg.length === 10 || dg.length === 11) dg = '55' + dg;
    return /^55\d{10,11}$/.test(dg) ? dg : '';
  }
  function fmtPhone(dg) {
    var m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(dg || ''); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : '';
  }
  function parseMoney(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = String(v || '').replace(/R\$|\s| /gi, '');
    if (!s) return NaN;
    var neg = /^-|^\(.*\)$/.test(s); s = s.replace(/[()\-+]/g, '');
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/\.\d{3}(\.|$)/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '');
    else s = s.replace(/,/g, '');
    var n = parseFloat(s); return isFinite(n) ? (neg ? -n : n) : NaN;
  }
  function parseDateAny(v) {
    if (v instanceof Date && !isNaN(v)) return ymdOf(v);
    var s = String(v == null ? '' : v).trim(); if (!s) return '';
    var m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return ok(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s))) { var y = +m[3]; if (y < 100) y += 2000; return ok(y, +m[2], +m[1]); }
    if ((m = /^(\d{1,2})[\/.\-](\d{1,2})$/.exec(s))) return ok(new Date().getFullYear(), +m[2], +m[1]);
    if (/^\d{5}(\.\d+)?$/.test(s)) { var d = new Date(Math.round((+s - 25569) * 86400000)); return ok(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
    return '';
    function ok(y, mo, da) { var dt = new Date(y, mo - 1, da); return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da && y > 2000 && y < 2100 ? ymdOf(dt) : ''; }
  }

  // ───────────────────────── import (CSV / XLSX / paste) ─────────────────────────
  function detectDelim(text) {
    var c = { ',': 0, ';': 0, '\t': 0 };
    text.split('\n').slice(0, 20).forEach(function (line) {
      var q = false;
      for (var i = 0; i < line.length; i++) { var ch = line[i]; if (ch === '"') q = !q; else if (!q && c[ch] !== undefined) c[ch]++; }
    });
    if (c['\t'] >= c[','] && c['\t'] >= c[';'] && c['\t'] > 0) return '\t';
    return c[';'] >= c[','] && c[';'] > 0 ? ';' : ',';
  }
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var d = detectDelim(text), rows = [], row = [], f = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"' && f === '') q = true;
      else if (ch === d) { row.push(f); f = ''; }
      else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; if (rows.length > MAX_ROWS + 20) break; }
      else if (ch !== '\r') f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); }).map(function (r) { return r.slice(0, 30).map(function (c) { return String(c).slice(0, 200); }); });
  }
  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'vendor/xlsx.js';
      s.onload = function () { window.XLSX ? res() : rej(new Error('xlsx')); };
      s.onerror = function () { rej(new Error('xlsx')); };
      document.head.appendChild(s);
    });
  }
  function rowsFromWorkbook(buf) {
    var wb = XLSX.read(buf, { type: 'array', cellDates: true }), best = [], bestN = -1;
    wb.SheetNames.forEach(function (n) {
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
      rows = rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
      if (rows.length > bestN) { best = rows; bestN = rows.length; }
    });
    return best.slice(0, MAX_ROWS + 20).map(function (r) { return r.slice(0, 30); });
  }
  var FIELDS = [
    { k: 'cliente', label: 'Cliente', re: /^(cliente|nome|name|aluno|paciente|contato|devedor|sacado|pagador|razao|razão)/i, req: true },
    { k: 'fone', label: 'WhatsApp', re: /(whats|zap|celular|telefone|fone|phone|contato tel|tel\b)/i },
    { k: 'valor', label: 'Valor', re: /(valor|preco|preço|mensalidade|total|amount|quantia|r\$)/i, req: true },
    { k: 'venc', label: 'Vencimento', re: /(venc|data|due|dia de pag|prazo)/i, req: true },
    { k: 'ref', label: 'Referência', re: /(refer|descri|servi|produto|plano|parcela|obs.*cobr|item|motivo)/i },
    { k: 'obs', label: 'Observação', re: /(observ|nota|coment)/i }
  ];
  function findHeaderRow(rows) {
    var lim = Math.min(rows.length, 15);
    for (var i = 0; i < lim; i++) {
      // a row holding a date or an amount is data, never the header
      if (rows[i].some(function (c) { var s = String(c).trim(); return s && (parseDateAny(c) || /^(R\$\s*)?[\d.,()\s+-]+$/.test(s)); })) continue;
      var hits = 0; rows[i].forEach(function (c) { var s = String(c).trim(); if (s && s.length < 40 && FIELDS.some(function (f) { return f.re.test(fold(s)) || f.re.test(s); })) hits++; });
      if (hits >= 2) return i;
    }
    return -1;
  }
  function guessMapByContent(rows) {
    // headerless (pasted) rows: cliente, whatsapp, valor, vencimento, referência by content
    var map = { cliente: -1, fone: -1, valor: -1, venc: -1, ref: -1, obs: -1 }, cols = 0;
    rows.forEach(function (r) { cols = Math.max(cols, r.length); });
    var sample = rows.slice(0, 20);
    function share(ci, test) { var n = 0, t = 0; sample.forEach(function (r) { var v = String(r[ci] == null ? '' : r[ci]).trim(); if (!v) return; t++; if (test(v, r[ci])) n++; }); return t ? n / t : 0; }
    var used = {};
    function pick(k, test) { var best = -1, bs = 0.6; for (var c = 0; c < cols; c++) { if (used[c]) continue; var s = share(c, test); if (s > bs) { bs = s; best = c; } } if (best > -1) { map[k] = best; used[best] = 1; } }
    pick('venc', function (v, raw) { return !!parseDateAny(raw); });
    pick('fone', function (v) { return !!normPhone(v) && !/[,]\d{2}$/.test(v); });
    pick('valor', function (v, raw) { var n = parseMoney(raw); return isFinite(n) && n > 0 && n < 10000000; });
    pick('cliente', function (v) { return /[A-Za-zÀ-ú]{2,}/.test(v); });
    pick('ref', function (v) { return /[A-Za-zÀ-ú]{2,}/.test(v); });
    return map;
  }
  function autoMap(header) {
    var map = { cliente: -1, fone: -1, valor: -1, venc: -1, ref: -1, obs: -1 }, used = {};
    FIELDS.forEach(function (f) {
      for (var i = 0; i < header.length; i++) { if (used[i]) continue; var h = String(header[i] || '').trim(); if (h && (f.re.test(fold(h)) || f.re.test(h))) { map[f.k] = i; used[i] = 1; break; } }
    });
    return map;
  }
  function rowsToItems(rows, map) {
    var out = [], bad = 0;
    rows.forEach(function (r) {
      function g(k) { return map[k] > -1 ? r[map[k]] : ''; }
      var cliente = clean(g('cliente')).slice(0, 80), valor = parseMoney(g('valor')), venc = parseDateAny(g('venc'));
      if (!cliente || !(valor > 0) || !venc) { if (r.some(function (c) { return String(c).trim(); })) bad++; return; }
      out.push({ id: uid(), cliente: cliente, fone: normPhone(g('fone')), valor: r2(valor), venc: venc, ref: clean(g('ref')).slice(0, 80), obs: clean(g('obs')).slice(0, 160), rec: false, pago: null, sent: {}, msg: null, criado: Date.now() });
    });
    return { items: out, bad: bad };
  }
  function addItems(list) {
    var seen = {}, added = 0, dup = 0;
    state.d.items.forEach(function (x) { seen[fold(x.cliente) + '|' + x.valor + '|' + x.venc] = 1; });
    list.forEach(function (x) {
      var k = fold(x.cliente) + '|' + x.valor + '|' + x.venc;
      if (seen[k]) { dup++; return; }
      if (state.d.items.length >= MAX_ITEMS) return;
      seen[k] = 1; state.d.items.push(x); added++;
    });
    saveNow();
    return { added: added, dup: dup };
  }
  function showImportError(msg) { var e = $('import-error'); e.textContent = msg; e.hidden = !msg; }
  function handleFile(file) {
    if (!file) return;
    showImportError('');
    if (file.size > 8 * 1024 * 1024) { showImportError('Arquivo grande demais (máx. 8 MB).'); return; }
    var isX = /\.(xlsx|xls)$/i.test(file.name);
    var rd = new FileReader();
    rd.onerror = function () { showImportError('Não consegui ler o arquivo.'); };
    rd.onload = function () {
      if (isX) {
        ensureXLSX().then(function () { openMapping(rowsFromWorkbook(rd.result), file.name); })
          .catch(function () { showImportError('Não consegui abrir a planilha Excel. Exporte como .CSV e tente de novo.'); });
      } else openMapping(parseCSV(rd.result), file.name);
    };
    if (isX) rd.readAsArrayBuffer(file); else rd.readAsText(file, 'utf-8');
    $('file-input').value = '';
  }
  function openMapping(rows, name) {
    if (!rows || !rows.length) { showImportError('O arquivo está vazio.'); return; }
    var h = findHeaderRow(rows), header, body, map;
    if (h > -1) { header = rows[h].map(function (c) { return String(c).trim(); }); body = rows.slice(h + 1); map = autoMap(header); }
    else { body = rows; var n = 0; rows.forEach(function (r) { n = Math.max(n, r.length); }); header = []; for (var i = 0; i < n; i++) header.push('Coluna ' + (i + 1)); map = guessMapByContent(rows); }
    body = body.slice(0, MAX_ROWS);
    state.pendingRaw = { header: header, body: body, map: map, name: name || 'colagem' };
    renderMapping();
  }
  function renderMapping() {
    var p = state.pendingRaw, box = $('mapping');
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    $('map-note').textContent = plural(p.body.length, 'linha encontrada', 'linhas encontradas') + ' em “' + p.name + '”. Confira qual coluna é qual — cliente, valor e vencimento são obrigatórios.';
    $('map-grid').innerHTML = FIELDS.map(function (f) {
      return '<div class="field"><label for="map-' + f.k + '">' + esc(f.label) + (f.req ? ' *' : '') + '</label><select id="map-' + f.k + '" data-map="' + f.k + '"><option value="-1">— nenhuma —</option>' +
        p.header.map(function (h, i) { return '<option value="' + i + '"' + (p.map[f.k] === i ? ' selected' : '') + '>' + esc(h || 'Coluna ' + (i + 1)) + '</option>'; }).join('') + '</select></div>';
    }).join('');
    $('map-grid').querySelectorAll('[data-map]').forEach(function (s) { s.addEventListener('change', function () { p.map[s.getAttribute('data-map')] = +s.value; renderMapPreview(); }); });
    renderMapPreview();
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderMapPreview() {
    var p = state.pendingRaw, res = rowsToItems(p.body.slice(0, 6), p.map);
    $('map-preview').innerHTML = '<thead><tr><th>Cliente</th><th>WhatsApp</th><th class="num">Valor</th><th class="num">Vencimento</th><th>Referência</th></tr></thead><tbody>' +
      (res.items.length ? res.items.map(function (x) { return '<tr><td>' + esc(x.cliente) + '</td><td>' + (x.fone ? esc(fmtPhone(x.fone)) : '<span class="warn-t">sem número válido</span>') + '</td><td class="num">' + esc(brl(x.valor)) + '</td><td class="num">' + esc(dmy(x.venc)) + '</td><td>' + esc(x.ref) + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="warn-t">Nenhuma linha válida com essas colunas — ajuste acima.</td></tr>') + '</tbody>';
  }
  function confirmMapping() {
    var p = state.pendingRaw; if (!p) return;
    if (p.map.cliente < 0 || p.map.valor < 0 || p.map.venc < 0) { toast('Escolha as colunas de cliente, valor e vencimento.'); return; }
    var res = rowsToItems(p.body, p.map);
    if (!res.items.length) { toast('Nenhuma linha válida para importar.'); return; }
    var r = addItems(res.items);
    state.pendingRaw = null; $('mapping').hidden = true;
    toast(plural(r.added, 'cobrança importada', 'cobranças importadas') + (r.dup ? ' · ' + plural(r.dup, 'repetida ignorada', 'repetidas ignoradas') : '') + (res.bad ? ' · ' + plural(res.bad, 'linha incompleta', 'linhas incompletas') : ''));
    state.filter = 'abertas'; paintAll();
  }
  function loadPasted() {
    var t = $('paste-area').value;
    if (!t.trim()) { toast('Cole as linhas primeiro.'); return; }
    openMapping(parseCSV(t), 'linhas coladas');
  }
  function loadExample() {
    var t = todayYmd();
    var ex = [
      ['Ana Beatriz Souza', '11900000001', 450, addDays(t, 3), 'Mensalidade da mentoria', 'cliente há 1 ano, sempre paga em dia', true],
      ['Carlos Eduardo Lima', '21900000002', 1200, t, 'Gestão de tráfego — novembro', '', true],
      ['Juliana Prado', '31900000003', 380, addDays(t, -1), 'Pacote de 4 sessões', 'prefere tom bem informal', false],
      ['Rafael Martins', '41900000004', 890, addDays(t, -5), 'Social media — mensalidade', 'já atrasou outras vezes', true],
      ['Patrícia Gomes', '51900000005', 2500, addDays(t, -16), 'Parcela 2/3 do site', '', false],
      ['Marcos Vinícius Teixeira', '61900000006', 650, addDays(t, -32), 'Consultoria de setembro', 'não responde há semanas', false],
      ['Fernanda Alves', '71900000007', 300, addDays(t, 12), 'Aula particular — pacote mensal', '', true],
      ['Bruno Carvalho', '81900000008', 720, addDays(t, -2), 'Edição de vídeos (4 vídeos)', '', false]
    ];
    var list = ex.map(function (e) { return { id: uid(), cliente: e[0], fone: normPhone(e[1]), valor: e[2], venc: e[3], ref: e[4], obs: e[5], rec: e[6], pago: null, sent: {}, msg: null, criado: Date.now(), exemplo: true }; });
    list[7].pago = { dt: addDays(t, -1), valor: 720 };
    var r = addItems(list);
    toast(r.added ? 'Exemplo carregado: ' + plural(r.added, 'cobrança', 'cobranças') + ' fictícias' : 'O exemplo já está na lista.');
    paintAll();
    gotoTab(pixReady() ? 'fila' : 'lista');
  }
  function downloadTemplate() {
    var lines = ['Cliente;WhatsApp;Valor;Vencimento;Referência;Observação', 'Ana Souza;11988887777;350,00;10/11/2026;Mensalidade de novembro;cliente antigo, sempre paga', 'Carlos Lima;21977776666;1200,00;15/11/2026;Gestão de tráfego;'];
    downloadBlob('planilha-modelo-cobrancas.csv', new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  }

  // ───────────────────────── add / edit form ─────────────────────────
  function addErr(msg) { var e = $('add-error'); e.textContent = msg; e.hidden = !msg; }
  function submitAdd(ev) {
    ev.preventDefault(); addErr('');
    var cliente = $('f-cliente').value.trim().slice(0, 80), foneRaw = $('f-fone').value.trim(), valor = parseMoney($('f-valor').value), venc = $('f-venc').value;
    if (!cliente) return addErr('Informe o nome do cliente.');
    if (!(valor > 0) || valor > 9999999) return addErr('Informe um valor válido (ex.: 350,00).');
    if (!parseYmd(venc)) return addErr('Informe a data de vencimento.');
    var fone = normPhone(foneRaw);
    if (foneRaw && !fone) return addErr('WhatsApp inválido — use DDD + número (ex.: 11999998888).');
    var data = { cliente: cliente, fone: fone, valor: r2(valor), venc: venc, ref: $('f-ref').value.trim().slice(0, 80), obs: $('f-obs').value.trim().slice(0, 160), rec: $('f-rec').checked };
    if (state.editId) {
      var it = getItem(state.editId);
      if (it) {
        var changed = it.valor !== data.valor || it.venc !== data.venc || it.cliente !== data.cliente || it.ref !== data.ref;
        Object.assign(it, data); if (changed) it.msg = null;
      }
      toast('Cobrança atualizada');
    } else {
      state.d.items.push(Object.assign({ id: uid(), pago: null, sent: {}, msg: null, criado: Date.now() }, data));
      toast('Cobrança adicionada');
    }
    saveNow(); resetForm(); paintAll();
  }
  function resetForm() {
    state.editId = '';
    ['f-cliente', 'f-fone', 'f-valor', 'f-ref', 'f-obs'].forEach(function (id) { $(id).value = ''; });
    $('f-venc').value = ''; $('f-rec').checked = false;
    $('add-title').textContent = 'Nova cobrança'; $('add-submit').textContent = 'Adicionar cobrança'; $('add-cancel').hidden = true; addErr('');
  }
  function editItem(id) {
    var it = getItem(id); if (!it) return;
    state.editId = id;
    $('f-cliente').value = it.cliente; $('f-fone').value = it.fone ? it.fone.slice(2) : ''; $('f-valor').value = NF2.format(it.valor);
    $('f-venc').value = it.venc; $('f-ref').value = it.ref || ''; $('f-obs').value = it.obs || ''; $('f-rec').checked = !!it.rec;
    $('add-title').textContent = 'Editar cobrança'; $('add-submit').textContent = 'Salvar alterações'; $('add-cancel').hidden = false;
    gotoTab('lista');
    $('add-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(function () { $('f-cliente').focus(); }, 300);
  }

  // ───────────────────────── pay dialog ─────────────────────────
  function payDialog(id) {
    var it = getItem(id); if (!it) return;
    var a = amounts(it), old = $('pay-modal'); if (old) old.remove();
    var m = document.createElement('div');
    m.className = 'modal active'; m.id = 'pay-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'pay-title');
    m.innerHTML = '<div class="modal-overlay" data-close></div><form class="modal-content" id="pay-form" novalidate><div class="modal-header"><h3 id="pay-title">Marcar como paga</h3><button type="button" class="btn-icon" data-close aria-label="Fechar">×</button></div>' +
      '<p class="field-note">' + esc(it.cliente) + (it.ref ? ' · ' + esc(it.ref) : '') + '</p>' +
      '<div class="grid-2"><div class="field"><label for="pay-dt">Data do pagamento</label><input type="date" id="pay-dt" value="' + todayYmd() + '"></div>' +
      '<div class="field"><label for="pay-v">Valor recebido (R$)</label><input id="pay-v" inputmode="decimal" value="' + esc(NF2.format(a.total)) + '"></div></div>' +
      '<p class="error-message" id="pay-err" hidden></p><div class="modal-actions"><button type="button" class="btn-ghost" data-close>Cancelar</button><button type="submit" class="btn-primary">Confirmar pagamento</button></div></form>';
    document.body.appendChild(m);
    var last = document.activeElement;
    function close() { m.remove(); if (last && last.focus) last.focus(); }
    m.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', close); });
    m.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    $('pay-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var dt = $('pay-dt').value, v = parseMoney($('pay-v').value), er = $('pay-err');
      if (!parseYmd(dt)) { er.textContent = 'Informe a data.'; er.hidden = false; return; }
      if (!(v > 0)) { er.textContent = 'Informe o valor recebido.'; er.hidden = false; return; }
      it.pago = { dt: dt, valor: r2(v) }; saveNow(); close(); paintAll(); toast('Pagamento registrado — ' + firstName(it.cliente) + ' saiu da fila');
    });
    setTimeout(function () { $('pay-v').focus(); }, 30);
  }
  function unpay(id) { var it = getItem(id); if (!it) return; it.pago = null; saveNow(); paintAll(); toast('Pagamento desfeito'); }
  function removeItem(id) {
    var it = getItem(id); if (!it) return;
    if (!confirm('Excluir a cobrança de ' + it.cliente + ' (' + brl(it.valor) + ', ' + dmy(it.venc) + ')?')) return;
    state.d.items = state.d.items.filter(function (x) { return x.id !== id; });
    if (state.editId === id) resetForm();
    saveNow(); paintAll(); toast('Cobrança excluída');
  }
  function markSent(id, on) {
    var it = getItem(id); if (!it) return;
    var st = stageOf(it); it.sent = it.sent || {};
    if (on) { if (!st) return; it.sent[st.d] = Date.now(); toast('Marcada como enviada · ' + st.n); }
    else { Object.keys(it.sent).forEach(function (k) { if (ymdOf(new Date(it.sent[k])) === todayYmd()) delete it.sent[k]; }); toast('Envio desfeito — voltou para a fila'); }
    saveNow(); paintAll();
  }

  // ───────────────────────── AI (BYOK, OpenRouter) ─────────────────────────
  function activeKey() {
    var k = window.ApiKeyManager && ApiKeyManager.getActiveKey ? ApiKeyManager.getActiveKey() : null;
    return k && k.key ? k : null;
  }
  // One OpenRouter call → assistant content string (COR-034/035/053).
  function fetchContent(messages, temperature, signal, maxTokens) {
    var key = activeKey();
    if (!key) return Promise.reject(new Error('Conecte sua chave de IA (ícone de chave no topo) para continuar.'));
    var model = (window.ApiKeyManager && ApiKeyManager.getModel) ? ApiKeyManager.getModel() : 'google/gemini-3.8-flash';
    var body = { model: model, messages: messages, temperature: (temperature == null ? 0.5 : temperature), max_tokens: maxTokens || 8000 };
    if (model.indexOf('deepseek/') !== 0) body.reasoning = { effort: 'low' };
    var doFetch = function () {
      return fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: signal,
        headers: { 'Authorization': 'Bearer ' + key.key, 'Content-Type': 'application/json', 'HTTP-Referer': location.origin, 'X-Title': 'Cobranca IA - Maestros da IA' },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok) {
            var msg = 'Erro ' + r.status + ' do provedor de IA.';
            try { var j = JSON.parse(txt); msg = (j.error && (j.error.message || j.error)) || msg; } catch (e) {}
            if (r.status === 401) msg = 'Chave inválida ou sem permissão. Confira sua chave da OpenRouter.';
            else if (r.status === 402) msg = 'Créditos insuficientes na sua conta OpenRouter.';
            else if (r.status === 429) msg = 'Muitas requisições ao provedor. Aguarde alguns segundos e tente de novo.';
            var e = new Error(String(msg)); e.httpStatus = r.status; throw e;
          }
          var data; try { data = JSON.parse(txt); } catch (e2) { throw new Error('Resposta inválida do provedor de IA.'); }
          if (data && data.error) throw new Error(String(data.error.message || 'Erro do provedor de IA.'));
          var choice = (data.choices && data.choices[0]) || {};
          var content = (choice.message && choice.message.content) || '';
          if (!content || !String(content).trim()) { var em = new Error('Resposta vazia do modelo.'); em.emptyContent = true; throw em; }
          return String(content);
        });
      });
    };
    var run = function () {
      return doFetch().catch(function (e) {
        if (e && e.emptyContent && body.reasoning) { delete body.reasoning; return doFetch(); }
        throw e;
      });
    };
    var limited = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('openrouter', run) : run();
    return Promise.resolve(limited).then(function (res) {
      if (res == null) throw new Error('Limite de uso por minuto atingido. Aguarde um pouco e tente de novo.');
      return res;
    });
  }
  function stripToObject(s) {
    s = String(s).replace(/```json/gi, '').replace(/```/g, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
    return s;
  }
  function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function parseJSONLadder(raw) {
    var s = stripToObject(raw), o = tryParse(s); if (o) return o;
    var s2 = s.replace(/,\s*([}\]])/g, '$1'); o = tryParse(s2); if (o) return o;
    var s3 = s2.replace(/[\x00-\x09\x0b-\x1f]+/g, ' '); o = tryParse(s3); if (o) return o;
    // raw newlines inside strings → \n
    var out = '', q = false;
    for (var i = 0; i < s3.length; i++) { var ch = s3[i]; if (ch === '"' && s3[i - 1] !== '\\') q = !q; out += (q && ch === '\n') ? '\\n' : ch; }
    o = tryParse(out); if (o) return o;
    var s4 = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); return tryParse(s4);
  }
  function callJSON(messages, temperature, signal) {
    return fetchContent(messages, temperature, signal).then(function (txt) {
      var obj = parseJSONLadder(txt); if (obj) return obj;
      var strict = messages.concat([{ role: 'user', content: 'Sua resposta anterior NÃO era um JSON válido. Responda novamente APENAS com o objeto JSON pedido, com aspas retas ("), sem markdown, sem texto antes ou depois.' }]);
      return fetchContent(strict, 0.3, signal).then(function (txt2) {
        var obj2 = parseJSONLadder(txt2); if (obj2) return obj2;
        throw new Error('O modelo não devolveu um JSON válido. Tente de novo (ou troque de modelo).');
      });
    });
  }
  var TOM_TXT = { proximo: 'próximo e informal (como quem tem intimidade com o cliente, sem gírias pesadas)', cordial: 'cordial e profissional', formal: 'formal e respeitoso' };
  function aiPayload(it) {
    var a = amounts(it), st = stageOf(it), h = history(it);
    var o = { id: it.id, nome: firstName(it.cliente), referencia: it.ref || '', valor: brl(a.valor), vencimento: dmy(it.venc), situacao: situacaoAI(a.dias), degrau_da_regua: st ? st.n : '' };
    if (a.total > a.valor) { o.multa = brl(a.multa); o.juros = brl(a.juros); o.valor_atualizado = brl(a.total); }
    if (it.obs) o.observacao_do_vendedor = it.obs;
    if (h.pagas) o.historico = 'pagou ' + h.pagas + ' cobrança(s) anterior(es), ' + (h.atrasadas ? h.atrasadas + ' com atraso' : 'todas em dia');
    return o;
  }
  function aiMessages(batch) {
    var c = state.d.cfg;
    var sys = 'Você escreve mensagens de cobrança para WhatsApp, em português do Brasil, para um pequeno negócio ou profissional autônomo.\n' +
      'Regras obrigatórias:\n' +
      '- Uma mensagem por cobrança, 2 a 4 frases curtas, em 1 ou 2 parágrafos. Sem markdown, sem listas, sem emojis em excesso (no máximo 1).\n' +
      '- Comece cumprimentando a pessoa pelo primeiro nome. Mencione a referência (se houver), o valor e o vencimento EXATAMENTE como recebidos.\n' +
      '- NUNCA invente valores, datas, multas, juros, descontos, prazos de negativação ou consequências. Use só os números recebidos. Se houver valor_atualizado, cite-o junto com o valor original.\n' +
      '- NÃO escreva a chave Pix nem o código Pix: ele será anexado automaticamente logo abaixo da mensagem. Você pode dizer que o Pix está logo abaixo.\n' +
      '- Ajuste a firmeza ao degrau da régua: lembrete antes do vencimento = leve e gentil; dia do vencimento = prático; poucos dias de atraso = compreensivo (pode ter sido esquecimento); atraso maior = firme e direto, pedindo uma data de pagamento; muito atraso / última tentativa = firme, pede retorno com prazo, sem ameaças.\n' +
      '- Respeite o Código de Defesa do Consumidor: nunca constranja, ameace, exponha ou ridicularize o cliente. Sempre ofereça a saída "se já pagou, desconsidere / me envie o comprovante" quando houver atraso.\n' +
      '- Considere a observação do vendedor e o histórico do cliente para calibrar o tom.\n' +
      '- Termine com a assinatura exatamente como recebida (se houver), sozinha na última linha.\n' +
      'Responda APENAS com JSON no formato {"mensagens":[{"id":"<id recebido>","texto":"<mensagem>"}]} com uma entrada para cada cobrança recebida.';
    var user = 'Contexto do vendedor: ' + (c.negocio ? c.negocio : 'prestador de serviços') + '.\nTom geral: ' + (TOM_TXT[c.tom] || TOM_TXT.cordial) + '.\nAssinatura: ' + (c.assina || '(sem assinatura)') + '.\n\nCobranças:\n' + JSON.stringify(batch.map(aiPayload), null, 1);
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }
  // reject any money amount / date the model wrote that is not the real one
  function checkNumbers(it, txt) {
    var a = amounts(it), ok = [a.valor, a.total, a.multa, a.juros].map(function (x) { return r2(x); });
    // the member's own reference text ("Parcela 2/3", "Plano 12/2026") is not a number the model invented
    if (it.ref) txt = txt.split(it.ref).join(' ');
    var bad = false, m, re = /R\$\s?([\d.]+(?:,\d{1,2})?)/g;
    while ((m = re.exec(txt))) { var v = r2(parseMoney(m[1])); if (ok.indexOf(v) === -1) bad = true; }
    var reD = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, vd = parseYmd(it.venc);
    while ((m = reD.exec(txt))) { if (+m[1] !== vd.getDate() || +m[2] !== vd.getMonth() + 1) bad = true; }
    if (/000201\d{2}26|br\.gov\.bcb\.pix/i.test(txt)) bad = true;
    return !bad;
  }
  function runAI(ids) {
    if (state.running) return;
    if (!activeKey()) { toast('Conecte sua chave de IA (ícone de chave no topo) — sem ela, use as mensagens-modelo.'); var mb = $('manage-keys-btn'); if (mb) mb.click(); return; }
    var list = (ids || queueItems().map(function (x) { return x.id; })).map(getItem).filter(function (x) { return x && stageOf(x); });
    if (!list.length) { toast('Nenhuma cobrança na fila para escrever.'); return; }
    state.running = true; state.ctl = new AbortController();
    var single = !!ids, done = 0, rejected = 0, failed = 0, chunks = [];
    for (var i = 0; i < list.length; i += AI_CHUNK) chunks.push(list.slice(i, i + AI_CHUNK));
    setAIUI(true, 0, list.length, single);
    var seq = Promise.resolve();
    chunks.forEach(function (ch) {
      seq = seq.then(function () {
        if (!state.running) return;
        return callJSON(aiMessages(ch), 0.6, state.ctl.signal).then(function (obj) {
          var arr = (obj && Array.isArray(obj.mensagens)) ? obj.mensagens : [];
          ch.forEach(function (it) {
            var hit = arr.filter(function (x) { return x && String(x.id) === it.id; })[0], txt = hit ? clean(hit.texto).slice(0, 1500) : '';
            var st = stageOf(it);
            if (txt && st && checkNumbers(it, txt)) { it.msg = { st: st.d, texto: txt, src: 'ia' }; }
            else { rejected++; if (st) it.msg = { st: st.d, texto: templateText(it), src: 'modelo' }; }
          });
        }).catch(function (e) {
          if (e && e.name === 'AbortError') return;
          failed += ch.length;
          throw e;
        }).then(function () { done += ch.length; saveNow(); setAIUI(true, done, list.length, single); renderQueue(); });
      });
    });
    seq.then(function () {
      var okN = list.length - rejected - failed;
      toast(state.running ? (okN ? plural(okN, 'mensagem escrita pela IA', 'mensagens escritas pela IA') : 'Nenhuma mensagem nova') + (rejected ? ' · ' + rejected + ' com número errado → mensagem-modelo' : '') : 'IA interrompida');
    }).catch(function (e) {
      toast(e && e.message ? e.message : 'Falha ao falar com a IA.');
    }).then(function () { state.running = false; state.ctl = null; setAIUI(false); renderQueue(); renderBadges(); });
  }
  function setAIUI(on, done, total, single) {
    $('ai-write').disabled = !!on; $('ai-stop').hidden = !on; $('ai-progress').hidden = !on;
    if (on) { $('ai-bar').style.width = (total ? Math.round(done * 100 / total) : 0) + '%'; $('ai-write').textContent = single ? 'Reescrevendo…' : 'Escrevendo ' + done + ' de ' + total + '…'; }
    else { $('ai-write').textContent = 'Escrever as mensagens com IA'; renderAINote(); }
  }
  function renderAINote() {
    var n = $('ai-note'); if (!n) return;
    var q = queueItems(), ia = q.filter(function (x) { return messageOf(x).src === 'ia'; }).length;
    n.textContent = activeKey()
      ? (ia === q.length && q.length ? 'Todas as mensagens da fila já foram escritas pela IA. Edite à vontade antes de enviar.' : 'A IA reescreve as mensagens-modelo da fila sob medida para cada cliente (' + q.length + ' na fila). Só vão primeiro nome, valor, vencimento e dias de atraso — nunca telefone nem chave Pix.')
      : 'Sem chave de IA, a fila usa mensagens-modelo prontas (já funcionam). Conecte uma chave para a IA escrever cada uma sob medida.';
  }

  // ───────────────────────── card PNG ─────────────────────────
  function fontsReady() { return (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve(); }
  function wrap(ctx, text, maxW) {
    var words = String(text).split(/\s+/), lines = [], line = '';
    words.forEach(function (w) { var t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; });
    if (line) lines.push(line); return lines;
  }
  function wrapChars(ctx, text, maxW) {
    var lines = [], line = '';
    for (var i = 0; i < text.length; i++) { var t = line + text[i]; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = text[i]; } else line = t; }
    if (line) lines.push(line); return lines;
  }
  function cardPNG(id) {
    var it = getItem(id); if (!it) return;
    var code = pixFor(it); if (!code) { toast('Cadastre o seu Pix primeiro.'); gotoTab('config'); return; }
    fontsReady().then(function () {
      var W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var x = cv.getContext('2d'), a = amounts(it), c = state.d.cfg;
      var PAPER = '#fbf4dc', INK = '#1d2433', MUTED = '#4a5263', RED = '#b8392a', SANS = "'Bricolage Grotesque', Arial, sans-serif", MONO = "'IBM Plex Mono', Menlo, monospace";
      x.fillStyle = '#e9dfc0'; x.fillRect(0, 0, W, H);
      x.fillStyle = PAPER; x.fillRect(40, 40, W - 80, H - 80);
      // stub
      var SX = 300;
      x.fillStyle = '#f3e8c4'; x.fillRect(40, 40, SX - 40, H - 80);
      x.strokeStyle = INK; x.setLineDash([10, 12]); x.lineWidth = 3; x.beginPath(); x.moveTo(SX, 60); x.lineTo(SX, H - 60); x.stroke(); x.setLineDash([]);
      for (var yy = 90; yy < H - 60; yy += 64) { x.fillStyle = '#e9dfc0'; x.beginPath(); x.arc(SX, yy, 9, 0, Math.PI * 2); x.fill(); }
      x.fillStyle = MUTED; x.font = '600 24px ' + MONO; x.fillText('CANHOTO', 70, 110);
      function stubKV(k, v, y) { x.fillStyle = MUTED; x.font = '600 22px ' + MONO; x.fillText(k, 70, y); x.fillStyle = INK; x.font = '700 34px ' + SANS; wrap(x, v, SX - 100).slice(0, 2).forEach(function (l, i) { x.fillText(l, 70, y + 42 + i * 40); }); }
      stubKV('CLIENTE', firstName(it.cliente), 190);
      stubKV('VENCIMENTO', dmy(it.venc), 340);
      stubKV('VALOR', brl(a.total), 450);
      stubKV('Nº', txidOf(it).slice(-8), 560);
      // body
      var BX = SX + 50, BW = W - 40 - BX - 50;
      x.fillStyle = MUTED; x.font = '600 24px ' + MONO; x.fillText('COBRANÇA · PIX', BX, 110);
      var sit = situacao(it), stamped = sit.cls === 'atrasada' || sit.cls === 'hoje';
      x.fillStyle = INK; x.font = '800 60px ' + SANS;
      var ly = 180; wrap(x, it.cliente, stamped ? BW - 250 : BW).slice(0, 2).forEach(function (l) { x.fillText(l, BX, ly); ly += 66; });
      if (it.ref) { x.fillStyle = MUTED; x.font = '500 30px ' + SANS; wrap(x, it.ref, BW).slice(0, 2).forEach(function (l) { x.fillText(l, BX, ly); ly += 38; }); }
      ly += 24;
      x.fillStyle = MUTED; x.font = '600 22px ' + MONO; x.fillText('VALOR A PAGAR', BX, ly); ly += 70;
      x.fillStyle = INK; x.font = '800 78px ' + SANS; x.fillText(brl(a.total), BX, ly);
      ly += 44;
      x.fillStyle = MUTED; x.font = '500 26px ' + SANS;
      x.fillText('Vencimento ' + dmy(it.venc) + (a.total > a.valor ? ' · inclui multa e juros' : ''), BX, ly);
      // stamp
      if (stamped) {
        x.save(); x.translate(W - 205, 175); x.rotate(-0.16); x.strokeStyle = RED; x.lineWidth = 6; x.strokeRect(-120, -42, 240, 84);
        x.fillStyle = RED; x.font = '800 36px ' + SANS; x.textAlign = 'center'; x.fillText(sit.cls === 'hoje' ? 'VENCE HOJE' : 'EM ATRASO', 0, 13); x.restore();
      }
      // QR
      var QS = 470, QY = ly + 40;
      drawQR(x, code, BX, QY, QS, INK, '#ffffff');
      x.strokeStyle = INK; x.lineWidth = 3; x.strokeRect(BX, QY, QS, QS);
      var tx = BX + QS + 26, tw = W - 40 - 30 - tx;
      x.fillStyle = INK; x.font = '700 24px ' + SANS;
      ['Abra o app', 'do seu banco', '→ Pix', '→ Ler QR', 'ou use o', 'copia e cola'].forEach(function (l, i) { x.fillText(l, tx, QY + 36 + i * 36); });
      x.fillStyle = MUTED; x.font = '500 22px ' + SANS;
      wrap(x, 'Recebedor: ' + pixText(c.nome, 25) + ' · ' + pixText(c.cidade, 15), tw).slice(0, 4).forEach(function (l, i) { x.fillText(l, tx, QY + 300 + i * 30); });
      // copia e cola
      var cy = QY + QS + 56;
      x.fillStyle = MUTED; x.font = '600 22px ' + MONO; x.fillText('PIX COPIA E COLA', BX, cy);
      x.fillStyle = INK; x.font = '400 21px ' + MONO;
      wrapChars(x, code, BW).slice(0, 6).forEach(function (l, i) { x.fillText(l, BX, cy + 36 + i * 30); });
      // barcode-ish footer
      x.fillStyle = INK; var bx = BX, seed = code.length;
      while (bx < W - 90) { var w = (seed = (seed * 9301 + 49297) % 233280) % 3 + 2; x.fillRect(bx, H - 150, w, 46); bx += w + ((seed >> 3) % 4) + 2; }
      x.fillStyle = MUTED; x.font = '500 18px ' + MONO; x.fillText('gerado em Cobrança IA · Maestros da IA', BX, H - 72);
      cv.toBlob(function (b) { if (b) { downloadBlob('cobranca-' + slug(it.cliente) + '-' + it.venc + '.png', b); toast('Cartão de cobrança baixado'); } }, 'image/png');
    });
  }

  // ───────────────────────── exports ─────────────────────────
  function downloadBlob(name, blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function csvCell(v) { var s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s) && !/^-?[\d.]+(,\d+)?$/.test(s)) s = "'" + s; return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function num2(v) { return v == null ? '' : NF2.format(v).replace(/\./g, ''); }
  function monthItems(key) { return state.d.items.filter(function (x) { return monthKey(x.venc) === key; }).sort(function (a, b) { return a.venc < b.venc ? -1 : a.venc > b.venc ? 1 : a.cliente.localeCompare(b.cliente); }); }
  function rowOf(it) {
    var a = amounts(it), s = situacao(it), late = it.pago ? Math.max(0, daysLate(it.venc, it.pago.dt)) : '';
    return { cliente: it.cliente, fone: it.fone ? fmtPhone(it.fone) : '', ref: it.ref || '', venc: it.venc, valor: a.valor, atual: it.pago ? '' : a.total, sit: s.txt, pagoEm: it.pago ? it.pago.dt : '', pagoV: it.pago ? it.pago.valor : '', late: late, fixa: it.rec ? 'Sim' : 'Não', pix: it.pago ? '' : pixFor(it) };
  }
  function exportCSV() {
    var list = monthItems(state.month); if (!list.length) { toast('Nenhuma cobrança neste mês.'); return; }
    var lines = [['Cliente', 'WhatsApp', 'Referência', 'Vencimento', 'Valor', 'Valor atualizado', 'Situação', 'Pago em', 'Valor pago', 'Dias de atraso no pagamento', 'Fixa', 'Pix copia e cola'].join(';')];
    list.forEach(function (it) { var r = rowOf(it); lines.push([r.cliente, r.fone, r.ref, dmy(r.venc), num2(r.valor), r.atual === '' ? '' : num2(r.atual), r.sit, r.pagoEm ? dmy(r.pagoEm) : '', r.pagoV === '' ? '' : num2(r.pagoV), r.late, r.fixa, r.pix].map(csvCell).join(';')); });
    downloadBlob('cobrancas-' + state.month + '.csv', new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    toast('CSV do mês baixado');
  }
  function exportXLSX() {
    var list = monthItems(state.month); if (!list.length) { toast('Nenhuma cobrança neste mês.'); return; }
    var btn = $('dl-xlsx'); btn.disabled = true;
    ensureXLSX().then(function () {
      var X = window.XLSX, wb = X.utils.book_new(), money = '#,##0.00';
      var hd = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1D2433' } } };
      var rows = [['Cliente', 'WhatsApp', 'Referência', 'Vencimento', 'Valor', 'Valor atualizado', 'Situação', 'Pago em', 'Valor pago', 'Dias de atraso no pagamento', 'Fixa', 'Pix copia e cola']];
      list.forEach(function (it) { var r = rowOf(it); rows.push([r.cliente, r.fone, r.ref, parseYmd(r.venc), r.valor, r.atual, r.sit, r.pagoEm ? parseYmd(r.pagoEm) : '', r.pagoV, r.late, r.fixa, r.pix]); });
      var n = rows.length;
      rows.push([]); rows.push(['Total do mês', '', '', '', { f: 'SUM(E2:E' + n + ')', z: money }]);
      rows.push(['Recebido', '', '', '', { f: 'SUM(I2:I' + n + ')', z: money }]);
      rows.push(['Em aberto (valor original)', '', '', '', { f: 'SUMIFS(E2:E' + n + ',H2:H' + n + ',"")', z: money }]);
      var ws = X.utils.aoa_to_sheet(rows, { cellDates: true });
      for (var i = 1; i < n; i++) {
        ['D', 'H'].forEach(function (col) { var cc = ws[col + (i + 1)]; if (cc && cc.t === 'd') cc.z = 'dd/mm/yyyy'; });
        ['E', 'F', 'I'].forEach(function (col) { var cc = ws[col + (i + 1)]; if (cc && cc.t === 'n') cc.z = money; });
      }
      for (var j = 0; j < 12; j++) { var ch = ws[X.utils.encode_cell({ r: 0, c: j })]; if (ch) ch.s = hd; }
      ws['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 32 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 6 }, { wch: 70 }];
      ws['!autofilter'] = { ref: 'A1:L' + n };
      var pc = [['Cliente', 'Cobranças', 'Pagas', 'Pagas com atraso', 'Atraso médio (dias)', 'Em aberto (R$)']];
      clientStats().forEach(function (s) { pc.push([s.nome, s.n, s.pagas, s.atrasadas, s.media == null ? '' : Math.round(s.media * 10) / 10, { v: s.aberto, t: 'n', z: money }]); });
      var wc = X.utils.aoa_to_sheet(pc); for (var k = 0; k < 6; k++) wc[X.utils.encode_cell({ r: 0, c: k })].s = hd;
      wc['!cols'] = [{ wch: 30 }, { wch: 11 }, { wch: 8 }, { wch: 16 }, { wch: 18 }, { wch: 16 }];
      X.utils.book_append_sheet(wb, ws, 'Cobranças ' + state.month);
      X.utils.book_append_sheet(wb, wc, 'Por cliente');
      X.writeFile(wb, 'cobrancas-' + state.month + '.xlsx', { compression: true });
      toast('Planilha .xlsx baixada');
    }).catch(function () { toast('Não consegui carregar o gerador de planilha. Tente de novo.'); })
      .then(function () { btn.disabled = false; });
  }
  function clientStats() {
    var G = {};
    state.d.items.forEach(function (it) {
      var k = it.fone || fold(it.cliente), g = G[k] || (G[k] = { nome: it.cliente, n: 0, pagas: 0, atrasadas: 0, somaAtraso: 0, aberto: 0, atrasadoAgora: 0 });
      g.n++;
      if (it.pago) { g.pagas++; var l = Math.max(0, daysLate(it.venc, it.pago.dt)); g.somaAtraso += l; if (l > 0) g.atrasadas++; }
      else { g.aberto += it.valor; if (daysLate(it.venc) > 0) g.atrasadoAgora += it.valor; }
    });
    return Object.keys(G).map(function (k) { var g = G[k]; g.media = g.pagas ? g.somaAtraso / g.pagas : null; return g; })
      .sort(function (a, b) { return b.atrasadoAgora - a.atrasadoAgora || b.aberto - a.aberto || a.nome.localeCompare(b.nome); });
  }
  function nextMonth() {
    var src = monthItems(state.month).filter(function (x) { return x.rec; });
    if (!src.length) { toast('Nenhuma cobrança fixa neste mês. Marque “Cobrança fixa” ao editar.'); return; }
    var list = src.map(function (it) {
      var v = addMonth(it.venc), mo = parseYmd(it.venc).getMonth(), ref = it.ref || '';
      var nm = MONTHS[(mo + 1) % 12];
      ref = ref.replace(new RegExp('\\b' + MONTHS[mo] + '\\b', 'i'), function (w) { return w.charAt(0) === w.charAt(0).toUpperCase() ? nm.charAt(0).toUpperCase() + nm.slice(1) : nm; });
      return { id: uid(), cliente: it.cliente, fone: it.fone, valor: it.valor, venc: v, ref: ref, obs: it.obs, rec: true, pago: null, sent: {}, msg: null, criado: Date.now() };
    });
    var r = addItems(list), nk = monthKey(list[0].venc);
    toast(r.added ? plural(r.added, 'cobrança criada', 'cobranças criadas') + ' em ' + monthLabel(nk) : 'As cobranças fixas de ' + monthLabel(nk) + ' já existem.');
    state.month = nk; paintAll();
  }

  // ───────────────────────── rendering ─────────────────────────
  function queueItems() {
    return state.d.items.filter(inQueue).sort(function (a, b) { return daysLate(b.venc) - daysLate(a.venc) || b.valor - a.valor; });
  }
  function gotoTab(t) {
    document.querySelectorAll('.tab').forEach(function (b) { var on = b.getAttribute('data-tab') === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('on', p.id === 'pane-' + t); });
    paintAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function renderBadges() {
    var q = queueItems().length, open = state.d.items.filter(function (x) { return !x.pago; }).length;
    var b = $('badge-fila'); b.hidden = !q; b.textContent = q;
    var l = $('badge-lista'); l.hidden = !open; l.textContent = open;
    $('dot-config').hidden = !!pixReady();
    var d = new Date(); $('today-pill').textContent = 'Hoje · ' + pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);
  }
  function slipHTML(it) {
    var a = amounts(it), st = stageOf(it), msg = messageOf(it), code = pixFor(it), s = situacao(it), wa = waLink(it, msg.texto);
    return '<article class="slip" data-id="' + esc(it.id) + '">' +
      '<div class="slip-stub">' +
        '<p class="stub-k">Cliente</p><p class="stub-v">' + esc(firstName(it.cliente)) + '</p>' +
        '<p class="stub-k">Venc.</p><p class="stub-v mono">' + esc(dmy(it.venc)) + '</p>' +
        '<p class="stub-k">Valor</p><p class="stub-v mono">' + esc(brl(a.total)) + '</p>' +
        (a.total > a.valor ? '<p class="stub-x">orig. ' + esc(brl(a.valor)) + ' + multa ' + esc(brl(a.multa)) + ' + juros ' + esc(brl(a.juros)) + '</p>' : '') +
        '<p class="stub-k stub-no">Nº</p><p class="stub-v stub-no mono small">' + esc(txidOf(it).slice(-8)) + '</p>' +
      '</div>' +
      '<div class="slip-main">' +
        '<header class="slip-head"><div><h3 class="slip-name">' + esc(it.cliente) + '</h3><p class="slip-ref">' + esc(it.ref || 'Sem referência') + (it.fone ? ' · ' + esc(fmtPhone(it.fone)) : '') + '</p></div>' +
        '<span class="rubber ' + s.cls + '">' + esc(st ? st.n : s.txt) + '<small>' + esc(s.txt) + '</small></span></header>' +
        '<div class="slip-grid">' +
          '<div class="msg-col"><div class="msg-top"><label class="label" for="msg-' + esc(it.id) + '">Mensagem</label><span class="src src-' + msg.src + '">' + esc(SRC_LABEL[msg.src]) + '</span></div>' +
          '<textarea class="msg" id="msg-' + esc(it.id) + '" data-msg="' + esc(it.id) + '" rows="7" maxlength="1500">' + esc(msg.texto) + '</textarea>' +
          '<p class="msg-hint">O Pix copia-e-cola vai logo abaixo desta mensagem, no mesmo envio.</p></div>' +
          '<div class="pix-col">' + (code ? '<canvas class="qr" width="168" height="168" data-qr="' + esc(it.id) + '" role="img" aria-label="QR Code Pix de ' + esc(brl(a.total)) + '"></canvas><p class="label">Pix copia e cola · ' + esc(brl(a.total)) + '</p><code class="pix-code">' + esc(code) + '</code>' : '<p class="pix-missing">Cadastre o seu Pix para gerar o QR e o copia-e-cola.</p><button type="button" class="btn-secondary btn-sm" data-goto="config">Cadastrar Pix</button>') + '</div>' +
        '</div>' +
        '<div class="slip-actions">' +
          (wa ? '<a class="btn-primary btn-wa" href="' + esc(wa) + '" target="_blank" rel="noopener noreferrer" data-wa="' + esc(it.id) + '">Abrir no WhatsApp</a>' : '<span class="btn-primary is-off" aria-disabled="true" title="Sem WhatsApp válido">Sem WhatsApp válido</span>') +
          '<button type="button" class="btn-secondary" data-sent="' + esc(it.id) + '">Marcar como enviada</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-copy="' + esc(it.id) + '">Copiar mensagem + Pix</button>' +
          (code ? '<button type="button" class="btn-ghost btn-sm" data-card="' + esc(it.id) + '">Baixar cartão (PNG)</button>' : '') +
          '<button type="button" class="btn-ghost btn-sm" data-ai1="' + esc(it.id) + '">Reescrever com IA</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-pay="' + esc(it.id) + '">Já pagou</button>' +
          (!it.fone ? '<button type="button" class="btn-ghost btn-sm" data-edit="' + esc(it.id) + '">Corrigir WhatsApp</button>' : '') +
        '</div>' +
      '</div></article>';
  }
  function renderQueue() {
    var q = queueItems(), ready = !!pixReady(), box = $('fila');
    $('fila-setup').hidden = ready || !state.d.items.length;
    $('fila-bar').hidden = !q.length;
    var tot = q.reduce(function (s, x) { return s + amounts(x).total; }, 0);
    $('fila-count').innerHTML = '<b>' + plural(q.length, 'cobrança', 'cobranças') + '</b> para enviar hoje · <b>' + esc(brl(tot)) + '</b>';
    var d = new Date(); $('fila-kicker').textContent = 'Fila de ' + pad2(d.getDate()) + ' de ' + MONTHS[d.getMonth()];
    var sentT = state.d.items.filter(function (x) { return !inQueue(x) && !x.pago && sentToday(x); });
    box.innerHTML = q.map(slipHTML).join('') + (sentT.length ? '<details class="sent-today"><summary>Já enviadas hoje (' + sentT.length + ')</summary><ul>' + sentT.map(function (x) { return '<li><span>' + esc(x.cliente) + ' · ' + esc(brl(amounts(x).total)) + '</span><button type="button" class="btn-ghost btn-sm" data-unsent="' + esc(x.id) + '">Desfazer envio</button></li>'; }).join('') + '</ul></details>' : '');
    box.querySelectorAll('canvas[data-qr]').forEach(function (cv) { var it = getItem(cv.getAttribute('data-qr')); if (it) paintQR(cv, pixFor(it)); });
    var empty = $('fila-empty'), act = $('fila-empty-actions');
    if (!q.length) {
      empty.hidden = false;
      if (!state.d.items.length) {
        $('fila-empty-title').textContent = 'Nenhuma cobrança cadastrada ainda.';
        $('fila-empty-text').textContent = 'Importe a planilha de clientes ou carregue o exemplo para ver a régua funcionando.';
        act.innerHTML = '<button type="button" class="btn-primary" data-goto="lista">Adicionar cobranças</button><button type="button" class="btn-secondary" id="fila-example">Carregar exemplo</button>';
        $('fila-example').addEventListener('click', loadExample);
      } else {
        var nxt = state.d.items.filter(function (x) { return !x.pago; }).map(function (x) { var r = regua().filter(function (s) { return s.d > daysLate(x.venc); })[0]; return r ? addDays(x.venc, r.d) : null; }).filter(Boolean).sort()[0];
        $('fila-empty-title').textContent = 'Fila do dia em dia.';
        $('fila-empty-text').textContent = 'Nenhuma cobrança chegou a um novo degrau da régua hoje.' + (nxt ? ' Próximo envio previsto: ' + dmy(nxt) + '.' : '');
        act.innerHTML = '<button type="button" class="btn-secondary" data-goto="lista">Ver todas as cobranças</button>';
      }
      act.querySelectorAll('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-goto')); }); });
    } else empty.hidden = true;
    wireSlips(box);
    renderAINote();
  }
  function wireSlips(box) {
    box.querySelectorAll('textarea[data-msg]').forEach(function (ta) {
      ta.addEventListener('input', function () {
        var it = getItem(ta.getAttribute('data-msg')), st = it && stageOf(it); if (!st) return;
        it.msg = { st: st.d, texto: ta.value.slice(0, 1500), src: 'voce' }; save();
        var art = ta.closest('.slip'), wa = art.querySelector('[data-wa]'); if (wa) wa.href = waLink(it, ta.value);
        var src = art.querySelector('.src'); if (src) { src.className = 'src src-voce'; src.textContent = SRC_LABEL.voce; }
      });
    });
    box.querySelectorAll('[data-wa]').forEach(function (a) { a.addEventListener('click', function () { var art = a.closest('.slip'); art.classList.add('opened'); toast('Enviou? Volte aqui e marque como enviada.'); }); });
    box.querySelectorAll('[data-sent]').forEach(function (b) { b.addEventListener('click', function () { markSent(b.getAttribute('data-sent'), true); }); });
    box.querySelectorAll('[data-unsent]').forEach(function (b) { b.addEventListener('click', function () { markSent(b.getAttribute('data-unsent'), false); }); });
    box.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = getItem(b.getAttribute('data-copy')), ta = box.querySelector('[data-msg="' + it.id + '"]');
        copyText(fullMessage(it, ta ? ta.value : messageOf(it).texto), 'Mensagem + Pix copiados');
      });
    });
    box.querySelectorAll('[data-card]').forEach(function (b) { b.addEventListener('click', function () { cardPNG(b.getAttribute('data-card')); }); });
    box.querySelectorAll('[data-ai1]').forEach(function (b) { b.addEventListener('click', function () { runAI([b.getAttribute('data-ai1')]); }); });
    box.querySelectorAll('[data-pay]').forEach(function (b) { b.addEventListener('click', function () { payDialog(b.getAttribute('data-pay')); }); });
    box.querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { editItem(b.getAttribute('data-edit')); }); });
    box.querySelectorAll('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-goto')); }); });
    box.querySelectorAll('.pix-code').forEach(function (c) { c.addEventListener('click', function () { copyText(c.textContent, 'Código Pix copiado'); }); c.setAttribute('title', 'Clique para copiar'); });
  }
  function copyText(t, ok) {
    function fallback() { var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.className = 'sr-only'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(ok); } catch (e) { toast('Não consegui copiar — selecione e copie à mão.'); } ta.remove(); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { toast(ok); }, fallback); else fallback();
  }
  function renderList() {
    var all = state.d.items, has = all.length;
    $('list-tools').hidden = !has; $('list-wrap').hidden = !has;
    document.querySelectorAll('[data-filter]').forEach(function (b) { var on = b.getAttribute('data-filter') === state.filter; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    var q = fold(state.q);
    var list = all.filter(function (x) {
      if (state.filter === 'abertas' && x.pago) return false;
      if (state.filter === 'pagas' && !x.pago) return false;
      if (state.filter === 'atrasadas' && (x.pago || daysLate(x.venc) <= 0)) return false;
      return !q || fold(x.cliente).indexOf(q) > -1 || fold(x.ref).indexOf(q) > -1;
    }).sort(function (a, b) { return a.venc < b.venc ? -1 : a.venc > b.venc ? 1 : a.cliente.localeCompare(b.cliente); });
    $('list-body').innerHTML = list.map(function (x) {
      var s = situacao(x), a = amounts(x);
      return '<tr><td><span class="chip-s ' + s.cls + '">' + esc(s.txt) + '</span></td><td><b>' + esc(x.cliente) + '</b>' + (x.rec ? ' <span class="tag">fixa</span>' : '') + (x.fone ? '<br><span class="muted mono">' + esc(fmtPhone(x.fone)) + '</span>' : '<br><span class="warn-t">sem WhatsApp</span>') + '</td><td>' + esc(x.ref) + '</td><td class="num mono">' + esc(dmy(x.venc)) + '</td><td class="num mono">' + esc(brl(x.valor)) + (a.total > a.valor ? '<br><span class="muted">atual. ' + esc(brl(a.total)) + '</span>' : '') + (x.pago ? '<br><span class="muted">pago ' + esc(brl(x.pago.valor)) + '</span>' : '') + '</td>' +
        '<td class="row-actions">' + (x.pago ? '<button type="button" class="btn-ghost btn-sm" data-unpay="' + esc(x.id) + '">Desfazer pagamento</button>' : '<button type="button" class="btn-secondary btn-sm" data-pay="' + esc(x.id) + '">Marcar paga</button>') + '<button type="button" class="btn-ghost btn-sm" data-edit="' + esc(x.id) + '">Editar</button><button type="button" class="btn-ghost btn-sm" data-del="' + esc(x.id) + '" aria-label="Excluir cobrança de ' + esc(x.cliente) + '">Excluir</button></td></tr>';
    }).join('');
    var le = $('list-empty');
    le.hidden = !!list.length && has; le.textContent = !has ? 'Nenhuma cobrança ainda — importe uma planilha, cole linhas ou adicione acima.' : 'Nenhuma cobrança neste filtro.';
    if (!has) le.hidden = false;
    var tb = $('list-body');
    tb.querySelectorAll('[data-pay]').forEach(function (b) { b.addEventListener('click', function () { payDialog(b.getAttribute('data-pay')); }); });
    tb.querySelectorAll('[data-unpay]').forEach(function (b) { b.addEventListener('click', function () { unpay(b.getAttribute('data-unpay')); }); });
    tb.querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { editItem(b.getAttribute('data-edit')); }); });
    tb.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { removeItem(b.getAttribute('data-del')); }); });
  }
  function monthKeys() {
    var K = {}; K[monthKey(todayYmd())] = 1; state.d.items.forEach(function (x) { K[monthKey(x.venc)] = 1; });
    return Object.keys(K).sort();
  }
  function renderControl() {
    var keys = monthKeys(); if (!state.month || keys.indexOf(state.month) === -1) state.month = monthKey(todayYmd());
    $('month-select').innerHTML = keys.map(function (k) { return '<option value="' + k + '"' + (k === state.month ? ' selected' : '') + '>' + esc(monthLabel(k)) + '</option>'; }).join('');
    var list = monthItems(state.month), box = $('ctl');
    if (!list.length) { box.innerHTML = '<div class="empty"><p class="empty-title">Nenhuma cobrança vencendo em ' + esc(monthLabel(state.month)) + '.</p><p>Adicione cobranças na aba Cobranças — ou gere as fixas a partir do mês anterior.</p></div>'; return; }
    var total = 0, rec = 0, aberto = 0, atras = 0, emDia = 0, pagas = 0, fixas = 0;
    list.forEach(function (it) {
      total += it.valor; if (it.rec) fixas++;
      if (it.pago) { rec += it.pago.valor; pagas++; if (daysLate(it.venc, it.pago.dt) <= 0) emDia++; }
      else { aberto += it.valor; if (daysLate(it.venc) > 0) atras += it.valor; }
    });
    var pct = total ? Math.min(100, Math.round((total - aberto) * 100 / total)) : 0;
    var stats = clientStats().filter(function (s) { return s.n; });
    box.innerHTML =
      '<div class="kpis">' +
        kpi('A receber no mês', brl(total), plural(list.length, 'cobrança', 'cobranças') + (fixas ? ' · ' + fixas + ' fixas' : '')) +
        kpi('Recebido', brl(rec), plural(pagas, 'paga', 'pagas') + (pagas ? ' · ' + Math.round(emDia * 100 / pagas) + '% em dia' : ''), 'good') +
        kpi('Em aberto', brl(aberto), plural(list.length - pagas, 'cobrança', 'cobranças')) +
        kpi('Atrasado agora', brl(atras), atras ? 'precisa de régua' : 'nada vencido em aberto', atras ? 'bad' : '') +
      '</div>' +
      '<div class="sheet meter-sheet"><p class="label">Quanto do mês já entrou</p><div class="meter" role="img" aria-label="' + pct + '% do valor do mês já foi pago"><span data-w="' + pct + '"></span></div><p class="meter-t"><b>' + pct + '%</b> do valor do mês já foi pago</p></div>' +
      '<div class="sheet"><h3 class="sheet-h">Histórico por cliente</h3><p class="field-note">Todas as cobranças salvas neste navegador, de todos os meses. Ordenado por quem está devendo agora.</p><div class="table-wrap"><table class="ledger"><thead><tr><th scope="col">Cliente</th><th scope="col" class="num">Cobranças</th><th scope="col" class="num">Pagas</th><th scope="col" class="num">Pagas com atraso</th><th scope="col" class="num">Atraso médio</th><th scope="col" class="num">Em aberto</th></tr></thead><tbody>' +
      stats.map(function (s) { return '<tr><td><b>' + esc(s.nome) + '</b></td><td class="num mono">' + s.n + '</td><td class="num mono">' + s.pagas + '</td><td class="num mono">' + s.atrasadas + '</td><td class="num mono">' + (s.media == null ? '—' : NF0.format(Math.round(s.media)) + ' d') + '</td><td class="num mono' + (s.atrasadoAgora ? ' neg' : '') + '">' + esc(brl(s.aberto)) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
    box.querySelectorAll('[data-w]').forEach(function (el) { el.style.width = el.getAttribute('data-w') + '%'; });
    function kpi(k, v, sub, cls) { return '<div class="kpi ' + (cls || '') + '"><p class="kpi-k">' + esc(k) + '</p><p class="kpi-v">' + esc(v) + '</p><p class="kpi-s">' + esc(sub) + '</p></div>'; }
  }
  function renderConfig() {
    var c = state.d.cfg;
    document.querySelectorAll('input[name="tipo"]').forEach(function (r) { r.checked = r.value === c.tipo; });
    document.querySelectorAll('input[name="tom"]').forEach(function (r) { r.checked = r.value === (c.tom || 'cordial'); });
    if (document.activeElement !== $('c-chave')) $('c-chave').value = c.chave || '';
    if (document.activeElement !== $('c-nome')) $('c-nome').value = c.nome || '';
    if (document.activeElement !== $('c-cidade')) $('c-cidade').value = c.cidade || '';
    if (document.activeElement !== $('c-assina')) $('c-assina').value = c.assina || '';
    if (document.activeElement !== $('c-negocio')) $('c-negocio').value = c.negocio || '';
    if (document.activeElement !== $('c-multa')) $('c-multa').value = c.multa ? NF2.format(c.multa).replace(/,00$/, '') : '';
    if (document.activeElement !== $('c-juros')) $('c-juros').value = c.juros ? NF2.format(c.juros).replace(/,00$/, '') : '';
    renderPixStatus(); renderRegua();
  }
  function renderPixStatus() {
    var c = state.d.cfg, note = $('chave-note'), k = c.chave ? normalizeKey(c.tipo, c.chave) : null;
    note.className = 'field-note' + (k && !k.ok ? ' warn-t' : k && k.ok ? ' ok-t' : '');
    note.textContent = !c.chave ? 'A chave fica só neste navegador — nunca vai para a IA nem para a comunidade.' : k.ok ? 'Chave válida (' + TIPO_LABEL[c.tipo] + '): ' + k.key : k.err;
    var key = pixReady(), box = $('pix-test');
    box.hidden = !key;
    if (key) {
      var code = brCode({ key: key, name: c.nome, city: c.cidade, amount: 1, txid: 'TESTE' });
      $('pix-test-code').textContent = code; paintQR($('pix-test-qr'), code);
    }
  }
  function renderRegua() {
    var R = regua(), box = $('regua');
    box.innerHTML = R.map(function (s, i) {
      return '<li><span class="regua-d mono">' + (s.d === 0 ? 'D' : s.d > 0 ? 'D+' + s.d : 'D' + s.d) + '</span>' +
        '<div class="field"><label for="rg-d-' + i + '">Dia</label><input type="number" id="rg-d-' + i + '" data-rd="' + i + '" min="-30" max="120" step="1" value="' + s.d + '"></div>' +
        '<div class="field grow"><label for="rg-n-' + i + '">Nome do degrau</label><input id="rg-n-' + i + '" data-rn="' + i + '" maxlength="30" value="' + esc(s.n) + '"></div>' +
        '<button type="button" class="btn-ghost btn-sm" data-rx="' + i + '"' + (R.length < 2 ? ' disabled' : '') + ' aria-label="Remover degrau ' + esc(s.n) + '">Remover</button></li>';
    }).join('');
    box.querySelectorAll('[data-rd]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var R2 = regua(), i = +inp.getAttribute('data-rd'), v = Math.max(-30, Math.min(120, parseInt(inp.value, 10)));
        if (isNaN(v)) { renderRegua(); return; }
        if (R2.some(function (s, j) { return j !== i && s.d === v; })) { toast('Já existe um degrau nesse dia.'); renderRegua(); return; }
        R2[i] = { d: v, n: R2[i].n }; state.d.cfg.regua = R2; saveNow(); renderRegua(); renderBadges();
      });
    });
    box.querySelectorAll('[data-rn]').forEach(function (inp) {
      inp.addEventListener('input', function () { var R2 = regua(), i = +inp.getAttribute('data-rn'); R2[i] = { d: R2[i].d, n: inp.value.slice(0, 30) || 'Degrau' }; state.d.cfg.regua = R2; save(); });
    });
    box.querySelectorAll('[data-rx]').forEach(function (b) {
      b.addEventListener('click', function () { var R2 = regua(); if (R2.length < 2) return; R2.splice(+b.getAttribute('data-rx'), 1); state.d.cfg.regua = R2; saveNow(); renderRegua(); renderBadges(); });
    });
  }
  function paintAll() {
    if (!state.d) return;
    renderBadges();
    if ($('pane-fila').classList.contains('on')) renderQueue();
    if ($('pane-lista').classList.contains('on')) { renderList(); renderMapping(); }
    if ($('pane-controle').classList.contains('on')) renderControl();
    if ($('pane-config').classList.contains('on')) renderConfig();
  }

  // ───────────────────────── init ─────────────────────────
  function init() {
    if (state.wired) { if (window.ApiKeyManager) { var s0 = $('model-select'); if (s0 && !s0.options.length) ApiKeyManager.renderModelPicker('model-select'); } paintAll(); return; }
    state.wired = true;
    state.d = load();
    if (window.ApiKeyManager) ApiKeyManager.renderModelPicker('model-select'); // COR-041/047

    document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-tab')); }); });
    document.querySelectorAll('.pane-head ~ .notice [data-goto]').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-goto')); }); });

    // fila
    $('ai-write').addEventListener('click', function () { runAI(null); });
    $('ai-stop').addEventListener('click', function () { if (state.ctl) state.ctl.abort(); state.running = false; });

    // lista / import
    var dz = $('dropzone'), fi = $('file-input');
    fi.addEventListener('change', function () { handleFile(fi.files && fi.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); }); });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });
    $('paste-load').addEventListener('click', loadPasted);
    $('example-btn').addEventListener('click', loadExample);
    $('template-btn').addEventListener('click', downloadTemplate);
    $('map-ok').addEventListener('click', confirmMapping);
    $('map-cancel').addEventListener('click', function () { state.pendingRaw = null; $('mapping').hidden = true; });
    $('add-form').addEventListener('submit', submitAdd);
    $('add-cancel').addEventListener('click', resetForm);
    document.querySelectorAll('[data-filter]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.getAttribute('data-filter'); renderList(); }); });
    var qT = null; $('list-q').addEventListener('input', function () { var v = this.value; clearTimeout(qT); qT = setTimeout(function () { state.q = v; renderList(); }, 160); });

    // controle
    $('month-select').addEventListener('change', function () { state.month = this.value; renderControl(); });
    $('next-month').addEventListener('click', nextMonth);
    $('dl-xlsx').addEventListener('click', exportXLSX);
    $('dl-csv').addEventListener('click', exportCSV);

    // config
    var c = state.d.cfg;
    document.querySelectorAll('input[name="tipo"]').forEach(function (r) { r.addEventListener('change', function () { c.tipo = r.value; saveNow(); renderPixStatus(); renderBadges(); }); });
    document.querySelectorAll('input[name="tom"]').forEach(function (r) { r.addEventListener('change', function () { c.tom = r.value; saveNow(); }); });
    $('c-chave').addEventListener('input', function () {
      c.chave = this.value.trim().slice(0, 77);
      var g = guessTipo(c.chave); if (g && (!c.tipo || (g !== c.tipo && (g === 'email' || g === 'evp' || c.tipo === 'email' || c.tipo === 'evp')))) { c.tipo = g; document.querySelectorAll('input[name="tipo"]').forEach(function (r) { r.checked = r.value === g; }); }
      save(); renderPixStatus(); renderBadges();
    });
    $('c-nome').addEventListener('input', function () { c.nome = this.value.slice(0, 25); save(); renderPixStatus(); renderBadges(); });
    $('c-cidade').addEventListener('input', function () { c.cidade = this.value.slice(0, 15); save(); renderPixStatus(); renderBadges(); });
    $('c-assina').addEventListener('input', function () { c.assina = this.value.slice(0, 60); save(); });
    $('c-negocio').addEventListener('input', function () { c.negocio = this.value.slice(0, 160); save(); });
    $('c-multa').addEventListener('input', function () { var v = parseMoney(this.value); c.multa = v > 0 && v <= 20 ? v : 0; save(); });
    $('c-juros').addEventListener('input', function () { var v = parseMoney(this.value); c.juros = v > 0 && v <= 20 ? v : 0; save(); });
    $('pix-test-copy').addEventListener('click', function () { copyText($('pix-test-code').textContent, 'Código Pix de teste copiado'); });
    $('regua-add').addEventListener('click', function () {
      var R = regua(); if (R.length >= 10) { toast('Máximo de 10 degraus.'); return; }
      var d = R[R.length - 1].d + 7; while (R.some(function (s) { return s.d === d; })) d++;
      R.push({ d: Math.min(d, 120), n: 'Novo degrau' }); state.d.cfg.regua = R; saveNow(); renderRegua();
    });
    $('regua-reset').addEventListener('click', function () { state.d.cfg.regua = DEFAULT_REGUA.slice(); saveNow(); renderRegua(); renderBadges(); toast('Régua padrão restaurada'); });

    // COR-062: logout must leave the login form empty for the next person
    var lo = $('logout-btn');
    if (lo) lo.addEventListener('click', function () {
      var em = $('gate-email'), ph = $('gate-phone'), er = $('gate-error');
      if (em) em.value = ''; if (ph) ph.value = ''; if (er) { er.textContent = ''; er.style.display = 'none'; }
    });
    $('wipe-local').addEventListener('click', function () {
      if (state.running) { toast('Aguarde a IA terminar.'); return; }
      if (!confirm('Apagar deste navegador todas as cobranças, a configuração do Pix, a régua, a sua chave de IA e a sua sessão? Isso não pode ser desfeito.')) return;
      state.wiping = true;
      try {
        var drop = [];
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (/^(cobranca|maestria_)/.test(k)) drop.push(k); }
        drop.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
      location.reload();
    });
    window.addEventListener('beforeunload', function () { if (!state.wiping) saveNow(); });

    paintAll();
    if (!pixReady() && state.d.items.length) gotoTab('config');
  }

  return { init: init, _t: { brCode: brCode, crc16: crc16, normalizeKey: normalizeKey, guessTipo: guessTipo, cpfOk: cpfOk, cnpjOk: cnpjOk, parseMoney: parseMoney, parseDateAny: parseDateAny, normPhone: normPhone, parseCSV: parseCSV, autoMap: autoMap, guessMapByContent: guessMapByContent, rowsToItems: rowsToItems, daysLate: daysLate, addMonth: addMonth, pixText: pixText } };
})();

// ── App init triggers: event + DOMContentLoaded + MutationObserver (COR-044) ──
(function () {
  var started = false;
  function go() { if (started) { App.init(); return; } started = true; App.init(); }
  document.addEventListener('maestria:app-ready', go);
  document.addEventListener('DOMContentLoaded', function () {
    var app = document.getElementById('app-screen');
    if (app && app.classList.contains('active')) { setTimeout(go, 100); }
    if (app) {
      var mo = new MutationObserver(function () { if (app.classList.contains('active')) go(); });
      mo.observe(app, { attributes: true, attributeFilter: ['class'] });
    }
  });
})();
