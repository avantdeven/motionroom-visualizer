const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const canvas = $('#visualizerCanvas');
const ctx = canvas.getContext('2d');
const audio = $('#audio');
const palette = ['#15f5d1', '#ff2f92', '#695cff'];
const availableFonts = ['Manrope','DM Mono','Impact','Arial Black','Georgia','Times New Roman','Courier New','Helvetica','Futura','Avenir','Garamond','Baskerville'];
const state = {
  playing: false, reference: null, customFigure: null, influence: .45, motion: .68, seed: 12,
  referenceAffects: { texture: true, color: true, font: true, wave: true, core: true },
  elements: { particles: true, rings: true, grid: true, grain: true, pulse: true },
  title: 'NIGHT SHIFT', subtitle: 'A NEW FREQUENCY', ratio: '16:9',
  figure: 'portal', figureScale: .52, warp: .38,
  lighting: 'laser', lightIntensity: .72, bloom: .64, beamAngle: 28,
  font: 'Manrope', fontWeight: 600, textAlign: 'center', tracking: .3,
  neonColor: '#15f5d1', neonIntensity: .72, neonSpread: .56, neonMode: 'solid',
  transientPunch: .78,
  waveStyle: 'smooth', waveRadius: .68, waveWeight: .45
};
let audioContext, analyser, source, mediaDest, dataArray, frequencyArray, objectUrl, loadedAudioFile;
let recorder, chunks = [], recording = false;
let exportTimer = null, exportTarget = 0;
let bassFloor = .08, beatPulse = 0, lastBeatAt = 0, transientFloor = .025, transientPulse = 0, lastTransientAt = 0;
let previousSpectrum = new Uint8Array(256);
let wordStyles = [], selectedWord = 0;
let offlineRendering = false, exportCancelRequested = false;
let autosaveTimer = null, restoringProject = false, referenceFiles = [], referenceItems = [], coreImageFile = null, uploadedFontFiles = [];
const PROJECT_KEY = 'motionroom:last-project:v2', PRESET_KEY = 'motionroom:presets:v1', DB_NAME = 'motionroom-projects';
const particles = Array.from({length: 90}, (_, i) => ({
  x: seeded(i * 3.7), y: seeded(i * 7.9), z: .2 + seeded(i * 11.2) * .8, s: .5 + seeded(i * 4.3) * 2
}));

function seeded(n) { return Math.abs(Math.sin(n + state.seed) * 43758.5453) % 1; }
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n>>16)&255,(n>>8)&255,n&255]; }
function rgba(hex, a) { return `rgba(${hexToRgb(hex).join(',')},${a})`; }
function formatTime(t) { if (!Number.isFinite(t)) return '00:00'; return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`; }
function defaultWordStyle(){return{font:state.font,color:'#ecfaff',weight:state.fontWeight,size:1,x:0,y:0,rotate:0,tracking:state.tracking,neon:1}}
function syncWords(){const words=(state.title||'UNTITLED').trim().split(/\s+/).filter(Boolean);wordStyles=words.map((_,i)=>wordStyles[i]||defaultWordStyle());selectedWord=Math.min(selectedWord,Math.max(0,words.length-1));renderWordTabs();syncWordControls()}
function populateWordFonts(){const select=$('#wordFont');const current=select?.value;if(!select)return;select.innerHTML='';availableFonts.forEach(font=>{const option=document.createElement('option');option.value=font;option.textContent=font.toUpperCase();select.append(option)});select.value=availableFonts.includes(current)?current:(wordStyles[selectedWord]?.font||state.font)}
function renderWordTabs(){const tabs=$('#wordTabs');if(!tabs)return;tabs.innerHTML='';(state.title||'UNTITLED').trim().split(/\s+/).filter(Boolean).forEach((word,i)=>{const button=document.createElement('button');button.type='button';button.textContent=word;button.classList.toggle('active',i===selectedWord);button.addEventListener('click',()=>{selectedWord=i;renderWordTabs();syncWordControls()});tabs.append(button)})}
function syncWordControls(){const s=wordStyles[selectedWord];if(!s)return;if(s.neon==null)s.neon=1;populateWordFonts();$('#wordFont').value=s.font;$('#wordColor').value=s.color;$('#wordWeight').value=String(s.weight);const values=[['wordSize',s.size*100,'wordSizeValue',Math.round(s.size*100)+'%'],['wordX',s.x,'wordXValue',s.x],['wordY',s.y,'wordYValue',s.y],['wordRotate',s.rotate,'wordRotateValue',s.rotate+'°'],['wordTracking',s.tracking*100,'wordTrackingValue',Math.round(s.tracking*100)+'%'],['wordNeon',s.neon*100,'wordNeonValue',Math.round(s.neon*100)+'%']];values.forEach(([id,value,out,label])=>{const el=$('#'+id);el.value=value;$('#'+out).textContent=label;updateRange(el)})}
function addAvailableFont(font){if(!availableFonts.includes(font))availableFonts.push(font);const global=$('#fontSelect');if(global&&![...global.options].some(o=>o.value===font)){const option=document.createElement('option');option.value=font;option.textContent=font.toUpperCase();global.insertBefore(option,global.querySelector('option[value="custom"]'))}populateWordFonts()}

function projectSnapshot(){
  return{version:2,state:{...state,playing:false,reference:null,customFigure:null},palette:[...palette],wordStyles:wordStyles.map(style=>({...style}))};
}
function scheduleAutosave(){
  if(restoringProject)return;
  $('#saveState').textContent='SAVING…';clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>{try{localStorage.setItem(PROJECT_KEY,JSON.stringify(projectSnapshot()));$('#saveState').textContent='AUTO-SAVED'}catch{$('#saveState').textContent='SAVE LIMITED'}},250);
}
function openProjectDB(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>request.result.createObjectStore('assets');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}
async function storeAsset(key,value){try{const db=await openProjectDB();await new Promise((resolve,reject)=>{const tx=db.transaction('assets','readwrite');tx.objectStore('assets').put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()}catch{}}
async function readAsset(key){try{const db=await openProjectDB(),value=await new Promise((resolve,reject)=>{const request=db.transaction('assets').objectStore('assets').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});db.close();return value}catch{return null}}
function syncProjectUI(){
  $('#titleInput').value=state.title;$('#subtitleInput').value=state.subtitle;$('#figureShape').value=state.figure;$('#lightingMode').value=state.lighting;$('#fontSelect').value=[...$('#fontSelect').options].some(o=>o.value===state.font)?state.font:'Manrope';$('#fontWeight').value=String(state.fontWeight);$('#textAlign').value=state.textAlign;$('#waveStyle').value=state.waveStyle;$('#neonColor').value=state.neonColor;$('#neonMode').value=state.neonMode;
  const ranges=[['influence',state.influence*100,'influenceValue'],['motion',state.motion*100,'motionValue'],['waveRadius',state.waveRadius*100,'waveRadiusValue'],['waveWeight',state.waveWeight*100,'waveWeightValue'],['figureScale',state.figureScale*100,'figureScaleValue'],['warp',state.warp*100,'warpValue'],['transientPunch',state.transientPunch*100,'transientPunchValue'],['lightIntensity',state.lightIntensity*100,'lightValue'],['bloom',state.bloom*100,'bloomValue'],['tracking',state.tracking*100,'trackingValue'],['neonIntensity',state.neonIntensity*100,'neonIntensityValue'],['neonSpread',state.neonSpread*100,'neonSpreadValue']];
  ranges.forEach(([id,value,out])=>{const el=$('#'+id),rounded=Math.round(value);el.value=rounded;$('#'+out).textContent=rounded+'%';updateRange(el)});$('#beamAngle').value=state.beamAngle;$('#beamValue').textContent=state.beamAngle+'°';updateRange($('#beamAngle'));
  $$('[data-element]').forEach(el=>el.checked=state.elements[el.dataset.element]!==false);$$('[data-reference-affect]').forEach(el=>el.checked=state.referenceAffects?.[el.dataset.referenceAffect]!==false);syncWords();
}
function loadSavedProject(){
  try{const saved=JSON.parse(localStorage.getItem(PROJECT_KEY));if(!saved?.state)return;restoringProject=true;Object.assign(state,saved.state,{playing:false,reference:null,customFigure:null});if(saved.palette?.length===3)saved.palette.forEach((color,i)=>setPalette(i,color));wordStyles=Array.isArray(saved.wordStyles)?saved.wordStyles.map(style=>({...defaultWordStyle(),...style})):[];syncProjectUI();$('#saveState').textContent='PROJECT RESTORED'}catch{$('#saveState').textContent='NEW PROJECT'}finally{restoringProject=false}
}
async function restoreProjectAssets(){
  const [savedAudio,savedReferences,savedCore,savedFonts]=await Promise.all([readAsset('audio'),readAsset('references'),readAsset('core'),readAsset('fonts')]);
  if(savedAudio)loadAudio(savedAudio,false);if(Array.isArray(savedReferences)){referenceFiles=[...savedReferences];savedReferences.forEach(file=>loadReference(file,false,false))}if(savedCore)loadCoreImage(savedCore,false,false);if(Array.isArray(savedFonts)){uploadedFontFiles=[...savedFonts];await loadFontFiles(savedFonts,false);if(availableFonts.includes(state.font)){$('#fontSelect').value=state.font;populateWordFonts()}}
}
function getPresets(){try{return JSON.parse(localStorage.getItem(PRESET_KEY))||[]}catch{return[]}}
function refreshPresets(selected=''){const presets=getPresets(),select=$('#presetSelect');select.innerHTML='';if(!presets.length){select.add(new Option('NO PRESETS YET',''));return}presets.forEach(preset=>select.add(new Option(preset.name,preset.id)));select.value=selected||presets[0].id}
function saveNamedPreset(){const name=$('#presetName').value.trim();if(!name){$('#presetName').focus();return}const presets=getPresets(),existing=presets.find(p=>p.name.toLowerCase()===name.toLowerCase()),preset={id:existing?.id||String(Date.now()),name,...projectSnapshot()};const next=existing?presets.map(p=>p.id===existing.id?preset:p):[...presets,preset];localStorage.setItem(PRESET_KEY,JSON.stringify(next));refreshPresets(preset.id);$('#presetName').value='';$('#saveState').textContent='PRESET SAVED'}
function loadNamedPreset(){const preset=getPresets().find(p=>p.id===$('#presetSelect').value);if(!preset)return;restoringProject=true;Object.assign(state,preset.state,{playing:false,reference:state.reference,customFigure:state.customFigure});preset.palette.forEach((color,i)=>setPalette(i,color));wordStyles=preset.wordStyles.map(style=>({...defaultWordStyle(),...style}));syncProjectUI();restoringProject=false;scheduleAutosave();$('#saveState').textContent='PRESET LOADED'}
function deleteNamedPreset(){const id=$('#presetSelect').value;if(!id)return;localStorage.setItem(PRESET_KEY,JSON.stringify(getPresets().filter(p=>p.id!==id)));refreshPresets();$('#saveState').textContent='PRESET DELETED'}

function setupAudio() {
  if (audioContext) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = .83;
  source = audioContext.createMediaElementSource(audio);
  mediaDest = audioContext.createMediaStreamDestination();
  source.connect(analyser); analyser.connect(audioContext.destination); analyser.connect(mediaDest);
  dataArray = new Uint8Array(analyser.fftSize); frequencyArray = new Uint8Array(analyser.frequencyBinCount);
}

function loadAudio(file,persist=true) {
  if (!file?.type.startsWith('audio/')) return;
  loadedAudioFile=file;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file); audio.src = objectUrl; setupAudio();
  $('#trackName').textContent = file.name; $('#trackMeta').textContent = `${(file.size/1048576).toFixed(1)} MB · READY`;
  $('#audioDropzone').classList.add('hidden'); $('#trackChip').classList.remove('hidden');
  $('#exportNote').textContent = 'Ready to play and record your visual.'; $('#exportNote').classList.remove('error');
  if(persist)storeAsset('audio',file);scheduleAutosave();
}

function loadReference(file,persist=true,apply=true) {
  if (!file?.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file); const img = new Image();
  const id=`ref-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  img.onload = () => {
    referenceItems.push({id,file,img,url});
    if(referenceItems.length>4){const removed=referenceItems.shift();URL.revokeObjectURL(removed.url)}
    referenceFiles=referenceItems.map(item=>item.file);state.reference=img;renderReferenceList();if(apply)applyReferenceInfluence(img);
    if(persist)storeAsset('references',referenceFiles);scheduleAutosave();
  };
  img.src = url;
}

function renderReferenceList(){
  const list=$('#referenceList');list.innerHTML='';
  referenceItems.forEach(item=>{const wrap=document.createElement('div');wrap.className='reference-item';const thumb=document.createElement('img');thumb.src=item.url;thumb.className='reference-thumb';thumb.alt=item.file.name;const remove=document.createElement('button');remove.type='button';remove.className='reference-remove';remove.textContent='×';remove.setAttribute('aria-label',`Remove ${item.file.name}`);remove.addEventListener('click',()=>removeReference(item.id));wrap.append(thumb,remove);list.append(wrap)});
}
function removeReference(id){
  const removed=referenceItems.find(item=>item.id===id);if(removed)URL.revokeObjectURL(removed.url);referenceItems=referenceItems.filter(item=>item.id!==id);referenceFiles=referenceItems.map(item=>item.file);state.reference=referenceItems.at(-1)?.img||null;renderReferenceList();storeAsset('references',referenceFiles);scheduleAutosave();$('#exportNote').textContent=referenceItems.length?'Reference removed. Remaining influences stay editable.':'All reference influence removed.';
}
function clearReferences(){
  referenceItems.forEach(item=>URL.revokeObjectURL(item.url));referenceItems=[];referenceFiles=[];state.reference=null;renderReferenceList();storeAsset('references',[]);scheduleAutosave();$('#exportNote').textContent='All reference images and texture influence removed.';
}

function loadCoreImage(file,persist=true,activate=true){
  if(!file?.type.startsWith('image/'))return;
  const url=URL.createObjectURL(file),img=new Image();
  img.onload=()=>{state.customFigure=img;if(activate){state.figure='image';$('#figureShape').value='image'}$('#coreImageLabel strong').textContent=file.name.toUpperCase();};
  img.src=url;
  coreImageFile=file;if(persist)storeAsset('core',file);scheduleAutosave();
}

async function loadFontFiles(files,persist=true){let lastFont='';for(const file of files){try{const family=file.name.replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9 _-]/g,'').trim()||('UserFont'+Date.now());const face=new FontFace(family,`url(${URL.createObjectURL(file)})`);await face.load();document.fonts.add(face);addAvailableFont(family);lastFont=family}catch{$('#exportNote').textContent=`${file.name} could not be loaded.`;$('#exportNote').classList.add('error')}}if(persist){uploadedFontFiles=[...files];storeAsset('fonts',uploadedFontFiles)}return lastFont}

function analyzeReference(img) {
  const c = document.createElement('canvas'); c.width = c.height = 24; const x = c.getContext('2d');
  x.drawImage(img,0,0,24,24); const d = x.getImageData(0,0,24,24).data;
  const samples=[[0,0,0,0],[0,0,0,0],[0,0,0,0]];let lumSum=0,lumSq=0,satSum=0,edges=0,count=0;
  for(let p=0;p<d.length;p+=4){const r=d[p],g=d[p+1],b=d[p+2],max=Math.max(r,g,b),min=Math.min(r,g,b),lum=(r+g+b)/3,band=lum<85?0:lum<170?1:2;samples[band][0]+=r;samples[band][1]+=g;samples[band][2]+=b;samples[band][3]++;lumSum+=lum;lumSq+=lum*lum;satSum+=max?((max-min)/max):0;if(p>=96)edges+=Math.abs(lum-((d[p-96]+d[p-95]+d[p-94])/3));count++}
  const colors=samples.map((s,i)=>s[3]?'#'+s.slice(0,3).map(n=>Math.round(n/s[3]).toString(16).padStart(2,'0')).join(''):palette[i]),mean=lumSum/count;
  return{colors,saturation:satSum/count,contrast:Math.min(1,Math.sqrt(Math.max(0,lumSq/count-mean*mean))/82),edges:Math.min(1,edges/count/65),brightness:mean/255};
}
function blendHex(a,b,mix){const aa=hexToRgb(a),bb=hexToRgb(b);return'#'+aa.map((v,i)=>Math.round(v+(bb[i]-v)*mix).toString(16).padStart(2,'0')).join('')}
function applyReferenceInfluence(img=state.reference){
  if(!img)return;const analysis=analyzeReference(img),mix=Math.max(0,Math.min(1,state.influence)),affects=state.referenceAffects;
  if(affects.color)analysis.colors.forEach((color,i)=>setPalette(i,blendHex(palette[i],color,mix)));
  if(affects.font){const font=analysis.edges>.62?'DM Mono':analysis.contrast>.58?'Impact':analysis.brightness>.62?'Georgia':'Manrope';state.font=font;addAvailableFont(font);wordStyles.forEach(style=>style.font=font);$('#fontSelect').value=font;syncWordControls()}
  if(affects.wave){const waves=['smooth','ribbon','dots','crown','helix','petals','shards','electric','tunnel'],index=Math.min(waves.length-1,Math.floor((analysis.edges*.46+analysis.saturation*.34+analysis.contrast*.2)*waves.length));state.waveStyle=waves[index];$('#waveStyle').value=state.waveStyle}
  if(affects.core){const figures=['portal','orb','diamond','hex','eye','star','spire','cross','monolith'],index=Math.min(figures.length-1,Math.floor((analysis.contrast*.45+analysis.edges*.35+(1-analysis.brightness)*.2)*figures.length));state.figure=figures[index];$('#figureShape').value=state.figure}
  scheduleAutosave();$('#exportNote').textContent='Reference influence applied. Every generated choice remains manually editable.';
}
function setPalette(i, color) { palette[i]=color; const el=$(`[data-color="${i}"]`); el.value=color; el.nextElementSibling.textContent=color.toUpperCase(); document.documentElement.style.setProperty(['--acid','--pink','--violet'][i],color); }

function getAudioData(t) {
  if (!dataArray) { dataArray=new Uint8Array(512); frequencyArray=new Uint8Array(256); dataArray.fill(128); }
  if (analyser && !audio.paused && !audio.ended) { analyser.getByteTimeDomainData(dataArray); analyser.getByteFrequencyData(frequencyArray); }
  else { dataArray.fill(128); frequencyArray.fill(0); beatPulse=0; transientPulse=0; previousSpectrum.fill(0); }
  let bass=0,mid=0; for(let i=0;i<24;i++)bass+=frequencyArray[i]||0; for(let i=24;i<100;i++)mid+=frequencyArray[i]||0;
  const bassLevel=bass/(24*255),midLevel=mid/(76*255);bassFloor=bassFloor*.94+bassLevel*.06;
  if(!audio.paused&&bassLevel>Math.max(.13,bassFloor*1.28)&&t-lastBeatAt>105){beatPulse=1;lastBeatAt=t}
  let flux=0;for(let i=2;i<150;i++){const current=(frequencyArray[i]||0)/255;const previous=(previousSpectrum[i]||0)/255;flux+=Math.max(0,current-previous);previousSpectrum[i]=frequencyArray[i]||0}flux/=148;
  transientFloor=transientFloor*.94+flux*.06;
  if(!audio.paused&&flux>Math.max(.018,transientFloor*(1.35+(1-state.transientPunch)*.75))&&t-lastTransientAt>70){transientPulse=Math.min(1,flux*11+.38);lastTransientAt=t}
  beatPulse*=.86;
  transientPulse*=.79;
  return {bass:bassLevel,mid:midLevel,beat:beatPulse,transient:transientPulse};
}

function drawLighting(w,h,cx,cy,energy,t){
  const intensity=state.lightIntensity*(.55+energy*.8), angle=state.beamAngle*Math.PI/180;
  ctx.save();ctx.globalCompositeOperation='screen';
  if(state.lighting==='laser'){
    ctx.translate(cx,cy);ctx.rotate(angle);for(let i=-3;i<=3;i++){const g=ctx.createLinearGradient(0,-h,0,h);g.addColorStop(0,'transparent');g.addColorStop(.5,rgba(palette[Math.abs(i)%3],.12*intensity));g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.fillRect(i*w*.075,-h,w*.008+energy*5,h*2)}
  }else if(state.lighting==='volumetric'){
    ctx.translate(cx,0);for(let i=-4;i<=4;i++){ctx.beginPath();ctx.moveTo(i*w*.06,0);ctx.lineTo(i*w*.2+w*.11,h);ctx.lineTo(i*w*.2-w*.11,h);ctx.closePath();const g=ctx.createLinearGradient(0,0,0,h);g.addColorStop(0,rgba(palette[(i+6)%3],.24*intensity));g.addColorStop(1,'transparent');ctx.fillStyle=g;ctx.fill()}
  }else if(state.lighting==='strobe'){
    const flash=Math.pow(energy,3)*intensity;ctx.fillStyle=rgba(palette[0],flash*.38);ctx.fillRect(0,0,w,h);for(let y=0;y<h;y+=h*.08){ctx.fillStyle=rgba(palette[1],flash*.12);ctx.fillRect(0,y,w,h*.015)}
  }else if(state.lighting==='halo'){
    for(let i=4;i>0;i--){ctx.strokeStyle=rgba(palette[i%3],intensity*.08);ctx.lineWidth=i*14*state.bloom;ctx.beginPath();ctx.arc(cx,cy,Math.min(w,h)*(.12+i*.055)+energy*30,0,Math.PI*2);ctx.stroke()}
  }else{
    const g=ctx.createLinearGradient(0,0,w,h);g.addColorStop(0,rgba(palette[2],.2*intensity));g.addColorStop(.48,'transparent');g.addColorStop(1,rgba(palette[1],.18*intensity));ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
  }ctx.restore();
}

function drawFigure(w,h,cx,cy,energy,beat,transient,t){
  if(!state.elements.pulse)return;const kick=beat*beat,hit=Math.min(1,Math.max(kick,transient*state.transientPunch));const size=Math.min(w,h)*state.figureScale*(.72+energy*.2+kick*.18+hit*.28),warp=state.warp,rot=t*.00015*state.motion;
  const flash=ctx.createRadialGradient(cx,cy,0,cx,cy,size*(.7+hit*.7));flash.addColorStop(0,rgba(palette[0],hit*.38));flash.addColorStop(.32,rgba(palette[1],hit*.16));flash.addColorStop(1,'transparent');ctx.fillStyle=flash;ctx.fillRect(cx-size,cy-size,size*2,size*2);
  ctx.save();ctx.translate(cx,cy);ctx.rotate(rot+hit*.035);ctx.globalCompositeOperation='screen';ctx.lineWidth=2+energy*3+hit*6;ctx.strokeStyle=palette[0];ctx.fillStyle=rgba(palette[2],.07+energy*.09+hit*.15);ctx.shadowBlur=10+state.bloom*45+hit*70;ctx.shadowColor=palette[0];ctx.beginPath();
  if(state.figure==='image'&&state.customFigure){const img=state.customFigure,aspect=img.width/img.height;let iw=size*.9,ih=size*.9;if(aspect>1)ih=iw/aspect;else iw=ih*aspect;ctx.globalAlpha=.82+hit*.18;ctx.filter=`saturate(${1.15+energy*.8}) contrast(${1.08+hit*.35})`;ctx.drawImage(img,-iw/2,-ih/2,iw,ih);ctx.filter='none';ctx.globalAlpha=.65;ctx.strokeRect(-iw/2,-ih/2,iw,ih);ctx.restore();return}
  if(state.figure==='diamond'){ctx.moveTo(0,-size*.55);ctx.lineTo(size*(.33+warp*.18),0);ctx.lineTo(0,size*.55);ctx.lineTo(-size*(.33+warp*.18),0);ctx.closePath()}
  else if(state.figure==='monolith'){const sw=size*(.22+warp*.12);ctx.rect(-sw/2,-size*.55,sw,size*1.1)}
  else if(state.figure==='orb'){const points=48;for(let i=0;i<=points;i++){const a=i/points*Math.PI*2,r=size*.38*(1+Math.sin(a*6+t*.002)*warp*.12);const x=Math.cos(a)*r,y=Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath()}
  else if(state.figure==='spire'){ctx.moveTo(0,-size*.65);ctx.lineTo(size*.24, size*.38);ctx.lineTo(0,size*.25);ctx.lineTo(-size*.24,size*.38);ctx.closePath()}
  else if(state.figure==='star'){for(let i=0;i<20;i++){const a=-Math.PI/2+i*Math.PI/10,r=i%2?size*(.18+warp*.1):size*.55;i?ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r):ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r)}ctx.closePath()}
  else if(state.figure==='hex'){for(let i=0;i<6;i++){const a=-Math.PI/2+i*Math.PI/3,r=size*(.42+warp*.08);i?ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r):ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r)}ctx.closePath()}
  else if(state.figure==='eye'){ctx.moveTo(-size*.5,0);ctx.quadraticCurveTo(0,-size*(.42+warp*.12),size*.5,0);ctx.quadraticCurveTo(0,size*(.42+warp*.12),-size*.5,0);ctx.closePath()}
  else if(state.figure==='cross'){const a=size*.14,b=size*.5;ctx.moveTo(-a,-b);ctx.lineTo(a,-b);ctx.lineTo(a,-a);ctx.lineTo(b,-a);ctx.lineTo(b,a);ctx.lineTo(a,a);ctx.lineTo(a,b);ctx.lineTo(-a,b);ctx.lineTo(-a,a);ctx.lineTo(-b,a);ctx.lineTo(-b,-a);ctx.lineTo(-a,-a);ctx.closePath()}
  else{ctx.ellipse(0,0,size*.42*(1+warp*.15),size*.42*(1-warp*.12),0,0,Math.PI*2)}
  ctx.fill();ctx.stroke();ctx.rotate(-rot*2);ctx.strokeStyle=rgba(palette[1],.65);ctx.lineWidth=1;ctx.beginPath();if(state.figure==='portal'||state.figure==='orb')ctx.ellipse(0,0,size*.51,size*.31,0,0,Math.PI*2);else{ctx.moveTo(-size*.5,0);ctx.lineTo(size*.5,0);ctx.moveTo(0,-size*.55);ctx.lineTo(0,size*.55)}ctx.stroke();ctx.restore();
}

function drawCoreWave(w,h,cx,cy,energy,t){
  const active=offlineRendering||(!audio.paused&&!audio.ended),points=state.waveStyle==='glitch'?96:180;
  const base=Math.min(w,h)*state.figureScale*(.42+state.waveRadius*.36),strength=Math.min(w,h)*(.025+energy*.075),weight=1+state.waveWeight*5;
  const sample=i=>active?(dataArray[Math.floor(i/(points-1)*(dataArray.length-1))]-128)/128:0;
  const point=(i,extra=0)=>{const a=i/points*Math.PI*2-(active?t*.00008*state.motion:0),r=base+sample(i)*strength+extra;return{x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r,a,r}};
  const wg=ctx.createLinearGradient(cx-base,cy-base,cx+base,cy+base);wg.addColorStop(0,palette[0]);wg.addColorStop(.45,palette[2]);wg.addColorStop(.75,palette[1]);wg.addColorStop(1,palette[0]);
  ctx.save();ctx.globalCompositeOperation='screen';ctx.strokeStyle=wg;ctx.fillStyle=wg;ctx.shadowBlur=active?8+state.bloom*30:5;ctx.shadowColor=palette[0];ctx.lineWidth=weight;
  if(state.waveStyle==='bars'){
    const bars=72;for(let i=0;i<bars;i++){const si=Math.floor(i/(bars-1)*(points-1)),v=Math.abs(sample(si)),a=i/bars*Math.PI*2-(active?t*.00008*state.motion:0),rest=active?0:weight*1.2,r1=base-v*strength*.25-rest,r2=base+v*strength*1.4+rest;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*r1,cy+Math.sin(a)*r1);ctx.lineTo(cx+Math.cos(a)*r2,cy+Math.sin(a)*r2);ctx.globalAlpha=active?.35+v*.65:.5;ctx.stroke()}ctx.globalAlpha=1;
  }else if(state.waveStyle==='dots'){
    const dots=96;for(let i=0;i<dots;i++){const si=Math.floor(i/(dots-1)*(points-1)),p=point(si),v=Math.abs(sample(si));ctx.globalAlpha=.4+v*.6;ctx.beginPath();ctx.arc(p.x,p.y,1.3+state.waveWeight*2.5+v*3,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1;
  }else if(state.waveStyle==='crown'){
    const spikes=96;for(let i=0;i<spikes;i++){const si=Math.floor(i/spikes*(points-1)),v=Math.abs(sample(si)),a=i/spikes*Math.PI*2-(active?t*.0001*state.motion:0),boost=active?v*strength*1.75:weight*1.2,r1=base-boost*.16,r2=base+boost+weight*1.5;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*r1,cy+Math.sin(a)*r1);ctx.lineTo(cx+Math.cos(a)*r2,cy+Math.sin(a)*r2);ctx.globalAlpha=.3+v*.7;ctx.stroke()}ctx.globalAlpha=1;
  }else if(state.waveStyle==='helix'){
    for(let lane=0;lane<2;lane++){ctx.beginPath();for(let i=0;i<=points;i++){const ii=i%points,a=ii/points*Math.PI*2-(active?t*.00008*state.motion:0),phase=Math.sin(a*8+t*.003+lane*Math.PI),r=base+phase*(strength*.42+weight*2)+sample(ii)*strength*.45;const x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.globalAlpha=lane?.55:1;ctx.stroke()}ctx.globalAlpha=1;
  }else if(state.waveStyle==='petals'){
    ctx.beginPath();for(let i=0;i<=points;i++){const ii=i%points,a=ii/points*Math.PI*2-(active?t*.000045*state.motion:0),bloom=Math.abs(Math.sin(a*6))*strength*(active?.62:.18),r=base+bloom+sample(ii)*strength*.35;const x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath();ctx.stroke();ctx.globalAlpha=.12;ctx.lineWidth=weight*4;ctx.stroke();ctx.globalAlpha=1;
  }else if(state.waveStyle==='shards'){
    const shards=48;for(let i=0;i<shards;i++){const a=i/shards*Math.PI*2-(active?t*.00007*state.motion:0),next=(i+.72)/shards*Math.PI*2-(active?t*.00007*state.motion:0),v=Math.abs(sample(Math.floor(i/shards*(points-1)))),inner=base-weight*2,outer=base+(active?v*strength:0)+weight*2;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*inner,cy+Math.sin(a)*inner);ctx.lineTo(cx+Math.cos(a)*outer,cy+Math.sin(a)*outer);ctx.lineTo(cx+Math.cos(next)*(base+v*strength*.35),cy+Math.sin(next)*(base+v*strength*.35));ctx.closePath();ctx.globalAlpha=.18+v*.55;ctx.fill();ctx.stroke()}ctx.globalAlpha=1;
  }else if(state.waveStyle==='electric'){
    ctx.beginPath();for(let i=0;i<=120;i++){const ii=i%120,a=ii/120*Math.PI*2-(active?t*.00012*state.motion:0),jag=(i%3-1)*weight*2.4+sample(Math.floor(ii/119*(points-1)))*strength*1.2,r=base+jag;const x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath();ctx.stroke();ctx.globalAlpha=.2;ctx.lineWidth=weight*4.5;ctx.stroke();ctx.globalAlpha=1;
  }else if(state.waveStyle==='tunnel'){
    for(let ring=0;ring<5;ring++){ctx.beginPath();const offset=(ring-2)*weight*3.2;for(let i=0;i<=points;i++){const ii=i%points,a=ii/points*Math.PI*2-(active?t*.000045*(ring%2?1:-1)*state.motion:0),r=base+offset+sample(ii)*strength*(.25+ring*.12);const x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath();ctx.globalAlpha=.16+ring*.13;ctx.stroke()}ctx.globalAlpha=1;
  }else if(state.waveStyle==='ribbon'){
    ctx.beginPath();for(let i=0;i<=points;i++){const p=point(i%points,weight*1.8);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)}for(let i=points;i>=0;i--){const p=point(i%points,-weight*1.8);ctx.lineTo(p.x,p.y)}ctx.closePath();ctx.globalAlpha=.36;ctx.fill();ctx.globalAlpha=1;ctx.stroke();
  }else{
    ctx.beginPath();for(let i=0;i<=points;i++){let p=point(i%points);if(state.waveStyle==='glitch'&&i%6<3){const snap=Math.PI/24;p={x:cx+Math.cos(Math.round(p.a/snap)*snap)*p.r,y:cy+Math.sin(Math.round(p.a/snap)*snap)*p.r}}i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)}ctx.closePath();ctx.stroke();ctx.globalAlpha=.16;ctx.lineWidth=weight*3.5;ctx.stroke();
  }ctx.restore();
}

function drawTitleWords(w,h,energy){
  const words=(state.title||'UNTITLED').trim().split(/\s+/).filter(Boolean);if(wordStyles.length!==words.length)wordStyles=words.map((_,i)=>wordStyles[i]||defaultWordStyle());
  const baseSize=w*.063,space=w*.018;const widths=words.map((word,i)=>{const s=wordStyles[i];ctx.font=`${s.weight} ${Math.round(baseSize*s.size)}px "${s.font}"`;ctx.letterSpacing=`${w*(.001+s.tracking*.008)}px`;return ctx.measureText(word).width});const total=widths.reduce((a,b)=>a+b,0)+space*Math.max(0,words.length-1);
  let cursor=state.textAlign==='left'?w*.1:state.textAlign==='right'?w*.9-total:(w-total)/2;
  words.forEach((word,i)=>{const s=wordStyles[i],fontSize=Math.round(baseSize*s.size),x=cursor+widths[i]/2+w*s.x/100,y=h*.48+h*s.y/100,wordNeon=s.neon??1,audioBoost=state.neonMode==='pulse'?.5+energy*1.25:1,neon=state.neonIntensity*wordNeon*audioBoost,spread=state.neonSpread;ctx.save();ctx.translate(x,y);ctx.rotate(s.rotate*Math.PI/180);ctx.textAlign='center';ctx.font=`${s.weight} ${fontSize}px "${s.font}"`;ctx.letterSpacing=`${w*(.001+s.tracking*.008)}px`;if(neon>0){ctx.globalCompositeOperation='screen';ctx.fillStyle=state.neonColor;ctx.shadowColor=state.neonColor;ctx.globalAlpha=Math.min(.8,neon*.35);ctx.shadowBlur=(18+fontSize*.35)*spread*neon;ctx.fillText(word,0,0);if(state.neonMode==='split'){ctx.fillStyle=palette[1];ctx.shadowColor=palette[1];ctx.shadowBlur=(8+fontSize*.16)*spread*neon;ctx.fillText(word,Math.max(1,fontSize*.018),0)}}ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.fillStyle=s.color;ctx.shadowColor=state.neonColor;ctx.shadowBlur=(4+fontSize*.08)*spread*neon;ctx.fillText(word,0,0);ctx.restore();cursor+=widths[i]+space});
}

function draw(t,manual=false,snapshot=null) {
  if(offlineRendering&&!manual){requestAnimationFrame(draw);return}
  const w=canvas.width,h=canvas.height,cx=w/2,cy=h/2; const {bass,mid,beat,transient=beat}=snapshot||getAudioData(t); const energy=Math.min(1,bass*1.7+mid*.35);
  ctx.fillStyle='#070709';ctx.fillRect(0,0,w,h);
  if(state.reference&&state.referenceAffects.texture){ctx.save();ctx.globalAlpha=state.influence*.3;ctx.filter=`blur(${8+state.influence*16}px) saturate(1.5) contrast(1.1)`;const scale=Math.max(w/state.reference.width,h/state.reference.height);const iw=state.reference.width*scale,ih=state.reference.height*scale;ctx.drawImage(state.reference,(w-iw)/2,(h-ih)/2,iw,ih);ctx.restore();}
  const grad=ctx.createRadialGradient(cx,cy,0,cx,cy,w*.6);grad.addColorStop(0,rgba(palette[2],.18+energy*.12));grad.addColorStop(.4,rgba(palette[1],.07));grad.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=grad;ctx.fillRect(0,0,w,h);
  if(state.elements.grid){ctx.save();ctx.strokeStyle=rgba(palette[2],.14);ctx.lineWidth=1;const gap=Math.max(36,w/24),off=(t*.018*state.motion)%gap;for(let x=-gap+off;x<w;x+=gap){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}for(let y=-gap+off;y<h;y+=gap){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}ctx.restore();}
  drawLighting(w,h,cx,cy,energy,t);
  if(state.elements.rings){ctx.save();ctx.translate(cx,cy);ctx.rotate(t*.00008*state.motion);for(let i=0;i<4;i++){ctx.beginPath();ctx.ellipse(0,0,w*(.13+i*.075)+energy*30,h*(.17+i*.035)+energy*18,t*.00015*(i%2?1:-1),0,Math.PI*2);ctx.strokeStyle=rgba(palette[i%3],.1+i*.055);ctx.lineWidth=i===0?3:1;ctx.stroke()}ctx.restore();}
  drawFigure(w,h,cx,cy,energy,beat,transient,t);
  if(state.elements.particles){ctx.save();particles.forEach((p,i)=>{const drift=t*.00002*state.motion*(i%2?1:-1);const x=((p.x+drift)%1)*w,y=(p.y+Math.sin(t*.001+i)*.015)*h;ctx.fillStyle=rgba(palette[i%3],.25+p.z*.55);ctx.fillRect(x,y,p.s*(1+energy*2),p.s*(1+energy*2));});ctx.restore();}
  // Sound wave wraps the core and rests until audio plays.
  drawCoreWave(w,h,cx,cy,energy,t);
  drawTitleWords(w,h,energy);const textX=state.textAlign==='left'?w*.1:state.textAlign==='right'?w*.9:cx;ctx.shadowBlur=0;ctx.textAlign=state.textAlign;ctx.font=`400 ${Math.round(w*.011)}px 'DM Mono'`;ctx.letterSpacing=`${w*.006}px`;ctx.fillStyle='rgba(236,250,255,.65)';ctx.fillText(state.subtitle.toUpperCase(),textX,h*.54);
  ctx.font=`400 ${Math.round(w*.008)}px 'DM Mono'`;ctx.textAlign='left';ctx.fillStyle='rgba(246,244,239,.45)';ctx.fillText('MOTIONROOM / AUDIO SIGNAL',w*.045,h*.93);ctx.textAlign='right';ctx.fillText(`${String(Math.floor((audio.currentTime||t/1000)/60)).padStart(2,'0')}:${String(Math.floor((audio.currentTime||t/1000)%60)).padStart(2,'0')}`,w*.955,h*.93);
  if(state.elements.grain){ctx.save();ctx.globalAlpha=.055;for(let i=0;i<850;i++){const v=Math.random()>0.5?255:0;ctx.fillStyle=`rgb(${v},${v},${v})`;ctx.fillRect(Math.random()*w,Math.random()*h,1.5,1.5)}ctx.restore();}
  if(!manual)requestAnimationFrame(draw);
}

function randomizePalette(){const hue=Math.floor(Math.random()*360);[0,1,2].forEach((_,i)=>setPalette(i,hslToHex((hue+i*105)%360, i===0?92:78, i===0?60:63)));}
function hslToHex(h,s,l){s/=100;l/=100;const k=n=>(n+h/30)%12,a=s*Math.min(l,1-l),f=n=>l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1)));return '#'+[f(0),f(8),f(4)].map(x=>Math.round(255*x).toString(16).padStart(2,'0')).join('');}
function updateRange(el){const p=(el.value-el.min)/(el.max-el.min)*100;el.style.background=`linear-gradient(90deg,var(--acid) 0 ${p}%,#333 ${p}%)`;}

$('#audioInput').addEventListener('change',e=>loadAudio(e.target.files[0]));
$('#referenceInput').addEventListener('change',e=>[...e.target.files].forEach(loadReference));
$('#clearReferences').addEventListener('click',clearReferences);$('#applyReference').addEventListener('click',()=>applyReferenceInfluence());
$$('[data-reference-affect]').forEach(el=>el.addEventListener('change',e=>{state.referenceAffects[e.target.dataset.referenceAffect]=e.target.checked;scheduleAutosave()}));
$('#coreImageInput').addEventListener('change',e=>loadCoreImage(e.target.files[0]));
$('#savePreset').addEventListener('click',saveNamedPreset);$('#loadPreset').addEventListener('click',loadNamedPreset);$('#deletePreset').addEventListener('click',deleteNamedPreset);
$('#removeTrack').addEventListener('click',()=>{audio.pause();audio.removeAttribute('src');loadedAudioFile=null;storeAsset('audio',null);$('#audioDropzone').classList.remove('hidden');$('#trackChip').classList.add('hidden');scheduleAutosave()});
$('#playButton').addEventListener('click',async()=>{if(!audio.src){$('#audioInput').click();return}setupAudio();await audioContext.resume();audio.paused?audio.play():audio.pause();});
audio.addEventListener('play',()=>{$('#playButton').textContent='❚❚';state.playing=true});audio.addEventListener('pause',()=>{$('#playButton').textContent='▶';state.playing=false});
audio.addEventListener('loadedmetadata',()=>$('#duration').textContent=formatTime(audio.duration));audio.addEventListener('timeupdate',()=>{$('#currentTime').textContent=formatTime(audio.currentTime);$('#timeline').value=audio.duration?audio.currentTime/audio.duration*1000:0;updateRange($('#timeline'));});
$('#timeline').addEventListener('input',e=>{if(audio.duration)audio.currentTime=e.target.value/1000*audio.duration});$('#muteButton').addEventListener('click',()=>{audio.muted=!audio.muted;$('#muteButton').textContent=audio.muted?'×':'◖'});
$$('[data-color]').forEach(el=>el.addEventListener('input',e=>setPalette(+e.target.dataset.color,e.target.value)));$('#randomizePalette').addEventListener('click',randomizePalette);
$('#influence').addEventListener('input',e=>{state.influence=e.target.value/100;$('#influenceValue').textContent=e.target.value+'%';updateRange(e.target)});$('#motion').addEventListener('input',e=>{state.motion=e.target.value/100;$('#motionValue').textContent=e.target.value+'%';updateRange(e.target)});
$$('[data-element]').forEach(el=>el.addEventListener('change',e=>state.elements[e.target.dataset.element]=e.target.checked));
$('#titleInput').addEventListener('input',e=>{state.title=e.target.value.toUpperCase();syncWords()});$('#subtitleInput').addEventListener('input',e=>state.subtitle=e.target.value.toUpperCase());
$('#figureShape').addEventListener('change',e=>{if(e.target.value==='image'&&!state.customFigure){$('#coreImageInput').click();return}state.figure=e.target.value});
$('#lightingMode').addEventListener('change',e=>state.lighting=e.target.value);
[['figureScale','figureScaleValue','figureScale','%'],['warp','warpValue','warp','%'],['lightIntensity','lightValue','lightIntensity','%'],['bloom','bloomValue','bloom','%']].forEach(([id,out,key,suffix])=>{$('#'+id).addEventListener('input',e=>{state[key]=e.target.value/100;$('#'+out).textContent=e.target.value+suffix;updateRange(e.target)})});
$('#transientPunch').addEventListener('input',e=>{state.transientPunch=e.target.value/100;$('#transientPunchValue').textContent=e.target.value+'%';updateRange(e.target)});
$('#beamAngle').addEventListener('input',e=>{state.beamAngle=+e.target.value;$('#beamValue').textContent=e.target.value+'°';updateRange(e.target)});
$('#fontSelect').addEventListener('change',e=>{if(e.target.value==='custom'){$('#fontUploadLabel').classList.remove('hidden');$('#fontInput').click()}else{state.font=e.target.value;addAvailableFont(state.font);wordStyles.forEach(s=>s.font=state.font);syncWordControls();$('#fontUploadLabel').classList.add('hidden')}});
$('#fontInput').addEventListener('change',async e=>{const files=[...e.target.files];if(!files.length)return;const lastFont=await loadFontFiles(files);if(lastFont){state.font=lastFont;wordStyles.forEach(s=>s.font=lastFont);$('#fontSelect').value=lastFont;$('#fontUploadLabel').classList.add('hidden');syncWordControls();scheduleAutosave()}});
$('#applyFontFamily').addEventListener('click',()=>{const family=$('#fontFamilyInput').value.trim();if(!family)return;addAvailableFont(family);state.font=family;wordStyles.forEach(s=>s.font=family);syncWordControls();$('#exportNote').textContent=`Using ${family}. If it is installed, the browser will render it.`});
$('#fontWeight').addEventListener('change',e=>{state.fontWeight=+e.target.value;wordStyles.forEach(s=>s.weight=state.fontWeight);syncWordControls()});$('#textAlign').addEventListener('change',e=>state.textAlign=e.target.value);
$('#tracking').addEventListener('input',e=>{state.tracking=e.target.value/100;wordStyles.forEach(s=>s.tracking=state.tracking);$('#trackingValue').textContent=e.target.value+'%';updateRange(e.target);syncWordControls()});
$('#neonColor').addEventListener('input',e=>state.neonColor=e.target.value);$('#neonMode').addEventListener('change',e=>state.neonMode=e.target.value);
$('#neonIntensity').addEventListener('input',e=>{state.neonIntensity=e.target.value/100;$('#neonIntensityValue').textContent=e.target.value+'%';updateRange(e.target)});$('#neonSpread').addEventListener('input',e=>{state.neonSpread=e.target.value/100;$('#neonSpreadValue').textContent=e.target.value+'%';updateRange(e.target)});
$('#wordFont').addEventListener('change',e=>wordStyles[selectedWord].font=e.target.value);$('#wordColor').addEventListener('input',e=>wordStyles[selectedWord].color=e.target.value);$('#wordWeight').addEventListener('change',e=>wordStyles[selectedWord].weight=+e.target.value);
[['wordSize','size',100,'wordSizeValue','%'],['wordX','x',1,'wordXValue',''],['wordY','y',1,'wordYValue',''],['wordRotate','rotate',1,'wordRotateValue','°'],['wordTracking','tracking',100,'wordTrackingValue','%']].forEach(([id,key,div,out,suffix])=>{$('#'+id).addEventListener('input',e=>{wordStyles[selectedWord][key]=+e.target.value/div;$('#'+out).textContent=e.target.value+suffix;updateRange(e.target)})});
$('#wordNeon').addEventListener('input',e=>{wordStyles[selectedWord].neon=+e.target.value/100;$('#wordNeonValue').textContent=e.target.value+'%';updateRange(e.target)});
$('#waveStyle').addEventListener('change',e=>state.waveStyle=e.target.value);
$('#waveRadius').addEventListener('input',e=>{state.waveRadius=e.target.value/100;$('#waveRadiusValue').textContent=e.target.value+'%';updateRange(e.target)});
$('#waveWeight').addEventListener('input',e=>{state.waveWeight=e.target.value/100;$('#waveWeightValue').textContent=e.target.value+'%';updateRange(e.target)});
$$('[data-ratio]').forEach(btn=>btn.addEventListener('click',()=>{const [a,b]=btn.dataset.ratio.split(':').map(Number);$$('[data-ratio]').forEach(x=>x.classList.toggle('active',x===btn));state.ratio=btn.dataset.ratio;$('#canvasStage').style.aspectRatio=`${a}/${b}`;if(a===b){canvas.width=canvas.height=1080;$('#resolutionLabel').textContent='1080 × 1080'}else if(a<b){canvas.width=720;canvas.height=1280;$('#resolutionLabel').textContent='1080 × 1920'}else{canvas.width=1280;canvas.height=720;$('#resolutionLabel').textContent='1920 × 1080'}}));
$('#shuffleLook').addEventListener('click',()=>{state.seed=Math.random()*100;randomizePalette();particles.forEach((p,i)=>{p.x=seeded(i*3.7);p.y=seeded(i*7.9)});});

function downloadBlob(blob,extension){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${(state.title||'visualizer').toLowerCase().replace(/[^a-z0-9]+/g,'-')}.${extension}`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),3000)}

$('#snapshotButton').addEventListener('click',()=>{canvas.toBlob(blob=>{if(blob){downloadBlob(blob,'png');$('#exportNote').textContent='High-resolution cover frame downloaded.'}},'image/png')});

async function exportRealtime(){
  if(recording)return;
  if(!audio.src){$('#exportNote').textContent='Drop a beat first, then export your video.';$('#exportNote').classList.add('error');$('#audioInput').click();return}
  if(!window.MediaRecorder||!canvas.captureStream){$('#exportNote').textContent='Video export is not supported in this browser. Try Chrome or Edge.';$('#exportNote').classList.add('error');return}
  setupAudio();await audioContext.resume();const stream=canvas.captureStream(60);mediaDest.stream.getAudioTracks().forEach(t=>stream.addTrack(t));chunks=[];
  const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(x=>MediaRecorder.isTypeSupported(x));recorder=new MediaRecorder(stream,mime?{mimeType:mime,videoBitsPerSecond:10000000}:undefined);
  const selected=$('#exportLength').value,requested=selected==='full'?audio.duration:Number(selected);exportTarget=Math.min(Number.isFinite(audio.duration)?audio.duration:requested,requested);
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  recorder.onstop=()=>{clearInterval(exportTimer);exportTimer=null;recording=false;audio.pause();$('#exportButton').disabled=false;$('#exportLength').disabled=false;$('#exportButton').classList.remove('recording');$('#exportButton').innerHTML='<span>↓</span> EXPORT VIDEO';const blob=new Blob(chunks,{type:mime||'video/webm'});downloadBlob(blob,'webm');$('#exportNote').textContent='Video export downloaded.';};
  audio.currentTime=0;recorder.start(1000);recording=true;$('#exportButton').disabled=true;$('#exportLength').disabled=true;$('#exportButton').classList.add('recording');$('#exportButton').innerHTML='<span>◌</span> EXPORTING 0%';$('#exportNote').classList.remove('error');$('#exportNote').textContent='Rendering your video — it will download automatically.';await audio.play();
  exportTimer=setInterval(()=>{const progress=Math.min(1,audio.currentTime/exportTarget);$('#exportButton').innerHTML=`<span>◌</span> EXPORTING ${Math.round(progress*100)}%`;if(audio.currentTime>=exportTarget&&recorder.state==='recording')recorder.stop()},200);
}

function offlineSnapshot(buffer,time,previousEnergy){
  const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i)),center=Math.floor(time*buffer.sampleRate),windowSize=2048,timeData=new Uint8Array(512);let sum=0;
  for(let i=0;i<512;i++){const index=Math.min(buffer.length-1,Math.max(0,center-1024+i*4));let value=0;channels.forEach(c=>value+=c[index]||0);value/=channels.length;timeData[i]=Math.max(0,Math.min(255,128+value*118));sum+=value*value}
  const rms=Math.sqrt(sum/512),bass=Math.min(1,rms*3.8),mid=Math.min(1,rms*2.1),beat=bass>Math.max(.18,previousEnergy*1.35)?1:Math.max(0,(bass-previousEnergy)*2.5);return{timeData,bass,mid,beat};
}

async function waitForEncoderQueue(encoder,maxSize=12){
  while(encoder.encodeQueueSize>maxSize){
    await new Promise(resolve=>encoder.addEventListener('dequeue',resolve,{once:true}));
  }
}

async function exportFast1080(){
  if(!loadedAudioFile){$('#exportNote').textContent='Drop a beat first, then export your video.';$('#exportNote').classList.add('error');$('#audioInput').click();return}
  if(!window.VideoEncoder||!window.AudioEncoder||!window.AudioData){$('#exportNote').textContent='Fast 1080p export needs Chrome or Edge with WebCodecs enabled.';$('#exportNote').classList.add('error');return}
  const button=$('#exportButton'),stopButton=$('#stopExportButton'),lengthSelect=$('#exportLength'),fpsSelect=$('#exportFps');exportCancelRequested=false;button.disabled=true;lengthSelect.disabled=true;fpsSelect.disabled=true;stopButton.classList.remove('hidden');button.classList.add('recording');$('#exportNote').classList.remove('error');$('#exportNote').textContent='Rendering constant-frame-rate 1080p video…';
  const oldWidth=canvas.width,oldHeight=canvas.height;let videoEncoder,audioEncoder;
  try{
    const {Muxer,ArrayBufferTarget}=await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs');
    const decodeContext=new AudioContext();const audioBuffer=await decodeContext.decodeAudioData(await loadedAudioFile.arrayBuffer());await decodeContext.close();if(exportCancelRequested)throw new DOMException('Rendering stopped by user.','AbortError');
    const selected=lengthSelect.value,requested=selected==='full'?audioBuffer.duration:Number(selected),duration=Math.min(audioBuffer.duration,requested),fps=Number(fpsSelect.value)||30;
    const [width,height]=state.ratio==='1:1'?[1080,1080]:state.ratio==='9:16'?[1080,1920]:[1920,1080];canvas.width=width;canvas.height=height;offlineRendering=true;
    const audioChannels=Math.min(2,audioBuffer.numberOfChannels),audioSampleRate=audioBuffer.sampleRate;
    const target=new ArrayBufferTarget();const muxer=new Muxer({target,video:{codec:'avc',width,height},audio:{codec:'aac',sampleRate:audioSampleRate,numberOfChannels:audioChannels},fastStart:'in-memory',firstTimestampBehavior:'offset'});
    let encodeError=null;videoEncoder=new VideoEncoder({output:(chunk,meta)=>muxer.addVideoChunk(chunk,meta),error:error=>{encodeError=error}});audioEncoder=new AudioEncoder({output:(chunk,meta)=>muxer.addAudioChunk(chunk,meta),error:error=>{encodeError=error}});
    const videoBase={width,height,bitrate:fps===60?18000000:12000000,framerate:fps,latencyMode:'realtime',hardwareAcceleration:'prefer-hardware',avc:{format:'avc'}},preferredVideoConfig={...videoBase,codec:fps===60?'avc1.64002a':'avc1.640028'},fallbackVideoConfig={...videoBase,codec:fps===60?'avc1.42002a':'avc1.420028'};const preferredSupport=await VideoEncoder.isConfigSupported(preferredVideoConfig),videoConfig=preferredSupport.supported?preferredVideoConfig:fallbackVideoConfig;const audioConfig={codec:'mp4a.40.2',sampleRate:audioSampleRate,numberOfChannels:audioChannels,bitrate:192000};
    const [videoSupport,audioSupport]=await Promise.all([VideoEncoder.isConfigSupported(videoConfig),AudioEncoder.isConfigSupported(audioConfig)]);if(!videoSupport.supported||!audioSupport.supported)throw new Error('This device cannot encode H.264/AAC at 1080p.');videoEncoder.configure(videoConfig);audioEncoder.configure(audioConfig);
    let previousEnergy=0;const frameCount=Math.ceil(duration*fps);for(let frame=0;frame<frameCount;frame++){if(exportCancelRequested)throw new DOMException('Rendering stopped by user.','AbortError');const timestamp=Math.round(frame*1e6/fps),nextTimestamp=Math.round((frame+1)*1e6/fps),time=timestamp/1e6,snap=offlineSnapshot(audioBuffer,time,previousEnergy);previousEnergy=snap.bass;dataArray.set(snap.timeData);draw(timestamp/1000,true,snap);const videoFrame=new VideoFrame(canvas,{timestamp,duration:nextTimestamp-timestamp});videoEncoder.encode(videoFrame,{keyFrame:frame%(fps*2)===0});videoFrame.close();if(videoEncoder.encodeQueueSize>5)await videoEncoder.flush();if(frame%20===0){const pct=Math.round(frame/frameCount*85);button.innerHTML=`<span>◌</span> RENDERING ${pct}%`;await new Promise(requestAnimationFrame)}if(encodeError)throw encodeError}
    if(exportCancelRequested)throw new DOMException('Rendering stopped by user.','AbortError');await videoEncoder.flush();button.innerHTML='<span>◌</span> MIXING AUDIO 90%';
    const audioFrames=Math.min(audioBuffer.length,Math.ceil(duration*audioSampleRate)),chunkSize=1024;let peak=0;for(let channel=0;channel<audioBuffer.numberOfChannels;channel++){const samples=audioBuffer.getChannelData(channel);for(let i=0;i<audioFrames;i+=32)peak=Math.max(peak,Math.abs(samples[i]||0))}const headroomGain=peak>0?Math.min(1,.92/peak):1;
    for(let offset=0;offset<audioFrames;offset+=chunkSize){if(exportCancelRequested)throw new DOMException('Rendering stopped by user.','AbortError');const frames=Math.min(chunkSize,audioFrames-offset),planar=new Float32Array(frames*audioChannels);for(let channel=0;channel<audioChannels;channel++){const sourceChannel=audioBuffer.getChannelData(Math.min(channel,audioBuffer.numberOfChannels-1));for(let i=0;i<frames;i++){const clean=Number.isFinite(sourceChannel[offset+i])?sourceChannel[offset+i]:0;planar[channel*frames+i]=Math.tanh(clean*headroomGain*1.08)/Math.tanh(1.08)*.92}}const timestamp=Math.round(offset/audioSampleRate*1e6);const audioData=new AudioData({format:'f32-planar',sampleRate:audioSampleRate,numberOfFrames:frames,numberOfChannels:audioChannels,timestamp,data:planar});audioEncoder.encode(audioData);audioData.close();await waitForEncoderQueue(audioEncoder,12);if(encodeError)throw encodeError}
    if(exportCancelRequested)throw new DOMException('Rendering stopped by user.','AbortError');await audioEncoder.flush();muxer.finalize();downloadBlob(new Blob([target.buffer],{type:'video/mp4'}),'mp4');$('#exportNote').textContent=`Constant ${fps} FPS MP4 exported in ${width} × ${height} with protected audio headroom.`;button.innerHTML='<span>✓</span> EXPORTED';setTimeout(()=>button.innerHTML='<span>↓</span> EXPORT 1080P MP4',1600);
  }catch(error){if(error.name==='AbortError'){$('#exportNote').textContent='Rendering stopped. No partial video was downloaded.';$('#exportNote').classList.remove('error');button.innerHTML='<span>■</span> RENDER STOPPED';setTimeout(()=>button.innerHTML='<span>↓</span> EXPORT 1080P MP4',1400)}else{console.error(error);$('#exportNote').textContent=error.message||'Fast export failed on this device.';$('#exportNote').classList.add('error');button.innerHTML='<span>!</span> EXPORT FAILED';setTimeout(()=>button.innerHTML='<span>↓</span> EXPORT 1080P MP4',1800)}}finally{if(videoEncoder?.state!=='closed')videoEncoder?.close();if(audioEncoder?.state!=='closed')audioEncoder?.close();offlineRendering=false;exportCancelRequested=false;canvas.width=oldWidth;canvas.height=oldHeight;button.disabled=false;stopButton.disabled=false;stopButton.innerHTML='<span>■</span> STOP RENDERING';stopButton.classList.add('hidden');lengthSelect.disabled=false;fpsSelect.disabled=false;button.classList.remove('recording')}
}

async function exportVideo(){return exportFast1080()}
$('#exportButton').addEventListener('click',exportVideo);$('#stopExportButton').addEventListener('click',()=>{exportCancelRequested=true;$('#stopExportButton').disabled=true;$('#stopExportButton').textContent='STOPPING…';$('#exportNote').textContent='Stopping safely and discarding the partial render…'});audio.addEventListener('ended',()=>{if(recording&&recorder.state==='recording')recorder.stop()});
['audioDropzone','referenceDropzone','canvasStage'].forEach(id=>{const el=$('#'+id);el.addEventListener('dragover',e=>{e.preventDefault();$('#dropOverlay').classList.add('visible')});el.addEventListener('dragleave',()=>$('#dropOverlay').classList.remove('visible'));el.addEventListener('drop',e=>{e.preventDefault();$('#dropOverlay').classList.remove('visible');[...e.dataTransfer.files].forEach(f=>f.type.startsWith('audio/')?loadAudio(f):loadReference(f))});});
$('#helpButton').addEventListener('click',()=>$('#helpDialog').showModal());$('#closeHelp').addEventListener('click',()=>$('#helpDialog').close());
document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA'].includes(e.target.tagName))return;if(e.code==='Space'){e.preventDefault();$('#playButton').click()}if(e.key.toLowerCase()==='r')randomizePalette();if(e.key.toLowerCase()==='s')$('#shuffleLook').click()});
document.addEventListener('input',scheduleAutosave);document.addEventListener('change',scheduleAutosave);
populateWordFonts();loadSavedProject();refreshPresets();$$('.range').forEach(updateRange);restoreProjectAssets();requestAnimationFrame(draw);
