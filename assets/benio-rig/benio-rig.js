/* Benio rig v3: draws Sakuraba Benio live from her painted layers plus the v3 face rig.
   Draw order (from the kit): parts in z-order; after 16_face draw the skin repair plate;
   17/18/19 are replaced by the current eye / mouth sprites; the effect overlay goes last.

   API: const b = await BenioRig.mount(canvas, {base:'assets/benio-rig/'});
        b.expression('happy', seconds)   any key from rig.expressions (29 of them)
        b.speak('Hello!', {expression:'talking'})  -> mouth follows the text, returns duration (s)
        b.talk(true|false)               -> continuous talk loop (e.g. while text types elsewhere)
        b.wink() / b.blink() / b.hop()
   Positive rotation = clockwise (degrees). Coordinates use the 1122 x 1402 master canvas. */
(function(){
  'use strict';
  const rad=(d)=>d*Math.PI/180, clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const load=(src)=>new Promise((res,rej)=>{ const i=new Image(); i.decoding='async'; i.onload=()=>res(i); i.onerror=rej; i.src=src; });

  // letter -> mouth shape, a simple text-driven lip sync (not audio aligned)
  const VIS={a:'a',á:'a',e:'e',i:'i',y:'i',o:'o',u:'u',w:'u',m:'m',b:'m',p:'m',f:'f',v:'f',l:'l',n:'l',t:'l',d:'l',s:'i',z:'i',c:'e',k:'e',g:'e',h:'a',r:'e',j:'i',q:'u',x:'e'};

  async function mount(canvas,opts){
    const base=(opts&&opts.base!=null)?opts.base:'assets/benio-rig/';
    const src=(f)=>/^data:/.test(f)?f:base+f;
    const rig=window.BENIO_RIG || await (await fetch(base+'rig.json')).json();
    const all=[...rig.parts, rig.face_plate, ...Object.values(rig.eyes), ...Object.values(rig.mouth), ...Object.values(rig.effects)];
    const img={};
    await Promise.all(all.map(e=>load(src(e.file)).then(i=>{ img[e.file]=i; })));
    const W=rig.canvas.width, H=rig.canvas.height, EX=rig.expressions;
    const ctx=canvas.getContext('2d');
    const reduced=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
    const BLINK=(rig.clips.blink&&rig.clips.blink.frames)||['open','half','closed','half','open'];

    function size(){ const r=canvas.getBoundingClientRect(), d=Math.min(window.devicePixelRatio||1,2);
      canvas.width=Math.max(1,Math.round(r.width*d)); canvas.height=Math.max(1,Math.round((r.height||r.width*H/W)*d)); }
    size(); if('ResizeObserver' in window) new ResizeObserver(size).observe(canvas);

    let visible=true;
    if('IntersectionObserver' in window) new IntersectionObserver(es=>{ visible=es[0].isIntersecting; },{rootMargin:'120px'}).observe(canvas);

    const t0=performance.now();
    let expr=(opts&&opts.expression)||'default', exprUntil=0;
    let blinkT=-1, blinkEye='both', nextBlink=t0+1500+Math.random()*2500;
    let speech=null, talkLoop=false, hopT=-1, twitchT=-9e9, twitchSide=1;

    function face(now){
      const e=EX[expr]||EX.default; let L=e.eye_left, R=e.eye_right, M=e.mouth, fx=e.effect;
      // blink only over open-ish eyes
      if(blinkT>=0){
        const f=Math.floor((now-blinkT)/(1000/12));
        if(f>=BLINK.length) blinkT=-1;
        else { const st=BLINK[f]; if(L==='open'&&blinkEye!=='right') L=st; if(R==='open'&&blinkEye!=='left') R=st; }
      }
      if(speech){
        const k=Math.max(0,(now-speech.t)/1000*speech.rate);   // rAF time can trail performance.now() slightly
        if(k>=speech.text.length){ speech=null; }
        else { const ch=speech.text[Math.floor(k)].toLowerCase(); M=VIS[ch]||(/[\s,.!?~…-]/.test(ch)?'rest':M==='original'?'talk_small':M); }
      } else if(talkLoop){
        const seq=rig.clips.talk.frames; M=seq[Math.floor((now-t0)/(1000/(rig.clips.talk.fps||10)))%seq.length];
      }
      if(!rig.eyes['left_'+L]) L='open'; if(!rig.eyes['right_'+R]) R='open'; if(!rig.mouth[M]) M='original';
      return {L,R,M,fx};
    }
    function rot(id,now){
      if(reduced) return 0;
      const t=(now-t0)/1000;
      if(id==='01_tail') return Math.sin(t*1.3)*3.2;
      if(id==='21_ear_left'||id==='22_ear_right'){ const s=id==='21_ear_left'?-1:1, k=clamp((now-twitchT)/300,0,1);
        return Math.sin(t*0.9+(s>0?1.2:0))*1 + (twitchSide===s? s*6*Math.sin(k*Math.PI):0); }
      if(id==='23_hair_ornament_left'||id==='24_hair_ornament_right') return Math.sin(t*1.6+(id[1]==='3'?0:1))*2;
      if(id==='25_obi_bow') return Math.sin(t*1.4)*1;
      if(id==='20_hair_front') return Math.sin(t*0.8)*0.5;
      return 0;
    }
    function drawE(e){ ctx.drawImage(img[e.file],e.x,e.y,e.width,e.height); }
    function draw(now){
      ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height);
      const s=canvas.width/W, t=(now-t0)/1000, br=reduced?0:Math.sin(t*2.1)*3;
      let hop=0; if(hopT>=0){ const k=(now-hopT)/520; if(k>=1) hopT=-1; else hop=-Math.sin(k*Math.PI)*70; }
      const f=face(now);
      ctx.setTransform(s,0,0,s,0,0); ctx.translate(W/2,H); ctx.scale(1+br*0.0012,1-br*0.0012); ctx.translate(-W/2,-H+hop);
      for(const p of rig.parts){
        if(p.id==='17_eye_left'){ drawE(rig.eyes['left_'+f.L]); continue; }
        if(p.id==='18_eye_right'){ drawE(rig.eyes['right_'+f.R]); continue; }
        if(p.id==='19_mouth'){ drawE(rig.mouth[f.M]); continue; }
        const a=rot(p.id,now);
        if(!a) drawE(p); else { const [px,py]=p.pivot_global; ctx.save(); ctx.translate(px,py); ctx.rotate(rad(a)); ctx.drawImage(img[p.file],p.x-px,p.y-py,p.width,p.height); ctx.restore(); }
        if(p.id==='16_face') drawE(rig.face_plate);
      }
      if(f.fx&&f.fx!=='none'&&rig.effects[f.fx]) drawE(rig.effects[f.fx]);
    }
    function loop(now){
      if(now>nextBlink&&blinkT<0){ blinkT=now; blinkEye='both'; nextBlink=now+3000+Math.random()*3000; if(Math.random()<.15) nextBlink=now+700; }
      if(!reduced&&Math.random()<0.003&&now-twitchT>1800){ twitchT=now; twitchSide=Math.random()<.5?-1:1; }
      if(exprUntil&&now>exprUntil){ expr='default'; exprUntil=0; }
      if(visible&&canvas.width>1) draw(now);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    return {
      rig, expressions:Object.keys(EX),
      expression(name,sec){ if(EX[name]){ expr=name; exprUntil=sec?performance.now()+sec*1000:0; twitchT=performance.now(); } },
      speak(text,o){ o=o||{}; const rate=o.rate||13; speech={text:String(text),t:performance.now(),rate};
        const dur=text.length/rate; this.expression(o.expression||'talking',dur+.2); return dur; },
      talk(on){ talkLoop=!!on; },
      blink(){ blinkT=performance.now(); blinkEye='both'; },
      wink(side){ blinkT=performance.now(); blinkEye=side||'left'; },
      hop(){ if(!reduced) hopT=performance.now(); }
    };
  }
  window.BenioRig={mount};
})();
