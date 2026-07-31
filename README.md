# Blinkers

Simple Chrome extension for blocking distracting websites. It uses dynamic network rules plus a tab-navigation guard to enforce a blocklist.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the folder containing `manifest.json`.
5. Pin Blinkers from Chrome’s Extensions menu.

For Incognito blocking, enable **Allow in Incognito** on the extension’s Details page. Set **Site access** to **On all sites** so network redirects can run immediately.

## Features

- Simple mode - daily allowance across blocklisted sites. Allows a 15 min snooze if you solve a challenge.
- Ultra mode - Lock in for a fixed duration with no snooze option. Controls locked.
- Option to block YouTube Shorts completely.
- Track time spent on websites.
- Local Chrome storage with no account or server.