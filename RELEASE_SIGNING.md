# Releasing ABUZ8 OS (build + code-signing)

The Windows installer is built from HEAD by `scripts/build-release.ps1` (electron-builder → NSIS + portable).
It bundles the sovereign brain (`build-assets/brain`) and the neural voice engines (`build-assets/voice`),
and **refuses to build** a brainless or mute artifact (fail-closed gates).

## Build

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
```

Output lands in `dist\`:
- `ABUZ8-OS-<version>-Setup.exe` — NSIS one-click installer
- `ABUZ8-OS-<version>.exe` — portable
- `latest.yml` + `.blockmap` — auto-update metadata

The build is **~7 GB** because the offline Gemma-4-E4B brain ships inside it (that is the product — a sovereign,
no-cloud-required OS). For a lean installer that seeds the brain on first run instead, trim `extraResources`
in `src/package.json` — that is a product decision for the owner, not a default.

## Code-signing — RECOMMENDED: Azure Trusted Signing (~$10/mo)

Unsigned installers trip Windows SmartScreen ("Unknown publisher"), which kills trust for public downloads.
electron-builder 25.x has **native Azure Trusted Signing** support, and `build-release.ps1` auto-uses it when
the env is set — no code change. This is the cheapest publicly-trusted path: Microsoft-managed cert in a cloud
HSM, short-lived/rotated, real SmartScreen reputation, **no $300+ EV hardware token**.

**One-time setup (owner — this is the only money/contract step):**
1. Azure Portal → create a **Trusted Signing account** (Basic SKU ≈ **$9.99/mo**, includes a large monthly
   signature quota).
2. Create a **Certificate Profile** under it, and complete **Identity Validation** (Microsoft verifies the
   publisher name shown on the signature). ⚠️ *Eligibility:* an **organization** profile historically wants a
   business that's been established **3+ years** with verifiable records — if ABUZ8 LLC is newer, use the
   **individual** validation (publisher shows your personal legal name) or supply the extra org docs.
3. Create a service principal (App registration) and grant it the **Trusted Signing Certificate Profile Signer**
   role on the account.

**Then set these env vars and re-run `scripts\build-release.ps1` — it signs automatically:**
```powershell
$env:AZURE_TENANT_ID     = '<tenant guid>'
$env:AZURE_CLIENT_ID     = '<app/client id>'
$env:AZURE_CLIENT_SECRET = '<client secret>'
$env:ABUZ8_SIGN_ENDPOINT = 'https://<region>.codesigning.azure.net'   # e.g. https://eus.codesigning.azure.net
$env:ABUZ8_SIGN_ACCOUNT  = '<trusted-signing account name>'
$env:ABUZ8_SIGN_PROFILE  = '<certificate profile name>'
$env:ABUZ8_SIGN_PUBLISHER= 'ABUZ8 LLC'                                 # optional display name
```

### Fallback: a local .pfx (OV/EV cert you bought)
| How | Set |
|-----|-----|
| electron-builder native | `$env:CSC_LINK = 'C:\path\code-sign.pfx'` + `$env:CSC_KEY_PASSWORD = '***'` |
| repo-local (gitignored) | drop the cert at `build\code-sign.pfx`, set `$env:ABUZ8_CSC_PASSWORD = '***'` |

OV ≈ $200–400/yr (reputation builds over downloads); EV ≈ $300–700/yr + hardware token (instant reputation).
With nothing set, the build is a clean **unsigned** artifact (it will NOT grab a random machine cert).

NEVER commit the `.pfx`, the client secret, or any password. `build/` is gitignored, so `build\code-sign.pfx`
is safe by default; keep the Azure secrets in env vars only.

## Auto-update trust

Self-update already enforces https + host-pin + SHA-256 + Ed25519 signature (P5). A signed installer closes the
last gap (publisher identity) for a clean public release.
