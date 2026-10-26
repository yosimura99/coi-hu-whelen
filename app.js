'use strict';
/* Còi Hú Whelen – mọi âm thanh được tổng hợp trực tiếp bằng Web Audio API */
(function () {
  var ctx = null, master = null, comp = null, noiseBuf = null, shaperCurves = {};
  var volume = 0.7;
  var primary = null;       // tông chính đang phát {id, voice}
  var rumbler = null;       // lớp rung trầm (chồng lên)
  var horn = null;          // kèn hơi (giữ)
  var manual = null;        // hú tay (giữ)
  var hornHolds = 0, manualHolds = 0;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Khởi tạo âm thanh (iOS cần resume sau lần chạm đầu) ---------- */
  function ensureAudio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { setStatus('Trình duyệt không hỗ trợ Web Audio'); return null; }
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
      ctx = new AC();
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 6;
      comp.attack.value = 0.003; comp.release.value = 0.15;
      master = ctx.createGain();
      master.gain.value = volCurve(volume);
      master.connect(comp); comp.connect(ctx.destination);
      // bộ đệm nhiễu trắng
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // âm im lặng để "mở khoá" iOS
      var s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050);
      s.connect(ctx.destination); s.start(0);
    }
    if (ctx.state !== 'running') { ctx.resume(); }
    return ctx;
  }
  function volCurve(v) { return 0.9 * v * v; }

  function shaperCurve(k) {
    if (shaperCurves[k]) return shaperCurves[k];
    var n = 2048, c = new Float32Array(n), norm = Math.tanh(k);
    for (var i = 0; i < n; i++) { var x = i * 2 / n - 1; c[i] = Math.tanh(k * x) / norm; }
    return (shaperCurves[k] = c);
  }

  function noiseSource() {
    var n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true; return n;
  }

  /* ---------- "Loa kèn": dạng sóng vuông/răng cưa -> méo -> lọc dải ---------- */
  // opts: waves[{type, detune, mult, gain}], drive, hp, peak, lp, bp, bpQ, level
  function hornVoice(opts) {
    var v = { nodes: [], timers: [] };
    v.pitch = ctx.createConstantSource();     // tần số chủ (Hz)
    v.pitch.offset.value = opts.start || 400;
    var mix = ctx.createGain(); mix.gain.value = 1;
    (opts.waves || [{ type: 'square' }]).forEach(function (w) {
      var o = ctx.createOscillator();
      o.type = w.type || 'square';
      o.frequency.value = 0;
      if (w.mult && w.mult !== 1) {
        var m = ctx.createGain(); m.gain.value = w.mult; v.pitch.connect(m); m.connect(o.frequency);
      } else v.pitch.connect(o.frequency);
      o.detune.value = w.detune || 0;
      var g = ctx.createGain(); g.gain.value = w.gain == null ? 0.5 : w.gain;
      o.connect(g); g.connect(mix); o.start();
      v.nodes.push(o);
    });
    var sh = ctx.createWaveShaper(); sh.curve = shaperCurve(opts.drive || 3); sh.oversample = '2x';
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = opts.hp || 350; hp.Q.value = 0.7;
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = opts.bp || 1400; bp.Q.value = opts.bpQ || 0.6;
    var pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = opts.peak || 2400; pk.Q.value = 2; pk.gain.value = 5;
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = opts.lp || 5000; lp.Q.value = 0.5;
    v.gate = ctx.createGain(); v.gate.gain.value = opts.gated ? 0 : 1;
    v.out = ctx.createGain(); v.out.gain.value = 0;
    mix.connect(sh); sh.connect(hp); hp.connect(bp); bp.connect(pk); pk.connect(lp); lp.connect(v.gate); v.gate.connect(v.out);
    v.out.connect(master);
    v.pitch.start();
    v.nodes.push(v.pitch);
    var lvl = opts.level || 0.8;
    v.level = lvl;
    v.out.gain.setTargetAtTime(lvl, ctx.currentTime, opts.attack || 0.02);
    v.filters = { hp: hp, bp: bp, lp: lp };
    return v;
  }

  function stopVoice(v, rel) {
    if (!v || v.dead) return;
    v.dead = true;
    v.timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
    var now = ctx.currentTime, r = rel || 0.04;
    v.out.gain.cancelScheduledValues(now);
    v.out.gain.setValueAtTime(v.out.gain.value, now);
    v.out.gain.setTargetAtTime(0, now, r);
    setTimeout(function () {
      v.nodes.forEach(function (n) { try { n.stop(); } catch (e) {} });
      try { v.out.disconnect(); } catch (e) {}
    }, r * 8000 + 100);
  }

  // Bộ lập lịch nhìn trước: step(v, t, i) lên lịch 1 chu kỳ tại t và trả về độ dài chu kỳ
  function runPattern(v, step) {
    var t = ctx.currentTime + 0.02, i = 0;
    function tick() { while (t < ctx.currentTime + 0.35) { t += step(v, t, i++); } }
    tick();
    v.timers.push(setInterval(tick, 40));
  }

  var P = function (v) { return v.pitch.offset; };
  function sweep(lo, hi, up, down) {
    return function (v, t) {
      var p = P(v);
      p.setValueAtTime(lo, t);
      p.exponentialRampToValueAtTime(hi, t + up);
      p.exponentialRampToValueAtTime(lo, t + up + down);
      return up + down;
    };
  }
  function twoTone(a, b, d) {
    return function (v, t) { var p = P(v); p.setValueAtTime(a, t); p.setValueAtTime(b, t + d); return 2 * d; };
  }

  var SQ = [{ type: 'square', gain: 0.45 }, { type: 'square', detune: 7, gain: 0.3 }];
  var SAW = [{ type: 'sawtooth', gain: 0.4 }, { type: 'square', detune: -6, gain: 0.3 }];

  /* ---------- Danh sách tông ---------- */
  var TONES = [
    { id: 'wail', name: 'WAIL', sub: 'Hú dài', speed: 1, make: function () {
      var v = hornVoice({ waves: SQ, drive: 3, bp: 1300, start: 600 });
      // khởi động từ thấp như còi thật
      runPattern(v, sweep(620, 1520, 2.3, 2.4)); return v; } },
    { id: 'yelp', name: 'YELP', sub: 'Hú nhanh', speed: 2, make: function () {
      var v = hornVoice({ waves: SQ, drive: 3, bp: 1300 });
      runPattern(v, sweep(640, 1540, 0.17, 0.16)); return v; } },
    { id: 'phaser', name: 'PHASER', sub: 'Piercer siêu nhanh', speed: 3, make: function () {
      var v = hornVoice({ waves: SAW, drive: 4, bp: 1700, bpQ: 0.8 });
      runPattern(v, function (v, t) { var p = P(v); p.setValueAtTime(1000, t); p.linearRampToValueAtTime(1750, t + 0.06); return 0.07; });
      return v; } },
    { id: 'hilo', name: 'HI-LO', sub: 'Hai tông châu Âu', speed: 1, make: function () {
      var v = hornVoice({ waves: SQ, drive: 2.5, bp: 1100 });
      runPattern(v, twoTone(960, 740, 0.55)); return v; } },
    { id: 'priority', name: 'PRIORITY', sub: 'Ưu tiên', speed: 2, make: function () {
      var v = hornVoice({ waves: SQ, drive: 3, bp: 1350 });
      runPattern(v, function (v, t) {
        var p = P(v);
        p.setValueAtTime(700, t); p.exponentialRampToValueAtTime(1550, t + 1.0); p.exponentialRampToValueAtTime(900, t + 1.4);
        var tt = t + 1.4;
        for (var k = 0; k < 5; k++) { p.exponentialRampToValueAtTime(1550, tt + 0.1); p.exponentialRampToValueAtTime(700, tt + 0.2); tt += 0.2; }
        return tt - t;
      }); return v; } },
    { id: 'hyper', name: 'HYPER-YELP', sub: 'Hú cực nhanh', speed: 3, make: function () {
      var v = hornVoice({ waves: SQ, drive: 3.5, bp: 1450 });
      runPattern(v, sweep(720, 1600, 0.065, 0.055)); return v; } },
    { id: 'rumbler', name: 'RUMBLER', sub: 'Rung trầm (chồng)', overlay: true, speed: 1, make: function () {
      var v = hornVoice({ waves: [{ type: 'square', gain: 0.5 }, { type: 'sine', mult: 0.5, gain: 0.6 }], drive: 2, hp: 40, bp: 260, bpQ: 0.5, peak: 120, lp: 700, level: 1.0 });
      runPattern(v, sweep(170, 420, 1.6, 1.6)); return v; } },
    { id: 'whistle', name: 'CÒI THỔI', sub: 'Còi cảnh sát', speed: 2, make: function () {
      return whistleVoice(); } },
    { id: 'fire', name: 'CỨU HỎA', sub: 'Còi cơ khí', speed: 1, make: function () {
      return fireVoice(); } },
    { id: 'ambulance', name: 'CỨU THƯƠNG', sub: 'Tò te Việt Nam', speed: 1, make: function () {
      var v = hornVoice({ waves: [{ type: 'square', gain: 0.4 }, { type: 'triangle', gain: 0.5 }], drive: 2.2, bp: 1000, bpQ: 0.7 });
      runPattern(v, twoTone(650, 870, 0.5)); return v; } },
    { id: 'vnpolice', name: 'CÔNG AN', sub: 'Hú Việt Nam', speed: 2, make: function () {
      var v = hornVoice({ waves: SAW, drive: 3, bp: 1250 });
      runPattern(v, function (v, t) {
        var p = P(v);
        p.setValueAtTime(520, t); p.exponentialRampToValueAtTime(1450, t + 0.9);
        p.setValueAtTime(1450, t + 1.05); p.exponentialRampToValueAtTime(520, t + 1.6);
        return 1.6; }); return v; } },
    { id: 'klaxon', name: 'KLAXON', sub: 'Kèn bóp còi', speed: 2, make: function () {
      var v = hornVoice({ waves: [{ type: 'square', gain: 0.4 }, { type: 'square', mult: 1.26, gain: 0.35 }], drive: 4, bp: 900, bpQ: 1.2, gated: true, start: 400 });
      runPattern(v, function (v, t) {
        var g = v.gate.gain, p = P(v);
        p.setValueAtTime(380, t); p.linearRampToValueAtTime(410, t + 0.05);
        g.setValueAtTime(0, t); g.linearRampToValueAtTime(1, t + 0.01); g.setValueAtTime(1, t + 0.22); g.linearRampToValueAtTime(0, t + 0.24);
        g.linearRampToValueAtTime(1, t + 0.36); g.setValueAtTime(1, t + 0.9); g.linearRampToValueAtTime(0, t + 0.93);
        return 1.5; }); return v; } }
  ];

  /* Còi thổi: sóng sin cao + rung (FM/AM ~ 28Hz như hạt bi trong còi) + tiếng hơi */
  function whistleVoice() {
    var v = { nodes: [], timers: [] };
    v.pitch = ctx.createConstantSource(); v.pitch.offset.value = 2900; v.nodes.push(v.pitch);
    var o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 0; v.pitch.connect(o.frequency);
    var o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 0; var m2 = ctx.createGain(); m2.gain.value = 2; v.pitch.connect(m2); m2.connect(o2.frequency);
    var lfo = ctx.createOscillator(); lfo.frequency.value = 27;
    var fm = ctx.createGain(); fm.gain.value = 260; lfo.connect(fm); fm.connect(v.pitch.offset);
    var am = ctx.createGain(); am.gain.value = 0.65;
    var amd = ctx.createGain(); amd.gain.value = 0.35; lfo.connect(amd); amd.connect(am.gain);
    var h2 = ctx.createGain(); h2.gain.value = 0.12; o2.connect(h2); h2.connect(am);
    o.connect(am);
    var n = noiseSource(); var nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 3200; nb.Q.value = 1.5;
    var ng = ctx.createGain(); ng.gain.value = 0.08; n.connect(nb); nb.connect(ng); ng.connect(am);
    v.gate = ctx.createGain(); v.gate.gain.value = 0;
    v.out = ctx.createGain(); v.out.gain.value = 0.55;
    am.connect(v.gate); v.gate.connect(v.out); v.out.connect(master);
    [v.pitch, o, o2, lfo, n].forEach(function (x) { x.start(); v.nodes.push(x); });
    runPattern(v, function (v, t) {
      var g = v.gate.gain;
      function blast(s, d) { g.setValueAtTime(0, s); g.linearRampToValueAtTime(1, s + 0.02); g.setValueAtTime(1, s + d - 0.03); g.linearRampToValueAtTime(0, s + d); }
      blast(t, 0.22); blast(t + 0.35, 0.22); blast(t + 0.7, 1.0);
      return 2.2;
    });
    return v;
  }

  /* Còi cơ khí xe cứu hỏa: rô-to quay lên chậm rồi xuống chậm */
  function fireVoice() {
    var v = hornVoice({ waves: [{ type: 'sawtooth', gain: 0.45 }, { type: 'triangle', gain: 0.4 }, { type: 'square', mult: 2, gain: 0.12 }], drive: 2.5, hp: 120, bp: 1000, bpQ: 0.45, lp: 3200, start: 60, attack: 0.3, level: 0.85 });
    // tiếng gió rít theo cao độ
    var n = noiseSource(); var nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 0; nb.Q.value = 6;
    v.pitch.connect(nb.frequency);
    var ng = ctx.createGain(); ng.gain.value = 0.35; n.connect(nb); nb.connect(ng); ng.connect(v.gate); n.start(); v.nodes.push(n);
    v.isFire = true;
    runPattern(v, function (v, t, i) {
      var p = P(v);
      if (i === 0) p.setValueAtTime(60, t);
      p.setTargetAtTime(1350, t, 1.7);      // quay lên ~6s
      p.setTargetAtTime(220, t + 6.5, 2.4); // nhả, quay xuống
      return 12;
    });
    return v;
  }
  function windDownFire(v) {
    if (!v || v.dead) return;
    v.timers.forEach(function (t) { clearInterval(t); });
    v.timers = [];
    var now = ctx.currentTime, p = P(v);
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now); else { var cur = p.value; p.cancelScheduledValues(now); p.setValueAtTime(cur, now); }
    p.setTargetAtTime(40, now, 1.6);
    stopVoice(v, 1.3);
  }

  /* Kèn hơi: răng cưa trầm, dày, có nhịp phách */
  function startHorn() {
    if (!ensureAudio()) return;
    if (horn && !horn.dead) return;
    horn = hornVoice({ waves: [{ type: 'sawtooth', gain: 0.45 }, { type: 'sawtooth', detune: 18, gain: 0.4 }, { type: 'sawtooth', mult: 1.5, detune: -8, gain: 0.3 }, { type: 'square', mult: 0.5, gain: 0.25 }],
      drive: 5, hp: 90, bp: 750, bpQ: 0.5, peak: 1600, lp: 3800, start: 140, attack: 0.015, level: 1.0 });
    var p = P(horn), now = ctx.currentTime;
    p.setValueAtTime(140, now); p.exponentialRampToValueAtTime(186, now + 0.09);
    $('airhorn').classList.add('held'); refresh();
  }
  function stopHorn() {
    if (!horn) return;
    var p = P(horn), now = ctx.currentTime;
    p.cancelScheduledValues(now); p.setValueAtTime(p.value || 186, now); p.exponentialRampToValueAtTime(150, now + 0.12);
    stopVoice(horn, 0.05); horn = null;
    $('airhorn').classList.remove('held'); refresh();
  }

  /* Hú tay: giữ thì cao độ tăng dần, thả thì tụt dần */
  function manualPress() {
    if (!ensureAudio()) return;
    var now = ctx.currentTime;
    if (!manual || manual.dead) {
      manual = hornVoice({ waves: SQ, drive: 3, bp: 1300, start: 120, attack: 0.05 });
    }
    var p = P(manual), g = manual.out.gain;
    hold(p, now); p.setTargetAtTime(1580, now, 0.9);
    hold(g, now); g.setTargetAtTime(manual.level, now, 0.05);
    clearTimeout(manual.killT);
    $('manual').classList.add('held'); refresh();
  }
  function manualRelease() {
    if (!manual) return;
    var now = ctx.currentTime, p = P(manual), g = manual.out.gain;
    hold(p, now); p.setTargetAtTime(90, now, 1.2);
    hold(g, now); g.setTargetAtTime(0, now + 1.2, 0.8);
    var m = manual;
    m.killT = setTimeout(function () { if (manual === m) { stopVoice(m, 0.1); manual = null; refresh(); } }, 5000);
    $('manual').classList.remove('held'); refresh();
  }
  function hold(param, now) {
    if (param.cancelAndHoldAtTime) { param.cancelAndHoldAtTime(now); }
    else { var v = param.value; param.cancelScheduledValues(now); param.setValueAtTime(v, now); }
  }

  /* ---------- Điều khiển ---------- */
  function selectTone(t) {
    if (!ensureAudio()) return;
    if (t.overlay) {
      if (rumbler) { stopVoice(rumbler, 0.06); rumbler = null; }
      else rumbler = t.make();
    } else if (primary && primary.id === t.id) {
      stopPrimary();
    } else {
      stopPrimary();
      primary = { id: t.id, tone: t, voice: t.make() };
    }
    refresh();
  }
  function stopPrimary() {
    if (!primary) return;
    if (primary.voice.isFire) windDownFire(primary.voice); else stopVoice(primary.voice, 0.04);
    primary = null;
  }
  function stopAll() {
    stopPrimary();
    if (rumbler) { stopVoice(rumbler, 0.05); rumbler = null; }
    if (horn) stopHorn();
    if (manual) { stopVoice(manual, 0.05); manual = null; }
    hornHolds = manualHolds = 0;
    $('airhorn').classList.remove('held'); $('manual').classList.remove('held');
    refresh();
  }

  function refresh() {
    var names = [];
    document.querySelectorAll('.tone').forEach(function (b) {
      var on = (primary && primary.id === b.dataset.id) || (rumbler && b.dataset.id === 'rumbler');
      b.classList.toggle('active', !!on);
    });
    if (primary) names.push(primary.tone.name);
    if (rumbler) names.push('RUMBLER');
    if (manual) names.push('HÚ TAY');
    if (horn) names.push('KÈN HƠI');
    var playing = names.length > 0;
    $('status').classList.toggle('on', playing);
    setStatus(playing ? 'Đang phát: ' + names.join(' + ') : 'Đã dừng – chọn một tông còi');
    lightSpeed = primary ? primary.tone.speed : (horn || manual || rumbler ? 2 : 1);
    lightOn = playing;
  }
  function setStatus(s) { $('statusText').textContent = s; }

  /* ---------- Đèn LED nháy đỏ/xanh ---------- */
  var lightOn = false, lightSpeed = 1;
  var leds = [];
  function lightLoop(ts) {
    var bar = $('lightbar');
    bar.classList.toggle('on', lightOn);
    if (lightOn) {
      var per = [640, 420, 260][lightSpeed - 1] || 640;
      var ph = (ts % per) / per;           // 0..1
      var half = ph < 0.5 ? 'r' : 'b';
      var sub = Math.floor((ph % 0.5) / 0.5 * 6); // 3 lần chớp mỗi nửa
      var flash = sub % 2 === 0;
      var white = Math.floor(ts / 90) % 7 === 0;
      for (var i = 0; i < leds.length; i++) {
        var l = leds[i], f = false;
        if (l.classList.contains('w')) f = white;
        else f = l.classList.contains(half) && flash;
        l.classList.toggle('f', f);
      }
    }
    requestAnimationFrame(lightLoop);
  }

  /* ---------- Giao diện ---------- */
  function build() {
    var grid = $('grid');
    TONES.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'tone'; b.dataset.id = t.id;
      b.innerHTML = t.name + '<small>' + t.sub + '</small>';
      b.addEventListener('pointerdown', function (e) { e.preventDefault(); selectTone(t); });
      grid.appendChild(b);
    });
    holdButton($('airhorn'), function () { if (hornHolds++ === 0) startHorn(); }, function () { if (hornHolds > 0 && --hornHolds === 0) stopHorn(); });
    holdButton($('manual'), function () { if (manualHolds++ === 0) manualPress(); }, function () { if (manualHolds > 0 && --manualHolds === 0) manualRelease(); });
    $('stop').addEventListener('pointerdown', function (e) { e.preventDefault(); ensureAudio(); stopAll(); });
    var vol = $('volume');
    vol.addEventListener('input', function () {
      volume = vol.value / 100; $('volVal').textContent = vol.value + '%';
      if (master) master.gain.setTargetAtTime(volCurve(volume), ctx.currentTime, 0.03);
    });
    leds = Array.prototype.slice.call(document.querySelectorAll('.led'));
    // lần chạm đầu tiên: mở khoá âm thanh iOS
    var unlock = function () { ensureAudio(); };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('touchend', unlock, true);
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && ctx && ctx.state !== 'running') ctx.resume(); });
    requestAnimationFrame(lightLoop);
  }
  // nút giữ, hỗ trợ đa điểm chạm qua Pointer Events
  function holdButton(el, down, up) {
    var active = {};
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      if (!active[e.pointerId]) { active[e.pointerId] = 1; down(); }
    });
    var end = function (e) { if (active[e.pointerId]) { delete active[e.pointerId]; up(); } };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { el.addEventListener(ev, end); });
  }

  build();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () {}); });
  }
})();
