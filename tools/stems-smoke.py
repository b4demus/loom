"""Exercise the real CPU model without a GUI or microphone. Uses a synthetic test mix."""
import argparse
import array
import json
import math
from pathlib import Path
import random
import struct
import subprocess
import tempfile
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument('--worker', required=True)
parser.add_argument('--cache', required=True)
parser.add_argument('--verify-existing', help='Verify the output of an earlier run without repeating inference')
parser.add_argument('--seconds', type=float, default=1)
parser.add_argument('--rate', type=int, default=22050)
args = parser.parse_args()
folder = Path(args.verify_existing) if args.verify_existing else Path(tempfile.mkdtemp(prefix='loom-stems-smoke-'))
sr = args.rate
frames = round(sr * args.seconds)
rng = random.Random(42)
data = array.array('h')
for i in range(frames):
    t = i / sr
    kick = math.sin(2 * math.pi * (55 * t + 0.7 * math.sin(2 * math.pi * 2 * t))) * math.exp(-(t % 0.5) * 25)
    bass = 0.2 * math.sin(2 * math.pi * 110 * t)
    hat = (rng.random() - 0.5) * 0.12 * math.exp(-(t % 0.125) * 65)
    lead = 0.12 * math.sin(2 * math.pi * 440 * t)
    for pan in [0.8, 1.0]:
        data.append(int(max(-0.99, min(0.99, bass + kick * 0.3 + hat + lead * pan)) * 32767))
source = folder / 'input.wav'
if not args.verify_existing:
    with wave.open(str(source), 'wb') as wav:
        wav.setparams((2, 2, sr, 0, 'NONE', 'not compressed'))
        wav.writeframes(data.tobytes())
request = folder / 'request.json'
request.write_text(json.dumps(dict(input=str(source), output=str(folder), cache=str(Path(args.cache).resolve()), stems=['vocals', 'drums', 'bass', 'other'])), encoding='utf8')
started = time.monotonic()
result = None if args.verify_existing else subprocess.run([args.worker, str(request)], stdout=folder.joinpath('progress.log').open('w'), stderr=folder.joinpath('error.log').open('w'), timeout=1200, env=__import__('os').environ | {'RAYON_NUM_THREADS': '4'})
if result and result.returncode:
    raise RuntimeError(folder.joinpath('error.log').read_text(errors='replace'))
report = {}
decoded = {}
for name in ['vocals', 'drums', 'bass', 'other']:
    raw = folder.joinpath(name + '.wav').read_bytes()
    pos, audio, fmt = 12, None, None
    while pos + 8 <= len(raw):
        kind, size = struct.unpack_from('<4sI', raw, pos)
        block = raw[pos + 8:pos + 8 + size]
        if kind == b'fmt ':
            fmt = struct.unpack_from('<HHIIHH', block)
            if fmt[0] == 65534 and len(block) >= 40:
                fmt = (struct.unpack_from('<H', block, 24)[0], *fmt[1:])
        if kind == b'data': audio = array.array('f', block)
        pos += 8 + size + (size % 2)
    assert fmt and fmt[0] == 3 and fmt[1] == 2 and fmt[2] == sr, (name, fmt)
    assert audio is not None and len(audio) == frames * 2
    assert all(math.isfinite(v) for v in audio)
    rms = math.sqrt(sum(v * v for v in audio) / len(audio))
    assert rms > 1e-8, (name, 'empty stem')
    report[name] = dict(frames=frames, sample_rate=sr, rms=round(rms, 6))
    decoded[name] = audio
# The test mix contains bass, percussion and a lead, but no voice. Catch a fake
# separator that merely duplicates the input into four otherwise-valid WAV files.
assert report['bass']['rms'] > report['vocals']['rms'] * 10
assert report['drums']['rms'] > report['vocals']['rms'] * 5
rmse = math.sqrt(sum((sum(values) - sample / 32768.0) ** 2 for values, sample in zip(zip(*decoded.values()), data)) / len(data))
input_rms = math.sqrt(sum((v / 32768.0) ** 2 for v in data) / len(data))
assert rmse < input_rms * 0.3, ('stem sum does not approximate the mixture', rmse, input_rms)
elapsed = max(folder.joinpath(n + '.wav').stat().st_mtime for n in report) - source.stat().st_mtime if args.verify_existing else time.monotonic() - started
print(json.dumps(dict(folder=str(folder), elapsed_seconds=round(elapsed, 2), reconstruction_rmse=round(rmse, 6), stems=report), indent=2))
