# Packaged Whisper model

`64da57285918e20ea79ea5c88eed7197933abaa8` is the pinned `Xenova/whisper-base`
revision used by Cukii's offline voice input. The build copies these assets into
`out/models/whisper-base`; runtime integrity is checked against the SHA-256
manifest in `voiceDictation.ts` before the local pipeline is initialized.

The upstream model is published under the MIT license:
https://huggingface.co/Xenova/whisper-base
