const TARGET_RATE = 24_000;
const CHUNK_SAMPLES = 2_400;

class PcmEncoder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.port.onmessage = ({ data }) => {
      if (data?.type === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  flush() {
    if (this.pending.length === 0) return;

    const pcm = this.toPcm(this.pending);
    this.pending = [];
    this.port.postMessage({ type: "pcm", data: pcm.buffer }, [pcm.buffer]);
  }

  toPcm(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return pcm;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (output) output.fill(0);
    if (!input) return true;

    const step = sampleRate / TARGET_RATE;
    for (let position = 0; position < input.length; position += step) {
      const left = Math.floor(position);
      const right = Math.min(left + 1, input.length - 1);
      const fraction = position - left;
      this.pending.push(input[left] + (input[right] - input[left]) * fraction);
    }

    while (this.pending.length >= CHUNK_SAMPLES) {
      const chunk = this.pending.splice(0, CHUNK_SAMPLES);
      const pcm = this.toPcm(chunk);
      this.port.postMessage({ type: "pcm", data: pcm.buffer }, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-encoder", PcmEncoder);
