import type { GameAudio } from "./GameAudio";
import { ProceduralScore, type ScoreTargets } from "./ProceduralScore";
import { RadioAudio, type RadioAudioFrame } from "./RadioAudio";

export type CueSound = "pickup" | "deliver" | "fail" | "lock" | "discover" | "radio" | "credit";

/**
 * Audio for After Hours, built on GameAudio's single context: the vehicle
 * radio, the procedural score, a restrained non-pitched ambient layer for
 * Altered Signal, numbers-station pips and a handful of short cues. Created
 * once when the context is unlocked and disposed with the game.
 */
export class AfterHoursAudio {
  readonly radio: RadioAudio;
  readonly score: ProceduralScore;
  private readonly ctx: AudioContext;
  private readonly sfx: GainNode;
  private readonly ambientSource: AudioBufferSourceNode | null;
  private readonly ambientFilter: BiquadFilterNode;
  private readonly ambientGain: GainNode;
  private ambientTarget = -1;

  constructor(private readonly audio: GameAudio) {
    const ctx = audio.context!;
    this.ctx = ctx;
    this.sfx = audio.sfxBus!;
    this.radio = new RadioAudio(ctx, audio.musicBus!, audio.noiseBuffer);
    this.score = new ProceduralScore(ctx, audio.scoreBus!, this.radio.signalIn, audio.noiseBuffer);

    // Ambient "breath": slow filtered noise, no pitch or rhythm, so it can
    // never clash with the album; it is only raised when the album is not
    // audible and clean audio is off.
    this.ambientFilter = ctx.createBiquadFilter();
    this.ambientFilter.type = "bandpass";
    this.ambientFilter.frequency.value = 380;
    this.ambientFilter.Q.value = 0.9;
    this.ambientGain = ctx.createGain();
    this.ambientGain.gain.value = 0;
    this.ambientFilter.connect(this.ambientGain);
    this.ambientGain.connect(this.sfx);
    const noise = audio.noiseBuffer;
    if (noise) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.connect(this.ambientFilter);
      src.start(0, Math.random() * 1.5);
      this.ambientSource = src;
    } else {
      this.ambientSource = null;
    }
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  update(
    radio: RadioAudioFrame,
    score: ScoreTargets,
    scoreActive: boolean,
    ambient: number,
    time: number,
  ): void {
    this.radio.update(radio);
    if (scoreActive) {
      if (!this.score.running) this.score.start();
      else if (this.score.stopping) this.score.cancelStop();
    } else if (this.score.running) {
      this.score.stop();
    }
    this.score.update(score);
    this.score.sweep();
    // A very slow swell (period ~11 s) on the ambient layer.
    const raw = ambient > 0 ? ambient * (0.02 + 0.012 * Math.sin((time * Math.PI * 2) / 11)) : 0;
    // Quantised so the parameter is only re-targeted a few times a second.
    const level = Math.round(raw * 2000) / 2000;
    if (level !== this.ambientTarget) {
      this.ambientTarget = level;
      this.ambientGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.8);
      this.ambientFilter.frequency.setTargetAtTime(
        320 + 160 * Math.sin(time * 0.21),
        this.ctx.currentTime,
        1.5,
      );
    }
  }

  setSuspended(suspended: boolean): void {
    this.radio.setSuspended(suspended);
  }

  private tone(
    freq: number,
    at: number,
    length: number,
    peak: number,
    dest: AudioNode,
    type: OscillatorType = "sine",
  ): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.01);
    g.gain.setValueAtTime(peak, at + Math.max(0.01, length - 0.04));
    g.gain.exponentialRampToValueAtTime(0.0001, at + length + 0.05);
    osc.connect(g).connect(dest);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
    osc.start(at);
    osc.stop(at + length + 0.08);
  }

  /** Numbers-station voice: pips for a digit, a long tone for zero, a chirp for words. */
  numbers(pips: number | null): void {
    const t = this.ctx.currentTime + 0.02;
    const dest = this.radio.numbersIn;
    if (pips === null) {
      this.tone(760, t, 0.08, 0.22, dest);
      this.tone(1140, t + 0.1, 0.08, 0.22, dest);
    } else if (pips === 0) {
      this.tone(620, t, 0.55, 0.22, dest);
    } else {
      for (let i = 0; i < pips; i++) this.tone(1000, t + i * 0.17, 0.07, 0.24, dest);
    }
  }

  cue(kind: CueSound): void {
    const t = this.ctx.currentTime + 0.01;
    const d = this.sfx;
    switch (kind) {
      case "pickup":
        this.tone(660, t, 0.09, 0.06, d);
        this.tone(880, t + 0.09, 0.14, 0.06, d);
        break;
      case "deliver":
        this.tone(587, t, 0.1, 0.06, d);
        this.tone(740, t + 0.11, 0.1, 0.06, d);
        this.tone(880, t + 0.22, 0.22, 0.06, d);
        break;
      case "fail":
        this.tone(330, t, 0.16, 0.06, d, "triangle");
        this.tone(262, t + 0.18, 0.3, 0.06, d, "triangle");
        break;
      case "lock":
        this.tone(1320, t, 0.28, 0.05, d);
        this.tone(1760, t + 0.05, 0.4, 0.035, d);
        break;
      case "discover":
        for (let i = 0; i < 4; i++)
          this.tone(880 * Math.pow(1.5, i % 2) * (1 + i * 0.05), t + i * 0.12, 0.3, 0.035, d);
        break;
      case "radio":
        this.radio.squelch();
        break;
      case "credit":
        break;
    }
  }

  dispose(): void {
    this.radio.dispose();
    this.score.dispose();
    try {
      this.ambientSource?.stop();
    } catch {
      // Already stopped.
    }
    this.ambientSource?.disconnect();
    this.ambientFilter.disconnect();
    this.ambientGain.disconnect();
  }
}
