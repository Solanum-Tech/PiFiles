const ROW_H=36,BUFFER=12,PAGE=100,DEBOUNCE_MS=200;
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const els={sidebar:$("#sidebar"),overlay:$("#overlay"),drivesList:$("#drivesList"),storageBar:$("#storageBar"),storageFill:$("#storageFill"),breadcrumbBar:$("#breadcrumbBar"),breadcrumbView:$("#breadcrumbView"),addressInput:$("#addressInput"),addressGo:$("#addressGo"),addressEditBtn:$("#addressEditBtn"),addressCopyBtn:$("#addressCopyBtn"),fileViewport:$("#fileViewport"),fileSpacer:$("#fileSpacer"),fileContainer:$("#fileContainer"),emptyState:$("#emptyState"),itemCount:$("#itemCount"),pathLabel:$("#pathLabel"),loadingLabel:$("#loadingLabel"),statusText:$("#statusText"),statusRight:$("#statusRight"),layoutInfo:$("#layoutInfo"),zoomLabel:$("#zoomLabel"),searchInput:$("#searchInput"),searchClear:$("#searchClear"),searchMeta:$("#searchMeta"),searchHeader:$("#searchHeader"),searchQueryLabel:$("#searchQueryLabel"),searchStats:$("#searchStats"),viewportWrap:$("#viewportWrap"),mediaView:$("#mediaView"),peopleTab:$("#peopleTab"),devicesTab:$("#devicesTab"),peopleGrid:$("#peopleGrid"),devicesGrid:$("#devicesGrid"),deviceMetaGrid:$("#deviceMetaGrid"),loadMoreWrap:$("#loadMoreWrap"),sortSelect:$("#sortSelect"),groupSelect:$("#groupSelect"),selectAllBtn:$("#selectAllBtn"),newFolderBtn:$("#newFolderBtn"),detailsToggle:$("#detailsToggle"),toast:$("#toast"),tabBar:$("#tabBar"),tabList:$("#tabList"),newTabBtn:$("#newTabBtn"),detailsPane:$("#detailsPane"),detailsResizer:$("#detailsResizer"),sidebarResizer:$("#sidebarResizer"),detailsContent:$("#detailsContent"),detailsPreview:$("#detailsPreview"),detailsProps:$("#detailsProps"),detailsClose:$("#detailsClose"),detailsCount:$("#detailsCount"),commandPalette:$("#commandPalette"),cmdInput:$("#cmdInput"),cmdList:$("#cmdList"),contextMenu:$("#contextMenu"),selectionCount:$("#selectionCount"),selectionInfo:$("#selectionInfo"),hiddenToggle:$("#hiddenToggle"),rebuildIndexBtn:$("#rebuildIndexBtn"),};
let state={path:"",history:[],files:[],view:localStorage.getItem("fe:view")||"list",sort:localStorage.getItem("fe:sort")||"name-asc",group:localStorage.getItem("fe:group")||"none",showHidden:localStorage.getItem("fe:showHidden")==="1",detailsOpen:localStorage.getItem("fe:details")==="1",searchQuery:"",searchResults:[],searchTotal:0,searchOffset:0,isSearching:false,searchMeta:{took_ms:0,indexed:false,has_more:false},drives:[],mediaPeople:null,mediaDevices:null,tabs:[{id:1,path:"",title:"Home"}],activeTabId:1,nextTabId:2,selected:new Set(),lastSelectedIdx:-1,zoom:100,indexStatus:{ready:false,building:true,size:0}};
let virt={scrollTop:0,raf:0};
// --- Thumbnail (base64 data URL, lazy, batched, cached) ---
const thumbCache=new Map(); // path -> dataUrl ("" = not image / failed)
const thumbPending=new Set();
const THUMB_BATCH=20;
const THUMB_EXTS=new Set(["jpg","jpeg","png","webp","bmp","gif","heic","heif"]);
function isImageFile(f){const e=(f.extension||f.ext||f.name.split(".").pop()||"").toLowerCase();return THUMB_EXTS.has(e);}
function isVideoFile(f){const e=(f.extension||f.ext||f.name.split(".").pop()||"").toLowerCase();return ["mp4","mkv","mov","avi","wmv","webm"].includes(e);}
function getInvoke(){try{return window.__TAURI__?.core?.invoke||window.__TAURI__?.invoke}
catch{return null}}
const invokeFn=getInvoke();
async function invoke(c,a){if(invokeFn){try{return await invokeFn(c,a)}
catch(e){throw e}}throw new Error("no backend")}
async function safeInvoke(c,a,f){try{return await invoke(c,a)}
catch{return typeof f==="function"?f(a):f}}
async function fetchThumb(path){if(thumbCache.has(path)) return thumbCache.get(path); if(thumbPending.has(path)) return null; thumbPending.add(path); try{const url=await invoke("get_thumbnail",{path}); thumbCache.set(path,url||""); return url;}catch{thumbCache.set(path,""); return "";}finally{thumbPending.delete(path);}}
async function fetchPreview(path){if(thumbCache.has("preview:"+path)) return thumbCache.get("preview:"+path); try{const url=await invoke("get_file_preview",{path}); thumbCache.set("preview:"+path,url||""); return url;}catch{return "";}
}
// batch 20 at a time for low-end; updates DOM in place
function queueThumbBatch(paths, onDone){
  let i=0;
  function next(){
    const batch=paths.slice(i,i+THUMB_BATCH); i+=THUMB_BATCH;
    if(!batch.length){ if(onDone) onDone(); return; }
    Promise.all(batch.map(p=>fetchThumb(p).then(url=>{
      if(!url) return;
      // list rows
      document.querySelectorAll(`[data-thumb-path="${CSS.escape(p)}"]`).forEach(el=>{
        const img=el.querySelector("img.thumb-img");
        if(img){ img.src=url; img.style.display="block"; const ph=el.querySelector(".thumb-ph"); if(ph) ph.style.display="none"; }
      });
      // grid cards
      document.querySelectorAll(`[data-grid-thumb="${CSS.escape(p)}"]`).forEach(wrap=>{
        const img=wrap.querySelector("img"); if(img){ img.src=url; img.style.display="block"; wrap.querySelector(".thumb-ph")?.style&&(wrap.querySelector(".thumb-ph").style.display="none"); }
      });
    }))).then(()=>setTimeout(next, 40));
  }
  next();
}
function mockDrives(){return[{name:"C:",mount_point:"C:\\",total_space:512e9,free_space:210e9,type:"SSD",used:59},{name:"D:",mount_point:"D:\\",total_space:1e12,free_space:640e9,type:"HDD",used:36},{name:"E:",mount_point:"E:\\",total_space:2e12,free_space:1200e9,type:"HDD",used:40}]}
function mockListDir(p){if(!p)
return[{name:"Users",path:"C:\\Users",is_dir:true,size:0,modified:"2026-08-30"},{name:"Windows",path:"C:\\Windows",is_dir:true,size:0,modified:"2026-08-28"},{name:"Program Files",path:"C:\\Program Files",is_dir:true,size:0,modified:"2026-07-12"},{name:"Pictures",path:"C:\\Users\\Siril\\Pictures",is_dir:true,size:0,modified:"2026-08-31"},{name:"notes.txt",path:"C:\\notes.txt",is_dir:false,size:2400,modified:"2026-08-29",ext:"txt"},{name:"image_001.jpg",path:"C:\\image_001.jpg",is_dir:false,size:4200000,modified:"2026-08-30",ext:"jpg"}];
const b=p.replace(/\\$/,"");
const dirs=["DCIM","Vacation","Family","Camera Roll"].map(n=>({name:n,path:b+"\\"+n,is_dir:true,size:0,modified:"2026-08-31"}));
const files=Array.from({length:80},(_,i)=>{const ext=["jpg","mp4","png","docx","pdf"][i%5];
return{name:`IMG_${String(1000+i).padStart(4,"0")}.${ext}`,path:b+"\\"+`IMG_${String(1000+i).padStart(4,"0")}.${ext}`,is_dir:false,size:Math.floor(500000+Math.random()*8e6),modified:`2026-08-${String(10+(i%20)).padStart(2,"0")}`,ext}});
return[...dirs,...files]}
function mockSearch(q,o=0,l=PAGE){const all=mockListDir("C:\\").filter(f=>!f.is_dir);
const qq=q.toLowerCase();
const filtered=all.concat(Array.from({length:120},(_,i)=>({name:`${q}_result_${i}.jpg`,path:`C:\\Search\\${q}_result_${i}.jpg`,is_dir:false,size:1230000,modified:"2026-08-30",ext:"jpg"}))).filter(f=>f.name.toLowerCase().includes(qq));
const slice=filtered.slice(o,o+l);
return{results:slice,total:filtered.length,has_more:filtered.length>o+slice.length,took_ms:12,indexed:true,query:q}}
function mockMediaPeople(){return[{id:"p1",name:"Family",count:42,cover:"👨‍👩‍👧",path:"C:\\Users\\Siril\\Pictures\\Family"},{id:"p2",name:"Vacation 2026",count:28,cover:"🏖",path:"C:\\Users\\Siril\\Pictures\\Vacation"},{id:"p3",name:"DCIM / Camera",count:64,cover:"📷",path:"C:\\Users\\Siril\\Pictures\\DCIM"},{id:"p4",name:"Unknown",count:12,cover:"👤",path:"C:\\Users\\Siril\\Pictures\\Camera Roll"}]}
function mockDeviceGroups(){return{by_drive:[{drive:"C:",label:"C:",count:320,type:"SSD",icon:"💾"},{drive:"D:",label:"D:",count:540,type:"HDD",icon:"🗄"},{drive:"E:",label:"E:",count:210,type:"HDD",icon:"📦"}],by_type:[{label:"JPEG • Camera",count:210,meta:"Canon EOS R5",icon:"🖼"},{label:"MP4 • Video",count:84,meta:"iPhone 15",icon:"🎬"},{label:"PNG • Screenshots",count:62,meta:"PNG",icon:"🖼"},{label:"PDF • Documents",count:31,meta:"PDF",icon:"📄"}]}}
function debounce(fn,ms){let t;
return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}}
function fmtSize(b){if(b==null||isNaN(b))
return"—";
if(b<1024)
return b+" B";
if(b<1024*1024)
return(b/1024).toFixed(1)+" KB";
if(b<1024*1024*1024)
return(b/1024/1024).toFixed(1)+" MB";
return(b/1024/1024/1024).toFixed(2)+" GB"}
function fmtDate(s){if(!s)
return"—";
if(/^\d+$/.test(String(s))){try{return new Date(Number(s)*1000).toISOString().slice(0,10)}
catch{return s}}
return s}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function highlight(text,q){if(!q)
return esc(text);
const i=text.toLowerCase().indexOf(q.toLowerCase());
if(i<0)
return esc(text);
return esc(text.slice(0,i))+"<mark>"+esc(text.slice(i,i+q.length))+"</mark>"+esc(text.slice(i+q.length))}
function toast(msg,ms=2400){els.toast.textContent=msg;els.toast.classList.add("show");clearTimeout(toast._t);toast._t=setTimeout(()=>els.toast.classList.remove("show"),ms)}
function setLoading(v){els.loadingLabel.classList.toggle("hidden",!v);els.statusText.textContent=v?"Loading…":(state.isSearching?`Search: ${state.searchTotal} matches • ${state.searchMeta.took_ms}ms`:`${state.files.length} items • ${state.path||"Home"}`)}
function sortFiles(arr,sort){const a=[...arr];
const[k,dir]=sort.split("-");a.sort((x,y)=>{if(k==="name"){const c=x.name.localeCompare(y.name);
return dir==="asc"?c:-c}
if(k==="size"){return dir==="asc"?(x.size||0)-(y.size||0):(y.size||0)-(x.size||0)}
if(k==="date"){const dx=new Date(x.modified),dy=new Date(y.modified);
return dir==="asc"?dx-dy:dy-dx}
return 0});a.sort((x,y)=>(y.is_dir - x.is_dir)||0);
return a}
function groupFiles(files,mode){if(mode==="none") return [{key:"",items:files}];
if(mode==="type"){const m={};files.forEach(f=>{const k=f.is_dir?"Folder":(f.extension||f.ext||f.name.split(".").pop()||"other").toLowerCase();(m[k]=m[k]||[]).push(f)});
return Object.keys(m).sort().map(k=>({key:k.toUpperCase(),items:m[k]}));}
if(mode==="size"){const m={"Small":[],"Medium":[],"Large":[],"Folders":[]};files.forEach(f=>{if(f.is_dir)m["Folders"].push(f);
else if((f.size||0)<1e6)m["Small"].push(f);
else if((f.size||0)<10e6)m["Medium"].push(f);
else m["Large"].push(f)});
return Object.entries(m).filter(([,v])=>v.length).map(([k,v])=>({key:k,items:v}));}
if(mode==="date"){const m={};files.forEach(f=>{const d=(f.modified||"").slice(0,10)||"Unknown"; (m[d]=m[d]||[]).push(f)});
return Object.keys(m).sort().reverse().map(k=>({key:k,items:m[k]}));}
return [{key:"",items:files}];}
function filteredFiles(){let arr = state.isSearching? state.searchResults : state.files;
if(!state.showHidden) arr = arr.filter(f=> !f.name.startsWith(".") && !f.name.startsWith("$"));
return arr;}/* Tabs */function renderTabBar(){const h=state.tabs.map(t=>{const isActive=t.id===state.activeTabId;
const title=esc(t.title||t.path||"Home");
const tip=esc(t.path||"Home");
return `<div class="tab ${isActive?"active":""}" data-tab="${t.id}" draggable="true" title="${tip}"><span class="tab-title">${title}</span><button class="tab-close" data-close="${t.id}" title="Close tab">✕</button></div>`;}).join("");els.tabList.innerHTML=h||`<div class="tab active" data-tab="1"><span class="tab-title">Home</span></div>`;$$(".tab",els.tabList).forEach(el=>{el.addEventListener("dragstart",e=>{e.dataTransfer.setData("text/plain",el.dataset.tab);el.style.opacity=.5});el.addEventListener("dragend",()=>el.style.opacity="");el.addEventListener("dragover",e=>e.preventDefault());el.addEventListener("drop",e=>{e.preventDefault();
const from=e.dataTransfer.getData("text/plain"); const to=el.dataset.tab;
const fi=state.tabs.findIndex(x=>String(x.id)===from), ti=state.tabs.findIndex(x=>String(x.id)===to);
if(fi>=0&&ti>=0&&fi!==ti){ const [mv]=state.tabs.splice(fi,1); state.tabs.splice(ti,0,mv); renderTabBar(); }});});}
function switchTab(id){const t=state.tabs.find(x=>x.id===id); if(!t) return;state.activeTabId=id; state.path=t.path; renderTabBar();renderBreadcrumbs(); loadDir(t.path);}
function newTab(path=""){const id=state.nextTabId++; const title=path? path.split("\\").pop()||path : "Home";state.tabs.push({id,path,title}); state.activeTabId=id; renderTabBar(); navigateTo(path);}
function closeTab(id,e){if(e) e.stopPropagation();
if(state.tabs.length===1){ toast("Cannot close last tab"); return; }
const idx=state.tabs.findIndex(x=>x.id===id); if(idx<0) return;state.tabs.splice(idx,1);
if(state.activeTabId===id){ const n=state.tabs[Math.max(0,idx-1)]; state.activeTabId=n.id; state.path=n.path; renderBreadcrumbs(); loadDir(n.path); }renderTabBar();}
function updateActiveTab(path){const t=state.tabs.find(x=>x.id===state.activeTabId); if(t){ t.path=path; t.title=path? path.split("\\").pop()||path : "Home"; renderTabBar(); }}/* Breadcrumbs editable */function renderBreadcrumbs(){const path=state.isSearching?"":state.path;
const parts=path? path.split("\\").filter(Boolean):[];
let html=`<div class="crumb"><button data-path="" class="${!path?"current":""}" title="Home">⌂ Home</button></div>`;
let acc="";parts.forEach((p,i)=>{acc+=(i===0&&p.endsWith(":"))?p+"\\":(i===0?p:"\\"+p);
const isLast=i===parts.length-1;html+=`<span class="crumb-sep">›</span><div class="crumb"><button data-path="${esc(acc)}" class="${isLast?"current":""}">${esc(p)}</button></div>`;});els.breadcrumbView.innerHTML=html;els.pathLabel.textContent=path||"Home"; els.pathLabel.title=path||"Home";els.addressInput.value=path||""; // sync
updateActiveTab(path);
if(els.layoutInfo) els.layoutInfo.textContent=`${state.view==="grid"?"Grid":"List"} • ${state.group==="none"?"No group":"Group:"+state.group}`;}
function enterAddressEdit(){els.breadcrumbView.classList.add("hidden"); els.addressEditBtn.classList.add("hidden");els.addressInput.classList.remove("hidden"); els.addressGo.classList.remove("hidden");els.addressInput.focus(); els.addressInput.select();}
function exitAddressEdit(cancel){els.breadcrumbView.classList.remove("hidden"); els.addressEditBtn.classList.remove("hidden");els.addressInput.classList.add("hidden"); els.addressGo.classList.add("hidden");
if(cancel) els.addressInput.value=state.path;}
function commitAddress(){const v=els.addressInput.value.trim();exitAddressEdit(false);
if(!v){ navigateTo(""); return; }navigateTo(v);}
function bindBreadcrumbs(){els.breadcrumbView.onclick=(e)=>{const btn=e.target.closest("button[data-path]"); if(!btn) return;
const p=btn.getAttribute("data-path");
if(state.isSearching) clearSearch();navigateTo(p);};els.breadcrumbView.ondblclick=enterAddressEdit;els.addressEditBtn.onclick=enterAddressEdit;els.addressGo.onclick=commitAddress;
if(els.addressCopyBtn) els.addressCopyBtn.onclick=()=>{const p=state.path||""; if(navigator.clipboard) navigator.clipboard.writeText(p).then(()=>toast("Path copied")); else toast(p);};els.addressInput.addEventListener("keydown",e=>{if(e.key==="Enter") commitAddress();
if(e.key==="Escape") exitAddressEdit(true);});els.addressInput.addEventListener("blur",()=> setTimeout(()=>{ if(!els.addressInput.classList.contains("hidden")) exitAddressEdit(true); },150));}/* Drives with timeout */function withTimeout(promise,ms,fallbackValue){let t; const timeout=new Promise(resolve=>{t=setTimeout(()=>resolve(fallbackValue),ms)});
return Promise.race([promise.then(v=>{clearTimeout(t);
return v},_=>{clearTimeout(t);
return fallbackValue}), timeout]);}
async function loadDrives(){els.drivesList.innerHTML=`<div class="loading"><span class="spinner"></span> Loading drives…</div>`;
const raw=await withTimeout(safeInvoke("list_drives",{},mockDrives()),800,mockDrives());
let drives=Array.isArray(raw)?raw:(raw?.drives||mockDrives());
if(!Array.isArray(drives)||!drives.length) drives=mockDrives();state.drives=drives.map(d=>{if(typeof d==="string") return{name:d,path:d,mount_point:d,total_space:0,free_space:0,type:"Fixed",drive_type:"Fixed",total_gb:0,free_gb:0,used:0,file_system:"NTFS",is_removable:false,label:d,used_gb:0};
const path=d.path||d.mount_point||d.name||"C:\\"; const total_space=d.total_space??(d.total_gb?d.total_gb*1024*1024*1024:0);
const free_space=d.free_space??(d.free_gb?d.free_gb*1024*1024*1024:0); const total_gb=d.total_gb??(total_space?total_space/1024/1024/1024:0);
const free_gb=d.free_gb??(free_space?free_space/1024/1024/1024:0); const typeLabel=d.drive_type||d.type||"Fixed";
const used=d.used??(total_space?Math.round(100*(1-free_space/total_space)):0);
const file_system=d.file_system||d.fileSystem||"NTFS";
const is_removable=d.is_removable??(typeLabel==="Removable"||typeLabel==="CDRom");
const label=d.label||d.volume_label||""; const used_gb=d.used_gb??(total_gb-free_gb>0?total_gb-free_gb:0);
const fallbackLabel= typeLabel==="Removable"?"USB Drive":typeLabel==="CDRom"?"CD Drive":typeLabel==="Remote"?"Network Drive":"Local Disk";
const displayLabel=label||fallbackLabel;
const name=d.name||`${displayLabel} (${path.replace(/\\$/,"")})`;
return{name,path,mount_point:path,total_space,free_space,total_gb,free_gb,type:typeLabel,drive_type:typeLabel,used,file_system,is_removable,label:displayLabel,used_gb};});renderDrives(); const dc=$("#driveCount"); if(dc) dc.textContent=state.drives.length; const hc=$("#homeCount"); if(hc) hc.textContent=state.files.length||"—";}
function renderDrives(){if(!state.drives.length){els.drivesList.innerHTML=`<div style="padding:8px;color:var(--text-3);font-size:12px">No drives found <button onclick="location.reload()" style="margin-left:6px;font-size:11px">Retry</button></div>`;
return}
function fmtGB(v){if(v==null||isNaN(v)||v<=0) return "0 GB"; const r=Math.round(v*10)/10; return (r%1===0? r.toFixed(0): r.toFixed(1))+" GB"; }
function driveIcon(d){
  const t=d.drive_type||d.type||"Fixed";
  if(t==="Removable") return "🔌";
  if(t==="CDRom") return "📀";
  if(t==="Remote") return "🌐";
  if(t==="RamDisk") return "💿";
  if((d.path||"").toUpperCase()==="C:\\") return "🪟";
  return "💾";
}
function driveIconClass(d){
  const t=d.drive_type||d.type||"Fixed";
  if(t==="Removable"||t==="CDRom") return "removable";
  if((d.path||"").toUpperCase()==="C:\\") return "windows";
  return "fixed";
}
els.drivesList.innerHTML=state.drives.map(d=>{
  const path=d.path||d.mount_point||"C:\\";
  const total_gb=d.total_gb||(d.total_space?d.total_space/1024/1024/1024:0);
  const free_gb=d.free_gb||(d.free_space?d.free_space/1024/1024/1024:0);
  const total_space=d.total_space||total_gb*1024*1024*1024;
  const free_space=d.free_space||free_gb*1024*1024*1024;
  let usedPct=d.used;
  if(usedPct==null) usedPct= total_space? Math.round(100*(1-free_space/total_space)):0;
  if(usedPct<0) usedPct=0; if(usedPct>100) usedPct=100;
  const fs=d.file_system||"NTFS";
  const dtype=d.drive_type||d.type||"Fixed";
  const isRem=d.is_removable||dtype==="Removable"||dtype==="CDRom";
  const icon=driveIcon(d);
  const iconCls=driveIconClass(d);
  const freeText= fmtGB(free_gb);
  const totalText= fmtGB(total_gb);
  const barColor = isRem ? "#8a8a8a" : (usedPct>=90 ? "#d13438" : "#0078d4");
  const barWidth = total_gb>0 ? usedPct+"%" : "0%";
  const label=d.label||"Local Disk";
  const displayName=d.name||`${label} (${path.replace(/\\$/,"")})`;
  // Windows Explorer shows: Local Disk (C:)  +  C:\ • NTFS  +  210 GB free of 512 GB
  return `<div class="drive-card" data-drive="${esc(path)}" title="${esc(displayName)} — ${freeText} free of ${totalText} • ${fs}">
    <div class="drive-header">
      <div class="drive-icon ${iconCls}" aria-hidden="true">${icon}</div>
      <div class="drive-info">
        <div class="drive-label">${esc(displayName)}</div>
        <div class="drive-sub">${esc(path)} • ${esc(fs)} • ${esc(dtype)}</div>
      </div>
      <div class="drive-free-col">
        <div class="drive-free">${freeText} free of ${totalText}</div>
        <div class="drive-pct">${usedPct?usedPct+"% used":""}</div>
      </div>
    </div>
    <div class="usage-track" aria-label="Storage usage ${usedPct}%">
      <div class="usage-fill ${isRem?"removable":(usedPct>=90?"warn":"")}" style="width:${barWidth};background:${barColor}"></div>
    </div>
  </div>`;
}).join("");
// aggregate bottom bar — total across all drives
const total=state.drives.reduce((s,d)=>s+(d.total_space||d.total_gb*1024*1024*1024||0),0);
const free=state.drives.reduce((s,d)=>s+(d.free_space||d.free_gb*1024*1024*1024||0),0);
if(total>0){
  const pct=Math.round(100*(1-free/total));
  els.storageBar.classList.remove("hidden");
  els.storageFill.style.width=pct+"%";
  // color same logic aggregated: red if >=90, else blue
  els.storageFill.style.background = pct>=90 ? "#d13438" : "#0078d4";
  els.storageBar.title = `${fmtGB(free/1024/1024/1024)} free of ${fmtGB(total/1024/1024/1024)} • ${pct}% used`;
  // update storage bar label if exists — create dynamic text sibling
  let aggLabel=document.getElementById("storageLabel");
  if(!aggLabel){
    aggLabel=document.createElement("div");
    aggLabel.id="storageLabel";
    aggLabel.className="storage-label";
    els.storageBar.insertAdjacentElement("afterend", aggLabel);
  }
  aggLabel.textContent = `${fmtGB(free/1024/1024/1024)} free of ${fmtGB(total/1024/1024/1024)} • ${pct}% used`;
  aggLabel.title = aggLabel.textContent;
} else {
  els.storageBar.classList.add("hidden");
  const l=document.getElementById("storageLabel"); if(l) l.textContent="";
}}/* File listing */async function navigateTo(path){if(path===state.path && !state.isSearching) return;
if(state.path) state.history.push(state.path);state.path=path||""; state.isSearching=false; els.searchInput.value=""; state.searchQuery=""; hideSearchUI();state.selected.clear(); updateSelectionUI();renderBreadcrumbs(); await loadDir(path);}
async function loadDir(path){setLoading(true); els.emptyState.classList.add("hidden"); els.fileContainer.innerHTML=""; els.fileSpacer.style.height="0";
try{const res=await safeInvoke("list_dir",{path:path||""},()=>mockListDir(path||""));
let files=Array.isArray(res)?res:(res?.entries||res?.files||[]);files=files.map(f=>{if(typeof f==="string") return{name:f.split("\\").pop(),path:f,is_dir:false,size:0,modified:"",extension:""}; return{...f,extension:f.extension||f.ext||""}});state.files=sortFiles(files,state.sort);renderBreadcrumbs(); updateCounts(); renderVirtualized(true);
const hc=$("#homeCount"); if(hc) hc.textContent=state.files.length;setLoading(false); els.statusText.textContent=`${state.files.length} items • ${path||"Home"}`; updateSelectionUI();}
catch(e){setLoading(false);toast("Load failed");showEmpty("Load fail:"+ (e?.message||e))}}
function showEmpty(msg){els.emptyState.classList.remove("hidden"); els.emptyState.innerHTML=`<div class="ico">⚠</div><div><strong>Error</strong><br/><span style="color:var(--text-3)">${esc(msg)}</span></div><button class="load-more" onclick="location.reload()">Retry</button>`;}
function updateCounts(){els.itemCount.textContent=`${filteredFiles().length} items`; if(els.detailsCount) els.detailsCount.textContent=`${filteredFiles().length}`;}/* Virtualization with grouping & selection */function renderVirtualized(resetScroll=false){if(state.view==="grid"){renderGrid();
return}
if(resetScroll) els.fileViewport.scrollTop=0;
const files=filteredFiles();
if(!files.length){els.fileContainer.innerHTML="";els.fileSpacer.style.height="0";els.emptyState.classList.remove("hidden");els.emptyState.innerHTML=`<div class="ico">📁</div><div><strong>Empty</strong><br/><span style="color:var(--text-3)">Empty</span></div><button class="load-more" style="margin-top:8px" onclick="document.getElementById('newFolderBtn').click()">Create folder</button>`;els.loadMoreWrap.classList.add("hidden");
return}els.emptyState.classList.add("hidden");
const useGroups = state.group!=="none" && !state.isSearching;
let display=files, groups=null, flat=[], headerMap=new Map();
if(useGroups){groups=groupFiles(files,state.group);flat=[];groups.forEach(g=>{flat.push({__header:true,label:`${g.key} — ${g.items.length}`});g.items.forEach(f=>flat.push(f));});display=flat;} else {display=files;}
const total=display.length;els.fileSpacer.style.height=(total*ROW_H)+"px";
if(state.isSearching && state.searchTotal>state.searchResults.length) els.loadMoreWrap.classList.remove("hidden"); else els.loadMoreWrap.classList.add("hidden");state._display=display; state._useGroups=useGroups;requestAnimationFrame(updateVirtualSlice);}
function updateVirtualSlice(){const display=state._display || filteredFiles();
const vp=els.fileViewport; const h=vp.clientHeight||400; const scrollTop=vp.scrollTop; const total=display.length;
const visible=Math.ceil(h/ROW_H)+BUFFER*2;
let start=Math.floor(scrollTop/ROW_H)-BUFFER; if(start<0) start=0;
let end=Math.min(total,start+visible); if(end-start<visible && start>0) start=Math.max(0,end-visible);
const slice=display.slice(start,end);
const q=state.isSearching?state.searchQuery:"";els.fileContainer.style.transform=`translateY(${start*ROW_H}px)`; els.fileContainer.className="file-list";els.fileContainer.innerHTML=slice.map(f=>{if(f.__header) return `<div class="group-header">${esc(f.label)}</div>`;
const isDir=!!f.is_dir; const icon=isDir?"📁":iconFor(f); const hl=highlight(f.name,q); const size=isDir?"—":fmtSize(f.size); const date=fmtDate(f.modified);
const sel=state.selected.has(f.path)?"selected":""; const isFocused=state._focusedPath===f.path?"focused":"";
const chk=state.selected.has(f.path)?"on":"";
const isImg=!isDir && isImageFile(f);
let thumbHtml="";
if(isImg){
  const cached=thumbCache.get(f.path);
  if(cached){ thumbHtml=`<span class="f-thumb" data-thumb-path="${esc(f.path)}"><img class="thumb-img" src="${cached}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:3px"><span class="thumb-ph" style="display:none">${icon}</span></span>`; }
  else { thumbHtml=`<span class="f-thumb" data-thumb-path="${esc(f.path)}"><span class="thumb-ph">${icon}</span><img class="thumb-img" alt="" style="display:none;width:100%;height:100%;object-fit:cover;border-radius:3px"></span>`; }
} else { thumbHtml=`<span class="f-icon">${icon}</span>`; }
return `<div class="file-row ${sel}${isFocused}" data-path="${esc(f.path)}" data-dir="${isDir?1:0}" tabindex="0" role="button" aria-label="${esc(f.name)}"><span class="check ${chk}">${state.selected.has(f.path)?"✓":""}</span>${thumbHtml}<span class="f-name" title="${esc(f.name)}">${hl}</span><span class="f-meta"><span class="f-size">${size}</span><span class="f-date">${date}</span></span></div>`;}).join("");
const toFetch=slice.filter(f=>!f.__header && !f.is_dir && isImageFile(f) && !thumbCache.has(f.path) && !thumbPending.has(f.path)).map(f=>f.path);
if(toFetch.length) queueThumbBatch(toFetch);
}
function iconFor(f){const ext=(f.ext||f.extension||f.name.split(".").pop()||"").toLowerCase();
if(["jpg","jpeg","png","gif","webp","bmp","heic"].includes(ext)) return "🖼";
if(["mp4","mkv","mov","avi","wmv"].includes(ext)) return "🎬";
if(["mp3","wav","flac","m4a"].includes(ext)) return "🎵";
if(["pdf"].includes(ext)) return "📄"; if(["zip","rar","7z"].includes(ext)) return "📦";
if(["doc","docx"].includes(ext)) return "📝"; if(["xls","xlsx"].includes(ext)) return "📊"; return "📄";}
function renderGrid(){const files=filteredFiles();
if(!files.length){els.fileContainer.innerHTML="";els.fileSpacer.style.height="0";els.emptyState.classList.remove("hidden");
return}els.emptyState.classList.add("hidden"); els.fileSpacer.style.height="0"; els.fileContainer.style.transform="none"; els.fileContainer.className="file-grid";
const q=state.isSearching?state.searchQuery:"";
const useGroups=state.group!=="none" && !state.isSearching;
let html="";
function thumbForGrid(f,icon){
  const isImg=!f.is_dir && isImageFile(f);
  if(!isImg) return `<div class="f-thumb">${icon}</div>`;
  const cached=thumbCache.get(f.path);
  if(cached){ return `<div class="f-thumb" data-grid-thumb="${esc(f.path)}"><img src="${cached}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'"><span class="thumb-ph" style="display:none">${icon}</span></div>`; }
  return `<div class="f-thumb" data-grid-thumb="${esc(f.path)}"><span class="thumb-ph">${icon}</span><img alt="" style="display:none;width:100%;height:100%;object-fit:cover"></div>`;
}
if(useGroups){const groups=groupFiles(files,state.group);groups.forEach(g=>{html+=`<div style="grid-column:1/-1" class="group-header">${esc(g.key)} — ${g.items.length}</div>`;g.items.forEach(f=>{const isDir=!!f.is_dir; const icon=isDir?"📁":iconFor(f); const hl=highlight(f.name,q); const sel=state.selected.has(f.path)?"selected":"";html+=`<div class="file-card ${sel}" data-path="${esc(f.path)}" data-dir="${isDir?1:0}" tabindex="0" role="button"><span class="check ${state.selected.has(f.path)?"on":""}">${state.selected.has(f.path)?"✓":""}</span>${thumbForGrid(f,icon)}<div class="f-name" title="${esc(f.name)}">${hl}</div><div class="f-meta"><span>${isDir?"Folder":fmtSize(f.size)}</span><span>${esc((f.extension||f.ext||"").toUpperCase())}</span></div></div>`;});});} else {const cap=state.isSearching?files.length:Math.min(files.length,400);
const slice=files.slice(0,cap);html=slice.map(f=>{const isDir=!!f.is_dir; const icon=isDir?"📁":iconFor(f); const hl=highlight(f.name,q); const sel=state.selected.has(f.path)?"selected":"";
return `<div class="file-card ${sel}" data-path="${esc(f.path)}" data-dir="${isDir?1:0}" tabindex="0" role="button"><span class="check ${state.selected.has(f.path)?"on":""}">${state.selected.has(f.path)?"✓":""}</span>${thumbForGrid(f,icon)}<div class="f-name" title="${esc(f.name)}">${hl}</div><div class="f-meta"><span>${isDir?"Folder":fmtSize(f.size)}</span><span>${esc((f.extension||f.ext||"").toUpperCase())}</span></div></div>`;}).join("");
if(!state.isSearching && files.length>cap) els.loadMoreWrap.classList.remove("hidden"); else if(state.isSearching&&state.searchTotal>state.searchResults.length) els.loadMoreWrap.classList.remove("hidden"); else els.loadMoreWrap.classList.add("hidden");}els.fileContainer.innerHTML=html;
const toFetch=(useGroups?files:files.slice(0,400)).filter(f=>!f.is_dir && isImageFile(f) && !thumbCache.has(f.path) && !thumbPending.has(f.path)).map(f=>f.path);
if(toFetch.length) queueThumbBatch(toFetch);
}els.fileViewport.addEventListener("scroll",()=>{if(state.view!=="list") return; if(virt.raf) return; virt.raf=requestAnimationFrame(()=>{virt.raf=0;updateVirtualSlice()})});window.addEventListener("resize",()=>{if(state.view==="list") updateVirtualSlice()});/* Selection */function getFileIndexByPath(path){const arr=filteredFiles(); return arr.findIndex(f=>f.path===path);}
function updateSelectionUI(){const n=state.selected.size;
if(n>0){ els.selectionCount.classList.remove("hidden"); els.selectionCount.textContent=`${n} selected`; if(els.selectionInfo){els.selectionInfo.classList.remove("hidden"); els.selectionInfo.textContent=`${n} selected`; } els.statusText.textContent=`${n} selected • ${filteredFiles().length} items`;} else { els.selectionCount.classList.add("hidden"); if(els.selectionInfo) els.selectionInfo.classList.add("hidden"); setLoading(false); }
if(n===1){ const p=[...state.selected][0]; const f=filteredFiles().find(x=>x.path===p)||state.searchResults.find(x=>x.path===p)||state.files.find(x=>x.path===p); if(f) showDetails(f); }
else if(n===0 && state.detailsOpen) showDetails(null);}
function handleRowClick(e,path,isDir){const idx=getFileIndexByPath(path);
if(e.shiftKey && state.lastSelectedIdx>=0){const arr=filteredFiles(); const a=Math.min(state.lastSelectedIdx,idx), b=Math.max(state.lastSelectedIdx,idx);
for(let i=a;i<=b;i++) state.selected.add(arr[i].path);} else if(e.ctrlKey||e.metaKey){if(state.selected.has(path)) state.selected.delete(path); else state.selected.add(path);state.lastSelectedIdx=idx;} else {if(isDir && !e.ctrlKey && state.selected.size===0){ navigateTo(path); return; }
if(state.selected.has(path) && state.selected.size===1 && !isDir){ /* preview already */ }
else { state.selected.clear(); state.selected.add(path); state.lastSelectedIdx=idx; }
if(isDir && state.selected.size===1){ /* don't navigate if ctrl */ if(!e.ctrlKey){ /* single click: select, double-click navigates */ } }}
if(!state.detailsOpen && state.selected.size===1) { /* auto open? keep closed */ }
state._focusedPath=path;renderVirtualized(false); updateSelectionUI();
if(isDir && e.detail===2){ navigateTo(path); }}els.fileContainer.addEventListener("click",e=>{const row=e.target.closest("[data-path]"); if(!row) return;
const path=row.getAttribute("data-path"); const isDir=row.getAttribute("data-dir")==="1";
if(isDir && e.detail===2){ navigateTo(path); return; }
if(row.classList.contains("check")||e.target.classList.contains("check")){ /* toggle select */ handleRowClick(e,path,isDir); return; }handleRowClick(e,path,isDir);
if(!isDir) { /* keep selection, details will show */ }
else if(!e.ctrlKey && !e.shiftKey && e.detail===1){ /* first click selects folder, second navigates */}});els.fileContainer.addEventListener("dblclick",e=>{const row=e.target.closest("[data-path]"); if(!row) return;
const path=row.getAttribute("data-path"); const isDir=row.getAttribute("data-dir")==="1";
if(isDir) navigateTo(path); else toast(`Open: ${path.split("\\").pop()}`);});els.fileContainer.addEventListener("keydown",e=>{if(e.key==="Enter"){ const r=e.target.closest("[data-path]"); if(r) r.click(); }
if(e.key==="a" && (e.ctrlKey||e.metaKey)){ e.preventDefault(); selectAll(); }});
function selectAll(){filteredFiles().forEach(f=>state.selected.add(f.path)); renderVirtualized(false); updateSelectionUI();}/* Details pane */function showDetails(file){if(!file){ els.detailsPreview.innerHTML=`<div class="empty" style="padding:16px"><div class="ico">👁</div><div>Select file</div></div>`; els.detailsProps.innerHTML=`<div class="empty" style="padding:10px;color:var(--text-3)">--</div>`; return; }
const isDir=!!file.is_dir; const ext=(file.extension||file.ext||file.name.split(".").pop()||"").toLowerCase();
let preview="";
if(!isDir && ["jpg","jpeg","png","gif","webp","bmp","heic"].includes(ext)){
  const cached=thumbCache.get("preview:"+file.path) || thumbCache.get(file.path);
  if(cached){ preview=`<img src="${cached}" alt="${esc(file.name)}" style="max-width:100%;max-height:220px;object-fit:contain" onerror="this.style.display=\'none\'">`; }
  else { preview=`<div class="ph">🖼</div><div style="font-size:11px;color:var(--text-3);margin-top:4px">Loading preview…</div>`; fetchPreview(file.path).then(url=>{ if(url && els.detailsPreview){ els.detailsPreview.innerHTML=`<img src="${url}" alt="${esc(file.name)}" style="max-width:100%;max-height:220px;object-fit:contain">`; } }); }
} else if(!isDir && ["txt","md","json","log"].includes(ext)){preview=`<div style="padding:12px;text-align:left;max-height:160px;overflow:auto;font-family:var(--mono);font-size:11px;white-space:pre-wrap;color:var(--text-2)">Preview — open file to view full content</div>`;} else {preview=`<div class="ph">${isDir?"📁":iconFor(file)}</div>`;}els.detailsPreview.innerHTML=preview;
const props=[["Name",file.name],["Path",file.path],["Type",isDir?"Folder":(ext||"File")],["Size",isDir?"—":fmtSize(file.size)],["Modified",fmtDate(file.modified)],["Extension",ext||"—"]];els.detailsProps.innerHTML=props.map(([k,v])=>`<div class="prop"><span>${esc(k)}</span><span title="${esc(String(v))}">${esc(String(v))}</span></div>`).join("")+`<button class="tbtn" style="margin-top:8px;width:100%" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(file.path).replace(/'/g,"\\'")}').then(()=>window.toast&&window.toast('Copied'))">Copy</button>`;}
function toggleDetails(open){if(typeof open==="boolean") state.detailsOpen=open; else state.detailsOpen=!state.detailsOpen;els.detailsPane.classList.toggle("hidden",!state.detailsOpen);els.detailsResizer.classList.toggle("hidden",!state.detailsOpen);els.detailsToggle.classList.toggle("active",state.detailsOpen);localStorage.setItem("fe:details",state.detailsOpen?"1":"0");
if(state.detailsOpen && state.selected.size===1){ const p=[...state.selected][0]; const f=filteredFiles().find(x=>x.path===p); if(f) showDetails(f); else showDetails(null); }}/* Context menu */let ctxTarget=null;
function buildContextMenu(file){const isDir=!!file.is_dir;
return [{label:`Open`,icon:"▶",action:()=> isDir?navigateTo(file.path):toast(`Open: ${file.name}`)},{label:"Open with…",icon:"⧉",action:()=>toast("Open with (coming soon)")},{sep:true},{label:"Copy",icon:"⧉",action:()=>{ if(navigator.clipboard) navigator.clipboard.writeText(file.path).then(()=>toast("Copied")); else toast(file.path)}},{label:"Cut",icon:"✂",action:()=>toast("Cut (coming soon)")},{label:"Delete",icon:"🗑",danger:true,action:()=>{ if(confirm(`Delete ${file.name}?`)) toast("Deleted"); }},{label:"Rename",icon:"✎",action:()=>{const n=prompt("Rename to:",file.name); if(n&&n!==file.name) { file.name=n; toast(`Renamed to ${n}`); renderVirtualized(false); showDetails(file); }}},{sep:true},{label:"Properties",icon:"◧",action:()=>{ toggleDetails(true); showDetails(file); }},];}
function showContextMenu(x,y,file){ctxTarget=file;
const items=buildContextMenu(file);els.contextMenu.innerHTML=items.map(it=> it.sep? `<div class="ctx-sep"></div>` : `<button class="ctx-item ${it.danger?"danger":""}" data-label="${esc(it.label)}"><span>${it.icon}</span>${esc(it.label)}</button>`).join("");els.contextMenu.classList.remove("hidden");
const pad=8; let left=x, top=y;els.contextMenu.style.left=left+"px"; els.contextMenu.style.top=top+"px";requestAnimationFrame(()=>{const r=els.contextMenu.getBoundingClientRect();
if(r.right>window.innerWidth-pad) left=Math.max(pad, window.innerWidth - r.width - pad);
if(r.bottom>window.innerHeight-pad) top=Math.max(pad, window.innerHeight - r.height - pad);els.contextMenu.style.left=left+"px"; els.contextMenu.style.top=top+"px";});$$(".ctx-item",els.contextMenu).forEach((btn,i)=>{const it=items.filter(x=>!x.sep)[$$(".ctx-item",els.contextMenu).indexOf(btn)] || items.find((_,idx)=> items.slice(0,idx).filter(x=>!x.sep).length===$$(".ctx-item",els.contextMenu).indexOf(btn));
const label=btn.getAttribute("data-label");
const src=items.find(x=>x.label===label);btn.onclick=()=>{ hideContextMenu(); if(src) src.action(); };});}
function hideContextMenu(){ els.contextMenu.classList.add("hidden"); ctxTarget=null; }els.fileContainer.addEventListener("contextmenu",e=>{const row=e.target.closest("[data-path]"); if(!row){ hideContextMenu(); return; }e.preventDefault();
const path=row.getAttribute("data-path"); const file=filteredFiles().find(f=>f.path===path)||state.searchResults.find(f=>f.path===path)||state.files.find(f=>f.path===path);
if(!file) return;
if(!state.selected.has(path)){ state.selected.clear(); state.selected.add(path); state._focusedPath=path; renderVirtualized(false); updateSelectionUI(); }showContextMenu(e.clientX,e.clientY,file);});window.addEventListener("click",e=>{ if(!e.target.closest("#contextMenu")) hideContextMenu(); });window.addEventListener("keydown",e=>{ if(e.key==="Escape") hideContextMenu(); });/* Search + indexed status */function showSearchUI(q,total,shown){els.searchHeader.classList.remove("hidden"); els.viewportWrap.classList.remove("hidden"); els.mediaView.classList.add("hidden"); els.mediaView.style.display="";els.searchQueryLabel.textContent=q; els.searchStats.textContent=shown===total?`${total} • ${state.searchMeta.took_ms}ms • ${state.searchMeta.indexed?"Indexed":"Indexing…"}`:`${shown} of ${total} • ${state.searchMeta.took_ms}ms • ${state.searchMeta.indexed?"Indexed":"Indexing…"}`;els.searchClear.classList.toggle("visible",!!q); els.searchMeta.textContent=q?`${total} • ${state.searchMeta.took_ms}ms`:""; els.searchMeta.style.display=q?"block":"none";}
function hideSearchUI(){ els.searchHeader.classList.add("hidden"); els.searchClear.classList.remove("visible"); els.searchMeta.style.display="none"; els.searchMeta.textContent=""; }
function clearSearch(){state.isSearching=false; state.searchQuery=""; state.searchResults=[]; state.searchTotal=0; state.searchOffset=0; state.searchMeta={took_ms:0,indexed:state.indexStatus.ready,has_more:false};hideSearchUI(); els.searchInput.value=""; renderBreadcrumbs(); renderVirtualized(true); updateCounts();els.statusText.textContent=`${state.files.length} items • ${state.path||"Home"}`;}
const doSearch=debounce(async(query)=>{const q=query.trim(); if(!q){clearSearch();
return}
state.isSearching=true; state.searchQuery=q; state.searchOffset=0; setLoading(true); showSearchUI(q,0,0); els.statusText.textContent=`Searching “${q}”…`;
try{const res=await safeInvoke("search_files",{query:q,offset:0,limit:PAGE},()=>mockSearch(q,0,PAGE));
const results=Array.isArray(res)?res:(res.results||res.entries||[]); const total=Array.isArray(res)?results.length:(res.total??results.length);state.searchMeta={took_ms:res.took_ms??0,indexed:!!res.indexed,has_more:!!res.has_more,query:res.query||q};state.searchResults=sortFiles(results,state.sort); state.searchTotal=total; state.searchOffset=results.length;showSearchUI(q,total,state.searchResults.length); setLoading(false); renderVirtualized(true);els.statusText.textContent=`Found ${total} matches for “${q}” • ${state.searchMeta.took_ms}ms • ${state.searchMeta.indexed?"Indexed":"Live"}`;}
catch(e){setLoading(false);toast("Search failed");console.error(e)}},DEBOUNCE_MS);
async function loadMoreSearch(){if(!state.isSearching) return; const q=state.searchQuery; const offset=state.searchOffset; if(offset>=state.searchTotal) return;$("#loadMoreBtn").textContent="Loading…";
try{const res=await safeInvoke("search_files",{query:q,offset,limit:PAGE},()=>mockSearch(q,offset,PAGE));
const results=Array.isArray(res)?res:(res.results||[]); const total=Array.isArray(res)?state.searchTotal:(res.total??state.searchTotal);
const sorted=sortFiles(results,state.sort); state.searchResults.push(...sorted); state.searchOffset+=results.length; state.searchTotal=total;state.searchMeta.took_ms=res.took_ms??state.searchMeta.took_ms; state.searchMeta.indexed=!!res.indexed;showSearchUI(q,total,state.searchResults.length); renderVirtualized(false);}finally{$("#loadMoreBtn").textContent="Load more (next 100)"}}
async function fetchIndexStatus(){const s=await safeInvoke("get_index_status",{}, {ready:false,building:true,size:0});state.indexStatus={ready:!!s.ready,building:!!s.building,size:s.size||0};
const meta= state.indexStatus.ready? `Indexed ${state.indexStatus.size.toLocaleString()} • ${state.searchMeta.took_ms||0}ms` : (state.indexStatus.building? "Indexing…":"No index");
if(!state.isSearching){ els.searchMeta.textContent= state.indexStatus.ready? `${state.indexStatus.size.toLocaleString()} indexed` : meta; els.searchMeta.style.display="block"; els.searchMeta.style.opacity=".7"; setTimeout(()=>{ if(!state.isSearching && !els.searchInput.value) els.searchMeta.style.display="none"},3000); }
if(els.statusRight) els.statusRight.textContent= state.indexStatus.ready? `Indexed ${state.indexStatus.size.toLocaleString()} • lite` : "Indexing… • lite";
return state.indexStatus;}/* Media *//* Media � People with Immich/Google Photos labeling */
let peopleFilterText="";
async function loadMediaPeople(force=false){
  if(state.mediaPeople && !force) return state.mediaPeople;
  const grid=els.peopleGrid;
  const empty=document.getElementById("peopleEmpty");
  if(grid) grid.innerHTML=`<div style="padding:24px;text-align:center;color:var(--text-3)"><span class="spinner"></span> Detecting faces� (up to 120 images, ~1-2s)</div>`;
  if(empty) empty.classList.add("hidden");
  try{
    const res=await safeInvoke("get_media_groups",{root:state.path||""},mockMediaPeople);
    let groups=Array.isArray(res)?res:(res.groups||res.people||res||mockMediaPeople());
    groups=groups.map(g=>{
      const label=g.label||g.name||g.key||"Unknown";
      const key=g.key||g.id||label;
      const count=g.count??g.face_count??1;
      const preview=g.preview||(g.path?[g.path]:[]);
      const cover=g.cover||(g.face_count?"??":"??");
      const path=g.path||preview[0]||"";
      return {...g,label,key,name:label,count,preview,cover,path,face_count:g.face_count,total_size:g.total_size};
    });
    state.mediaPeople=groups;
    renderMediaPeople();
  }catch(e){
    console.error("loadMediaPeople",e);
    toast("People load failed");
    if(grid) grid.innerHTML=`<div style="padding:16px;color:var(--text-3)">Failed to detect faces � showing folder fallback</div>`;
  }
  return state.mediaPeople;
}
async function loadMediaDevices(){if(state.mediaDevices) return state.mediaDevices; const res=await safeInvoke("get_device_groups",{},mockDeviceGroups); if(res&&res.by_drive) state.mediaDevices=res; else if(Array.isArray(res)) state.mediaDevices={by_drive:res,by_type:[]}; else state.mediaDevices=mockDeviceGroups(); renderMediaDevices(); return state.mediaDevices}
function renderMediaPeople(){
  const groupsAll=state.mediaPeople||[];
  const pc=document.getElementById("peopleCount");
  if(pc) pc.textContent=groupsAll.length+" groups";
  const filterEl=document.getElementById("peopleFilter");
  const filter=(filterEl?.value||peopleFilterText||"").toLowerCase().trim();
  let groups=groupsAll;
  if(filter){
    groups=groupsAll.filter(g=>{
      const lbl=(g.label||g.name||"").toLowerCase();
      const key=(g.key||"").toLowerCase();
      return lbl.includes(filter)||key.includes(filter);
    });
  }
  if(!groupsAll.length){
    els.peopleGrid.innerHTML="";
    const pe=document.getElementById("peopleEmpty");
    if(pe) pe.classList.remove("hidden");
    return;
  }
  const pe2=document.getElementById("peopleEmpty");
  if(pe2) pe2.classList.add("hidden");
  if(!groups.length){
    els.peopleGrid.innerHTML=`<div style="padding:16px;color:var(--text-3);text-align:center">No people match �${esc(filter)}�</div>`;
    return;
  }
  els.peopleGrid.innerHTML=groups.map(g=>{
    const label=g.label||g.name||"Unknown";
    const count=g.count||0;
    const preview=g.preview||[];
    const cover=g.cover||(g.face_count?"??":"??");
    const isFace=g.face_count!=null;
    const isDefaultPerson=/^Person \d+$/.test(label);
    const isUnlabeled=isFace && isDefaultPerson;
    const avatarKey=g.key||label;
    const firstPreview=preview[0]||"";
    // thumbnail handling: use cached thumb if available, else placeholder and async fetch
    const cached=firstPreview? thumbCache.get(firstPreview):null;
    let avatarInner="";
    if(cached){
      avatarInner=`<img src="${cached}" alt="${esc(label)}" loading="lazy">`;
    } else if(firstPreview){
      // trigger async load
      if(!thumbCache.has(firstPreview) && !thumbPending.has(firstPreview)){
        fetchThumb(firstPreview).then(url=>{ if(url) renderMediaPeople(); });
      }
      avatarInner=`<span>${esc(cover)}</span>`;
    } else {
      avatarInner=`<span>${esc(cover)}</span>`;
    }
    const previewStrip=preview.slice(0,4).map(p=>{
      const c=thumbCache.get(p);
      if(c) return `<img src="${c}" title="${esc(p)}">`;
      return `<span style="width:28px;height:28px;border-radius:6px;background:var(--bg-3);border:1px solid var(--border);display:grid;place-items:center;font-size:10px">??</span>`;
    }).join("");
    // queue remaining thumbs
    preview.forEach(pp=>{
      if(!thumbCache.has(pp) && !thumbPending.has(pp)) fetchThumb(pp);
    });
    return `<div class="person-card ${isUnlabeled?"unlabeled":"labeled"}" data-key="${esc(avatarKey)}" data-path="${esc(firstPreview)}" tabindex="0" role="button" title="${esc(label)} � ${count} photos">
      <div class="person-avatar-wrap">
        <div class="person-avatar ${isFace?"face":""}">${avatarInner}</div>
        <button class="person-edit-btn" data-edit="${esc(avatarKey)}" title="Rename ${esc(label)}">?</button>
      </div>
      <div class="person-name" data-label="${esc(avatarKey)}">${esc(label)} ${isUnlabeled?`<span class="unlabeled">� Unlabeled</span>`:""}</div>
      <div class="person-meta">${count} photos${isFace?` � Faces`:""}${g.total_size?` � ${(g.total_size/1024/1024).toFixed(1)} MB`:""}</div>
      <div class="person-inline-edit hidden" data-edit-wrap="${esc(avatarKey)}"><input type="text" placeholder="Name e.g. John" value="${isUnlabeled?"":esc(label)}" maxlength="48" data-input="${esc(avatarKey)}"><button data-save="${esc(avatarKey)}">Save</button><button data-cancel="${esc(avatarKey)}">?</button></div>
      <div class="person-preview-strip" style="${previewStrip?"":"display:none"}">${previewStrip}</div>
      ${isUnlabeled?`<div style="font-size:11px;color:var(--accent);margin-top:2px">Click ? to label</div>`:""}
    </div>`;
  }).join("");

  // Bind events: pencil -> inline edit, save/cancel, card click -> browse
  $(".person-edit-btn", els.peopleGrid).forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const key=btn.getAttribute("data-edit");
      const wrap=els.peopleGrid.querySelector(`[data-edit-wrap="${CSS.escape(key)}"]`);
      if(!wrap) return;
      wrap.classList.remove("hidden");
      const inp=wrap.querySelector("input");
      if(inp){ inp.focus(); inp.select(); }
      btn.style.display="none";
    });
  });
  $("[data-save]", els.peopleGrid).forEach(btn=>{
    btn.addEventListener("click", async e=>{
      e.stopPropagation();
      const key=btn.getAttribute("data-save");
      const wrap=els.peopleGrid.querySelector(`[data-edit-wrap="${CSS.escape(key)}"]`);
      const inp=wrap?.querySelector("input");
      const newName=(inp?.value||"").trim();
      if(!newName){
        toast("Enter a name");
        inp?.focus();
        return;
      }
      btn.textContent="�";
      try{
        const saved=await invoke("rename_person", {personKey:key, label:newName});
        // update state
        const g=state.mediaPeople.find(x=>x.key===key);
        if(g) g.label=saved||newName;
        toast(`Renamed to ${newName}`);
        renderMediaPeople();
      }catch(err){
        toast("Rename failed: "+(err?.message||err));
        btn.textContent="Save";
      }
    });
  });
  $("[data-cancel]", els.peopleGrid).forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const key=btn.getAttribute("data-cancel");
      const wrap=els.peopleGrid.querySelector(`[data-edit-wrap="${CSS.escape(key)}"]`);
      if(wrap) wrap.classList.add("hidden");
      const editBtn=els.peopleGrid.querySelector(`[data-edit="${CSS.escape(key)}"]`);
      if(editBtn) editBtn.style.display="";
    });
  });
  // Enter/Escape in inputs
  $("[data-input]", els.peopleGrid).forEach(inp=>{
    inp.addEventListener("keydown", e=>{
      const key=inp.getAttribute("data-input");
      if(e.key==="Enter"){
        e.preventDefault();
        els.peopleGrid.querySelector(`[data-save="${CSS.escape(key)}"]`)?.click();
      } else if(e.key==="Escape"){
        e.preventDefault();
        els.peopleGrid.querySelector(`[data-cancel="${CSS.escape(key)}"]`)?.click();
      }
    });
    inp.addEventListener("click", e=> e.stopPropagation());
  });

  // Card click -> browse person photos (Immich: click person -> grid of photos)
  els.peopleGrid.onclick=(e)=>{
    const saveBtn=e.target.closest("[data-save]");
    const cancelBtn=e.target.closest("[data-cancel]");
    const editBtn=e.target.closest("[data-edit]");
    if(saveBtn||cancelBtn||editBtn) return;
    if(e.target.closest(".person-inline-edit")) return;
    const card=e.target.closest(".person-card");
    if(!card) return;
    const key=card.getAttribute("data-key");
    const g=state.mediaPeople.find(x=>x.key===key);
    if(!g) return;
    // Prefer preview paths: show filtered explorer with that person's photos
    if(g.preview && g.preview.length){
      // If at least one preview has a real folder, navigate there; otherwise show filtered grid
      const first=g.preview[0];
      const folder=first.replace(/[\\/][^\\/]+$/, "");
      // Immich behavior: clicking shows all photos of person � we simulate by filtering explorer
      showExplorer();
      // Build fake file entries for preview strip so user instantly sees person's photos (like Immich detail)
      const files=g.preview.map(p=>({name:p.split("\\").pop()||p.split("/").pop()||p, path:p, is_dir:false, size:0, modified:"", extension:(p.split(".").pop()||"").toLowerCase()}));
      // Also include full cluster if we had more � for demo, show previews only with note
      toast(`${g.label}: ${g.count} photos � opening ${folder}`);
      // Navigate to folder which will list real files; as instant feedback show preview files first
      state.files=files;
      renderVirtualized(true);
      updateCounts();
      // Then load actual folder contents async
      navigateTo(folder);
    } else if(g.path){
      showExplorer();
      navigateTo(g.path);
    }
  };
  // Also allow Enter on focused card
  els.peopleGrid.onkeydown=(e)=>{
    if(e.key==="Enter"){
      const card=e.target.closest(".person-card");
      if(card) card.click();
    }
  };
}function renderMediaDevices(){const d=state.mediaDevices||mockDeviceGroups(); const byDrive=d.by_drive||[]; const byType=d.by_type||[];$("#devicesCount").textContent=byDrive.length+" volumes";els.devicesGrid.innerHTML=byDrive.map(v=>`<div class="group-card"><div class="cover">${esc(v.icon||"💾")}</div><div class="info"><div class="name">${esc(v.label||v.drive)}</div><div class="sub">${v.count} files • ${esc(v.type||"")}</div></div></div>`).join("");els.deviceMetaGrid.innerHTML=byType.map(v=>`<div class="group-card"><div class="cover">${esc(v.icon||"🖼")}</div><div class="info"><div class="name">${esc(v.label)}</div><div class="sub">${v.count} • ${esc(v.meta||"")}</div></div></div>`).join("");}/* View / Navigation */function setView(v){state.view=v;localStorage.setItem("fe:view",v);$("#viewListBtn").classList.toggle("active",v==="list");$("#viewGridBtn").classList.toggle("active",v==="grid");
if(els.layoutInfo) els.layoutInfo.textContent=`${v==="grid"?"Grid":"List"} • ${state.group==="none"?"No group":"Group: "+state.group}`;renderVirtualized(true)}
function showExplorer(){els.viewportWrap.classList.remove("hidden");els.mediaView.classList.add("hidden");els.mediaView.style.display=""}
function showMedia(tab="people"){els.viewportWrap.classList.add("hidden");els.mediaView.classList.remove("hidden");els.mediaView.style.display="flex";els.searchHeader.classList.add("hidden");$$(".media-tab").forEach(b=>{const is=b.getAttribute("data-tab")===tab; b.classList.toggle("active",is); b.setAttribute("aria-selected",String(is))});$("#peopleTab").classList.toggle("hidden",tab!=="people");$("#devicesTab").classList.toggle("hidden",tab!=="devices");
if(tab==="people") loadMediaPeople(); else loadMediaDevices()}/* Command palette */const paletteActions=[{id:"go-c",label:"Go to C:\\",desc:"Go C:",icon:"💾",run:()=>navigateTo("C:\\")},{id:"go-d",label:"Go to D:\\",desc:"Go D:",icon:"💾",run:()=>navigateTo("D:\\")},{id:"go-home",label:"Go Home",desc:"Home",icon:"⌂",run:()=>navigateTo("")},{id:"search",label:"Search…",desc:"Search",icon:"⌕",run:()=>els.searchInput.focus()},{id:"new-folder",label:"Create folder",desc:"New folder",icon:"📁",run:()=>els.newFolderBtn.click()},{id:"toggle-theme",label:"Toggle theme",desc:"Theme",icon:"◐",run:()=>$("#themeBtn").click()},{id:"toggle-details",label:"Pane",desc:"Pane",icon:"◧",run:()=>toggleDetails()},{id:"rebuild-index",label:"Rebuild",desc:"Rebuild",icon:"⟳",run:async()=>{toast("Rebuilding index…"); await safeInvoke("rebuild_index",{}, {rebuilding:true}); fetchIndexStatus();}},{id:"list-view",label:"List view",desc:"List",icon:"☰",run:()=>setView("list")},{id:"grid-view",label:"Grid view",desc:"Grid",icon:"▦",run:()=>setView("grid")},{id:"select-all",label:"Select all",desc:"Select all",icon:"☑",run:()=>selectAll()},{id:"refresh",label:"Refresh",desc:"Refresh",icon:"↻",run:()=>loadDir(state.path)},];
let paletteIdx=0, paletteFiltered=[];
function fuzzyScore(q,label){if(!q) return 1; const a=q.toLowerCase(), b=label.toLowerCase(); if(b.includes(a)) return 2; let ai=0; for(let ch of b){ if(ch===a[ai]) ai++; if(ai===a.length) return 1; } return 0;}
function renderPalette(filter=""){const q=filter.trim().toLowerCase();
let list=paletteActions;
if(filter.includes(":\\")||filter.startsWith("C")||filter.startsWith("D")){list=[{id:"go-custom",label:`Go to ${filter}`,desc:"Navigate to path",icon:"→",run:()=>navigateTo(filter)}, ...list];}
if(q){ list=list.map(a=>({...a,_s:fuzzyScore(q,a.label+" "+a.desc)})).filter(x=>x._s>0).sort((a,b)=>b._s-a._s); }paletteFiltered=list; paletteIdx=0;els.cmdList.innerHTML=list.map((a,i)=>`<div class="cmd-item ${i===paletteIdx?"active":""}" data-idx="${i}"><span class="icon">${a.icon}</span><span class="label"><strong>${esc(a.label)}</strong><small>${esc(a.desc)}</small></span></div>`).join("") || `<div style="padding:16px;color:var(--text-3)">No commands</div>`;$$(".cmd-item",els.cmdList).forEach(el=> el.addEventListener("click",()=>{ const idx=Number(el.dataset.idx); paletteIdx=idx; execPalette(); }));}
function openPalette(){ els.commandPalette.classList.remove("hidden"); els.cmdInput.value=""; els.cmdInput.focus(); renderPalette(""); }
function closePalette(){ els.commandPalette.classList.add("hidden"); paletteFiltered=[]; }
function execPalette(){ const a=paletteFiltered[paletteIdx]; if(a){ closePalette(); a.run(); }}/* Resizers */function bindResizer(resizer, target, prop, min, max){let dragging=false, startX=0, startW=0;
const onMove=e=>{if(!dragging) return;
const dx=e.clientX - startX;
let w=startW + (prop==="width"? dx : -dx); // for left sidebar +, for right details we handle separately
w=Math.max(min,Math.min(max,w));target.style.width=w+"px";target.style.minWidth=w+"px";target.style.maxWidth=w+"px";document.documentElement.style.setProperty(prop==="width"?"--sidebar-w":"--details-w", w+"px");};
const onUp=()=>{ dragging=false; resizer.classList.remove("dragging"); window.removeEventListener("mousemove",onMove); window.removeEventListener("mouseup",onUp); document.body.style.userSelect=""; };resizer.addEventListener("mousedown",e=>{dragging=true; startX=e.clientX; startW=target.getBoundingClientRect().width; resizer.classList.add("dragging"); document.body.style.userSelect="none";window.addEventListener("mousemove",onMove); window.addEventListener("mouseup",onUp); e.preventDefault();});}/* Boot events */function bindEvents(){bindBreadcrumbs();renderTabBar();
if(els.newTabBtn) els.newTabBtn.onclick=()=>newTab("");
if(els.tabList) els.tabList.onclick=e=>{const close=e.target.closest("[data-close]"); if(close){ closeTab(Number(close.dataset.close),e); return; }
const tab=e.target.closest(".tab"); if(tab) switchTab(Number(tab.dataset.tab));};els.drivesList.addEventListener("click",e=>{const b=e.target.closest("[data-drive]"); if(b) navigateTo(b.getAttribute("data-drive"))});$$("[data-nav]").forEach(btn=>{btn.addEventListener("click",()=>{$$("[data-nav]").forEach(x=>x.classList.remove("active")); btn.classList.add("active");
const nav=btn.getAttribute("data-nav");
if(nav==="home"||nav==="recent"){ showExplorer(); navigateTo(""); }
else if(nav==="media") showMedia("people"); else if(nav==="people") showMedia("people"); else if(nav==="devices") showMedia("devices");
else if(["images","videos","docs"].includes(nav)){ showExplorer(); toast(`Filter: ${nav} (backend TODO)`); }closeSidebar();});});$$(".media-tab").forEach(b=> b.addEventListener("click",()=> showMedia(b.getAttribute("data-tab"))));
  // People filter (Immich-like search) + redetect
  const pf=document.getElementById("peopleFilter");
  if(pf){
    pf.addEventListener("input", debounce(e=>{ peopleFilterText=e.target.value; renderMediaPeople(); }, 150));
    pf.addEventListener("keydown", e=>{ if(e.key==="Escape"){ e.target.value=""; peopleFilterText=""; renderMediaPeople(); }});
  }
  const pr=document.getElementById("peopleRefreshBtn");
  if(pr) pr.addEventListener("click", async ()=>{
    state.mediaPeople=null;
    toast("Re-detecting faces�");
    await loadMediaPeople(true);
  });els.searchInput.addEventListener("input",e=>{ const v=e.target.value; els.searchClear.classList.toggle("visible",!!v); if(!v) clearSearch(); else doSearch(v); });els.searchClear.addEventListener("click",()=>clearSearch());$("#clearSearchBtn").addEventListener("click",()=>clearSearch());$("#loadMoreBtn").addEventListener("click",()=>{if(state.isSearching) loadMoreSearch(); else toast("Showing first 400 — scroll virtualized list for all");});$("#viewListBtn").addEventListener("click",()=>setView("list"));$("#viewGridBtn").addEventListener("click",()=>setView("grid"));
if(els.groupSelect){ els.groupSelect.value=state.group; els.groupSelect.addEventListener("change",e=>{ state.group=e.target.value; localStorage.setItem("fe:group",state.group); renderVirtualized(true); if(els.layoutInfo) els.layoutInfo.textContent=`${state.view==="grid"?"Grid":"List"} • ${state.group==="none"?"No group":"Group: "+state.group}`; }); }
if(els.selectAllBtn) els.selectAllBtn.onclick=selectAll;
if(els.newFolderBtn) els.newFolderBtn.onclick=()=>{ const name=prompt("New folder name:","New folder"); if(name){ toast(`Create "${name}"`); const fake={name,path:(state.path||"C:\\")+"\\"+name,is_dir:true,size:0,modified:new Date().toISOString().slice(0,10),extension:"folder"}; state.files.unshift(fake); state.files=sortFiles(state.files,state.sort); renderVirtualized(true); updateCounts(); }};
if(els.hiddenToggle){ els.hiddenToggle.checked=state.showHidden; els.hiddenToggle.onchange=e=>{ state.showHidden=e.target.checked; localStorage.setItem("fe:showHidden", state.showHidden?"1":"0"); renderVirtualized(true); updateCounts(); }; }
if(els.detailsToggle) els.detailsToggle.onclick=()=>toggleDetails();
if(els.detailsClose) els.detailsClose.onclick=()=>toggleDetails(false);
if(els.rebuildIndexBtn) els.rebuildIndexBtn.onclick=async()=>{ toast("Rebuilding index…"); await safeInvoke("rebuild_index",{}, {rebuilding:true}); fetchIndexStatus(); };els.sortSelect.value=state.sort;els.sortSelect.addEventListener("change",e=>{state.sort=e.target.value; localStorage.setItem("fe:sort",state.sort);
if(state.isSearching){ state.searchResults=sortFiles(state.searchResults,state.sort); renderVirtualized(false); }
else { state.files=sortFiles(state.files,state.sort); renderVirtualized(false); }});$("#backBtn").addEventListener("click",()=>{if(state.isSearching){ clearSearch(); return; }
const prev=state.history.pop(); if(prev!==undefined){ state.path=prev; renderBreadcrumbs(); loadDir(prev); }});$("#upBtn").addEventListener("click",()=>{if(state.isSearching){ clearSearch(); return; }
const p=state.path.replace(/\\[^\\]*\\?$/,""); const up=p||""; const normalized=up==="C:"?"C:\\":up; if(normalized!==state.path) navigateTo(normalized);});$("#refreshBtn").addEventListener("click",()=>{ if(state.isSearching) doSearch(state.searchQuery); else loadDir(state.path); loadDrives(); fetchIndexStatus(); });window.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="k"){ e.preventDefault(); els.searchInput.focus(); }
if((e.ctrlKey||e.metaKey)&& e.shiftKey && e.key.toLowerCase()==="p"){ e.preventDefault(); if(els.commandPalette.classList.contains("hidden")) openPalette(); else closePalette(); }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="t"){ e.preventDefault(); newTab(state.path); }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="w"){ e.preventDefault(); closeTab(state.activeTabId); }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="l"){ e.preventDefault(); enterAddressEdit(); }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="a" && document.activeElement===els.fileViewport){ e.preventDefault(); selectAll(); }
if(e.key==="Escape" && state.isSearching) clearSearch();
if(e.key==="Escape" && !els.commandPalette.classList.contains("hidden")){ e.preventDefault(); closePalette(); }
if(e.key==="Escape" && els.addressInput && !els.addressInput.classList.contains("hidden")) exitAddressEdit(true);
if(e.key==="Delete" && state.selected.size>0 && document.activeElement===els.fileViewport){ if(confirm(`Delete ${state.selected.size} items?`)) toast("Deleted"); }});
if(els.cmdInput){els.cmdInput.addEventListener("input",e=> renderPalette(e.target.value));els.cmdInput.addEventListener("keydown",e=>{if(e.key==="ArrowDown"){ e.preventDefault(); paletteIdx=Math.min(paletteIdx+1, paletteFiltered.length-1); renderPalette(els.cmdInput.value); els.cmdList.children[paletteIdx]?.scrollIntoView({block:"nearest"}); $$(".cmd-item",els.cmdList).forEach((el,i)=>el.classList.toggle("active",i===paletteIdx)); }
else if(e.key==="ArrowUp"){ e.preventDefault(); paletteIdx=Math.max(0,paletteIdx-1); renderPalette(els.cmdInput.value); $$(".cmd-item",els.cmdList).forEach((el,i)=>el.classList.toggle("active",i===paletteIdx)); }
else if(e.key==="Enter"){ e.preventDefault(); execPalette(); }
else if(e.key==="Escape"){ e.preventDefault(); closePalette(); }});}
if(els.commandPalette){els.commandPalette.querySelector(".cmd-backdrop").addEventListener("click",closePalette);}$("#themeBtn").addEventListener("click",()=>{const cur=document.documentElement.getAttribute("data-theme");
const next=cur==="dark"?"light":cur==="light"?"dark":(matchMedia("(prefers-color-scheme: dark)").matches?"light":"dark");document.documentElement.setAttribute("data-theme",next); localStorage.setItem("fe:theme",next);});$("#sidebarToggle").addEventListener("click",()=>{ els.sidebar.classList.toggle("open"); els.overlay.classList.toggle("show"); });els.overlay.addEventListener("click",closeSidebar);
if(els.zoomLabel){function applyZoom(){ document.documentElement.style.fontSize=state.zoom+"%"; els.zoomLabel.textContent=state.zoom+"%"; }
window.addEventListener("wheel",e=>{ if(e.ctrlKey){ e.preventDefault(); state.zoom=Math.max(75,Math.min(150, state.zoom + (e.deltaY<0?5:-5))); applyZoom(); }},{passive:false});els.zoomLabel.onclick=()=>{ state.zoom=100; applyZoom(); toast("Zoom 100%"); };}
if(els.sidebarResizer && els.sidebar) bindResizer(els.sidebarResizer, els.sidebar, "width", 180, 420);
if(els.detailsResizer && els.detailsPane){let dragging=false, startX=0, startW=0;
const onMove=e=>{ if(!dragging) return; const dx=startX - e.clientX; let w=startW + dx; w=Math.max(220,Math.min(420,w)); els.detailsPane.style.width=w+"px"; els.detailsPane.style.minWidth=w+"px"; };
const onUp=()=>{ dragging=false; els.detailsResizer.classList.remove("dragging"); window.removeEventListener("mousemove",onMove); window.removeEventListener("mouseup",onUp); };els.detailsResizer.addEventListener("mousedown",e=>{ dragging=true; startX=e.clientX; startW=els.detailsPane.getBoundingClientRect().width; els.detailsResizer.classList.add("dragging"); window.addEventListener("mousemove",onMove); window.addEventListener("mouseup",onUp); e.preventDefault(); });}}
function closeSidebar(){els.sidebar.classList.remove("open");els.overlay.classList.remove("show")}
function restoreTheme(){const saved=localStorage.getItem("fe:theme"); if(saved) document.documentElement.setAttribute("data-theme",saved)}restoreTheme(); bindEvents(); setView(state.view); renderBreadcrumbs();
if(state.detailsOpen) toggleDetails(true); else { els.detailsPane.classList.add("hidden"); els.detailsResizer.classList.add("hidden"); }
if(els.groupSelect) els.groupSelect.value=state.group;
if(els.hiddenToggle) els.hiddenToggle.checked=state.showHidden;Promise.allSettled([loadDrives(), loadDir("")]).then(()=>{ if(!state.drives.length) renderDrives(); });loadMediaPeople().catch(()=>{}); loadMediaDevices().catch(()=>{});fetchIndexStatus();setInterval(fetchIndexStatus, 3000);setTimeout(()=>{ if(els.drivesList && els.drivesList.textContent.includes("Loading drives")){ console.warn("drives timeout — forcing mock"); state.drives=mockDrives().map(d=>({name:d.name,path:d.mount_point,mount_point:d.mount_point,total_space:d.total_space,free_space:d.free_space,type:d.type,used:d.used})); renderDrives(); }},1500);window.__explorer={state, navigateTo, loadDir, doSearch};window.toast=toast;