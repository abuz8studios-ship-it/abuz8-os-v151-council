# One-time setup: local TripoSR (sovereign image->3D, zero cloud key) for ABUZ8 OS.
# Uses the ComfyUI venv (already has torch+CUDA for the 5090s). Idempotent.
$ErrorActionPreference = 'Continue'
$py  = 'E:\ABU\ComfyUI\.venv\Scripts\python.exe'
$dst = 'E:\ABU\TripoSR'
Write-Output "[triposr-setup] start $(Get-Date -Format o)"
if (-not (Test-Path $py)) { Write-Output '[triposr-setup] FATAL: ComfyUI venv python missing'; exit 1 }
if (-not (Test-Path "$dst\.git") -and -not (Test-Path "$dst\tsr")) {
  Write-Output '[triposr-setup] cloning TripoSR...'
  git clone --depth 1 https://github.com/VAST-AI-Research/TripoSR $dst 2>&1 | Out-String | Write-Output
}
Write-Output '[triposr-setup] installing python deps...'
& $py -m pip install --quiet --upgrade pip 2>&1 | Out-String | Write-Output
& $py -m pip install --quiet omegaconf einops transformers trimesh rembg imageio pillow "huggingface_hub" onnxruntime 2>&1 | Out-String | Write-Output
# PyMCubes = CPU marching cubes (prebuilt wheel, no compile). The runner uses this as a
# torchmcubes shim, so we DON'T need torchmcubes (which fails to compile on CUDA13/MSVC).
& $py -m pip install --quiet PyMCubes 2>&1 | Out-String | Write-Output
Write-Output '[triposr-setup] prefetching weights (stabilityai/TripoSR ~1.7GB, first time only)...'
& $py -c "from huggingface_hub import hf_hub_download as d; d('stabilityai/TripoSR','model.ckpt'); d('stabilityai/TripoSR','config.yaml'); print('[triposr-setup] WEIGHTS_OK')" 2>&1 | Out-String | Write-Output
Write-Output "[triposr-setup] DONE $(Get-Date -Format o)"
