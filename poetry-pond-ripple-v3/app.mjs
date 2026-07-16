import {
  createWorld, hydrateWorld, undoLastTurn as undoWorldTurn,
  processLocalTurn, buildRippleProof, getPath
} from './world-engine.mjs';

function main(){
'use strict';

// ---------- tiny linear algebra ----------
const M4 = {
  identity(){return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);},
  multiply(a,b){
    const o=new Float32Array(16);
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
    return o;
  },
  perspective(fovy,aspect,near,far){
    const f=1/Math.tan(fovy/2),nf=1/(near-far),o=new Float32Array(16);
    o[0]=f/aspect;o[5]=f;o[10]=(far+near)*nf;o[11]=-1;o[14]=2*far*near*nf;return o;
  },
  lookAt(e,c,u){
    let zx=e[0]-c[0],zy=e[1]-c[1],zz=e[2]-c[2];let l=Math.hypot(zx,zy,zz)||1;zx/=l;zy/=l;zz/=l;
    let xx=u[1]*zz-u[2]*zy,xy=u[2]*zx-u[0]*zz,xz=u[0]*zy-u[1]*zx;l=Math.hypot(xx,xy,xz)||1;xx/=l;xy/=l;xz/=l;
    const yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
    return new Float32Array([xx,yx,zx,0,xy,yy,zy,0,xz,yz,zz,0,-(xx*e[0]+xy*e[1]+xz*e[2]),-(yx*e[0]+yy*e[1]+yz*e[2]),-(zx*e[0]+zy*e[1]+zz*e[2]),1]);
  },
  compose(p,ry,rz,s){
    const cy=Math.cos(ry),sy=Math.sin(ry),cz=Math.cos(rz),sz=Math.sin(rz);
    return new Float32Array([
      cy*cz*s[0], sz*s[0], -sy*cz*s[0],0,
      -cy*sz*s[1], cz*s[1], sy*sz*s[1],0,
      sy*s[2],0,cy*s[2],0,
      p[0],p[1],p[2],1
    ]);
  },
  invert(a){
    const o=new Float32Array(16);const a00=a[0],a01=a[1],a02=a[2],a03=a[3],a10=a[4],a11=a[5],a12=a[6],a13=a[7],a20=a[8],a21=a[9],a22=a[10],a23=a[11],a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10,b03=a01*a12-a02*a11,b04=a01*a13-a03*a11,b05=a02*a13-a03*a12,b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,b08=a20*a33-a23*a30,b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
    let d=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;if(!d)return M4.identity();d=1/d;
    o[0]=(a11*b11-a12*b10+a13*b09)*d;o[1]=(a02*b10-a01*b11-a03*b09)*d;o[2]=(a31*b05-a32*b04+a33*b03)*d;o[3]=(a22*b04-a21*b05-a23*b03)*d;
    o[4]=(a12*b08-a10*b11-a13*b07)*d;o[5]=(a00*b11-a02*b08+a03*b07)*d;o[6]=(a32*b02-a30*b05-a33*b01)*d;o[7]=(a20*b05-a22*b02+a23*b01)*d;
    o[8]=(a10*b10-a11*b08+a13*b06)*d;o[9]=(a01*b08-a00*b10-a03*b06)*d;o[10]=(a30*b04-a31*b02+a33*b00)*d;o[11]=(a21*b02-a20*b04-a23*b00)*d;
    o[12]=(a11*b07-a10*b09-a12*b06)*d;o[13]=(a00*b09-a01*b07+a02*b06)*d;o[14]=(a31*b01-a30*b03-a32*b00)*d;o[15]=(a20*b03-a21*b01+a22*b00)*d;return o;
  },
  transform(m,v){const x=v[0],y=v[1],z=v[2],w=v[3]??1;return [m[0]*x+m[4]*y+m[8]*z+m[12]*w,m[1]*x+m[5]*y+m[9]*z+m[13]*w,m[2]*x+m[6]*y+m[10]*z+m[14]*w,m[3]*x+m[7]*y+m[11]*z+m[15]*w];}
};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const ease=t=>1-Math.pow(1-clamp(t,0,1),3);
const hashString=s=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0};
const rand01=n=>{n=Math.sin(n*12.9898+78.233)*43758.5453;return n-Math.floor(n)};
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));

// ---------- DOM ----------
const $=s=>document.querySelector(s);
const canvas=$('#gl'), labelsRoot=$('#labels'), reflectionLabelsRoot=$('#reflectionLabels');
const ui={
  input:$('#lineInput'),send:$('#sendBtn'),undo:$('#undoBtn'),read:$('#readBtn'),menu:$('#menuBtn'),status:$('#status'),hint:$('#worldHint'),meta:$('#recordMeta'),modeBtn:$('#modeBtn'),modeName:$('#modeName'),modeMenu:$('#modeMenu'),drawer:$('#drawer'),backdrop:$('#drawerBackdrop'),close:$('#closeDrawer'),orbit:$('#orbitToggle'),reflect:$('#reflectionToggle'),satellites:$('#satelliteToggle'),speak:$('#speakBtn'),remember:$('#rememberToggle'),aiToggle:$('#aiToggle'),aiPolicy:$('#aiPolicy'),aiStatus:$('#aiStatus'),export:$('#exportBtn'),reset:$('#resetBtn'),resetCamera:$('#resetCameraBtn'),reading:$('#reading'),exitReading:$('#exitReading'),toasts:$('#toasts'),fallback:$('#fallback'),
  proof:$('#rippleProof'),proofText:$('#proofText'),closeProof:$('#closeProof'),runEvals:$('#runEvalsBtn'),evalStatus:$('#evalStatus'),worldStats:$('#worldStats'),usageStats:$('#usageStats'),
  clarification:$('#clarificationTray'),clarificationQuestion:$('#clarificationQuestion'),clarificationOptions:$('#clarificationOptions')
};

// ---------- WebGL ----------
const gl=canvas.getContext('webgl2',{antialias:true,alpha:false,premultipliedAlpha:false,preserveDrawingBuffer:true});
if(!gl){ui.fallback.classList.add('show');return;}

function shader(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
function program(vs,fs){const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,vs));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fs));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));return p;}
function locs(p,names){const o={};for(const n of names)o[n]=gl.getUniformLocation(p,n);return o;}
function attrib(p,name){return gl.getAttribLocation(p,name);}

const skyProgram=program(`#version 300 es
precision highp float;
out vec2 vUv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vUv=p*.5;gl_Position=vec4(p*2.0-1.0,0.9999,1.0);}`,
`#version 300 es
precision highp float;
in vec2 vUv;out vec4 outColor;uniform float uTime;uniform float uWarm;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){vec2 uv=vUv;float y=clamp(uv.y,0.0,1.0);vec3 low=mix(vec3(.055,.10,.15),vec3(.33,.18,.18),uWarm);vec3 high=mix(vec3(.045,.09,.17),vec3(.12,.13,.25),uWarm);vec3 c=mix(low,high,smoothstep(0.0,.9,y));float sun=exp(-length((uv-vec2(.72,.30))*vec2(1.0,1.6))*10.0);c+=vec3(1.0,.45,.20)*sun*.20*uWarm;vec2 g=floor(uv*vec2(650.0,360.0));float star=step(.9977,hash(g));star*=smoothstep(.42,.9,y);c+=star*(.35+.35*sin(uTime*1.3+hash(g)*9.0));outColor=vec4(c,1.0);}`);
const skyU=locs(skyProgram,['uTime','uWarm']);

const boxProgram=program(`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;layout(location=1) in vec3 aNormal;
uniform mat4 uProj,uView,uModel;out vec3 vWorld;out vec3 vNormal;out float vY;
void main(){vec4 w=uModel*vec4(aPos,1.0);vWorld=w.xyz;vNormal=mat3(uModel)*aNormal;vY=aPos.y;gl_Position=uProj*uView*w;}`,
`#version 300 es
precision highp float;
in vec3 vWorld,vNormal;in float vY;out vec4 outColor;uniform vec3 uColor,uEmissive,uCamera;uniform float uTime,uAlpha,uSelected,uFog;
float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
void main(){vec3 n=normalize(vNormal);vec3 l=normalize(vec3(-.45,.88,.35));float diff=max(dot(n,l),0.0);float rim=pow(1.0-max(dot(n,normalize(uCamera-vWorld)),0.0),2.4);float grain=hash(floor(vWorld*17.0))*.06;float edge=smoothstep(.37,.5,abs(vY));vec3 c=uColor*(.28+diff*.68)+uEmissive*(.18+edge*.85+uSelected*.55)+rim*uEmissive*.18+grain;float d=length(vWorld-uCamera);float fog=1.0-exp(-d*uFog);vec3 fogC=vec3(.055,.085,.11);c=mix(c,fogC,clamp(fog,0.0,.82));outColor=vec4(c,uAlpha);}`);
const boxU=locs(boxProgram,['uProj','uView','uModel','uColor','uEmissive','uCamera','uTime','uAlpha','uSelected','uFog']);

const waterProgram=program(`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uProj,uView,uReflectMatrix;uniform float uTime;uniform vec4 uRipples[8];
out vec3 vWorld;out vec4 vReflect;out float vWave;
float ripple(vec2 p,vec4 r){float age=uTime-r.z;if(age<0.0||age>12.0||r.w<=0.0)return 0.0;float d=distance(p,r.xy);float front=age*2.35;float ring=sin((d-front)*10.0)*exp(-abs(d-front)*1.65);return ring*r.w*exp(-age*.16);}
void main(){vec3 p=aPos;float w=sin(p.x*.22+uTime*.42)*.055+cos(p.z*.18-uTime*.32)*.045+sin((p.x+p.z)*.11+uTime*.24)*.03;for(int i=0;i<8;i++)w+=ripple(p.xz,uRipples[i]);p.y+=w;vWorld=p;vWave=w;vReflect=uReflectMatrix*vec4(p,1.0);gl_Position=uProj*uView*vec4(p,1.0);}`,
`#version 300 es
precision highp float;
in vec3 vWorld;in vec4 vReflect;in float vWave;out vec4 outColor;uniform sampler2D uReflection;uniform vec3 uCamera;uniform float uUseReflection,uTime;
void main(){vec3 dx=dFdx(vWorld),dy=dFdy(vWorld);vec3 n=normalize(cross(dx,dy));if(n.y<0.0)n=-n;vec3 view=normalize(uCamera-vWorld);float fres=pow(1.0-max(dot(n,view),0.0),3.0);vec2 uv=vReflect.xy/max(vReflect.w,.001);uv+=n.xz*.028;vec3 refl=texture(uReflection,uv).rgb;vec3 deep=vec3(.018,.07,.105);vec3 shallow=vec3(.04,.15,.19);vec3 c=mix(deep,shallow,.32+n.y*.16);c=mix(c,refl,.26+.56*fres*uUseReflection);float sparkle=pow(max(dot(reflect(-normalize(vec3(-.45,.88,.35)),n),view),0.0),78.0);c+=vec3(1.0,.74,.42)*sparkle*.8;c+=vec3(.12,.42,.47)*abs(vWave)*.7;outColor=vec4(c,.91);}`);
const waterU=locs(waterProgram,['uProj','uView','uReflectMatrix','uTime','uRipples[0]','uReflection','uCamera','uUseReflection']);waterU.uRipples=waterU['uRipples[0]'];

const lineProgram=program(`#version 300 es
precision highp float;layout(location=0) in vec3 aPos;uniform mat4 uProj,uView;uniform float uTime,uPhase;out float vPulse;void main(){vPulse=.35+.65*pow(.5+.5*sin(uTime*1.8+uPhase+aPos.y*2.0),3.0);gl_Position=uProj*uView*vec4(aPos,1.0);}`,
`#version 300 es
precision highp float;in float vPulse;out vec4 outColor;uniform vec3 uColor;uniform float uAlpha;void main(){outColor=vec4(uColor,uAlpha*vPulse);}`);
const lineU=locs(lineProgram,['uProj','uView','uTime','uPhase','uColor','uAlpha']);

function createBox(){
  const p=[
  -1,-1, 1, 1,-1, 1, 1,1,1,-1,1,1,  1,-1,-1,-1,-1,-1,-1,1,-1,1,1,-1,
  -1,1,1,1,1,1,1,1,-1,-1,1,-1,  -1,-1,-1,1,-1,-1,1,-1,1,-1,-1,1,
   1,-1,1,1,-1,-1,1,1,-1,1,1,1, -1,-1,-1,-1,-1,1,-1,1,1,-1,1,-1];
  const n=[0,0,1,0,0,1,0,0,1,0,0,1, 0,0,-1,0,0,-1,0,0,-1,0,0,-1, 0,1,0,0,1,0,0,1,0,0,1,0, 0,-1,0,0,-1,0,0,-1,0,0,-1,0, 1,0,0,1,0,0,1,0,0,1,0,0, -1,0,0,-1,0,0,-1,0,0,-1,0,0];
  const ind=[];for(let f=0;f<6;f++){const o=f*4;ind.push(o,o+1,o+2,o,o+2,o+3)}
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);const pb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,pb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(p),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);const nb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,nb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(n),gl.STATIC_DRAW);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,0,0);const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(ind),gl.STATIC_DRAW);gl.bindVertexArray(null);return{vao,count:ind.length};
}
function createWater(size=82,seg=150){
  const v=[],ind=[];for(let z=0;z<=seg;z++)for(let x=0;x<=seg;x++){v.push((x/seg-.5)*size,0,(z/seg-.5)*size)}
  for(let z=0;z<seg;z++)for(let x=0;x<seg;x++){const a=z*(seg+1)+x,b=a+1,c=a+seg+1,d=c+1;ind.push(a,c,b,b,c,d)}
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(v),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(ind),gl.STATIC_DRAW);gl.bindVertexArray(null);return{vao,count:ind.length};
}
function createArc(a,b,h=4,segments=72){
  const v=[];for(let i=0;i<=segments;i++){const t=i/segments;const x=lerp(a[0],b[0],t),z=lerp(a[2],b[2],t),y=lerp(a[1],b[1],t)+Math.sin(Math.PI*t)*h;v.push(x,y,z)}
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(v),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);gl.bindVertexArray(null);return{vao,count:v.length/3};
}
const boxMesh=createBox(),waterMesh=createWater();

// ---------- reflection target ----------
let reflectW=1,reflectH=1,reflectionTexture=null,reflectionFbo=null,reflectionDepth=null;
function resizeReflection(w,h){
  const scale=Math.min(1,900/Math.max(w,h));reflectW=Math.max(2,Math.floor(w*scale));reflectH=Math.max(2,Math.floor(h*scale));
  if(reflectionTexture)gl.deleteTexture(reflectionTexture);if(reflectionDepth)gl.deleteRenderbuffer(reflectionDepth);if(reflectionFbo)gl.deleteFramebuffer(reflectionFbo);
  reflectionTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,reflectionTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,reflectW,reflectH,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  reflectionDepth=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,reflectionDepth);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,reflectW,reflectH);
  reflectionFbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,reflectionFbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,reflectionTexture,0);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,reflectionDepth);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
}

// ---------- state and content ----------
const instructionEntries=[
  {id:'i1',role:'instruction',text:'DROP ONE ACTION'},
  {id:'i2',role:'instruction',text:'THE WORLD STORES WHAT CHANGED'},
  {id:'i3',role:'instruction',text:'A LATER STRATUM MUST RESPOND'},
  {id:'i4',role:'instruction',text:'TOUCH IT TO SEE THE CAUSE'},
  {id:'i5',role:'instruction',text:'UNDO RESTORES THE PRIOR WORLD'}
];
const satellites=[
  {id:'history',x:-11,z:-5,scale:.50,yaw:.16,words:['HISTORY','EVENTS','CAUSE','PROOF']},
  {id:'memory',x:11,z:-6,scale:.53,yaw:-.18,words:['MEMORY','ENTITIES','STATE','PERSISTENCE']},
  {id:'possibility',x:-18,z:-18,scale:.38,yaw:.2,words:['POSSIBILITY','GOAL','FUTURE']},
  {id:'return',x:17,z:-20,scale:.35,yaw:-.1,words:['RETURN','UNDO','RESTORE']},
  {id:'silence',x:0,z:-25,scale:.31,yaw:0,words:['SILENCE','WAIT','UNRESOLVED']}
];
const state={
  entries:instructionEntries.map(x=>({...x})),mode:'Stone',busy:false,operation:null,batches:[],selectedId:null,selectedCausalIds:[],pendingClarification:null,
  world:createWorld(),usageLog:[],evalReport:null,
  orbit:false,reflect:true,showSatellites:true,remember:false,reading:false,
  aiEnabled:true,aiPolicy:'efficient',serverAvailable:false,aiAvailable:false,solModel:'gpt-5.6-sol',lunaModel:'gpt-5.6-luna',apiPath:'/api/turn',lastGenerator:'local-typed',warm:.42,
  yaw:0,pitch:.16,distance:18,target:[0,3.15,0],camera:[0,0,0],
  ripples:[],falling:null,lastTime:performance.now(),autoPhase:0
};
const storageKey='poetry-pond-ripple-v3';
function loadRemembered(){
  try{
    const raw=localStorage.getItem(storageKey);if(!raw)return;
    const d=JSON.parse(raw);if(!d.remember)return;
    state.remember=true;
    state.entries=Array.isArray(d.entries)&&d.entries.length?d.entries:state.entries;
    state.batches=Array.isArray(d.batches)?d.batches:[];
    state.mode=d.mode||'Stone';state.aiEnabled=d.aiEnabled!==false;state.aiPolicy=['efficient','deep','luna'].includes(d.aiPolicy)?d.aiPolicy:'efficient';
    state.world=hydrateWorld(d.world||{});state.usageLog=Array.isArray(d.usageLog)?d.usageLog:[];
    state.lastGenerator=d.lastGenerator||'local-typed';state.orbit=!!d.orbit;state.reflect=d.reflect!==false;state.showSatellites=d.showSatellites!==false;
  }catch(e){console.warn('Could not restore pond ledger.',e)}
}
loadRemembered();
function save(){
  if(!state.remember){localStorage.removeItem(storageKey);return}
  localStorage.setItem(storageKey,JSON.stringify({
    remember:true,entries:state.entries,batches:state.batches,mode:state.mode,aiEnabled:state.aiEnabled,aiPolicy:state.aiPolicy,
    world:state.world,usageLog:state.usageLog,lastGenerator:state.lastGenerator,orbit:state.orbit,reflect:state.reflect,showSatellites:state.showSatellites
  }))
}

const colors={
  instruction:{base:[.15,.19,.22],em:[.16,.24,.27]},
  user:{base:[.24,.20,.15],em:[.95,.58,.18]},
  consequence:{base:[.18,.18,.18],em:[.30,.26,.20]},
  therefore:{base:[.23,.18,.10],em:[.95,.58,.16]},
  branch:{base:[.10,.23,.24],em:[.20,.86,.82]},
  satellite:{base:[.13,.17,.18],em:[.12,.28,.29]}
};

let rootSlabs=[],satelliteSlabs=[],labelRecords=[],arcRecords=[];
function rebuildWorld(animateId=null){
  rootSlabs=[];satelliteSlabs=[];arcRecords=[];labelsRoot.textContent='';reflectionLabelsRoot.textContent='';labelRecords=[];
  const total=state.entries.length;let y=.34;
  state.entries.forEach((entry,i)=>{
    const seed=hashString(entry.id);const t=i/Math.max(1,total-1);const profile=9.6-3.15*Math.pow(t,.72);const width=profile*(.94+rand01(seed)*.12);const height=.48+(rand01(seed+1)*.14);const depth=2.35+(rand01(seed+2)*.52);const rz=(rand01(seed+3)-.5)*.045;const ry=(rand01(seed+4)-.5)*.025;
    const role=entry.role||'consequence';const slab={entry,x:0,y:y+height*.5,z:0,width,height,depth,rz,ry,role,seed,appear:entry.id===animateId?performance.now():0};rootSlabs.push(slab);y+=height+.065;
    createLabel(slab,false);
  });
  for(const s of satellites){
    let sy=.25;const list=[];
    const branchEvents=state.world.events.filter(event=>event.branchTarget===s.id).slice(-3);
    const words=[...s.words,...branchEvents.map(event=>event.sourceText)];
    words.forEach((text,i)=>{const seed=hashString(s.id+text+i);const h=.48;const w=Math.max(2.1,(7.5-i*.42)*s.scale);const d=2.2*s.scale;const isBranch=i>=s.words.length;const slab={entry:{id:isBranch?`sat-${s.id}-${branchEvents[i-s.words.length]?.id}`:s.id+i,role:'satellite',text,eventId:isBranch?branchEvents[i-s.words.length]?.id:null,usedEventIds:isBranch?[branchEvents[i-s.words.length]?.id]:[]},x:s.x,y:sy+h*s.scale*.5,z:s.z,width:w,height:h*s.scale,depth:d,rz:(rand01(seed)-.5)*.06,ry:s.yaw,role:'satellite',seed,mountain:s.id,scale:s.scale};sy+=h*s.scale+.05;list.push(slab);createLabel(slab,false)});satelliteSlabs.push(...list);
  }
  if(state.showSatellites){
    const peak=[0,y+.2,0];satellites.slice(0,4).forEach((s,i)=>{const sy=s.words.length*(.48*s.scale+.05)+.3;arcRecords.push({mesh:createArc(peak,[s.x,sy,s.z],2.7+i*.55),phase:i*1.7,color:i%2?[.96,.63,.30]:[.30,.88,.84]})});
  }
  updateMeta();
}
function createLabel(slab){
  const el=document.createElement('div');el.className=`stratum-label ${slab.role}`;el.textContent=slab.entry.text;el.dataset.id=slab.entry.id;labelsRoot.appendChild(el);
  const ref=document.createElement('div');ref.className='reflection-label';ref.textContent=slab.entry.text;reflectionLabelsRoot.appendChild(ref);
  el.addEventListener('click',()=>selectSlab(slab.entry.id));
  labelRecords.push({slab,el,ref});
}
function clearProof(){
  state.selectedId=null;state.selectedCausalIds=[];ui.proof?.classList.remove('open');
  labelRecords.forEach(record=>record.el.classList.remove('causal-source'));
}
function selectSlab(id){
  const e=state.entries.find(x=>x.id===id)||satelliteSlabs.find(x=>x.entry.id===id)?.entry;
  if(!e)return;
  state.selectedId=id;
  const usedIds=Array.isArray(e.usedEventIds)?e.usedEventIds:[];
  const proof=buildRippleProof(state.world,usedIds);
  state.selectedCausalIds=proof.map(item=>item.sourceStratumId).filter(Boolean);
  labelRecords.forEach(record=>record.el.classList.toggle('causal-source',state.selectedCausalIds.includes(record.slab.entry.id)));
  if(proof.length){
    const changes=proof.flatMap(item=>item.changes.map(change=>change.description)).slice(0,3);
    ui.proofText.innerHTML=`<b>Ripple proof</b>${escapeHtml(proof[0].sourceText)}${changes.length?` · ${changes.map(escapeHtml).join(' · ')}`:''}`;
    ui.proof.classList.add('open');
    showStatus(`This stratum cites ${proof.length} stored event${proof.length===1?'':'s'}.`,'');
  }else if(e.role==='satellite'){
    const stackId=e.id.replace(/\d+$/,'');const stack=state.world.entities[`stack:${stackId}`];
    ui.proofText.innerHTML=`<b>Stack state</b>${escapeHtml(stackId)} · activation count ${Number(stack?.attributes?.activationCount||0)} · last event ${escapeHtml(stack?.attributes?.lastEventId||'none')}`;
    ui.proof.classList.add('open');
  }else{
    ui.proofText.innerHTML=`<b>Stratum</b>${escapeHtml(e.text)} · no earlier causal event cited`;
    ui.proof.classList.add('open');
  }
  speak(e.text);
}
function updateMeta(){
  const conversation=state.entries.length-instructionEntries.length;
  const events=state.world.events.length,entities=Math.max(0,Object.keys(state.world.entities).length-6);
  const context=events?`${events} validated event${events===1?'':'s'}`:'new world';
  ui.meta.textContent=conversation?`${conversation} strata · ${state.batches.length} exchange${state.batches.length===1?'':'s'} · ${context}`:'Instruction strata: 5 · empty ledger';
  ui.undo.disabled=state.busy||state.batches.length===0;ui.hint.classList.toggle('hide',conversation>0);
  if(ui.worldStats)ui.worldStats.textContent=`${entities} entities · ${events} events`;
  if(ui.usageStats){
    const totals=state.usageLog.reduce((a,x)=>{const u=x.usage?.totals||x.usage||{};a.calls+=Number(x.usage?.callCount||0);a.input+=Number(u.inputTokens||u.input_tokens||0);a.cached+=Number(u.cachedTokens||0);a.output+=Number(u.outputTokens||u.output_tokens||0);a.reasoning+=Number(u.reasoningTokens||0);a.cost+=Number(u.estimatedCostUsd||0);return a},{calls:0,input:0,cached:0,output:0,reasoning:0,cost:0});
    const hit=totals.input?Math.round(totals.cached/totals.input*100):0;ui.usageStats.textContent=`${totals.calls} calls · ${totals.input}/${totals.output} tok · ${hit}% cached · $${totals.cost.toFixed(4)}`;
  }
  save();
}
rebuildWorld();

// ---------- geometry drawing ----------
function drawSky(time,warm){gl.disable(gl.DEPTH_TEST);gl.useProgram(skyProgram);gl.uniform1f(skyU.uTime,time);gl.uniform1f(skyU.uWarm,warm);gl.drawArrays(gl.TRIANGLES,0,3);gl.enable(gl.DEPTH_TEST)}
function setMat4(l,m){gl.uniformMatrix4fv(l,false,m)}
function drawBox(slab,view,proj,camera,time,reflection=false,alpha=1){
  const role=colors[slab.role]||colors.consequence;let y=slab.y;let scale=1;
  if(slab.appear){const p=ease((performance.now()-slab.appear)/780);y=lerp(slab.y+5.5,slab.y,p);scale=lerp(.72,1,p);if(p>=1)slab.appear=0}
  const model=M4.compose([slab.x,y,slab.z],slab.ry,slab.rz,[slab.width*.5*scale,slab.height*.5*scale,slab.depth*.5*scale]);
  gl.useProgram(boxProgram);setMat4(boxU.uProj,proj);setMat4(boxU.uView,view);setMat4(boxU.uModel,model);gl.uniform3fv(boxU.uColor,role.base);gl.uniform3fv(boxU.uEmissive,role.em);gl.uniform3fv(boxU.uCamera,camera);gl.uniform1f(boxU.uTime,time);gl.uniform1f(boxU.uAlpha,alpha);gl.uniform1f(boxU.uSelected,state.selectedId===slab.entry.id?1:state.selectedCausalIds.includes(slab.entry.id)?.72:0);gl.uniform1f(boxU.uFog,reflection?.018:.012);gl.bindVertexArray(boxMesh.vao);gl.drawElements(gl.TRIANGLES,boxMesh.count,gl.UNSIGNED_SHORT,0);
}
function drawWorld(view,proj,camera,time,reflection=false){
  gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);
  if(state.showSatellites)for(const s of satelliteSlabs)drawBox(s,view,proj,camera,time,reflection,.96);
  for(const s of rootSlabs)drawBox(s,view,proj,camera,time,reflection,1);
  if(state.falling){const f=state.falling;const slab={entry:{id:'fall'},x:0,y:f.y,z:0,width:.52,height:.42,depth:.56,rz:f.rz,ry:f.ry,role:'user',seed:0};drawBox(slab,view,proj,camera,time,reflection,1)}
  if(!reflection&&state.showSatellites){
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.depthMask(false);gl.useProgram(lineProgram);setMat4(lineU.uProj,proj);setMat4(lineU.uView,view);gl.uniform1f(lineU.uTime,time);for(const a of arcRecords){gl.uniform1f(lineU.uPhase,a.phase);gl.uniform3fv(lineU.uColor,a.color);gl.uniform1f(lineU.uAlpha,.34);gl.bindVertexArray(a.mesh.vao);gl.drawArrays(gl.LINE_STRIP,0,a.mesh.count)}gl.depthMask(true);gl.disable(gl.BLEND);
  }
}
function drawWater(view,proj,reflectMatrix,camera,time){
  gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);gl.useProgram(waterProgram);setMat4(waterU.uProj,proj);setMat4(waterU.uView,view);setMat4(waterU.uReflectMatrix,reflectMatrix);gl.uniform1f(waterU.uTime,time);const arr=new Float32Array(32);state.ripples.slice(-8).forEach((r,i)=>{arr[i*4]=r.x;arr[i*4+1]=r.z;arr[i*4+2]=r.start;arr[i*4+3]=r.amp});gl.uniform4fv(waterU.uRipples,arr);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,reflectionTexture);gl.uniform1i(waterU.uReflection,0);gl.uniform3fv(waterU.uCamera,camera);gl.uniform1f(waterU.uUseReflection,state.reflect?1:0);gl.bindVertexArray(waterMesh.vao);gl.drawElements(gl.TRIANGLES,waterMesh.count,gl.UNSIGNED_INT,0);gl.depthMask(true);gl.disable(gl.BLEND);
}

// ---------- projection and label positioning ----------
function project(world,viewProj,w,h){const c=M4.transform(viewProj,[world[0],world[1],world[2],1]);if(c[3]<=.02)return null;const x=c[0]/c[3],y=c[1]/c[3],z=c[2]/c[3];if(z<-1||z>1)return null;return[(x*.5+.5)*w,(-y*.5+.5)*h,z,c[3]]}
function updateLabels(view,proj){
  const vp=M4.multiply(proj,view),w=innerWidth,h=innerHeight;
  for(const r of labelRecords){const s=r.slab;if(s.role==='satellite'&&!state.showSatellites){r.el.style.opacity=0;r.ref.style.opacity=0;continue}
    const frontZ=s.z+Math.cos(s.ry)*s.depth*.51;const center=[s.x,s.y,frontZ];const left=[s.x-Math.cos(s.ry)*s.width*.43,s.y,frontZ+Math.sin(s.ry)*s.width*.43];const right=[s.x+Math.cos(s.ry)*s.width*.43,s.y,frontZ-Math.sin(s.ry)*s.width*.43];const top=[s.x,s.y+s.height*.34,frontZ];const bottom=[s.x,s.y-s.height*.34,frontZ];const pc=project(center,vp,w,h),pl=project(left,vp,w,h),pr=project(right,vp,w,h),pt=project(top,vp,w,h),pb=project(bottom,vp,w,h);
    const facing=(state.camera[2]-s.z)*Math.cos(s.ry)+(state.camera[0]-s.x)*Math.sin(s.ry);if(!pc||!pl||!pr||!pt||!pb||facing<.1){r.el.style.opacity=0;r.ref.style.opacity=0;continue}
    const width=Math.hypot(pr[0]-pl[0],pr[1]-pl[1]),height=Math.max(10,Math.hypot(pt[0]-pb[0],pt[1]-pb[1]));const angle=Math.atan2(pr[1]-pl[1],pr[0]-pl[0])*180/Math.PI;const font=clamp(height*.72,s.role==='satellite'?7:9,s.role==='user'?25:22);r.el.style.left=pc[0]+'px';r.el.style.top=pc[1]+'px';r.el.style.width=width+'px';r.el.style.height=Math.max(height*1.15,18)+'px';r.el.style.fontSize=font+'px';r.el.style.transform=`translate(-50%,-50%) rotate(${angle}deg)`;r.el.style.opacity=s.appear?ease((performance.now()-s.appear)/600):clamp(1-pc[2]*.15,.55,1);r.el.classList.toggle('selected',state.selectedId===s.entry.id);
    const mirror=[center[0],-center[1],center[2]],ml=[left[0],-left[1],left[2]],mr=[right[0],-right[1],right[2]];const pm=project(mirror,vp,w,h),pml=project(ml,vp,w,h),pmr=project(mr,vp,w,h);if(pm&&pml&&pmr&&pm[1]>h*.48){const mw=Math.hypot(pmr[0]-pml[0],pmr[1]-pml[1]);const ma=Math.atan2(pmr[1]-pml[1],pmr[0]-pml[0])*180/Math.PI;r.ref.style.left=pm[0]+'px';r.ref.style.top=pm[1]+'px';r.ref.style.width=mw+'px';r.ref.style.height=Math.max(height,15)+'px';r.ref.style.fontSize=clamp(font*.76,6,18)+'px';r.ref.style.transform=`translate(-50%,-50%) rotate(${ma}deg) scaleY(-1)`;r.ref.style.opacity=state.reflect?clamp(.24-(pm[1]-h*.48)/h*.25,.025,.20):0}else r.ref.style.opacity=0;
  }
}

// ---------- camera and render loop ----------
let proj=M4.identity(),view=M4.identity(),reflectView=M4.identity(),reflectMatrix=M4.identity();
function updateCamera(dt){if(state.orbit&&!state.busy&&!state.reading)state.yaw+=dt*.00005;if(state.reading)state.yaw+=dt*.000035;const cp=Math.cos(state.pitch),sp=Math.sin(state.pitch),sy=Math.sin(state.yaw),cy=Math.cos(state.yaw);state.camera=[state.target[0]+sy*cp*state.distance,state.target[1]+sp*state.distance,state.target[2]+cy*cp*state.distance];view=M4.lookAt(state.camera,state.target,[0,1,0]);const re=[state.camera[0],-state.camera[1],state.camera[2]],rt=[state.target[0],-state.target[1],state.target[2]];reflectView=M4.lookAt(re,rt,[0,-1,0]);const bias=new Float32Array([.5,0,0,0,0,.5,0,0,0,0,.5,0,.5,.5,.5,1]);reflectMatrix=M4.multiply(bias,M4.multiply(proj,reflectView));}
function resize(){const dpr=Math.min(devicePixelRatio||1,2);const w=Math.max(1,innerWidth),h=Math.max(1,innerHeight);canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';gl.viewport(0,0,canvas.width,canvas.height);proj=M4.perspective(Math.PI/4.2,w/h,.1,120);resizeReflection(canvas.width,canvas.height)}
addEventListener('resize',resize,{passive:true});resize();
function frame(now){const dt=Math.min(40,now-state.lastTime);state.lastTime=now;const time=now*.001;updateCamera(dt);state.ripples=state.ripples.filter(r=>time-r.start<12);
  if(state.falling){const p=(now-state.falling.started)/760;state.falling.y=lerp(13,state.falling.targetY,ease(p));state.falling.ry+=dt*.004;state.falling.rz+=dt*.006;if(p>=1)state.falling=null}
  if(state.reflect){gl.bindFramebuffer(gl.FRAMEBUFFER,reflectionFbo);gl.viewport(0,0,reflectW,reflectH);gl.clearColor(.02,.05,.08,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);drawSky(time,state.warm);drawWorld(reflectView,proj,[state.camera[0],-state.camera[1],state.camera[2]],time,true)}
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(.02,.05,.08,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);drawSky(time,state.warm);drawWorld(view,proj,state.camera,time,false);drawWater(view,proj,reflectMatrix,state.camera,time);updateLabels(view,proj);requestAnimationFrame(frame)}
requestAnimationFrame(frame);

// ---------- interaction ----------
let drag=null,pinchDist=0;
function pointRay(clientX,clientY){const x=clientX/innerWidth*2-1,y=1-clientY/innerHeight*2;const inv=M4.invert(M4.multiply(proj,view));const n=M4.transform(inv,[x,y,-1,1]),f=M4.transform(inv,[x,y,1,1]);for(const p of[n,f]){p[0]/=p[3];p[1]/=p[3];p[2]/=p[3]}const d=[f[0]-n[0],f[1]-n[1],f[2]-n[2]];const t=-n[1]/d[1];return t>0?[n[0]+d[0]*t,0,n[2]+d[2]*t]:null}
canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);drag={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,moved:0}});
canvas.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.lastX,dy=e.clientY-drag.lastY;drag.moved+=Math.abs(dx)+Math.abs(dy);state.yaw-=dx*.006;state.pitch=clamp(state.pitch+dy*.004,-.06,.56);drag.lastX=e.clientX;drag.lastY=e.clientY});
canvas.addEventListener('pointerup',e=>{if(drag&&drag.id===e.pointerId&&drag.moved<8){const p=pointRay(e.clientX,e.clientY);if(p)addRipple(p[0],p[2],.18)}drag=null});
canvas.addEventListener('wheel',e=>{e.preventDefault();state.distance=clamp(state.distance*Math.exp(e.deltaY*.0012),10.5,31)},{passive:false});
canvas.addEventListener('dblclick',resetCamera);
canvas.addEventListener('touchstart',e=>{if(e.touches.length===2)pinchDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY)},{passive:true});
canvas.addEventListener('touchmove',e=>{if(e.touches.length===2){const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);if(pinchDist)state.distance=clamp(state.distance*(pinchDist/d),10.5,31);pinchDist=d}},{passive:true});
function resetCamera(){state.yaw=0;state.pitch=.16;state.distance=18;state.target=[0,3.15,0];toast('Camera returned to the waterline view.')}
function addRipple(x,z,amp=.24){state.ripples.push({x,z,start:performance.now()*.001,amp});if(state.ripples.length>8)state.ripples.shift()}

// ---------- generation, authoritative state, and strata ----------
function latestTopY(){const s=rootSlabs[rootSlabs.length-1];return s?s.y+s.height*.5+.08:.5}
function makeId(prefix='s'){return prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7)}
function ripplePoint(target){const s=satellites.find(x=>x.id===target);return s?[s.x,s.z]:[0,0]}
function sleepOp(ms,op){return new Promise(resolve=>{if(op.cancelled)return resolve(false);const rec={timer:0,resolve};rec.timer=setTimeout(()=>{op.waits.delete(rec);resolve(!op.cancelled)},ms);op.waits.add(rec)})}
function setBusy(active){state.busy=active;ui.input.disabled=active;ui.modeBtn.disabled=active;ui.send.disabled=false;ui.send.classList.toggle('stop',active);ui.send.textContent=active?'Stop':'Drop stone'}
function closeClarification(){state.pendingClarification=null;ui.clarification?.classList.remove('open');ui.clarification?.setAttribute('aria-hidden','true');if(ui.clarificationOptions)ui.clarificationOptions.textContent=''}
function showClarification(pending,clarification){
  state.pendingClarification={...pending,clarification};
  ui.clarificationQuestion.textContent=clarification.question||'The action needs a more exact interpretation.';
  ui.clarificationOptions.textContent='';
  for(const option of clarification.options||[]){
    const button=document.createElement('button');button.type='button';button.textContent=option.label||'Resolve';
    button.addEventListener('click',()=>{
      const resolution=option.resolution||{kind:'cancel'};
      if(resolution.kind==='cancel'){
        state.entries=state.entries.filter(entry=>entry.batchId!==pending.batchId);closeClarification();rebuildWorld();showStatus('The unresolved stone was withdrawn before it altered the world.','');toast('Nothing was committed.');save();ui.input.focus();return;
      }
      closeClarification();executeTurn({...pending,resolution,reuseEntry:true,skipFall:true});
    });
    ui.clarificationOptions.appendChild(button);
  }
  ui.clarification.classList.add('open');ui.clarification.setAttribute('aria-hidden','false');
}
async function remoteTurn(payload,signal){
  if(!state.serverAvailable)return null;
  const started=performance.now();
  const r=await fetch(state.apiPath,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    world:state.world,text:payload.text,original_text:payload.originalText||payload.text,mode:payload.mode,resolution:payload.resolution||null,
    request_id:payload.batchId,turn_id:payload.batchId,event_id:payload.eventId,source_stratum_id:payload.userId,created_at:payload.createdAt,use_openai:state.aiEnabled,ai_policy:state.aiPolicy
  }),signal});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`Context engine returned ${r.status}`);
  const usage=j.usage||null;state.usageLog.push({batchId:payload.batchId,createdAt:new Date().toISOString(),latencyMs:Math.round(performance.now()-started),status:'completed',usage,aiRoute:j.aiRoute||null,proposer:j.proposer||null,generator:j.generator||null});updateMeta();
  return j;
}
async function checkAIStatus(){
  try{const r=await fetch('/api/status',{cache:'no-store'});const j=await r.json();state.serverAvailable=!!r.ok;state.aiAvailable=!!(r.ok&&j.configured);state.solModel=j.solModel||state.solModel;state.lunaModel=j.lunaModel||j.writerModel||j.model||state.lunaModel;state.keySource=j.keySource||'none';state.keyTail=j.keyTail||'';if(!localStorage.getItem(storageKey)&&j.defaultPolicy)state.aiPolicy=j.defaultPolicy}
  catch(_){state.serverAvailable=false;state.aiAvailable=false;state.keySource='none';state.keyTail=''}
  updateAIStatus();
}
function updateAIStatus(){
  if(!ui.aiStatus)return;
  const policyLabel=state.aiPolicy==='deep'?'Deep':state.aiPolicy==='luna'?'Luna':'Efficient';
  ui.aiStatus.textContent=!state.serverAvailable?'Browser engine':!state.aiEnabled?'Server validation only':state.aiAvailable?`${state.solModel} + ${state.lunaModel}`:'Server local validation';
  ui.aiToggle.querySelector('.value').textContent=state.aiEnabled?'On':'Off';if(ui.aiPolicy)ui.aiPolicy.querySelector('.value').textContent=policyLabel;
  const note=document.getElementById('apiKeyNote');
  if(note){
    if(!state.serverAvailable){note.textContent='The local server is not reachable, so no key can be held. The browser typed engine is running.';note.className='field-note key-note-off'}
    else if(state.aiAvailable){note.textContent=`Key active (…${state.keyTail}, source: ${state.keySource==='env'?'server environment':'saved from this panel'}). Luna and Sol are live.`;note.className='field-note key-note-ok'}
    else{note.textContent='No key configured. The typed local engine runs everything; add a key to enable Luna and Sol.';note.className='field-note key-note-off'}
  }
}
async function saveApiKey(){
  const input=document.getElementById('apiKeyInput');const note=document.getElementById('apiKeyNote');
  const key=input.value.trim();
  if(!key){toast('Paste a key first, or use Clear to remove the saved one.');return}
  try{
    const r=await fetch('/api/llm-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error||`The server refused the key (${r.status}).`);
    input.value='';
    await checkAIStatus();
    toast(`Key saved on the local server (…${j.keyTail||''}). Luna and Sol routing is live.`);
  }catch(err){note.textContent=err.message;note.className='field-note key-note-err';toast('The key was not saved.')}
}
async function clearApiKey(){
  try{
    const r=await fetch('/api/llm-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:''})});
    if(!r.ok)throw new Error('The server could not clear the key.');
    document.getElementById('apiKeyInput').value='';
    await checkAIStatus();
    toast(state.aiAvailable?'Runtime key cleared; the server environment key remains.':'Key cleared. The typed local engine continues.');
  }catch(err){toast(err.message)}
}
document.getElementById('apiKeySave')?.addEventListener('click',saveApiKey);
document.getElementById('apiKeyClear')?.addEventListener('click',clearApiKey);
document.getElementById('apiKeyInput')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();saveApiKey()}});
function stopOperation(){
  const op=state.operation;if(!op)return;
  op.cancelled=true;op.abort?.abort();for(const w of op.waits){clearTimeout(w.timer);w.resolve(false)}op.waits.clear();
  if(op.eventApplied&&!state.batches.some(b=>b.id===op.id)){
    state.batches.push({id:op.id,text:op.text,mode:op.mode,createdAt:op.createdAt,partial:true,eventId:op.event?.id||null,generator:'interrupted',addedStrata:op.added});state.lastGenerator='interrupted';
  }else if(!op.eventApplied){state.entries=state.entries.filter(entry=>entry.batchId!==op.id)}
  setBusy(false);state.operation=null;state.falling=null;showStatus(`Generation stopped. ${op.added} completed strata remain; the ledger ${op.eventApplied?'keeps the accepted action':'was not changed'}.`,'');updateMeta();save();toast('Stop preserved only accepted state and visible completed strata.');
}
async function obtainTurn(payload,op){
  let result=null;
  try{result=await remoteTurn(payload,op.abort.signal)}catch(err){if(op.cancelled)return null;state.serverAvailable=false;state.aiAvailable=false;updateAIStatus();state.usageLog.push({batchId:payload.batchId,createdAt:new Date().toISOString(),status:'failed',error:err.message});toast(`${err.message}. The browser typed engine continued.`)}
  if(!result)result=processLocalTurn(state.world,{text:payload.text,originalText:payload.originalText||payload.text,mode:payload.mode,resolution:payload.resolution||null,turnId:payload.batchId,eventId:payload.eventId,idempotencyKey:payload.batchId,sourceStratumId:payload.userId,createdAt:payload.createdAt});
  return result;
}
async function executeTurn(payload){
  if(state.busy)return;
  const {text,mode,batchId,userId,createdAt}=payload;
  const op={id:batchId,text,mode,createdAt,userId,cancelled:false,added:0,eventApplied:false,event:null,waits:new Set(),abort:new AbortController()};
  state.operation=op;setBusy(true);clearProof();
  let userEntry=state.entries.find(entry=>entry.id===userId);
  if(!payload.reuseEntry){
    addRipple(0,0,.18);const top=latestTopY();state.falling={started:performance.now(),y:13,targetY:top+.3,ry:0,rz:0};showStatus('The stone is falling toward typed interpretation.','busy');
    if(!await sleepOp(650,op))return;
    userEntry={id:userId,batchId,role:'pending',mode,text,createdAt,eventId:null,usedEventIds:[]};state.entries.push(userEntry);op.added++;state.falling=null;rebuildWorld(userEntry.id);
  }else{showStatus('The participant resolved the ambiguity. Validating the event again.','busy')}
  try{
    const result=await obtainTurn(payload,op);if(!result||op.cancelled)return;
    if(result.status==='needs_clarification'){
      userEntry.role='pending';setBusy(false);state.operation=null;state.falling=null;rebuildWorld(userEntry.id);showClarification(payload,result.clarification);showStatus('The stone cannot settle until the ambiguity is resolved.','');toast('No world state changed.');save();return;
    }
    if(result.status!=='accepted')throw new Error(result.error||'The event was rejected.');
    state.world=hydrateWorld(result.world);op.eventApplied=true;op.event=result.event;userEntry.role='user';userEntry.eventId=result.event.id;userEntry.usedEventIds=[result.event.id];
    const response=result.render;const profile=result.ripple;state.lastGenerator=result.generator||response.generator||'local-typed';
    addRipple(0,0,profile.impact);showStatus(`${profile.evidence?.changedProperties||0} material property changes passed ontology validation.`,'busy');rebuildWorld(userEntry.id);
    for(let i=0;i<response.consequences.length;i++){
      if(!await sleepOp(650+i*80,op))return;
      const item=response.consequences[i];const e={id:makeId('consequence'),batchId,role:'consequence',text:item.text,createdAt:new Date().toISOString(),eventId:result.event.id,usedEventIds:item.usedEventIds||[],proof:buildRippleProof(state.world,item.usedEventIds||[])};
      state.entries.push(e);op.added++;rebuildWorld(e.id);addRipple(0,0,profile.consequences[i]||.2);showStatus(`Consequence ${i+1} settled from verified event evidence.`,'busy');
    }
    if(response.branch&&!op.cancelled&&await sleepOp(560,op)){
      const item=response.branch;const e={id:makeId('branch'),batchId,role:'branch',text:item.text,createdAt:new Date().toISOString(),target:item.target,eventId:result.event.id,usedEventIds:item.usedEventIds||[],proof:buildRippleProof(state.world,item.usedEventIds||[])};
      state.entries.push(e);op.added++;rebuildWorld(e.id);const [rx,rz]=ripplePoint(item.target);addRipple(rx,rz,profile.branch||.28);showStatus(`The ${item.target} mountain gained a material event layer.`,'busy');
    }
    if(!await sleepOp(620,op))return;
    const item=response.therefore;const t={id:makeId('therefore'),batchId,role:'therefore',text:item.text,createdAt:new Date().toISOString(),eventId:result.event.id,usedEventIds:item.usedEventIds||[],proof:buildRippleProof(state.world,item.usedEventIds||[])};
    state.entries.push(t);op.added++;
    state.batches.push({id:batchId,text,mode,createdAt,eventId:result.event.id,proposer:result.proposer||result.source||'local-proposer',generator:state.lastGenerator,aiRoute:result.aiRoute||null,ripple:profile,relevantEventIds:(result.relevantEvents||[]).map(event=>event.id),usage:result.usage||null,partial:false});
    rebuildWorld(t.id);addRipple(0,0,profile.final||.28);setBusy(false);state.operation=null;showStatus('The typed event, world state, visible strata, satellite branch, and ripple now agree.','');toast('The turn passed the Ripple Contract.');ui.input.focus();save();
  }catch(err){
    state.entries=state.entries.filter(entry=>entry.batchId!==batchId);setBusy(false);state.operation=null;state.falling=null;rebuildWorld();showStatus(`The action was rejected before altering the world: ${err.message}`,'fault');toast('Nothing false was added.');
  }
}
function submitLine(){
  if(state.busy){stopOperation();return}
  if(state.pendingClarification)return;
  const text=ui.input.value.trim();if(!text)return;const payload={text,originalText:text,mode:state.mode,batchId:makeId('turn'),eventId:makeId('event'),userId:makeId('user'),createdAt:new Date().toISOString(),resolution:null,reuseEntry:false,skipFall:false};ui.input.value='';executeTurn(payload);
}
function undoLatest(){
  if(state.busy||state.pendingClarification||!state.batches.length)return;
  const b=state.batches.pop();state.entries=state.entries.filter(e=>e.batchId!==b.id);const undone=undoWorldTurn(state.world);state.world=undone.world;clearProof();rebuildWorld();addRipple(0,0,.34);showStatus(`Turn removed. ${undone.removedEvents.length} accepted event${undone.removedEvents.length===1?'':'s'} replayed out of the world.`,'');toast('Undo restored entity state and satellite activation, not only the text stack.');save();
}
function resetField(){
  if(state.busy)stopOperation();closeClarification();state.entries=instructionEntries.map(x=>({...x}));state.batches=[];state.world=createWorld();state.usageLog=[];state.lastGenerator='local-typed';state.ripples=[];clearProof();rebuildWorld();addRipple(0,0,.22);toggleDrawer(false);showStatus('A new pond has started with an empty typed event ledger.','');toast('State, events, proof, branches, and usage returned to zero.');save();
}
function runBrowserEvals(){
  const tests=[];const record=(name,fn)=>{try{fn();tests.push({name,passed:true})}catch(error){tests.push({name,passed:false,error:error.message})}};
  const seed={bird:{id:'bird',type:'actor',aliases:['bird'],attributes:{present:true,locationId:null,hunger:0,lastAction:null}},blueberry:{id:'blueberry',type:'resource',aliases:['blueberry','blueberries'],attributes:{present:true,quantity:1,ownerId:null,locationId:null,condition:'fresh'}}};
  const run=(world,text,extra={})=>processLocalTurn(world,{text,mode:'Stone',turnId:makeId('eval-turn'),eventId:makeId('eval-event'),idempotencyKey:makeId('eval-request'),sourceStratumId:makeId('eval-stratum'),createdAt:new Date().toISOString(),...extra});
  record('Seeded persistence',()=>{let w=createWorld({seedEntities:seed});const a=run(w,'The bird eats the last blueberry.');if(a.status!=='accepted')throw Error('consume rejected');w=a.world;const q=run(w,'What food remains?');if(q.status!=='accepted'||q.world.entities.blueberry.attributes.quantity!==0||!q.relevantEvents.some(e=>e.id===a.event.id))throw Error('absence did not return')});
  record('Undo restores seed',()=>{let w=createWorld({seedEntities:seed});w=run(w,'The bird eats the last blueberry.').world;w=undoWorldTurn(w).world;if(w.entities.blueberry.attributes.quantity!==1)throw Error('seed not restored')});
  record('Ambiguous pronoun waits',()=>{const w=createWorld({seedEntities:{...seed,fox:{id:'fox',type:'actor',aliases:['fox'],attributes:{present:true,locationId:null,hunger:0,lastAction:null}}}});const r=run(w,'It eats the blueberry.');if(r.status!=='needs_clarification')throw Error('ambiguity committed')});
  record('Negation preserves resource',()=>{const r=run(createWorld({seedEntities:seed}),'The bird does not eat the blueberry.');if(r.world.entities.blueberry.attributes.quantity!==1)throw Error('negation consumed')});
  record('Unknown poetry waits',()=>{const r=run(createWorld(),'Moonlight folds the river.');if(r.status!=='needs_clarification')throw Error('unknown became truth')});
  state.evalReport={generatedAt:new Date().toISOString(),passed:tests.filter(t=>t.passed).length,total:tests.length,tests};ui.evalStatus.textContent=`${state.evalReport.passed}/${state.evalReport.total}`;ui.evalStatus.className=`value ${state.evalReport.passed===state.evalReport.total?'eval-pass':'eval-fail'}`;toast(state.evalReport.passed===state.evalReport.total?'All browser foundation checks passed.':'A browser foundation check failed.');return state.evalReport;
}

// ---------- UI ----------
function showStatus(text,kind=''){ui.status.textContent=text;ui.status.className='status show '+kind;clearTimeout(showStatus.t);showStatus.t=setTimeout(()=>ui.status.classList.remove('show'),kind==='busy'?5000:3200)}
function toast(text){const e=document.createElement('div');e.className='toast';e.textContent=text;ui.toasts.appendChild(e);setTimeout(()=>{e.style.opacity=0;e.style.transform='translateY(-5px)'},2800);setTimeout(()=>e.remove(),3300)}
function setMode(mode){state.mode=mode;ui.modeName.textContent=mode;ui.modeMenu.classList.remove('open');ui.modeBtn.setAttribute('aria-expanded','false');save();showStatus(`${mode} mask selected.`,'')}
function toggleDrawer(open){ui.drawer.classList.toggle('open',open);ui.backdrop.classList.toggle('open',open);ui.drawer.setAttribute('aria-hidden',String(!open))}
function updateToggles(){ui.orbit.querySelector('.value').textContent=state.orbit?'On':'Off';ui.reflect.querySelector('.value').textContent=state.reflect?'On':'Off';ui.satellites.querySelector('.value').textContent=state.showSatellites?'On':'Off';ui.remember.querySelector('.value').textContent=state.remember?'On':'Off';ui.modeName.textContent=state.mode;updateAIStatus()}
function speak(text){if(!('speechSynthesis'in window)||!text)return;window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.rate=.88;u.pitch=.92;window.speechSynthesis.speak(u)}
function enterReading(){state.reading=true;ui.reading.classList.add('open');document.querySelector('#ui').style.opacity='.14';showStatus('Reading mode. The stack remains the text.','');const e=[...state.entries].reverse().find(x=>x.role!=='instruction');if(e)speak(e.text)}
function exitReading(){state.reading=false;ui.reading.classList.remove('open');document.querySelector('#ui').style.opacity='';window.speechSynthesis?.cancel?.()}
function exportRecord(){const blob=new Blob([JSON.stringify({title:'Poetry Pond — Typed Ripple V3',exportedAt:new Date().toISOString(),models:{sol:state.solModel,luna:state.lunaModel,policy:state.aiPolicy},instructions:instructionEntries,world:state.world,exchanges:state.batches,strata:state.entries,apiUsage:state.usageLog,evalReport:state.evalReport},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='poetry-pond-typed-ripple-v3.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('Strata, authoritative state, causal edges, proof, evals, and API usage exported.')}

ui.input.addEventListener('input',()=>ui.send.disabled=!state.busy&&!state.pendingClarification&&!ui.input.value.trim());
ui.input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!ui.send.disabled)submitLine()}if(e.key==='Escape')ui.modeMenu.classList.remove('open')});
ui.send.addEventListener('click',submitLine);ui.undo.addEventListener('click',undoLatest);ui.read.addEventListener('click',enterReading);ui.exitReading.addEventListener('click',exitReading);ui.closeProof?.addEventListener('click',clearProof);ui.runEvals?.addEventListener('click',runBrowserEvals);
ui.modeBtn.addEventListener('click',()=>{const open=!ui.modeMenu.classList.contains('open');ui.modeMenu.classList.toggle('open',open);ui.modeBtn.setAttribute('aria-expanded',String(open))});
document.querySelectorAll('.mode-option').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
ui.menu.addEventListener('click',()=>toggleDrawer(true));ui.close.addEventListener('click',()=>toggleDrawer(false));ui.backdrop.addEventListener('click',()=>toggleDrawer(false));
ui.orbit.addEventListener('click',()=>{state.orbit=!state.orbit;updateToggles();save()});ui.reflect.addEventListener('click',()=>{state.reflect=!state.reflect;updateToggles();save()});ui.satellites.addEventListener('click',()=>{state.showSatellites=!state.showSatellites;rebuildWorld();updateToggles();save()});
ui.speak.addEventListener('click',()=>{const e=state.entries[state.entries.length-1];if(e)speak(e.text)});ui.remember.addEventListener('click',()=>{state.remember=!state.remember;updateToggles();save();toast(state.remember?'This browser will remember the event ledger, entity state, strata, and API usage.':'The pond will start from an empty ledger after reload.')});
ui.aiToggle.addEventListener('click',()=>{state.aiEnabled=!state.aiEnabled;updateToggles();save();toast(state.aiEnabled?(state.aiAvailable?'Dual-model OpenAI routing enabled.':'OpenAI enabled; the typed browser engine remains active until the server is ready.'):'OpenAI disabled; server and browser validation remain authoritative.')});
ui.aiPolicy?.addEventListener('click',()=>{const order=['efficient','deep','luna'];state.aiPolicy=order[(order.indexOf(state.aiPolicy)+1)%order.length];updateToggles();save();toast(state.aiPolicy==='efficient'?'Efficient routing: local first, Luna routine, Sol only when needed.':state.aiPolicy==='deep'?'Deep routing: Sol reviews complex causality, Luna renders.':'Luna routing: lowest-cost API path without Sol escalation.');});ui.export.addEventListener('click',exportRecord);ui.reset.addEventListener('click',resetField);ui.resetCamera.addEventListener('click',resetCamera);
addEventListener('keydown',e=>{if(e.key==='Escape'){if(ui.drawer.classList.contains('open'))toggleDrawer(false);else if(state.reading)exitReading();else ui.modeMenu.classList.remove('open')}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undoLatest()}});
updateToggles();updateMeta();checkAIStatus();
showStatus('The pond is undisturbed. Ambiguous stones will wait rather than become false history.','');

}
main();
