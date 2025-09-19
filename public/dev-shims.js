// dev-shims.js
// This file contains development-only shims and test helpers. It is loaded
// dynamically by index.html only when running on localhost (or when
// window.__DUBSWITCH_DEV_SHIMS__ is set true).

window.blocks = window.blocks || [
  { label: '1-8', userin: 20, localin: 0 },
  { label: '9-16', userin: 21, localin: 1 },
  { label: '17-24', userin: 22, localin: 2 },
  { label: '25-32', userin: 23, localin: 3 }
];
window.routingState = window.routingState || [null, null, null, null];
window.userPatches = window.userPatches || {};
window.channelNames = window.channelNames || {};
window.channelNamePending = window.channelNamePending || {};
window.channelColors = window.channelColors || {};
window.colorMap = window.colorMap || { null: 'transparent' };

// Small helper to prefill channel names for tests
function __dev_fillChannelNames(){
  for (let ch=1; ch<=32; ch++){ const nn=String(ch).padStart(2,'0'); if(!window.channelNames[nn]) window.channelNames[nn]=`Ch ${nn}`; }
}

// Expose small helper so tests can opt-in explicitly
window.__dev_fillChannelNames = __dev_fillChannelNames;
