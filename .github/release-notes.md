## Install

**macOS and Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.ps1 | iex
```

Or download the file for your system below, unpack it and run `streamfree`. Each file has a `.sha256` checksum next to it.

| System | File |
|---|---|
| macOS, Apple silicon | `streamfree-aarch64-apple-darwin.tar.gz` |
| macOS, Intel | `streamfree-x86_64-apple-darwin.tar.gz` |
| Windows, 64-bit | `streamfree-x86_64-pc-windows-msvc.zip` |
| Linux, x86-64 | `streamfree-x86_64-unknown-linux-gnu.tar.gz` |
| Linux, ARM64 | `streamfree-aarch64-unknown-linux-gnu.tar.gz` |

On macOS, a binary downloaded with a browser is not notarized: allow it once with `xattr -d com.apple.quarantine ./streamfree`.

The host needs Chrome, Edge or another Chromium browser; guests can use any modern browser. See the [README](https://github.com/iamvinbas/streamFree#readme) for guests over the internet, destinations and known limits.
