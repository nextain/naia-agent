# 4060 8GB Ollama placement handoff

Status: handoff, 2026-07-20.

The shell may set `ollamaNumGpu: 0` for the 4060 8GB profile. The agent parses
that setting and forwards it to Ollama as `options.num_gpu: 0`, including zero.
This keeps DNA3 (`dna3:latest`) off the 4060 so the bundled VoxCPM2 and Ditto
services retain the VRAM budget. It is CPU placement; actual AMD NPU execution
depends on the installed Ollama/runtime support and is not claimed by this
change.

Verification: the Ollama provider and settings-store contract suites passed
(61 tests), and `pnpm exec tsc --noEmit` passed.
