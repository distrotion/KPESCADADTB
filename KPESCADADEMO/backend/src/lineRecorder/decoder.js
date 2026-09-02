// decoder.js — raw array จาก PLC + config → canonical event
//   canonical: { line, type, carrier, lane, dateKey, station, seq, stationType,
//                enterTs, exitTs, values:{}, raw, ts }
//   ภาษากลางเดียวทุกไลน์ — ความต่างอยู่ที่ config.decode/events/stations/fields

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function _at(arr, idx) { return (idx == null || !Array.isArray(arr)) ? null : arr[idx]; }

// eventType (จาก decode.eventType) อยู่ในกลุ่มไหน → ENTER/STEP/STAGE/EXIT (null=ไม่รู้จัก)
function _typeOf(events, code) {
  for (const t of ['ENTER', 'STEP', 'STAGE', 'EXIT']) {
    if ((events[t] || []).includes(Number(code))) return t;
  }
  return null;
}

// เก็บ field ที่ source=plc (index) → values (manual/formula เติมภายหลัง)
function _plcValues(fields, raw, station) {
  const out = {};
  for (const f of (fields || [])) {
    if (f.scope === 'step' && f.station && String(f.station) !== String(station)) continue;
    if (f.source && f.source.kind === 'plc' && f.source.index != null) {
      const v = _num(_at(raw, f.source.index));
      if (v != null) out[f.key] = v;
    }
  }
  return out;
}

// decode 1 message (array) → canonical event | null (ถ้า eventType ไม่รู้จัก)
function decode(raw, cfg, nowTs) {
  if (!Array.isArray(raw)) return null;
  const d = cfg.decode || {};
  const code = _num(_at(raw, d.eventType));
  const type = _typeOf(cfg.events || {}, code);
  if (!type) return null;
  const stationCode = _at(raw, d.stationCode);
  const st = (cfg.stations || {})[String(stationCode)] || {};
  const laneRaw = _at(raw, d.lane);
  const lane = (cfg.lanes || {})[String(laneRaw)] || (laneRaw != null ? String(laneRaw) : '');
  return {
    line: cfg.line,
    type,
    eventCode: code,
    carrier: _at(raw, d.carrier) != null ? String(_at(raw, d.carrier)) : '',
    lane,
    dateKey: _at(raw, d.dateKey) != null ? String(_at(raw, d.dateKey)) : '',
    station: stationCode != null ? String(stationCode) : '',
    stationName: st.name || '',
    stationType: st.type || '',
    seq: st.seq != null ? Number(st.seq) : null,
    enterTs: _num(_at(raw, d.enterTime)),
    exitTs: _num(_at(raw, d.exitTime)),
    values: _plcValues(cfg.fields, raw, stationCode),
    raw,
    ts: nowTs || null,
  };
}

module.exports = { decode };
