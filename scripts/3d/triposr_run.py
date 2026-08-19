#!/usr/bin/env python
"""ABUZ8 sovereign image->3D via local TripoSR (no cloud key). Runs on the 5090.
Usage: triposr_run.py <image_path> <out_glb> [resolution]
Prints a JSON line on the last line: {"ok":true,"out":"...","verts":N}
"""
import sys, os, json, traceback

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: triposr_run.py <image> <out.glb> [res]"})); return 2
    img_path, out_path = sys.argv[1], sys.argv[2]
    res = int(sys.argv[3]) if len(sys.argv) > 3 else 256
    repo = r"E:\ABU\TripoSR"
    if repo not in sys.path:
        sys.path.insert(0, repo)
    try:
        import torch
        import numpy as np
        from PIL import Image
        # Sovereign CPU marching-cubes shim: torchmcubes often fails to compile on
        # CUDA13/MSVC. Inject a torchmcubes module backed by PyMCubes so tsr imports cleanly.
        import types as _types
        try:
            import torchmcubes  # noqa: F401 (compiled CUDA path, if it built)
        except Exception:
            import mcubes as _mc
            _shim = _types.ModuleType("torchmcubes")
            def _marching_cubes(level, thresh=0.0):
                vol = level.detach().cpu().numpy() if hasattr(level, "detach") else level
                v, f = _mc.marching_cubes(vol, thresh)
                return torch.from_numpy(v.copy()).float(), torch.from_numpy(f.copy()).long()
            _shim.marching_cubes = _marching_cubes
            sys.modules["torchmcubes"] = _shim
        from tsr.system import TSR
        from tsr.utils import remove_background, resize_foreground
        import rembg
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        model = TSR.from_pretrained("stabilityai/TripoSR", config_name="config.yaml", weight_name="model.ckpt")
        model.renderer.set_chunk_size(8192)
        model.to(dev)
        image = Image.open(img_path).convert("RGB")
        try:
            session = rembg.new_session()
            image = remove_background(image, session)
            image = resize_foreground(image, 0.85)
            arr = np.array(image).astype(np.float32) / 255.0
            if arr.shape[-1] == 4:
                arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
            image = Image.fromarray((arr * 255.0).astype(np.uint8))
        except Exception:
            pass  # background removal is best-effort
        with torch.no_grad():
            scene_codes = model([image], device=dev)
        meshes = model.extract_mesh(scene_codes, has_vertex_color=True, resolution=res)
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        meshes[0].export(out_path)
        verts = int(getattr(meshes[0], "vertices", []).__len__()) if hasattr(meshes[0], "vertices") else 0
        print(json.dumps({"ok": True, "out": out_path, "verts": verts, "device": dev}))
        return 0
    except ModuleNotFoundError as e:
        print(json.dumps({"ok": False, "not_installed": True, "error": str(e)})); return 3
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "trace": traceback.format_exc()[-600:]})); return 1

if __name__ == "__main__":
    sys.exit(main())
