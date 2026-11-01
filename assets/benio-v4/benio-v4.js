/* Benio Sakuraba V4: frame-swap animation, adapted from the kit's 10_INTEGRATION_CODE/benio-v4.js and
   09_WORKING_WEBSITE_DEMO/demo.js.

   The ONE rule from the kit: Benio is ONE <img>. Blinking, talking and expressions only change img.src to a
   complete, pre-rendered 561x701 picture of her. Nothing is drawn over her face (no CSS/SVG/canvas eyelids
   or mouths), and no eye or mouth piece is ever positioned separately.

   Files (copied unchanged from the kit, same folder and file names):
     03_BLINK_FRAME_STRIPS/frame_00..08_561x701.png   the 9-frame blink (00 = her original face)
     09_WORKING_WEBSITE_DEMO/talk_open__*.png         talking, eyes open
     09_WORKING_WEBSITE_DEMO/talk_closed__*.png       talking, eyes closed (a blink beat during speech)
     09_WORKING_WEBSITE_DEMO/emotion_*.png            expression presets

   API: const b=new BenioV4(img, 'assets/benio-v4/');
        b.blink()                     the 9 frames at the kit's exact timings (0..330 ms), back to the resting face
        b.autoBlink(true|false)       one blink every 3-6 s with a random delay (manual p.5)
        b.speak(text)                 text-timed mouth shapes, one swap every ~130 ms; returns seconds
        b.talk(true|false)            a talking loop, e.g. while a speech bubble types
        b.expression(name, seconds)   e.g. 'happy_eyes_closed' for 2 s, then back to her original face
        b.preloadTalk()               fetch the talking pictures ahead of time */
(function(){
  'use strict';
  // FRAME_COORDINATES.json "ready_frames": index -> t_ms
  const BLINK_MS=[0,48,82,108,137,203,235,276,330];
  // the same 9 mouth shapes the kit's demo cycles through
  const VISEMES=['rest','a','i','m','u','e','o','talk_small','talk_medium'];
  const EMOTIONS=['neutral_open','happy_eyes_closed','peaceful_closed_smile','speaking_open','surprised','winking_left'];
  // letter -> mouth shape (stylised, text-timed; not synced to audio, as the manual says)
  const LETTER={a:'a',h:'a',e:'e',c:'e',k:'e',g:'e',r:'e',x:'e',i:'i',y:'i',s:'i',z:'i',j:'i',o:'o',u:'u',w:'u',q:'u',
                m:'m',b:'m',p:'m',f:'talk_small',v:'talk_small',l:'talk_medium',n:'talk_medium',t:'talk_medium',d:'talk_medium'};
  const SWAP_MS=130;                              // manual p.7: switch every ~110-160 ms while talking
  // a single-file build can map each path to embedded data (window.BENIO_V4_FILES); the website uses the paths as they are
  const R=(src)=>(window.BENIO_V4_FILES&&window.BENIO_V4_FILES[src])||src;
  const reduced=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;

  class BenioV4{
    constructor(img,root){
      this.img=img; this.root=root||'assets/benio-v4/';
      this.cache=new Map(); this.busy=false; this.mode='idle'; this.exprT=0; this.talkT=0; this.autoT=0; this.n=0;
      this.rest=this.blinkSrc(0); this.preloadBlink();
    }
    blinkSrc(i){ return `${this.root}03_BLINK_FRAME_STRIPS/frame_${String(i).padStart(2,'0')}_561x701.png`; }
    talkSrc(eyes,shape){ return `${this.root}09_WORKING_WEBSITE_DEMO/talk_${eyes}__${shape}.png`; }
    emotionSrc(name){ return `${this.root}09_WORKING_WEBSITE_DEMO/emotion_${name}.png`; }
    load(src){ let p=this.cache.get(src); if(!p){ const im=new Image(); im.decoding='async'; im.src=R(src);
      p={im,ready:false}; p.promise=(im.decode?im.decode():new Promise((r,j)=>{ im.onload=r; im.onerror=j; })).then(()=>{ p.ready=true; }).catch(()=>{}); this.cache.set(src,p); } return p; }
    // show a picture only once it has loaded, so the image never flashes empty mid-animation
    show(src){ const p=this.load(src); if(p.ready){ const r=R(src); if(this.img.getAttribute('src')!==r) this.img.src=r; return true; } return false; }
    preloadBlink(){ return Promise.all(BLINK_MS.map((_,i)=>this.load(this.blinkSrc(i)).promise)); }
    preloadTalk(){ const open=VISEMES.map(v=>this.load(this.talkSrc('open',v)).promise);
      Promise.all(open).then(()=>VISEMES.forEach(v=>this.load(this.talkSrc('closed',v))));   // eyes-closed versions after the open ones
      return Promise.all(open); }
    restFace(){ if(this.mode==='talk') return; this.show(this.exprSrc||this.rest); }

    async blink(){
      if(this.busy||this.mode==='talk'||this.exprClosed) return; this.busy=true;
      await this.preloadBlink();
      const start=performance.now();
      for(let i=0;i<BLINK_MS.length;i++){
        const wait=start+BLINK_MS[i]-performance.now(); if(wait>0) await new Promise(r=>setTimeout(r,wait));
        if(this.mode==='talk') break;                 // speech took over: stop and let it drive the picture
        this.show(this.blinkSrc(i));
      }
      this.busy=false; this.restFace();               // frame 08 is identical to 00 (her original face)
    }
    autoBlink(on){ clearTimeout(this.autoT); if(!on||reduced) return;
      const next=()=>{ this.autoT=setTimeout(()=>{ if(document.visibilityState==='visible') this.blink(); next(); },3000+Math.random()*3000); };
      next(); }

    expression(name,sec){
      clearTimeout(this.exprT);
      if(!name||name==='neutral_open'||!EMOTIONS.includes(name)){ this.exprSrc=null; this.exprClosed=false; this.restFace(); return; }
      const src=this.emotionSrc(name); this.exprSrc=src; this.exprClosed=/closed/.test(name);
      this.load(src).promise.then(()=>{ if(this.exprSrc===src) this.restFace(); });
      if(sec) this.exprT=setTimeout(()=>this.expression(null),sec*1000);
    }

    // talking loop (e.g. while a speech bubble types): cycle the demo's mouth shapes
    talk(on){
      if(on===(this.mode==='talk')) return;
      clearInterval(this.talkT);
      if(on){ this.mode='talk'; this.preloadTalk(); this.exprSrc=null; this.exprClosed=false;
        const step=()=>{ const shape=VISEMES[this.n%VISEMES.length]; this.frameFor(shape); this.n++; };
        step(); this.talkT=setInterval(step,140); }
      else { this.mode='idle'; this.restFace(); }
    }
    // one mouth picture; every ~11th picture is the eyes-closed version, as in the kit's demo
    frameFor(shape){ const closed=this.n%11===10;
      if(!(closed&&this.show(this.talkSrc('closed',shape)))) this.show(this.talkSrc('open',shape)) || this.show(this.rest); }

    // text-timed speech: one mouth shape per ~130 ms, chosen from the letters being "said"
    speak(text){
      text=String(text||''); clearInterval(this.talkT); clearTimeout(this.exprT); this.exprSrc=null; this.exprClosed=false;
      this.mode='talk'; this.preloadTalk();
      const letters=[...text.toLowerCase()], perSwap=Math.max(1,Math.round(letters.length/Math.max(1,text.length/13*1000/SWAP_MS)));
      const shapes=[]; for(let i=0;i<letters.length;i+=perSwap){ const ch=letters[i];
        shapes.push(/[\s,.!?~…\-—]/.test(ch)?'rest':LETTER[ch]||'talk_small'); }
      shapes.push('rest');
      let k=0; this.talkT=setInterval(()=>{ if(k>=shapes.length){ clearInterval(this.talkT); this.mode='idle'; this.restFace(); return; }
        this.frameFor(shapes[k]); this.n++; k++; },SWAP_MS);
      return shapes.length*SWAP_MS/1000;
    }
  }
  window.BenioV4=BenioV4;
})();
