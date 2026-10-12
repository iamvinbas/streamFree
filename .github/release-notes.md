## Install

**macOS and Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.ps1 | iex
```

The installers add the **streamFree app**: Applications on macOS, Start menu and desktop on Windows, the applications menu on Linux. Or download the file for your system below and unpack it. On macOS, drag `streamFree.app` into Applications. Each file has a `.sha256` checksum next to it.

| System | File |
|---|---|
| macOS, Apple silicon | `streamfree-aarch64-apple-darwin.tar.gz` |
| macOS, Intel | `streamfree-x86_64-apple-darwin.tar.gz` |
| Windows, 64-bit | `streamfree-x86_64-pc-windows-msvc.zip` |
| Linux, x86-64 | `streamfree-x86_64-unknown-linux-gnu.tar.gz` |
| Linux, ARM64 | `streamfree-aarch64-unknown-linux-gnu.tar.gz` |

The macOS app is not notarized. The first time, right-click it and choose **Open**; if macOS still blocks it, use **System Settings → Privacy & Security → Open Anyway**. The install script avoids this step.

On macOS and Windows the app runs the studio in the system's web engine (WebKit, WebView2), so no browser is needed; on Linux it needs Chrome, Edge or Brave. Guests can use any modern browser. See the [README](https://github.com/iamvinbas/streamFree#readme) for guests over the internet, destinations and known limits.
