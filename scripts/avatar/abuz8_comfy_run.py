#!/usr/bin/env python
# ABUZ8 OS — universal ComfyUI runner. Loads ANY ComfyUI workflow file (UI graph format),
# converts it to API/prompt format, optionally overrides the positive prompt + seed, submits to
# the local ComfyUI, polls to completion, and prints the output file. This is how the studio runs
# bleeding-edge workflows (LTX-2.3, Wan 2.2, Hunyuan) natively without hand-building graphs.
import sys, json, time, argparse, urllib.request, random

def api_from_ui(wf, object_info, prompt_text=None, seed=None):
    nodes = wf.get('nodes', [])
    links = {l[0]: l for l in wf.get('links', [])}  # id -> [id, src_node, src_slot, dst_node, dst_slot, type]
    api = {}
    pos_node = None
    for n in nodes:
        if n.get('mode') in (2, 4):  # muted / bypassed
            continue
        ct = n['type']
        oi = object_info.get(ct, {})
        req = (oi.get('input', {}) or {}).get('required', {}) or {}
        opt = (oi.get('input', {}) or {}).get('optional', {}) or {}
        order = list(req.items()) + list(opt.items())
        linked = {}
        for inp in n.get('inputs', []) or []:
            if inp.get('link') is not None and inp['link'] in links:
                l = links[inp['link']]
                linked[inp['name']] = [str(l[1]), l[2]]
        # widget inputs = ordered primitive inputs not satisfied by a link
        widget_names = [name for name, spec in order
                        if name not in linked and (isinstance(spec[0], list) or (isinstance(spec[0], str) and spec[0] in ('INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO')))]
        wv = n.get('widgets_values') or []
        inputs = dict(linked)
        wi = 0
        for name in widget_names:
            if wi < len(wv):
                inputs[name] = wv[wi]; wi += 1
                # seed nodes carry an extra 'control_after_generate' widget right after the seed
                if name in ('seed', 'noise_seed') and wi < len(wv) and isinstance(wv[wi], str):
                    wi += 1
        api[str(n['id'])] = {'class_type': ct, 'inputs': inputs}
        title = (n.get('title') or '').lower()
        if ct in ('CLIPTextEncode', 'GemmaAPITextEncode', 'LTXVConditioning') and pos_node is None and 'negativ' not in title:
            pos_node = str(n['id'])
    # override the positive prompt + a fresh seed
    if prompt_text and pos_node and 'text' in api[pos_node]['inputs']:
        api[pos_node]['inputs']['text'] = prompt_text
    if seed is not None:
        for nid, nd in api.items():
            for k in ('seed', 'noise_seed'):
                if k in nd['inputs'] and isinstance(nd['inputs'][k], (int, float)):
                    nd['inputs'][k] = int(seed)
    return api

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workflow', required=True)
    ap.add_argument('--prompt', default=None)
    ap.add_argument('--base', default='http://127.0.0.1:8188')
    ap.add_argument('--timeout', type=int, default=600)
    a = ap.parse_args()
    wf = json.load(open(a.workflow, encoding='utf-8'))
    if all(k.isdigit() for k in list(wf.keys())[:3]) if wf else False:
        api = wf  # already API format
    else:
        oi = json.load(urllib.request.urlopen(a.base + '/object_info', timeout=30))
        api = api_from_ui(wf, oi, a.prompt, random.randint(1, 2**31))
    req = urllib.request.Request(a.base + '/prompt', data=json.dumps({'prompt': api}).encode(), headers={'Content-Type': 'application/json'})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=30)); pid = r['prompt_id']
    except urllib.error.HTTPError as e:
        sys.stderr.write('SUBMIT_ERROR ' + e.read().decode()[:600]); sys.exit(1)
    deadline = time.time() + a.timeout
    while time.time() < deadline:
        time.sleep(3)
        try:
            h = json.load(urllib.request.urlopen(a.base + '/history/' + pid, timeout=10))
        except Exception:
            continue
        if pid in h:
            entry = h[pid]; st = entry.get('status', {})
            if entry.get('outputs'):
                for nid, o in entry['outputs'].items():
                    for key in ('images', 'gifs', 'video', 'videos'):
                        if o.get(key):
                            im = o[key][0]
                            print('OK ' + a.base + '/view?filename=' + urllib.parse.quote(im['filename']) + '&subfolder=' + urllib.parse.quote(im.get('subfolder', '')) + '&type=' + im.get('type', 'output'))
                            return
            if st.get('status_str') == 'error':
                msg = '; '.join(str((m[1] or {}).get('exception_message', '')) for m in st.get('messages', []) if m and m[0] == 'execution_error')
                sys.stderr.write('WORKFLOW_ERROR ' + msg[:500]); sys.exit(1)
    sys.stderr.write('TIMEOUT'); sys.exit(1)

if __name__ == '__main__':
    import urllib.parse
    main()
