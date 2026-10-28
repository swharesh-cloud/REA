class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.count = 0;
    this.paused = false;
    this.port.onmessage = (event) => {
      const type = event.data && event.data.type;
      if (type === "pause") {
        this.paused = true;
        this.emit();
      } else if (type === "resume") {
        this.paused = false;
      } else if (type === "flush") {
        this.emit();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  emit() {
    if (!this.count) return;
    const samples = new Float32Array(this.count);
    let offset = 0;
    for (let index = 0; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.count = 0;
    this.port.postMessage({ type: "chunk", sampleRate, samples }, [
      samples.buffer,
    ]);
  }

  process(inputs) {
    if (this.paused) return true;
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    const copy = new Float32Array(channel.length);
    copy.set(channel);
    this.chunks.push(copy);
    this.count += copy.length;
    if (this.count >= sampleRate * 20) this.emit();
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
