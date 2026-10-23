"use strict";
/* 前端只负责展示：ASI收益与指数点位均由后端计算，不在Canvas层二次合成。
 * 内部视窗start/end为点序号；数据time为5分钟终点，asof为实际采样时刻。
 * 图中使用百分比；period_return是后端原始小数，显示时用period_return_pct。
 */
const $ = id => document.getElementById(id);
// 静态发布包才设置该标记；本地及云端原API模式保持原有行为。
const staticMode = document.documentElement.dataset.mode === "github-pages";
let publishedAuditPath = null;
async function readDashboard(days) {
  const url=staticMode?new URL(`./data/dashboard.json?v=${Math.floor(Date.now()/30000)}`,document.baseURI):`/api/dashboard?days=${days}`;
  const r=await fetch(url,{signal:AbortSignal.timeout(12000),cache:"no-store"});
  if(!r.ok)throw Error(`HTTP ${r.status}`);
  const data=await r.json();
  if(staticMode){
    // 交易日以已发布截面中的日期为准，午休和周末不占拼接宽度。
    const dates=[...new Set(data.points.map(p=>p.time.slice(0,10)))].sort().slice(-days);
    data.points=data.points.filter(p=>dates.includes(p.time.slice(0,10)));
  }
  return data;
}
const canvas = $("chart"), ctx = canvas.getContext("2d"), tooltip = $("tooltip");
let saved = {};
try { saved = JSON.parse(localStorage.getItem("asi5m-view") || "{}"); } catch (_) {}
const state = { data:null, selected:new Set(saved.selected || ["hs300","sz50"]), overlay:saved.overlay !== false,
  asi:true, breadth:saved.breadth !== false, cold:true, hot:true, extremeCold:true, extremeHot:true, start:0, end:1, hover:null, full:true, days:[5,10,16].includes(saved.days) ? saved.days : 16,
  width:0, height:0, plot:null, pointers:new Map(), gesture:null, busy:false, disconnected:false, generation:0 };
$("days").value = String(state.days);
const pct = n => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
const signed = n => `${n > 0 ? "+" : ""}${n}`;
const seriesValue = (s,v) => !Number.isFinite(v) ? "—" : s.axis === "right" ? `${signed(v)} 只` : pct(v);
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clock = value => value ? value.slice(11,19) : "—";
const stamp = value => value.slice(0,16).replace("T"," ");
const referenceLines = [
  // ±2%长虚线在右侧标注；±3%细点虚线在左侧标注，与用户参考图一致。
  {key:"cold",level:-2,color:"#00bc41",name:"冰点 −2%",dash:[6,4],side:"right"},
  {key:"hot",level:2,color:"#ff3043",name:"沸点 +2%",dash:[6,4],side:"right"},
  {key:"extremeCold",level:-3,color:"#008e43",name:"极冷 −3%",dash:[2,2],side:"left"},
  {key:"extremeHot",level:3,color:"#ba0000",name:"极热 +3%",dash:[2,2],side:"left"}
];
function persist() { try { localStorage.setItem("asi5m-view",JSON.stringify({selected:[...state.selected],overlay:state.overlay,breadth:state.breadth,days:state.days})); } catch (_) {} }
function series() {
  const out = [];
  if (state.asi) out.push({key:"asi",name:"活跃股等权（ASI5m）",color:"#2771f5"});
  if (state.overlay && state.data) for (const [key, info] of Object.entries(state.data.indexes)) if (state.selected.has(key)) out.push({key,...info});
  if (state.breadth) out.push({key:"breadth",name:"广度净差",color:"#8192ad",axis:"right",dash:[4,3]});
  return out;
}
function valueAt(point,key) { return key === "asi" ? point.asi : key === "breadth" ? point.breadth?.net : point.indexes[key]; }
// 按后端指数定义构造按钮/图例，切换只改变可见性，不触发行情请求。
function renderControls() {
  if (!state.data) return;
  $("index-buttons").replaceChildren();
  for (const [key, info] of Object.entries(state.data.indexes)) {
    const button = document.createElement("button"); button.className="index-button";
    button.style.setProperty("--series",info.color); button.style.setProperty("--tint",`${info.color}0b`);
    button.setAttribute("aria-pressed",String(state.selected.has(key))); button.setAttribute("aria-label",`切换${info.name}`);
    button.innerHTML=`<span class="dot"></span>${escapeHTML(info.name)}`;
    button.onclick=()=>{ state.selected.has(key)?state.selected.delete(key):state.selected.add(key);persist();renderControls();draw(); };
    $("index-buttons").append(button);
  }
  $("overlay").textContent=`指数叠加：${state.overlay?"开":"关"}`; $("overlay").setAttribute("aria-pressed",String(state.overlay));
  $("legend").replaceChildren();
  const entries=[{key:"asi",name:"活跃股等权（ASI5m）",color:"#2771f5",active:state.asi}];
  if(state.overlay) for(const [key,info] of Object.entries(state.data.indexes)) if(state.selected.has(key)) entries.push({key,...info,active:true});
  entries.push({key:"breadth",name:"广度净差（右轴·上涨−下跌）",color:"#8192ad",active:state.breadth,dashed:true},...referenceLines.map(line=>({...line,active:state[line.key],dashed:true})));
  for(const entry of entries) {
    const button=document.createElement("button"); button.style.setProperty("--series",entry.color);button.setAttribute("aria-pressed",String(entry.active));
    button.innerHTML=`<span class="swatch ${entry.dashed?"dashed":""} ${entry.side==="left"?"fine":""}"></span>${escapeHTML(entry.name)}`;
    button.onclick=()=>{if(entry.key==="asi"||entry.key==="breadth"||referenceLines.some(line=>line.key===entry.key))state[entry.key]=!state[entry.key];else state.selected.delete(entry.key);persist();renderControls();draw();};
    $("legend").append(button);
  }
}
// 统一裁剪范围，禁止缩放/拖拽把视窗完全移出已有数据。
function clampRange(start,end) {
  const max=Math.max(1,(state.data?.points.length||2)-1), size=Math.max(Math.min(10,max),Math.min(max,end-start));
  state.start=Math.max(0,Math.min(max-size,start));state.end=state.start+size;
  state.full=state.start<.01&&state.end>=max-.01;
}
function reset() { clampRange(0,Math.max(1,(state.data?.points.length||2)-1));state.hover=null;tooltip.hidden=true;draw(); }
function zoom(factor,anchor=.5) { const size=state.end-state.start, center=state.start+size*anchor;clampRange(center-size*factor*anchor,center+size*factor*(1-anchor));draw(); }
// 按设备像素比设置Canvas实际分辨率，CSS尺寸仍为逻辑像素，避免高分屏模糊。
function resize() {
  const rect=canvas.getBoundingClientRect();state.width=rect.width;state.height=rect.height;
  const dpr=Math.min(window.devicePixelRatio||1,3);canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);draw();
}
// 绘制顺序：网格/日界 -> 四条参考线 -> 数据线/缺口 -> 标签 -> 悬浮十字线。
function draw() {
  const {width:w,height:h}=state; if(!w||!h)return;
  ctx.clearRect(0,0,w,h);const points=state.data?.points||[];
  const p={left:w<600?44:52,top:22,right:w-(state.breadth?48:16),bottom:h-34};p.width=p.right-p.left;p.height=p.bottom-p.top;state.plot=p;
  const active=series(), a=Math.max(0,Math.floor(state.start)), b=Math.min(points.length-1,Math.ceil(state.end));
  const vals=[0,...referenceLines.filter(line=>state[line.key]).map(line=>line.level)];for(let i=a;i<=b;i++)for(const s of active){const v=valueAt(points[i],s.key);if(s.axis!=="right"&&Number.isFinite(v))vals.push(v);}
  let min=Math.min(...vals),max=Math.max(...vals),padding=Math.max(.35,(max-min)*.12); min-=padding;max+=padding;
  const span=max-min,raw=span/5,mag=10**Math.floor(Math.log10(raw)),ratio=raw/mag;
  const step=(ratio<=1?1:ratio<=2?2:ratio<=2.5?2.5:ratio<=5?5:10)*mag;
  const x=i=>p.left+(i-state.start)/(state.end-state.start)*p.width,y=v=>p.bottom-(v-min)/(max-min)*p.height;
  // 广度单位为“只”，独立缩放且与左轴零点对齐，不参与百分比轴的范围计算。
  const breadthLimit=state.data?.formula.sample_size||100;
  const breadthScale=Math.min(max,-min)/breadthLimit, yBreadth=v=>y(v*breadthScale);
  const seriesY=(s,v)=>s.axis==="right"?yBreadth(v):y(v);
  state.x=x;state.y=y;
  ctx.font='11px Arial,"Microsoft YaHei",sans-serif';ctx.textBaseline="middle";ctx.lineWidth=1;
  for(let v=Math.ceil(min/step)*step;v<=max+1e-8;v+=step){const yy=y(v);ctx.beginPath();ctx.moveTo(p.left,yy);ctx.lineTo(p.right,yy);ctx.strokeStyle=Math.abs(v)<1e-7?"#cbd1dc":"#edf0f4";ctx.stroke();ctx.fillStyle="#8992a0";ctx.textAlign="right";ctx.fillText(`${Math.abs(v)<1e-7?"0.0":v.toFixed(1)}%`,p.left-13,yy);}
  const dayStarts=[];for(let i=0;i<points.length;i++)if(i===0||points[i].time.slice(0,10)!==points[i-1].time.slice(0,10))dayStarts.push(i);
  ctx.save();ctx.beginPath();ctx.rect(p.left,p.top,p.width,p.height);ctx.clip();
  ctx.strokeStyle="#dce2ec";ctx.lineWidth=1;
  for(const i of dayStarts){const xx=x(i);if(xx>=p.left&&xx<=p.right){ctx.beginPath();ctx.moveTo(xx,p.top);ctx.lineTo(xx,p.bottom);ctx.stroke();}}
  for(const line of referenceLines)if(state[line.key]){const yy=y(line.level);ctx.setLineDash(line.dash);ctx.strokeStyle=line.color;ctx.lineWidth=1.1;ctx.beginPath();ctx.moveTo(p.left,yy);ctx.lineTo(p.right,yy);ctx.stroke();ctx.setLineDash([]);}
  // Separate gaps in an incomplete real feed; adjacent trading dates remain stitched as in references.
  for(const s of [...active].reverse()) {
    ctx.strokeStyle=s.color;ctx.lineWidth=s.key==="asi"?1.4:1.3;ctx.lineJoin="round";ctx.lineCap="round";ctx.setLineDash(s.dash||[]);ctx.beginPath();let pen=false;
    for(let i=a;i<=b;i++){const point=points[i],value=valueAt(point,s.key);if(!Number.isFinite(value)){pen=false;continue;}
      if(i>a&&point.time.slice(0,10)===points[i-1].time.slice(0,10)){
        const gap=(new Date(point.time)-new Date(points[i-1].time))/60000;
        const lunch=points[i-1].time.slice(11,16)==="11:30"&&point.time.slice(11,16)==="13:05";
        if(gap>5&&!lunch)pen=false;
      }
      if(i>a&&s.key==="asi"&&point.gap_before)pen=false;
      if(pen)ctx.lineTo(x(i),seriesY(s,value));else ctx.moveTo(x(i),seriesY(s,value));pen=true;
    }ctx.stroke();ctx.setLineDash([]);
    if(a===b&&points[a]&&Number.isFinite(valueAt(points[a],s.key))){ctx.beginPath();ctx.arc(x(a),seriesY(s,valueAt(points[a],s.key)),2.5,0,Math.PI*2);ctx.fillStyle=s.color;ctx.fill();}
  }
  ctx.restore();
  if(state.breadth){ctx.fillStyle="#8998ae";ctx.textAlign="left";ctx.fillText("净差(只)",p.right+3,10);for(const v of [-breadthLimit,-breadthLimit/2,0,breadthLimit/2,breadthLimit])ctx.fillText(signed(v),p.right+7,yBreadth(v));}
  ctx.textAlign="right";ctx.font='11px "SimSun",serif';
  for(const line of referenceLines)if(state[line.key]){ctx.fillStyle=line.color;ctx.textAlign=line.side==="left"?"left":"right";ctx.fillText(line.name,line.side==="left"?p.left+6:p.right-5,y(line.level)+(line.key==="extremeCold"?10:-9));}
  ctx.font='11px Arial,"Microsoft YaHei",sans-serif';ctx.fillStyle="#66738a";ctx.textAlign="center";
  const visibleDays=dayStarts.filter(i=>i>=a&&i<=b),labelDate=(state.end-state.start)>160;
  if(labelDate){const stride=Math.max(1,Math.ceil(visibleDays.length/Math.max(2,p.width/62)));visibleDays.forEach((i,j)=>{if(j%stride===0){let xx=x(i);if(xx>=p.left&&xx<=p.right)ctx.fillText(points[i].time.slice(5,10),xx,p.bottom+16);}});}
  else {const stride=Math.max(1,Math.ceil((state.end-state.start)/Math.max(2,p.width/82)));for(let i=a;i<=b;i++){if(i%stride!==0)continue;const xx=x(i);if(xx>=p.left&&xx<=p.right){ctx.fillStyle="#9ba5b4";ctx.fillText(points[i].time.slice(11,16),xx,p.bottom+16);}}for(const i of visibleDays){ctx.fillStyle="#66738a";ctx.textAlign="left";ctx.fillText(points[i].time.slice(5,10),x(i)+4,p.top+8);ctx.textAlign="center";}}
  if(state.hover!==null&&points[state.hover]&&state.hover>=a&&state.hover<=b){const i=state.hover,xx=x(i);ctx.save();ctx.beginPath();ctx.rect(p.left,p.top,p.width,p.height);ctx.clip();ctx.strokeStyle="#9caabd";ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(xx,p.top);ctx.lineTo(xx,p.bottom);ctx.stroke();ctx.setLineDash([]);for(const s of active){const v=valueAt(points[i],s.key);if(!Number.isFinite(v))continue;const yy=seriesY(s,v);ctx.fillStyle="#fff";ctx.strokeStyle=s.color;ctx.lineWidth=1.7;ctx.beginPath();ctx.arc(xx,yy,3,0,Math.PI*2);ctx.fill();ctx.stroke();}ctx.restore();}
  $("range-label").textContent=points.length?`${points[a].time.slice(0,10)} — ${points[b].time.slice(0,10)} · ${b-a+1} 点`:"5分钟周期 · 等待行情";
}
// 提示同时公开采样时间、收益基准和来源，让局部实盘区间不会冒充完整日收益。
function showTooltip(px,py) {
  const points=state.data?.points,p=state.plot;if(!points?.length||!p)return;
  state.hover=Math.max(0,Math.min(points.length-1,Math.round(state.start+(px-p.left)/p.width*(state.end-state.start))));
  const point=points[state.hover];
  tooltip.innerHTML=`<div class="tip-title">${stamp(point.time)} <span style="font-weight:400;color:#9da5b1">${point.complete?"已结束":"形成中"}</span></div>`+
    series().map(s=>`<div class="tip-row"><span style="color:${s.color}">${escapeHTML(s.name)}</span><b style="color:${s.color}">${seriesValue(s,valueAt(point,s.key))}</b></div>`).join("")+
    `<div class="tip-small">指数点位 ${point.index_level.toFixed(3)} · 样本 ${point.sample_size}<br>本周期等权收益 ${pct(point.period_return_pct)}<br>上涨 ${point.counts.up} / 下跌 ${point.counts.down} / 平盘 ${point.counts.flat}<br>基准 ${stamp(point.day_anchor_time)}${point.day_return_complete?"":" · 区间基准"}<br>${point.origin==="historical_recalculation"?`历史K线截止 ${clock(point.asof)} · 历史真实行情回算`:`采样 ${clock(point.asof)} · ${point.source==="simulation"?"模拟行情":"实盘采集"}`}</div>`;
  tooltip.hidden=false;const tw=tooltip.offsetWidth,th=tooltip.offsetHeight;
  tooltip.style.left=`${Math.max(2,Math.min(state.width-tw-2,px+16+tw>state.width?px-tw-16:px+16))}px`;
  tooltip.style.top=`${Math.max(2,Math.min(state.height-th-2,py-th/2))}px`;draw();
}
function localPosition(e) { const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top}; }
canvas.addEventListener("wheel",e=>{if(!state.data?.points.length)return;e.preventDefault();const p=localPosition(e);zoom(Math.exp(Math.max(-.5,Math.min(.5,e.deltaY*.0015))),Math.max(0,Math.min(1,(p.x-state.plot.left)/state.plot.width)));},{passive:false});
canvas.addEventListener("dblclick",reset);
canvas.addEventListener("pointerdown",e=>{
  // 单指拖动与双指缩放共用Pointer Events，指针捕获避免拖出画布后丢失释放事件。
  canvas.focus({preventScroll:true});const p=localPosition(e);state.pointers.set(e.pointerId,p);canvas.setPointerCapture(e.pointerId);canvas.classList.add("dragging");
  const ps=[...state.pointers.values()];state.gesture={start:state.start,end:state.end,x:p.x,y:p.y,moved:false};
  if(ps.length===2)state.gesture={start:state.start,end:state.end,distance:Math.hypot(ps[1].x-ps[0].x,ps[1].y-ps[0].y),center:(ps[0].x+ps[1].x)/2,moved:true};
});
canvas.addEventListener("pointermove",e=>{
  const pos=localPosition(e);if(!state.pointers.has(e.pointerId)){if(pos.x>=state.plot?.left&&pos.x<=state.plot.right&&pos.y>=state.plot.top&&pos.y<=state.plot.bottom)showTooltip(pos.x,pos.y);else {state.hover=null;tooltip.hidden=true;draw();}return;}
  state.pointers.set(e.pointerId,pos);const ps=[...state.pointers.values()],g=state.gesture,p=state.plot;if(!g||!p)return;
  if(ps.length===2&&g.distance){const dist=Math.max(1,Math.hypot(ps[1].x-ps[0].x,ps[1].y-ps[0].y));const newSize=(g.end-g.start)*g.distance/dist,anchor=(g.center-p.left)/p.width,center=(ps[0].x+ps[1].x)/2;const left=g.start+(g.end-g.start)*anchor-newSize*(center-p.left)/p.width;clampRange(left,left+newSize);state.hover=null;tooltip.hidden=true;draw();}
  else if(ps.length===1&&!g.distance){const delta=(g.x-pos.x)/p.width*(g.end-g.start);if(Math.abs(g.x-pos.x)>3)g.moved=true;if(g.moved){clampRange(g.start+delta,g.end+delta);state.hover=null;tooltip.hidden=true;draw();}}
});
function release(e){const pos=localPosition(e),g=state.gesture;state.pointers.delete(e.pointerId);if(!state.pointers.size){canvas.classList.remove("dragging");if(g&&!g.moved)showTooltip(pos.x,pos.y);state.gesture=null;}else{const p=[...state.pointers.values()][0];state.gesture={start:state.start,end:state.end,x:p.x,y:p.y,moved:true};}}
canvas.addEventListener("pointerup",release);canvas.addEventListener("pointercancel",release);
canvas.addEventListener("pointerleave",()=>{if(!state.pointers.size){state.hover=null;tooltip.hidden=true;draw();}});
canvas.addEventListener("keydown",e=>{if(["+","=","-","0","ArrowLeft","ArrowRight"].includes(e.key))e.preventDefault();if(e.key==="+"||e.key==="=")zoom(.75);if(e.key==="-")zoom(1.33);if(e.key==="0")reset();if(e.key.startsWith("Arrow")&&state.data?.points.length){state.hover=Math.max(Math.ceil(state.start),Math.min(Math.floor(state.end),(state.hover??Math.round(state.end))+(e.key==="ArrowLeft"?-1:1)));showTooltip(state.x(state.hover),state.height/2);}});
$("zoom-in").onclick=()=>zoom(.75);$("zoom-out").onclick=()=>zoom(1.33);$("reset").onclick=reset;
$("overlay").onclick=()=>{state.overlay=!state.overlay;persist();renderControls();draw();};
$("days").onchange=()=>{state.days=Number($("days").value);state.full=true;persist();load();};
$("refresh").onclick=()=>load();
function notice(message) { $("notice").textContent=message;$("notice").hidden=!message; }
function renderStructure() {
  // 徽标始终反映最新截面；缩放/悬浮历史不会把历史结构误当作当前结构。
  const point=state.data?.points.at(-1),button=$("structure-badge");
  const cached=state.disconnected||["error","starting"].includes(state.data?.status.state);
  const label=point?.structure?.label||(point?"数据不足":"等待数据");
  const detail=point&&Number.isFinite(point.asi)?`（ASI ${pct(point.asi)}｜净差 ${Number.isFinite(point.breadth?.net)?signed(point.breadth.net):"—"}）`:"";
  button.textContent=`结构：${label}${detail}${cached&&point?" · 缓存":""}`;
  button.className=`structure-badge ${point?.structure?.tone||"neutral"}${cached?" cached":""}`;
  button.title=`当期ASI活跃股池，非全A广度。${point?`截面 ${stamp(point.time)}；采样 ${stamp(point.asof)}。`:""}${cached?"采集/连接暂未就绪，显示最后缓存。":""}点击查看判断口径。`;
  button.setAttribute("aria-label",`${button.textContent}，查看口径`);
}
$("structure-badge").onclick=()=>{
  const d=state.data?.breadth_definition,a=d?.structure_asi_threshold_pct??.2,b=d?.structure_breadth_threshold_pct??40;
  const point=state.data?.points.at(-1),n=state.data?.formula.sample_size||100;
  openDialog("活跃股广度与结构口径",`<p>范围为每根5分钟截面选出的<strong>${n}只ASI活跃股</strong>，不是全A市场。上涨/下跌相对各股昨收判断，沿用后端最小报价单位一半的平盘容差。</p><div class="formula-block">净差（只）= 上涨家数 − 下跌家数<br>标准化净差（%）= 100 × 净差 / 样本数</div><p>灰蓝虚线使用右轴“只”，不做平滑；右轴零点与左轴0%对齐，范围覆盖±样本数，缩放时与ASI同步。缺失广度会断线，不能以0填补。</p><p>结构为本项目可配置规则：ASI &gt; ${a}%且标准化净差 ≥ ${b}%为<strong>普涨</strong>；ASI &lt; −${a}%且净差 ≤ −${b}%为<strong>普跌</strong>。|ASI| &gt; ${a}%且ASI与净差方向相反为<strong>分化</strong>；其余为<strong>震荡</strong>。样本数${n}时，广度门槛对应${n*b/100}只净差。</p><p>徽标使用最新截面的ASI和广度；日内收益基准缺失时显示“基准不完整”，家数缺失或不自洽时显示“数据不足”。形成中截面会随采样更新；断线/采集失败时标“缓存”。${point?`当前截面 ${stamp(point.time)}，实际采样 ${stamp(point.asof)}。`:""}</p><p>这两项为展示指标，不参与ASI公式、成分筛选或指数递推。阈值可在配置文件中修改 <code>structure_asi_threshold_pct</code> 与 <code>structure_breadth_threshold_pct</code>，重启服务生效。</p>`);
};
async function load() {
  // generation丢弃并发请求的旧响应；轮询只读本地缓存，不放大外部抓取负载。
  const generation=++state.generation;$("refresh").disabled=true;
  try {
    const data=await readDashboard(state.days);if(generation!==state.generation)return;
    publishedAuditPath=data.publication?.latest_audit_path||null;
    const old=state.data,wasFull=state.full;
    const changedSource=old?.status.active!==data.status.active||old?.formula.model!==data.formula.model;
    // Preserve the user's historical window across polling and point insertions.
    const oldStartTime=old?.points[Math.floor(state.start)]?.time;
    const oldSize=state.end-state.start;
    state.data=data;state.disconnected=false;$("today-count").textContent=data.today_count;
    $("method-summary").textContent=`成交额前${data.formula.sample_size}只 · 5分钟收益等权 · 指数连乘递推`;
    const active=data.status.active,isSim=active==="simulation",names={simulation:"模拟数据",eastmoney:"东方财富 / 新浪 / 腾讯 · 实盘",json:"自有接口 · 实盘采集"};
    $("source-badge").textContent=data.status.state==="error"&&!data.points.length?"实盘连接异常":names[active]||"等待实时行情";$("source-badge").className=`source-badge ${isSim?"simulation":data.status.state==="error"?"error":active&&data.points.length?"live":""}`;
    const last=data.points.at(-1);$("updated").textContent=last?`最新采样 ${stamp(last.asof)}${data.status.state==="closed"?" · 非交易时段":""}`:"等待首个有效截面";
    let message="";
    if(isSim)message=data.status.state==="fallback"?`实时源暂不可用，已切换为模拟数据。${data.status.error||""}`:data.status.requested!=="simulation"?"当前无实盘缓存，非交易时段展示模拟数据。开市后将尝试采集实时行情。":"当前为模拟数据，曲线用于本地功能演示。可在本地配置中启用实时行情。";
    else if(data.status.error)message=`采集暂未成功，正在自动换线重试${data.status.consecutive_failures?`（连续${data.status.consecutive_failures}次）`:""}；保留已有实盘截面。${data.status.error}`;
    if(!isSim&&data.points.length>0&&data.points.length<48)message+=(message?" ":"")+"实盘历史从本次接入起积累，多日曲线随采集逐步形成。";
    if(data.points.some(p=>!p.day_return_complete))message+=(message?" ":"")+"部分区间缺少开盘以来的完整采集，ASI使用该区间起点作基准，详情见数值提示。";
    const historical=data.points.filter(p=>p.origin==="historical_recalculation");
    if(historical.length)message+=(message?" ":"")+`已接入历史真实行情回算 ${historical.length} 点；历史K线与盘中采样在数值提示中分别标明。`;
    if(staticMode){
      const exported=data.publication?.exported_at;
      const stale=exported&&data.status.state!=="closed"&&Date.now()-Date.parse(exported)>15*60*1000;
      message+=(message?" ":"")+`GitHub同步展示 · 每5分钟尝试同步，发布可能延迟。${exported?`数据导出 ${stamp(exported)}。`:""}${stale?"同步已超过15分钟未更新，当前显示历史缓存。":""}`;
      $("updated").textContent+=(exported?` · 导出 ${clock(exported)}`:"");
      $("source-badge").textContent+=" · 同步版";
    }
    notice(message);
    $("empty").hidden=data.points.length>0;if(!data.points.length)$("empty").textContent=data.status.state==="starting"?"正在连接行情源，准备首个截面…":data.status.error?"实时源暂不可用，等待重试":"尚无有效行情截面，等待采集";
    renderControls();renderStructure();if(wasFull||changedSource)reset();else{const idx=data.points.findIndex(p=>p.time===oldStartTime);clampRange(idx>=0?idx:state.start,(idx>=0?idx:state.start)+oldSize);draw();}
    if(!old)resize();
  }catch(error){if(generation!==state.generation)return;state.disconnected=true;$("source-badge").textContent="连接中断";$("source-badge").className="source-badge error";notice(staticMode?"发布数据暂时无法读取，已保留最后一次数据，请稍后刷新。":"本地服务连接中断，已保留最后一次数据。请确认启动窗口仍在运行。");if(!state.data?.points.length)$("empty").textContent=staticMode?"暂时无法读取发布数据":"暂时无法连接本地服务";}
  finally{if(generation===state.generation){$("refresh").disabled=false;renderStructure();}}
}
function openDialog(title,html){$("dialog-title").textContent=title;$("dialog-content").innerHTML=html;if(!$("details").open)$("details").showModal();}
$("formula").onclick=()=>{
  const f=state.data?.formula||{sample_size:100,min_listing_days:60,index_base:1000,first_bar_reference:"previous_close"};
  const first=f.first_bar_reference==="open"?"09:30开盘价（首根不含隔夜收益）":"上一交易日收盘价（首根包含隔夜变动）";
  openDialog("活跃股等权（ASI5m）· 5分钟等权指数",`<p>按用户提供的收益链模型实现。每根5分钟K线先剔除<strong>ST、停牌、上市未满${f.min_listing_days}个自然日</strong>的股票，再按当日累计成交额降序选前${f.sample_size}只，同额按代码升序。</p><div class="formula-block">rᵢ,ₜ = Pᵢ,ₜ / Pᵢ,ₜ₋₁ − 1<br>Rₜ = (1 / Nₜ) × Σ rᵢ,ₜ<br>Indexₜ = Indexₜ₋₁ × (1 + Rₜ)<br><strong>图中ASI5m(%) = 100 × (Indexₜ / 当日基准点位 − 1)</strong></div><p>每只成分权重1/Nₜ，成交额仅用于选股。初始基值${f.index_base}；新入选股票同样使用它自己的上一根5分钟收盘价，股票价格高低不会造成换股跳空。收益链法不额外引入价格加总除数。</p><p>09:35首根参考${first}；13:05参考11:30收盘。形成中K线始终相对同一根上根收盘计算，轮询更新不会重复复利；K线结束后固定最终样本和收益。每日48根K线。</p><p>图中为累计涨跌幅，单周期收益和指数点位见数值提示/截面明细。冰点−2%、沸点+2%使用长虚线，极冷−3%、极热+3%使用细点虚线，可分别点击图例隐藏。缺少上根K线数据时拒绝计算，不按0收益补齐；指数采集中断时断线并重新定基，明确标记“区间基准”。</p><p style="color:#8a95a6">本版本不再使用昨日涨幅、今日涨幅、涨跌比、涨跌停比的四项平均。元数据和上一根收盘价必须由行情源提供；实时快照在5分钟终点附近采样存在时间误差，实际采样时间见提示。此处不是交易所官方指数，也不是传统ASI振动升降指标。</p>`);
};
async function audit(point) {
  // 明细来自后端保存的原始100只成分，按source+time查询，不拿当前股票池倒填历史。
  if(!point||!state.data)return;
  openDialog("截面明细","<p>正在读取前100只成分…</p>");
  try{const source=state.data.status.active;
    if(staticMode&&!publishedAuditPath)throw Error("audit not published");
    const url=staticMode?new URL(publishedAuditPath,document.baseURI):`/api/audit?source=${encodeURIComponent(source)}&time=${encodeURIComponent(point.time)}`;
    const r=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error("audit");const p=await r.json();
    if(p.time!==point.time)throw Error("audit version mismatch");
    const history=p.origin==="historical_recalculation";
    const sourceLabel=history?"历史真实行情回算":p.source==="simulation"?"模拟行情":"实盘采集";
    const timeLabel=history?"历史K线截止":"实际采样";
    const provenance=history?`<br>来源：${escapeHTML(p.history_provenance?.bars||"")}；${escapeHTML(p.history_provenance?.eligibility_granularity||"")}`:"";
    openDialog(`截面明细 · ${stamp(p.time)}`,`<p>数据：${sourceLabel} · ${timeLabel} ${stamp(p.asof)} · 成分${p.sample_size}只<br>收益参考时刻 ${stamp(p.reference_time)} · ${p.day_return_complete?"当日完整基准":"区间起点基准"}${provenance}</p><div class="formula-block">本周期等权收益 = ${p.period_return_pct.toFixed(6)}%<br>上一指数点位 = ${p.index_previous.toFixed(6)}<br>当前指数点位 = ${p.index_level.toFixed(6)}<br>当日/区间基准 = ${p.day_base_index.toFixed(6)}<br><strong>ASI累计涨跌幅 = ${p.asi.toFixed(6)}%</strong></div><div class="table-scroll"><table class="details-table"><thead><tr><th>股票 / 代码</th><th>成交额（亿）</th><th>上根收盘</th><th>当前价</th><th>5分钟收益</th><th>权重</th></tr></thead><tbody>${p.members.map(s=>`<tr><td>${escapeHTML(s.name)}<br><span style="color:#98a1af">${escapeHTML(s.code)}</span></td><td>${(s.amount/1e8).toFixed(2)}</td><td>${s.previous_bar_close.toFixed(2)}</td><td>${s.price.toFixed(2)}</td><td class="${s.period_return>0?"positive":s.period_return<0?"negative":""}">${pct(s.period_return_pct)}</td><td>${(100*s.weight).toFixed(2)}%</td></tr>`).join("")}</tbody></table></div>`);
  }catch(_){openDialog("截面明细","<p>暂时无法读取该截面，请刷新后重试。</p>");}
}
$("audit-latest").onclick=()=>audit(state.data?.points.at(-1));
$("close-dialog").onclick=()=>$("details").close();
$("details").addEventListener("click",e=>{if(e.target===$("details")){const r=$("details").getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$("details").close();}});
new ResizeObserver(resize).observe(canvas);
load();setInterval(load,staticMode?30000:5000);
