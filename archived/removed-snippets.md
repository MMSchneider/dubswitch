# Archived removed snippets

This file contains large comment blocks and explanatory snippets moved out of the main source files to keep the code lean.

---

### From `public/app.js` (original file header)

```text
/*
  public/app.js
  ----------------
  Front-end application logic for the DubSwitch UI.

  Purpose
  - Manage WebSocket communication with the local server.
  - Present the channel grid (1..32) and allow toggling inputs.
  - Provide the Settings / Matrix UI used to configure per-block and
    per-channel A/B mappings (LocalIns, UserIns, DAW, AES50X, Custom).
  - Infer a sensible default matrix from the live device state when
    the server hasn't provided a persisted one.

  High-level concepts / data shapes
  - blocks: Array of 4 block descriptors (1-8, 9-16, 17-24, 25-32)
      { label, userin, localin }

  - routingState: [v0, v1, v2, v3] numeric values representing each
    block's current route as provided by the X32 device.

  - userPatches: map ch -> numeric value representing /config/userrout/in/NN

  - toggleMatrix: persisted mapping (from server or inferred) with shape:
      { blocks: [ { id, toggleAction, switchAllAction, param, overrides } ... ],
        channelMap: { '01': { aAction, bAction, param }, ... } }

  - channelMatrix: runtime per-channel mapping derived from toggleMatrix
      keys 1..32 -> { aAction, bAction, param }

  WebSocket message contract (subset used by this client)
  - From server: {type: 'ping'|'routing'|'clp'|'channel_names'|'matrix'|...}
  - To server:   {type: 'clp'|'load_routing'|'set_x32_ip'|'get_matrix'|'set_matrix'|...}

  Important functions (documented inline below)
  - safeSendWs(data) : send on ws only when open (with once-open fallback)
  - createWs(url)    : establish WS and wire handlers
  - handleWsMessage  : central handler for incoming WS messages
  - computeValueForAction(ch, action, param): compute numeric CLP value
  - buildMatrixFromCurrentState(): create a sensible toggleMatrix if missing
  - renderUserPatches()/renderRoutingTable()/renderMatrix()/renderPerChannelMatrix(): UI renderers

  Notes
  - This file contains UI logic and optimistic updates (client-side) — the server
    is authoritative for persisted matrix and device routing. The client will
    request the server matrix at startup (get_matrix) and will auto-save
    inferred matrices if the user opted into autosave.
*/
```

---

You can restore any snippet from here if you need the original in-file documentation.

---

### Small HTML snippets moved from `public/index.html`

1) Matrix explainer text from `public/index.html`:

```text
Each block's toggle action and the global switch action can be set. Changes persist on the server.
```

