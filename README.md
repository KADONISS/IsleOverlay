# IsleOverlay

IsleOverlay is a configurable overlay bundle for IslePilot-compatible servers. It keeps its own settings directory and can run independently from any previous overlay installation.

## Configure a server

Start the app with `--configure`, or use **Server / API settings** from the tray menu:

- Right-click the IsleOverlay tray icon and choose **Configure** to reopen the settings window.
- If IsleOverlay is already running, launching it again with `--configure` brings the existing settings window to the front.

- **Server page URL**: optional web page such as `https://islepilot.eu/p/sbtcisland`.
- **API base URL**: the URL used for `/api/...` requests. The field accepts a path prefix.
- **Use server path as API prefix**: only enable this when the backend really serves endpoints at `https://host/p/name/api/...`.

For the current IslePilot web layout, the usual configuration is:

```text
Server page URL: https://islepilot.eu/p/sbtcisland
API base URL:    https://islepilot.eu
Use path prefix: off
```

If a private deployment exposes the overlay API under a path, use that path as the API base and enable the prefix option.

## Development

```powershell
npm install
npm run check
npm start -- --configure
```

Build Windows installer and portable executable:

```powershell
npm run dist
```

Artifacts are written to `release/`. Auto-update is disabled by default so the clone does not use the original app's update feed.
