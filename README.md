# MMM-CareConnect

Care alerts and WebRTC audio calling for MagicMirror2.

## Hub Dependency

The module is designed to use `MMM-SimpleRemote` as its hub. Carers see alerts and calls in the SimpleRemote dashboard.

## Installation

1. Copy `MMM-CareConnect` into the MagicMirror `modules/` directory.
2. Add `MMM-SimpleRemote` to the mirror config.
3. Use the same `mirrorToken` value in both modules.

## Config Example

```js
{
  module: "MMM-SimpleRemote",
  position: "fullscreen_above",
  config: {
    basePath: "/mm-simple-remote",
    mirrorToken: "CHANGE_ME_SHARED_TOKEN"
  }
},
{
  module: "MMM-CareConnect",
  position: "top_right",
  config: {
    hubBasePath: "/mm-simple-remote",
    mirrorToken: "CHANGE_ME_SHARED_TOKEN",
    alertButtons: [
      { label: "Need help", message: "I need assistance.", level: "help" },
      { label: "Call me", message: "Please call me.", level: "call" }
    ]
  }
}
```

## Voice Control Compatibility

The module listens for:

- `SR_CARE_ALERT`
- `AUDIOCALL_START_REQUEST`
- `AUDIOCALL_ACCEPT_REQUEST`
- `AUDIOCALL_DECLINE_REQUEST`
- `AUDIOCALL_END_REQUEST`

These notifications are emitted by `MMM-VoiceControl`.
