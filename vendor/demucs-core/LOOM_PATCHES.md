# Source and license

demucs-core/src and Cargo.toml are copied unmodified from
https://github.com/nikhilunni/demucs-rs at commit
805d6f72ede20282832ac78c634e8767716c0b21 (Apache-2.0, see LICENSE).
The workspace excludes this vendor package from workspace test defaults.
The optimized worker uses only dsp/resample.rs from this source tree, included
as a standalone module. Neural inference runs in ONNX Runtime CPU, not Burn.

The original implementation used the 84 MB safetensors standard HTDemucs model
from set-soft/audio_separation revision 939723568b2dca203e61cc7294317ba38549964f.
It has been replaced by the standard HTDemucs ONNX export documented in
licenses/htdemucs-model.txt. The network, 7.8 s segment and 25% overlap are retained.
