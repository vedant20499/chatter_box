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
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
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

      try {
        await loadKokoro();
      } catch(e) {
        console.warn('Background Kokoro load failed, using fallback:', e.message);
      }

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

          // Clear all bot callouts as soon as user starts speaking
          window.dispatchEvent(new Event('clearBotCallouts'));

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

        this.recognition.onstart = () => {
          console.log('🎤 Speech recognition started');
          this.networkRetryActive = false;
          const userCallout = document.getElementById('user-callout');
          if (userCallout && userCallout.innerHTML.includes('Connection lost')) {
            userCallout.classList.remove('visible');
            setTimeout(() => {
              userCallout.classList.add('hidden');
              userCallout.innerHTML = '';
            }, 300);
          }
        };
        this.recognition.onerror = (e) => {
          console.warn('Speech recog error:', e.error);
          if (e.error === 'network') {
            const userCallout = document.getElementById('user-callout');
            if (userCallout) {
              userCallout.innerHTML = `<span class="hearing-indicator">📡</span> Connection lost. Reconnecting...`;
              userCallout.classList.remove('hidden');
              userCallout.classList.add('visible');
              
              // Auto-hide the connection lost banner after 4 seconds
              setTimeout(() => {
                if (userCallout && userCallout.innerHTML.includes('Connection lost')) {
                  userCallout.classList.remove('visible');
                  setTimeout(() => {
                    userCallout.classList.add('hidden');
                    userCallout.innerHTML = '';
                  }, 300);
                }
              }, 4000);
            }
            this.networkRetryActive = true;
          }
        };
        this.recognition.onend = () => {
          if (this.isRunning && !isSpeaking) {
            const delay = this.networkRetryActive ? 5000 : 50;
            this.networkRetryActive = false;
            setTimeout(() => {
              if (this.isRunning && !isSpeaking) {
                try { this.recognition.start(); } catch (err) {}
              }
            }, delay);
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

      // Calculate RMS volume to scale the wave amplitude dynamically
      let sumSq = 0;
      for (let i = 0; i < bufferLength; i++) {
        const val = (dataArray[i] - 128) / 128;
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / bufferLength);
      const volume = Math.min(1.0, rms * 4.0); // scale sensitivity
      
      const baseRadius = 115; // Larger base radius to clear the face-circle
      const targetAmplitude = 4 + volume * 50; // Dynamic amplitude with 4px baseline
      
      const time = Date.now() * 0.003;
      
      // 3 overlapping sinusoidal waves with different colors, speeds, frequencies
      const waves = [
        { color: 'rgba(0, 230, 118, 0.75)', freq: 3, speed: 1.5, ampMult: 1.0, phaseShift: 0 },
        { color: 'rgba(0, 188, 212, 0.85)', freq: 4, speed: -1.2, ampMult: 0.8, phaseShift: Math.PI / 3 },
        { color: 'rgba(33, 150, 243, 0.65)', freq: 2, speed: 2.0, ampMult: 0.6, phaseShift: Math.PI * 2 / 3 }
      ];

      // Draw background ring (slightly larger)
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, baseRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 188, 212, 0.05)';
      ctx.lineWidth = 1;
      ctx.stroke();

      waves.forEach((w) => {
        ctx.beginPath();
        ctx.strokeStyle = w.color;
        ctx.lineWidth = 3;
        ctx.shadowBlur = 10;
        ctx.shadowColor = w.color;
        
        const numPoints = 120;
        for (let i = 0; i <= numPoints; i++) {
          const theta = (i / numPoints) * Math.PI * 2;
          
          // Generate a smooth sinusoidal pattern periodic in 2*pi
          const waveVal = Math.sin(w.freq * theta + time * w.speed + w.phaseShift) * 
                          Math.cos(2 * theta - time * w.speed * 0.5);
                          
          const amp = targetAmplitude * w.ampMult;
          const r = baseRadius + waveVal * amp;
          
          const x = width / 2 + Math.cos(theta) * r;
          const y = height / 2 + Math.sin(theta) * r;
          
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.closePath();
        ctx.stroke();
      });
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

      let lowMidSum = 0;
      const range = Math.min(bufferLength, 64);
      for (let i = 0; i < range; i++) {
        lowMidSum += dataArray[i];
      }
      const lowMidAvg = lowMidSum / range;

      if (lowMidAvg > 45 && Math.random() < 0.05 && !this.musicCooldown) {
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
