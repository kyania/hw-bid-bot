# HW Bid Bot — Chrome Extension

A Chrome extension that automatically places bids on [homeworkforyou.com](https://www.homeworkforyou.com/project/browse/) while you're already logged in. No credentials stored — it works inside your existing browser session.

## Features

- Walks through project listings sequentially and places bids automatically
- Skips projects already bid on
- Configurable bid message
- Filter by subject field (or bid on everything)
- Configurable browse refresh interval
- Restart Scan button to reset the cycle without stopping the bot

## Installation

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer Mode** (toggle, top-right)
4. Click **Load unpacked** and select this folder
5. Navigate to `https://www.homeworkforyou.com/project/browse/` while logged in
6. Open the extension popup, configure your settings, and click **Start Bot**

## Settings

| Setting | Description |
|---|---|
| Subject Fields | Comma-separated list of subjects to bid on. Leave empty to bid on all. |
| Browse Refresh Interval | Seconds to wait after checking all projects before reloading the page. |
| Bid Message | The message sent with every bid. |
