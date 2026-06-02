// audio.js
import { getVoiceForCharacter, CHARACTERS } from './characters.js';

// ---------------------------------------------------------------------------
// Kokoro TTS (dynamic import, safe fallback)
// ---------------------------------------------------------------------------
let kokoroTTS = null;
let kokoroLoadPromise = null;
let isLoading = false;
let kokoroAvailable = true;

async function loadKokoro() {
  if (kokoroTTS) return kokoroTTS;
  if (kokoroLoadPromise) return kokoroLoadPromise;
  if (!kokoroAvailable) throw new Error('Kokoro unavailable');

  isLoading = true;
  updateLoadingUI(true);

  kokoroLoadPromise = (async () => {
    try {
      const { KokoroTTS } = await import('kokoro-js');
      
      // Try ultra-fast WebGPU acceleration tier first
      try {
        console.log('🔄 Loading Kokoro TTS model via WebGPU (~80MB) …');
        kokoroTTS = await KokoroTTS.from_pretrained(
          'onnx-community/Kokoro-82M-v1.0-ONNX',
          { dtype: 'fp16', device: 'webgpu' }
        );
        console.log('✅ Kokoro initialized with WebGPU acceleration.');
      } catch (webgpuError) {
        console.warn('⚠️ WebGPU initialization failed, falling back to WASM CPU processing...', webgpuError.message);
        kokoroTTS = await KokoroTTS.from_pretrained(
          'onnx-community/Kokoro-82M-v1.0-ONNX',
          { dtype: 'q8', device: 'wasm' }
        );
        console.log('✅ Kokoro ready (WASM Mode)');
      }
      
      return kokoroTTS;
    } catch (err) {
      console.error('❌ Kokoro failed:', err);
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

// ---------- Speaking state ----------
let isSpeaking = false;
let speakingTimeout = null;

function setSpeaking(active) {
  isSpeaking = active;
  if (active) {
    clearTimeout(speakingTimeout);
    speakingTimeout = setTimeout(() => { isSpeaking = false; }, 15000);
  } else {
    clearTimeout(speakingTimeout);
  }
}

// Audio playback helpers
let currentAudioContext = null;
let currentSource = null;

function isFiniteAudio(float32Array) {
  if (!float32Array || float32Array.length === 0) return false;
  for (let i = 0; i < float32Array.length; i++) {
    if (!Number.isFinite(float32Array[i])) return false;
  }
  return true;
}

async function playAudioBuffer(float32Array, sampleRate) {
  if (!isFiniteAudio(float32Array)) {
    console.warn('⚠️ Kokoro produced non‑finite audio – discarding');
    throw new Error('Non‑finite audio data from Kokoro');
  }

  stopSpeaking();

  // Reuse hot AudioContext to eliminate generation lag between sentences
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
  console.log('🔊 Audio playing (Kokoro)');
}

export function stopSpeaking() {
  try {
    if (currentSource) { currentSource.stop(); currentSource = null; }
    // Suspend instead of killing context to allow instantaneous initialization next cycle
    if (currentAudioContext && currentAudioContext.state === 'running') {
      currentAudioContext.suspend();
    }
  } catch (e) { /* ignore */ }
  speechSynthesis.cancel();
  setSpeaking(false);
}

function getKokoroVoice(characterId) {
  const char = CHARACTERS[characterId];
  return char?.kokoroVoice || null;
}

// Public speak function – Kokoro first, then Web Speech API
export async function speak(text, characterId) {
  if (!text) return;

  console.log('🔈 speak() called with:', text.slice(0, 50));

  setSpeaking(true);

  if (kokoroAvailable) {
    try {
      await loadKokoro();
      if (kokoroTTS) {
        const voiceName = getKokoroVoice(characterId);
        if (voiceName) {
          const result = await kokoroTTS.generate(text, { voice: voiceName });
          
          // Debug telemetry block executed safely inside execution scope
          console.log("Kokoro Output Debug:", {
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
      console.warn('🎤 Kokoro TTS failed, using browser TTS:', err.message);
    }
  }

  // Fallback: browser Web Speech API
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
// AudioEngine with 3‑second silence timer and self‑reply guard
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

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      this.drawWaves();
      this.soundClassifyLoop();

      // Warm up and pre-load model into local background cache immediately at runtime startup
      loadKokoro().catch((e) => console.warn('Background Kokoro pre-load failed:', e.message));

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
              console.log('🎤 final transcript (after silence):', transcript);
              this.onUserSpeech(transcript);
              this.lastInterimTranscript = '';
            }
          }, this.SILENCE_DELAY);
        };

        this.recognition.onerror = (e) => {
          if (e.error !== 'no-speech') console.warn('Speech recog error:', e.error);
        };

        this.recognition.onend = () => { if (this.isRunning) this.recognition.start(); };
        this.recognition.start();
      }
      this.isRunning = true;
    } catch (err) {
      console.error('Mic access failed:', err);
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
      ctx.arc(width/2, height/2, width/2 - 2, 0, Math.PI * 2);
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
      // Loop Guard: exit immediately if context is halted or if the AI itself is speaking
      if (!this.isRunning || isSpeaking) return;

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      this.analyser.getByteFrequencyData(dataArray);

      let frequencyVolumeSum = 0;
      for (let i = 0; i < bufferLength; i++) {
        frequencyVolumeSum += dataArray[i];
      }
      const averageVolume = frequencyVolumeSum / bufferLength;

      // Filter disturbances by requiring persistent environmental energy (Threshold > 35) before random firing
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
