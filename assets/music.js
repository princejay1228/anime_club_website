/* SIMATS Anime Club — original Japanese-style soundtrack, generated live with the Web Audio API.
   Everything here is synthesised in the browser: no recordings, no samples, no copyrighted music.

   Score
   - Intro  "Oni no Kodō" (Heartbeat of the Oni): aggressive taiko + shamisen riff in the In scale.
   - Logo   a temple gong when the SIMATS logo appears.
   - Calm   a playlist of 23 peaceful pieces that play one after another and loop, starting at a random one:
            three hand-written (Sakura no Niwa, Tsuki no Yashiro, Chaya no Kaze) and twenty composed by a seeded
            melody writer, so each always plays the same tune. Instruments: koto, shakuhachi, shinobue, shamisen,
            biwa, kokyū, temple bells, wind chimes, soft taiko, rain and sea.

   API: ClubMusic.enable(true|false), setProgress(introProgress0to1), enabled, track, tracks,
        state() -> {stage, name, jp, en, index, count, elapsed, duration, enabled}, next(), prev(), select(i), seek(0..1) */
(function(){
  'use strict';
  const MIDI=(m)=>440*Math.pow(2,(m-69)/12);
  let ac=null, out, bus, introG, calmG, fxG, noise;
  let enabled=false, timer=0, nextT=0, step=0, prog=0;
  let stage='intro', switchAt=0, calmIdx=0, calmStep=0, calmEndsAt=0, gongPlayed=false, trackG=null;

  // ---------- setup ----------
  function init(){
    ac=new (window.AudioContext||window.webkitAudioContext)();
    out=ac.createGain(); out.gain.value=0;
    const comp=ac.createDynamicsCompressor(); comp.threshold.value=-16; comp.knee.value=10; comp.ratio.value=4; comp.attack.value=.004; comp.release.value=.2;
    bus=ac.createGain();
    const rev=ac.createConvolver(); rev.buffer=impulse(3.4,2.6); const rg=ac.createGain(); rg.gain.value=.3;
    bus.connect(comp); bus.connect(rev); rev.connect(rg); rg.connect(comp); comp.connect(out); out.connect(ac.destination);
    introG=ac.createGain(); calmG=ac.createGain(); fxG=ac.createGain(); calmG.gain.value=0;
    introG.connect(bus); calmG.connect(bus); fxG.connect(bus);
    noise=ac.createBuffer(1,ac.sampleRate*2,ac.sampleRate); const d=noise.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
    document.addEventListener('visibilitychange',()=>{ if(!ac) return; if(document.hidden) ac.suspend(); else if(enabled) ac.resume(); });
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
  function gong(t){
    const base=58, P=[[1,1,7.5],[1.48,.55,6.5],[1.98,.45,5.5],[2.44,.32,5],[2.9,.25,4.2],[3.61,.18,3.4],[4.32,.12,2.8],[5.3,.08,2.2]];
    for(const [r,a,d] of P){ const o=ac.createOscillator(), g=ac.createGain(); o.type='sine';
      o.frequency.setValueAtTime(base*r*1.012,t); o.frequency.exponentialRampToValueAtTime(base*r,t+1.5);
      g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(a*.55,t+.03+r*.02); g.gain.exponentialRampToValueAtTime(.0001,t+d);
      o.connect(g).connect(fxG); o.start(t); o.stop(t+d+.1); }
    const n=nsrc(t,1.6), lp=ac.createBiquadFilter(), ng=ac.createGain(); lp.type='lowpass'; lp.frequency.setValueAtTime(2600,t); lp.frequency.exponentialRampToValueAtTime(300,t+1.4);
    env(ng,t,.005,.35,1.4); n.connect(lp).connect(ng).connect(fxG);
    taiko(t,.9,fxG,.75);
  }

  // ---------- intro: "Oni no Kodō" — 150 bpm, In scale on D ----------
  const IN=[62,63,67,69,72,74,75,79];   // D Eb G A C D Eb G
  const RIFF=[[0,null,0,1,null,2,null,0, 3,null,2,1,null,0,null,null],
              [0,null,0,1,null,2,null,3, 4,null,3,2,null,1,0,null],
              [5,null,5,6,null,7,null,5, 3,null,4,3,null,2,1,null],
              [0,0,null,1,1,null,2,2, 3,null,4,null,5,null,7,null]];
  function introStep(t,i,dt){
    const s=i%16, bar=Math.floor(i/16)%4, hot=prog>.35, d=introG;
    if([0,3,6,8,11,14].includes(s)) taiko(t,s===0||s===8?.95:.62,d,s===0?.9:1);
    if(bar===3&&s>=12) taiko(t,.75,d,1.1);                          // fill
    if(s===4||s===12) ka(t,.32,d);
    if(s%2===0||hot) shime(t,s%4===0?.22:(hot?.1:.14),d);
    const n=RIFF[bar][s]; if(n!=null){ shamisen(t,MIDI(IN[n]),.17,d); if(hot) shamisen(t+.004,MIDI(IN[n]-12),.09,d,.3); }
    if(s===0&&bar===0) drone(t,dt*64,[MIDI(38),MIDI(45)],.05,d);
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
      ['Harukaze','春風','Spring Wind',88,'yo',64,'fue','arp',{chime:.04},149],
      ['Nami no Oto','波の音','Sound of the Waves',50,'hira',57,'kokyu','drone',{amb:'sea'},151],
      ['Fūrin','風鈴','Wind Bell',80,'ryukyu',60,'koto','arp',{chime:.12},163],
      ['Yoi no Tsuki','宵の月','Evening Moon',52,'in',64,'shaku','drone',{pluck:true},173],
      ['Sakura Fubuki','桜吹雪','Petal Storm',90,'hira',64,'koto','arp',{},181],
      ['Yumeji','夢路','Dream Road',56,'kumoi',62,'bell','drone',{amb:'rain'},191],
      ['Kaerimichi','帰り道','The Way Home',72,'yo',62,'shaku','bass',{pluck:true},199],
    ].map(([name,jp,en,bpm,sc,root,lead,acc,x,seed])=>Object.assign({name,jp,en,bpm,lead,acc,seed,gen:true,scale:ladder(root,sc),drone:[root-12,root-5]},x))
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
  for(const T of CALM){ if(T.gen) compose(T); T.seq=[]; for(let r=0;r<(T.gen?1:2);r++) for(const sec of FORM) for(const nb of T[sec]) T.seq.push(nb);   // short hand-written melodies play twice
    T.eighths=T.seq.reduce((a,x)=>a+x[1]*2,0); T.dur=T.eighths*30/T.bpm; }
  calmIdx=Math.floor(Math.random()*CALM.length);                  // start somewhere different on each visit
  let calmSeq=[], calmPos=0, calmBeat=0, trackStart=0, resumeOff=0;
  // start piece idx at time t, optionally part-way through (off seconds); fadeOut/fadeIn shape the crossfade
  function startCalm(t,idx,off=0,fadeOut=1.2,fadeIn=2.5){
    const T=CALM[idx], e=30/T.bpm; calmIdx=idx; calmSeq=T.seq;
    if(trackG){ const old=trackG; old.gain.cancelScheduledValues(t); old.gain.setTargetAtTime(0,Math.max(ac.currentTime,t-.05),fadeOut/3); setTimeout(()=>old.disconnect(),Math.max(0,(t-ac.currentTime+fadeOut*3+2)*1000)); }
    trackG=ac.createGain(); trackG.gain.setValueAtTime(0.0001,t); trackG.gain.exponentialRampToValueAtTime(1,t+fadeIn); trackG.connect(calmG);
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
      case 'shamisen': return shamisen(t,f,.1,g,.4);
      case 'biwa': return biwa(t,f,.16,g);
      case 'bell': bell(t,f<520?f*2:f,.09,g); if(b>=2) koto(t,f,.07,g,2); return;
      default: koto(t,f,.2,g); if(b>=1&&Math.random()<.35) koto(t+e,f*1.5,.06,g,1.4);
    }
  }
  function calmTick(t){                                              // called on each eighth-note
    const T=CALM[calmIdx], e=30/T.bpm, barN=Math.floor(calmStep/8), root=T.bass[barN%T.bass.length], g=trackG;
    if(T.acc==='bass'||T.acc==='drone'){ if(calmStep%8===0) koto(t,MIDI(root),T.acc==='drone'?.1:.16,g,3.2); }
    if(T.acc==='arp'){ const L=T.scale, k=L.indexOf(root+12), ch=[k,k+2,k+4,k+2].map(i=>L[Math.max(0,Math.min(L.length-1,i))]-12);
      if(calmStep%2===0) koto(t,MIDI(ch[(calmStep/2)%4]),calmStep%8===0?.11:.06,g,1.8); }
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
      if(want==='calm'){ introG.gain.cancelScheduledValues(now); introG.gain.setTargetAtTime(0,now,.12); if(!gongPlayed){ gong(now+.08); gongPlayed=true; }
        switchAt=now+3.2; calmG.gain.cancelScheduledValues(now); calmG.gain.setValueAtTime(0,now); calmG.gain.setTargetAtTime(1,switchAt,1.2); startCalm(switchAt,calmIdx); nextT=switchAt; }
      else { calmG.gain.cancelScheduledValues(now); calmG.gain.setTargetAtTime(0,now,.4); introG.gain.cancelScheduledValues(now); introG.gain.setTargetAtTime(1,now+.3,.3); gongPlayed=false; nextT=now+.35; step=0; }
      stage=want;
    }
    while(nextT<ahead){
      if(stage==='intro'){ const dt=60/150/4; introStep(nextT,step,dt); step++; nextT+=dt; }
      else {
        if(nextT>=calmEndsAt){ startCalm(nextT+1.5,(calmIdx+1)%CALM.length); nextT+=1.5; }   // next piece, after a short breath
        nextT+=calmTick(nextT);
      }
    }
  }
  const curStage=()=>enabled?stage:(prog>=.935?'calm':'intro');
  const elapsed=()=>{ if(!enabled||!ac||stage!=='calm') return resumeOff; return Math.max(0,Math.min(CALM[calmIdx].dur,ac.currentTime-trackStart)); };
  function enable(on){
    if(on&&!ac) init();
    if(!on&&enabled) resumeOff=elapsed();                             // pausing remembers where the piece was
    enabled=on;
    if(!ac) return;
    const now=ac.currentTime;
    out.gain.cancelScheduledValues(now);
    if(on){ ac.resume(); out.gain.setValueAtTime(Math.max(out.gain.value,.0001),now); out.gain.linearRampToValueAtTime(.6,now+.8);
      stage=prog>=.935?'calm':'intro'; introG.gain.cancelScheduledValues(now); introG.gain.setValueAtTime(stage==='intro'?1:0,now); calmG.gain.cancelScheduledValues(now); calmG.gain.setValueAtTime(stage==='calm'?1:0,now); gongPlayed=stage==='calm';
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
    get track(){ return curStage()==='intro'?'Oni no Kodō':CALM[calmIdx].name; },
    tracks:[{name:'Oni no Kodō',jp:'鬼の鼓動',en:'Heartbeat of the Oni',part:'intro'},...CALM.map(T=>({name:T.name,jp:T.jp,en:T.en,dur:T.dur}))],
    state(){ const st=curStage(); return st==='intro'?{stage:st,name:'Oni no Kodō',jp:'鬼の鼓動',en:'Heartbeat of the Oni',enabled}
      :{stage:st,index:calmIdx,count:CALM.length,name:CALM[calmIdx].name,jp:CALM[calmIdx].jp,en:CALM[calmIdx].en,elapsed:elapsed(),duration:CALM[calmIdx].dur,enabled}; },
    next(){ select(calmIdx+1); }, prev(){ if(elapsed()>4) select(calmIdx); else select(calmIdx-1); }, select, seek(f){ select(calmIdx,Math.max(0,Math.min(.995,f))*CALM[calmIdx].dur); } };
})();
