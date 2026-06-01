// audio.js
import { getVoiceForCharacter, CHARACTERS } from './characters.js';

// ---------------------------------------------------------------------------
// Kokoro TTS (loaded dynamically to avoid breaking the app)
// ---------------------------------------------------------------------------
let kokoroTTS = null;
let kokoroLoadPromise = null;
let isLoading = false;
let kokoroAvailable = true;   // assume it will work, set to false if import fails

async function loadKokoro() {
  if (kokoroTTS) return kokoroTTS;
  if (kokoroLoadPromise) return kokoroLoadPromise;

  if (!kokoroAvailable) throw new Error('Kokoro unavailable');

  isLoading = true;
  updateLoadingUI(true);

  kokoroLoadPromise = (async () => {
    try {
      // Dynamic import – if this fails, kokoroAvailable becomes false
      const { KokoroTTS } = await import('kokoro-js');
      console.log('🔄 Loading Kokoro TTS model (~80MB) …');
      kokoroTTS = await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-ONNX',
        { dtype: 'q8' }
      );
      console.log('✅ Kokoro ready');
      return kokoroTTS;
    } catch (err) {
      console.error('❌ Kokoro failed to load:', err);
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

// Audio playback helpers
let currentAudioContext = null;
let currentSource = null;

function playAudioBuffer(float32Array, sampleRate) {
  stopSpeaking();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  currentAudioContext = ctx;
  const audioBuffer = ctx.createBuffer(1, float32Array.length, sampleRate);
  audioBuffer.getChannelData(0).set(float32Array);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  source.start(0);
  currentSource = source;
}

export function stopSpeaking() {
  try {
    if (currentSource) { currentSource.stop(); currentSource = null; }
    if (currentAudioContext && currentAudioContext.state !== 'closed') {
      currentAudioContext.close();
      currentAudioContext = null;
    }
  } catch (e) { /* ignore */ }
  speechSynthesis.cancel();
}

// Public speak function – tries Kokoro first, then Web Speech
export async function speak(text, characterId) {
  if (!text) return;

  // Try Kokoro if it hasn't failed previously
  if (kokoroAvailable) {
    try {
      await loadKokoro();
      if (kokoroTTS) {
        const char = CHARACTERS[characterId];
        const voiceName = char?.kokoroVoice;
        if (voiceName) {
          const result = await kokoroTTS.generate(text, { voice: voiceName });
          playAudioBuffer(result.audio, result.sample_rate);
          return;
        }
      }
    } catch (err) {
      // Kokoro failed – fall through to Web Speech
      console.warn('Kokoro TTS failed, using browser TTS:', err.message);
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
  speechSynthesis.speak(utterance);
}

// ---------------------------------------------------------------------------
// AudioEngine with 3‑second silence timer
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
    this.SILENCE_DELAY = 3000;   // 3 seconds of silence before sending
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

      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;   // capture partial speech
        this.recognition.lang = 'en-US';

        this.recognition.onresult = (event) => {
          clearTimeout(this.silenceTimeout);
          let interim = '';
          let final = '';

          for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              final += transcript;
            } else {
              interim += transcript;
            }
          }

          if (final) this.lastInterimTranscript = final;
          if (interim) this.lastInterimTranscript = final + interim;

          // Start silence timer – after 3s of no speech, send the transcript
          this.silenceTimeout = setTimeout(() => {
            const transcript = this.lastInterimTranscript.trim();
            if (transcript && this.onUserSpeech) {
              console.log('🎤 final transcript (after silence):', transcript);
              this.onUserSpeech(transcript);
              this.lastInterimTranscript = '';
            }
          }, this.SILENCE_DELAY);
        };

        this.recognition.onerror = (event) => {
          console.warn('Speech recognition error:', event.error);
          clearTimeout(this.silenceTimeout);
        };

        this.recognition.onend = () => {
          if (this.isRunning) this.recognition.start();
        };

        this.recognition.start();
      }

      this.isRunning = true;
    } catch (error) {
      console.error('Microphone access failed:', error);
    }
  }

  drawWaves() {
    const canvas = document.getElementById('wave-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!this.isRunning) return;
      this.animationFrame = requestAnimationFrame(draw);
      this.analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 2;
      const color = getComputedStyle(document.body).getPropertyValue('--text').trim() || '#00bcd4';
      ctx.strokeStyle = color;
      ctx.beginPath();
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
      if (!this.isRunning) return;
      if (Math.random() < 0.05 && !this.musicCooldown) {
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
