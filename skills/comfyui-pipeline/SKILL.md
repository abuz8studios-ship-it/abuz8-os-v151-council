---
name: ComfyUI image/video
description: Generate images/video on a local GPU via ComfyUI when it is running.
---

# ComfyUI image/video

## When to use
You need generated imagery (avatar textures, thumbnails, art) and ComfyUI is up on :8188.
## Steps
- Check /api/comfyui/status (running?).
- Export a workflow from ComfyUI (Save API Format) and POST it to /api/comfyui/generate.
- Use the returned image URL as a texture/asset.
## Guardrails
- Honest fallback: if ComfyUI is down, say so — do not fabricate an image.
