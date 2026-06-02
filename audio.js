// audio.js
import { getVoiceForCharacter, CHARACTERS } from './characters.js';

// ---------------------------------------------------------------------------
// Engine State & Feature Flags
// ---------------------------------------------------------------------------
let kokoroTTS = null;
let kokoroLoadPromise = null;
let isLoading = false;
let kokoroAvailable = true;
let useWebGPU = true;               // allow WebGPU, disable after first GPU crash
let isSpeaking = false;             // true while bot is speaking
let speakingTimeout = null;
let currentAudioContext = null;
let currentSource = null;
let activeEngine = null;
let currentBotAnalyser = null;

// Global flag that app.js can check
export let isBotSpeaking = false;

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
  if (!kokoroAvailable) throw new Error('Kokoro unavailable');

  isLoading = true;
  updateLoadingUI(true);

  kokoroLoadPromise = (async () => {
    try {
      const { KokoroTTS } = await import('kokoro-js');
      const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';

      if (useWebGPU && await checkWebGPUSupport()) {
        try {
          console.log('🔄 Attempting WebGPU pipeline...');
          kokoroTTS = await KokoroTTS.from_pretrained(modelId, {
            dtype: 'fp32',
            device: 'webgpu'
          });
          console.log('✅ Kokoro WebGPU ready');
          return kokoroTTS;
        } catch (gpuError) {
          console.warn('⚠️ WebGPU failed, falling back to WASM:', gpuError.message);
          useWebGPU = false;   // permanently switch to WASM
        }
      }

      console.log('📦 Loading 8‑bit quantized WASM pipeline (~88MB) …');
      kokoroTTS = await KokoroTTS.from_pretrained(modelId, {
        dtype: 'q8',
        device: 'wasm'
      });
      console.log('✅ Kokoro ready (WASM)');
      return kokoroTTS;
    } catch (err) {
      console.error('❌ Kokoro initialization failed:', err);
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
  isBotSpeaking = active;          // update global flag
  if (active) {
    clearTimeout(speakingTimeout);
    speakingTimeout = setTimeout(() => {
      isSpeaking = false;
      isBotSpeaking = false;
    }, 15000);
  } else {
    clearTimeout(speakingTimeout);
    isBotSpeaking = false;
  }
}

function isFiniteAudio(arr) {
  if (!arr || arr.length === 0) return false;
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

async function playAudioBuffer(float32Array, sampleRate) {
  if (!isFiniteAudio(float32Array)) {
    console.warn('⚠️ Non‑finite audio – discarding');
    throw new Error('Non‑finite audio');
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
  
  // Set up bot analyser
  currentBotAnalyser = ctx.createAnalyser();
  currentBotAnalyser.fftSize = 256;
  source.connect(currentBotAnalyser);
  currentBotAnalyser.connect(ctx.destination);

  source.onended = () => {
    setSpeaking(false);
    currentSource = null;
    currentBotAnalyser = null;
    if (activeEngine && activeEngine.isRunning && activeEngine.recognition) {
      try { activeEngine.recognition.start(); } catch (e) {}
    }
    // Notify app that the bot finished speaking
    window.dispatchEvent(new Event('botFinishedSpeaking'));
  };
  setSpeaking(true);
  source.start(0);
  currentSource = source;
  console.log('🔊 Audio playing');
}

export function stopSpeaking() {
  try {
    if (currentSource) { currentSource.stop(); currentSource = null; }
    if (currentAudioContext && currentAudioContext.state === 'running') {
      currentAudioContext.suspend();
    }
  } catch (e) {}
  currentBotAnalyser = null;
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
  console.log('🔈 speak:', text.slice(0, 50));
  setSpeaking(true);

  // Mute microphone during speech
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
            if (useWebGPU && genError.message?.includes('Device')) {
              console.warn('🛑 WebGPU device lost, falling back to WASM');
              useWebGPU = false;
              kokoroTTS = null;
              await loadKokoro();
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
      console.warn('Kokoro failed, using browser TTS:', err.message);
    }
  }

  // Fallback: browser Web Speech API
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
    window.dispatchEvent(new Event('botFinishedSpeaking'));
  };
  utterance.onerror = () => {
    setSpeaking(false);
    if (activeEngine && activeEngine.isRunning && activeEngine.recognition) {
      try { activeEngine.recognition.start(); } catch (e) {}
    }
    window.dispatchEvent(new Event('botFinishedSpeaking'));
  };
  speechSynthesis.speak(utterance);
}

// ---------------------------------------------------------------------------
// AudioEngine with 3‑second silence timer, mute/unmute, and self‑reply guard
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
      this.isRunning = true;
      this.drawWaves();
      this.soundClassifyLoop();

      loadKokoro().catch(e => console.warn('Background Kokoro load:', e.message));

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

          // Hide bot callout as soon as user starts speaking
          const botCallout = document.getElementById('bot-callout');
          if (botCallout) {
            botCallout.classList.remove('visible');
            setTimeout(() => botCallout.classList.add('hidden'), 300);
          }

          // Show and update user callout at the bottom
          const userCallout = document.getElementById('user-callout');
          if (userCallout && this.lastInterimTranscript.trim()) {
            userCallout.innerHTML = `<span class="hearing-indicator">🎤</span> "${this.lastInterimTranscript}"`;
            userCallout.classList.remove('hidden');
            // small delay to trigger CSS transition
            setTimeout(() => userCallout.classList.add('visible'), 50);
          }

          this.silenceTimeout = setTimeout(() => {
            if (isSpeaking) return;
            const transcript = this.lastInterimTranscript.trim();
            if (transcript && this.onUserSpeech) {
              console.log('🎤 final transcript (after silence):', transcript);
              if (userCallout) {
                userCallout.innerHTML = `<span class="hearing-indicator">⏳</span> Thinking...`;
              }
              this.onUserSpeech(transcript);
              this.lastInterimTranscript = '';
            }
          }, this.SILENCE_DELAY);
        };

        this.recognition.onerror = (e) => console.warn('Speech recog error:', e.error);
        this.recognition.onend = () => {
          if (this.isRunning && !isSpeaking) {
            try { this.recognition.start(); } catch (e) {}
          }
        };
        this.recognition.start();
      }
    } catch (err) {
      console.error('Mic access failed:', err);
    }
  }

  drawWaves() {
    const canvas = document.getElementById('wave-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width, height = canvas.height;
    const bufferLength = this.analyser ? this.analyser.frequencyBinCount : 128;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!this.isRunning) return;
      this.animationFrame = requestAnimationFrame(draw);
      
      ctx.clearRect(0, 0, width, height);
      
      // Default to silence (128)
      dataArray.fill(128);

      if (isBotSpeaking) {
        if (currentBotAnalyser) {
          currentBotAnalyser.getByteTimeDomainData(dataArray);
        } else {
          // Generate a synthetic voice-like wave pattern for browser TTS
          const time = Date.now() * 0.015;
          for (let i = 0; i < bufferLength; i++) {
            const wave1 = Math.sin(i * 0.15 + time) * 18;
            const wave2 = Math.cos(i * 0.08 + time * 1.3) * 12;
            const noise = (Math.random() - 0.5) * 3;
            dataArray[i] = 128 + wave1 + wave2 + noise;
          }
        }
      } else if (this.analyser) {
        this.analyser.getByteTimeDomainData(dataArray);
      }

      // Draw standard background ring
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, 105, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 188, 212, 0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Draw dynamic visualizer wave around face avatar
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#00bcd4';
      ctx.beginPath();
      
      const baseRadius = 105;
      const maxAmplitude = 30;

      for (let i = 0; i < bufferLength; i++) {
        const angle = (i / bufferLength) * Math.PI * 2;
        const offset = (dataArray[i] - 128) / 128.0;
        const r = baseRadius + offset * maxAmplitude;
        
        const x = width / 2 + Math.cos(angle) * r;
        const y = height / 2 + Math.sin(angle) * r;
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      
      ctx.closePath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#00bcd4';
      ctx.stroke();
      ctx.shadowBlur = 0;
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
