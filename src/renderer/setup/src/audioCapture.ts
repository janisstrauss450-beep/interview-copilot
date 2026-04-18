export interface CaptureStats {
  dbfs: number;
  sampleRate: number;
  framesPerSec: number;
}

export type CaptureFrameHandler = (frame: Int16Array) => void;
export type CaptureStatsHandler = (stats: CaptureStats) => void;

const WORKLET_SOURCE = `
class PcmCapturer extends AudioWorkletProcessor {
  constructor() {
    super();
    this._emitEvery = Math.floor(sampleRate * 0.02);
    this._buf = new Float32Array(this._emitEvery);
    this._filled = 0;
    this._meterSum = 0;
    this._meterCount = 0;
    this._lastMeterEmit = currentTime;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = channel[i];
      this._buf[this._filled++] = s;
      this._meterSum += s * s;
      this._meterCount++;

      if (this._filled === this._emitEvery) {
        const pcm = new Int16Array(this._emitEvery);
        for (let j = 0; j < this._emitEvery; j++) {
          const x = Math.max(-1, Math.min(1, this._buf[j]));
          pcm[j] = x < 0 ? x * 0x8000 : x * 0x7fff;
        }
        this.port.postMessage({ type: 'pcm', pcm }, [pcm.buffer]);
        this._filled = 0;
      }
    }

    if (currentTime - this._lastMeterEmit >= 0.1 && this._meterCount > 0) {
      const rms = Math.sqrt(this._meterSum / this._meterCount);
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : -120;
      this.port.postMessage({ type: 'meter', dbfs });
      this._meterSum = 0;
      this._meterCount = 0;
      this._lastMeterEmit = currentTime;
    }

    return true;
  }
}
registerProcessor('pcm-capturer', PcmCapturer);
`;

export class AudioCapture {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletUrl: string | null = null;
  private running = false;
  private frameCount = 0;
  private lastStatsEmit = 0;

  constructor(
    private onFrame: CaptureFrameHandler,
    private onStats: CaptureStatsHandler,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get sampleRate(): number {
    return this.audioCtx?.sampleRate ?? 0;
  }

  async start(mode: 'loopback' | 'mic'): Promise<void> {
    if (this.running) return;

    let stream: MediaStream;
    if (mode === 'loopback') {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      stream.getVideoTracks().forEach((t) => t.stop());
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    }

    let audioCtx: AudioContext;
    try {
      audioCtx = new AudioContext({ sampleRate: 24000 });
    } catch {
      audioCtx = new AudioContext();
    }

    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(workletUrl);

    const source = audioCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioCtx, 'pcm-capturer');

    this.frameCount = 0;
    this.lastStatsEmit = performance.now();
    let lastDbfs = -120;

    node.port.onmessage = (e) => {
      const data = e.data;
      if (data?.type === 'pcm') {
        this.onFrame(data.pcm as Int16Array);
        this.frameCount++;
        const now = performance.now();
        if (now - this.lastStatsEmit >= 500) {
          const elapsed = (now - this.lastStatsEmit) / 1000;
          const framesPerSec = this.frameCount / elapsed;
          this.onStats({ dbfs: lastDbfs, sampleRate: audioCtx.sampleRate, framesPerSec });
          this.frameCount = 0;
          this.lastStatsEmit = now;
        }
      } else if (data?.type === 'meter') {
        lastDbfs = data.dbfs;
        this.onStats({ dbfs: data.dbfs, sampleRate: audioCtx.sampleRate, framesPerSec: 0 });
      }
    };

    source.connect(node);

    this.audioCtx = audioCtx;
    this.stream = stream;
    this.workletNode = node;
    this.source = source;
    this.workletUrl = workletUrl;
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    try {
      this.source?.disconnect();
      this.workletNode?.disconnect();
      this.workletNode?.port.close();
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.audioCtx?.close();
    } catch {
      // best-effort teardown
    } finally {
      if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
      this.audioCtx = null;
      this.stream = null;
      this.workletNode = null;
      this.source = null;
      this.workletUrl = null;
      this.running = false;
    }
  }
}

export function concatInt16(frames: Int16Array[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += f.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(new Uint8Array(f.buffer, f.byteOffset, f.byteLength), offset);
    offset += f.byteLength;
  }
  return out;
}
