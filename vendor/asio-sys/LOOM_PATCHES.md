# Local ASIO build fixes

Based on RustAudio `asio-sys` 0.4.0 (Apache-2.0, see LICENSE).

- Bind the C interface, omitting unused C++ manager classes whose inherited tail padding
  cannot be represented by Rust's `repr(C)` on MinGW.
- Expose `ASIOControlPanel` through bindgen so its C++ symbol uses the correct ABI.
- Expose input names and channel groups through the driver's existing `ASIOGetChannelInfo` API.
- Zero-initialize `ASIODriverInfo`, including the optional window reference.
- Compile the three host translation units and link the C++ standard library statically.

The Steinberg SDK itself is a build dependency outside the repository, selected by
`CPAL_ASIO_DIR`. It is not needed beside the packaged executable.
