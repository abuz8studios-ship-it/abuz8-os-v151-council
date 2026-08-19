#!/usr/bin/env python
# ABUZ8 OS — XTTS-v2 voice cloning. Loads the LOCAL model (no download) and synthesizes
# text in a target voice from a short reference clip. Sovereign: nothing leaves the machine.
import argparse, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--text', required=True)
    ap.add_argument('--ref', required=True, help='reference voice .wav to clone')
    ap.add_argument('--out', required=True)
    ap.add_argument('--lang', default='en')
    ap.add_argument('--model_dir', default=r'E:\ABU\AUDIO\xtts')
    a = ap.parse_args()

    import torch, torchaudio, numpy as np
    import soundfile as sf
    # torch 2.11's torchaudio.load routes through torchcodec (broken DLL on this stack).
    # Replace it with a soundfile-based loader so XTTS audio loading works without torchcodec.
    def _sf_load(path, *a, **k):
        data, sr = sf.read(str(path), dtype='float32', always_2d=True)  # (frames, channels)
        return torch.from_numpy(data.T.copy()), sr                       # (channels, frames), sr
    torchaudio.load = _sf_load
    from TTS.tts.configs.xtts_config import XttsConfig
    from TTS.tts.models.xtts import Xtts

    config = XttsConfig()
    config.load_json(os.path.join(a.model_dir, 'config.json'))
    model = Xtts.init_from_config(config)
    model.load_checkpoint(config, checkpoint_dir=a.model_dir, use_deepspeed=False)
    if torch.cuda.is_available():
        model.cuda()
    out = model.synthesize(a.text, config, speaker_wav=a.ref, gpt_cond_len=3, language=a.lang)
    wav = out['wav'] if isinstance(out, dict) else out
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    sf.write(a.out, wav, 24000)
    print('OK ' + a.out)

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        sys.stderr.write('XTTS_ERROR: ' + str(e))
        sys.exit(1)
