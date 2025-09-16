// Front-end JavaScript for DubSwitch (moved from inline <script> in index.html)

// Helper to send via WebSocket only when open
function safeSendWs(data) {
  if (window.ws && window.ws.readyState === 1) {
    window.ws.send(data);
  } else {
    // Wait for connection, then send once
    if (window.ws) {
      const onceOpen = () => {
        if (window.ws && window.ws.readyState === 1) window.ws.send(data);
        window.ws.removeEventListener('open', onceOpen);
      };
      window.ws.addEventListener('open', onceOpen);
    }
  }
}

// Single WebSocket manager
window.ws = window.ws || null;
function createWs(url) {
  try {
    if (window.ws && window.ws.readyState <= 1) {
      window.ws.close();
    }
  } catch (e) { /* ignore */ }
  window.ws = new WebSocket(url);
  window.ws.onopen = () => {
    console.log('WebSocket open ->', url);
  };
  window.ws.onclose = () => {
    console.log('WebSocket closed');
    x32Connected = false;
    showConnectDialog();
    statusEl.textContent = 'Status: Disconnected';
  };
  window.ws.onerror = (e) => {
    console.log('WebSocket error', e);
    statusEl.textContent = 'Status: WebSocket error';
  };
  window.ws.onmessage = handleWsMessage;
}

// Central message handler (previously ws.onmessage)
function handleWsMessage(evt) {
  const data = JSON.parse(evt.data);
  if (data.type === "ping") {
    x32Connected = true;
    initialConnectShown = true;
    hideConnectDialog();
    // Use the ping's origin as the current X32 IP when present
    const ip = data.from || null;
    setConnectedStatus(ip);
    safeSendWs(JSON.stringify({ type: "load_routing" }));
  } else if (data.type === "routing") {
    routingState = (Array.isArray(data.values) ? data.values.map(Number) : [null, null, null, null]);
    renderRoutingTable();
    if (x32Connected) setTimeout(checkUserIns, 300);
  } else if (data.type === "clp") {
    if (data.address && data.address.startsWith("/config/userrout/in/") && data.args.length) {
      const ch = parseInt(data.address.split("/").pop(), 10);
      const raw = data.args[0];
      userPatches[ch] = (raw && raw.value != null) ? raw.value : raw;
      renderUserPatches();
    } else if (data.address && /^\/ch\/\d{2}\/config\/name$/.test(data.address) && data.args.length) {
      const chKey = data.address.match(/^\/ch\/(\d{2})\/config\/name$/)[1];
      const raw = data.args[0];
      channelNames[chKey] = raw;
      channelNamePending[chKey] = false;
      renderUserPatches();
      renderRoutingTable();
    } else if (data.address && /^\/ch\/\d{2}\/config\/color$/.test(data.address) && data.args.length) {
      const ch = parseInt(data.address.split("/")[2], 10);
      const raw = data.args[0];
      const val = (raw && raw.value != null) ? raw.value : raw;
      channelColors[ch] = val;
    }
    clpLog.innerHTML += `<div>> Reply: <span style="color:#adff2f">${data.address}</span> ${JSON.stringify(data.args)}</div>`;
  } else if (data.type === "channel_names" && data.names) {
    for (let k in channelNames) delete channelNames[k];
    for (let k in data.names) {
      channelNames[k] = data.names[k];
      channelNamePending[k] = false;
    }
    renderUserPatches();
    renderRoutingTable();
  }
}

// Manual IP button in connection dialog
document.getElementById('manualIpBtn').addEventListener('click', function() {
  document.getElementById('connect-warning').style.display = 'none';
  $('#settingsModal').modal('show');
  document.getElementById('x32IpInput').value = localStorage.getItem('x32ManualIp') || '';
  // Enable all buttons in the modal
  ['autodiscoverBtn','saveIpBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = 1;
      btn.style.pointerEvents = '';
    }
  });
});

// When settings modal is closed, show connection dialog again if not connected
$('#settingsModal').on('hidden.bs.modal', function () {
  if (!window.x32Connected) {
    document.getElementById('connect-warning').style.display = '';
  }
});
// Settings dialog logic
document.getElementById('settingsBtn').addEventListener('click', function() {
  $('#settingsModal').modal('show');
  document.getElementById('x32IpInput').value = localStorage.getItem('x32ManualIp') || '';
});

document.getElementById('saveIpBtn').addEventListener('click', function() {
  const ip = document.getElementById('x32IpInput').value.trim();
  if (ip) {
    localStorage.setItem('x32ManualIp', ip);
    $('#settingsModal').modal('hide');
    x32Connected = false;
    document.getElementById('status').textContent = `Status: Setting X32 IP to: ${ip}`;
    document.getElementById('connect-warning').style.display = '';
    // Inform server to use this IP for OSC
    safeSendWs(JSON.stringify({ type: 'set_x32_ip', ip }));
  }
});

document.getElementById('autodiscoverBtn').addEventListener('click', function() {
  const btn = this;
  console.log('Autodiscover clicked');
  btn.disabled = true;
  btn.style.opacity = 0.6;
  // Immediately close the modal and show the connect dialog so there's no overlap
  try { $('#settingsModal').modal('hide'); } catch(e) {}
  document.getElementById('connect-warning').style.display = '';
  document.getElementById('status').textContent = 'Status: Autodiscovering…';
  fetch(serverBase + '/autodiscover-x32')
    .then(res => res.json())
    .then(data => {
      console.log('Autodiscover result', data);
      if (data.ip) {
        try { localStorage.setItem('x32ManualIp', data.ip); } catch(e) {}
        document.getElementById('x32IpInput').value = data.ip;
        x32Connected = false;
        document.getElementById('status').textContent = `Status: Setting X32 IP to: ${data.ip}`;
        safeSendWs(JSON.stringify({ type: 'set_x32_ip', ip: data.ip }));
      } else {
        document.getElementById('status').textContent = 'No X32 found on network.';
        try { $('#settingsModal').modal('show'); } catch(e) {}
      }
    })
    .catch(err => {
      console.error('Autodiscover error', err);
      document.getElementById('status').textContent = 'Discovery error.';
      try { $('#settingsModal').modal('show'); } catch(e) {}
    })
    .finally(() => {
      btn.disabled = false;
      btn.style.opacity = 1;
    });
});

// Always connect to the local server WebSocket. If a manual IP was stored,
// tell the server to target that X32 IP instead of creating a direct WS.
const statusEl = document.getElementById("status");
// Keep last known X32 IP (set when the server sends a ping with 'from')
window.lastX32Ip = null;
function setConnectedStatus(ip) {
  if (ip) window.lastX32Ip = ip;
  const ipPart = window.lastX32Ip ? ` (${window.lastX32Ip})` : '';
  statusEl.innerHTML = `Status: <span style="color: lime;">Connected</span>${ipPart}`;
}
let manualIp = localStorage.getItem('x32ManualIp');
// If loaded from file:// (packaged app) location.host is empty. Use localhost:3000.
const defaultWsHost = 'localhost:3000';
const wsHost = (location.protocol === 'file:' || !location.host) ? defaultWsHost : location.host;
createWs("ws://" + wsHost);
// When running as a packaged app, use explicit http://localhost:3000 for fetch/REST calls
const serverBase = (location.protocol === 'file:' || !location.host) ? 'http://localhost:3000' : `${location.protocol}//${location.host}`;
// Populate footer/app version by querying the server's /version endpoint (falls back to package.json in server)
(function populateVersion(){
  const footerEl = document.getElementById('app-version');
  const headerEl = document.getElementById('header-version');
  if (!footerEl && !headerEl) return;
  fetch(serverBase + '/version').then(r => r.text()).then(v => {
    const ver = (v || '').trim();
    if (ver) {
      if (footerEl) footerEl.textContent = `Version: v${ver}`;
      if (headerEl) headerEl.textContent = `v${ver}`;
    }
  }).catch(err => {
    if (window.PROD_VERSION) {
      if (footerEl) footerEl.textContent = `Version: v${window.PROD_VERSION}`;
      if (headerEl) headerEl.textContent = `v${window.PROD_VERSION}`;
    }
  });
})();
if (manualIp) {
  statusEl.textContent = `Status: Using manual IP: ${manualIp} (verifying)`;
  // Ask the server to set the X32 target to the saved manual IP
  safeSendWs(JSON.stringify({ type: 'set_x32_ip', ip: manualIp }));
} else {
  statusEl.textContent = 'Status: Connecting to server';
}
const userpatchContainer = document.getElementById("userpatch-container");
const routingTable = document.getElementById("routing-table");
const toggleInputsBtn = document.getElementById("toggle-inputs");
const clpLog = document.getElementById("clp-log");

const blocks = [
  { label: "1-8", userin: 20, localin: 0 },
  { label: "9-16", userin: 21, localin: 1 },
  { label: "17-24", userin: 22, localin: 2 },
  { label: "25-32", userin: 23, localin: 3 }
];
let routingState = [null,null,null,null];
const userPatches   = {};
const channelNames  = {};
const channelNamePending = {};
const channelColors = {};
const colorMap = {
  0:"#333",1:"red",2:"green",3:"yellow",
  4:"blue",5:"magenta",6:"cyan",7:"white",
  8:"#222",9:"darkred",10:"darkgreen",11:"olive",
  12:"navy",13:"purple",14:"teal",15:"#ccc"
};

let x32Connected = false;
let initialConnectShown = false;
let connectDialogTimeout = null;

function loadUserPatches(){
  for(let ch=1;ch<=32;ch++){
    const nn=String(ch).padStart(2,"0");
    safeSendWs(JSON.stringify({
      type:"clp",
      address:`/config/userrout/in/${nn}`,
      args:[]
    }));
  }
}
function loadChannelNames(){
  for(let ch=1;ch<=32;ch++){
    const nn=String(ch).padStart(2,"0");
    safeSendWs(JSON.stringify({
      type:"clp",
      address:`/ch/${nn}/config/name`,
      args:[]
    }));
  }
}
function loadChannelColors(){
  for(let ch=1;ch<=32;ch++){
    const nn=String(ch).padStart(2,"0");
    safeSendWs(JSON.stringify({
      type:"clp",
      address:`/ch/${nn}/config/color`,
      args:[]
    }));
  }
}
function refreshUserPatches(){
  loadUserPatches();
  loadChannelNames();
  loadChannelColors();
}
function setAllUserPatchesLocal(){
  for(let ch=1;ch<=32;ch++){
    userPatches[ch]=ch;
    const nn=String(ch).padStart(2,"0");
    safeSendWs(JSON.stringify({
      type:"clp",
      address:`/config/userrout/in/${nn}`,
      args:[ch]
    }));
  }
  renderUserPatches();
}
function setAllUserPatchesCard(){
  for(let ch=1;ch<=32;ch++){
    const val=128+ch;
    userPatches[ch]=val;
    const nn=String(ch).padStart(2,"0");
    safeSendWs(JSON.stringify({
      type:"clp",
      address:`/config/userrout/in/${nn}`,
      args:[val]
    }));
  }
  renderUserPatches();
}
function toggleAllInputs(){
  const allLocal = routingState.every((v,i)=>Number(v)===blocks[i].localin);
  const targets  = blocks.map(b=>allLocal?b.userin:b.localin);
  safeSendWs(JSON.stringify({type:"toggle_inputs",targets}));
  routingState = allLocal
    ? blocks.map(b=>b.userin)
    : blocks.map(b=>b.localin);
  renderRoutingTable();
  renderUserPatches(); // Ensure buttons are updated after toggling inputs
}
function sendCustomOSC(){
  const addr=document.getElementById("clp-address").value.trim();
  const argStr=document.getElementById("clp-args").value.trim();
  let args=[];
  if(argStr){
    try{ args=eval("["+argStr+"]"); }
    catch(e){
      clpLog.innerHTML+=`<div style="color:red">Invalid args: ${e.message}</div>`;
      return;
    }
  }
  safeSendWs(JSON.stringify({type:"clp",address:addr,args}));
  clpLog.innerHTML+=`<div>> Sent: ${addr} ${JSON.stringify(args)}</div>`;
}

function showConnectDialog(force) {
  document.getElementById('connect-warning').style.display = '';
  document.querySelectorAll('button, .channel-btn').forEach(btn=>{
    // Don't disable manual IP button
    if (btn.id === 'manualIpBtn') {
      btn.disabled = false;
      btn.style.opacity = 1;
      btn.style.pointerEvents = '';
    } else {
      btn.disabled = true;
      btn.style.opacity = 0.5;
      btn.style.pointerEvents = 'none';
    }
  });
}
function hideConnectDialog() {
  document.getElementById('connect-warning').style.display = 'none';
  document.querySelectorAll('button, .channel-btn').forEach(btn=>{
    btn.disabled = false;
    btn.style.opacity = 1;
    btn.style.pointerEvents = '';
  });
  try { clearTimeout(connectDialogTimeout); } catch(e) {}
  try { clearInterval(connectDialogTimeout); } catch(e) {}
  connectDialogTimeout = null;
}

function checkUserIns() {
  if (!x32Connected) {
    showConnectDialog();
    document.querySelectorAll('.channel-btn').forEach(btn=>{
      btn.disabled = true;
      btn.style.opacity = 0.5;
      btn.style.pointerEvents = 'none';
    });
    toggleInputsBtn.disabled = false;
    toggleInputsBtn.style.opacity = 1;
    toggleInputsBtn.style.pointerEvents = '';
    return;
  }
  hideConnectDialog();
  if (!Array.isArray(routingState) || routingState.length !== blocks.length) return;
  const allUserIns = routingState.every((v,i)=>Number(v)===blocks[i].userin);
  const warning = document.getElementById('userin-warning');
  if(!allUserIns) {
    warning.style.display = '';
    document.querySelectorAll('.channel-btn').forEach(btn=>{
      btn.disabled = true;
      btn.style.opacity = 0.5;
      btn.style.pointerEvents = 'none';
    });
    toggleInputsBtn.disabled = false;
    toggleInputsBtn.style.opacity = 1;
    toggleInputsBtn.style.pointerEvents = '';
    statusEl.innerHTML = '<span style="color:#ff5c5c;font-weight:bold;">Switch all inputs to UserIns to use the app.</span>';
    document.getElementById('switch-to-userins').disabled = false;
    document.getElementById('switch-to-userins').style.opacity = 1;
    document.getElementById('switch-to-userins').style.pointerEvents = '';
  } else {
    warning.style.display = 'none';
    document.querySelectorAll('.channel-btn').forEach(btn=>{
      btn.disabled = false;
      btn.style.opacity = 1;
      btn.style.pointerEvents = '';
    });
    toggleInputsBtn.disabled = false;
    toggleInputsBtn.style.opacity = 1;
    toggleInputsBtn.style.pointerEvents = '';
    setConnectedStatus(window.lastX32Ip);
  }
}

// Attach dialog button handlers
window.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('switch-to-userins').onclick = ()=>{
    safeSendWs(JSON.stringify({type:'toggle_inputs',targets:blocks.map(b=>b.userin)}));
    setTimeout(()=>safeSendWs(JSON.stringify({type:'load_routing'})),500);
  };
});

function renderRoutingTable(){
  let html="<tr><th>Block</th><th>Current</th></tr>";
  blocks.forEach((b,i)=>{
    const v=Number(routingState[i]);
    let txt;
    let cls;
    if(v===b.userin){
      txt = `UserIns ${b.label}`;
      cls = "userin";
    } else if(v===b.localin){
      txt = `LocalIns ${b.label}`;
      cls = "localin";
    } else if(v===0 && b.localin!==0){
      txt = `LocalIns ${b.label}`;
      cls = "localin";
    } else if(v>=1 && v<=32 && channelNames[v]){
      txt = `Other (${v}) — ${channelNames[v]}`;
      cls = "other";
    } else {
      txt = `Other (${v})`;
      cls = "other";
    }
    html+=`<tr><td>${b.label}</td><td class="${cls}">${txt}</td></tr>`;
  });
  routingTable.innerHTML=html;
  const allLocal=routingState.every((v,i)=>Number(v)===blocks[i].localin);
  toggleInputsBtn.classList.toggle("local",allLocal);
  toggleInputsBtn.classList.toggle("user",!allLocal);
  toggleInputsBtn.disabled=false;
  renderUserPatches();
  checkUserIns();
}

function renderUserPatches(){
  let html="";
  for(let ch=1;ch<=32;ch++){
    const nn=String(ch).padStart(2,"0");
    let name = `Ch ${nn}`;
    const chKey = nn;
    if(channelNamePending[chKey]){
      name = "Updating…";
    } else if(channelNames[chKey]!==undefined && channelNames[chKey]!==null && channelNames[chKey]!=""){
      if(typeof channelNames[chKey]==="object" && "value" in channelNames[chKey]){
        name = String(channelNames[chKey].value).trim();
      } else if(typeof channelNames[chKey]==="string"){
        name = channelNames[chKey].trim();
      } else {
        name = String(channelNames[chKey]).trim();
      }
    }
    const uVal=userPatches[ch]||ch;
    let patchTypeText = "";
    if(uVal>=1&&uVal<=32){
      patchTypeText = "Local";
    } else if(uVal>=129&&uVal<=160){
      patchTypeText = "DAW";
    } else {
      patchTypeText = "Other";
    }
    html+=`
      <div id="card-${nn}" class="channel-card card">
        <div id="led-${nn}" class="led-top"></div>
        <div
          id="btn-${nn}"
          class="channel-btn card-body"
        >
          <div class="up-text-wrap">
            <div class="up-num">${nn}</div>
            <div class="up-name" id="chname-${nn}" style="display:inline-block;">${name} <span id="rename-icon-${nn}" style="cursor:pointer;">✏️</span></div>
            <div class="up-type" style="font-size:0.8em;color:#adff2f;">${patchTypeText}</div>
            <span class="led" id="inner-led-${nn}"></span>
          </div>
        </div>
      </div>`;
  }
  userpatchContainer.innerHTML=html;

  for(let ch=1;ch<=32;ch++){
    const nn=String(ch).padStart(2,"0");
    const btn = document.getElementById(`btn-${nn}`);
    const card= document.getElementById(`card-${nn}`);
    const cVal=channelColors[ch];
    const uVal=userPatches[ch]||ch;
    if(uVal>=1&&uVal<=32){
      btn.style.backgroundColor = "#222"; // dark grey for Local
    } else if(uVal>=129&&uVal<=160){
      btn.style.backgroundColor = "#0074D9"; // blue for Card
    } else {
      btn.style.backgroundColor = cVal!=null? colorMap[cVal] : "transparent";
    }
    const topLed = document.getElementById(`led-${nn}`);
    const innerLed = document.getElementById(`inner-led-${nn}`);
    if(uVal>=1&&uVal<=32){
      topLed.style.background="#222"; // dark grey for Local
      innerLed.style.background="red";
    } else if(uVal>=129&&uVal<=160){
      topLed.style.background="#39e639"; // green for Card
      innerLed.style.background="green";
    } else {
      topLed.style.background="#333"; innerLed.style.background="#333";
    }
    const nameEl = document.getElementById(`chname-${nn}`);
    const iconEl = document.getElementById(`rename-icon-${nn}`);
    iconEl.onclick = (e) => {
      e.stopPropagation(); // Prevent patch toggle when renaming
      const chKey = nn;
      const currentName = channelNames[chKey] || "";
      const newName = prompt(`Rename channel ${nn}:`, currentName);
      if(newName && newName.trim() && newName !== currentName){
        channelNamePending[chKey] = true;
        renderUserPatches();
        safeSendWs(JSON.stringify({
          type: "clp",
          address: `/ch/${nn}/config/name`,
          args: [newName.trim()]
        }));
        setTimeout(() => {
          safeSendWs(JSON.stringify({
            type: "clp",
            address: `/ch/${nn}/config/name`,
            args: []
          }));
        }, 500);
      }
    };
    btn.onclick = (e) => {
      if(e.target === nameEl) return;
      const isLocal=uVal>=1&&uVal<=32;
      const newVal=isLocal?128+ch:ch;
      userPatches[ch]=newVal;
      safeSendWs(JSON.stringify({
        type:"clp",
        address:`/config/userrout/in/${nn}`,
        args:[newVal]
      }));
      renderUserPatches();
    };
  }
}

function togglePanel(panel) {
  if(panel === 'routing') {
    const content = document.getElementById('routing-content');
    const chevron = document.getElementById('routing-chevron');
    if(content.style.display === 'none') {
      content.style.display = '';
      chevron.textContent = '▼';
    } else {
      content.style.display = 'none';
      chevron.textContent = '▶️';
    }
  } else if(panel === 'clp') {
    const content = document.getElementById('clp-content');
    const chevron = document.getElementById('clp-chevron');
    if(content.style.display === 'none') {
      content.style.display = '';
      chevron.textContent = '▼';
    } else {
      content.style.display = 'none';
      chevron.textContent = '▶️';
    }
  }
}

// Message handling is centralized in handleWsMessage which is assigned
// to window.ws.onmessage inside createWs(). No duplicate handlers here.

window.onload=()=>{
  showConnectDialog(true);
  initialConnectShown = false;
  x32Connected = false;
  if (connectDialogTimeout) clearTimeout(connectDialogTimeout);
  connectDialogTimeout = setTimeout(()=>{
    if (x32Connected) {
      hideConnectDialog();
      setConnectedStatus(window.lastX32Ip);
    } else {
      connectDialogTimeout = setInterval(()=>{
        if (x32Connected) {
          hideConnectDialog();
          setConnectedStatus(window.lastX32Ip);
          clearInterval(connectDialogTimeout);
          connectDialogTimeout = null;
        }
      }, 500);
    }
  }, 3000);
  renderUserPatches();
  loadChannelNames(); // Explicitly load channel names from X32 on start
  refreshUserPatches();
  safeSendWs(JSON.stringify({type:"load_routing"}));
};
