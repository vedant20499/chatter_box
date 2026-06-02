// audio.js
import { getVoiceForCharacter, CHARACTERS } from './characters.js';

// ---------------------------------------------------------------------------
// Engine State & Feature Flags
// ---------------------------------------------------------------------------
let kokoroTTS = null;
let kokoroLoadPromise = null;
let isLoading = false;
let kokoroAvailable = true;
let useWebGPU = true;               // <-- Allow WebGPU, fallback permanently to WASM on failure
let isSpeaking = false;
let speakingTimeout = null;
let currentAudioContext = null;
let currentSource = null;
let activeEngine = null;

async function checkWebGPUSupport() {
  if (!window.isSecureContext) return false;
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) { return false; }
}

async function loadKokoro() {
  if (kokoroTTS) return kokoroTTS;
  if (kokoroLoadPromise) return kokoroLoadPromise;
  if (!kokoroAvailable) throw new Error('Kokoro engine marked as unavailable.');

  isLoading = true;
  updateLoadingUI(true);

  kokoroLoadPromise = (async () => {
    try {
      const { KokoroTTS } = await import('kokoro-js');
      const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';

      if (useWebGPU && await checkWebGPUSupport()) {
        try {
          console.log('🔄 Attempting WebGPU pipeline initialization (FP32)...');
          kokoroTTS = await KokoroTTS.from_pretrained(modelId, {
            dtype: 'fp32',
            device: 'webgpu'
          });
          console.log('✅ Kokoro WebGPU ready');
          return kokoroTTS;
        } catch (gpuError) {
          console.warn('⚠️ WebGPU failed at compilation tier, falling back to WASM:', gpuError.message);
          useWebGPU = false; 
        }
      }

      // Safe cross-device fallback pipeline (8-bit quantized)
      console.log('📦 Loading 8‑bit quantized WASM pipeline (~88MB) …');
      kokoroTTS = await KokoroTTS.from_pretrained(modelId, {
        dtype: 'q8',
        device: 'wasm'
      });
      console.log('✅ Kokoro ready (WASM Mode)');
      return kokoroTTS;
    } catch (err) {
      console.error('❌ Critical failure initializing Kokoro:', err);
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

function isFiniteAudio(arr) {
  if (!arr || arr.length === 0) return false;
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

async function playAudioBuffer(float32Array, sampleRate) {
  if (!isFiniteAudio(float32Array)) {
    console.warn('⚠️ Non‑finite audio array produced – discarding generation frame.');
    throw new Error('Non‑finite audio array returned.');
  }
  
  stopSpeaking();
  
  if (!currentAudioContext || currentAudioContext.state === 'closed') {
    currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  const ctx = currentAudioContext;
  if (ctx.state === 'suspended') await ctx.resume();

  const safeRate = sampleRate && Number.isFinite(sampleRate) ? sampleRate : 24000;
  const buffer = ctx.createBuffer(1, float32Array.length, safeRate);
  buffer.getChannelData(0).set(float32Array);
  
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  
  source.onended = () => {
    setSpeaking(false);
    currentSource = null;
    // Safely re-engage microphone recording when playback settles
    if (activeEngine && activeEngine.isRunning && activeEngine.recognition) {
      try { activeEngine.recognition.start(); } catch (e) { /* Ignore active logs */ }
    }
  };
  
  setSpeaking(true);
  source.start(0);
  currentSource = source;
  console.log('🔊 Local context buffer emitting audio successfully.');
}

export function stopSpeaking() {
  try {
    if (currentSource) { currentSource.stop(); currentSource = null; }
    if (currentAudioContext && currentAudioContext.state === 'running') {
      currentAudioContext.suspend();
    }
  } catch (e) {}
  speechSynthesis.cancel();
  setSpeaking(false);
}

function getKokoroVoice(characterId) {
  return CHARACTERS[characterId]?.kokoroVoice || null;
}

function cleanTextForTTS(text) {
  return text
    .replace(/\*[^*]+\*/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function speak(rawText, characterId) {
  if (!rawText) return;
  const text = cleanTextForTTS(rawText);
  console.log('🔈 speak request initialized for:', text.slice(0, 50));
  setSpeaking(true);

  // Stop recognition to prevent the client from capturing its own speakers
  if (activeEngine && activeEngine.recognition) {
    try { activeEngine.recognition.stop(); } catch (e) {}
  }

  if (kokoroAvailable) {
    try {
      await loadKokoro();
      if (kokoroTTS) {
        const voiceName = getKokoroVoice(characterId);
        if (voiceName) {
          let result;
          try {
            result = await kokoroTTS.generate(text, { voice: voiceName });
          } catch (genError) {
            const errStr = genError.message || String(genError);
            // Catch structural or asynchronous WebGPU context crashes cleanly
            if (useWebGPU && (errStr.includes('Device') || errStr.includes('lost') || errStr.includes('mapAsync'))) {
              console.warn('🛑 WebGPU device lost or hung during runtime generation. Purging cache and defaulting to WASM.');
              
              useWebGPU = false;
              kokoroTTS = null;
              kokoroLoadPromise = null; // ✅ FIXED: Clear the broken promise allocation to allow fresh pipeline build
              
              await loadKokoro(); // Reinitializes model weights safely in WebAssembly execution context
              if (kokoroTTS) {
                result = await kokoroTTS.generate(text, { voice: voiceName });
              } else {
                throw genError;
              }
            } else {
              throw genError;
            }
          }

          const targetRate = result.sampling_rate || result.sample_rate || 24000;
          await playAudioBuffer(result.audio, targetRate);
          return;
        }
      }
    } catch (err) {
      console.warn('Kokoro execution context broke. Engaging native browser Speech API:', err.message);
    }
  }

  // OS Native Speech Synthesis fallback layers
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = getVoiceForCharacter(characterId);
  if (voice) utterance.voice = voice;
  const config = CHARACTERS[characterId]?.voiceConfig;
  if (config) {
    utterance.pitch = config.pitch || 1;
    utterance.rate = config.rate || 1;
  }
  utterance.onstart = () => setSpeaking(true);
  utterance.onend = () => {
    setSpeaking(false);
    if (activeEngine && activeEngine.isRunning && activeEngine.recognition) {
      try { activeEngine.recognition.start(); } catch (e) {}
    }
  };
  utterance.onerror = () => {
    setSpeaking(false);
    if (activeEngine && activeEngine.isRunning && activeEngine.recognition) {
      try { activeEngine.recognition.start(); } catch (e) {}
    }
  };
  speechSynthesis.speak(utterance);
}

// ---------------------------------------------------------------------------
// AudioEngine Base Infrastructure
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
    activeEngine = this;
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      currentAudioContext = this.audioCtx;
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      this.drawWaves();
      this.soundClassifyLoop();

      loadKokoro().catch(e => console.warn('Background preload caught:', e.message));

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
            if (isSpeaking) return;
            const transcript = this.lastInterimTranscript.trim();
            if (transcript && this.onUserSpeech) {
              console.log('🎤 final transcript (after silence):', transcript);
              this.onUserSpeech(transcript);
              this.lastInterimTranscript = '';
            }
          }, this.SILENCE_DELAY);
        };

        this.recognition.onerror = (e) => console.warn('Speech recog error:', e.error);
        
        // ✅ FIXED: Prevent loop that forced the microphone back on during active text generation
        this.recognition.onend = () => { 
          if (this.isRunning && !isSpeaking) {
            try { this.recognition.start(); } catch (e) {} 
          } 
        };
        
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

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
      const avg = sum / bufferLength;

      if (avg > 35 && Math.random() < 0.15 && !this.musicCooldown) {
        if (this.onUserSpeech) this.onUserSpeech('__MUSIC_DETECTED__');
        this.musicCooldown = true;
        setTimeout(() => { this.musicCooldown = false; }, 30000);
      }
    }, 5000);
  }

  speak(text, characterId) { speak(text, characterId); }

  stop() {
    this.isRunning = false;
    clearTimeout(this.silenceTimeout);
    if (this.recognition) this.recognition.stop();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.audioCtx && this.audioCtx.state !== 'closed') this.audioCtx.close();
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
  }
}
