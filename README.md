# MMM-CareConnect

Combined **Care Alerts + WebRTC Audio Calling** module for MagicMirror².


It is designed to talk to a hub (carer web UI + storage + signaling), typically **MMM-SimpleRemote**.

## Hub dependency
Carers see alerts/calls in the hub dashboard. If you do not run a hub anywhere, there is no carer web interface.

## Installation
1) Copy `MMM-CareConnect` into your `modules/` directory.
2) Ensure the hub is reachable and configured with a `mirrorToken`.
3) Where the config says "CHANGE-ME" change this token to a long random string as an identifier.
## Config example

```js
{
  module: "MMM-SimpleRemote",
  position: "fullscreen_above",
  config: {
    basePath: "/mm-simple-remote",
    mirrorToken: "CHANGE_ME"
  }
},
{
  module: "MMM-CareConnect",
  position: "top_right",
  config: {
    hubBasePath: "/mm-simple-remote",
    mirrorToken: "CHANGE_ME",
    alertButtons: [
      { label: "Need help", message: "I need assistance.", level: "help" },
      { label: "Call me", message: "Please call me.", level: "call" }
    ]
  }
}
```

## Voice control compatibility
The module listens for:
- `SR_CARE_ALERT` (for alert requests)
- `AUDIOCALL_START_REQUEST`, `AUDIOCALL_ACCEPT_REQUEST`, `AUDIOCALL_DECLINE_REQUEST`, `AUDIOCALL_END_REQUEST`

So existing voice control integrations keep working.
