let ROW_H=(window.PiSettings&&PiSettings.rowHeight())||36; const BUFFER=12,PAGE=100,DEBOUNCE_MS=200;
// Settings bridge (settings.js): read a preference with a fallback.
const THEMES=["fluent-dark","fluent-light","material-dark","material-light"];
const pref=(k,d)=>{ try{ const v=window.PiSettings&&PiSettings.get(k); return v===undefined?d:v; }catch{ return d; } };
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const els={sidebar:$("#sidebar"),overlay:$("#overlay"),drivesList:$("#drivesList"),storageBar:$("#storageBar"),storageFill:$("#storageFill"),breadcrumbBar:$("#breadcrumbBar"),breadcrumbView:$("#breadcrumbView"),addressInput:$("#addressInput"),addressGo:$("#addressGo"),addressEditBtn:$("#addressEditBtn"),addressCopyBtn:$("#addressCopyBtn"),fileViewport:$("#fileViewport"),fileSpacer:$("#fileSpacer"),fileContainer:$("#fileContainer"),emptyState:$("#emptyState"),itemCount:$("#itemCount"),pathLabel:$("#pathLabel"),loadingLabel:$("#loadingLabel"),statusText:$("#statusText"),statusRight:$("#statusRight"),layoutInfo:$("#layoutInfo"),zoomLabel:$("#zoomLabel"),searchInput:$("#searchInput"),searchClear:$("#searchClear"),searchMeta:$("#searchMeta"),searchHeader:$("#searchHeader"),searchQueryLabel:$("#searchQueryLabel"),searchStats:$("#searchStats"),viewportWrap:$("#viewportWrap"),mediaView:$("#mediaView"),peopleTab:$("#peopleTab"),devicesTab:$("#devicesTab"),peopleGrid:$("#peopleGrid"),devicesGrid:$("#devicesGrid"),deviceMetaGrid:$("#deviceMetaGrid"),loadMoreWrap:$("#loadMoreWrap"),sortSelect:$("#sortSelect"),groupSelect:$("#groupSelect"),selectAllBtn:$("#selectAllBtn"),newFolderBtn:$("#newFolderBtn"),detailsToggle:$("#detailsToggle"),toast:$("#toast"),tabBar:$("#tabBar"),tabList:$("#tabList"),newTabBtn:$("#newTabBtn"),detailsPane:$("#detailsPane"),detailsResizer:$("#detailsResizer"),sidebarResizer:$("#sidebarResizer"),detailsContent:$("#detailsContent"),detailsPreview:$("#detailsPreview"),detailsProps:$("#detailsProps"),detailsClose:$("#detailsClose"),detailsCount:$("#detailsCount"),detailsPreviewTab:$("#detailsPreviewTab"),detailsPropsTab:$("#detailsPropsTab"),commandPalette:$("#commandPalette"),cmdInput:$("#cmdInput"),cmdList:$("#cmdList"),contextMenu:$("#contextMenu"),selectionCount:$("#selectionCount"),selectionInfo:$("#selectionInfo"),hiddenToggle:$("#hiddenToggle"),rebuildIndexBtn:$("#rebuildIndexBtn"),viewerModal:$("#viewerModal"),viewerBackdrop:$("#viewerBackdrop"),viewerContent:$("#viewerContent"),viewerTitle:$("#viewerTitle"),viewerMeta:$("#viewerMeta"),viewerClose:$("#viewerClose"),viewerOpenExternal:$("#viewerOpenExternal"),viewerMovePerson:$("#viewerMovePerson"),themeSelect:$("#themeSelect"),forwardBtn:$("#forwardBtn"),newBtn:$("#newBtn"),cutBtn:$("#cutBtn"),copyBtn:$("#copyBtn"),pasteBtn:$("#pasteBtn"),deleteBtn:$("#deleteBtn"),renameBtn:$("#renameBtn"),fileHeader:$("#fileHeader"),filterBtn:$("#filterBtn"),splitViewBtn:$("#splitViewBtn"),};
let state={path:"",history:[],files:[],view:localStorage.getItem("fe:view")||"list",sort:localStorage.getItem("fe:sort")||"name-asc",group:localStorage.getItem("fe:group")||"none",showHidden:localStorage.getItem("fe:showHidden")==="1",detailsOpen:localStorage.getItem("fe:details")==="1",detailsMode:(()=>{const m=localStorage.getItem("fe:detailsMode"); if(m==="preview"||m==="details"||m==="hidden") return m; return localStorage.getItem("fe:details")==="1" ? "preview" : "hidden";})(),_lastDetailsTab:(()=>{const m=localStorage.getItem("fe:detailsMode"); return (m==="preview"||m==="details")?m:"preview";})(),searchQuery:"",searchResults:[],searchTotal:0,searchOffset:0,isSearching:false,searchMeta:{took_ms:0,indexed:false,has_more:false},tagMode:null,tagOffset:0,tagTotal:0,tagQuery:"",tagHasMore:false,tagTookMs:0,drives:[],mediaPeople:null,mediaDevices:null,peopleSelection:new Set(),tabs:[{id:1,loc:{k:"home"},back:[],fwd:[],title:"Home",scroll:0}],activeTabId:1,nextTabId:2,loc:{k:"home"},navToken:0,dirToken:0,knownFolders:{},selected:new Set(),lastSelectedIdx:-1,zoom:100,indexStatus:{ready:false,building:true,size:0}};
let virt={scrollTop:0,raf:0};
// --- Operation view + clipboard (fast copy/paste rivals native, multi-threaded via ops.rs) ---
const clipboard={op:null,sources:[]};
let currentOpId=null;
function hideOpView(){}
function isOpVisible(){ return false; }
async function listenOpProgress(){
  try{
    const evApi= window.__TAURI__?.event || window.__TAURI__?.core?.event;
    // Tauri v2: window.__TAURI__.event.listen
    let listenFn=null;
    if(window.__TAURI__?.event?.listen) listenFn=window.__TAURI__.event.listen;
    else if(window.__TAURI__?.core?.event?.listen) listenFn=window.__TAURI__.core.event.listen;
    // Also try @tauri-apps/api/event dynamic import
    if(!listenFn){
      try{ const mod=await import(/* @vite-ignore */ "@tauri-apps/api/event"); if(mod.listen) listenFn=mod.listen; }catch{}
    }
    if(!listenFn) return;
    await listenFn("op://progress", (event)=>{
      const p=event.payload||event;
      if(!p||!p.id) return;
      // Folder size calc progress - emitted from get_folder_size (full walk, no 2000 cap)
      // Frontend shows "Calculating... 1,234 files • 2.1 GB" in details pane, not operationView
      if(p.op==="size" || p.op==="folder_size"){
        const path = p.path || (typeof p.id==="string" && p.id.startsWith("size:") ? p.id.slice(5) : null) || p.file;
        if(!path) return;
        const bytes = p.bytes ?? p.bytes_copied ?? p.total_bytes ?? 0;
        const files = p.current ?? 0;
        const done = !!p.done;
        if(!done){
          // interim: keep loading=true so fetchFolderSize doesn't overwrite, store progress for tooltip - include timestamp so TTL logic stays correct
          const cur = folderSizeCache.get(path) || {size:null, loading:true, timestamp: Date.now()};
          folderSizeCache.set(path, {size: bytes, loading:true, files, bytes, timestamp: cur.timestamp || Date.now()});
          const el=document.getElementById("folder-size-val");
          paintFolderSize(path,{size:bytes},true);
          if(el && el.dataset.for===path){
            // Show spec: "Calculating... 1,234 files • 2.1 GB"
            try{ el.textContent=`Calculating... ${Number(files).toLocaleString()} files \u2022 ${fmtSize(bytes)}`; }catch{ el.textContent=`Calculating... ${files} files \u2022 ${fmtSize(bytes)}`; }
            el.style.color="var(--text-3)";
          }
          // row tooltip interim
          try{
            const escPath=(window.CSS&&window.CSS.escape?window.CSS.escape(path):path);
            const row=document.querySelector(`[data-path="${escPath}"]`);
            if(row){
              const f=state.files.find(x=>x.path===path) || filteredFiles().find(x=>x.path===path);
              const tip=f ? fmtFolderTooltip(f, {size:bytes, loading:true}) : `Folder \u2022 ${files} files \u2022 ${fmtSize(bytes)}`;
              row.title=tip;
            }
          }catch{}
        } else {
          if(p.error){
            folderSizeCache.set(path,{size:null, loading:false, error:String(p.error), timestamp: Date.now()});
            const el=document.getElementById("folder-size-val");
            if(el && el.dataset.for===path) { el.textContent="-"; el.style.color=""; }
            paintFolderSize(path,{error:p.error});
          } else {
            // final will also be set by fetchFolderSize resolver; set here for immediate paint - timestamp marks fresh (<5min) so next hover/selection stays put
            const finalBytes = Number(bytes)||0;
            folderSizeCache.set(path,{size:finalBytes, loading:false, files, bytes:finalBytes, timestamp: Date.now()});
            paintFolderSize(path,{size:finalBytes});
            try{
              const f=state.files.find(x=>x.path===path) || filteredFiles().find(x=>x.path===path);
              if(f){
                const cached=folderSizeCache.get(path);
                const escPath=(window.CSS&&window.CSS.escape?window.CSS.escape(path):path);
                const row=document.querySelector(`[data-path="${escPath}"]`);
                if(row){
                  row.title=fmtFolderTooltip(f,cached);
                  const se=row.querySelector(".f-size");
                  if(se) se.title=fmtFolderTooltip(f,cached);
                }
              }
            }catch{}
          }
        }
        return;
      }
    });
  }catch(e){ console.error("op listen failed",e); }
}
listenOpProgress();
function copySelectionToClipboard(op){
  const sel=[...state.selected]; if(sel.some(p=>/^[A-Za-z]:[\\/]?$/.test(p))){ toast("Drives can’t be cut or copied - open the drive and select its contents"); return; }
  if(!sel.length){ toast("Select something first"); return; }
  clipboard.op=op; clipboard.sources=sel.slice();
  $$("#fileContainer .cut-pending").forEach(el=>el.classList.remove("cut-pending"));
  if(op==="cut") sel.forEach(p=>els.fileContainer.querySelector(`[data-path="${CSS.escape(p)}"]`)?.classList.add("cut-pending"));
  toast(`${op==="cut"?"Cut":"Copied"} ${sel.length===1?`“${sel[0].split("\\").pop()}”`:sel.length+" items"} • Ctrl+V to paste`);
}
/** Paste into the current folder (or `targetDir`): runs as a background operation. */
async function doPaste(targetDir){
  if(!clipboard.sources.length || !clipboard.op){ toast("Nothing to paste - copy or cut something first"); return; }
  const dest=targetDir||(state.loc?.k==="dir"?state.path:"");
  if(!dest){ toast("Open a folder to paste into"); return; }
  const sources=clipboard.sources.slice();
  const op=clipboard.op;
  const lower=dest.toLowerCase();
  if(sources.some(s=> lower===s.toLowerCase() || lower.startsWith(s.toLowerCase()+"\\"))){ toast("A folder can't be pasted into itself"); return; }
  const id= op==="cut" ? await PiOps.move(sources,dest,{origin:els.pasteBtn}) : await PiOps.copy(sources,dest,{origin:els.pasteBtn});
  if(id && op==="cut"){ clipboard.op=null; clipboard.sources=[]; $$("#fileContainer .cut-pending").forEach(el=>el.classList.remove("cut-pending")); }
}
async function doDeleteSelection(permanent=false){
  const sel=[...state.selected]; if(sel.some(p=>/^[A-Za-z]:[\\/]?$/.test(p))){ toast("Drives can’t be deleted"); return; }
  if(!sel.length){ toast("Select something to delete"); return; }
  const what= sel.length===1? `“${sel[0].split("\\").pop()}”` : `these ${sel.length} items`;
  // Explorer: Delete asks (if enabled) and recycles; Shift+Delete always asks and is permanent.
  // Permanent deletes are confirmed by a native dialog in the backend (page script can't fake it).
  if(window.__TAURI__ ? (!permanent && pref("confirmDelete",true)) : (permanent || pref("confirmDelete",true))){
    const ok=await PiDialog.confirm(permanent
      ? { title:"Permanently delete?", message:`${what[0].toUpperCase()+what.slice(1)} will be deleted forever. This can't be undone.`, okText:"Delete permanently", danger:true, origin:els.deleteBtn }
      : { title:"Move to Recycle Bin?", message:`Move ${what} to the Recycle Bin? You can restore ${sel.length===1?"it":"them"} from there.`, okText:"Move to Recycle Bin", origin:els.deleteBtn });
    if(!ok) return;
  }
  // Rows fade out right away; the operation finishes in the background.
  sel.forEach(p=>els.fileContainer.querySelector(`[data-path="${CSS.escape(p)}"]`)?.classList.add("deleting"));
  const id= permanent? await PiOps.remove(sel,{origin:els.deleteBtn}) : await PiOps.recycle(sel,{origin:els.deleteBtn});
  if(!id){ $$("#fileContainer .deleting").forEach(el=>el.classList.remove("deleting")); return; }
  state.selected.clear(); updateSelectionUI();
}
// When an operation touching the visible folder finishes, refresh it in place and select what arrived.
window.addEventListener("pifiles:fileop-done",e=>{
  const st=e.detail; if(!st) return;
  [...(st.sources||[]),st.dest].filter(Boolean).forEach(p=>{ invalidateFolderCache(p); const parent=p.slice(0,p.lastIndexOf("\\")); if(parent) invalidateFolderCache(parent); });
  if(st.kind==="move" && window.PiTags) (st.outputs||[]).forEach((o,i)=>{ const from=(st.sources||[])[i]; if(from) PiTags.rename(from,o); });
  if(state.loc?.k!=="dir") return;
  const here=state.path.toLowerCase().replace(/\\$/,"");
  const touches=p=>{ const x=String(p||"").toLowerCase().replace(/\\$/,""); return x===here || x.slice(0,x.lastIndexOf("\\"))===here; };
  if(!(touches(st.dest) || (st.sources||[]).some(touches))) return;
  loadDir(state.path,{keepScroll:true}).then(()=>{
    if(st.dest && touches(st.dest) && st.outputs?.length && st.state==="done"){ state.selected=new Set(st.outputs.filter(o=>state.files.some(f=>f.path===o))); refreshRowStates(); updateSelectionUI(); }
  });
});
async function doCreateFolder(){
  const name=await PiDialog.prompt({title:"New folder", message:"Name the new folder", value:"New folder", okText:"Create", origin:els.newBtn});
  if(!name) return;
  const trimmed=name.trim();
  if(!trimmed){ toast("Invalid name"); return; }
  if(trimmed.includes("/")||trimmed.includes("\\")||trimmed.includes(":")){ toast("Name cannot contain / \\ :"); return; }
  const full=(state.path||"C:\\").replace(/\\$/,"")+"\\"+trimmed;
  try{
    await invoke("create_folder",{path:full});
    toast(`Created "${trimmed}"`);
    invalidateFolderCache(state.path||"C:\\");
    invalidateFolderCache(full);
    await loadDir(state.path);
  }catch(e){ toast("Create failed: "+(e.message||e)); }
}
async function doRenameFile(oldPath){ if(isDriveRoot(oldPath)) return doRenameDrive(oldPath);
  const base=oldPath.split("\\").pop()||oldPath;
  const name=await PiDialog.prompt({title:"Rename", value:base, okText:"Rename", selectBaseName:true});
  if(!name||name===base) return;
  if(name.includes("/")||name.includes("\\")){ toast("Invalid name"); return; }
  const dir=oldPath.slice(0, oldPath.lastIndexOf("\\"))||state.path;
  const newPath=(dir.replace(/\\$/,"")+"\\"+name);
  try{
    await invoke("rename_item",{old:oldPath,new:newPath});
    toast(`Renamed to ${name}`);
    invalidateFolderCache(oldPath);
    invalidateFolderCache(newPath);
    const oldParent=oldPath.slice(0, oldPath.lastIndexOf("\\"));
    const newParent=newPath.slice(0, newPath.lastIndexOf("\\"));
    if(oldParent) invalidateFolderCache(oldParent);
    if(newParent) invalidateFolderCache(newParent);
    await loadDir(state.path);
  }catch(e){ toast("Rename failed: "+(e.message||e)); }
}
// --- Built-in viewer helpers + thumbnail ---
/* Thumbnails are data URLs; keep only the most recently used so long browsing sessions don't grow the web view's memory without bound. Cap follows the device tier. */
const perfTierNow=()=>document.documentElement.dataset.perf||"mid";
class LruMap extends Map{ get(k){ if(!super.has(k)) return undefined; const v=super.get(k); super.delete(k); super.set(k,v); return v; } set(k,v){ if(super.has(k)) super.delete(k); super.set(k,v); const cap=({low:500,mid:1500,high:3000})[perfTierNow()]||1500; if(this.size>cap){ const drop=this.size-Math.floor(cap*.85); let n=0; for(const key of super.keys()){ super.delete(key); if(++n>=drop) break; } } return this; } }
const thumbCache=new LruMap();
const PANE_MS=170; // right-pane slide duration (paneVisibility)
const thumbPending=new Set();
const THUMB_BATCH=({low:4,mid:8,high:12})[document.documentElement.dataset.perf||"mid"]||8;
const THUMB_EXTS=new Set(["jpg","jpeg","png","webp","bmp","gif","heic","heif","svg"]);
/** Image types the web view decodes itself (streamed, no backend work). */
const NATIVE_IMG_EXTS=new Set(["jpg","jpeg","jfif","png","webp","bmp","gif","avif","ico"]);
const VIDEO_EXTS=new Set(["mp4","mkv","mov","avi","wmv","webm","m4v","flv"]);
const AUDIO_EXTS=new Set(["mp3","wav","flac","m4a","ogg","aac","wma","opus"]);
const TEXT_EXTS=new Set(["txt","md","csv","json","log","yml","yaml","xml","html","htm","js","ts","css","py","rs","java","c","cpp","h","sh","bat","ini","cfg","conf","toml","svg"]);
const ARCHIVE_EXTS=new Set(["zip","rar","7z","tar","gz","tgz","jar","apk"]);
const PDF_EXTS=new Set(["pdf"]);
const DOC_EXTS=new Set(["doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp"]);
function getExt(f){return (f.extension||f.ext|| (f.name||"").split(".").pop()||"").toLowerCase();}
function isImageFile(f){return THUMB_EXTS.has(getExt(f));}
// Files the backend can thumbnail: images natively, videos/PDFs/RAW via the Windows Shell.
const SHELL_THUMB_EXTS=new Set(["pdf","cr2","cr3","crw","nef","nrw","arw","srf","sr2","dng","raf","orf","rw2","pef","srw","x3f","3fr","iiq","erf","kdc","mef","mos","rwl"]);
function hasThumb(f){if(!pref("showThumbnails",true)) return false; const e=getExt(f); return THUMB_EXTS.has(e)||VIDEO_EXTS.has(e)||SHELL_THUMB_EXTS.has(e);}
function isVideoFile(f){return VIDEO_EXTS.has(getExt(f));}
function isAudioFile(f){return AUDIO_EXTS.has(getExt(f));}
function isTextFile(f){const e=getExt(f); return TEXT_EXTS.has(e);}
function isArchiveFile(f){return ARCHIVE_EXTS.has(getExt(f));}
function isPdfFile(f){return PDF_EXTS.has(getExt(f));}
function isDocFile(f){return DOC_EXTS.has(getExt(f));}
function assetUrl(p){
  try{
    if(window.__TAURI__?.core?.convertFileSrc) return window.__TAURI__.core.convertFileSrc(p);
    if(window.__TAURI__?.convertFileSrc) return window.__TAURI__.convertFileSrc(p);
  }catch{}
  // fallback: asset protocol http
  return "http://asset.localhost/"+encodeURIComponent(p).replace(/%2F/g,"/").replace(/%5C/g,"/").replace(/%3A/g,":");
}
function getInvoke(){try{return window.__TAURI__?.core?.invoke||window.__TAURI__?.invoke}
catch{return null}}
const invokeFn=getInvoke();
async function invoke(c,a){if(invokeFn){try{return await invokeFn(c,a)}
catch(e){throw e}}throw new Error("no backend")}
/* Fallbacks: plain values are safe defaults; functions generate demo data for the browser preview.
   Inside the real app demo data must never be shown (it once replaced the real drive list), so the
   error is passed on instead. */
const IS_APP=!!window.__TAURI__;
async function safeInvoke(c,a,f){try{return await invoke(c,a)}
catch(e){ if(IS_APP && typeof f==="function" && /mock/i.test(String(f))) throw e; return typeof f==="function"?f(a):f}}
// expose opener for inline onclick (global scope) - lightweight
try{ window.__invoke = invoke; window.__openExternal = (p)=> invoke("open_file",{path:p}).then(()=>toast("Opened with default app")).catch(e=>toast(String(e.message||e||e))); }catch{}
/* One request per path: concurrent callers (list, grid, gallery, preview) share the same promise
   instead of the second one getting nothing and marking the file "no thumbnail". */
const thumbInflight=new Map();
function fetchThumb(path){ if(thumbCache.has(path)) return Promise.resolve(thumbCache.get(path)); if(thumbInflight.has(path)) return thumbInflight.get(path);
  thumbPending.add(path);
  const job=invoke("get_thumbnail",{path}).then(url=>{ thumbCache.set(path,url||""); return url||""; },()=>{ thumbCache.set(path,""); return ""; }).finally(()=>{ thumbPending.delete(path); thumbInflight.delete(path); });
  thumbInflight.set(path,job); return job; }
async function fetchPreview(path){if(thumbCache.has("preview:"+path)) return thumbCache.get("preview:"+path); try{const url=await invoke("get_file_preview",{path}); thumbCache.set("preview:"+path,url||""); return url;}catch{return "";}
}
// Max-quality fallback: when asset:// fails (heic/heif etc), load high-quality 2048 q90 base64
async function previewAssetFallback(path, imgEl){
  try{
    const url=await invoke("get_file_preview",{path});
    if(url && imgEl){
      imgEl.src=url; imgEl.style.display="block"; imgEl.style.opacity="1"; imgEl.style.position="static";
      const t=imgEl.previousElementSibling;
      if(t && t.tagName==="IMG" && t.dataset.thumbPreview!==undefined) t.style.display="none";
      thumbCache.set("preview:"+path, url);
    }
  }catch{
    if(imgEl) imgEl.outerHTML='<div style="font-size:22px">🖼</div><div style="color:var(--text-3)">Preview unavailable</div>';
  }
}
window.__previewAssetFallback=previewAssetFallback;
window.__fetchPreviewFallback=previewAssetFallback;
async function viewerAssetFallback(path, imgEl){
  try{
    const url=await invoke("get_file_preview",{path});
    if(url && imgEl){
      imgEl.src=url; imgEl.style.display="block"; imgEl.style.opacity="1"; imgEl.style.position="static";
      const t=imgEl.previousElementSibling;
      if(t && t.dataset.viewerThumb!==undefined) t.style.display="none";
      thumbCache.set("preview:"+path, url);
    } else if(imgEl){
      imgEl.outerHTML='<div style="font-size:32px">🖼</div><div style="color:var(--text-3)">Preview unavailable</div>';
    }
  }catch{
    if(imgEl) imgEl.outerHTML='<div style="font-size:32px">🖼</div><div style="color:var(--text-3)">Preview failed</div>';
  }
}
window.__viewerAssetFallback=viewerAssetFallback;
// batch 20 at a time for low-end; updates DOM in place
/* Rolling thumbnail queue: up to THUMB_BATCH requests in flight, the next one starts as soon as
   any finishes (fixed batches used to wait for their slowest file). Newest requests go first,
   so the rows the user just scrolled to fill in before older ones. */
const thumbQueue=[]; const thumbQueued=new Set(); let thumbActive=0;
function applyThumb(p,url){
  const sel=(window.CSS&&CSS.escape)?CSS.escape(p):p;
  document.querySelectorAll(`[data-thumb-path="${sel}"]`).forEach(el=>{ const img=el.querySelector("img.thumb-img"); if(img){ img.src=url; img.style.display="block"; const ph=el.querySelector(".thumb-ph"); if(ph) ph.style.display="none"; } });
  document.querySelectorAll(`[data-grid-thumb="${sel}"]`).forEach(wrap=>{ const img=wrap.querySelector("img"); if(img){ img.src=url; img.style.display="block"; const ph=wrap.querySelector(".thumb-ph"); if(ph) ph.style.display="none"; } });
}
function pumpThumbs(){
  while(thumbActive<THUMB_BATCH && thumbQueue.length){
    const p=thumbQueue.pop(); thumbQueued.delete(p); thumbActive++;
    fetchThumb(p).then(url=>{ if(url) applyThumb(p,url); }).finally(()=>{ thumbActive--; pumpThumbs(); });
  }
}
function queueThumbBatch(paths, onDone){
  for(const p of [...paths].reverse()){ if(thumbCache.has(p)){ const u=thumbCache.get(p); if(u) applyThumb(p,u); continue; } if(!thumbQueued.has(p)){ thumbQueue.push(p); thumbQueued.add(p); } }
  pumpThumbs();
  if(onDone) Promise.resolve().then(onDone);
}
function mockDrives(){return[{name:"C:",mount_point:"C:\\",total_space:512e9,free_space:210e9,type:"SSD",used:59},{name:"D:",mount_point:"D:\\",total_space:1e12,free_space:640e9,type:"HDD",used:36},{name:"E:",mount_point:"E:\\",total_space:2e12,free_space:1200e9,type:"HDD",used:40}]}
function mockListDir(p){if(!p)
return[{name:"Users",path:"C:\\Users",is_dir:true,size:0,modified:"2026-08-30 14:20",item_count:8},{name:"Windows",path:"C:\\Windows",is_dir:true,size:0,modified:"2026-08-28 09:12",item_count:24},{name:"Program Files",path:"C:\\Program Files",is_dir:true,size:0,modified:"2026-07-12 11:00",item_count:12},{name:"Pictures",path:"C:\\Users\\Siril\\Pictures",is_dir:true,size:0,modified:"2026-08-31 16:45",item_count:4},{name:"notes.txt",path:"C:\\notes.txt",is_dir:false,size:2400,modified:"2026-08-29 10:30",ext:"txt"},{name:"image_001.jpg",path:"C:\\image_001.jpg",is_dir:false,size:4200000,modified:"2026-08-30 18:05",ext:"jpg"}];
const b=p.replace(/\\$/,"");
const dirs=["DCIM","Vacation","Family","Camera Roll"].map((n,i)=>({name:n,path:b+"\\"+n,is_dir:true,size:0,modified:"2026-08-31 12:00",item_count:[42,28,64,12][i]||4}));
const files=Array.from({length:80},(_,i)=>{const ext=["jpg","mp4","png","docx","pdf"][i%5];
return{name:`IMG_${String(1000+i).padStart(4,"0")}.${ext}`,path:b+"\\"+`IMG_${String(1000+i).padStart(4,"0")}.${ext}`,is_dir:false,size:Math.floor(500000+Math.random()*8e6),modified:`2026-08-${String(10+(i%20)).padStart(2,"0")}`,ext}});
return[...dirs,...files]}
function mockSearch(q,o=0,l=PAGE){const all=mockListDir("C:\\").filter(f=>!f.is_dir);
const qq=q.toLowerCase();
const filtered=all.concat(Array.from({length:120},(_,i)=>({name:`${q}_result_${i}.jpg`,path:`C:\\Search\\${q}_result_${i}.jpg`,is_dir:false,size:1230000,modified:"2026-08-30",ext:"jpg"}))).filter(f=>f.name.toLowerCase().includes(qq));
const slice=filtered.slice(o,o+l);
return{results:slice,total:filtered.length,has_more:filtered.length>o+slice.length,took_ms:12,indexed:true,query:q}}
function mockMediaPeople(){return[{id:"p1",name:"Family",count:42,cover:"👨‍👩‍👧",path:"C:\\Users\\Siril\\Pictures\\Family"},{id:"p2",name:"Vacation 2026",count:28,cover:"🏖",path:"C:\\Users\\Siril\\Pictures\\Vacation"},{id:"p3",name:"DCIM / Camera",count:64,cover:"📷",path:"C:\\Users\\Siril\\Pictures\\DCIM"},{id:"p4",name:"Unknown",count:12,cover:"👤",path:"C:\\Users\\Siril\\Pictures\\Camera Roll"}]}
function mockDeviceGroups(){return{by_drive:[{drive:"C:",label:"Drive C:",key:"C:",count:320,total_size:0,preview:[],type:"SSD",icon:"💾"},{drive:"D:",label:"Drive D:",key:"D:",count:540,total_size:0,preview:[],type:"HDD",icon:"🗄"},{drive:"E:",label:"Drive E:",key:"E:",count:210,total_size:0,preview:[],type:"HDD",icon:"📦"}],by_type:[{key:"Canon EOS R5",label:"Canon EOS R5",count:84,total_size:420000000,preview:[]},{key:"Apple iPhone 15",label:"Apple iPhone 15",count:62,total_size:310000000,preview:[]},{key:"Nikon Z6",label:"Nikon Z6",count:31,total_size:180000000,preview:[]},{key:"JPEG (Camera)",label:"JPEG (Camera)",count:28,total_size:90000000,preview:[]}],by_device:[{key:"Canon EOS R5",label:"Canon EOS R5",count:84,total_size:420000000,preview:[]},{key:"Apple iPhone 15",label:"Apple iPhone 15",count:62,total_size:310000000,preview:[]}]}}
function debounce(fn,ms){let t;
return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}}
function fmtSize(b){if(b==null||b===""||isNaN(Number(b))) return"-"; b=Number(b); if(b===0) return"0 B";
  const bin=pref("sizeUnits","binary")!=="decimal"; const k=bin?1024:1000; const u=bin?["B","KiB","MiB","GiB","TiB"]:["B","KB","MB","GB","TB"];
  let i=0; while(b>=k && i<u.length-1){ b/=k; i++; } return i===0? b+" B" : (b>=100? b.toFixed(0) : b.toFixed(i>=3?2:1))+" "+u[i];}
function fmtFolderLabel(f){if(!f.is_dir) return fmtSize(f.size); const c=f.item_count; if(c==null) return"-"; if(c===0) return"Empty"; if(c===1) return"1 item"; return c+" items"; }
function fmtFolderTooltip(f,cached){let tip="Folder"; if(f.item_count!=null) tip+=` • ${f.item_count} ${f.item_count===1?"item":"items"}`; if(cached && cached.size!=null) tip+=` • ${fmtSize(cached.size)}`; else if(cached && cached.loading) tip+=` • calculating…`; return tip;}
// On-demand folder size cache - stays put, only updates on launch or on changes (not on every hover/selection)
// Rust cache (1h + mtime) ensures single calc per folder per launch; frontend mirrors it to avoid redundant invokes.
const FOLDER_SIZE_TTL_MS = 60*60*1000; // 1 hour (matches Rust cache TTL)
const folderSizeCache=new Map(); // path -> {size:number|null, loading:boolean, error?:string, timestamp:number}
// Invalidate frontend cache for path and its parents/descendants - called after ops (copy/move/delete/create/rename)
function invalidateFolderCache(path){
  if(!path) return;
  const norm=path.replace(/[\/\\]+$/,"");
  const keys=[...folderSizeCache.keys()];
  for(const k of keys){
    const kn=k.replace(/[\/\\]+$/,"");
    if(kn.toLowerCase()===norm.toLowerCase()){ folderSizeCache.delete(k); continue; }
    if(kn.length>norm.length && kn.slice(0,norm.length).toLowerCase()===norm.toLowerCase() && (kn[norm.length]==="\\"||kn[norm.length]==="/")){ folderSizeCache.delete(k); continue; }
    if(norm.length>kn.length && norm.slice(0,kn.length).toLowerCase()===kn.toLowerCase() && (norm[kn.length]==="\\"||norm[kn.length]==="/")){ folderSizeCache.delete(k); continue; }
  }
}
window.__invalidateFolderCache = invalidateFolderCache;
async function fetchFolderSize(path){
  const now=Date.now();
  const cached=folderSizeCache.get(path);
  if(cached){
    if(cached.loading) return cached; // already calculating - don't spam
    if(cached.timestamp && (now - cached.timestamp < FOLDER_SIZE_TTL_MS) && cached.size!=null) return cached; // fresh (<5min) - stay put, no re-invoke
    if(cached.error && cached.timestamp && (now - cached.timestamp < 30000)) return cached; // error cooldown 30s
    // stale (>5min) falls through to recompute
  }
  // mark loading immediately so concurrent hover/selection doesn't spawn duplicate invokes
  folderSizeCache.set(path,{size: cached?.size ?? null, loading:true, timestamp: now});
  try{
    const sz=await safeInvoke("get_folder_size",{path}, (a)=>{ const p=a?.path||path; const f=state.files.find(x=>x.path===p) || filteredFiles().find(x=>x.path===p); const cnt=f?.item_count ?? 5; return cnt*1024*1024*2;});
    const v={size:Number(sz)||0,loading:false, timestamp: Date.now()};
    folderSizeCache.set(path,v);
    return v;
  }catch(e){
    const v={size:null,loading:false,error:String(e?.message||e), timestamp: Date.now()};
    folderSizeCache.set(path,v);
    return v;
  }
}
// Automatic folder sizes: visible folders are measured in the background, two at a time,
// and each Size cell is filled in place as its walk reports progress (no re-render).
const folderSizeQueue=[]; let folderSizeActive=0;
function queueFolderSizes(paths){
  if(!pref("autoFolderSizes",true) || !paths.length) return;
  folderSizeQueue.length=0; // only what's on screen now; scrolled-away folders are queued again when shown
  for(const p of paths){ const c=folderSizeCache.get(p); if(c && (c.loading || c.size!=null || c.error)) continue; folderSizeQueue.push(p); }
  pumpFolderSizes();
}
function pumpFolderSizes(){
  while(folderSizeActive<2 && folderSizeQueue.length){
    const p=folderSizeQueue.shift();
    folderSizeActive++;
    fetchFolderSize(p).then(res=>paintFolderSize(p,res)).finally(()=>{ folderSizeActive--; pumpFolderSizes(); });
  }
}
function paintFolderSize(path,res,interim){
  const esc2=(window.CSS&&CSS.escape)?CSS.escape(path):path;
  const cell=els.fileContainer?.querySelector(`[data-path="${esc2}"] .f-size`);
  if(cell && !cell.querySelector(".view-size")){
    if(res && res.size!=null){ cell.textContent=fmtSize(res.size); cell.classList.toggle("f-size-live",!!interim); }
    else if(res && res.error && !interim){ cell.textContent="-"; cell.classList.remove("f-size-live"); }
  }
  const val=document.getElementById("folder-size-val");
  if(!interim && val && val.dataset.for===path && res && res.size!=null){ val.textContent=fmtSize(res.size); val.style.color=""; }
}
function parseDate(s){ s=String(s).trim(); if(/^\d+$/.test(s)) return new Date(Number(s)*1000); if(/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.replace(" ","T")); return null; }
function fmtDate(s){if(!s) return"-"; const d=parseDate(s); if(!d||isNaN(d)) return String(s);
  const mode=pref("dateFormat","relative");
  if(mode==="relative"){ const diff=(Date.now()-d.getTime())/1000;
    if(diff>=0 && diff<60) return "Just now";
    if(diff>=0 && diff<3600){ const m=Math.floor(diff/60); return m+(m===1?" minute ago":" minutes ago"); }
    if(diff>=0 && diff<86400){ const h=Math.floor(diff/3600); return h+(h===1?" hour ago":" hours ago"); }
    if(diff>=0 && diff<7*86400){ const n=Math.floor(diff/86400); return n===1?"Yesterday":n+" days ago"; } }
  if(mode==="short") return d.toLocaleDateString(undefined,{day:"2-digit",month:"2-digit",year:"numeric"});
  if(mode==="iso") return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  return d.toLocaleDateString(undefined,{day:"2-digit",month:"long",year:"numeric"});}
function displayName(f){ if(f.is_dir||pref("showExtensions",true)) return f.name; const i=f.name.lastIndexOf("."); return i>0? f.name.slice(0,i) : f.name; }
function folderIcon(){ return window.PiIcons? PiIcons.folder() : "📁"; }
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function highlight(text,q){if(!q)
return esc(text);
const i=text.toLowerCase().indexOf(q.toLowerCase());
if(i<0)
return esc(text);
return esc(text.slice(0,i))+"<mark>"+esc(text.slice(i,i+q.length))+"</mark>"+esc(text.slice(i+q.length))}
function toast(msg,ms=2400){els.toast.textContent=msg;els.toast.classList.add("show");clearTimeout(toast._t);toast._t=setTimeout(()=>els.toast.classList.remove("show"),ms)}
function calcTotalSize(files){return files.filter(f=>!f.is_dir).reduce((s,f)=>s+(Number(f.size)||0),0);}
function statusSummary(){if(state.isSearching) return `Search: ${state.searchTotal} matches • ${state.searchMeta.took_ms}ms`; if(state.tagMode) { const label=TAG_LABELS[state.tagMode]||state.tagMode; return `${label} • ${state.tagTotal} files • ${state.tagTookMs}ms • ${state.path||"All drives"}`; } const n=filteredFiles().length; const total=calcTotalSize(filteredFiles()); const sizeStr= total?` • ${fmtSize(total)}`:""; const folderN=filteredFiles().filter(f=>f.is_dir).length; const fileN=n-folderN; return `${n} items • ${fileN} files • ${folderN} folders${sizeStr} • ${state.path||"Home"}`;}
function setLoading(v){els.loadingLabel.classList.toggle("hidden",!v);els.statusText.textContent=v?"Loading…":statusSummary();}
function sortFiles(arr,sort){const a=[...arr];
const[k,dir]=sort.split("-");a.sort((x,y)=>{if(k==="name"){const c=x.name.localeCompare(y.name);
return dir==="asc"?c:-c}
if(k==="size"){return dir==="asc"?(x.size||0)-(y.size||0):(y.size||0)-(x.size||0)}
if(k==="date"){const dx=new Date(x.modified),dy=new Date(y.modified);
return dir==="asc"?dx-dy:dy-dx}
if(k==="type"){const ex=(x.is_dir?"":(x.extension||x.ext||"")).toLowerCase(), ey=(y.is_dir?"":(y.extension||y.ext||"")).toLowerCase(); const c=ex.localeCompare(ey)||x.name.localeCompare(y.name); return dir==="asc"?c:-c}
return 0});if(pref("foldersFirst",true)) a.sort((x,y)=>(y.is_dir - x.is_dir)||0);
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
return arr;}/* Tabs *//* ---------- Locations, tabs and history ----------
   Every tab has a location (Home, a folder, Gallery, People, a person, Devices, a device, a
   category, a tag, Network, Recent or a search) plus its own back/forward history, like
   Explorer. go() is the only way the visible page changes, so the window can never show one
   page while the status bar describes another. */
const VIEW_IDS=["viewportWrap","homeView","galleryView","devicesView","networkView","mediaView"];
const locKey=l=>JSON.stringify(l||{k:"home"});
function locTitle(l){ switch(l?.k){
  case "dir": return l.path.replace(/\\$/,"").split("\\").pop()||l.path;
  case "gallery": return l.tab==="video"?"Videos":"Gallery";
  case "people": return "People";
  case "person": return l.label||((state.mediaPeople||[]).find(g=>g.key===l.key)?.label)||"Person";
  case "devices": return "Devices";
  case "device": return l.name;
  case "tag": return TAG_LABELS[l.tag]||l.tag;
  case "utag": return window.PiTags?.get(l.id)?.name||"Tag";
  case "network": return "Network";
  case "recent": return "Recent";
  case "search": return `Search: ${l.q}`;
  default: return "Home"; } }
function locIcon(l){ if(!window.PiIcons) return "";
  switch(l?.k){
    case "dir": return /^[A-Za-z]:\\?$/.test(l.path)? PiIcons.drive({path:l.path.replace(/\\?$/,"\\")}) : /^\\\\[^\\]+\\?$/.test(l.path)? PiIcons.ui("computer") : PiIcons.folder();
    case "gallery": return PiIcons.place(l.tab==="video"?"videos":"pictures");
    case "people": case "person": return PiIcons.place("people");
    case "devices": return PiIcons.place("devices");
    case "device": return PiIcons.ui(/iphone|phone|galaxy|pixel|sm-/i.test(l.name)?"phone":"camera");
    case "tag": return PiIcons.ui("filter");
    case "utag": return PiIcons.place("tags");
    case "network": return PiIcons.place("network");
    case "recent": return PiIcons.place("recent");
    case "search": return PiIcons.ui("search");
    default: return PiIcons.place("home"); } }
const curTab=()=>state.tabs.find(t=>t.id===state.activeTabId)||state.tabs[0];
const pathLoc=p=>p?{k:"dir",path:p}:{k:"home"};
// views.js is a module that loads after this file; queue page renders until it's ready.
const viewsQueue=[];
function whenViews(fn){ if(window.PiViews) fn(); else viewsQueue.push(fn); }
window.addEventListener("pifiles:views-ready",()=>{ while(viewsQueue.length) try{ viewsQueue.shift()(); }catch(e){console.error(e)} });

function showView(id){
  for(const v of VIEW_IDS){
    const el=document.getElementById(v); if(!el) continue;
    const on=v===id;
    if(on===!el.classList.contains("hidden")) continue;
    el.classList.toggle("hidden",!on);
    if(v==="mediaView") el.style.display=on?"flex":"";
    if(on && pref("animations",true)){ el.classList.remove("pf-view-in"); void el.offsetWidth; el.classList.add("pf-view-in"); }
  }
  document.documentElement.classList.toggle("pf-files-view", id==="viewportWrap");
  const pb=document.getElementById("personPhotosActionBar"); if(pb && state.loc?.k!=="person") pb.classList.add("hidden");
}
function syncSidebar(loc){
  $$("#sidebar .nav-item.active").forEach(x=>x.classList.remove("active"));
  const kf=state.knownFolders||{};
  let sel=null;
  if(loc.k==="home") sel='[data-nav="home"]';
  else if(loc.k==="recent") sel='[data-nav="recent"]';
  else if(loc.k==="gallery") sel='[data-nav="media"]';
  else if(loc.k==="people"||loc.k==="person") sel='[data-nav="people"]';
  else if(loc.k==="devices"||loc.k==="device") sel='[data-nav="devices"]';
  else if(loc.k==="network") sel='[data-nav="network"]';
  else if(loc.k==="tag") sel=`[data-nav="${loc.tag==="documents"?"docs":loc.tag==="images"?"cat-images":loc.tag==="videos"?"cat-videos":loc.tag}"]`;
  else if(loc.k==="utag") sel=`[data-utag="${CSS.escape(loc.id)}"]`;
  else if(loc.k==="dir"){
    const p=loc.path.toLowerCase().replace(/\\$/,"");
    const pin=Object.entries(kf).find(([k,v])=>k!=="home" && String(v).toLowerCase().replace(/\\$/,"")===p);
    if(pin) sel=`[data-pinned="${pin[0]}"]`;
    $$(".drive-card",els.drivesList).forEach(c=>c.classList.toggle("active", String(c.dataset.drive||"").toLowerCase().replace(/\\$/,"")===p));
    $$("#netList [data-netpath]").forEach(c=>c.classList.toggle("active", c.dataset.netpath.toLowerCase().replace(/\\$/,"")===p));
  }
  if(loc.k!=="dir") $$(".drive-card.active",els.drivesList).forEach(c=>c.classList.remove("active"));
  if(sel) document.querySelector("#sidebar "+sel)?.classList.add("active");
}
function syncNavButtons(){
  const t=curTab();
  const b=document.getElementById("backBtn"), f=document.getElementById("forwardBtn"), u=document.getElementById("upBtn");
  if(b){ b.disabled=!t.back.length; b.title=t.back.length?`Back to ${locTitle(t.back[t.back.length-1])} (Alt+Left)`:"Back (Alt+Left)"; }
  if(f){ f.disabled=!t.fwd.length; f.title=t.fwd.length?`Forward to ${locTitle(t.fwd[t.fwd.length-1])} (Alt+Right)`:"Forward (Alt+Right)"; }
  if(u) u.disabled=t.loc.k==="home";
}
/** Navigates the current tab. `replace`: change the location without a history entry. */
async function go(loc,{replace=false}={}){
  const tab=curTab(); if(!tab||!loc) return;
  const same=locKey(tab.loc)===locKey(loc);
  if(!same && !replace){ tab.back.push(tab.loc); if(tab.back.length>200) tab.back.shift(); tab.fwd=[]; }
  if(!same) tab.scroll=0;
  tab.loc=loc; tab.title=locTitle(loc);
  await renderLoc(loc);
}
async function goBack(){ const t=curTab(); if(!t.back.length) return; t.fwd.push(t.loc); t.loc=t.back.pop(); t.title=locTitle(t.loc); await renderLoc(t.loc,{restoreScroll:true}); }
async function goForward(){ const t=curTab(); if(!t.fwd.length) return; t.back.push(t.loc); t.loc=t.fwd.pop(); t.title=locTitle(t.loc); await renderLoc(t.loc); }
function goUp(){ const l=state.loc||{k:"home"};
  if(l.k==="dir"){ const p=l.path.replace(/\\+$/,""); if(/^[A-Za-z]:$/.test(p)||/^\\\\[^\\]+$/.test(p)) return go({k:"home"}); const i=p.lastIndexOf("\\"); const up=i>0?p.slice(0,i):""; return go(pathLoc(/^[A-Za-z]:$/.test(up)?up+"\\":/^\\\\[^\\]*$/.test(up)?"":up)); }
  if(l.k==="person") return go({k:"people"});
  if(l.k==="device") return go({k:"devices"});
  if(l.k!=="home") return go({k:"home"}); }

async function renderLoc(loc,{restoreScroll=false}={}){
  const token=++state.navToken;
  state.loc=loc;
  hideContextMenu();
  // Leaving search / categories / a person resets their state; the selection never carries over.
  if(loc.k!=="search" && state.isSearching) clearSearch();
  if(loc.k!=="tag" && state.tagMode) clearTagFilter();
  if(loc.k!=="person") state.currentPersonKey=null;
  state.selected.clear(); state.lastSelectedIdx=-1; updateSelectionUI();
  if(loc.k==="dir") state.path=loc.path; else if(loc.k!=="search") state.path="";
  try{ localStorage.setItem("pf:lastLoc", JSON.stringify(loc)); if(loc.k==="dir") localStorage.setItem("fe:lastPath", loc.path); }catch{}
  renderTabBar(); renderBreadcrumbs(); syncSidebar(loc); syncNavButtons();
  const scroll=restoreScroll?(curTab().scroll||0):0;
  switch(loc.k){
    case "home": showView("homeView"); state.files=[]; updateCounts(); whenViews(()=>PiViews.home()); els.statusText.textContent=`${state.drives.length} drives`; break;
    case "dir": showView("viewportWrap"); await loadDir(loc.path,{scroll}); break;
    case "gallery": showView("galleryView"); whenViews(()=>PiViews.gallery({kind:loc.tab||"image"})); els.statusText.textContent="Gallery"; break;
    case "people": showView("mediaView"); $("#peopleTab")?.classList.remove("hidden"); loadMediaPeople(); els.statusText.textContent="People"; break;
    case "person": showView("viewportWrap"); await loadPersonPhotos(loc.key); break;
    case "devices": showView("devicesView"); whenViews(()=>PiViews.devices()); els.statusText.textContent="Devices"; break;
    case "device": showView("galleryView"); whenViews(()=>PiViews.gallery({kind:loc.tab||"all",device:loc.name})); els.statusText.textContent=loc.name; break;
    case "network": showView("networkView"); whenViews(()=>PiViews.network()); els.statusText.textContent="Network"; break;
    case "tag": showView("viewportWrap"); await loadTag(loc.tag,0,PAGE); break;
    case "utag": showView("viewportWrap"); await loadPathList(window.PiTags?.filesWith(loc.id)||[], `${locTitle(loc)} • tagged items`, token); break;
    case "recent": showView("viewportWrap"); await loadPathList(recentList().map(r=>r.path), "Recently opened in PiFiles", token); break;
    case "search": showView("viewportWrap"); runSearch(loc.q); break;
  }
}
/** Lists arbitrary paths (tags, recent files) in the file list. */
async function loadPathList(paths,label,token){
  setLoading(true);
  let files=[];
  try{ files=paths.length? await safeInvoke("get_files_info",{paths},()=>paths.map(p=>({name:p.split("\\").pop(),path:p,is_dir:false,size:0,modified:"",extension:(p.split(".").pop()||"").toLowerCase()}))) : []; }catch{}
  if(token!==state.navToken) return;
  // Items that were deleted or moved outside PiFiles are dropped from the list.
  state.files=sortFiles((files||[]).filter(f=>f && (f.modified||f.size||f.is_dir)),state.sort);
  setLoading(false); renderVirtualized(true); updateCounts();
  els.statusText.textContent=`${state.files.length} item${state.files.length===1?"":"s"} • ${label}`;
}
function recentList(){ if(!pref("trackRecent",true)) return []; try{ return JSON.parse(localStorage.getItem("pf:recent")||"[]"); }catch{ return []; } }
function clearRecent(path){ try{ if(path){ localStorage.setItem("pf:recent",JSON.stringify(recentList().filter(r=>r.path.toLowerCase()!==path.toLowerCase()))); } else localStorage.removeItem("pf:recent"); }catch{} if(state.loc?.k==="home") whenViews(()=>PiViews.home()); else if(state.loc?.k==="recent") renderLoc(state.loc); }
window.__clearRecent=clearRecent;
function addRecent(path){ if(!pref("trackRecent",true)) return; if(!path || /\\pifiles-(archive-preview|versions)\\/i.test(path)) return; try{ const l=recentList().filter(r=>r.path.toLowerCase()!==path.toLowerCase()); l.unshift({path,t:Date.now()}); localStorage.setItem("pf:recent",JSON.stringify(l.slice(0,60))); }catch{} }

// Updates the tab strip in place: only the tabs whose title, icon or state changed are touched,
// so navigating in one tab never re-creates (or visibly refreshes) the others.
function wireTabDrag(el){
  el.addEventListener("dragstart",e=>{e.dataTransfer.setData("text/plain",el.dataset.tab);el.style.opacity=.5});
  el.addEventListener("dragend",()=>el.style.opacity="");
  el.addEventListener("dragover",e=>e.preventDefault());
  el.addEventListener("drop",e=>{e.preventDefault();
    const from=e.dataTransfer.getData("text/plain"); const to=el.dataset.tab;
    const fi=state.tabs.findIndex(x=>String(x.id)===from), ti=state.tabs.findIndex(x=>String(x.id)===to);
    if(fi>=0&&ti>=0&&fi!==ti){ const [mv]=state.tabs.splice(fi,1); state.tabs.splice(ti,0,mv); renderTabBar(); }});
}
function renderTabBar(){
  const list=els.tabList;
  const have=new Map([...list.children].filter(el=>el.dataset.tab).map(el=>[el.dataset.tab,el]));
  const want=new Set(state.tabs.map(t=>String(t.id)));
  for(const [id,el] of have) if(!want.has(id)) el.remove();
  let prev=null;
  for(const t of state.tabs){
    const id=String(t.id); let el=have.get(id);
    if(!el){
      el=document.createElement("div"); el.className="tab"; el.dataset.tab=id; el.draggable=true; el.setAttribute("role","tab"); el.setAttribute("aria-selected","false");
      el.innerHTML=`<span class="tab-ico"></span><span class="tab-title"></span><button class="tab-close" data-close="${id}" title="Close tab (Ctrl+W)" aria-label="Close tab">${window.PiIcons?PiIcons.ui("close"):"✕"}</button>`;
      wireTabDrag(el);
    }
    const isActive=t.id===state.activeTabId;
    if(el.classList.contains("active")!==isActive){ el.classList.toggle("active",isActive); el.setAttribute("aria-selected",String(isActive)); }
    const title=t.title||locTitle(t.loc), tip=t.loc?.k==="dir"?t.loc.path:locTitle(t.loc);
    if(el.title!==tip) el.title=tip;
    const tt=el.querySelector(".tab-title"); if(tt.textContent!==title) tt.textContent=title;
    const ico=locIcon(t.loc); if(el._ico!==ico){ el.querySelector(".tab-ico").innerHTML=ico; el._ico=ico; }
    const at=prev?prev.nextSibling:list.firstChild;
    if(el!==at) list.insertBefore(el,at);
    prev=el;
  }
}
function saveTabScroll(){ const t=curTab(); if(t && state.loc?.k && els.fileViewport) t.scroll=els.fileViewport.scrollTop; }
function switchTab(id){ if(id===state.activeTabId) return; saveTabScroll(); const t=state.tabs.find(x=>x.id===id); if(!t) return; state.activeTabId=id; renderLoc(t.loc,{restoreScroll:true}); }
/** New tabs open on Home (Ctrl+T, the + button) or on a given folder (middle-click, menu). */
function newTab(loc){ saveTabScroll(); if(typeof loc==="string") loc=pathLoc(loc); loc=loc||{k:"home"}; const id=state.nextTabId++; state.tabs.push({id,loc,back:[],fwd:[],title:locTitle(loc),scroll:0}); state.activeTabId=id; renderLoc(loc);
  requestAnimationFrame(()=>{ const el=els.tabList.querySelector(`[data-tab="${id}"]`); if(el && pref("animations",true)) el.animate([{opacity:0,transform:"translateY(6px) scale(.96)"},{opacity:1,transform:"none"}],{duration:180,easing:"cubic-bezier(0,0,0,1)"}); }); }
function closeTab(id,e){if(e) e.stopPropagation();
  if(state.tabs.length===1){ go({k:"home"}); return; }
  const idx=state.tabs.findIndex(x=>x.id===id); if(idx<0) return;
  const el=els.tabList.querySelector(`[data-tab="${id}"]`);
  const finish=()=>{ state.tabs.splice(idx,1);
    if(state.activeTabId===id){ const n=state.tabs[Math.min(idx,state.tabs.length-1)]; state.activeTabId=n.id; renderLoc(n.loc,{restoreScroll:true}); } else renderTabBar(); };
  if(el && pref("animations",true)){ const a=el.animate([{opacity:1,maxWidth:el.offsetWidth+"px"},{opacity:0,maxWidth:"0px",paddingLeft:"0",paddingRight:"0"}],{duration:140,easing:"cubic-bezier(.4,0,1,1)"}); a.onfinish=finish; } else finish(); }
function updateActiveTab(){ /* titles come from the tab's location (see go) */ }
/* Breadcrumbs */function renderBreadcrumbs(){const loc=state.loc||{k:"home"};
const sepHtml=window.PiIcons? `<span class="crumb-sep">${PiIcons.ui("chevronRight")}</span>` : `<span class="crumb-sep">›</span>`;
const homeBtn=(cur)=>`<div class="crumb"><button data-path="" class="crumb-home ${cur?"current":""}" title="Home">${window.PiIcons?PiIcons.place("home"):"⌂"}${cur?"<span>Home</span>":""}</button></div>`;
let html="";
if(loc.k==="dir"){
  const path=loc.path;
  const unc=path.startsWith("\\\\");
  const parts=path.split("\\").filter(Boolean);
  const driveName=p=>{ const d=(state.drives||[]).find(x=>String(x.path||x.mount_point||"").toUpperCase().replace(/\\$/,"")===p.toUpperCase()); return d? (d.name||`${d.label||"Local Disk"} (${p})`) : p; };
  html=homeBtn(false);
  let acc=unc?"\\\\":"";
  parts.forEach((p,i)=>{ acc+= unc ? (i===0?p:"\\"+p) : ((i===0&&p.endsWith(":"))?p+"\\":(i===0?p:(acc.endsWith("\\")?"":"\\")+p));
    const isLast=i===parts.length-1; const label=i===0&&p.endsWith(":")?driveName(p):p;
    html+=`${sepHtml}<div class="crumb"><button data-path="${esc(acc)}" class="${isLast?"current":""}">${esc(label)}</button></div>`; });
} else if(loc.k==="home"){ html=homeBtn(true); }
else {
  html=homeBtn(false);
  const parent= loc.k==="person"?{k:"people",label:"People"}: loc.k==="device"?{k:"devices",label:"Devices"}:null;
  if(parent) html+=`${sepHtml}<div class="crumb"><button data-loc='${esc(JSON.stringify({k:parent.k}))}'>${esc(parent.label)}</button></div>`;
  html+=`${sepHtml}<div class="crumb"><button class="current" data-loc='${esc(JSON.stringify(loc))}'>${esc(locTitle(loc))}</button></div>`;
}
els.breadcrumbView.innerHTML=html;
renderPathBar(loc);
const path=loc.k==="dir"?loc.path:"";
els.pathLabel.textContent=path||locTitle(loc); els.pathLabel.title=path||locTitle(loc); els.addressInput.value=path;
if(els.layoutInfo) els.layoutInfo.textContent=`${state.view==="grid"?"Grid":"List"} • ${state.group==="none"?"No group":"Group:"+state.group}`;
const sp=els.searchInput; if(sp) sp.placeholder= loc.k==="dir" ? `Search ${locTitle(loc)}` : "Search";}

/** Finder-style path bar (shown by themes that want it): Drive › folder › folder. */
function renderPathBar(loc){
  const bar=document.getElementById("pathBar"); if(!bar) return;
  const sep=`<span class="pb-sep">${window.PiIcons?PiIcons.ui("chevronRight"):"›"}</span>`;
  if(loc.k!=="dir"){ bar.innerHTML=`<button class="pb-seg" data-path=""><span class="pb-ico">${locIcon(loc)}</span>${esc(locTitle(loc))}</button>`; return; }
  const unc=loc.path.startsWith("\\\\"); const parts=loc.path.split("\\").filter(Boolean);
  let acc=unc?"\\\\":""; const segs=[];
  parts.forEach((p,i)=>{ acc+= unc ? (i===0?p:"\\"+p) : (i===0&&p.endsWith(":")? p+"\\" : (acc.endsWith("\\")?"":"\\")+p);
    const d=i===0&&p.endsWith(":")?(state.drives||[]).find(x=>String(x.path).toUpperCase().replace(/\$/,"")===p.toUpperCase()):null;
    const ico= i===0&&p.endsWith(":")&&window.PiIcons? PiIcons.drive({path:acc}) : (window.PiIcons?PiIcons.folder():"");
    segs.push(`<button class="pb-seg" data-path="${esc(acc)}"><span class="pb-ico">${ico}</span>${esc(d?d.name:p)}</button>`); });
  bar.innerHTML=segs.join(sep);
}
function enterAddressEdit(){els.breadcrumbView.classList.add("hidden"); els.addressEditBtn.classList.add("hidden");els.addressInput.classList.remove("hidden"); els.addressGo.classList.remove("hidden");els.addressInput.focus(); els.addressInput.select();}
function exitAddressEdit(cancel){els.breadcrumbView.classList.remove("hidden"); els.addressEditBtn.classList.remove("hidden");els.addressInput.classList.add("hidden"); els.addressGo.classList.add("hidden");
if(cancel) els.addressInput.value=state.loc?.k==="dir"?state.path:"";}
function commitAddress(){const v=els.addressInput.value.trim();exitAddressEdit(false);
if(!v){ navigateTo(""); return; }navigateTo(v);}
function bindBreadcrumbs(){els.breadcrumbView.onclick=(e)=>{const btn=e.target.closest("button[data-path],button[data-loc]"); if(!btn) return;
if(btn.dataset.loc){ go(JSON.parse(btn.dataset.loc)); return; }
navigateTo(btn.getAttribute("data-path"));};
document.getElementById("pathBar")?.addEventListener("click",e=>{ const b=e.target.closest("[data-path]"); if(b) navigateTo(b.dataset.path); });els.breadcrumbView.ondblclick=enterAddressEdit;els.addressEditBtn.onclick=enterAddressEdit;els.addressGo.onclick=commitAddress;
if(els.addressCopyBtn) els.addressCopyBtn.onclick=()=>{const p=state.path||""; if(navigator.clipboard) navigator.clipboard.writeText(p).then(()=>toast("Path copied")); else toast(p);};els.addressInput.addEventListener("keydown",e=>{if(e.key==="Enter") commitAddress();
if(e.key==="Escape") exitAddressEdit(true);});els.addressInput.addEventListener("blur",()=> setTimeout(()=>{ if(!els.addressInput.classList.contains("hidden")) exitAddressEdit(true); },150));}/* Drives with timeout */function withTimeout(promise,ms,fallbackValue){let t; const timeout=new Promise(resolve=>{t=setTimeout(()=>resolve(fallbackValue),ms)});
return Promise.race([promise.then(v=>{clearTimeout(t);
return v},_=>{clearTimeout(t);
return fallbackValue}), timeout]);}
async function loadDrives(){els.drivesList.innerHTML=`<div class="loading"><span class="spinner"></span> Loading drives…</div>`;
let raw; if(IS_APP){ try{ raw=await invoke("list_drives"); }catch(e){ els.drivesList.innerHTML=`<div style="padding:8px;color:var(--text-3);font-size:12px">Couldn't read drives <button data-act="reload" style="margin-left:6px;font-size:11px">Retry</button></div>`; console.error("list_drives",e); return; } }
else raw=await withTimeout(safeInvoke("list_drives",{},mockDrives()),800,mockDrives());
let drives=Array.isArray(raw)?raw:(raw?.drives||(IS_APP?[]:mockDrives()));
if(!IS_APP && (!Array.isArray(drives)||!drives.length)) drives=mockDrives();state.drives=drives.map(d=>{if(typeof d==="string") return{name:d,path:d,mount_point:d,total_space:0,free_space:0,type:"Fixed",drive_type:"Fixed",total_gb:0,free_gb:0,used:0,file_system:"NTFS",is_removable:false,label:d,used_gb:0};
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
return{name,path,mount_point:path,total_space,free_space,total_gb,free_gb,type:typeLabel,drive_type:typeLabel,used,file_system,is_removable,label:displayLabel,used_gb};});renderDrives(); const dc=$("#driveCount"); if(dc) dc.textContent=state.drives.length; const hc=$("#homeCount"); if(hc) hc.textContent=state.files.length||"-";}
function renderDrives(){if(!state.drives.length){els.drivesList.innerHTML=`<div style="padding:8px;color:var(--text-3);font-size:12px">No drives found <button data-act="reload" style="margin-left:6px;font-size:11px">Retry</button></div>`;
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
  const icon=window.PiIcons? PiIcons.drive(d) : driveIcon(d);
  const iconCls=driveIconClass(d);
  const freeText= fmtGB(free_gb);
  const totalText= fmtGB(total_gb);
  const barColor = isRem ? "#8a8a8a" : (usedPct>=90 ? "#d13438" : "#0078d4");
  const barWidth = total_gb>0 ? usedPct+"%" : "0%";
  const label=d.label||"Local Disk";
  const displayName=d.name||`${label} (${path.replace(/\\$/,"")})`;
  // Windows Explorer shows: Local Disk (C:)  +  C:\ • NTFS  +  210 GB free of 512 GB
  return `<div class="drive-card" data-drive="${esc(path)}" title="${esc(displayName)} - ${freeText} free of ${totalText} • ${fs}">
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
// aggregate bottom bar - total across all drives
const total=state.drives.reduce((s,d)=>s+(d.total_space||d.total_gb*1024*1024*1024||0),0);
const free=state.drives.reduce((s,d)=>s+(d.free_space||d.free_gb*1024*1024*1024||0),0);
if(total>0){
  const pct=Math.round(100*(1-free/total));
  els.storageBar.classList.remove("hidden");
  els.storageFill.style.width=pct+"%";
  // color same logic aggregated: red if >=90, else blue
  els.storageFill.style.background = pct>=90 ? "#d13438" : "#0078d4";
  els.storageBar.title = `${fmtGB(free/1024/1024/1024)} free of ${fmtGB(total/1024/1024/1024)} • ${pct}% used`;
  // update storage bar label if exists - create dynamic text sibling
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
}
if(state.loc?.k==="home"){ whenViews(()=>PiViews.home()); els.statusText.textContent=`${state.drives.length} drive${state.drives.length===1?"":"s"}`; }
syncSidebar(state.loc||{k:"home"});
}/* File listing */function navigateTo(path){ return go(pathLoc(path||"")); }
/** Loads a folder into the list. The previous listing stays on screen until the new one is
 *  ready (no blank flash), a slow load shows a thin progress bar, and a late response for a
 *  folder the user already left is ignored. */
async function loadDir(path,{scroll=0,keepScroll=false}={}){
  const token=++state.dirToken;
  const slow=setTimeout(()=>{ if(token===state.dirToken){ setLoading(true); els.viewportWrap?.classList.add("pf-loading"); } },160);
  try{
    const res=await safeInvoke("list_dir",{path:path||""},()=>mockListDir(path||""));
    if(token!==state.dirToken) return;
    let files=Array.isArray(res)?res:(res?.entries||res?.files||[]);
    files=files.map(f=>{if(typeof f==="string") return{name:f.split("\\").pop(),path:f,is_dir:false,size:0,modified:"",extension:"",item_count:null}; const item_count=f.item_count ?? f.file_count ?? null; return{...f,extension:f.extension||f.ext||"",item_count};});
    const prevScroll=els.fileViewport.scrollTop;
    state.files=sortFiles(files,state.sort);
    els.emptyState.classList.add("hidden");
    renderVirtualized(false);
    els.fileViewport.scrollTop= keepScroll? prevScroll : scroll;
    if(state.view==="list") updateVirtualSlice();
    updateCounts(); updateSelectionUI();
    const hc=$("#homeCount"); if(hc) hc.textContent=state.files.length;
  }catch(e){
    if(token!==state.dirToken) return;
    state.files=[]; els.fileContainer.innerHTML=""; els.fileSpacer.style.height="0";
    showEmpty(String(e?.message||e).replace(/\(os error \d+\)/,"").trim());
  }finally{
    clearTimeout(slow);
    if(token===state.dirToken){ setLoading(false); els.viewportWrap?.classList.remove("pf-loading"); }
  }
}
function showEmpty(msg){els.emptyState.classList.remove("hidden"); els.emptyState.innerHTML=`<div class="ico pf-empty-ico">${window.PiIcons?PiIcons.ui("warning"):"⚠"}</div><div><strong>Can't open this folder</strong><br/><span style="color:var(--text-3)">${esc(msg)}</span></div><button class="load-more" id="emptyRetry">Try again</button>`; document.getElementById("emptyRetry")?.addEventListener("click",()=>refreshView());}
function updateCounts(){const filtered=filteredFiles(); els.itemCount.textContent=`${filtered.length} items`; if(els.detailsCount) els.detailsCount.textContent=`${filtered.length}`; // status bar shows total size like Windows Explorer
 els.statusText.textContent=statusSummary(); if(els.statusRight){ const total=calcTotalSize(filtered); els.statusRight.textContent= total? `${fmtSize(total)} • ${filtered.filter(f=>!f.is_dir).length} files` : `${filtered.length} items • ${state.path||"Home"}`; }
 // update pathLabel tooltip with size as well
 if(els.pathLabel) els.pathLabel.title= statusSummary();
}/* Virtualization with grouping & selection */function renderVirtualized(resetScroll=false){if(state.view==="grid"){renderGrid();
return}
if(resetScroll) els.fileViewport.scrollTop=0;
const files=filteredFiles();
if(!files.length){els.fileContainer.innerHTML="";els.fileSpacer.style.height="0";els.emptyState.classList.remove("hidden"); if(state.tagMode){ els.emptyState.innerHTML=`<div class="ico">📁</div><div><strong>No ${esc(TAG_LABELS[state.tagMode]||state.tagMode)} found</strong><br/><span style="color:var(--text-3)">No files of this type on this device</span></div>`; } else { els.emptyState.innerHTML=`<div class="ico">📁</div><div><strong>Empty</strong><br/><span style="color:var(--text-3)">Empty</span></div><button class="load-more" style="margin-top:8px" data-act="new-folder">Create folder</button>`; }els.loadMoreWrap.classList.add("hidden");
return}els.emptyState.classList.add("hidden");
const useGroups = state.group!=="none" && !state.isSearching && !state.tagMode;
let display=files, groups=null, flat=[], headerMap=new Map();
if(useGroups){groups=groupFiles(files,state.group);flat=[];groups.forEach(g=>{flat.push({__header:true,label:`${g.key} - ${g.items.length}`});g.items.forEach(f=>flat.push(f));});display=flat;} else {display=files;}
const total=display.length;els.fileSpacer.style.height=(total*ROW_H)+"px";
if(state.isSearching && state.searchTotal>state.searchResults.length) els.loadMoreWrap.classList.remove("hidden"); else if(state.tagMode && state.tagTotal>state.files.length) els.loadMoreWrap.classList.remove("hidden"); else els.loadMoreWrap.classList.add("hidden");state._display=display; state._useGroups=useGroups;requestAnimationFrame(updateVirtualSlice);requestAnimationFrame(()=>maybeLoadMore());}
function updateVirtualSlice(){if(state.view!=="list") return; const display=state._display || filteredFiles();
const vp=els.fileViewport; const h=vp.clientHeight||400; const scrollTop=vp.scrollTop; const total=display.length;
const visible=Math.ceil(h/ROW_H)+BUFFER*2;
let start=Math.floor(scrollTop/ROW_H)-BUFFER; if(start<0) start=0;
let end=Math.min(total,start+visible); if(end-start<visible && start>0) start=Math.max(0,end-visible);
const slice=display.slice(start,end);
const q=state.isSearching?state.searchQuery:"";els.fileContainer.style.transform=`translateY(${start*ROW_H}px)`; els.fileContainer.className="file-list";els.fileContainer.innerHTML=slice.map(f=>{if(f.__header) return `<div class="group-header">${esc(f.label)}</div>`;
const isDir=!!f.is_dir; const icon=isDir?folderIcon():iconFor(f); const hl=highlight(displayName(f),q);
const cached=isDir?folderSizeCache.get(f.path):null; const tip=isDir?fmtFolderTooltip(f,cached):fmtSize(f.size); const date=fmtDate(f.modified);
const ftype=isDir?"Folder":(((f.extension||f.ext||f.name.split(".").pop()||"").toUpperCase()||"File")+" File").replace(" File File"," File");
const ftypeDisplay=isDir?"Folder":((f.extension||f.ext||"").toUpperCase() || f.name.split(".").pop()?.toUpperCase() || "File");
const sel=state.selected.has(f.path)?"selected":""; const isFocused=state._focusedPath===f.path?"focused":"";
const chk=state.selected.has(f.path)?"on":"";
const isImg=!isDir && hasThumb(f);
let thumbHtml="";
if(isImg){
  const cachedThumb=thumbCache.get(f.path);
  if(cachedThumb){ thumbHtml=`<span class="f-thumb" data-thumb-path="${esc(f.path)}"><img class="thumb-img" src="${cachedThumb}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:3px"><span class="thumb-ph" style="display:none">${icon}</span></span>`; }
  else { thumbHtml=`<span class="f-thumb" data-thumb-path="${esc(f.path)}"><span class="thumb-ph">${icon}</span><img class="thumb-img" alt="" style="display:none;width:100%;height:100%;object-fit:cover;border-radius:3px"></span>`; }
} else { thumbHtml=sysIconHtml(f,icon,"f-icon")||`<span class="f-icon ${isDir?"folder":""}">${icon}</span>`; }
let sizeHtml="";
if(isDir){
  if(cached && cached.size!=null) sizeHtml=esc(fmtSize(cached.size));
  else if(cached && cached.loading) sizeHtml='<span style="color:var(--text-3)">Calculating…</span>';
  else if(pref("autoFolderSizes",true)) sizeHtml='<span class="f-size-pending" aria-label="Calculating"></span>';
  else sizeHtml=`<button class="view-size" data-size-path="${esc(f.path)}">View size</button>`;
} else { sizeHtml=esc(fmtSize(f.size)); }
const cutCls=clipboard.op==="cut"&&clipboard.sources.includes(f.path)?" cut-pending":"";
return `<div class="file-row ${sel} ${isFocused}${cutCls}" data-path="${esc(f.path)}" data-dir="${isDir?1:0}" tabindex="0" role="option" aria-selected="${!!sel}" aria-label="${esc(f.name)} - ${esc(tip)}"><span class="check ${chk}">${state.selected.has(f.path)?"✓":""}</span>${thumbHtml}<span class="f-name" title="${esc(f.name)} • ${esc(tip)}">${hl}</span><span class="f-tag">${window.PiTags?PiTags.chips(f.path):""}</span><span class="f-date">${esc(date)}</span><span class="f-type">${esc(ftypeDisplay)}</span><span class="f-size" title="${esc(tip)}">${sizeHtml}</span></div>`;}).join("");
if(els.fileHeader) els.fileHeader.style.display = state.view==="list" ? "flex" : "none";
const toFetch=slice.filter(f=>!f.__header && !f.is_dir && hasThumb(f) && !thumbCache.has(f.path) && !thumbPending.has(f.path)).map(f=>f.path);
if(toFetch.length) queueThumbBatch(toFetch); requestAnimationFrame(()=>maybeLoadMore());
queueFolderSizes(slice.filter(f=>!f.__header && f.is_dir).map(f=>f.path));
}
function iconFor(f){ if(window.PiIcons) return PiIcons.file(f);
const ext=(f.ext||f.extension||f.name.split(".").pop()||"").toLowerCase();
if(["jpg","jpeg","png","gif","webp","bmp","heic"].includes(ext)) return "🖼";
if(["mp4","mkv","mov","avi","wmv"].includes(ext)) return "🎬";
if(["mp3","wav","flac","m4a"].includes(ext)) return "🎵";
if(["pdf"].includes(ext)) return "📄"; if(["zip","rar","7z"].includes(ext)) return "📦";
if(["doc","docx"].includes(ext)) return "📝"; if(["xls","xlsx"].includes(ext)) return "📊"; return "📄";}
function renderGrid(){const files=filteredFiles();
if(!files.length){els.fileContainer.innerHTML="";els.fileSpacer.style.height="0";els.emptyState.classList.remove("hidden");
return}els.emptyState.classList.add("hidden"); els.fileSpacer.style.height="0"; els.fileContainer.style.transform="none"; els.fileContainer.className="file-grid";
const q=state.isSearching?state.searchQuery:"";
const useGroups=state.group!=="none" && !state.isSearching && !state.tagMode;
let html="";
function thumbForGrid(f,icon){
  const isImg=!f.is_dir && hasThumb(f);
  if(!isImg) return sysIconHtml(f,icon,"f-thumb")||`<div class="f-thumb">${icon}</div>`;
  const cached=thumbCache.get(f.path);
  if(cached){ return `<div class="f-thumb" data-grid-thumb="${esc(f.path)}"><img src="${cached}" alt="" style="width:100%;height:100%;object-fit:cover" data-onerr="hide"><span class="thumb-ph" style="display:none">${icon}</span></div>`; }
  return `<div class="f-thumb" data-grid-thumb="${esc(f.path)}"><span class="thumb-ph">${icon}</span><img alt="" style="display:none;width:100%;height:100%;object-fit:cover"></div>`;
}
if(useGroups){const groups=groupFiles(files,state.group);groups.forEach(g=>{html+=`<div style="grid-column:1/-1" class="group-header">${esc(g.key)} - ${g.items.length}</div>`;g.items.forEach(f=>{const isDir=!!f.is_dir; const icon=isDir?folderIcon():iconFor(f); const hl=highlight(displayName(f),q); const sel=state.selected.has(f.path)?"selected":""; const sizeLabel=isDir?fmtFolderLabel(f):fmtSize(f.size); const tip=isDir?fmtFolderTooltip(f,folderSizeCache.get(f.path)):fmtSize(f.size); html+=`<div class="file-card ${sel}" data-path="${esc(f.path)}" data-dir="${isDir?1:0}" tabindex="0" role="button" title="${esc(f.name)} • ${esc(tip)}"><span class="check ${state.selected.has(f.path)?"on":""}">${state.selected.has(f.path)?"✓":""}</span>${thumbForGrid(f,icon)}<div class="f-name" title="${esc(f.name)} • ${esc(tip)}">${hl}</div><div class="f-meta"><span title="${esc(tip)}">${esc(sizeLabel)}</span><span>${esc((f.extension||f.ext||"").toUpperCase())}</span></div></div>`;});});} else {if(state._gridKey!==state.path){ state._gridKey=state.path; state.gridCap=GRID_CHUNK(); } const cap=(state.isSearching||state.tagMode)?files.length:Math.min(files.length,state.gridCap||GRID_CHUNK());
const slice=files.slice(0,cap);html=slice.map(f=>{const isDir=!!f.is_dir; const icon=isDir?folderIcon():iconFor(f); const hl=highlight(displayName(f),q); const sel=state.selected.has(f.path)?"selected":"";
const sizeLabel=isDir?fmtFolderLabel(f):fmtSize(f.size); const tip=isDir?fmtFolderTooltip(f,folderSizeCache.get(f.path)):fmtSize(f.size);
return `<div class="file-card ${sel}" data-path="${esc(f.path)}" data-dir="${isDir?1:0}" tabindex="0" role="button" title="${esc(f.name)} • ${esc(tip)}"><span class="check ${state.selected.has(f.path)?"on":""}">${state.selected.has(f.path)?"✓":""}</span>${thumbForGrid(f,icon)}<div class="f-name" title="${esc(f.name)} • ${esc(tip)}">${hl}</div><div class="f-meta"><span title="${esc(tip)}">${esc(sizeLabel)}</span><span>${esc((f.extension||f.ext||"").toUpperCase())}</span></div></div>`;}).join("");
if(state.isSearching&&state.searchTotal>state.searchResults.length) els.loadMoreWrap.classList.remove("hidden"); else if(state.tagMode && state.tagTotal>state.files.length) els.loadMoreWrap.classList.remove("hidden"); else els.loadMoreWrap.classList.add("hidden");}els.fileContainer.innerHTML=html;
const toFetch=(useGroups?files:files.slice(0,state.gridCap||GRID_CHUNK())).filter(f=>!f.is_dir && hasThumb(f) && !thumbCache.has(f.path) && !thumbPending.has(f.path)).map(f=>f.path);
if(toFetch.length) queueThumbBatch(toFetch); requestAnimationFrame(()=>maybeLoadMore());
}
/* Infinite scroll: more search/category results and more grid cards load as the user nears the bottom. */
function GRID_CHUNK(){ return (document.documentElement.dataset.perf==="low")?150:300; }
function nearListEnd(){ const v=els.fileViewport; return !!v && v.scrollTop+v.clientHeight > v.scrollHeight-Math.max(800,v.clientHeight*1.5); }
function maybeLoadMore(){
  if(state._loadingMore || !nearListEnd()) return;
  let job=null;
  if(state.isSearching && state.searchTotal>state.searchResults.length) job=loadMoreSearch();
  else if(state.tagMode && state.tagTotal>state.files.length) job=loadMoreTag();
  else if(state.view==="grid" && !state.isSearching && !state.tagMode && state.group==="none" && filteredFiles().length>(state.gridCap||0)){
    const top=els.fileViewport.scrollTop; state.gridCap=(state.gridCap||GRID_CHUNK())+GRID_CHUNK(); renderGrid(); els.fileViewport.scrollTop=top; return;
  }
  if(!job) return;
  state._loadingMore=true; els.loadMoreWrap?.classList.add("busy");
  Promise.resolve(job).finally(()=>{ state._loadingMore=false; els.loadMoreWrap?.classList.remove("busy"); requestAnimationFrame(maybeLoadMore); });
}
if(els.fileViewport) els.fileViewport.addEventListener("scroll",()=>{ if(!state._lmRaf) state._lmRaf=requestAnimationFrame(()=>{ state._lmRaf=0; maybeLoadMore(); }); },{passive:true});
if(els.fileViewport) els.fileViewport.addEventListener("scroll",()=>{try{if(state.view!=="list") return; if(virt.raf) return; virt.raf=requestAnimationFrame(()=>{try{virt.raf=0;updateVirtualSlice()}catch(e){console.error(e)}})}catch(e){console.error(e)}}); window.addEventListener("resize",()=>{try{if(state.view==="list") updateVirtualSlice()}catch(e){console.error(e)}});/* Selection */function getFileIndexByPath(path){const arr=filteredFiles(); return arr.findIndex(f=>f.path===path);}
function updateSelectionUI(){const n=state.selected.size;
if(n>0){ els.selectionCount.classList.remove("hidden"); els.selectionCount.textContent=`${n} selected`; if(els.selectionInfo){els.selectionInfo.classList.remove("hidden"); els.selectionInfo.textContent=`${n} selected`; } const selFiles=[...state.selected].map(p=> filteredFiles().find(x=>x.path===p) || state.searchResults.find(x=>x.path===p) || state.files.find(x=>x.path===p)).filter(Boolean); const selTotal=selFiles.filter(f=>!f.is_dir).reduce((s,f)=>s+(Number(f.size)||0),0); const selFolders=selFiles.filter(f=>f.is_dir).length; const selSizeStr= selTotal? ` • ${fmtSize(selTotal)}` : (selFolders?` • ${selFolders} folder${selFolders>1?"s":""}`:""); els.statusText.textContent=`${n} selected${selSizeStr} • ${filteredFiles().length} items`;} else { els.selectionCount.classList.add("hidden"); if(els.selectionInfo) els.selectionInfo.classList.add("hidden"); setLoading(false); }
if(n===1){ const p=[...state.selected][0]; const f=filteredFiles().find(x=>x.path===p)||state.searchResults.find(x=>x.path===p)||state.files.find(x=>x.path===p); if(f) showDetails(f); }
else if(n===0 && state.detailsMode!=="hidden") showDetails(null);
  const personBar = document.getElementById("personPhotosActionBar");
  if (personBar) {
    if (state.currentPersonKey && n > 0) {
      personBar.classList.remove("hidden");
      const cntEl = document.getElementById("personActionCount");
      if (cntEl) cntEl.textContent = `${n} photo${n > 1 ? "s" : ""} selected`;
    } else {
      personBar.classList.add("hidden");
    }
  }
}
function handleRowClick(e,path,isDir){const idx=getFileIndexByPath(path);
if(e.shiftKey && state.lastSelectedIdx>=0){const arr=filteredFiles(); const a=Math.min(state.lastSelectedIdx,idx), b=Math.max(state.lastSelectedIdx,idx);
for(let i=a;i<=b;i++) state.selected.add(arr[i].path);} else if(e.ctrlKey||e.metaKey){if(state.selected.has(path)) state.selected.delete(path); else state.selected.add(path);state.lastSelectedIdx=idx;} else {
if(state.selected.has(path) && state.selected.size===1 && !isDir){ /* preview already */ }
else { state.selected.clear(); state.selected.add(path); state.lastSelectedIdx=idx; }
if(isDir && state.selected.size===1){ /* don't navigate if ctrl */ if(!e.ctrlKey){ /* single click: select, double-click navigates */ } }}
if(state.detailsMode==="hidden" && state.selected.size===1) { /* keep hidden until user toggles - lightweight Files-like */ }
state._focusedPath=path;refreshRowStates(); updateSelectionUI();}window.__fetchFolderSize = async (path)=>{
  const btn=document.querySelector(`[data-size-path="${(window.CSS&&window.CSS.escape?window.CSS.escape(path):path)}"]`);
  if(btn){ btn.textContent="Calculating…"; btn.disabled=true; }
  const res=await fetchFolderSize(path);
  if(btn){
    if(res && res.size!=null){ btn.outerHTML='<span style="color:var(--text-2)">'+esc(fmtSize(res.size))+'</span>'; }
    else { btn.textContent="-"; btn.disabled=false; }
  }
  renderVirtualized(false); updateCounts();
  const el=document.getElementById("folder-size-val");
  if(el && state.selected.has(path) && res && res.size!=null){ el.textContent=fmtSize(res.size); el.style.color=""; }
  return res;
};
if(els.fileContainer) els.fileContainer.addEventListener("click",e=>{try{
const vBtn=e.target.closest(".view-size");
if(vBtn){
  e.stopPropagation(); e.preventDefault();
  const p=vBtn.getAttribute("data-size-path");
  if(!p) return;
  vBtn.textContent="Calculating…"; vBtn.style.color="var(--text-3)"; vBtn.disabled=true;
  fetchFolderSize(p).then(res=>{
    if(res && res.size!=null){
      const f=filteredFiles().find(x=>x.path===p)||state.files.find(x=>x.path===p);
      const tip=f?fmtFolderTooltip(f,res):fmtSize(res.size);
      vBtn.outerHTML='<span style="color:var(--text-2)">'+esc(fmtSize(res.size))+'</span>';
      const row2=document.querySelector(`[data-path="${(window.CSS&&window.CSS.escape?window.CSS.escape(p):p)}"]`);
      if(row2) row2.title=tip;
      const el=document.getElementById("folder-size-val");
      if(el && state.selected.has(p)) { el.textContent=fmtSize(res.size); el.style.color=""; }
      updateCounts();
    } else { vBtn.textContent="-"; vBtn.disabled=false; }
  }).catch(()=>{ vBtn.textContent="-"; vBtn.disabled=false; });
  return;
}
const row=e.target.closest("[data-path]"); if(!row) return;
const path=row.getAttribute("data-path"); const isDir=row.getAttribute("data-dir")==="1";
if(row.classList.contains("check")||e.target.classList.contains("check")){ /* toggle select */ handleRowClick(e,path,isDir); return; }handleRowClick(e,path,isDir);
// One rule for files and folders alike. e.detail counts clicks even though the row re-renders
// after the first click (which is why the old dblclick listener never fired for files).
if(!e.ctrlKey && !e.shiftKey && !e.metaKey){
  if(pref("openWith","double")==="single" ? e.detail===1 : e.detail===2) activateItem(path,isDir,row.querySelector(".f-thumb,.f-icon")||row);
}
if(!isDir) { /* keep selection, details will show */ }
else if(!e.ctrlKey && !e.shiftKey && e.detail===1){ /* first click selects folder, second navigates */}}catch(e){console.error("file click",e)}});// Opening is handled by the click listener above (settings-driven); middle-click opens folders in a new tab.
if(els.fileContainer) els.fileContainer.addEventListener("auxclick",e=>{try{ if(e.button!==1) return; const row=e.target.closest("[data-path]"); if(!row) return;
  const path=row.getAttribute("data-path"); const isDir=row.getAttribute("data-dir")==="1";
  if(isDir && pref("middleClickFolder","newTab")==="newTab"){ e.preventDefault(); newTab(pathLoc(path)); }
  else if(!isDir && pref("middleClickFolder","newTab")==="newTab"){ e.preventDefault(); activateItem(path,false); }
}catch(err){console.error("auxclick",err)}});
if(els.fileContainer) els.fileContainer.addEventListener("mousedown",e=>{ if(e.button===1) e.preventDefault(); }); // no autoscroll on middle-click
// Lightweight hover: fetch folder size on demand (not for all 5000) - shows in tooltip + details
if(els.fileContainer) els.fileContainer.addEventListener("mouseover", e=>{try{const row=e.target.closest("[data-path]"); if(!row) return; if(row.getAttribute("data-dir")!=="1") return; const p=row.getAttribute("data-path"); if(!p) return;
  const cachedHover=folderSizeCache.get(p);
  if(cachedHover && (cachedHover.loading || (cachedHover.timestamp && Date.now()-cachedHover.timestamp < FOLDER_SIZE_TTL_MS && cachedHover.size!=null) || (cachedHover.error && cachedHover.timestamp && Date.now()-cachedHover.timestamp < 30000))) return; // fresh/loading/error-cooldown - stay put, no re-calc on hover
  const f=filteredFiles().find(x=>x.path===p) || state.files.find(x=>x.path===p); if(!f) return;
  fetchFolderSize(p).then(res=>{ const tip=fmtFolderTooltip(f,res); const sizeEl=row.querySelector(".f-size"); if(sizeEl) sizeEl.title=tip; row.title=`${f.name} • ${tip}`; const nameEl=row.querySelector(".f-name"); if(nameEl) nameEl.title=`${f.name} • ${tip}`; }); }catch(err){console.error("hover folder size",err)}});if(els.fileContainer) els.fileContainer.addEventListener("keydown",e=>{try{if(e.key==="Enter"){ const r=e.target.closest("[data-path]"); if(r) r.click(); }
if(e.key==="a" && (e.ctrlKey||e.metaKey)){ e.preventDefault(); selectAll(); }}catch(e){console.error("keydown",e)}});
/** Updates selection/focus marks on the rows already on screen (no re-render, so double-clicks
 *  land on the same element and nothing flickers). `withTags` also refreshes the tag column. */
function refreshRowStates(withTags){
  $$("#fileContainer [data-path]").forEach(el=>{
    const p=el.dataset.path; const on=state.selected.has(p);
    el.classList.toggle("selected",on);
    el.classList.toggle("focused",state._focusedPath===p);
    el.setAttribute("aria-selected",String(on));
    const c=el.querySelector(".check"); if(c){ c.classList.toggle("on",on); c.textContent=on?"✓":""; }
    if(withTags){ const t=el.querySelector(".f-tag"); if(t && window.PiTags) t.innerHTML=PiTags.chips(p); }
  });
}
function refreshView(){
  const l=state.loc||{k:"home"};
  if(l.k==="dir"){ invalidateFolderCache(state.path); loadDir(state.path,{keepScroll:true}); }
  else if(l.k==="home"){ loadDrives(); window.PiViews?.refreshNetwork?.(); whenViews(()=>PiViews.home()); }
  else renderLoc(l,{restoreScroll:true});
}

/* ---- the file's own icon (programs, shortcuts, .ico…) or the system icon for its type ---- */
const PER_FILE_ICON=new Set(["exe","lnk","ico","msi","url","appref-ms","scr","cpl","msc","com","cur","ani","website","appx","msix"]);
const sysIconCache=new Map(); const sysIconPending=new Set(); let sysIconQ=[], sysIconBusy=false;
function sysIconKey(f){
  const mode=pref("systemIcons","apps");
  if(mode==="off"||f.is_dir) return null;
  const e=getExt(f);
  if(PER_FILE_ICON.has(e)) return "p:"+f.path.toLowerCase();
  if(mode==="all" && !hasThumb(f)) return "e:"+e;
  return null;
}
function sysIconHtml(f,fallback,cls){
  const k=sysIconKey(f); if(!k) return null;
  const u=sysIconCache.get(k);
  if(u) return `<span class="${cls} sys"><img src="${u}" alt="" draggable="false"></span>`;
  if(u===undefined) queueSysIcon(k,f.path);
  return `<span class="${cls}" data-sysicon="${esc(k)}">${fallback}</span>`;
}
function queueSysIcon(k,path){ if(sysIconPending.has(k)) return; sysIconPending.add(k); sysIconQ.push([k,path]); if(!sysIconBusy) pumpSysIcons(); }
async function pumpSysIcons(){
  sysIconBusy=true;
  while(sysIconQ.length){
    const batch=sysIconQ.splice(0,8);
    await Promise.all(batch.map(async([k,path])=>{
      let url="";
      try{ url=await invoke("get_file_icon",{path,size:64}); }catch{}
      sysIconCache.set(k,url||""); sysIconPending.delete(k);
      if(!url) return;
      document.querySelectorAll(`[data-sysicon="${CSS.escape(k)}"]`).forEach(el=>{ el.classList.add("sys"); el.innerHTML=`<img src="${url}" alt="" draggable="false">`; el.removeAttribute("data-sysicon"); });
    }));
  }
  sysIconBusy=false;
}

/* ---- opening files: built-in viewer or the system's app, per type (Settings → File handling) ---- */
const RAW_EXTS=new Set(["cr2","cr3","crw","nef","nrw","arw","srf","sr2","dng","raf","orf","rw2","pef","srw","x3f","3fr","iiq","erf","kdc","mef","mos","rwl"]);
function fileCategory(f){
  const e=getExt(f);
  if(RAW_EXTS.has(e)) return "raw";
  if(THUMB_EXTS.has(e)) return "image";
  const k=window.PiViewer?.kind(f);
  if(k) return k; // video, audio, archive, sheet, text
  if(PDF_EXTS.has(e)) return "pdf";
  if(TEXT_EXTS.has(e)) return "text";
  return null; // nothing built in can show it meaningfully
}
function opensInViewer(f){
  const cat=fileCategory(f);
  if(!cat) return false;
  const per=(pref("openHandlers",{})||{})[cat];
  if(per) return per==="viewer";
  return pref("fileOpenAction","viewer")!=="app";
}
/** Opens an item the way the user configured: folders navigate; files open in the built-in viewer or the default app. */
function activateItem(path,isDir,originEl){
  if(isDir){ navigateTo(path); return; }
  const f=fileByPath(path)||{name:path.split("\\").pop()||path, path, is_dir:false, size:0, extension:(path.split(".").pop()||"").toLowerCase(), modified:""};
  if(getExt(f)==="lnk"||getExt(f)==="url"||getExt(f)==="exe"||getExt(f)==="msi"||!opensInViewer(f)){ addRecent(path); window.__openExternal?.(path); }
  else openViewer(f,originEl);
}
function selectAll(){filteredFiles().forEach(f=>state.selected.add(f.path)); refreshRowStates(); updateSelectionUI();}
// --- Viewer helpers for details pane + modal ---
function viewerOpenBtnHtml(path){ return `<button class="tbtn small" data-act="viewer" data-arg="${esc(path)}" style="margin-top:6px;width:100%">Open viewer (double-click)</button>`; }
async function renderDetailsPreview(file){
  const ext=getExt(file);
  const isDir=!!file.is_dir;
  if(isDir) return `<div class="ph">📁</div>`;
  // Image (including svg) - max quality via asset:// streaming, thumb placeholder for instant paint
  if(THUMB_EXTS.has(ext)){
    if(ext==="svg"){
      const url=assetUrl(file.path);
      return `<img src="${url}" alt="${esc(file.name)}" style="max-width:100%;max-height:200px;object-fit:contain" data-onerr="hide-next-block"><div style="display:none;font-size:22px">🖼</div><div style="font-size:10px;color:var(--text-3)">SVG • <a href="#" data-act="viewer" data-arg="${esc(file.path)}">open viewer</a></div>`;
    }
    const asset=assetUrl(file.path);
    const thumb=thumbCache.get(file.path) || thumbCache.get("preview:"+file.path) || "";

    const safeName=esc(file.name);
    // Progressive: show thumb instantly if cached (blurred), swap to max-quality asset when loaded
    // Asset streaming is max quality (original pixels via Tauri asset protocol, no 512 q75 recompress)
    // onerror -> fallback to high-quality 2048 q90 base64 (covers heic/heif where asset may fail)
    if(thumb){
      return `<div style="position:relative;display:grid;place-items:center;min-height:60px"><img src="${thumb}" alt="${safeName}" data-thumb-preview style="max-width:100%;max-height:200px;object-fit:contain;filter:blur(1px);opacity:.9;transition:opacity .15s"><img src="${asset}" alt="${safeName}" style="max-width:100%;max-height:200px;object-fit:contain;cursor:zoom-in;position:absolute;inset:0;margin:auto;opacity:0;transition:opacity .22s" data-onload="reveal" data-onerr="asset-fallback" data-fallback="${esc(file.path)}" data-act="viewer" data-arg="${esc(file.path)}"><div style="font-size:10px;color:var(--text-3);margin-top:4px">Max quality • streamed • click to zoom</div></div>`;
    }
    // No thumb cached yet - show asset immediately (still max quality, faster than waiting for Rust 2048 encode + base64)
    if(!thumbCache.has(file.path) && !thumbPending.has(file.path)) fetchThumb(file.path).catch(()=>{});
    return `<img src="${asset}" alt="${safeName}" style="max-width:100%;max-height:200px;object-fit:contain;cursor:zoom-in" data-act="viewer" data-arg="${esc(file.path)}" data-onerr="asset-fallback-keep" data-fallback="${esc(file.path)}"><div style="font-size:10px;color:var(--text-3)">Max quality • streamed • click to zoom</div>`;
  }
  if(RAW_EXTS.has(ext)){
    const url=thumbCache.get("preview:"+file.path) || await fetchPreview(file.path);
    return url? `<img src="${url}" alt="${esc(file.name)}" style="max-width:100%;max-height:200px;object-fit:contain;cursor:zoom-in" data-act="viewer" data-arg="${esc(file.path)}"><div style="font-size:10px;color:var(--text-3)">RAW photo • camera preview</div>` : `<div class="ph">${iconFor(file)}</div><div style="font-size:11px;color:var(--text-3)">RAW photo</div>`;
  }
  if(VIDEO_EXTS.has(ext)){
    const url=assetUrl(file.path);
    return `<video controls preload="metadata" src="${url}" style="max-width:100%;max-height:200px;background:#000;border-radius:6px"></video><div style="font-size:10px;color:var(--text-3);margin-top:4px">Video • double-click for viewer</div>`;
  }
  if(AUDIO_EXTS.has(ext)){
    const url=assetUrl(file.path);
    return `<div style="font-size:22px">🎵</div><audio controls preload="metadata" src="${url}" style="width:100%;margin-top:6px"></audio>`;
  }
  if(PDF_EXTS.has(ext)){
    // small pdf → iframe via assetUrl; details shows first page hint + open button
    if((file.size||0) < 5*1024*1024){
      const url=assetUrl(file.path);
      return `<iframe src="${url}" style="width:100%;height:180px;border:1px solid var(--border);border-radius:6px;background:#fff"></iframe><div style="font-size:10px;color:var(--text-3)">PDF • <a href="#" data-act="viewer" data-arg="${esc(file.path)}">open viewer</a> • <a href="#" data-act="external" data-arg="${esc(file.path)}">open externally</a></div>`;
    }
    return `<div class="ph">📄</div><div style="font-size:11px;color:var(--text-3)">PDF • ${(file.size?fmtSize(file.size):"")} • <a href="#" data-act="external" data-arg="${esc(file.path)}">open externally</a></div>`;
  }
  if(TEXT_EXTS.has(ext) && ext!=="svg"){
    // fetch text preview inline (lightweight 200KB cap)
    try{
      const txt=await safeInvoke("read_text_file",{path:file.path, limit: 4000}, null);
      if(txt!=null){
        let display=txt;
        // simple md highlight
        if(ext==="md") display=txt.slice(0,1200);
        if(display.length>1200) display=display.slice(0,1200)+"\\n… truncated";
        return `<pre style="max-height:160px">${esc(display)}</pre><div style="font-size:10px;color:var(--text-3)">Text preview • double-click for full viewer</div>`;
      }
    }catch(e){ /* binary -> hex */ }
    return `<div class="ph">📝</div><div style="font-size:11px;color:var(--text-3)">Text file • double-click to view</div>`;
  }
  if(ARCHIVE_EXTS.has(ext)){
    return `<div class="ph">📦</div><div style="font-size:11px;color:var(--text-3)">Archive • double-click to list contents (100 max)</div>`;
  }
  if(DOC_EXTS.has(ext)){
    return `<div class="ph">${iconFor(file)}</div><div style="font-size:11px;color:var(--text-3)">${esc(ext.toUpperCase())} document • <a href="#" data-act="external" data-arg="${esc(file.path)}">open externally</a></div>`;
  }
  // fallback - try hex preview hint
  return `<div class="ph">${iconFor(file)}</div><div style="font-size:11px;color:var(--text-3)">Double-click for viewer • properties below</div>`;
}
async function showDetails(file){ await showDetailsBasic(file); if(file) upgradeDetailsProps(file); }
async function showDetailsBasic(file){
  if(!file){
    if(els.detailsPreview) els.detailsPreview.innerHTML=`<div class="empty" style="padding:16px"><div class="ico pf-empty-ico">${window.PiIcons?PiIcons.ui("eye"):""}</div><div>Select a file to preview</div></div>`;
    if(els.detailsProps) els.detailsProps.innerHTML=`<div class="empty" style="padding:10px;color:var(--text-3)">No selection</div>`;
    return;
  }
  const isDir=!!file.is_dir;
  const ext=getExt(file);
  let preview="";
  try{ preview=await renderDetailsPreview(file); }catch{ preview=`<div class="ph">${isDir?folderIcon():iconFor(file)}</div>`; }
  if(els.detailsPreview) els.detailsPreview.innerHTML=preview;
  if(isDir){
    const countLabel=fmtFolderLabel(file);
    const cached=folderSizeCache.get(file.path);
    let sizeHtml="";
    if(cached && cached.size!=null){ sizeHtml=`<span id="folder-size-val" data-for="${esc(file.path)}">${esc(fmtSize(cached.size))}</span><span style="color:var(--text-3);margin-left:6px">${esc(countLabel)}</span>`; }
    else if(cached && cached.loading){ sizeHtml=`<span id="folder-size-val" data-for="${esc(file.path)}" style="color:var(--text-3)">Calculating...</span><span style="color:var(--text-3);margin-left:6px">${esc(countLabel)}</span>`; }
    else { sizeHtml=`<span id="folder-size-val" data-for="${esc(file.path)}" style="color:var(--text-3)">Calculating...</span><span style="color:var(--text-3);margin-left:6px">${esc(countLabel)}</span>`; }
    const props=[["Name",file.name],["Path",file.path],["Type","Folder"],["Items",countLabel],["Size",sizeHtml],["Modified",fmtDate(file.modified)],["Extension","-"]];
    if(els.detailsProps) els.detailsProps.innerHTML=props.map(([k,v])=> k==="Size"? `<div class="prop"><span>${esc(k)}</span><span>${v}</span></div>` : `<div class="prop"><span>${esc(k)}</span><span title="${esc(String(v))}">${esc(String(v))}</span></div>`).join("")+`<button class="tbtn" style="margin-top:8px;width:100%" data-act="copy" data-arg="${esc(file.path)}">Copy path</button>`;
    // only fetch if not fresh and not already loading - stays put on selection/hover
    {
      const fresh = cached && cached.timestamp && (Date.now()-cached.timestamp < FOLDER_SIZE_TTL_MS) && cached.size!=null;
      const errCooldown = cached && cached.error && cached.timestamp && (Date.now()-cached.timestamp < 30000);
      const shouldFetch = !cached || (!cached.loading && !fresh && !errCooldown);
      if(shouldFetch){
        fetchFolderSize(file.path).then(res=>{
          const el=document.getElementById("folder-size-val");
          if(!el) return;
          if(res && res.size!=null){ el.textContent=fmtSize(res.size); el.style.color=""; const sel=document.querySelector(`[data-path="${(window.CSS&&window.CSS.escape?window.CSS.escape(file.path):file.path)}"] .f-size`); if(sel) sel.title=fmtFolderTooltip(file,res); } else { el.textContent="-"; }
        });
      }
    }
  } else {
    const typeLabel=ext ? ext.toUpperCase()+" File" : "File";
    let dims="-";
    const base=[["Name",file.name],["Path",file.path],["Type",typeLabel],["Size",fmtSize(file.size)],["Modified",fmtDate(file.modified)],["Extension",ext||"-"]];
    if(THUMB_EXTS.has(ext)) base.splice(3,0,["Dimensions",dims]);
    if(els.detailsProps) els.detailsProps.innerHTML=base.map(([k,v])=>`<div class="prop"><span>${esc(k)}</span><span title="${esc(String(v))}">${esc(String(v))}</span></div>`).join("")+`<button class="tbtn" style="margin-top:8px;width:100%" data-act="copy" data-arg="${esc(file.path)}">Copy path</button>`;
    if(THUMB_EXTS.has(ext)){
      try{
        const probeUrl=thumbCache.get("preview:"+file.path)||thumbCache.get(file.path)||assetUrl(file.path);
        const im=new Image();
        im.onload=()=>{
          const d=`${im.naturalWidth} x ${im.naturalHeight}`;
          const row=[...els.detailsProps.querySelectorAll(".prop")].find(el=>el.firstChild&&el.firstChild.textContent==="Dimensions");
          if(row){ const v=row.querySelector("span:last-child"); if(v) { v.textContent=d; v.title=d; } }
        };
        im.onerror=()=>{};
        im.src=probeUrl;
      }catch{}
    }
  }
}
/** Full properties (OS property system) replace the basic list when the backend is available. */
function upgradeDetailsProps(file){
  if(!window.PiProps || !window.__TAURI__ || !els.detailsProps) return;
  els.detailsProps.dataset.for=file.path;
  const opts=file.is_dir?{countLabel:fmtFolderLabel(file), folderSize:fetchFolderSize(file.path).then(r=>r?.size)}:{};
  PiProps.renderPane(els.detailsProps, file.path, opts);
}
/** Explorer-style Properties dialog in its own window (Alt+Enter / context menu). */
async function openPropertiesWindow(paths){
  paths=(paths||[]).filter(Boolean); if(!paths.length){ toast("Select something first"); return; }
  if(!window.__TAURI__){ const f=fileByPath(paths[0]); if(f){ setDetailsMode("details"); showDetails(f); } return; }
  try{ await invoke("open_properties_window",{paths}); }catch(e){ toast(String(e?.message||e)); }
}
window.__openProperties=openPropertiesWindow;
function getDetailsMode(){ return state.detailsMode; }
function setDetailsMode(mode){
  const valid=new Set(["preview","details","hidden"]);
  if(!valid.has(mode)) mode="preview";
  state.detailsMode=mode;
  state.detailsOpen=mode!=="hidden";
  if(mode!=="hidden") state._lastDetailsTab=mode;
  localStorage.setItem("fe:detailsMode",mode);
  localStorage.setItem("fe:details",mode!=="hidden"?"1":"0");
  const isHidden=mode==="hidden";
  paneVisibility(isHidden);
  if(els.detailsToggle){
    els.detailsToggle.classList.toggle("active",!isHidden);
    els.detailsToggle.title=isHidden ? "Show preview pane (Ctrl+Shift+D)" : "Hide preview pane (Ctrl+Shift+D)";
    els.detailsToggle.setAttribute("aria-pressed",String(!isHidden));
  }
  const tabBtns=document.querySelectorAll("[data-details-tab]");
  tabBtns.forEach(b=>{
    const isActive=b.getAttribute("data-details-tab")===mode;
    b.classList.toggle("active",isActive);
    b.setAttribute("aria-selected",String(isActive));
  });
  const previewTab=document.getElementById("detailsPreviewTab");
  const propsTab=document.getElementById("detailsPropsTab");
  if(previewTab) previewTab.classList.toggle("hidden",mode!=="preview");
  if(propsTab) propsTab.classList.toggle("hidden",mode!=="details");
  if(!isHidden){
    // Fill the pane after it has slid in, so decoding a preview never competes with the motion.
    clearTimeout(state._paneFillT);
    state._paneFillT=setTimeout(()=>{
      if(state.detailsMode==="hidden") return;
      if(state.selected.size===1){
        const p=[...state.selected][0];
        const f=filteredFiles().find(x=>x.path===p)||state.searchResults.find(x=>x.path===p)||state.files.find(x=>x.path===p);
        if(f) showDetails(f); else showDetails(null);
      } else if(state.selected.size===0){
        showDetails(null);
      }
    }, PANE_MS);
  }
}
/* Opening/closing the right pane: the layout changes exactly once (no width animation, which
   re-laid-out the whole file list on every frame) and only the pane's contents slide, which the
   compositor does on the GPU. */
function paneVisibility(hide){
  const pane=els.detailsPane, rz=els.detailsResizer; if(!pane) return;
  const animate=!document.documentElement.classList.contains("pf-no-anim") && document.documentElement.dataset.perf!=="low";
  clearTimeout(pane._t);
  if(hide){
    if(pane.classList.contains("hidden")) return;
    if(!animate){ pane.classList.add("hidden"); rz?.classList.add("hidden"); return; }
    pane.classList.add("pf-pane-out");
    pane._t=setTimeout(()=>{ pane.classList.add("hidden"); pane.classList.remove("pf-pane-out"); rz?.classList.add("hidden"); }, PANE_MS);
  } else {
    pane.classList.remove("pf-pane-out");
    if(!pane.classList.contains("hidden")) return;
    if(animate) pane.classList.add("pf-pane-in");
    pane.classList.remove("hidden"); rz?.classList.remove("hidden");
    if(animate){ void pane.offsetWidth; requestAnimationFrame(()=>pane.classList.remove("pf-pane-in")); }
  }
}
function toggleDetails(open){
  if(typeof open==="boolean"){
    if(open) setDetailsMode(state._lastDetailsTab||"preview");
    else setDetailsMode("hidden");
    return;
  }
  if(state.detailsMode==="hidden") setDetailsMode(state._lastDetailsTab||"preview");
  else setDetailsMode("hidden");
}
// --- Built-in viewer modal (Files-app like, lightweight, on-demand) ---
let currentViewerFile=null;
let viewerOrigin=null;
function viewerOriginEl(path){
  if(!path) return null;
  const sel=`[data-path="${CSS.escape(path)}"]`;
  const row=document.querySelector(`#fileContainer ${sel}`) || document.querySelector(`.gv-tile${sel}, .hv-recent-row${sel}`);
  const el=row?.querySelector(".f-thumb, .f-icon, img") || row;
  return el && el.getClientRects().length ? el : null;
}
async function closeViewer(){
  if(window.PiViewer && !(await PiViewer.canClose())) return;
  if(window.PiImageEditor && !(await PiImageEditor.canClose())) return;
  try{ window.PiViewer?.dispose(); }catch{}
  try{ window.PiImageEditor?.dispose(); }catch{}
  // Shrink back into the file it came from (wherever that row is now).
  const back=viewerOriginEl(currentViewerFile?.backTo?.path || currentViewerFile?.path) || viewerOrigin;
  if(els.viewerModal && window.PiMotion?.closeTo) PiMotion.closeTo(els.viewerModal, back);
  else if(els.viewerModal) els.viewerModal.classList.add("hidden");
  // Clear after the close animation so the dialog doesn't collapse while it shrinks away.
  const content=els.viewerContent;
  setTimeout(()=>{ if(content && els.viewerModal?.classList.contains("hidden")) content.innerHTML=""; }, 320);
  currentViewerFile=null;
  document.body.style.overflow="";
}
// A file opened from inside an archive offers a way back to the archive listing.
function addViewerBackButton(file){
  if(!file || !file.backTo || !els.viewerContent) return;
  const b=document.createElement("button");
  b.className="pf-btn pv-back";
  b.innerHTML=`${window.PiIcons?PiIcons.ui("back"):"‹"} Back to ${esc(file.backTo.name)}`;
  b.onclick=()=>openViewer(file.backTo);
  els.viewerContent.prepend(b);
}
async function openViewer(file,originEl){
  if(!file) return;
  const wasOpen=els.viewerModal && !els.viewerModal.classList.contains("hidden");
  currentViewerFile=file;
  if(!file.backTo) addRecent(file.path);
  const ext=getExt(file);
  if(els.viewerTitle) els.viewerTitle.textContent=file.name+" • "+(file.size?fmtSize(file.size):"-")+" • "+ext.toUpperCase();
  if(els.viewerModal && !wasOpen){
    viewerOrigin=originEl||viewerOriginEl(file.path);
    if(window.PiMotion) PiMotion.open(els.viewerModal, viewerOrigin); else els.viewerModal.classList.remove("hidden");
  }
  if(els.viewerContent) els.viewerContent.innerHTML=`<div style="padding:20px;color:var(--text-3)"><span class="spinner"></span> Loading preview…</div>`;
  if(els.viewerMeta) els.viewerMeta.innerHTML=`<span class="pill">${esc(file.path)}</span><span class="pill">${file.is_dir?"Folder":fmtSize(file.size)}</span><span class="pill">${fmtDate(file.modified)}</span>`;
  if(els.viewerMovePerson){
    if(state.currentPersonKey && !file.is_dir && THUMB_EXTS.has(ext)){
      els.viewerMovePerson.classList.remove("hidden");
      els.viewerMovePerson.onclick = () => {
        closeViewer();
        state.selected = new Set([file.path]);
        updateSelectionUI();
        renderVirtualized(false);
        const moveBtn = document.getElementById("moveSelectedPhotosBtn");
        if(moveBtn) moveBtn.click();
      };
    } else {
      els.viewerMovePerson.classList.add("hidden");
    }
  }
  document.body.style.overflow="hidden";
  const viewerBox=els.viewerContent?.closest(".viewer-box");
  // Movies, music, archives and spreadsheets have dedicated viewers (viewer-plus.js).
  if(window.PiViewer && PiViewer.kind(file) && els.viewerContent){
    try{
      await PiViewer.render(file, els.viewerContent, {
        openInner: f=>openViewer(f),
        goUp: ()=>false,
        navigate: p=>{ closeViewer(); if(state.isSearching) clearSearch(); navigateTo(p); },
      });
    }catch(e){ els.viewerContent.innerHTML=`<div style="padding:20px;color:#d13438">Preview failed: ${esc(String(e.message||e))}</div>`; }
    addViewerBackButton(file);
    return;
  }
  try{ window.PiViewer?.dispose(); }catch{}
  try{ window.PiImageEditor?.dispose(); }catch{}
  viewerBox?.classList.remove("pf-viewer-wide","pf-viewer-media");
  // render by type
  try{
    let html="";
    if(file.is_dir){
      html=`<div style="text-align:center;padding:20px"><div style="font-size:32px">📁</div><div style="margin-top:8px">${esc(file.name)}</div><div style="font-size:11px;color:var(--text-3)">${esc(fmtFolderLabel(file))}</div></div>`;
    } else if((THUMB_EXTS.has(ext)||RAW_EXTS.has(ext)) && ext!=="svg" && window.PiImageEditor){
      // Images open in the viewer/editor (zoom, pan, crop, adjust, AI tools, undo, history).
      const native=NATIVE_IMG_EXTS.has(ext);
      let src=native? assetUrl(file.path) : null;
      if(!native){ try{ src=await invoke("get_file_preview",{path:file.path}); }catch{} }
      if(src){
        viewerBox?.classList.add("pf-viewer-wide");
        els.viewerContent.classList.remove("has-text");
        PiImageEditor.mount(els.viewerContent, file, {
          src, thumb: thumbCache.get(file.path)||"", editable:true,
          onSaved:(out)=>{ thumbCache.delete(file.path); thumbCache.delete("preview:"+file.path); if(state.loc?.k==="dir") loadDir(state.path,{keepScroll:true}); },
          onError:async(ed)=>{ try{ const u=await invoke("get_file_preview",{path:file.path}); if(u && ed.src!==u){ ed.src=u; ed.img.src=u; return; } }catch{} els.viewerContent.innerHTML=`<div style="font-size:32px">🖼</div><div style="color:var(--text-3)">Preview unavailable</div>`; },
        });
        addViewerBackButton(file);
        return;
      }
      els.viewerContent.innerHTML=`<div style="font-size:32px">🖼</div><div style="color:var(--text-3)">Preview unavailable</div>`;
      return;
    } else if(THUMB_EXTS.has(ext)||RAW_EXTS.has(ext)){
      if(ext==="svg"){
        const url=assetUrl(file.path);
        html=`<img class="viewer-img" src="${url}" alt="${esc(file.name)}" style="cursor:zoom-in" data-act="zoom-toggle">`;
      } else {
        // Formats the web view decodes natively are streamed straight from disk (asset protocol):
        // no backend decode, resize, re-encode or base64, and the GPU decodes it. The cached
        // thumbnail shows instantly underneath while the full image decodes. HEIC/RAW (and any
        // file the web view can't read) fall back to the backend's resized preview.
        const native=NATIVE_IMG_EXTS.has(ext);
        const thumb=thumbCache.get(file.path)||"";
        if(native){
          const url=assetUrl(file.path);
          html=`<div class="viewer-img-stack">${thumb?`<img class="viewer-img viewer-ph" src="${thumb}" alt="" aria-hidden="true">`:""}<img class="viewer-img viewer-full" src="${url}" alt="${esc(file.name)}" decoding="async" style="cursor:zoom-in" data-act="zoom-toggle" data-onload="viewer-ready" data-onerr="viewer-fallback" data-fallback="${esc(file.path)}"></div><div style="font-size:11px;color:var(--text-3);margin-top:8px">Click to zoom • ${fmtSize(file.size)}</div>`;
        } else {
          let b64=null;
          try{ b64=await invoke("get_file_preview",{path:file.path}); }catch{}
          html= b64 ? `<img class="viewer-img" src="${b64}" alt="${esc(file.name)}" style="cursor:zoom-in" data-act="zoom-toggle"><div style="font-size:11px;color:var(--text-3);margin-top:8px">Click to zoom • ${fmtSize(file.size)}</div>`
                    : `<div style="font-size:32px">🖼</div><div style="color:var(--text-3)">Preview unavailable</div>`;
        }
      }
      if(els.viewerContent) els.viewerContent.classList.remove("has-text");
    } else if(VIDEO_EXTS.has(ext)){
      const url=assetUrl(file.path);
      html=`<video controls autoplay style="max-width:100%;max-height:62vh;background:#000;border-radius:8px" src="${url}"></video><div style="font-size:11px;color:var(--text-3);margin-top:8px">Video • ${fmtSize(file.size)} • streamed via asset protocol (no base64, low RAM)</div>`;
      if(els.viewerContent) els.viewerContent.classList.remove("has-text");
    } else if(AUDIO_EXTS.has(ext)){
      const url=assetUrl(file.path);
      html=`<div style="text-align:center;width:100%"><div style="font-size:40px">🎵</div><div style="margin:8px 0 12px">${esc(file.name)}</div><audio controls autoplay src="${url}" style="width:100%;max-width:520px"></audio></div>`;
      if(els.viewerContent) els.viewerContent.classList.remove("has-text");
    } else if(PDF_EXTS.has(ext)){
      if(true){ // streamed by WebView2's PDF viewer, any size
        const url=assetUrl(file.path);
        html=`<iframe src="${url}" style="width:100%;height:62vh;border:1px solid var(--border);border-radius:6px;background:#fff"></iframe>`;
      } else {
        html=`<div style="text-align:center;padding:20px"><div style="font-size:32px">📄</div><div>PDF too large for inline preview (${fmtSize(file.size)})</div><button class="tbtn" style="margin-top:8px" data-act="external" data-arg="${esc(file.path)}">Open externally</button></div>`;
      }
      if(els.viewerContent) els.viewerContent.classList.remove("has-text");
    } else if(TEXT_EXTS.has(ext) && ext!=="svg"){
      try{
        const txt=await invoke("read_text_file",{path:file.path, limit: 200*1024});
        let display=txt||"(empty)";
        // escape and simple highlight
        html=`<pre class="viewer-text">${esc(display)}</pre>`;
        if(els.viewerContent) els.viewerContent.classList.add("has-text");
      }catch(e){
        try{
          const hex=await invoke("get_hex_preview",{path:file.path});
          html=`<pre class="viewer-hex">${esc(hex)}</pre>`;
          if(els.viewerContent) els.viewerContent.classList.add("has-text");
        }catch(e2){
          html=`<div style="padding:20px;color:var(--text-3)">Unable to preview text: ${esc(String(e.message||e))}</div>`;
        }
      }
    } else if(ARCHIVE_EXTS.has(ext)){
      try{
        const entries=await invoke("list_archive",{path:file.path});
        const list=(Array.isArray(entries)?entries:[]).slice(0,100);
        if(!list.length) html=`<div style="padding:20px;color:var(--text-3)">Empty archive or unsupported format</div>`;
        else {
          html=`<div class="archive-list">${list.map(it=>{
            const name=esc(it.name||it);
            const sz=it.size!=null?fmtSize(it.size):"";
            const isDir=it.is_dir||String(it.name||"").endsWith("/");
            const icon=isDir?"📁": (()=>{
              const e=(String(it.name||"").split(".").pop()||"").toLowerCase();
              if(["jpg","jpeg","png","gif","webp"].includes(e)) return "🖼";
              if(["mp4","mkv"].includes(e)) return "🎬";
              if(["pdf"].includes(e)) return "📄";
              return "📄";
            })();
            return `<div class="archive-entry"><span class="ae-icon">${icon}</span><span class="ae-name" title="${name}">${name}</span><span class="ae-size">${sz}</span></div>`;
          }).join("")}</div>`;
        }
        if(els.viewerContent) els.viewerContent.classList.add("has-text");
      }catch(e){
        html=`<div style="padding:20px;text-align:center"><div style="font-size:32px">📦</div><div style="margin-top:8px">${esc(String(e.message||e))}</div><button class="tbtn" style="margin-top:10px" data-act="external" data-arg="${esc(file.path)}">Open externally</button></div>`;
        if(els.viewerContent) els.viewerContent.classList.remove("has-text");
      }
    } else if(DOC_EXTS.has(ext)){
      html=`<div style="text-align:center;padding:20px"><div style="font-size:32px">${iconFor(file)}</div><div style="margin-top:8px">${esc(file.name)}</div><div style="font-size:11px;color:var(--text-3)">${esc(ext.toUpperCase())} • ${fmtSize(file.size)} • No inline renderer (lightweight)</div><button class="tbtn" style="margin-top:12px" data-act="external" data-arg="${esc(file.path)}">Open with default app</button></div>`;
      if(els.viewerContent) els.viewerContent.classList.remove("has-text");
    } else {
      // other / exe / binary -> hex preview 512 bytes + properties
      try{
        const hex=await invoke("get_hex_preview",{path:file.path});
        html=`<div style="width:100%"><div style="font-size:11px;color:var(--text-3);margin-bottom:6px">Hex preview (first 512 bytes) • ${fmtSize(file.size)}</div><pre class="viewer-hex">${esc(hex)}</pre></div>`;
        if(els.viewerContent) els.viewerContent.classList.add("has-text");
      }catch(e){
        html=`<div style="text-align:center;padding:20px"><div style="font-size:32px">${iconFor(file)}</div><div>${esc(file.name)}</div><div style="font-size:11px;color:var(--text-3)">${fmtSize(file.size)} • ${esc(ext||"file")}</div><button class="tbtn" style="margin-top:10px" data-act="external" data-arg="${esc(file.path)}">Open externally</button></div>`;
        if(els.viewerContent) els.viewerContent.classList.remove("has-text");
      }
    }
    if(els.viewerContent) els.viewerContent.innerHTML=html;
    addViewerBackButton(file);
  }catch(e){
    if(els.viewerContent) els.viewerContent.innerHTML=`<div style="padding:20px;color:#d13438">Preview failed: ${esc(String(e.message||e))}</div>`;
  }
}
window.__viewerOpen=(path)=>{
  const f=filteredFiles().find(x=>x.path===path)||state.files.find(x=>x.path===path)||state.searchResults.find(x=>x.path===path);
  if(f) openViewer(f); else openViewer({name:path.split("\\").pop()||path, path, is_dir:false, size:0, extension:(path.split(".").pop()||"").toLowerCase(), modified:""});
};
/* ---------- Context menus ----------
   PiFiles' own commands first, then the system's (Open in Terminal, 7-Zip, Git, Send to, …)
   read live from the OS - under "Show more options" or inline, per Settings → Context menu. */
let ctxTarget=null;
const ctxStack=[]; // open menu elements, top level first
function getSelectedPathsForOp(file){
  if(state.selected.has(file.path) && state.selected.size>0) return [...state.selected];
  return [file.path];
}
function fileByPath(p){ return filteredFiles().find(x=>x.path===p)||state.searchResults.find(x=>x.path===p)||state.files.find(x=>x.path===p)||null; }
const mIco=n=> !n? "" : String(n).startsWith("<")||String(n).startsWith("data:")? (String(n).startsWith("data:")?`<img src="${n}" alt="">`:n) : (window.PiIcons?PiIcons.ui(n):"");
const isArchivePath=p=>window.PiViewer?.kind({name:p,path:p})==="archive";
const OWN_LABELS=new Set(["open","open in new tab","open in new window","open with","cut","copy","paste","delete","rename","properties","share","copy as path","copy path","restore previous versions","refresh","view","sort by","group by","new","undo","redo","select all","pin to quick access","unpin from quick access"]);
const SKIP_VERBS=new Set(["cut","copy","paste","delete","rename","open","explore","opennewwindow","opennewprocess","opennewtab","pintohome","refresh"]);
function sysSeen(){ try{ return JSON.parse(localStorage.getItem("pf:sysSeen")||"{}"); }catch{ return {}; } }
function rememberSysItems(items){ const s=sysSeen(); const walk=l=>l.forEach(i=>{ if(i.separator) return; s[i.label]={icon:i.icon||null,verb:i.verb||"",t:Date.now()}; }); walk(items); try{ localStorage.setItem("pf:sysSeen",JSON.stringify(s)); }catch{} }
/** System menu → our item format, minus what PiFiles already offers and what the user hid. */
function convertSys(items, token){
  const place=pref("sysMenuPlacement",{})||{};
  const conv=list=>list.filter(i=>{
    if(i.separator) return true;
    const l=i.label.toLowerCase();
    if(i.verb==="properties"){ i.label="Properties (Windows)"; return place[i.label]!=="hidden"; }
    if(i.verb==="PreviousVersions"){ i.label="Windows previous versions"; return place[i.label]!=="hidden"; }
    if(SKIP_VERBS.has(String(i.verb).toLowerCase())) return false;
    if(OWN_LABELS.has(l)) return false;
    return place[i.label]!=="hidden";
  }).map(i=> i.separator? {sep:true} : ({label:i.label, icon:i.icon||null, disabled:i.disabled, sys:true, children: i.children?.length? conv(i.children):null,
      action: i.children?.length? null : ()=>invoke("shell_menu_invoke",{token,id:i.id}).then(()=>setTimeout(()=>{ if(state.loc?.k==="dir") loadDir(state.path,{keepScroll:true}); },1200)).catch(e=>toast(String(e?.message||e)))}));
  const out=conv(items);
  while(out.length && out[0].sep) out.shift();
  while(out.length && out[out.length-1].sep) out.pop();
  return out.filter((x,i,a)=>!(x.sep && a[i-1]?.sep));
}
/** Loads the OS menu; returns {more, main} item lists. */
async function loadSystemItems(paths, background){
  if(pref("systemMenu","submenu")==="off") return {more:[],main:[]};
  try{
    const m=await invoke("shell_menu",{paths:background?[]:paths, background:background||null, extended:!!window.__shiftHeld});
    rememberSysItems(m.items);
    const all=convertSys(m.items, m.token);
    const place=pref("sysMenuPlacement",{})||{};
    const inline=pref("systemMenu","submenu")==="inline";
    const main=all.filter(i=>!i.sep && (inline || place[i.label]==="main"));
    const more=inline?[]:all.filter(i=>i.sep || place[i.label]!=="main");
    return {main, more};
  }catch(e){ return {main:[],more:[],error:String(e?.message||e)}; }
}
function customActionItems(paths, kind){
  const acts=pref("customActions",[])||[];
  const first=paths[0]||state.path||"";
  const dir= kind==="background"? state.path : (fileByPath(first)?.is_dir? first : first.replace(/[\\/][^\\/]*$/,""));
  return acts.filter(a=>a && a.name && a.program && (a.on==="all" || a.on===kind || (a.on==="both" && kind!=="background")) &&
      (!a.exts || kind!=="files" || paths.every(p=>a.exts.toLowerCase().split(/[\s,;]+/).filter(Boolean).includes((p.split(".").pop()||"").toLowerCase()))))
    .map(a=>({label:a.name, icon:"terminal", action:()=>{
      const name=(first.split(/[\\/]/).pop()||"");
      // Placeholders are expanded by the backend, which also asks (natively, once) before a
      // program runs for the first time and passes values to shells via environment variables.
      invoke("run_custom_action",{program:a.program,template:a.args||"",paths,dir:dir||null}).catch(e=>{ const m=String(e?.message||e); if(m!=="Not allowed") toast(m); });
    }}));
}
function splitArgs(s){ const out=[]; let cur="", q=null; for(const ch of s){ if(q){ if(ch===q) q=null; else cur+=ch; } else if(ch==='"'||ch==="'") q=ch; else if(/\s/.test(ch)){ if(cur){ out.push(cur); cur=""; } } else cur+=ch; } if(cur) out.push(cur); return out; }
function tagMenuItems(paths){
  if(!window.PiTags) return [];
  const tags=PiTags.all();
  return [...tags.map(t=>({label:t.name, icon:`<span class="ctx-dot" style="--tc:${esc(t.color)}"></span>`, checked: paths.every(p=>PiTags.has(p,t.id)), keepOpen:true,
      action:()=>{ PiTags.toggle(paths,t.id); refreshRowStates(true); }})),
    ...(tags.length?[{sep:true}]:[]),
    {label:"New tag…", icon:"add", action:async()=>{ const n=await PiDialog.prompt({title:"New tag",message:"Name the tag",placeholder:"e.g. Invoices",okText:"Create and apply"}); const t=n&&PiTags.create(n); if(t){ PiTags.toggle(paths,t.id); refreshRowStates(true); } }},
    {label:"Manage tags…", icon:"edit", action:()=>PiSettings.open("tags")}];
}
async function extractArchive(path, mode){
  try{
    if(mode==="here"){ const r=await invoke("archive_extract_all",{path,password:null}); toast(`Extracted ${r.count} file${r.count===1?"":"s"}`); if(state.loc?.k==="dir") loadDir(state.path,{keepScroll:true}); }
    else { const dest=await invoke("pick_folder",{title:`Extract “${path.split("\\").pop()}” to…`, start:path.replace(/[\\/][^\\/]*$/,"")}); if(!dest) return; const n=await invoke("archive_extract_selected",{path,entries:[],base:"",dest,password:null}); toast(`Extracted ${n} file${n===1?"":"s"} to ${dest}`); navigateTo(dest); }
  }catch(e){ if(/PASSWORD/.test(String(e?.message||e))) openViewer(fileByPath(path)||{name:path.split("\\").pop(),path,is_dir:false,size:0,extension:"",modified:""}); else toast("Extract failed: "+(e?.message||e)); }
}
function copyPaths(paths){ const t=paths.join("\r\n"); navigator.clipboard?.writeText(t).then(()=>toast(paths.length>1?`Copied ${paths.length} paths`:"Path copied")).catch(()=>toast(t)); }
const isDriveRoot=p=>/^[A-Za-z]:[\\/]?$/.test(String(p||""));
function driveInfo(p){ const k=String(p).slice(0,2).toUpperCase(); return (state.drives||[]).find(d=>String(d.path||d.mount_point||"").slice(0,2).toUpperCase()===k)||null; }
async function doRenameDrive(path){
  const d=driveInfo(path); const letter=String(path).slice(0,2).toUpperCase();
  const cur=(d && d.label && !/^Local Disk$/i.test(d.label))? d.label : "";
  const name=await PiDialog.prompt({title:`Rename drive ${letter}`, message:"The drive name appears next to its letter, e.g. “Photos (D:)”. Leave empty to remove it.", value:cur, placeholder:"Drive name", okText:"Rename"});
  if(name==null || name.trim()===cur) return;
  try{ await invoke("rename_volume",{root:letter+"\\",label:name.trim()}); toast(`Renamed ${letter} to “${name.trim()||"Local Disk"}”`); await loadDrives(); if(state.loc?.k==="home") window.PiViews?.home(); }
  catch(e){ toast(String(e?.message||e)); }
}
/** Drives get their own menu: no cut/copy/delete, rename means the volume label. */
function buildDriveMenu(file){
  const d=driveInfo(file.path)||{}; const root=String(file.path).slice(0,2).toUpperCase()+"\\";
  const items=[
    {label:"Open", icon:"open", bold:true, action:()=> activateItem(root,true)},
    {label:"Open in new tab", icon:"add", action:()=> newTab(root)},
    {sep:true},
    {label:"Rename…", icon:"rename", hint:"F2", action:()=> doRenameDrive(root)},
    ...(d.is_removable||/removable|usb/i.test(String(d.type||d.drive_type||""))?[{label:"Eject", icon:"upload", action:()=> invoke("shell_verb",{paths:[root],verb:"eject"}).then(()=>toast("Safe to remove")).catch(e=>toast(String(e?.message||e)))}]:[]),
    {sep:true},
    ...(clipboard.sources.length?[{label:"Paste into drive", icon:"paste", action:()=> doPaste(root)}]:[]),
    {label:"Share on network…", icon:"shareNet", action:()=> window.PiExtras?.shareOnNetwork(root)},
    {label:"Copy path", icon:"copyPath", action:()=> copyPaths([root])},
    {sys:"files", paths:[root]},
    {sep:true},
    {label:"Properties", icon:"properties", hint:"Alt+Enter", action:()=> openPropertiesWindow([root])},
  ];
  return items;
}
function buildContextMenu(file){
  if(isDriveRoot(file.path)) return buildDriveMenu(file);
  const paths=getSelectedPathsForOp(file); const multi=paths.length>1; const isDir=!!file.is_dir;
  const items=[
    {label:"Open", icon:"open", bold:true, hint:pref("openWith","double")==="single"?"Click":"Double-click", action:()=> activateItem(file.path,isDir)},
    isDir ? {label:"Open in new tab", icon:"add", action:()=> newTab(file.path)} : {label:"Open with", icon:"openWith", children:[
      {label:"Built-in viewer", icon:"eye", action:()=> openViewer(file)},
      {label:"Default app", icon:"open", action:()=> window.__openExternal(file.path)},
      {sep:true},
      {label:"Choose another app…", icon:"apps", action:()=> invoke("open_with_dialog",{path:file.path}).catch(e=>toast(String(e?.message||e)))},
    ]},
    ...(!isDir && !multi && isArchivePath(file.path) ? [
      {label:"Extract here", icon:"extract", action:()=>extractArchive(file.path,"here")},
      {label:"Extract to…", icon:"openFolder", action:()=>extractArchive(file.path,"to")}] : []),
    {sep:true},
    {label:"Cut", icon:"cut", hint:"Ctrl+X", action:()=>{ state.selected=new Set(paths); refreshRowStates(); updateSelectionUI(); copySelectionToClipboard("cut"); }},
    {label:"Copy", icon:"copy", hint:"Ctrl+C", action:()=>{ state.selected=new Set(paths); refreshRowStates(); updateSelectionUI(); copySelectionToClipboard("copy"); }},
    ...(isDir && !multi && clipboard.sources.length ? [{label:"Paste into folder", icon:"paste", action:()=> doPaste(file.path)}] : []),
    {label:"Rename", icon:"rename", hint:"F2", disabled:multi, action:()=> doRenameFile(file.path)},
    {label:"Delete", icon:"delete", hint:"Del", danger:true, action:()=>{ state.selected=new Set(paths); doDeleteSelection(); }},
    {sep:true},
    {label:"Tags", icon:"tags", children: tagMenuItems(paths)},
    {label:"Share", icon:"share", action:()=> window.PiExtras?.share(paths)},
    ...(isDir && !multi ? [{label:"Share on network…", icon:"shareNet", action:()=> window.PiExtras?.shareOnNetwork(file.path)}] : []),
    {label:"Copy path", icon:"copyPath", hint:"Ctrl+Shift+C", action:()=> copyPaths(paths)},
    ...(!isDir && !multi ? [{label:"Restore previous versions…", icon:"history", action:()=> window.PiExtras?.restoreVersions(file.path)}] : []),
    ...(isDir && !multi ? [{label:"Restore deleted files…", icon:"restore", action:()=> window.PiExtras?.restoreDeleted(file.path)}] : []),
    ...(!multi && (state.loc?.k==="recent"||state.loc?.k==="home") && recentList().some(r=>r.path.toLowerCase()===file.path.toLowerCase()) ? [{label:"Remove from Recent", icon:"close", action:()=> clearRecent(file.path)}] : []),
    ...(state.currentPersonKey && !isDir ? [{label:"Move to another person…", icon:"person", action:()=>{ state.selected=new Set(paths); updateSelectionUI(); document.getElementById("moveSelectedPhotosBtn")?.click(); }}] : []),
  ];
  const custom=customActionItems(paths, isDir?"folders":"files");
  if(custom.length) items.push({sep:true}, ...custom);
  items.push({sys:"files", paths});
  items.push({sep:true}, {label:"Properties", icon:"properties", hint:"Alt+Enter", action:()=> openPropertiesWindow(paths)});
  return items;
}
function buildViewportContextMenu(){
  const sortItem=(k,label)=>({label, checked: state.sort.startsWith(k+"-"), keepOpen:false, action:()=>{ const [ck,cd]=state.sort.split("-"); const nat=k==="date"||k==="size"?"desc":"asc"; els.sortSelect.value=`${k}-${ck===k?(cd==="asc"?"desc":"asc"):nat}`; els.sortSelect.dispatchEvent(new Event("change")); }});
  const groupItem=(g,label)=>({label, checked: state.group===g, action:()=>{ els.groupSelect.value=g; els.groupSelect.dispatchEvent(new Event("change")); }});
  const dir=state.loc?.k==="dir";
  const items=[
    {label:"View", icon:"grid", children:[{label:"Details", icon:"list", checked:state.view==="list", action:()=>setView("list")},{label:"Grid", icon:"grid", checked:state.view==="grid", action:()=>setView("grid")}]},
    {label:"Sort by", icon:"sort", children:[sortItem("name","Name"),sortItem("date","Date modified"),sortItem("type","Type"),sortItem("size","Size")]},
    {label:"Group by", icon:"group", children:[groupItem("none","(None)"),groupItem("date","Date"),groupItem("type","Type"),groupItem("size","Size")]},
    {label:"Refresh", icon:"refresh", hint:"F5", action:()=> refreshView()},
    {sep:true},
    {label:"Paste", icon:"paste", hint:"Ctrl+V", disabled:!clipboard.sources.length||!dir, action:()=> doPaste()},
    ...(dir?[{label:"New", icon:"addCircle", children:[{label:"Folder", icon:"newFolder", hint:"Ctrl+Shift+N", action:()=> doCreateFolder()},{label:"Text document", icon:"newFile", action:()=> window.__createFile?.("New Text Document.txt")}]}]:[]),
    {label:"Select all", icon:"selectAll", hint:"Ctrl+A", action:()=> selectAll()},
  ];
  if(dir){
    items.push({sep:true},
      {label:"Share on network…", icon:"shareNet", action:()=> window.PiExtras?.shareOnNetwork(state.path)},
      {label:"Restore deleted files…", icon:"restore", action:()=> window.PiExtras?.restoreDeleted(state.path)},
      {label:"Copy path", icon:"copyPath", action:()=> copyPaths([state.path])});
    const custom=customActionItems([state.path],"background");
    if(custom.length) items.push({sep:true}, ...custom);
    items.push({sys:"background", folder:state.path});
  }
  return items;
}
function closeMenusFrom(level){ while(ctxStack.length>level){ const m=ctxStack.pop(); if(m===els.contextMenu){ m.classList.add("hidden"); m.innerHTML=""; } else m.remove(); } }
function hideContextMenu(){ try{ closeMenusFrom(0); }catch(e){console.error(e)} ctxTarget=null; }
function positionMenu(menu,x,y,anchor){
  const pad=8; menu.style.left="0px"; menu.style.top="0px";
  const r=menu.getBoundingClientRect();
  let left=x, top=y;
  if(anchor){ left=anchor.right-4; top=anchor.top-5; if(left+r.width>innerWidth-pad) left=Math.max(pad, anchor.left-r.width+4); }
  if(left+r.width>innerWidth-pad) left=Math.max(pad, innerWidth-r.width-pad);
  if(top+r.height>innerHeight-pad) top=Math.max(pad, innerHeight-r.height-pad);
  menu.style.left=left+"px"; menu.style.top=top+"px";
  menu.style.transformOrigin= anchor? "left top" : `${x-left}px ${y-top}px`;
}
function renderMenu(menu, items){
  menu._items=items;
  menu.innerHTML=items.map((it,i)=>{
    if(it.sep) return `<div class="ctx-sep" role="separator"></div>`;
    if(it.loading) return `<div class="ctx-item ctx-loading" aria-disabled="true"><span class="ctx-ico"><span class="spinner"></span></span><span class="ctx-label">${esc(it.label)}</span></div>`;
    const hasKids=!!(it.children||it.lazy);
    return `<button class="ctx-item ${it.danger?"danger":""} ${it.bold?"bold":""} ${it.sys?"sys":""}" role="menuitem${it.checked!=null?"checkbox":""}" ${it.checked!=null?`aria-checked="${!!it.checked}"`:""} data-i="${i}" ${it.disabled?"disabled":""} ${hasKids?'aria-haspopup="menu"':""}>
      <span class="ctx-ico">${it.checked? (window.PiIcons?PiIcons.ui("check"):"✓") + (it.icon&&String(it.icon).startsWith("<span")? it.icon:"") : mIco(it.icon)}</span><span class="ctx-label">${esc(it.label)}</span>${it.hint&&!hasKids?`<span class="ctx-hint">${esc(it.hint)}</span>`:""}${hasKids?`<span class="ctx-more">${window.PiIcons?PiIcons.ui("chevronRight"):"›"}</span>`:""}</button>`;
  }).join("");
}
function openMenu(items,x,y,level,anchorEl){
  closeMenusFrom(level);
  const menu= level===0 ? els.contextMenu : document.createElement("div");
  if(level>0){ menu.className="ctx-menu ctx-sub"; menu.setAttribute("role","menu"); document.body.appendChild(menu); }
  renderMenu(menu, items);
  menu.classList.remove("hidden");
  menu.classList.remove("ctx-in"); void menu.offsetWidth; menu.classList.add("ctx-in");
  positionMenu(menu,x,y,anchorEl?.getBoundingClientRect());
  ctxStack[level]=menu; ctxStack.length=level+1;
  menu._level=level;
  return menu;
}
function activateMenuItem(menu, btn, viaKey){
  const it=menu._items[Number(btn.dataset.i)];
  if(!it || it.disabled) return;
  if(it.children||it.lazy){ openSubmenu(menu, btn, viaKey); return; }
  if(it.keepOpen){ it.action?.(); it.checked=!it.checked; renderMenu(menu, menu._items); return; }
  hideContextMenu();
  try{ it.action?.(); }catch(e){ console.error(e); }
}
async function openSubmenu(menu, btn, focusFirst){
  const it=menu._items[Number(btn.dataset.i)];
  let kids=it.children;
  if(!kids && it.lazy){ kids=[{loading:true,label:"Loading…"}]; }
  const sub=openMenu(kids, 0, 0, menu._level+1, btn);
  menu.querySelectorAll(".ctx-item.open").forEach(b=>b.classList.remove("open")); btn.classList.add("open");
  if(it.lazy && !it.children){ it.children=await it.lazy(); if(sub.isConnected && ctxStack.includes(sub)){ renderMenu(sub, it.children.length?it.children:[{label:"No more options",disabled:true}]); positionMenu(sub,0,0,btn.getBoundingClientRect()); } }
  if(focusFirst) sub.querySelector(".ctx-item:not([disabled])")?.focus();
}
/** Opens the menu; system entries arrive asynchronously and are merged in place. */
function showContextMenu(x,y,file, customItems){
  const raw=customItems || buildContextMenu(file);
  ctxTarget=file;
  const sysIdx=raw.findIndex(i=>i.sys==="files"||i.sys==="background");
  let items=raw.slice();
  let sysSpec=null;
  if(sysIdx>=0){ sysSpec=raw[sysIdx]; items.splice(sysIdx,1); }
  const mode=pref("systemMenu","submenu");
  if(sysSpec && mode!=="off" && invokeFn){
    const loader=loadSystemItems(sysSpec.paths||[], sysSpec.sys==="background"?sysSpec.folder:null);
    const more={label:"Show more options", icon:"more", hint:"Shift+F10", lazy:async()=>{ const r=await loader; return r.more.length? r.more : [{label:r.error?"System menu unavailable":"No more options",disabled:true}]; }};
    const at=sysIdx;
    if(mode==="submenu") items.splice(at,0,{sep:true},more);
    loader.then(r=>{
      const menu=els.contextMenu;
      if(ctxTarget!==file || menu.classList.contains("hidden")) return;
      const cur=menu._items.slice();
      let pos=cur.indexOf(more); if(pos<0) pos=Math.min(at+(mode==="submenu"?1:0),cur.length);
      if(r.main.length) cur.splice(pos,0,...r.main);
      if(mode==="inline" && r.more.length) cur.splice(pos,0,{sep:true},...r.more);
      if(mode==="submenu" && !r.more.length){ const i=cur.indexOf(more); if(i>=0){ cur.splice(i,1); if(cur[i-1]?.sep) cur.splice(i-1,1); } }
      if(cur.length!==menu._items.length){ const left=menu.style.left, top=menu.style.top; renderMenu(menu,cur); menu.style.left=left; menu.style.top=top; positionMenu(menu, parseFloat(left), parseFloat(top)); }
    });
  }
  while(items.length && items[items.length-1].sep) items.pop();
  openMenu(items,x,y,0);
  els.contextMenu.querySelector(".ctx-item:not([disabled])")?.focus({preventScroll:true});
}
function showFileMenuFor(x,y,path,isDir){
  const f=fileByPath(path)||{name:path.split(/[\\/]/).pop()||path,path,is_dir:!!isDir,size:0,extension:(path.split(".").pop()||"").toLowerCase(),modified:""};
  showContextMenu(x,y,f);
}
// Pointer: hovering an item with a submenu opens it; clicks run commands.
document.addEventListener("pointerover",e=>{
  const btn=e.target.closest?.(".ctx-menu .ctx-item"); if(!btn) return;
  const menu=btn.closest(".ctx-menu");
  clearTimeout(menu._hoverT);
  const it=menu._items?.[Number(btn.dataset.i)];
  menu._hoverT=setTimeout(()=>{ if(!ctxStack.includes(menu)) return;
    if(it && (it.children||it.lazy) && !it.disabled){ if(!btn.classList.contains("open")) openSubmenu(menu,btn,false); }
    else { closeMenusFrom(menu._level+1); menu.querySelectorAll(".ctx-item.open").forEach(b=>b.classList.remove("open")); }
  },180);
});
document.addEventListener("click",e=>{
  const btn=e.target.closest?.(".ctx-menu .ctx-item");
  if(btn){ e.stopPropagation(); activateMenuItem(btn.closest(".ctx-menu"),btn,false); return; }
  if(!e.target.closest?.(".ctx-menu")) hideContextMenu();
},true);
document.addEventListener("keydown",e=>{
  if(!ctxStack.length || els.contextMenu.classList.contains("hidden")) return;
  const menu=ctxStack[ctxStack.length-1];
  const btns=[...menu.querySelectorAll(".ctx-item:not([disabled]):not(.ctx-loading)")];
  const i=btns.indexOf(document.activeElement);
  if(e.key==="Escape"||(e.key==="ArrowLeft"&&ctxStack.length>1)){ e.preventDefault(); e.stopPropagation(); if(ctxStack.length>1){ const parent=ctxStack[ctxStack.length-2]; closeMenusFrom(ctxStack.length-1); parent.querySelector(".ctx-item.open")?.focus(); } else hideContextMenu(); return; }
  if(e.key==="ArrowDown"||e.key==="ArrowUp"){ e.preventDefault(); const n=btns[(i+(e.key==="ArrowDown"?1:-1)+btns.length)%btns.length]; n?.focus(); return; }
  if(e.key==="ArrowRight"&&document.activeElement?.getAttribute("aria-haspopup")){ e.preventDefault(); openSubmenu(menu,document.activeElement,true); return; }
  if(e.key==="Enter"||e.key===" "){ if(btns[i]){ e.preventDefault(); activateMenuItem(menu,btns[i],true); } }
},true);
window.addEventListener("blur",()=>hideContextMenu());
window.addEventListener("resize",()=>hideContextMenu());
document.addEventListener("keydown",e=>{ window.__shiftHeld=e.shiftKey; },true);
document.addEventListener("keyup",e=>{ window.__shiftHeld=e.shiftKey; },true);
if(els.fileContainer) els.fileContainer.addEventListener("contextmenu",e=>{try{const row=e.target.closest("[data-path]"); e.preventDefault(); if(!row){ showContextMenu(e.clientX,e.clientY,{path:state.path,name:"",is_dir:true},buildViewportContextMenu()); return; }
const path=row.getAttribute("data-path"); const file=fileByPath(path);
if(!file) return;
if(!state.selected.has(path)){ state.selected.clear(); state.selected.add(path); state._focusedPath=path; refreshRowStates(); updateSelectionUI(); }showContextMenu(e.clientX,e.clientY,file);}catch(e){console.error("contextmenu",e)}});
if(els.fileViewport) els.fileViewport.addEventListener("contextmenu",e=>{
  if(e.target===els.fileViewport || e.target===els.fileSpacer || e.target===els.fileContainer){
    e.preventDefault();
    if(state.selected.size){ state.selected.clear(); refreshRowStates(); updateSelectionUI(); }
    showContextMenu(e.clientX,e.clientY,{path:state.path,name:"",is_dir:true},buildViewportContextMenu());
  }
});
// Keyboard menu key / Shift+F10 opens the menu for the selection.
document.addEventListener("keydown",e=>{
  if(!(e.key==="ContextMenu"||(e.shiftKey&&e.key==="F10"))) return;
  if(/INPUT|TEXTAREA/.test(document.activeElement?.tagName||"")) return;
  e.preventDefault();
  const p=[...state.selected][0];
  const el=p && els.fileContainer.querySelector(`[data-path="${CSS.escape(p)}"]`);
  const r=(el||els.fileViewport).getBoundingClientRect();
  if(p) showContextMenu(r.left+40,r.top+r.height/2,fileByPath(p)||{path:p,name:p}); else showContextMenu(r.left+40,r.top+40,{path:state.path,name:"",is_dir:true},buildViewportContextMenu());
});
/* Search + indexed status */function showSearchUI(q,total,shown){els.searchHeader.classList.remove("hidden"); els.viewportWrap.classList.remove("hidden"); els.mediaView.classList.add("hidden"); els.mediaView.style.display="";els.searchQueryLabel.textContent=q; els.searchStats.textContent=shown===total?`${total} • ${state.searchMeta.took_ms}ms • ${state.searchMeta.indexed?"Indexed":"Indexing…"}`:`${shown} of ${total} • ${state.searchMeta.took_ms}ms • ${state.searchMeta.indexed?"Indexed":"Indexing…"}`;els.searchClear.classList.toggle("visible",!!q); els.searchMeta.textContent=q?`${total} • ${state.searchMeta.took_ms}ms`:""; els.searchMeta.style.display=q?"block":"none";}
function hideSearchUI(){ els.searchHeader.classList.add("hidden"); els.searchClear.classList.remove("visible"); els.searchMeta.style.display="none"; els.searchMeta.textContent=""; }
function clearSearch(){state.isSearching=false; state.searchQuery=""; state.searchResults=[]; state.searchTotal=0; state.searchOffset=0; state.searchMeta={took_ms:0,indexed:state.indexStatus.ready,has_more:false};hideSearchUI(); els.searchInput.value=""; els.searchClear.classList.remove("visible");}
/** Leaves search: back to where it started. */
function exitSearch(){ if(state.loc?.k==="search") goBack(); else clearSearch(); }
/** Typing in the search box: the first keystroke adds a history entry, later ones refine it. */
function doSearch(v){ const q=String(v||"").trim(); if(!q){ exitSearch(); return; } const inSearch=state.loc?.k==="search"; go({k:"search",q}, {replace:inSearch}); }
// --- Tags backend (Images / Videos / Documents / Archives) ---
const TAG_COMMANDS={images:"list_images",videos:"list_videos",docs:"list_documents",documents:"list_documents",archives:"list_archives"};
const TAG_LABELS={images:"Images",videos:"Videos",docs:"Documents",documents:"Documents",archives:"Archives"};
function normalizeTag(nav){ if(nav==="docs") return "documents"; return nav; }
function showTagHeader(tag,total,shown,tookMs){ els.searchHeader.classList.remove("hidden"); els.viewportWrap.classList.remove("hidden"); els.mediaView.classList.add("hidden"); els.mediaView.style.display=""; const label=TAG_LABELS[tag]||tag; els.searchQueryLabel.textContent=label; els.searchStats.textContent= shown===total ? `${total} files • ${tookMs}ms` : `${shown} of ${total} • ${tookMs}ms`; els.searchClear.classList.remove("visible"); els.searchMeta.textContent=`${total} • ${tookMs}ms`; els.searchMeta.style.display=total?"block":"none"; }
function hideTagHeader(){ if(!state.isSearching) hideSearchUI(); }
function clearTagFilter(){ state.tagMode=null; state.tagOffset=0; state.tagTotal=0; state.tagHasMore=false; state.tagTookMs=0; state.tagQuery=""; hideTagHeader(); }
function mapSearchResultToFile(r){ return {name:r.name, path:r.path, is_dir:!!r.is_dir, size: r.size||0, modified:"", extension:(r.name.split(".").pop()||r.matched||"").toLowerCase(), ext:(r.name.split(".").pop()||r.matched||"").toLowerCase(), matched:r.matched||""}; }
async function loadTag(tag, offset=0, limit=PAGE){ const norm=normalizeTag(tag); const cmd=TAG_COMMANDS[norm]||TAG_COMMANDS[tag]; if(!cmd){ toast(`Unknown tag: ${tag}`); return; } const isInitial=offset===0; if(isInitial){ state.tagMode=norm; state.tagOffset=0; state.tagTotal=0; state.tagHasMore=false; state.tagTookMs=0; state.tagQuery=norm; state.isSearching=false; state.selected.clear(); updateSelectionUI(); showTagHeader(norm,0,0,0); els.statusText.textContent=`Loading ${TAG_LABELS[norm]||norm}…`; setLoading(true); } try{ const mockForTag=(q,o,l)=>{ const exts={images:["jpg","png"],videos:["mp4","mov"],documents:["pdf","docx"],archives:["zip","rar"]}; const extList=exts[q]||["jpg"]; const filtered=mockListDir("C:\\").filter(f=>!f.is_dir).concat(Array.from({length:120},(_,i)=>({name:`${q}_${i}.${extList[i%extList.length]}`,path:`C:\\Tags\\${q}_${i}.${extList[i%extList.length]}`,is_dir:false,size:1200000+ i*1000,modified:"2026-08-30",ext:extList[i%extList.length]}))); const slice=filtered.slice(o,o+l); return {results:slice,total:filtered.length,has_more:filtered.length>o+slice.length,took_ms:8,indexed:false,query:q};}; const res=await safeInvoke(cmd,{root:state.path||null,offset,limit},()=>mockForTag(norm,offset,limit)); const results=Array.isArray(res)?res:(res.results||res.entries||[]); const total=Array.isArray(res)?results.length:(res.total??results.length); const took=res.took_ms??0; const has_more=!!res.has_more; const mapped=results.map(mapSearchResultToFile); const sorted=sortFiles(mapped,state.sort); if(isInitial){ state.files=sorted; state.tagTotal=total; state.tagOffset=sorted.length; state.tagHasMore=has_more; state.tagTookMs=took; } else { state.files.push(...sorted); state.files=sortFiles(state.files,state.sort); state.tagOffset=state.files.length; state.tagTotal=total; state.tagHasMore=has_more; state.tagTookMs=took; } showTagHeader(norm,total,state.files.length,took); setLoading(false); renderVirtualized(isInitial); updateCounts(); els.statusText.textContent=`${TAG_LABELS[norm]||norm} • ${total} files • ${took}ms`; }catch(e){ setLoading(false); toast(`Failed to load ${tag}: ${e?.message||e}`); console.error(e); }finally{} }
async function loadMoreTag(){ if(!state.tagMode) return; if(state.tagOffset>=state.tagTotal) return; await loadTag(state.tagMode, state.tagOffset, PAGE); }
const runSearch=debounce(async(query)=>{const q=query.trim(); if(!q){clearSearch();
return}
  const qLower=q.toLowerCase();
  const personMatch=(state.mediaPeople||[]).find(g=>{
    const lbl=(g.label||"").toLowerCase();
    if(/^person \d+$/i.test(lbl)) return false;
    return lbl===qLower || (q.length>=2 && lbl.includes(qLower));
  });
  if(personMatch){
    const first=(state.mediaPeople||[]).filter(g=>{
      const lbl=(g.label||"").toLowerCase();
      return !/^person \d+$/i.test(lbl) && lbl.includes(qLower);
    });
    if(first.length===1){
      go({k:"person",key:first[0].key,label:first[0].label},{replace:true});
      return;
    }
    if(first.length>1){
      go({k:"people"},{replace:true});
      peopleFilterText=q;
      const pf=document.getElementById("peopleFilter"); if(pf) pf.value=q;
      renderMediaPeople();
      toast(`${first.length} people match "${q}"`);
      return;
    }
  }
const token=state.navToken; state.isSearching=true; state.searchQuery=q; state.searchOffset=0; setLoading(true); showSearchUI(q,0,0); if(els.searchInput.value.trim()!==q) els.searchInput.value=q; els.searchClear.classList.add("visible"); els.statusText.textContent=`Searching \u201C${q}\u201D\u2026`;
try{const res=await safeInvoke("search_files",{query:q,offset:0,limit:PAGE},()=>mockSearch(q,0,PAGE));
if(token!==state.navToken||state.loc?.k!=="search"||state.loc.q!==q) return;
const results=Array.isArray(res)?res:(res.results||res.entries||[]); const total=Array.isArray(res)?results.length:(res.total??results.length);state.searchMeta={took_ms:res.took_ms??0,indexed:!!res.indexed,has_more:!!res.has_more,query:res.query||q};state.searchResults=sortFiles(results,state.sort); state.searchTotal=total; state.searchOffset=results.length;showSearchUI(q,total,state.searchResults.length); setLoading(false); renderVirtualized(true);els.statusText.textContent=`Found ${total} matches for “${q}” • ${state.searchMeta.took_ms}ms • ${state.searchMeta.indexed?"Indexed":"Live"}`;}
catch(e){setLoading(false);toast("Search failed");console.error(e)}},DEBOUNCE_MS);
async function loadMoreSearch(){if(!state.isSearching) return; const q=state.searchQuery; const offset=state.searchOffset; if(offset>=state.searchTotal) return;
try{const res=await safeInvoke("search_files",{query:q,offset,limit:PAGE},()=>mockSearch(q,offset,PAGE));
const results=Array.isArray(res)?res:(res.results||[]); const total=Array.isArray(res)?state.searchTotal:(res.total??state.searchTotal);
const sorted=sortFiles(results,state.sort); state.searchResults.push(...sorted); state.searchOffset+=results.length; state.searchTotal=total;state.searchMeta.took_ms=res.took_ms??state.searchMeta.took_ms; state.searchMeta.indexed=!!res.indexed;showSearchUI(q,total,state.searchResults.length); renderVirtualized(false);}finally{}}
async function fetchIndexStatus(){const s=await safeInvoke("get_index_status",{}, {ready:false,building:true,size:0});state.indexStatus={ready:!!s.ready,building:!!s.building,size:s.size||0}; state._indexBuilding=!!s.building||!s.ready;
const meta= state.indexStatus.ready? `Indexed ${state.indexStatus.size.toLocaleString()} • ${state.searchMeta.took_ms||0}ms` : (state.indexStatus.building? "Indexing…":"No index");
if(!state.isSearching){ els.searchMeta.textContent= state.indexStatus.ready? `${state.indexStatus.size.toLocaleString()} indexed` : meta; els.searchMeta.style.display="block"; els.searchMeta.style.opacity=".7"; setTimeout(()=>{ if(!state.isSearching && !els.searchInput.value) els.searchMeta.style.display="none"},3000); }
if(els.statusRight) els.statusRight.textContent= state.indexStatus.ready? `Indexed ${state.indexStatus.size.toLocaleString()} • lite` : "Indexing… • lite";
return state.indexStatus;}/* Media *//* Media - People with Immich/Google Photos labeling */
let peopleFilterText="";
let peoplePollTimer=null;
async function loadMediaPeople(force=false){
  try{
    const grid=els.peopleGrid; if(!grid){ console.warn("peopleGrid missing"); return state.mediaPeople||[]; }
    const empty=document.getElementById("peopleEmpty");
    const countEl=document.getElementById("peopleCount");

    if(state.mediaPeople && state.mediaPeople.length && !force) {
      renderMediaPeople();
      return state.mediaPeople;
    }
    if(force) state.mediaPeople=null;
    if(empty) empty.classList.add("hidden");
    if(peoplePollTimer){ clearInterval(peoplePollTimer); peoplePollTimer=null; }

    function normalizeGroups(res){
      let groups=Array.isArray(res)?res:(res.groups||res.people||res||[]);
      if(!Array.isArray(groups) || groups.length===0) {
        if(state.mediaPeople && state.mediaPeople.length) return state.mediaPeople;
      }
      if(!groups.length) groups=[];
      return groups.map(g=>{
        const label=g.label||g.name||g.key||"Unknown";
        const key=g.key||g.id||label;
        const count=g.count??g.face_count??1;
        const preview=g.preview||(g.path?[g.path]:[]);
        const paths=g.paths||g.sample_paths||[];
        const cover=g.cover||"👤";
        const path=g.path||paths[0]||(preview.find(p=>typeof p==="string"&&!p.startsWith("data:image/"))||"");
        return {...g,label,key,name:label,count,preview,cover,path,paths,face_count:g.face_count,total_size:g.total_size};
      });
    }

    if(force){
      try{ await safeInvoke("start_face_scan",{root: "", force: true}, {started:true}); }catch(e){ console.error(e); }
    }

    // Load any existing or in-flight groups immediately
    try{
      const initialRes = await safeInvoke("get_media_groups",{root:""},{groups:[]});
      const initialGroups = normalizeGroups(initialRes);
      if(initialGroups.length > 0){
        state.mediaPeople = initialGroups;
        renderMediaPeople();
      }
    }catch(_){}

    // Re-render only when people actually change: the grid holds up to 120 base64 avatars.
    const signature = gs => gs.map(g=>`${g.key}:${g.count}:${g.label}`).join("|");
    let lastSig = signature(state.mediaPeople||[]);
    const poll = async () => {
      try{
        let status = await safeInvoke("get_all_drives_scan_status",{}, null);
        if(!status) status = await safeInvoke("get_face_scan_status",{}, {scanning:false, progress:0, total:0, cached:0, drives:""});
        const scanning = !!status.scanning;

        // Real-time progressive streaming: fetch groups on every poll tick while scan progresses
        const res = await safeInvoke("get_media_groups",{root:""},{groups:[]});
        const groups = normalizeGroups(res);

        if(groups.length > 0){
          const sig = signature(groups);
          if(sig !== lastSig){
            lastSig = sig;
            state.mediaPeople = groups;
            renderMediaPeople();
          }
        }
        if(countEl && scanning){
          const fresh = status.new_images||0;
          const done = Math.max(0, (status.progress||0) - ((status.total||0) - fresh));
          const what = status.phase==="walking" ? "Finding photos…"
            : fresh>0 ? `analysing ${done}/${fresh} new photos` : "Updating…";
          countEl.textContent = groups.length ? `${groups.length} people • ${what}` : what;
        }

        if(!scanning){
          if(peoplePollTimer){ clearInterval(peoplePollTimer); peoplePollTimer=null; }
          if(state.mediaPeople && state.mediaPeople.length){
            renderMediaPeople();
          } else {
            if(grid) grid.innerHTML="";
            if(empty) empty.classList.remove("hidden");
            if(countEl) countEl.textContent="0 groups";
          }
        }

      }catch(e){ console.error("poll",e); }
    };

    await poll();
    let st = await safeInvoke("get_all_drives_scan_status",{}, null);
    if(!st) st = await safeInvoke("get_face_scan_status",{}, {scanning:false});
    if(st && st.scanning){
      if(!peoplePollTimer) peoplePollTimer=setInterval(poll, 1000);
    }

    return state.mediaPeople;
  }catch(e){ console.error("loadMediaPeople outer",e); if(els.peopleGrid) try{ els.peopleGrid.innerHTML=`<div style="padding:16px;color:var(--text-3)">People load failed: ${esc(e.message||String(e))}</div>`; }catch(_){} return state.mediaPeople||[]; }
}
async function loadMediaDevices(){if(state.mediaDevices) return state.mediaDevices; const res=await safeInvoke("get_device_groups",{},mockDeviceGroups()); if(res&&res.by_drive){ // backend now returns by_drive + by_type (EXIF) + by_device (alias) - normalize for compat
  const byDevice=res.by_device||res.by_type||[]; const byType=res.by_type||res.by_device||byDevice; state.mediaDevices={by_drive:res.by_drive, by_type:byType, by_device:byDevice}; } else if(Array.isArray(res)) state.mediaDevices={by_drive:res,by_type:[],by_device:[]}; else state.mediaDevices=mockDeviceGroups(); renderMediaDevices(); return state.mediaDevices}
// --- Manual merge (Immich/Google Photos-like) helpers ---
function updatePeopleMergeBar(){
  const bar=document.getElementById("peopleMergeBar");
  const cntEl=document.getElementById("peopleMergeCount");
  const btn=document.getElementById("peopleMergeBtn");
  if(!bar) return;
  const n=state.peopleSelection.size;
  if(n>=1){
    bar.classList.remove("hidden");
    if(cntEl) cntEl.textContent=n===1? "1 selected": `${n} selected`;
    if(btn){
      btn.textContent=n<2? `Select ${2-n} more to merge` : `Merge ${n} persons`;
      btn.disabled=n<2;
      btn.title=n<2? "Select at least 2 persons to merge" : `Merge ${n} persons into one`;
    }
  } else {
    bar.classList.add("hidden");
  }
}
function clearPeopleSelection(){
  state.peopleSelection.clear();
  updatePeopleMergeBar();
  try{ renderMediaPeople(); }catch{}
}
function togglePeopleSelection(key, checked){
  if(checked) state.peopleSelection.add(key);
  else state.peopleSelection.delete(key);
  updatePeopleMergeBar();
}
async function doPeopleMerge(){
  const keys=[...state.peopleSelection];
  if(keys.length<2){ toast("Select at least 2 persons to merge"); return; }
  // derive default label: first non-default Person N, or first label
  const groups=state.mediaPeople||[];
  const firstLabel=(keys.map(k=>groups.find(g=>g.key===k)?.label).find(l=>l && !/^Person \d+$/i.test(l)) ) || groups.find(g=>g.key===keys[0])?.label || "";
  const suggested=firstLabel && !/^Person \d+$/i.test(firstLabel) ? firstLabel : "";
  let newLabel=await PiDialog.prompt({title:"Merge people", message:`Give the ${keys.length} merged people one name`, value:suggested, placeholder:"Name", okText:"Merge"});
  if(newLabel===null) return; // cancelled
  newLabel=newLabel.trim();
  if(!newLabel){
    // if user cleared, use suggested or fallback "Merged Person"
    newLabel=suggested || "Merged Person";
  }
  if(newLabel.length>48){ toast("Name too long (max 48)"); return; }
  const btn=document.getElementById("peopleMergeBtn");
  if(btn){ btn.disabled=true; btn.textContent="Merging…"; }
  try{
    const merged=await invoke("merge_persons", {personKeys: keys, label: newLabel});
    // merged is MediaGroup from backend
    // Update local state: remove old keys, add merged
    const before=(state.mediaPeople||[]).length;
    state.mediaPeople=(state.mediaPeople||[]).filter(g=>!keys.includes(g.key));
    if(merged && merged.key){
      state.mediaPeople.unshift(merged);
      // re-sort by count desc like backend
      state.mediaPeople.sort((a,b)=> (b.count||0)-(a.count||0) || a.key.localeCompare(b.key));
    } else {
      // fallback: reload from cache
      try{
        const res=await safeInvoke("get_media_groups",{root:""},{groups:[]});
        if(Array.isArray(res)) state.mediaPeople=res;
        else if(res.groups) state.mediaPeople=res.groups;
      }catch{}
    }
    clearPeopleSelection();
    renderMediaPeople();
    toast(`Merged ${keys.length} persons into "${merged?.label||newLabel}" • ${merged?.count||"?"} photos. AI model trained: exemplars unified & lifelong Must-Link constraint saved.`);
  }catch(e){
    toast("Merge failed: "+(e?.message||String(e)));
    if(btn){ btn.disabled=false; updatePeopleMergeBar(); }
  }
}
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
    els.peopleGrid.innerHTML=`<div style="padding:16px;color:var(--text-3);text-align:center">No people match “${esc(filter)}”</div>`;
    return;
  }
  const isDataUrl=s=>typeof s==="string" && s.startsWith("data:image/");
  els.peopleGrid.innerHTML=groups.map(g=>{
    const label=g.label||g.name||"Unknown";
    const count=g.count||0;
    const preview=g.preview||[];
    const cover=g.cover||(g.face_count?"👤":"👤");
    const isFace=g.face_count!=null;
    const isDefaultPerson=/^Person \d+$/.test(label);
    const isUnlabeled=isFace && isDefaultPerson;
    const avatarKey=g.key||label;
    // preview[0] is data URL for face groups; also pass via data-path as paths[0] for navigation
    const firstPreview=preview[0]||"";
    // Face thumbnails are data:image/jpeg;base64 96x96 directly - render without thumbCache/fetchThumb
    // File-path previews (fallback) use thumbCache + get_thumbnail
    let avatarInner="";
    if(isDataUrl(firstPreview)){
      avatarInner=`<img src="${esc(firstPreview)}" alt="${esc(label)}" loading="lazy" style="width:56px;height:56px;object-fit:cover;border-radius:50%;display:block" data-onerr="hide-next-grid">`;
      // fallback span hidden behind image if data URL broken
      avatarInner+=`<span style="display:none;place-items:center;width:56px;height:56px;font-size:22px">${esc(cover)}</span>`;
      // wrap both: outer CSS will show img covering circle
    } else if(firstPreview){
      const cached=thumbCache.get(firstPreview);
      if(cached){
        avatarInner=`<img src="${esc(cached)}" alt="${esc(label)}" loading="lazy" style="width:56px;height:56px;object-fit:cover;border-radius:50%;display:block">`;
      } else {
        if(!thumbCache.has(firstPreview) && !thumbPending.has(firstPreview)){
          fetchThumb(firstPreview).then(url=>{ if(url) renderMediaPeople(); });
        }
        avatarInner=`<span>${esc(cover)}</span>`;
      }
    } else {
      avatarInner=`<span>${esc(cover)}</span>`;
    }
    const previewStrip=preview.slice(0,4).map(p=>{
      if(isDataUrl(p)){
        return `<img src="${esc(p)}" title="${esc(label)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid var(--border);background:var(--bg-3)" loading="lazy">`;
      }
      const c=thumbCache.get(p);
      if(c) return `<img src="${esc(c)}" title="${esc(p)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid var(--border)">`;
      if(!thumbCache.has(p) && !thumbPending.has(p)) fetchThumb(p);
      return `<span style="width:28px;height:28px;border-radius:50%;background:var(--bg-3);border:1px solid var(--border);display:grid;place-items:center;font-size:10px">•</span>`;
    }).join("");
    // queue remaining non-data-url thumbs only
    preview.forEach(pp=>{
      if(!isDataUrl(pp) && !thumbCache.has(pp) && !thumbPending.has(pp)) fetchThumb(pp);
    });
    const navPath=(g.paths&&g.paths[0])|| (isDataUrl(firstPreview)?"":firstPreview) || "";
    const isSelected=state.peopleSelection.has(avatarKey);
    return `<div class="person-card ${isUnlabeled?"unlabeled":"labeled"} ${isSelected?"merge-selected":""}" data-key="${esc(avatarKey)}" data-path="${esc(navPath)}" tabindex="0" role="button" title="${esc(label)} • ${count} photos">
      <label class="person-merge-check" title="Select for merge" data-act="stop"><input type="checkbox" data-merge-check="${esc(avatarKey)}" ${isSelected?"checked":""}></label>
      <div class="person-avatar-wrap">
        <div class="person-avatar ${isFace?"face":""}">${avatarInner}</div>
        <button class="person-edit-btn" data-edit="${esc(avatarKey)}" title="Rename ${esc(label)}">✎</button>
      </div>
      <div class="person-name" data-label="${esc(avatarKey)}">${esc(label)} ${isUnlabeled?`<span class="unlabeled">• Unlabeled</span>`:""}</div>
      <div class="person-meta">${count} photos${isFace?` • Faces`:""}${g.total_size?` • ${fmtSize(g.total_size)}`:""}</div>
      <div class="person-inline-edit hidden" data-edit-wrap="${esc(avatarKey)}"><input type="text" value="${esc(label)}" placeholder="Name this person" maxlength="48" data-input="${esc(avatarKey)}"><button data-save="${esc(avatarKey)}">Save</button><button data-cancel="${esc(avatarKey)}">✕</button></div>
      <div class="person-preview-strip" style="${previewStrip?"":"display:none"}">${previewStrip}</div>
      ${isUnlabeled?`<div style="font-size:11px;color:var(--accent);margin-top:2px">Click ✎ to label</div>`:""}
    </div>`;
  }).join("");
  updatePeopleMergeBar();
  window.dispatchEvent(new Event("pifiles:people-rendered"));

  // --- Manual merge helpers (Immich/Google Photos-like) ---
  // updatePeopleMergeBar is defined below as global; ensure bar visibility after each render
  // Delegated click handling - fixes "click to label not working" (was $ vs $$, missing stopPropagation, pointer-events)
  // Order: data-edit first → show input, data-input ignore, data-save → Save, data-cancel → Cancel, else data-key → showPersonPhotos
  const cssEsc=(s)=> (window.CSS && window.CSS.escape ? window.CSS.escape(s) : s);
  // Single delegated click handles edit/save/cancel + navigation; ensures stopPropagation prevents showPersonPhotos
  els.peopleGrid.onclick=async (e)=>{
    // merge checkbox - toggle selection without opening photos (Immich-like)
    const mergeCheck=e.target.closest("[data-merge-check]");
    if(mergeCheck){
      e.stopPropagation();
      // let native checkbox toggle happen; defer reading checked until after default
      const k=mergeCheck.getAttribute("data-merge-check");
      setTimeout(()=>{
        if(mergeCheck.checked) state.peopleSelection.add(k);
        else state.peopleSelection.delete(k);
        updatePeopleMergeBar();
        const card=mergeCheck.closest(".person-card");
        if(card) card.classList.toggle("merge-selected", mergeCheck.checked);
      }, 0);
      return;
    }
    if(e.target.closest(".person-merge-check")){
      e.stopPropagation();
      return;
    }
    const editBtn=e.target.closest("[data-edit]");
    if(editBtn){
      e.stopPropagation();
      e.preventDefault();
      const key=editBtn.getAttribute("data-edit");
      const wrap=els.peopleGrid.querySelector(`[data-edit-wrap="${cssEsc(key)}"]`);
      if(!wrap) return;
      wrap.classList.remove("hidden");
      const inp=wrap.querySelector("input");
      if(inp){ inp.focus(); inp.select(); }
      editBtn.style.display="none";
      return;
    }
    if(e.target.closest("[data-input]")){
      e.stopPropagation();
      return;
    }
    const saveBtn=e.target.closest("[data-save]");
    if(saveBtn){
      e.stopPropagation();
      e.preventDefault();
      const key=saveBtn.getAttribute("data-save");
      const wrap=els.peopleGrid.querySelector(`[data-edit-wrap="${cssEsc(key)}"]`);
      const inp=wrap?.querySelector("input");
      const newName=(inp?.value||"").trim();
      if(!newName){
        toast("Enter a name");
        inp?.focus();
        return;
      }
      if(newName.length>48){ toast("Name too long (max 48)"); return; }
      // Check if another person already has this exact name (Immich / Google Photos merge on rename)
      const existingMatch = (state.mediaPeople || []).find(
        x => x.key !== key && x.label.trim().toLowerCase() === newName.toLowerCase()
      );
      if(existingMatch) {
        const doMerge = await PiDialog.confirm({title:`Merge with ${existingMatch.label}?`, message:`Someone is already named "${existingMatch.label}". Merge these two into one person?`, okText:"Merge"});
        if(doMerge) {
          saveBtn.textContent = "Merging…";
          saveBtn.disabled = true;
          try {
            const merged = await invoke("merge_persons", { personKeys: [existingMatch.key, key], label: existingMatch.label });
            state.mediaPeople = (state.mediaPeople || []).filter(g => g.key !== key && g.key !== existingMatch.key);
            if(merged && merged.key) {
              state.mediaPeople.unshift(merged);
              state.mediaPeople.sort((a,b) => (b.count||0) - (a.count||0));
            }
            toast(`Merged into "${existingMatch.label}"! AI model fused prototypes.`);
            renderMediaPeople();
            return;
          } catch(err) {
            console.error("Auto-merge on rename failed:", err);
          }
        }
      }

      saveBtn.textContent="…";
      saveBtn.disabled=true;
      try{
        const saved=await invoke("rename_person", {personKey:key, label:newName});
        const g=state.mediaPeople.find(x=>x.key===key);
        if(g) g.label=saved||newName;
        toast(`Saved ${saved||newName}`);
        renderMediaPeople();
      }catch(err){
        toast("Rename failed: "+(err?.message||String(err)));
        saveBtn.textContent="Save";
        saveBtn.disabled=false;
      }
      return;
    }
    const cancelBtn=e.target.closest("[data-cancel]");
    if(cancelBtn){
      e.stopPropagation();
      e.preventDefault();
      const key=cancelBtn.getAttribute("data-cancel");
      const wrap=els.peopleGrid.querySelector(`[data-edit-wrap="${cssEsc(key)}"]`);
      if(wrap) wrap.classList.add("hidden");
      const editBtn2=els.peopleGrid.querySelector(`[data-edit="${cssEsc(key)}"]`);
      if(editBtn2) editBtn2.style.display="";
      const g2=state.mediaPeople.find(x=>x.key===key);
      const inp=wrap?.querySelector("input");
      if(inp && g2) inp.value=g2.label;
      return;
    }
    if(e.target.closest(".person-inline-edit")) return;
    const card=e.target.closest("[data-key]");
    if(!card) return;
    // delegate to person photos (Immich: click person → show all photos)
    const key=card.getAttribute("data-key");
    if(key) showPersonPhotos(key);
  };
  // Delegated key handling: Enter on input → Save, Esc → Cancel, Enter on card → open
  els.peopleGrid.onkeydown=(e)=>{
    const inp=e.target.closest("[data-input]");
    if(inp){
      const key=inp.getAttribute("data-input");
      if(e.key==="Enter"){
        e.preventDefault(); e.stopPropagation();
        els.peopleGrid.querySelector(`[data-save="${cssEsc(key)}"]`)?.click();
      } else if(e.key==="Escape"){
        e.preventDefault(); e.stopPropagation();
        els.peopleGrid.querySelector(`[data-cancel="${cssEsc(key)}"]`)?.click();
      }
      return;
    }
    if(e.key==="Enter"){
      const card=e.target.closest(".person-card");
      if(card){ e.preventDefault(); card.click(); }
    }
  };
  // change event for checkbox via keyboard/assistive tech
  els.peopleGrid.onchange=(e)=>{
    const cb=e.target.closest("[data-merge-check]");
    if(cb){
      const k=cb.getAttribute("data-merge-check");
      if(cb.checked) state.peopleSelection.add(k);
      else state.peopleSelection.delete(k);
      updatePeopleMergeBar();
      const card=cb.closest(".person-card");
      if(card) card.classList.toggle("merge-selected", cb.checked);
    }
  };
  // bind sticky merge bar buttons (once per render, idempotent)
  const mergeBtn=document.getElementById("peopleMergeBtn");
  const cancelBtn=document.getElementById("peopleMergeCancel");
  if(mergeBtn && !mergeBtn._bound){
    mergeBtn._bound=true;
    mergeBtn.addEventListener("click", doPeopleMerge);
  }
  if(cancelBtn && !cancelBtn._bound){
    cancelBtn._bound=true;
    cancelBtn.addEventListener("click", clearPeopleSelection);
  }
}function deviceIconFor(label, meta){ const s=((label||"")+" "+(meta||"")).toLowerCase(); if(s.includes("iphone")||s.includes("ipad")||s.includes("apple")) return "📱"; if(s.includes("canon")||s.includes("nikon")||s.includes("sony")||s.includes("fujifilm")||s.includes("fuji")||s.includes("panasonic")||s.includes("olympus")||s.includes("lumix")||s.includes("eos")||s.includes("ilce")||s.includes("z6")||s.includes("r5")||s.includes("dslr")||s.includes("mirrorless")) return "📷"; if(s.includes("heic")) return "📱"; if(s.includes("video")||s.includes("mp4")||s.includes("mov")) return "🎬"; if(s.includes("audio")) return "🎵"; if(s.includes("png")||s.includes("jpeg")||s.includes("jpg")||s.includes("heic")||s.includes("webp")||s.includes("tiff")) return "🖼"; return "🖼"; }
function renderMediaDevices(){const d=state.mediaDevices||mockDeviceGroups(); const byDrive=d.by_drive||[]; const byType=d.by_type||d.by_device||[];const dcEl=document.getElementById("devicesCount"); if(dcEl) dcEl.textContent=byDrive.length+" volumes";els.devicesGrid.innerHTML=byDrive.map(v=>`<div class="group-card"><div class="cover">${esc(v.icon||"💾")}</div><div class="info"><div class="name">${esc(v.label||v.drive||v.key||"Drive")}</div><div class="sub">${v.count} files${v.total_size?` • ${fmtSize(v.total_size)}`:""}${v.type?` • ${esc(v.type)}`:""}</div></div></div>`).join("")||`<div style="padding:12px;color:var(--text-3)">No drives found</div>`; if(!byType.length){ els.deviceMetaGrid.innerHTML=`<div style="padding:12px;color:var(--text-3)">No device data - add photos with EXIF (JPEG from camera/phone)</div>`; return; } els.deviceMetaGrid.innerHTML=byType.map(v=>{ const label=v.label||v.key||"Unknown Device"; const meta=v.meta||v.make||""; const count=v.count||0; const size=v.total_size?fmtSize(v.total_size):""; // EXIF Make/Model: show Make as meta if not provided - first token of label
  let metaDisplay=meta; if(!metaDisplay && label && !label.includes("(") && !label.includes("JPEG") && !label.includes("PNG") && !label.includes("Video") && !label.includes("Audio")){ const first=label.trim().split(/\s+/)[0]; if(first && first.toLowerCase()!==label.toLowerCase()) metaDisplay=first; } const subParts=[]; subParts.push(count+(count===1?" file":" files")); if(metaDisplay) subParts.push(esc(metaDisplay)); else if(size) subParts.push(size); else if(label.includes("(")) subParts.push("No EXIF - extension fallback"); const icon=v.icon||deviceIconFor(label, metaDisplay); const preview=(v.preview&&v.preview[0])||""; const thumbAttr=preview?` data-device-thumb="${esc(preview)}"`:""; return `<div class="group-card" title="${esc(label)} • ${count} files"${thumbAttr}><div class="cover">${esc(icon)}</div><div class="info"><div class="name">${esc(label)}</div><div class="sub">${subParts.join(" • ")}</div></div></div>`; }).join("");}/* View / Navigation */function setView(v){state.view=v;localStorage.setItem("fe:view",v);$("#viewListBtn").classList.toggle("active",v==="list");$("#viewGridBtn").classList.toggle("active",v==="grid");
if(els.layoutInfo) els.layoutInfo.textContent=`${v==="grid"?"Grid":"List"} • ${state.group==="none"?"No group":"Group: "+state.group}`;renderVirtualized(true)}
function showExplorer(){ showView("viewportWrap"); }
function showMedia(tab="people"){ go({k: tab==="devices"?"devices":"people"}); }/* Command palette */const paletteActions=[{id:"go-c",label:"Go to C:\\",desc:"Go C:",icon:"💾",run:()=>navigateTo("C:\\")},{id:"go-d",label:"Go to D:\\",desc:"Go D:",icon:"💾",run:()=>navigateTo("D:\\")},{id:"go-home",label:"Go Home",desc:"Home",icon:"⌂",run:()=>navigateTo("")},{id:"search",label:"Search…",desc:"Search",icon:"⌕",run:()=>els.searchInput.focus()},{id:"new-folder",label:"Create folder",desc:"New folder",icon:"📁",run:()=>els.newFolderBtn.click()},{id:"toggle-theme",label:"Toggle light/dark",desc:"Theme",icon:"◐",run:()=>PiSettings.set("theme",(document.documentElement.dataset.theme||"").includes("light")?"fluent-dark":"fluent-light")},{id:"toggle-details",label:"Pane",desc:"Pane",icon:"◧",run:()=>toggleDetails()},{id:"rebuild-index",label:"Rebuild",desc:"Rebuild",icon:"⟳",run:async()=>{toast("Rebuilding index…"); await safeInvoke("rebuild_index",{}, {rebuilding:true}); fetchIndexStatus();}},{id:"list-view",label:"List view",desc:"List",icon:"☰",run:()=>setView("list")},{id:"grid-view",label:"Grid view",desc:"Grid",icon:"▦",run:()=>setView("grid")},{id:"select-all",label:"Select all",desc:"Select all",icon:"☑",run:()=>selectAll()},{id:"refresh",label:"Refresh",desc:"Refresh",icon:"↻",run:()=>refreshView()},{id:"go-gallery",label:"Gallery",desc:"Photos and videos",icon:"🖼",run:()=>go({k:"gallery"})},{id:"go-devices",label:"Devices",desc:"By camera / phone",icon:"📷",run:()=>go({k:"devices"})},{id:"ops",label:"File operations",desc:"Copy / move progress",icon:"⇄",run:()=>PiOps.open()},];
let paletteIdx=0, paletteFiltered=[];
function fuzzyScore(q,label){if(!q) return 1; const a=q.toLowerCase(), b=label.toLowerCase(); if(b.includes(a)) return 2; let ai=0; for(let ch of b){ if(ch===a[ai]) ai++; if(ai===a.length) return 1; } return 0;}
function showPersonPhotos(personKey){ const g=(state.mediaPeople||[]).find(x=>x.key===personKey); return go({k:"person",key:personKey,label:g?.label}); }
async function loadPersonPhotos(personKey){
  const g=(state.mediaPeople||[]).find(x=>x.key===personKey);
  if(!g){ state.files=[]; renderVirtualized(true); updateCounts(); els.statusText.textContent="This person is no longer in People"; return; }
  state.currentPersonKey = personKey;
  state.currentPersonLabel = g.label;
  const filePaths=(g.paths&&g.paths.length)?g.paths:(g.preview?g.preview.filter(p=>!p.startsWith("data:image/")):[]);
  if(!filePaths.length){ toast(`No photos for ${g.label}`); return; }
  let files=filePaths.map(p=>{ const name=p.split("\\").pop()||p.split("/").pop()||p; const ext=(name.split(".").pop()||"").toLowerCase(); return {name, path:p, is_dir:false, size:0, modified:"", extension:ext, ext}; });
  state.isSearching=false; state.searchQuery=""; hideSearchUI();
  state.files=files; renderVirtualized(true); updateCounts();
  els.statusText.textContent=`${files.length} photos of ${g.label}`;

  try {
    const meta = await invoke("get_files_info", { paths: filePaths });
    if (meta && meta.length) {
      state.files = meta;
      renderVirtualized(true);
      updateCounts();
    }
  } catch (err) {
    console.error("Failed to fetch file info:", err);
  }
}
function getPersonPaletteCommands(){
  return (state.mediaPeople||[]).filter(g=>{
    const lbl=(g.label||"").trim();
    if(!lbl) return false;
    if(/^Person \d+$/i.test(lbl)) return false;
    return true;
  }).flatMap(g=>[
    {id:`person-find-${g.key}`, label:`Find photos of ${g.label}`, desc:`${g.count} photos • ${g.label}`, icon:"🔍", run:()=> showPersonPhotos(g.key)},
    {id:`person-go-${g.key}`, label:`Go to ${g.label}`, desc:`Show ${g.count} photos of ${g.label}`, icon:"👤", run:()=> showPersonPhotos(g.key)},
  ]);
}
function renderPalette(filter=""){const q=filter.trim().toLowerCase();
let list=[...paletteActions, ...getPersonPaletteCommands()];
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
// viewer modal bindings (lightweight)
if(els.viewerClose) els.viewerClose.onclick=closeViewer;
if(els.viewerBackdrop) els.viewerBackdrop.onclick=closeViewer;
if(els.viewerOpenExternal) els.viewerOpenExternal.onclick=()=>{
  if(currentViewerFile) invoke("open_file",{path:currentViewerFile.path}).then(()=>toast("Opened with default app")).catch(e=>toast(String(e.message||e)));
};
window.addEventListener("keydown", e=>{
  if(e.key==="Escape" && els.viewerModal && !els.viewerModal.classList.contains("hidden")){
    e.preventDefault(); closeViewer();
  }
  if(e.key==="Enter" && els.fileViewport===document.activeElement && state.selected.size===1){
    const p=[...state.selected][0];
    const f=filteredFiles().find(x=>x.path===p);
    if(f){ e.preventDefault(); activateItem(f.path, !!f.is_dir); }
  }
});
if(els.newTabBtn) els.newTabBtn.onclick=()=>newTab({k:"home"});
if(els.tabList) els.tabList.onclick=e=>{const close=e.target.closest("[data-close]"); if(close){ closeTab(Number(close.dataset.close),e); return; }
const tab=e.target.closest(".tab"); if(tab) switchTab(Number(tab.dataset.tab));};els.drivesList.addEventListener("click",e=>{const b=e.target.closest("[data-drive]"); if(b) navigateTo(b.getAttribute("data-drive"))});
els.drivesList.addEventListener("auxclick",e=>{const b=e.target.closest("[data-drive]"); if(b&&e.button===1){ e.preventDefault(); newTab(pathLoc(b.getAttribute("data-drive"))); }});
const NAV_LOC={home:{k:"home"},recent:{k:"recent"},media:{k:"gallery"},people:{k:"people"},devices:{k:"devices"},network:{k:"network"},images:{k:"gallery",tab:"image"},videos:{k:"gallery",tab:"video"},"cat-images":{k:"tag",tag:"images"},"cat-videos":{k:"tag",tag:"videos"},docs:{k:"tag",tag:"documents"},documents:{k:"tag",tag:"documents"},archives:{k:"tag",tag:"archives"}};
$$("[data-nav]").forEach(btn=>{btn.addEventListener("click",()=>{ const l=NAV_LOC[btn.getAttribute("data-nav")]; if(l) go({...l}); closeSidebar(); });
  btn.addEventListener("auxclick",e=>{ const l=NAV_LOC[btn.getAttribute("data-nav")]; if(l&&e.button===1){ e.preventDefault(); newTab({...l}); } });});
  // People filter (Immich-like search) + redetect
  const pf=document.getElementById("peopleFilter");
  if(pf){
    pf.addEventListener("input", debounce(e=>{ peopleFilterText=e.target.value; renderMediaPeople(); }, 150));
    pf.addEventListener("keydown", e=>{ if(e.key==="Escape"){ e.target.value=""; peopleFilterText=""; renderMediaPeople(); }});
  }
  const pr=document.getElementById("peopleRefreshBtn");
  if(pr) pr.addEventListener("click", async ()=>{
    state.mediaPeople=null;
    toast("Re-detecting faces…");
    await loadMediaPeople(true);
  });els.searchInput.addEventListener("input",e=>{ const v=e.target.value; els.searchClear.classList.toggle("visible",!!v); doSearch(v); });els.searchClear.addEventListener("click",()=> exitSearch());$("#clearSearchBtn").addEventListener("click",()=> goBack());$("#viewListBtn").addEventListener("click",()=>setView("list"));$("#viewGridBtn").addEventListener("click",()=>setView("grid"));
if(els.groupSelect){ els.groupSelect.value=state.group; els.groupSelect.addEventListener("change",e=>{ state.group=e.target.value; localStorage.setItem("fe:group",state.group); renderVirtualized(true); if(els.layoutInfo) els.layoutInfo.textContent=`${state.view==="grid"?"Grid":"List"} • ${state.group==="none"?"No group":"Group: "+state.group}`; }); }
if(els.selectAllBtn) els.selectAllBtn.onclick=selectAll;
if(els.newFolderBtn) els.newFolderBtn.onclick=doCreateFolder;
if(els.hiddenToggle){ els.hiddenToggle.checked=state.showHidden; els.hiddenToggle.onchange=e=>{ state.showHidden=e.target.checked; localStorage.setItem("fe:showHidden", state.showHidden?"1":"0"); renderVirtualized(true); updateCounts(); }; }
if(els.detailsToggle) els.detailsToggle.onclick=()=>toggleDetails();
if(els.detailsClose) els.detailsClose.onclick=()=>toggleDetails(false);
// details pane tabs: Preview / Details (Files app like)
document.querySelectorAll("[data-details-tab]").forEach(btn=>{
  btn.addEventListener("click",()=> setDetailsMode(btn.getAttribute("data-details-tab")));
});
if(els.rebuildIndexBtn) els.rebuildIndexBtn.onclick=async()=>{ toast("Rebuilding index…"); await safeInvoke("rebuild_index",{}, {rebuilding:true}); fetchIndexStatus(); };
if(els.themeSelect){ els.themeSelect.value=document.documentElement.getAttribute("data-theme")||localStorage.getItem("fe:theme")||"fluent-dark"; els.themeSelect.addEventListener("change",e=>{ setTheme(e.target.value); }); }
$$("[data-pinned]").forEach(btn=> btn.addEventListener("click",()=>{
  const k=btn.getAttribute("data-pinned");
  const kf=state.knownFolders||{};
  const map={ desktop:kf.desktop, downloads:kf.downloads, documents:kf.documents, pictures:kf.pictures, music:kf.music, videos:kf.videos, recycle:"C:\\$Recycle.Bin"};
  const target=map[k]||"";
  if(k==="recycle") toast("Recycle Bin - opening C:\\$Recycle.Bin");
  navigateTo(target);
  closeSidebar();
}));
if(els.newBtn) els.newBtn.addEventListener("click", ()=> doCreateFolder());
if(els.cutBtn) els.cutBtn.addEventListener("click", ()=> { if(state.selected.size) copySelectionToClipboard("cut"); else toast("Select files to cut"); });
if(els.copyBtn) els.copyBtn.addEventListener("click", ()=> { if(state.selected.size) copySelectionToClipboard("copy"); else toast("Select files to copy"); });
if(els.pasteBtn) els.pasteBtn.addEventListener("click", ()=> doPaste());
if(els.deleteBtn) els.deleteBtn.addEventListener("click", ()=> doDeleteSelection());
if(els.renameBtn) els.renameBtn.addEventListener("click", ()=> { if(state.selected.size===1) doRenameFile([...state.selected][0]); else toast("Select single file to rename (F2)"); });
if(els.filterBtn) els.filterBtn.addEventListener("click", ()=> { els.searchInput.focus(); toast("Filter - type to filter"); });
if(els.splitViewBtn) els.splitViewBtn.addEventListener("click", ()=> toast("Split view - coming soon"));
if(els.forwardBtn) els.forwardBtn.addEventListener("click", ()=> goForward());
els.sortSelect.value=state.sort;els.sortSelect.addEventListener("change",e=>{state.sort=e.target.value; localStorage.setItem("fe:sort",state.sort);
if(state.isSearching){ state.searchResults=sortFiles(state.searchResults,state.sort); renderVirtualized(false); }
else if(state.tagMode){ state.files=sortFiles(state.files,state.sort); renderVirtualized(false); }
else { state.files=sortFiles(state.files,state.sort); renderVirtualized(false); }});$("#backBtn").addEventListener("click",()=>goBack());$("#upBtn").addEventListener("click",()=>goUp());$("#refreshBtn")?.addEventListener("click",e=>{ const b=e.currentTarget; b.classList.remove("spin-once"); void b.offsetWidth; b.classList.add("spin-once"); refreshView(); });
// App-level commands (from guard.js: F5, Ctrl+F, Alt+←/→, mouse back/forward, Ctrl+wheel/±).
window.addEventListener("pifiles:command",e=>{ const c=e.detail;
  if(c==="refresh"){ refreshView(); fetchIndexStatus(); }
  else if(c==="search"){ els.searchInput.focus(); els.searchInput.select(); }
  else if(c==="back") goBack(); else if(c==="forward") goForward();
  else if(c==="zoom-in"||c==="zoom-out"||c==="zoom-reset"){ state.zoom= c==="zoom-reset"?100:Math.max(75,Math.min(150,state.zoom+(c==="zoom-in"?5:-5))); document.documentElement.style.fontSize=state.zoom+"%"; if(els.zoomLabel) els.zoomLabel.textContent=state.zoom+"%"; }
});
window.addEventListener("pifiles:refresh",()=>refreshView());
window.addEventListener("pifiles:tags",()=>{ refreshRowStates(true); if(state.loc?.k==="utag"){ renderTabBar(); renderBreadcrumbs(); syncSidebar(state.loc); } });
window.addEventListener("pifiles:icons",()=>{ sysIconCache.clear(); renderVirtualized(false); renderDrives(); renderTabBar(); renderBreadcrumbs(); });
window.addEventListener("keydown",e=>{
if((e.ctrlKey||e.metaKey)&& !e.shiftKey && e.key.toLowerCase()==="p"){ e.preventDefault(); setDetailsMode("preview"); if(state.detailsMode!=="hidden" && state.selected.size===1){ const p=[...state.selected][0]; const f=filteredFiles().find(x=>x.path===p); if(f) showDetails(f); } return; }
if((e.ctrlKey||e.metaKey)&& !e.shiftKey && e.key.toLowerCase()==="i"){ e.preventDefault(); setDetailsMode("details"); if(state.selected.size===1){ const p=[...state.selected][0]; const f=filteredFiles().find(x=>x.path===p); if(f) showDetails(f); } return; }
if((e.ctrlKey||e.metaKey)&& e.shiftKey && e.key.toLowerCase()==="d"){ e.preventDefault(); toggleDetails(); return; }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="k"){ e.preventDefault(); els.searchInput.focus(); }
if((e.ctrlKey||e.metaKey)&& e.shiftKey && e.key.toLowerCase()==="p"){ e.preventDefault(); if(els.commandPalette.classList.contains("hidden")) openPalette(); else closePalette(); }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="t"){ e.preventDefault(); newTab({k:"home"}); }
if((e.ctrlKey||e.metaKey)&& e.key==="Tab"){ e.preventDefault(); const i=state.tabs.findIndex(t=>t.id===state.activeTabId); const n=state.tabs[(i+(e.shiftKey?-1:1)+state.tabs.length)%state.tabs.length]; switchTab(n.id); }
if((e.ctrlKey||e.metaKey)&& e.shiftKey && e.key.toLowerCase()==="c" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName||"")){ e.preventDefault(); copyPaths(state.selected.size?[...state.selected]:[state.path].filter(Boolean)); return; }
if((e.ctrlKey||e.metaKey)&& e.shiftKey && e.key.toLowerCase()==="n"){ e.preventDefault(); doCreateFolder(); return; }
if(e.key==="Backspace" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||"") && els.viewerModal.classList.contains("hidden")){ e.preventDefault(); goBack(); }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="w"){ e.preventDefault(); closeTab(state.activeTabId); }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="l"){ e.preventDefault(); enterAddressEdit(); }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="a"){ if(document.activeElement===els.fileViewport || !/INPUT|TEXTAREA/.test(document.activeElement.tagName)){ e.preventDefault(); selectAll(); } }
if((e.ctrlKey||e.metaKey)&& !e.shiftKey && e.key.toLowerCase()==="c" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName||"") && els.viewerModal.classList.contains("hidden")){ if(state.selected.size>0){ e.preventDefault(); copySelectionToClipboard("copy"); } }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="x" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName||"") && els.viewerModal.classList.contains("hidden")){ if(state.selected.size>0){ e.preventDefault(); copySelectionToClipboard("cut"); } }
if((e.ctrlKey||e.metaKey)&& e.key.toLowerCase()==="v" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName||"") && els.viewerModal.classList.contains("hidden")){ e.preventDefault(); doPaste(); }
if(e.key==="Escape" && isOpVisible()){ hideOpView(); }
if(e.key==="Escape" && state.loc?.k==="search" && document.activeElement===els.searchInput) exitSearch();
if(e.key==="Escape" && !els.commandPalette.classList.contains("hidden")){ e.preventDefault(); closePalette(); }
if(e.key==="Escape" && els.addressInput && !els.addressInput.classList.contains("hidden")) exitAddressEdit(true);
if((e.key==="Delete" || e.key==="Del") && state.selected.size>0 && els.viewerModal.classList.contains("hidden")){ if(document.activeElement===els.fileViewport || !/INPUT|TEXTAREA/.test(document.activeElement.tagName)){ e.preventDefault(); doDeleteSelection(e.shiftKey); } }
if(e.key==="F5"){ e.preventDefault(); loadDir(state.path); }
if(e.key==="Enter" && e.altKey){ e.preventDefault(); openPropertiesWindow(state.selected.size?[...state.selected]:(state.loc?.k==="dir"?[state.path]:[])); return; }if(e.key==="F2" && state.selected.size===1){ e.preventDefault(); const p=[...state.selected][0]; doRenameFile(p); }});
if(els.cmdInput){els.cmdInput.addEventListener("input",e=> renderPalette(e.target.value));els.cmdInput.addEventListener("keydown",e=>{if(e.key==="ArrowDown"){ e.preventDefault(); paletteIdx=Math.min(paletteIdx+1, paletteFiltered.length-1); renderPalette(els.cmdInput.value); els.cmdList.children[paletteIdx]?.scrollIntoView({block:"nearest"}); $$(".cmd-item",els.cmdList).forEach((el,i)=>el.classList.toggle("active",i===paletteIdx)); }
else if(e.key==="ArrowUp"){ e.preventDefault(); paletteIdx=Math.max(0,paletteIdx-1); renderPalette(els.cmdInput.value); $$(".cmd-item",els.cmdList).forEach((el,i)=>el.classList.toggle("active",i===paletteIdx)); }
else if(e.key==="Enter"){ e.preventDefault(); execPalette(); }
else if(e.key==="Escape"){ e.preventDefault(); closePalette(); }});}
if(els.commandPalette){els.commandPalette.querySelector(".cmd-backdrop").addEventListener("click",closePalette);}
function setTheme(theme){
  if(!THEMES.includes(theme)){
    if(theme==="dark") theme="fluent-dark";
    else if(theme==="light") theme="fluent-light";
    else theme="fluent-dark";
  }
  document.documentElement.setAttribute("data-theme", theme);
  try{ localStorage.setItem("fe:theme", theme); }catch{}
  if(els.themeSelect) els.themeSelect.value=theme;
  document.querySelectorAll(".variant-chip").forEach(c=> c.classList.toggle("active", c.getAttribute("data-theme")===theme));
  if(els.statusRight){
    const desc={ "fluent-dark":"Fluent Dark • Segoe Variable • 4px • Mica", "fluent-light":"Fluent Light • Segoe Variable • 4px", "material-dark":"Material Dark • Roboto • 12px • Elevation", "material-light":"Material Light • Roboto • 12px"}[theme]||theme;
    els.statusRight.title="Theme: "+theme;
    els.statusRight.setAttribute("data-theme-hint", desc);
  }
}
$("#themeBtn")?.addEventListener("click",()=>{
  const cur=document.documentElement.getAttribute("data-theme")||localStorage.getItem("fe:theme")||"fluent-dark";
  let idx=THEMES.indexOf(cur);
  if(idx<0){ idx = cur==="dark"?0 : cur==="light"?1 : 0; }
  const next=THEMES[(idx+1)%THEMES.length];
  setTheme(next);
  toast("Theme: "+next);
});
document.querySelectorAll(".variant-chip").forEach(chip=>{
  chip.addEventListener("click",()=>{
    const t=chip.getAttribute("data-theme");
    setTheme(t);
    toast("Variant: "+t+" - strongest can be promoted");
  });
});$("#sidebarToggle").addEventListener("click",()=>{ els.sidebar.classList.toggle("open"); els.overlay.classList.toggle("show"); });els.overlay.addEventListener("click",closeSidebar);
if(els.zoomLabel){function applyZoom(){ document.documentElement.style.fontSize=state.zoom+"%"; els.zoomLabel.textContent=state.zoom+"%"; }
window.addEventListener("wheel",e=>{ if(e.ctrlKey && !e.target.closest?.(".viewer-box")){ e.preventDefault(); state.zoom=Math.max(75,Math.min(150, state.zoom + (e.deltaY<0?5:-5))); applyZoom(); }},{passive:false});els.zoomLabel.onclick=()=>{ state.zoom=100; applyZoom(); toast("Zoom 100%"); };}
if(els.sidebarResizer && els.sidebar) bindResizer(els.sidebarResizer, els.sidebar, "width", 180, 420);
if(els.detailsResizer && els.detailsPane){let dragging=false, startX=0, startW=0;
const onMove=e=>{ if(!dragging) return; const dx=startX - e.clientX; let w=startW + dx; w=Math.max(220,Math.min(420,w)); els.detailsPane.style.width=w+"px"; els.detailsPane.style.minWidth=w+"px"; };
const onUp=()=>{ dragging=false; els.detailsResizer.classList.remove("dragging"); window.removeEventListener("mousemove",onMove); window.removeEventListener("mouseup",onUp); };els.detailsResizer.addEventListener("mousedown",e=>{ dragging=true; startX=e.clientX; startW=els.detailsPane.getBoundingClientRect().width; els.detailsResizer.classList.add("dragging"); window.addEventListener("mousemove",onMove); window.addEventListener("mouseup",onUp); e.preventDefault(); });}
 // operation view cancel/close
 const opCancel=$("#opCancel"), opClose=$("#opClose");
 if(opCancel) opCancel.onclick= async ()=>{ if(currentOpId){ try{ await invoke("cancel_operation",{id:currentOpId}); toast("Cancelled"); }catch{} hideOpView(); } else hideOpView(); };
 if(opClose) opClose.onclick=()=> hideOpView();}
function closeSidebar(){try{if(els.sidebar) els.sidebar.classList.remove("open");if(els.overlay) els.overlay.classList.remove("show")}catch(e){console.error(e)}}
function restoreTheme(){try{
  let saved=localStorage.getItem("fe:theme");
  if(!saved){
    saved="fluent-dark";
  } else if(saved==="dark") saved="fluent-dark";
  else if(saved==="light") saved="fluent-light";
  else if(!THEMES.includes(saved)) saved="fluent-dark";
  document.documentElement.setAttribute("data-theme", saved);
  if(els.themeSelect) els.themeSelect.value=saved;
  document.querySelectorAll(".variant-chip").forEach(c=> c.classList.toggle("active", c.getAttribute("data-theme")===saved));
}catch(e){console.error(e); try{document.documentElement.setAttribute("data-theme","fluent-dark")}catch(_){} }}

// --- Window Controls (Custom Frameless Native Titlebar) ---
async function initWindowControls(){
  const minBtn = document.getElementById("windowMinBtn");
  const maxBtn = document.getElementById("windowMaxBtn");
  const closeBtn = document.getElementById("windowCloseBtn");
  const maxIcon = document.getElementById("winMaxIcon");

  async function updateMaxState(){
    try {
      const isMax = await safeInvoke("is_window_maximized", {}, false);
      if(maxIcon){
        if(isMax){
          maxIcon.innerHTML = `<path fill="none" stroke="currentColor" stroke-width="1" d="M2.5 2.5V0.5h7v7H7.5M0.5 2.5h7v7h-7z"/>`;
        } else {
          maxIcon.innerHTML = `<rect width="8.5" height="8.5" x="0.75" y="0.75" fill="none" stroke="currentColor" stroke-width="1.2"/>`;
        }
      }
    } catch{}
  }

  if(minBtn) minBtn.onclick = async () => {
    try { await invoke("minimize_window"); } catch(e){ console.error(e); }
  };
  if(maxBtn) maxBtn.onclick = async () => {
    try {
      await invoke("toggle_maximize_window");
      await updateMaxState();
    } catch(e){ console.error(e); }
  };
  if(closeBtn) closeBtn.onclick = async () => {
    try { await invoke("close_window"); } catch(e){ window.close(); }
  };

  const tabBar = document.getElementById("tabBar");
  if(tabBar) {
    tabBar.addEventListener("dblclick", async (e) => {
      if(e.target.closest("button") || e.target.closest("input") || e.target.closest(".tab")) return;
      try {
        await invoke("toggle_maximize_window");
        await updateMaxState();
      } catch{}
    });
  }

  window.addEventListener("keydown", async (e) => {
    if(e.key === "F11"){
      e.preventDefault();
      try {
        const isFs = await invoke("toggle_fullscreen");
        toast(isFs ? "Fullscreen mode (F11)" : "Exited fullscreen");
      } catch{}
    }
  });

  updateMaxState();
}

// --- Active Learning & Machine Learning Facial Recognition Suggestions ---
let activeFaceSuggestions = [];
let currentSugIdx = 0;
let faceModelStats = null;

async function refreshFaceModelStats(){
  try {
    const stats = await safeInvoke("get_face_model_stats", {}, null);
    if(stats){
      faceModelStats = stats;
      const el = document.getElementById("aiModelStats");
      if(el){
        const n=(v,one,many)=>`${v} ${v===1?one:many}`;
        el.textContent = stats.total_classes || stats.user_confirmations || stats.user_corrections
          ? [n(stats.total_classes,"person you taught","people you taught"), n(stats.total_exemplars,"reference face","reference faces"),
             n(stats.user_corrections,"correction","corrections"), stats.non_faces_filtered? n(stats.non_faces_filtered,"non-face hidden","non-faces hidden") : ""].filter(Boolean).join(" · ")
          : "Nothing learned yet - name, merge or correct people and PiFiles remembers it";
      }
    }
  } catch(e){ console.error("refreshFaceModelStats", e); }
}

async function loadFaceSuggestions(){
  try {
    const suggestions = await safeInvoke("get_face_learning_suggestions", {}, []);
    activeFaceSuggestions = Array.isArray(suggestions) ? suggestions : [];
    const badge = document.getElementById("aiSuggestionBadge");
    if(badge){
      badge.textContent = activeFaceSuggestions.length;
      badge.style.display = activeFaceSuggestions.length > 0 ? "inline-flex" : "none";
    }
    await refreshFaceModelStats();
  } catch(e){ console.error("loadFaceSuggestions", e); }
}

function renderCurrentSuggestion(){
  const modal = document.getElementById("faceSuggestionModal");
  if(!modal) return;
  if(currentSugIdx >= activeFaceSuggestions.length || activeFaceSuggestions.length === 0){
    modal.classList.add("hidden");
    toast("All pending suggestions reviewed! Model updated.");
    loadMediaPeople(true);
    return;
  }

  const sug = activeFaceSuggestions[currentSugIdx];
  modal.classList.remove("hidden");

  const progressPill = document.getElementById("sugProgressPill");
  if(progressPill) progressPill.textContent = `${currentSugIdx + 1} of ${activeFaceSuggestions.length}`;

  const thumbImg = document.getElementById("sugFaceThumb");
  if(thumbImg) thumbImg.src = sug.face_thumb || "";

  const confBadge = document.getElementById("sugConfidenceBadge");
  if(confBadge) {
    const confPct = Math.round((sug.confidence || 0.8) * 100);
    confBadge.textContent = `${confPct}% Match`;
  }

  const promptEl = document.getElementById("sugPrompt");
  if(promptEl){
    if(sug.question_type === "verify_face"){
      promptEl.innerHTML = `Does this photo contain a <strong>clear face</strong>?`;
    } else if(sug.suggested_label && !sug.suggested_label.startsWith("Person ")){
      promptEl.innerHTML = `Does this photo contain <strong>${esc(sug.suggested_label)}</strong>?`;
    } else {
      promptEl.innerHTML = `Who is in this photo? Help label <strong>${esc(sug.suggested_label || "this person")}</strong>`;
    }
  }

  const reasonEl = document.getElementById("sugReason");
  if(reasonEl) reasonEl.textContent = sug.reason || "High facial similarity to learned profile";

  const filePill = document.getElementById("sugFilePill");
  if(filePill) {
    filePill.textContent = sug.photo_path.split("\\").pop() || sug.photo_path;
    filePill.title = sug.photo_path;
  }

  const datalist = document.getElementById("existingPersonsList");
  if(datalist && sug.existing_persons){
    datalist.innerHTML = sug.existing_persons
      .map(([k, lbl]) => `<option value="${esc(lbl)}" data-key="${esc(k)}"></option>`)
      .join("");
  }

  const labelBox = document.getElementById("faceLabelBox");
  if(labelBox) labelBox.classList.add("hidden");

  const labelInp = document.getElementById("sugLabelInput");
  if(labelInp) labelInp.value = sug.suggested_label && !sug.suggested_label.startsWith("Person ") ? sug.suggested_label : "";

  const feedbackToast = document.getElementById("modelFeedbackToast");
  if(feedbackToast) feedbackToast.classList.add("hidden");
}

async function submitSuggestionFeedback(action, targetKey, targetLabel){
  if(currentSugIdx >= activeFaceSuggestions.length) return;
  const sug = activeFaceSuggestions[currentSugIdx];
  const payload = {
    action,
    suggestion_id: sug.id,
    photo_path: sug.photo_path,
    target_person_key: targetKey || sug.suggested_person_key,
    target_label: targetLabel || sug.suggested_label,
    hash: sug.hash || 0,
    embedding: sug.embedding || [],
    thumb_url: sug.face_thumb || ""
  };

  const feedbackToast = document.getElementById("modelFeedbackToast");
  if(feedbackToast){
    feedbackToast.textContent = action === "not_a_face" 
      ? "Learned: artifact filtered from face detector" 
      : `Model updated: prototype trained for ${targetLabel || sug.suggested_label || "person"}`;
    feedbackToast.classList.remove("hidden");
  }

  try {
    await invoke("submit_face_feedback", { payload });
    await refreshFaceModelStats();
  } catch(e){
    console.error("submit_face_feedback", e);
  }

  setTimeout(() => {
    activeFaceSuggestions.splice(currentSugIdx, 1);
    const badge = document.getElementById("aiSuggestionBadge");
    if(badge){
      badge.textContent = activeFaceSuggestions.length;
      badge.style.display = activeFaceSuggestions.length > 0 ? "inline-flex" : "none";
    }
    renderCurrentSuggestion();
  }, 450);
}

function initFaceSuggestionsUI(){
  const reviewBtn = document.getElementById("aiReviewBtn");
  const resetBtn = document.getElementById("aiResetModelBtn");
  const modal = document.getElementById("faceSuggestionModal");
  const closeBtn = document.getElementById("closeFaceModal");
  const backdrop = document.getElementById("faceSuggestionBackdrop");

  if(reviewBtn) reviewBtn.onclick = async () => {
    if(!activeFaceSuggestions.length){
      await loadFaceSuggestions();
    }
    if(!activeFaceSuggestions.length){
      toast("No uncertain matches found - facial model is up to date!");
      return;
    }
    currentSugIdx = 0;
    renderCurrentSuggestion();
  };

  if(resetBtn) resetBtn.onclick = async () => {
    if(!(await PiDialog.confirm({title:"Reset recognition?", message:"PiFiles forgets the people you named, merged and corrected. Photos aren't touched.", okText:"Reset", danger:true}))) return;
    try {
      await invoke("reset_face_model");
      toast("Facial recognition model reset to default");
      await refreshFaceModelStats();
      await loadMediaPeople(true);
    } catch(e){
      toast("Reset failed: " + e);
    }
  };

  if(closeBtn) closeBtn.onclick = () => {
    if(modal) modal.classList.add("hidden");
  };
  if(backdrop) backdrop.onclick = () => {
    if(modal) modal.classList.add("hidden");
  };

  const confirmBtn = document.getElementById("sugConfirmBtn");
  if(confirmBtn) confirmBtn.onclick = () => {
    submitSuggestionFeedback("confirm");
  };

  const changeBtn = document.getElementById("sugChangeBtn");
  const labelBox = document.getElementById("faceLabelBox");
  const labelInp = document.getElementById("sugLabelInput");
  const applyLabelBtn = document.getElementById("sugApplyLabelBtn");

  if(changeBtn) changeBtn.onclick = () => {
    if(labelBox){
      labelBox.classList.toggle("hidden");
      if(!labelBox.classList.contains("hidden") && labelInp){
        labelInp.focus();
        labelInp.select();
      }
    }
  };

  if(applyLabelBtn) applyLabelBtn.onclick = () => {
    const val = (labelInp?.value || "").trim();
    if(!val){
      toast("Please enter a person's name");
      return;
    }
    submitSuggestionFeedback("new_person", null, val);
  };

  const notFaceBtn = document.getElementById("sugNotFaceBtn");
  if(notFaceBtn) notFaceBtn.onclick = () => {
    submitSuggestionFeedback("not_a_face");
  };

  const skipBtn = document.getElementById("sugSkipBtn");
  if(skipBtn) skipBtn.onclick = () => {
    currentSugIdx++;
    renderCurrentSuggestion();
  };

  window.addEventListener("keydown", (e) => {
    if(modal && !modal.classList.contains("hidden")){
      if(e.target.tagName === "INPUT") return;
      if(e.key === "y" || e.key === "Y" || e.key === "Enter"){
        e.preventDefault();
        confirmBtn?.click();
      } else if(e.key === "n" || e.key === "N"){
        e.preventDefault();
        changeBtn?.click();
      } else if(e.key === "x" || e.key === "X"){
        e.preventDefault();
        notFaceBtn?.click();
      } else if(e.key === "Escape"){
        e.preventDefault();
        closeBtn?.click();
      }
    }
  });
}


function initMovePhotosUI(){
  const moveBtn = document.getElementById("moveSelectedPhotosBtn");
  const clearBtn = document.getElementById("clearPersonSelectionBtn");
  const modal = document.getElementById("movePhotosModal");
  const closeBtn = document.getElementById("closeMovePhotosModal");
  const backdrop = document.getElementById("movePhotosBackdrop");
  const cancelBtn = document.getElementById("cancelMovePhotosBtn");
  const confirmBtn = document.getElementById("confirmMovePhotosBtn");
  const selectEl = document.getElementById("moveTargetPersonSelect");
  const newNameInp = document.getElementById("moveTargetNewNameInput");
  const summaryEl = document.getElementById("movePhotosSummary");

  function closeModal(){
    if(modal) modal.classList.add("hidden");
  }

  if(closeBtn) closeBtn.onclick = closeModal;
  if(backdrop) backdrop.onclick = closeModal;
  if(cancelBtn) cancelBtn.onclick = closeModal;

  if(clearBtn) clearBtn.onclick = () => {
    state.selected.clear();
    renderVirtualized(false);
    updateSelectionUI();
  };

  if(moveBtn) moveBtn.onclick = () => {
    if(!state.currentPersonKey || state.selected.size === 0) return;
    const count = state.selected.size;
    const currentPerson = (state.mediaPeople || []).find(p => p.key === state.currentPersonKey);
    const sourceLabel = currentPerson ? currentPerson.label : "this person";

    if(summaryEl){
      summaryEl.innerHTML = `Move <strong>${count}</strong> selected photo${count > 1 ? "s" : ""} from <strong>${esc(sourceLabel)}</strong> to:`;
    }

    if(selectEl){
      selectEl.innerHTML = '<option value=""> - Select an existing person - </option>' +
        (state.mediaPeople || [])
          .filter(p => p.key !== state.currentPersonKey)
          .map(p => `<option value="${esc(p.key)}">${esc(p.label)} (${p.count} photos)</option>`)
          .join("");
    }

    if(newNameInp) newNameInp.value = "";
    if(modal) modal.classList.remove("hidden");
  };

  if(confirmBtn) confirmBtn.onclick = async () => {
    if(!state.currentPersonKey || state.selected.size === 0){
      closeModal();
      return;
    }
    const targetKey = selectEl?.value || null;
    const newName = (newNameInp?.value || "").trim() || null;

    if(!targetKey && !newName){
      toast("Please select an existing person or type a new person name");
      return;
    }

    const count = state.selected.size;
    const photoPaths = Array.from(state.selected);
    const sourceKey = state.currentPersonKey;

    try {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Moving...";
      const res = await invoke("move_person_photos", {
        sourceKey,
        photoPaths,
        targetKey: targetKey || null,
        targetLabel: newName || null
      });

      if(res && res.groups){
        state.mediaPeople = res.groups;
      }

      // Remove moved files from explorer
      const pathSet = new Set(photoPaths);
      state.files = state.files.filter(f => !pathSet.has(f.path));
      state.selected.clear();
      renderVirtualized(true);
      updateCounts();
      updateSelectionUI();

      closeModal();
      const targetDisplayName = newName || (state.mediaPeople || []).find(p => p.key === targetKey)?.label || "person";
      toast(`Moved ${count} photo${count > 1 ? "s" : ""} to ${targetDisplayName}. AI model trained: +1 positive exemplar on target, hard-negative repulsion boundary on source.`);

      // Refresh People cache in background
      await loadMediaPeople(true);
    } catch(err){
      console.error("move_person_photos error:", err);
      toast("Failed to move photos: " + err);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Move Photo(s)";
    }
  };
}

function initFastScanUI(){
  const btn = document.getElementById("fastScanToggleBtn");
  if(!btn) return;

  function updateBtnUI(isFast){
    state.fastScanMode = !!isFast;
    if(state.fastScanMode){
      btn.textContent = "⚡ Fast Scan";
      btn.title = "Fast Scan active (high CPU). Click to switch to silent Eco Mode";
      btn.style.background = "var(--accent-bg)";
      btn.style.borderColor = "var(--accent)";
      btn.style.color = "var(--accent-text)";
      btn.style.fontWeight = "600";
    } else {
      btn.textContent = "🌱 Eco Mode";
      btn.title = "Eco Mode active (gentle low-CPU background scan). Click to switch to Fast Scan";
      btn.style.background = "";
      btn.style.borderColor = "";
      btn.style.color = "";
      btn.style.fontWeight = "normal";
    }
  }

  btn.onclick = async () => {
    const nextMode = !state.fastScanMode;
    try {
      await invoke("set_fast_scan_mode", { fast: nextMode });
      updateBtnUI(nextMode);
      toast(nextMode ? "⚡ Fast Scan enabled: processing faces at maximum speed" : "🌱 Eco Mode enabled: background scanning silently with low CPU");
    } catch(e){
      console.error("set_fast_scan_mode error:", e);
    }
  };

  invoke("is_fast_scan_mode")
    .then(isFast => updateBtnUI(isFast))
    .catch(() => updateBtnUI(false));
}

function safeBoot(){
  try{
    restoreTheme();
    try{ initWindowControls(); }catch(e){console.error("initWindowControls",e)}
    try{ initFaceSuggestionsUI(); }catch(e){console.error("initFaceSuggestionsUI",e)}
    try{ bindEvents(); }catch(e){console.error("bindEvents",e)}
    try{ setView(state.view); }catch(e){console.error("setView",e)}
    try{ renderBreadcrumbs(); }catch(e){console.error(e)}
    try{
      setDetailsMode(state.detailsMode||"hidden");
    }catch(e){console.error(e)}
    if(els.groupSelect) try{ els.groupSelect.value=state.group; }catch(e){console.error(e)}
    if(els.hiddenToggle) try{ els.hiddenToggle.checked=state.showHidden; }catch(e){console.error(e)}
    safeInvoke("get_known_folders",{},{}).then(k=>{ state.knownFolders=k||{}; if(state.loc?.k==="home") whenViews(()=>PiViews.home()); syncSidebar(state.loc); });
    const startMode=pref("startup","home");
    let startLoc={k:"home"};
    try{ if(startMode==="last") startLoc=JSON.parse(localStorage.getItem("pf:lastLoc")||"null")||pathLoc(localStorage.getItem("fe:lastPath")||""); else if(startMode==="path") startLoc=pathLoc(pref("startupPath","")||""); }catch{}
    if(!startLoc||startLoc.k==="search") startLoc={k:"home"};
    state.tabs[0].loc=startLoc; state.tabs[0].title=locTitle(startLoc);
    loadDrives().catch(e=>console.error("loadDrives",e)).finally(()=>{ try{ if(!state.drives.length) renderDrives(); }catch(e){console.error(e)} });
    renderLoc(startLoc);
    // People data and review suggestions aren't needed for the first screen; load them once the app is idle.
    const idle=window.requestIdleCallback||(f=>setTimeout(f,1500));
    setTimeout(()=>idle(()=>{ try{ loadMediaPeople().catch(e=>console.error("loadMediaPeople",e)); }catch(e){console.error(e)} try{ loadFaceSuggestions().catch(e=>console.error("loadFaceSuggestions",e)); }catch(e){console.error(e)} }), perfTierNow()==="low"?15000:5000);
    try{ fetchIndexStatus(); }catch(e){console.error(e)}
    // Poll the index status quickly only while it's building, and never while the window is hidden.
    (function pollIndex(){ setTimeout(()=>{ try{ if(!document.hidden) fetchIndexStatus(); }catch(e){console.error(e)} pollIndex(); }, state._indexBuilding?3000:30000); })();
    if(!IS_APP) setTimeout(()=>{ try{ if(els.drivesList && els.drivesList.textContent.includes("Loading drives")){ console.warn("drives timeout - forcing mock"); state.drives=mockDrives().map(d=>({name:d.name,path:d.mount_point,mount_point:d.mount_point,total_space:d.total_space,free_space:d.free_space,type:d.type,used:d.used})); renderDrives(); }}catch(e){console.error(e)} },1500);
    window.__fmtSize=fmtSize; window.__assetUrl=assetUrl;
    window.__explorer={state, go, goBack, navigateTo, loadDir, doSearch, doCreateFolder, activateItem, selectAll, refreshView,
      openFile:(f,origin)=>{ if(opensInViewer(f)) openViewer(f,origin); else { addRecent(f.path); window.__openExternal?.(f.path); } },
      showFileMenu:(x,y,path,isDir)=>showFileMenuFor(x,y,path,isDir),
      thumb:(p)=>fetchThumb(p), recent:()=>recentList(), fmtDate,
      previewPath:(p)=>{ if(state.detailsMode!=="hidden"){ const n=p.split("\\").pop(); showDetails(fileByPath(p)||{name:n,path:p,is_dir:false,size:0,extension:(n.split(".").pop()||"").toLowerCase(),modified:""}); } },
      renderPeople:()=>{ try{ renderMediaPeople(); }catch(e){console.error(e)} },
      reloadPeople:()=>{ try{ loadMediaPeople(true); window.PiFacesUI?.reset(); }catch(e){console.error(e)} },
      clearSelection:()=>{ state.selected.clear(); refreshRowStates(); updateSelectionUI(); }};
    // Live settings: re-render the list/breadcrumbs when a display preference changes.
    window.addEventListener("pifiles:settings", e=>{ try{
      const k=e.detail&&e.detail.key;
      if(k==="density"){ ROW_H=PiSettings.rowHeight(); }
      if(k==="systemIcons"){ sysIconCache.clear(); }
      if(["density","showExtensions","showThumbnails","foldersFirst","dateFormat","sizeUnits","colTag","colDate","colType","colSize","showCheckboxes","autoFolderSizes","systemIcons"].includes(k)){
        if(k==="foldersFirst") state.files=sortFiles(state.files,state.sort);
        renderVirtualized(false); if(k==="sizeUnits"){ try{ updateCounts(); }catch{} }
      }
    }catch(err){ console.error("settings",err); } });window.toast=toast;
  }catch(e){console.error("safeBoot fatal",e); try{toast("Boot error: "+(e.message||e))}catch(_){}}
}
if(document.readyState==="loading"){ document.addEventListener("DOMContentLoaded", safeBoot); } else { safeBoot(); }
window.addEventListener("error", e=>{ console.error("global error", e.error||e.message); try{toast("Error: "+(e.message||e.error))}catch(_){}} );
window.addEventListener("unhandledrejection", e=>{ console.error("unhandled", e.reason); });
/* Minimised/hidden for a few seconds → lower the web view's memory target and return idle memory to the OS. */
document.addEventListener("visibilitychange",()=>{ const core=window.__TAURI__?.core; if(!core) return; clearTimeout(window.__pfBgT); if(document.hidden) window.__pfBgT=setTimeout(()=>core.invoke("set_background_mode",{background:true}).catch(()=>{}),4000); else core.invoke("set_background_mode",{background:false}).catch(()=>{}); });

/* Delegated actions for markup built from strings. Values come from data attributes (never
   spliced into code), so a crafted file name can't execute script - and no inline handlers
   means the strict Content-Security-Policy can forbid them. */
document.addEventListener("click",e=>{
  const el=e.target.closest?.("[data-act]"); if(!el) return;
  const arg=el.dataset.arg;
  switch(el.dataset.act){
    case "viewer": e.preventDefault(); window.__viewerOpen?.(arg); break;
    case "external": e.preventDefault(); Promise.resolve(window.__openExternal?.(arg)).catch(err=>toast(String(err?.message||err))); break;
    case "copy": navigator.clipboard?.writeText(arg).then(()=>toast("Copied")); break;
    case "zoom-toggle": el.style.transform=el.style.transform?"":"scale(1.8)"; el.style.cursor=el.style.transform?"zoom-out":"zoom-in"; break;
    case "stop": e.stopPropagation(); break;
    case "reload": location.reload(); break;
    case "new-folder": document.getElementById("newFolderBtn")?.click(); break;
  }
});
document.addEventListener("error",e=>{
  const el=e.target; if(!(el instanceof HTMLElement) || !el.dataset.onerr) return;
  const kind=el.dataset.onerr; delete el.dataset.onerr;
  if(kind==="unavailable"){ el.outerHTML=`<div style="font-size:32px">🖼</div><div style="color:var(--text-3)">Preview unavailable</div>`; return; }
  if(kind!=="asset-fallback-keep") el.style.display="none";
  const next=el.nextElementSibling;
  if(kind==="hide-next-grid" && next) next.style.display="grid";
  if(kind==="hide-next-block" && next) next.style.display="block";
  if(kind.startsWith("asset-fallback")) window.__previewAssetFallback?.(el.dataset.fallback, el);
  if(kind==="viewer-fallback"){ el.style.display=""; invoke("get_file_preview",{path:el.dataset.fallback}).then(u=>{ if(u){ el.src=u; el.parentElement?.querySelector(".viewer-ph")?.remove(); } }).catch(()=>{ el.outerHTML=`<div style="color:var(--text-3)">Preview unavailable</div>`; }); }
},true);
document.addEventListener("load",e=>{
  const el=e.target; if(!(el instanceof HTMLElement)) return;
  if(el.dataset.onload==="viewer-ready"){ el.classList.add("ready"); const ph=el.parentElement?.querySelector(".viewer-ph"); if(ph) setTimeout(()=>ph.remove(),180); return; }
  if(el.dataset.onload!=="reveal") return;
  el.style.opacity="1"; el.style.position="static"; const t=el.previousElementSibling; if(t) t.style.display="none";
},true);
/* Sidebar: drives get the same drive menu as on Home (rename label, eject, properties…). */
els.sidebar?.addEventListener("contextmenu",e=>{ const d=e.target.closest("[data-drive]"); if(!d) return; e.preventDefault(); const path=d.dataset.drive; showContextMenu(e.clientX,e.clientY,{path,name:path,is_dir:true},buildDriveMenu({path})); });
