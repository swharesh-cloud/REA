import {
  downsample,
  encodeWav,
  rootMeanSquare,
  TARGET_SAMPLE_RATE,
} from "./wav";

export type CapturedChunk = {
  blob: Blob;
  startMs: number;
  durationMs: number;
  silent: boolean;
};

const SILENCE_RMS = 0.004;

export class PcmRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterFrame = 0;
  private wakeLock: WakeLockSentinel | null = null;
  private elapsedBefore = 0;
  private runningSince = 0;
  private capturedMs = 0;
  private paused = true;
  private stopped = false;
  private flushWait: (() => void) | null = null;
  onchunk: ((chunk: CapturedChunk) => void) | null = null;
  onlevel: ((level: number) => void) | null = null;
  oninterrupt: (() => void) | null = null;

  elapsedMs() {
    if (this.paused || this.runningSince === 0) return this.elapsedBefore;
    return this.elapsedBefore + (performance.now() - this.runningSince);
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "This browser cannot use the microphone. Open the app over HTTPS.",
      );
    }
    if (!window.AudioContext) {
      throw new Error(
        "This browser cannot capture lecture audio. Use current Safari, Chrome, or Firefox, or upload a file.",
      );
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        throw new Error(
          "Microphone permission was blocked. Allow the mic for this site and try again.",
        );
      }
      if (error instanceof DOMException && error.name === "NotFoundError") {
        throw new Error("No microphone was found on this device.");
      }
      throw error;
    }
    const context = new AudioContext();
    if (!context.audioWorklet) {
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      throw new Error(
        "This browser cannot capture lecture audio. Use current Safari, Chrome, or Firefox, or upload a file.",
      );
    }
    await context.resume();
    await context.audioWorklet.addModule("/pcm-capture-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "pcm-capture");
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(worklet);
    source.connect(analyser);
    worklet.connect(silent);
    silent.connect(context.destination);
    worklet.port.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
    this.context = context;
    this.stream = stream;
    this.worklet = worklet;
    this.analyser = analyser;
    this.stopped = false;
    this.paused = false;
    this.elapsedBefore = 0;
    this.capturedMs = 0;
    this.runningSince = performance.now();
    context.onstatechange = () => {
      if (
        (context.state as string) === "interrupted" &&
        !this.paused &&
        !this.stopped
      ) {
        this.oninterrupt?.();
      }
    };
    document.addEventListener("visibilitychange", this.onVisible);
    await this.acquireWakeLock();
    this.pumpLevel();
  }

  pause() {
    if (this.paused || this.stopped) return;
    this.elapsedBefore = this.elapsedMs();
    this.runningSince = 0;
    this.paused = true;
    this.worklet?.port.postMessage({ type: "pause" });
    this.onlevel?.(0);
  }

  async resume() {
    if (!this.paused || this.stopped || !this.context) return;
    if (this.context.state !== "running") await this.context.resume();
    this.paused = false;
    this.runningSince = performance.now();
    this.worklet?.port.postMessage({ type: "resume" });
    await this.acquireWakeLock();
    this.pumpLevel();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.paused) {
      this.elapsedBefore = this.elapsedMs();
      this.paused = true;
    }
    await this.flushAndWait();
    this.teardown();
  }

  private handleMessage(data: unknown) {
    if (!data || typeof data !== "object") return;
    const message = data as {
      type?: string;
      samples?: Float32Array;
      sampleRate?: number;
    };
    if (message.type === "flushed") {
      this.flushWait?.();
      this.flushWait = null;
      return;
    }
    if (message.type !== "chunk" || !message.samples || !message.sampleRate)
      return;
    const samples = downsample(
      message.samples,
      message.sampleRate,
      TARGET_SAMPLE_RATE,
    );
    const durationMs = Math.round(
      (message.samples.length / message.sampleRate) * 1000,
    );
    const startMs = this.capturedMs;
    this.capturedMs += durationMs;
    this.onchunk?.({
      blob: encodeWav(samples, TARGET_SAMPLE_RATE),
      startMs,
      durationMs,
      silent: rootMeanSquare(samples) < SILENCE_RMS,
    });
  }

  private flushAndWait() {
    if (!this.worklet) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => {
        this.flushWait = null;
        resolve();
      }, 1500);
      this.flushWait = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      this.worklet?.port.postMessage({ type: "flush" });
    });
  }

  private pumpLevel = () => {
    if (!this.analyser || this.paused || this.stopped) return;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    this.onlevel?.(Math.min(1, Math.sqrt(sum / data.length) * 3));
    this.meterFrame = window.requestAnimationFrame(this.pumpLevel);
  };

  private onVisible = () => {
    if (document.visibilityState !== "visible" || this.paused || this.stopped)
      return;
    void this.acquireWakeLock();
    if (this.context && this.context.state === "suspended") {
      void this.context.resume();
    }
  };

  private async acquireWakeLock() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.wakeLock = null;
    }
  }

  private teardown() {
    document.removeEventListener("visibilitychange", this.onVisible);
    window.cancelAnimationFrame(this.meterFrame);
    this.worklet?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    void this.wakeLock?.release();
    this.context = null;
    this.stream = null;
    this.worklet = null;
    this.analyser = null;
    this.wakeLock = null;
    this.onlevel?.(0);
  }
}
