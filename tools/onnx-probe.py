"""Development-only CPU runtime probe; no GUI, microphone or upload."""
import sys
import time
import wave
import numpy as np
sys.path.insert(0, sys.argv[1])
import onnxruntime as ort

with wave.open(sys.argv[3], 'rb') as wav:
    sr = wav.getframerate()
    source = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').reshape(-1, 2).T.astype('float32') / 32768
audio = np.zeros((1, 2, 343980), dtype='float32')
for c in range(2):
    resampled = np.interp(np.arange(round(source.shape[1] * 44100 / sr)) * sr / 44100, np.arange(source.shape[1]), source[c])
    audio[0, c, :len(resampled)] = resampled
options = ort.SessionOptions()
options.intra_op_num_threads = 4
options.inter_op_num_threads = 1
options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
t = time.perf_counter()
session = ort.InferenceSession(sys.argv[2], options, providers=['CPUExecutionProvider'])
loaded = time.perf_counter()
output = session.run(['stems'], {'mix': audio})[0]
print({'load_seconds': round(loaded-t, 3), 'inference_seconds': round(time.perf_counter()-loaded, 3), 'shape': output.shape,
       'finite': bool(np.isfinite(output).all()), 'rms': [round(float(np.sqrt((s[:, :44100] ** 2).mean())), 6) for s in output[0]]})
