/* SIMATS Anime Club — soundtrack, played with the Web Audio API.
   Everything except "The Rising Sun" is composed here and synthesised live in the browser (no samples).

   Score
   - Intro  "The Rising Sun" by kaazoom (Pixabay, free licence), 30-second edit (loops if the intro runs longer). If it can't load, the composed
            "Oni no Kōshin" (March of the Oni) plays instead: taiko, low strings and a shamisen riff that build with the
            scroll into a shinobue theme, brass stabs, high strings, choir and cymbals (In scale on D, 150 bpm).
   - Logo   a temple gong (tam-tam roar) with an orchestral hit when the SIMATS logo appears.
   - Calm   a shuffled playlist of 32 songs; the next one is random and never one of the last ~12 played:
            - "The Rising Sun" (full) and its 2-minute edit
            - "Oni no Kōshin" as a full build-up
            - six shinobue-and-orchestra pieces (Kaze no Uta, Hikari no Michi, Ryū no Sora, Yūgure no Shiro, Tabidachi, Hanabi)
            - three hand-written (Sakura no Niwa, Tsuki no Yashiro, Chaya no Kaze) and twenty composed by a seeded
              melody writer, so each always plays the same tune (koto, shakuhachi, shinobue, shamisen, biwa, kokyū,
              temple bells, wind chimes, soft taiko, rain and sea)

   API: ClubMusic.enable(true|false), setProgress(introProgress0to1), enabled, track, tracks,
        state() -> {stage, name, jp, en, index, count, elapsed, duration, enabled}, next(), prev(), select(i), seek(0..1) */
(function(){
  'use strict';
  const MIDI=(m)=>440*Math.pow(2,(m-69)/12);
  let ac=null, out, bus, introG, calmG, fxG, noise, dryOut, introDry, calmDry;
  // Recorded tracks (Pixabay licence: free to use, no attribution required; credited anyway).
  // They skip the synth reverb/compressor and play through their own "dry" path, levelled by *_FILE_GAIN.
  const INTRO_FILE='assets/music/rising-sun-30s.mp3', INTRO_FILE_GAIN=1.8, CALM_FILE_GAIN=1.2;
  let introM=null, useIntroFile=true, introPending=false, curM=null;
  let enabled=false, timer=0, nextT=0, step=0, prog=0;
  let stage='intro', switchAt=0, calmIdx=0, calmStep=0, calmEndsAt=0, gongPlayed=false, trackG=null;

  // ---------- setup ----------
  function init(){ build(new (window.AudioContext||window.webkitAudioContext)());
    introM=media(INTRO_FILE,'auto',INTRO_FILE_GAIN); introM.el.loop=true; introM.g.connect(introDry);
    introM.el.addEventListener('error',()=>{ useIntroFile=false; });            // file missing -> the composed intro plays instead
    for(const T of CALM) if(T.file){ T.m=media(T.file,'none',CALM_FILE_GAIN); T.m.el.addEventListener('loadedmetadata',()=>{ if(isFinite(T.m.el.duration)) T.dur=T.m.el.duration; }); }
    document.addEventListener('visibilitychange',()=>{ if(!ac) return;
      if(document.hidden){ ac.suspend(); pauseFiles(); }
      else if(enabled){ ac.resume(); if(stage==='calm'&&curM) curM.el.play().catch(()=>{}); } }); }
  function media(src,preload,gain){ const el=new Audio(); el.preload=preload; el.src=src; const node=ac.createMediaElementSource(el), g=ac.createGain(); g.gain.value=gain; node.connect(g); return {el,node,g}; }
  function pauseFiles(){ if(introM) introM.el.pause(); if(curM) curM.el.pause(); introPending=false; }
  // phones only let a media element start inside a tap, so each one is started and paused during the first tap
  function unlockFiles(){ for(const m of [introM,...CALM.filter(T=>T.m).map(T=>T.m)]){ if(!m||!m.el.paused) continue;
    const p=m.el.play(); if(p) p.then(()=>{ if(!(m===introM&&stage==='intro')&&m!==curM) m.el.pause(); }).catch(()=>{}); } }
  const multi=(ps)=>new Proxy({},{get:(_,k)=>(...x)=>ps.forEach(p=>p[k](...x))});
  const IG=()=>multi([introG.gain,introDry.gain]), CG=()=>multi([calmG.gain,calmDry.gain]);   // synth + recorded faders move together
  function build(ctx){
    ac=ctx;
    out=ac.createGain(); out.gain.value=0;
    const comp=ac.createDynamicsCompressor(); comp.threshold.value=-16; comp.knee.value=10; comp.ratio.value=4; comp.attack.value=.004; comp.release.value=.2;
    bus=ac.createGain();
    const rev=ac.createConvolver(); rev.buffer=impulse(3.4,2.6); const rg=ac.createGain(); rg.gain.value=.3;
    bus.connect(comp); bus.connect(rev); rev.connect(rg); rg.connect(comp); comp.connect(out); out.connect(ac.destination);
    introG=ac.createGain(); calmG=ac.createGain(); fxG=ac.createGain(); calmG.gain.value=0;
    introG.connect(bus); calmG.connect(bus); fxG.connect(bus);
    dryOut=ac.createGain(); dryOut.connect(out);
    introDry=ac.createGain(); calmDry=ac.createGain(); calmDry.gain.value=0; introDry.connect(dryOut); calmDry.connect(dryOut);
    noise=ac.createBuffer(1,ac.sampleRate*2,ac.sampleRate); const d=noise.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
  }
  function impulse(sec,decay){ const n=ac.sampleRate*sec, b=ac.createBuffer(2,n,ac.sampleRate);
    for(let c=0;c<2;c++){ const d=b.getChannelData(c); for(let i=0;i<n;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/n,decay); } return b; }
  function env(g,t,a,peak,dec){ g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(Math.max(.0002,peak),t+a); g.gain.exponentialRampToValueAtTime(.0001,t+a+dec); }
  function nsrc(t,dur){ const s=ac.createBufferSource(); s.buffer=noise; s.start(t,Math.random()); s.stop(t+dur); return s; }

  // ---------- instruments ----------
  function taiko(t,v,dest,p=1){
    const o=ac.createOscillator(), g=ac.createGain(); o.type='sine';
    o.frequency.setValueAtTime(150*p,t); o.frequency.exponentialRampToValueAtTime(46*p,t+.22);
    env(g,t,.004,v,.75); o.connect(g).connect(dest); o.start(t); o.stop(t+.9);
    const n=nsrc(t,.2), f=ac.createBiquadFilter(), ng=ac.createGain(); f.type='bandpass'; f.frequency.value=190; f.Q.value=.8;
    env(ng,t,.002,v*.9,.12); n.connect(f).connect(ng).connect(dest);
  }
  function ka(t,v,dest){ const n=nsrc(t,.06), f=ac.createBiquadFilter(), g=ac.createGain(); f.type='highpass'; f.frequency.value=2400; env(g,t,.001,v,.045); n.connect(f).connect(g).connect(dest);
    const o=ac.createOscillator(), og=ac.createGain(); o.type='triangle'; o.frequency.value=1150; env(og,t,.001,v*.5,.04); o.connect(og).connect(dest); o.start(t); o.stop(t+.08); }
  function shime(t,v,dest){ const o=ac.createOscillator(), g=ac.createGain(); o.frequency.setValueAtTime(360,t); o.frequency.exponentialRampToValueAtTime(230,t+.05);
    env(g,t,.002,v,.11); o.connect(g).connect(dest); o.start(t); o.stop(t+.16);
    const n=nsrc(t,.05), f=ac.createBiquadFilter(), ng=ac.createGain(); f.type='highpass'; f.frequency.value=1500; env(ng,t,.001,v*.35,.04); n.connect(f).connect(ng).connect(dest); }
  function shamisen(t,f,v,dest,dur=.45){
    const o=ac.createOscillator(), o2=ac.createOscillator(), lp=ac.createBiquadFilter(), g=ac.createGain();
    o.type='sawtooth'; o2.type='square'; o.frequency.setValueAtTime(f*1.025,t); o.frequency.exponentialRampToValueAtTime(f,t+.025);
    o2.frequency.setValueAtTime(f*2.003,t); const g2=ac.createGain(); g2.gain.value=.18;                         // sawari buzz
    lp.type='lowpass'; lp.Q.value=4; lp.frequency.setValueAtTime(4200,t); lp.frequency.exponentialRampToValueAtTime(700,t+.18);
    env(g,t,.002,v,dur); o.connect(lp); o2.connect(g2).connect(lp); lp.connect(g).connect(dest);
    o.start(t); o2.start(t); o.stop(t+dur+.1); o2.stop(t+dur+.1);
  }
  function koto(t,f,v,dest,dec=2.4){
    const o=ac.createOscillator(), h=ac.createOscillator(), lp=ac.createBiquadFilter(), g=ac.createGain(), hg=ac.createGain();
    o.type='triangle'; h.type='sine'; o.frequency.setValueAtTime(f*1.008,t); o.frequency.exponentialRampToValueAtTime(f,t+.05); h.frequency.value=f*2; hg.gain.value=.3;
    lp.type='lowpass'; lp.frequency.setValueAtTime(3400,t); lp.frequency.exponentialRampToValueAtTime(650,t+dec*.6);
    env(g,t,.004,v,dec); o.connect(lp); h.connect(hg).connect(lp); lp.connect(g).connect(dest);
    o.start(t); h.start(t); o.stop(t+dec+.2); h.stop(t+dec+.2);
  }
  function shaku(t,f,dur,v,dest){
    const o=ac.createOscillator(), g=ac.createGain(), lfo=ac.createOscillator(), lg=ac.createGain();
    o.type='sine'; o.frequency.setValueAtTime(f*.965,t); o.frequency.linearRampToValueAtTime(f,t+.22);           // meri-kari scoop
    lfo.frequency.value=5.2; lg.gain.setValueAtTime(0,t); lg.gain.linearRampToValueAtTime(f*.011,t+Math.min(dur,1.2));
    lfo.connect(lg).connect(o.frequency);
    g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+.28); g.gain.setValueAtTime(v,t+dur-.35); g.gain.exponentialRampToValueAtTime(.0001,t+dur);
    o.connect(g).connect(dest); o.start(t); lfo.start(t); o.stop(t+dur+.05); lfo.stop(t+dur+.05);
    const n=nsrc(t,dur), bp=ac.createBiquadFilter(), ng=ac.createGain(); bp.type='bandpass'; bp.frequency.value=f*2.2; bp.Q.value=2;
    ng.gain.setValueAtTime(.0001,t); ng.gain.exponentialRampToValueAtTime(v*.22,t+.1); ng.gain.exponentialRampToValueAtTime(.0001,t+dur); n.connect(bp).connect(ng).connect(dest);
  }
  function drone(t,dur,fs,v,dest){ for(const f of fs){ const o=ac.createOscillator(), g=ac.createGain(); o.type='sine'; o.frequency.value=f;
    g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+2); g.gain.setValueAtTime(v,t+dur-2); g.gain.exponentialRampToValueAtTime(.0001,t+dur);
    o.connect(g).connect(dest); o.start(t); o.stop(t+dur+.1); } }
  function chime(t,dest){ const b=1800+Math.random()*1500; for(const m of [1,2.76,5.4]){ const o=ac.createOscillator(), g=ac.createGain(); o.type='sine'; o.frequency.value=b*m;
    env(g,t,.003,.03/m,3); o.connect(g).connect(dest); o.start(t); o.stop(t+3.2); } }
  // Temple gong / tam-tam. A real one roars: the mallet thump, then the energy blooms from the low hum up into a
  // bright, beating wash of inharmonic partials that swells for about a second before the long decay.
  const GONG=(()=>{ let a=7; const R=()=>{ a=(a*16807)%2147483647; return a/2147483647; };      // fixed partial set
    const P=[]; for(let k=1;k<=72;k++){ const r=Math.pow(k,.96)*(1+(R()-.5)*.09); P.push([r,1/Math.pow(k,.5),k/72,(R()-.5)*1.4]); } return P; })();
  function loopNoise(t,dur){ const n=ac.createBufferSource(); n.buffer=noise; n.loop=true; n.start(t,Math.random()); n.stop(t+dur); return n; }
  function gong(t){
    const f0=54, d=fxG, master=ac.createGain(); master.gain.value=1.15; master.connect(d);
    // body: inharmonic partials, each a slightly detuned pair (beating); higher ones bloom later and die sooner
    for(const [r,amp,h,det] of GONG){ const f=f0*r; if(f>5200) continue;
      const g=ac.createGain(), peak=amp*.13, bloom=.015+h*h*1.25, dec=13*(1-.75*h)+1.2;
      g.gain.setValueAtTime(.0001,t); g.gain.linearRampToValueAtTime(peak*(h<.15?1:.35),t+.012);
      g.gain.exponentialRampToValueAtTime(peak,t+bloom+.02); g.gain.exponentialRampToValueAtTime(.0001,t+bloom+dec); g.connect(master);
      for(const tw of [0,det+.5]){ const o=ac.createOscillator(); o.type='sine';
        o.frequency.setValueAtTime(f*(1.018-h*.01)+tw,t); o.frequency.exponentialRampToValueAtTime(f+tw,t+2.2);       // the pitch sags as it settles
        o.connect(g); o.start(t); o.stop(t+bloom+dec+.1); } }
    // the roar: noise through resonant bands that swell up after the strike and wash out slowly
    for(const [fc,q,pk,at,dec] of [[180,3,.22,.25,6],[420,4,.2,.45,6.5],[900,5,.17,.75,5.5],[1750,6,.16,1.0,4.5],[3300,6,.12,1.2,3.8],[6200,4,.06,1.35,2.8]]){
      const n=loopNoise(t,at+dec+.2), bp=ac.createBiquadFilter(), g=ac.createGain(); bp.type='bandpass'; bp.frequency.value=fc; bp.Q.value=q;
      g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(pk,t+at); g.gain.exponentialRampToValueAtTime(.0001,t+at+dec); n.connect(bp).connect(g).connect(master); }
    // mallet: a soft, heavy thump with a low "whomp", plus a sub swell under it all
    const th=ac.createOscillator(), tg=ac.createGain(); th.type='sine'; th.frequency.setValueAtTime(95,t); th.frequency.exponentialRampToValueAtTime(38,t+.35);
    env(tg,t,.004,.9,.6); th.connect(tg).connect(master); th.start(t); th.stop(t+.8);
    const mn=nsrc(t,.25), lp=ac.createBiquadFilter(), mg=ac.createGain(); lp.type='lowpass'; lp.frequency.value=700; env(mg,t,.002,.5,.18); mn.connect(lp).connect(mg).connect(master);
    const sub=ac.createOscillator(), sg=ac.createGain(); sub.type='sine'; sub.frequency.value=f0*.75;
    sg.gain.setValueAtTime(.0001,t); sg.gain.exponentialRampToValueAtTime(.18,t+.6); sg.gain.exponentialRampToValueAtTime(.0001,t+9); sub.connect(sg).connect(master); sub.start(t); sub.stop(t+9.1);
    taiko(t,.8,d,.7);
    for(const k of [26,38,45,50,57]) brass(t,MIDI(k+12),.05,d,1.4);   // orchestral hit with the gong
  }
  // render just the gong to a WAV (for listening samples)
  async function renderGongWav(tail=14){
    const saved=[ac,out,bus,introG,calmG,fxG,noise,prog,dryOut,introDry,calmDry], sr=44100;
    build(new OfflineAudioContext(2,Math.round(tail*sr),sr)); out.gain.value=.6; gong(.1);
    const buf=await ac.startRendering(); [ac,out,bus,introG,calmG,fxG,noise,prog,dryOut,introDry,calmDry]=saved; return wavOf(buf,sr);
  }
  function wavOf(buf,sr){
    const n=buf.length, L=buf.getChannelData(0), R=buf.getChannelData(1), dv=new DataView(new ArrayBuffer(44+n*4));
    const w=(o,str)=>{ for(let i=0;i<str.length;i++) dv.setUint8(o+i,str.charCodeAt(i)); };
    w(0,'RIFF'); dv.setUint32(4,36+n*4,true); w(8,'WAVE'); w(12,'fmt '); dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,2,true);
    dv.setUint32(24,sr,true); dv.setUint32(28,sr*4,true); dv.setUint16(32,4,true); dv.setUint16(34,16,true); w(36,'data'); dv.setUint32(40,n*4,true);
    let peak=0; for(let i=0;i<n;i++){ peak=Math.max(peak,Math.abs(L[i]),Math.abs(R[i])); dv.setInt16(44+i*4,Math.max(-1,Math.min(1,L[i]))*32767,true); dv.setInt16(46+i*4,Math.max(-1,Math.min(1,R[i]))*32767,true); }
    return {wav:dv.buffer,peak};
  }

  // ---------- orchestra for the intro ----------
  function saws(t,f,cents,dest,stop){ return cents.map(c=>{ const o=ac.createOscillator(); o.type='sawtooth'; o.frequency.value=f; o.detune.value=c; o.connect(dest); o.start(t); o.stop(stop); return o; }); }
  function strStac(t,f,v,dest,len=.17){                              // low strings, driving staccato
    const lp=ac.createBiquadFilter(), g=ac.createGain(); lp.type='lowpass'; lp.frequency.setValueAtTime(2600,t); lp.frequency.exponentialRampToValueAtTime(700,t+len); lp.Q.value=.8;
    saws(t,f,[-8,8],lp,t+len+.15); env(g,t,.006,v,len); lp.connect(g).connect(dest);
  }
  function strPad(t,f,dur,v,dest,trem){                              // high strings, sustained (tremolo when the storm peaks)
    const lp=ac.createBiquadFilter(), g=ac.createGain(); lp.type='lowpass'; lp.frequency.value=3200;
    saws(t,f,[-11,0,11],lp,t+dur+.4);
    g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+.18); g.gain.setValueAtTime(v,t+dur-.05); g.gain.exponentialRampToValueAtTime(.0001,t+dur+.3);
    if(trem){ const tg=ac.createGain(), l=ac.createOscillator(), lg=ac.createGain(); l.frequency.value=13; lg.gain.value=.45; tg.gain.value=.55; l.connect(lg).connect(tg.gain); l.start(t); l.stop(t+dur+.4); lp.connect(tg).connect(g); }
    else lp.connect(g); g.connect(dest);
  }
  function brass(t,f,v,dest,dur=.34){                               // horn / trombone stab
    const lp=ac.createBiquadFilter(), g=ac.createGain(); lp.type='lowpass'; lp.Q.value=2;
    lp.frequency.setValueAtTime(380,t); lp.frequency.exponentialRampToValueAtTime(3400,t+.035); lp.frequency.exponentialRampToValueAtTime(900,t+dur);
    saws(t,f,[-6,6],lp,t+dur+.2); const sq=ac.createOscillator(), sg=ac.createGain(); sq.type='square'; sq.frequency.value=f/2; sg.gain.value=.35; sq.connect(sg).connect(lp); sq.start(t); sq.stop(t+dur+.2);
    g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+.02); g.gain.setValueAtTime(v*.8,t+dur*.6); g.gain.exponentialRampToValueAtTime(.0001,t+dur+.15);
    lp.connect(g).connect(dest);
  }
  function fue(t,f,dur,v,dest){                                      // shinobue: shrill bamboo flute with a grace-note flick and vibrato
    const o=ac.createOscillator(), o2=ac.createOscillator(), g=ac.createGain(), g2=ac.createGain(), l=ac.createOscillator(), lg=ac.createGain();
    o.type='triangle'; o2.type='sine'; o2.frequency.value=f*2; g2.gain.value=.18;
    o.frequency.setValueAtTime(f*1.12,t); o.frequency.exponentialRampToValueAtTime(f,t+.045);
    l.frequency.value=6.3; lg.gain.setValueAtTime(0,t); lg.gain.linearRampToValueAtTime(f*.014,t+Math.min(dur,.5)); l.connect(lg).connect(o.frequency);
    g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+.03); g.gain.setValueAtTime(v*.85,t+Math.max(.05,dur-.06)); g.gain.exponentialRampToValueAtTime(.0001,t+dur+.08);
    o.connect(g); o2.connect(g2).connect(g); g.connect(dest);
    [o,o2,l].forEach(x=>{ x.start(t); x.stop(t+dur+.15); });
    const n=nsrc(t,dur+.1), bp=ac.createBiquadFilter(), ng=ac.createGain(); bp.type='bandpass'; bp.frequency.value=f*1.5; bp.Q.value=3;
    env(ng,t,.01,v*.35,Math.max(.08,dur*.8)); n.connect(bp).connect(ng).connect(dest);
  }
  function choir(t,fs,dur,v,dest){                                   // "aah" choir from formant-filtered saws
    const g=ac.createGain(); g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+.45); g.gain.setValueAtTime(v,t+dur-.1); g.gain.exponentialRampToValueAtTime(.0001,t+dur+.6); g.connect(dest);
    const f1=ac.createBiquadFilter(), f2=ac.createBiquadFilter(); f1.type=f2.type='bandpass'; f1.frequency.value=760; f2.frequency.value=1150; f1.Q.value=5; f2.Q.value=6; f1.connect(g); f2.connect(g);
    for(const f of fs){ const mix=ac.createGain(); mix.gain.value=.6; saws(t,f,[-13,12],mix,t+dur+.7); mix.connect(f1); mix.connect(f2); }
  }
  function crash(t,v,dest){ const n=nsrc(t,2.6), hp=ac.createBiquadFilter(), g=ac.createGain(); hp.type='highpass'; hp.frequency.value=4200; env(g,t,.003,v,2.4); n.connect(hp).connect(g).connect(dest); }
  function riser(t,dur,v,dest){ const n=nsrc(t,dur), bp=ac.createBiquadFilter(), g=ac.createGain(); bp.type='bandpass'; bp.Q.value=3;
    bp.frequency.setValueAtTime(300,t); bp.frequency.exponentialRampToValueAtTime(7000,t+dur); g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+dur*.95); g.gain.exponentialRampToValueAtTime(.0001,t+dur+.05);
    n.connect(bp).connect(g).connect(dest); }

  // ---------- intro: "Oni no Kōshin" (March of the Oni) — 150 bpm, In scale on D ----------
  // It builds with the scroll: drums + low strings -> shamisen -> shinobue theme, brass and high strings -> choir, cymbals, full storm.
  const BPM=150, IN=[62,63,67,69,72,74,75,79];   // D Eb G A C D Eb G
  const RIFF=[[0,null,0,1,null,2,null,0, 3,null,2,1,null,0,null,null],
              [0,null,0,1,null,2,null,3, 4,null,3,2,null,1,0,null],
              [5,null,5,6,null,7,null,5, 3,null,4,3,null,2,1,null],
              [0,0,null,1,1,null,2,2, 3,null,4,null,5,null,7,null]];
  const ROOTS=[38,38,43,45, 38,36,43,45];          // D D G A | D C G A (one per bar, 8-bar cycle)
  const OST=[0,0,12,0,1,0,12,7];                   // low-string ostinato on 8ths (1 = the dark b2 of the In scale)
  // the shinobue theme: [MIDI, length in 16ths]; 8 bars
  const THEME=[[81,4],[86,4],[87,2],[86,2],[84,2],[81,2],  [79,6],[81,2],[84,4],[81,4],
               [86,4],[87,4],[91,4],[87,2],[86,2],  [86,12],[null,4],
               [91,4],[87,2],[86,2],[84,4],[86,4],  [81,6],[79,2],[81,8],
               [84,2],[86,2],[87,4],[86,2],[84,2],[81,4],  [86,14],[null,2]];
  const themeAt=[]; { let p=0; for(const [n,l] of THEME){ themeAt[p]=[n,l]; p+=l; } }
  const lvl=()=>prog<.1?0:prog<.36?1:prog<.66?2:3;
  function introStep(t,i,dt,Lv,dest){                               // Lv/dest: used when it plays as a playlist song
    const s=i%16, bar=Math.floor(i/16)%8, L=Lv??lvl(), d=dest||introG, root=ROOTS[bar], beat=dt*4;
    // drums
    if([0,3,6,8,11,14].includes(s)&&(L>0||s===0||s===8)) taiko(t,s===0||s===8?.95:.6,d,s===0?.85:1);
    if(L>=2&&(s===10||s===13)) taiko(t,.45,d,1.2);
    if(bar%4===3&&s>=12) taiko(t,.7+(s-12)*.06,d,1.1);                 // fill into the next phrase
    if(s===4||s===12) ka(t,L>=2?.36:.28,d);
    if(L>=1&&(s%2===0||L>=3)) shime(t,s%4===0?.2:.1,d);
    // low strings drive from the start
    if(s%2===0){ const k=OST[(s/2)%8]; strStac(t,MIDI(root+k),L>=2?.11:.08,d); if(L>=3) strStac(t,MIDI(root+k-12),.06,d,.2); }
    // shamisen riff
    if(L>=1){ const n=RIFF[bar%4][s]; if(n!=null) shamisen(t,MIDI(IN[n]-(L>=2?12:0)),L>=2?.08:.14,d,.3); }
    // shinobue theme, brass stabs and high strings
    if(L>=2){ const th=themeAt[bar*16+s]; if(th&&th[0]!=null) fue(t,MIDI(th[0]),th[1]*dt*.95,.075,d);
      if(s===0||s===6||s===10) for(const k of (s===0?[12,19,24]:[12,19])) brass(t,MIDI(root+k),s===0?.07:.05,d,s===0?.42:.26);
      if(s===0) strPad(t,MIDI(root+24),beat*4,.03,d,L>=3), strPad(t,MIDI(root+31),beat*4,.025,d,L>=3); }
    // full storm: choir, cymbals, riser into each 4-bar phrase
    if(L>=3){ if(s===0) choir(t,[MIDI(root+24),MIDI(root+31),MIDI(root+36)],beat*4,.05,d);
      if(s===0&&bar%4===0) crash(t,.12,d); if(bar%4===3&&s===8) riser(t,beat*2,.08,d); }
    if(L>=2&&s===0&&bar%4===0&&L<3) crash(t,.07,d);
    if(s===0&&bar%4===0) drone(t,beat*16,[MIDI(26),MIDI(38)],.045,d);
  }
  // ---------- more instruments for the calm pieces ----------
  function biwa(t,f,v,dest){                                         // plucked lute: bright attack, pitch settles, buzzy
    const o=ac.createOscillator(), lp=ac.createBiquadFilter(), g=ac.createGain(); o.type='sawtooth';
    o.frequency.setValueAtTime(f*1.05,t); o.frequency.exponentialRampToValueAtTime(f,t+.07);
    lp.type='lowpass'; lp.Q.value=6; lp.frequency.setValueAtTime(2600,t); lp.frequency.exponentialRampToValueAtTime(420,t+.6);
    env(g,t,.003,v,1.6); o.connect(lp).connect(g).connect(dest); o.start(t); o.stop(t+1.8);
  }
  function bell(t,f,v,dest){                                         // small temple bowl / rin
    for(const [m,a,d] of [[1,1,4.5],[2.01,.45,3.2],[3.03,.25,2.4],[4.2,.12,1.6]]){ const o=ac.createOscillator(), g=ac.createGain(); o.type='sine'; o.frequency.value=f*m;
      env(g,t,.004,v*a,d); o.connect(g).connect(dest); o.start(t); o.stop(t+d+.1); }
  }
  function kokyu(t,f,dur,v,dest){                                    // bowed fiddle
    const o=ac.createOscillator(), lp=ac.createBiquadFilter(), g=ac.createGain(), lfo=ac.createOscillator(), lg=ac.createGain();
    o.type='sawtooth'; o.frequency.setValueAtTime(f*.985,t); o.frequency.linearRampToValueAtTime(f,t+.18);
    lfo.frequency.value=5.6; lg.gain.setValueAtTime(0,t); lg.gain.linearRampToValueAtTime(f*.008,t+Math.min(dur,.9)); lfo.connect(lg).connect(o.frequency);
    lp.type='lowpass'; lp.frequency.value=1500; lp.Q.value=1.5;
    g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+.35); g.gain.setValueAtTime(v,t+Math.max(.36,dur-.3)); g.gain.exponentialRampToValueAtTime(.0001,t+dur+.1);
    o.connect(lp).connect(g).connect(dest); o.start(t); lfo.start(t); o.stop(t+dur+.2); lfo.stop(t+dur+.2);
  }
  function ambience(kind,t,dur,dest){                                // soft rain or sea under a piece
    const s=ac.createBufferSource(); s.buffer=noise; s.loop=true; const f=ac.createBiquadFilter(), g=ac.createGain();
    if(kind==='rain'){ f.type='bandpass'; f.frequency.value=2400; f.Q.value=.4; g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(.05,t+3); }
    else { f.type='lowpass'; f.frequency.value=520; g.gain.setValueAtTime(.05,t);
      const l=ac.createOscillator(), lg=ac.createGain(); l.frequency.value=.09; lg.gain.value=.045; l.connect(lg).connect(g.gain); l.start(t); l.stop(t+dur); }
    g.gain.setTargetAtTime(.0001,t+dur-2,.6); s.connect(f).connect(g).connect(dest); s.start(t); s.stop(t+dur);
  }

  // ---------- calm playlist ----------
  // Three hand-written pieces, then twenty more composed from a fixed seed each (the same tune every time),
  // each with its own scale, lead instrument, tempo, accompaniment and texture.
  const SC={ hira:[0,2,3,7,8], in:[0,1,5,7,8], yo:[0,2,5,7,9], kumoi:[0,2,3,7,9], ryukyu:[0,4,5,7,11], ritsu:[0,2,5,7,10] };
  const ladder=(root,k)=>{ const r=[]; for(let o=0;o<3;o++) for(const x of SC[k]) if(o<2||x===0) r.push(root+12*o+x); return r; };   // 2 octaves + top tonic
  const CALM=[
    { name:'Sakura no Niwa', jp:'桜の庭', en:'Cherry Garden', bpm:70, scale:[57,59,60,64,65,69,71,72,76,77], drone:[45,52], lead:'koto', acc:'bass',
      A:[[4,1],[3,.5],[2,.5],[3,1],[null,1],[5,1],[4,1],[3,2]], A2:[[4,1],[3,.5],[2,.5],[1,1],[null,1],[2,1],[0,1],[0,2]],
      B:[[5,.5],[6,.5],[7,1],[6,1],[5,1],[4,1.5],[3,.5],[4,2]], bass:[45,40,41,45] },
    { name:'Tsuki no Yashiro', jp:'月の社', en:'Moon Shrine', bpm:56, scale:[62,63,67,69,70,74,75,79], drone:[50,57], lead:'shaku', acc:'bass', pluck:true,
      A:[[3,3],[2,1],[3,2],[null,2]], A2:[[4,2],[3,1],[2,1],[0,3],[null,1]], B:[[5,2],[4,1],[3,1],[2,2],[1,2]], bass:[50,50,43,45] },
    { name:'Chaya no Kaze', jp:'茶屋の風', en:'Teahouse Breeze', bpm:84, scale:[60,62,65,67,69,72,74,77,79,81], drone:[48,55], lead:'koto', acc:'bass', chime:.06,
      A:[[2,.5],[3,.5],[4,1],[5,.5],[4,.5],[3,1],[2,1],[null,1],[1,1],[2,1]], A2:[[2,.5],[3,.5],[4,1],[7,1],[5,1],[4,1],[3,2],[null,1]],
      B:[[5,1],[6,.5],[7,.5],[8,1],[7,1],[5,1],[4,1],[5,2]], bass:[48,53,55,48] },
    { name:'The Rising Sun', jp:'ライジング・サン', en:'kaazoom', file:'assets/music/rising-sun-full.mp3', dur:179.4 },
    { name:'Oni no Kōshin', jp:'鬼の行進', en:'March of the Oni', kind:'oni' },        // the composed intro, full build-up
    // name, kanji, English, bpm, scale, root, lead, accompaniment, extras, seed
    ...[
      ['Ame no Engawa','雨の縁側','Rainy Veranda',64,'in',62,'koto','arp',{amb:'rain'},11],
      ['Chikurin no Michi','竹林の道','Bamboo Path',66,'yo',62,'shaku','arp',{},23],
      ['Yūyake Komichi','夕焼け小道','Sunset Lane',92,'yo',60,'shamisen','bass',{pulse:true},37],
      ['Hotaru no Kawa','蛍の川','Firefly River',60,'kumoi',64,'bell','arp',{amb:'sea'},41],
      ['Yukimi Shōji','雪見障子','Snow-viewing Window',52,'hira',57,'bell','drone',{chime:.03},53],
      ['Inaho no Nami','稲穂の波','Waves of Rice',96,'yo',67,'fue','bass',{pulse:true},67],
      ['Furudera no Kane','古寺の鐘','Old Temple Bell',50,'in',57,'kokyu','drone',{bells:true},71],
      ['Momijigari','紅葉狩り','Maple Viewing',76,'kumoi',62,'koto','bass',{chime:.03},83],
      ['Hoshi no Fune','星の舟','Star Boat',58,'ritsu',64,'bell','drone',{},97],
      ['Mizuumi no Asa','湖の朝','Lake Morning',68,'in',59,'biwa','arp',{amb:'sea'},101],
      ['Kitsune no Yomeiri','狐の嫁入り','The Fox\'s Wedding',100,'in',62,'shamisen','bass',{pulse:true,amb:'rain'},113],
      ['Ennichi no Akari','縁日の灯','Festival Lanterns',108,'yo',65,'fue','arp',{pulse:true},127],
      ['Koke no Niwa','苔の庭','Moss Garden',54,'hira',60,'koto','drone',{},131],
      'short',
      ['Harukaze','春風','Spring Wind',88,'yo',64,'fue','arp',{chime:.04},149],
      ['Nami no Oto','波の音','Sound of the Waves',50,'hira',57,'kokyu','drone',{amb:'sea'},151],
      ['Fūrin','風鈴','Wind Bell',80,'ryukyu',60,'koto','arp',{chime:.12},163],
      ['Yoi no Tsuki','宵の月','Evening Moon',52,'in',64,'shaku','drone',{pluck:true},173],
      ['Sakura Fubuki','桜吹雪','Petal Storm',90,'hira',64,'koto','arp',{},181],
      ['Yumeji','夢路','Dream Road',56,'kumoi',62,'bell','drone',{amb:'rain'},191],
      ['Kaerimichi','帰り道','The Way Home',72,'yo',62,'shaku','bass',{pluck:true},199],
      // shinobue flute over an orchestra (strings, horns, taiko), in the spirit of "The Rising Sun"
      ['Kaze no Uta','風の歌','Song of the Wind',84,'yo',62,'shinobue','orch',{},211],
      ['Hikari no Michi','光の道','Path of Light',92,'ritsu',64,'shinobue','orch',{pulse:true},223],
      ['Ryū no Sora','龍の空','Dragon Sky',100,'in',62,'shinobue','orch',{pulse:true,horns:true},227],
      ['Yūgure no Shiro','夕暮れの城','Castle at Dusk',66,'hira',57,'shaku','orch',{horns:true},229],
      ['Tabidachi','旅立ち','Setting Out',96,'yo',60,'shinobue','orch',{pulse:true,horns:true},233],
      ['Hanabi','花火','Fireworks',104,'kumoi',64,'shinobue','orch',{pulse:true,chime:.05},239],
    ].map(r=>r==='short'?{ name:'The Rising Sun (2 min edit)', jp:'ライジング・サン', en:'kaazoom', file:'assets/music/rising-sun-2min.mp3', dur:118.5 }
      :(([name,jp,en,bpm,sc,root,lead,acc,x,seed])=>Object.assign({name,jp,en,bpm,lead,acc,seed,gen:true,scale:ladder(root,sc),drone:[root-12,root-5]},x))(r))
  ];
  // seeded melody writer: 4-bar phrases from rhythm cells and a gentle random walk, cadencing on the tonic
  function rng(a){ return ()=>{ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
  const CELLS={ quick:[[1,1,1,1],[1,.5,.5,2],[.5,.5,1,2],[1,1,2],[.5,.5,.5,.5,2],[1.5,.5,1,1],[2,1,1]], slow:[[2,2],[3,1],[2,1,1],[4],[1,1,2],[1.5,.5,2]] };
  function compose(T){
    const R=rng(T.seed), pick=(a)=>a[Math.floor(R()*a.length)], N=T.scale.length-1, cl=(i)=>Math.max(0,Math.min(N,i));
    const cells=(T.lead==='shaku'||T.lead==='kokyu'||T.bpm<58)?CELLS.slow:CELLS.quick;
    const bar=(start,rh)=>{ let i=start; return rh.map((b,k)=>{ if(k) i=cl(i+pick([-2,-1,-1,1,1,2,0])); return [(k&&R()<.08)?null:i,b]; }); };
    const shift=(m,d)=>m.map(([n,b])=>[n==null?null:cl(n+d),b]);
    const cad=(from,ton)=>{ const a=cl(from+(ton>from?-1:1)); return [[cl(Math.round((a+ton)/2)+(R()<.5?1:0)),1],[cl((a+ton)>>1),1],[ton,2]]; };
    const r1=pick(cells), m1=bar(5,r1), m2=shift(m1,pick([-1,1,2])), m3=bar(pick([4,6,7]),pick(cells)), m4=bar(pick([7,8]),pick(cells));
    const A=[...m1,...m2,...m3,...cad(m3[m3.length-1][0]??5,5)];
    const A2=[...m1,...shift(m2,-1),...bar(3,pick(cells)),...cad(3,0)];
    const B=[...m4,...shift(m4,-1),...bar(cl(N-3),pick(cells)),...cad(6,5)];
    Object.assign(T,{A,A2,B});
    const L=T.scale; T.bass=[0,pick([3,2]),pick([1,3]),0].map(k=>L[k]-12);
  }
  const FORM=['A','A2','B','A','A','A2','B','A2'];
  const ONI_BARS=48;
  for(const T of CALM){ if(T.kind==='oni'){ T.dur=ONI_BARS*16*60/BPM/4; continue; } if(T.file) continue; if(T.gen) compose(T); T.seq=[]; for(let r=0;r<(T.gen?1:2);r++) for(const sec of FORM) for(const nb of T[sec]) T.seq.push(nb);   // short hand-written melodies play twice
    T.eighths=T.seq.reduce((a,x)=>a+x[1]*2,0); T.dur=T.eighths*30/T.bpm; }
  calmIdx=Math.floor(Math.random()*CALM.length);                  // start somewhere different on each visit
  let calmSeq=[], calmPos=0, calmBeat=0, trackStart=0, resumeOff=0;
  // shuffle: the next song is random, never one of the last ~12 played; "previous" walks back through what played
  const history=[];
  function pickNext(){ const recent=new Set(history.slice(-Math.min(12,CALM.length-2))), all=[...CALM.keys()].filter(i=>i!==calmIdx);
    const c=all.filter(i=>!recent.has(i)); const pool=c.length?c:all; return pool[Math.floor(Math.random()*pool.length)]; }
  // start piece idx at time t, optionally part-way through (off seconds); fadeOut/fadeIn shape the crossfade
  function startCalm(t,idx,off=0,fadeOut=1.2,fadeIn=2.5){
    const T=CALM[idx], e=30/(T.bpm||120); calmIdx=idx; calmSeq=T.seq||[];
    if(curM){ const oldM=curM; curM=null; setTimeout(()=>{ if(curM!==oldM) oldM.el.pause(); },fadeOut*1000+900); }
    if(trackG){ const old=trackG; old.gain.cancelScheduledValues(t); old.gain.setTargetAtTime(0,Math.max(ac.currentTime,t-.05),fadeOut/3); setTimeout(()=>old.disconnect(),Math.max(0,(t-ac.currentTime+fadeOut*3+2)*1000)); }
    trackG=ac.createGain(); trackG.gain.setValueAtTime(0.0001,t); trackG.gain.exponentialRampToValueAtTime(T.kind==='oni'?.55:1,t+fadeIn); trackG.connect(T.file?calmDry:calmG);   // the march is levelled down to sit with the rest
    if(T.file){                                                     // a recorded track: play the file from `off`
      const m=T.m; try{ m.g.disconnect(); }catch(e){} m.g.connect(trackG); curM=m;
      try{ m.el.currentTime=off; }catch(e){}
      setTimeout(()=>{ if(curM===m&&enabled&&stage==='calm') m.el.play().catch(()=>{}); },Math.max(0,(t-ac.currentTime)*1000));
      calmStep=0; calmPos=0; calmBeat=0; trackStart=t-off; calmEndsAt=trackStart+T.dur; resumeOff=0; return;
    }
    if(T.kind==='oni'){ const dt=60/BPM/4; calmStep=Math.max(0,Math.min(ONI_BARS*16-1,Math.round(off/dt))); calmPos=0; calmBeat=0;
      trackStart=t-calmStep*dt; calmEndsAt=trackStart+T.dur; resumeOff=0; return; }
    const st=Math.max(0,Math.min(T.eighths-1,Math.round(off/e)));
    let acc=0; calmPos=0; while(calmPos<calmSeq.length&&acc+calmSeq[calmPos][1]*2<=st){ acc+=calmSeq[calmPos][1]*2; calmPos++; }
    calmBeat=0; if(acc<st){ calmBeat=acc+calmSeq[calmPos][1]*2-st; calmPos++; }   // landed mid-note: wait for the next one
    calmStep=st; trackStart=t-st*e; calmEndsAt=trackStart+T.dur; resumeOff=0;
    drone(t,calmEndsAt-t+1,T.drone.map(MIDI),T.acc==='drone'?.05:.032,trackG);
    if(T.amb) ambience(T.amb,t,calmEndsAt-t+1,trackG);
  }
  function lead(T,t,f,b,e){
    const d=b*2*e, g=trackG;
    switch(T.lead){
      case 'shaku': return shaku(t,f,d+.15,.16,g);
      case 'fue': return shaku(t,f<520?f*2:f,Math.max(.3,d+.05),.1,g);
      case 'kokyu': return kokyu(t,f,d,.09,g);
      case 'shinobue': return fue(t,f<600?f*2:f,Math.max(.12,d*.95),.065,g);
      case 'shamisen': return shamisen(t,f,.1,g,.4);
      case 'biwa': return biwa(t,f,.16,g);
      case 'bell': bell(t,f<520?f*2:f,.09,g); if(b>=2) koto(t,f,.07,g,2); return;
      default: koto(t,f,.2,g); if(b>=1&&Math.random()<.35) koto(t+e,f*1.5,.06,g,1.4);
    }
  }
  function calmTick(t){                                              // called on each eighth-note
    if(CALM[calmIdx].file) return .25;
    if(CALM[calmIdx].kind==='oni'){ const dt=60/BPM/4, bar=Math.floor(calmStep/16);   // builds: shamisen -> flute and brass -> full storm
      introStep(t,calmStep,dt,bar<8?1:bar<24?2:3,trackG); calmStep++; return dt; }
    const T=CALM[calmIdx], e=30/T.bpm, barN=Math.floor(calmStep/8), root=T.bass[barN%T.bass.length], g=trackG;
    if(T.acc==='bass'||T.acc==='drone'){ if(calmStep%8===0) koto(t,MIDI(root),T.acc==='drone'?.1:.16,g,3.2); }
    if(T.acc==='arp'){ const L=T.scale, k=L.indexOf(root+12), ch=[k,k+2,k+4,k+2].map(i=>L[Math.max(0,Math.min(L.length-1,i))]-12);
      if(calmStep%2===0) koto(t,MIDI(ch[(calmStep/2)%4]),calmStep%8===0?.11:.06,g,1.8); }
    if(T.acc==='orch'){                                             // strings pad + driving low strings, horns and a cymbal now and then
      if(calmStep%8===0){ const bd=8*e; strPad(t,MIDI(root+12),bd,.02,g,false); strPad(t,MIDI(root+19),bd,.016,g,false);
        if(T.horns&&barN%4===0) brass(t,MIDI(root+12),.03,g,bd*.9); if(barN%8===0) crash(t,.035,g); }
      if(calmStep%2===0) strStac(t,MIDI(root-12+(calmStep%8===4?7:0)),calmStep%8===0?.07:.045,g,.22); }
    if(T.pulse){ if(calmStep%8===0) taiko(t,.22,g,1.15); if(calmStep%8===4) shime(t,.05,g); if(calmStep%8===6) ka(t,.05,g); }
    if(T.pluck&&calmStep%8===4&&Math.random()<.55) koto(t,MIDI(T.scale[2+Math.floor(Math.random()*3)]),.07,g,2.6);
    if(T.bells&&calmStep%16===0) bell(t,MIDI(root+24),.06,g);
    if(T.chime&&Math.random()<T.chime) chime(t,g);
    if(calmBeat<=0&&calmPos<calmSeq.length){
      const [n,b]=calmSeq[calmPos]; calmPos++; calmBeat=b*2;
      if(n!=null) lead(T,t,MIDI(T.scale[n]),b,e);
    }
    calmBeat--; calmStep++;
    return e;
  }

  // ---------- scheduler ----------
  function tick(){
    if(!enabled) return;
    const now=ac.currentTime, ahead=now+.25;
    const want=stage==='calm'?(prog<.9?'intro':'calm'):(prog>=.935?'calm':'intro');   // a little hysteresis so it can't flap
    if(want!==stage){
      if(want==='calm'){ IG().cancelScheduledValues(now); IG().setTargetAtTime(0,now,.12); if(!gongPlayed){ gong(now+.08); gongPlayed=true; }
        setTimeout(()=>{ if(stage==='calm'&&introM) introM.el.pause(); },900);          // the intro track pauses (and resumes if you scroll back)
        switchAt=now+3.2; CG().cancelScheduledValues(now); CG().setValueAtTime(0,now); CG().setTargetAtTime(1,switchAt,1.2); startCalm(switchAt,calmIdx); nextT=switchAt; }
      else { CG().cancelScheduledValues(now); CG().setTargetAtTime(0,now,.4); IG().cancelScheduledValues(now); IG().setTargetAtTime(1,now+.3,.3); gongPlayed=false; nextT=now+.35; step=0;
        if(curM){ const m=curM; setTimeout(()=>{ if(stage==='intro') m.el.pause(); },1200); } }
      stage=want;
    }
    while(nextT<ahead){
      if(stage==='intro'){
        if(useIntroFile){                                           // the recorded intro track
          if(introM.el.paused&&!introPending){ introPending=true; introM.el.play().then(()=>{ introPending=false; }).catch(()=>{ introPending=false; useIntroFile=false; }); }
          nextT=ahead; continue; }
        const dt=60/BPM/4; introStep(nextT,step,dt); step++; nextT+=dt; }
      else {
        if(nextT>=calmEndsAt){ history.push(calmIdx); startCalm(nextT+1.5,pickNext()); nextT+=1.5; }   // a random next piece, after a short breath
        nextT+=calmTick(nextT);
      }
    }
  }
  const curStage=()=>enabled?stage:(prog>=.935?'calm':'intro');
  const elapsed=()=>{ if(!enabled||!ac||stage!=='calm') return resumeOff; const T=CALM[calmIdx];
    if(T.file&&curM===T.m&&!curM.el.paused) return Math.max(0,Math.min(T.dur,curM.el.currentTime));
    return Math.max(0,Math.min(T.dur,ac.currentTime-trackStart)); };
  function enable(on){
    if(on&&!ac) init();
    if(!on&&enabled){ resumeOff=elapsed(); pauseFiles(); }            // pausing remembers where the piece was
    enabled=on;
    if(!ac) return;
    const now=ac.currentTime;
    out.gain.cancelScheduledValues(now);
    if(on){ ac.resume(); out.gain.setValueAtTime(Math.max(out.gain.value,.0001),now); out.gain.linearRampToValueAtTime(.6,now+.8);
      stage=prog>=.935?'calm':'intro'; IG().cancelScheduledValues(now); IG().setValueAtTime(stage==='intro'?1:0,now); CG().cancelScheduledValues(now); CG().setValueAtTime(stage==='calm'?1:0,now); gongPlayed=stage==='calm';
      unlockFiles();
      if(stage==='calm') startCalm(now+.1,calmIdx,resumeOff,.3,.8); nextT=now+.1; step=0;
      clearInterval(timer); timer=setInterval(tick,40); }
    else { out.gain.linearRampToValueAtTime(0,now+.4); clearInterval(timer); setTimeout(()=>{ if(!enabled&&ac) ac.suspend(); },500); }
  }
  // jump to piece i (wraps), optionally part-way through
  function select(i,off=0){
    i=((i%CALM.length)+CALM.length)%CALM.length;
    if(enabled&&stage==='calm'){ const now=ac.currentTime; startCalm(now+.06,i,off,.25,off?.4:.9); nextT=now+.06; }
    else { calmIdx=i; resumeOff=off; }
  }
  window.ClubMusic={ enable, setProgress(p){ prog=p; }, get enabled(){ return enabled; },
    get track(){ return curStage()==='intro'?(useIntroFile?'The Rising Sun (intro)':'Oni no Kōshin'):CALM[calmIdx].name; },
    get introFile(){ return useIntroFile; },
    tracks:[{name:'The Rising Sun (intro)',jp:'ライジング・サン',en:'kaazoom',part:'intro'},...CALM.map(T=>({name:T.name,jp:T.jp,en:T.en,dur:T.dur}))],
    state(){ const st=curStage(); return st==='intro'?(useIntroFile?{stage:st,name:'The Rising Sun (intro)',jp:'ライジング・サン',en:'kaazoom',enabled}:{stage:st,name:'Oni no Kōshin',jp:'鬼の行進',en:'March of the Oni',enabled})
      :{stage:st,index:calmIdx,count:CALM.length,name:CALM[calmIdx].name,jp:CALM[calmIdx].jp,en:CALM[calmIdx].en,elapsed:elapsed(),duration:CALM[calmIdx].dur,enabled}; },
    // render the intro (scroll progress ramping 0 -> 1) plus the logo gong to a WAV, for listening samples
    async renderIntro(sec=40,tail=8){
      const saved=[ac,out,bus,introG,calmG,fxG,noise,prog,dryOut,introDry,calmDry], sr=44100;
      build(new OfflineAudioContext(2,Math.round((sec+tail)*sr),sr)); out.gain.value=.6;
      const dt=60/BPM/4; for(let i=0,t=.05;t<sec;i++,t+=dt){ prog=Math.min(.93,t/sec*1.02); introStep(t,i,dt); }
      introG.gain.setValueAtTime(1,sec-.1); introG.gain.setTargetAtTime(0,sec,.12); gong(sec+.05);
      const buf=await ac.startRendering(); [ac,out,bus,introG,calmG,fxG,noise,prog,dryOut,introDry,calmDry]=saved;
      return wavOf(buf,sr);
    },
    renderGong:renderGongWav,
    next(){ history.push(calmIdx); select(pickNext()); },
    prev(){ if(elapsed()>4||!history.length) select(calmIdx); else select(history.pop()); }, select, seek(f){ select(calmIdx,Math.max(0,Math.min(.995,f))*CALM[calmIdx].dur); } };
})();
