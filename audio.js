// audio.js
import { getVoiceForCharacter, CHARACTERS } from './characters.js';

// ---------------------------------------------------------------------------
// Engine State & Feature Flags
// ---------------------------------------------------------------------------
let kokoroTTS = null;
let kokoroLoadPromise = null;
let isLoading = false;
let kokoroAvailable = true;
let isSpeaking = false;
let speakingTimeout = null;
let currentAudioContext = null;
let currentSource = null;

/**
 * Validates system capabilities before allocating expensive model memory.
 * Ensures your public link handles Chrome's strict security policies.
 */
async function checkWebGPUSupport() {
  if (!window.isSecureContext) {
    console.warn("⚠️ App is running in an insecure context. Chrome disables WebGPU on non-HTTPS links.");
    return false;
  }
  if (!navigator.gpu) {
    console.log("ℹ️ WebGPU is not natively exposed or supported on this browser engine.");
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) {
    return false;
  }
}

/**
 * Progressively loads the Text-to-Speech model.
 * Fallbacks seamlessly from FP32 WebGPU to 8-bit quantized WASM.
 */
async function loadKokoro() {
  if (kokoroTTS) return kokoroTTS;
  if (kokoroLoadPromise) return kokoroLoadPromise;
  if (!kokoroAvailable) throw new Error('Kokoro engine marked as unavailable.');

  isLoading = true;
  updateLoadingUI(true);

  kokoroLoadPromise = (async () => {
    try {
      const { KokoroTTS } = await import('kokoro-js');
      const hasWebGPU = await checkWebGPUSupport();
      const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';

      if (hasWebGPU) {
        try {
          console.log('🔄 WebGPU Verified. Allocating FP32 Accelerated Pipeline (~326MB)...');
          kokoroTTS = await KokoroTTS.from_pretrained(modelId, { 
            dtype: 'fp32', 
            device: 'webgpu' 
          });
          console.log('✅ Kokoro initialized successfully with WebGPU hardware acceleration.');
          return kokoroTTS;
        } catch (gpuError) {
          console.warn('⚠️ WebGPU compilation failed. Dropping back to WebAssembly context...', gpuError.message);
        }
      }

      // Public distribution fallback: Runs smoothly on 90%+ of systems (Mobile, older browsers)
      console.log('📦 Allocating Optimized 8-bit Quantized WASM Pipeline (~88MB)...');
      kokoroTTS = await KokoroTTS.from_pretrained(modelId, { 
        dtype: 'q8', 
        device: 'wasm' 
      });
      console.log('✅ Kokoro fallback ready (WASM Mode)');
      return kokoroTTS;

    } catch (err) {
      console.error('❌ Kokoro initialization pipeline collapsed:', err);
      kokoroAvailable = false;
      kokoroTTS = null;
      throw err;
    } finally {
      isLoading = false;
      updateLoadingUI(false);
    }
  })();

  return kokoroLoadPromise;
}

function updateLoadingUI(show) {
  const face = document.getElementById('face-circle');
  if (!face) return;
  if (show) {
    face.dataset.prevText = face.textContent;
    face.textContent = '⏳';
  } else {
    face.textContent = face.dataset.prevText || '😊';
    delete face.dataset.prevText;
  }
}

function setSpeaking(active) {
  isSpeaking = active;
  if (active) {
    clearTimeout(speakingTimeout);
    speakingTimeout = setTimeout(() => { isSpeaking = false; }, 15000);
  } else {
    clearTimeout(speakingTimeout);
  }
}

function isFiniteAudio(float32Array) {
  if (!float32Array || float32Array.length === 0) return false;
  for (let i = 0; i < float32Array.length; i++) {
    if (!Number.isFinite(float32Array[i])) return false;
  }
  return true;
}

/**
 * Handles raw float processing and passes it to the system audio node.
 */
async function playAudioBuffer(float32Array, sampleRate) {
  if (!isFiniteAudio(float32Array)) {
    console.warn('⚠️ Audio buffer contains corrupt or non-finite sequences. Dropping generation slice.');
    throw new Error('Non‑finite audio array data passed from generator.');
  }

  stopSpeaking();

  // Reuse running context to mitigate instantiation overheads
  if (!currentAudioContext || currentAudioContext.state === 'closed') {
    currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  const ctx = currentAudioContext;

  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const safeSampleRate = sampleRate && Number.isFinite(sampleRate) ? sampleRate : 24000;
  const audioBuffer = ctx.createBuffer(1, float32Array.length, safeSampleRate);
  audioBuffer.getChannelData(0).set(float32Array);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);

  source.onended = () => {
    setSpeaking(false);
    currentSource = null;
  };

  setSpeaking(true);
  source.start(0);
  currentSource = source;
  console.log('🔊 Local playback pipeline emitting stream successfully.');
}

export function stopSpeaking() {
  try {
    if (currentSource) { 
      currentSource.stop(); 
      currentSource = null; 
    }
    if (currentAudioContext && currentAudioContext.state === 'running') {
      currentAudioContext.suspend();
    }
  } catch (e) { /* Catch silent errors from uninitialized streams */ }
  speechSynthesis.cancel();
  setSpeaking(false);
}

function getKokoroVoice(characterId) {
  const char = CHARACTERS[characterId];
  return char?.kokoroVoice || null;
}

/**
 * Primary text rendering loop. Automatically tests for Kokoro viability
 * before gracefully backing off to native Web Speech APIs.
 */
export async function speak(text, characterId) {
  if (!text) return;
  console.log('🔈 Synthesis requested for chunk:', text.slice(0, 50));
  setSpeaking(true);

  if (kokoroAvailable) {
    try {
      await loadKokoro();
      if (kokoroTTS) {
        const voiceName = getKokoroVoice(characterId);
        if (voiceName) {
          const result = await kokoroTTS.generate(text, { voice: voiceName });
          
          // Debug telemetry output matrix
          console.log("Kokoro Output Telemetry:", {
            isAudioValid: !!result.audio,
            audioLength: result.audio ? result.audio.length : 'N/A',
            sampleRate: result.sampleRate,
            sampling_rate: result.sampling_rate
          });

          const targetSampleRate = result.sampling_rate || result.sample_rate || 24000;
          await playAudioBuffer(result.audio, targetSampleRate);
          return;
        }
      }
    } catch (err) {
      console.warn('🎤 Premium synthesis layer glitched. Engaging native OS voices:', err.message);
    }
  }

  // Final cross-platform fallback logic: Local OS Speech Engine
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = getVoiceForCharacter(characterId);
  if (voice) utterance.voice = voice;

  const voiceConfig = CHARACTERS[characterId]?.voiceConfig;
  if (voiceConfig) {
    utterance.pitch = voiceConfig.pitch || 1;
    utterance.rate = voiceConfig.rate || 1;
  }

  utterance.onstart = () => setSpeaking(true);
  utterance.onend = () => setSpeaking(false);
  utterance.onerror = () => setSpeaking(false);

  speechSynthesis.speak(utterance);
}

// ---------------------------------------------------------------------------
// AudioEngine Infrastructure 
// ---------------------------------------------------------------------------
export class AudioEngine {
  constructor(state, onUserSpeech) {
    this.state = state;
    this.onUserSpeech = onUserSpeech;
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.recognition = null;
    this.isRunning = false;
    this.musicCooldown = false;
    this.animationFrame = null;
    this.silenceTimeout = null;
    this.lastInterimTranscript = '';
    this.SILENCE_DELAY = 3000;
  }

  /**
   * Must be called explicitly from an interactive screen boundary (e.g., "Start Chat" button)
   * to resolve Chrome's Autoplay Interaction Gate policies on public links.
   */
  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      
      // Mirror the context to the playback pipeline to satisfy Chrome user-gesture locks
      currentAudioContext = this.audioCtx;

      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      this.drawWaves();
      this.soundClassifyLoop();

      // Silently pre-fetch model weights into the client cache on initialization
      loadKokoro().catch((e) => console.warn('Background caching stream handled:', e.message));

      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';

        this.recognition.onresult = (event) => {
          clearTimeout(this.silenceTimeout);
          if (isSpeaking) { 
            this.lastInterimTranscript = ''; 
            return; 
          }

          let interim = '', final = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const t = event.results[i][0].transcript;
            if (event.results[i].isFinal) final += t;
            else interim += t;
          }
          if (final) this.lastInterimTranscript = final;
          if (interim) this.lastInterimTranscript = final + interim;

          this.silenceTimeout = setTimeout(() => {
            if (isSpeaking) { 
              this.lastInterimTranscript = ''; 
              return; 
            }
            const transcript = this.lastInterimTranscript.trim();
            if (transcript && this.onUserSpeech) {
              this.onUserSpeech(transcript);
              this.lastInterimTranscript = '';
            }
          }, this.SILENCE_DELAY);
        };

        this.recognition.onend = () => { 
          if (this.isRunning) this.recognition.start(); 
        };
        this.recognition.start();
      }
      this.isRunning = true;
    } catch (err) {
      console.error('Critical Failure: Microphone configuration rejected by system policies:', err);
    }
  }

  drawWaves() {
    const canvas = document.getElementById('wave-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width, height = canvas.height;
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!this.isRunning) return;
      this.animationFrame = requestAnimationFrame(draw);
      this.analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, width, height);

      ctx.beginPath();
      ctx.arc(width / 2, height / 2, Math.max(1, width / 2 - 2), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 188, 212, 0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#00bcd4';
      const sliceWidth = width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineTo(width, height / 2);
      ctx.stroke();
    };
    draw();
  }

  soundClassifyLoop() {
    setInterval(() => {
      if (!this.isRunning || isSpeaking) return;
      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      this.analyser.getByteFrequencyData(dataArray);

      let frequencyVolumeSum = 0;
      for (let i = 0; i < bufferLength; i++) { 
        frequencyVolumeSum += dataArray[i]; 
      }
      const averageVolume = frequencyVolumeSum / bufferLength;

      if (averageVolume > 35 && Math.random() < 0.15 && !this.musicCooldown) {
        if (this.onUserSpeech) this.onUserSpeech('__MUSIC_DETECTED__');
        this.musicCooldown = true;
        setTimeout(() => { this.musicCooldown = false; }, 30000);
      }
    }, 5000);
  }

  speak(text, characterId) { 
    speak(text, characterId); 
  }

  stop() {
    this.isRunning = false;
    clearTimeout(this.silenceTimeout);
    if (this.recognition) this.recognition.stop();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.audioCtx && this.audioCtx.state !== 'closed') this.audioCtx.close();
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
  }
}
