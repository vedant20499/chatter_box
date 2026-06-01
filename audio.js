// audio.js
import { getVoiceForCharacter } from './characters.js';

export class AudioEngine {
  constructor(state, onUserSpeech) {
    this.state = state;
    this.onUserSpeech = onUserSpeech;   // callback(transcript)
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.recognition = null;
    this.isRunning = false;
    this.musicCooldown = false;
    this.animationFrame = null;
  }

  // Start the microphone, visualizer, sound classification, and speech recognition
  async start() {
    try {
      // 1. Get microphone stream
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // 2. Create audio context and analyser for wave visualisation
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      // 3. Start wave drawing
      this.drawWaves();

      // 4. Start ambient sound classification loop (simplified)
      this.soundClassifyLoop();

      // 5. Start Web Speech API recognition (if available)
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US';

        this.recognition.onresult = (event) => {
          const last = event.results.length - 1;
          const transcript = event.results[last][0].transcript.trim();
          if (transcript && this.onUserSpeech) {
            this.onUserSpeech(transcript);
          }
        };

        this.recognition.onerror = (event) => {
          // Ignore common non-critical errors (e.g., 'no-speech')
          console.warn('Speech recognition error:', event.error);
        };

        this.recognition.start();
      }

      this.isRunning = true;
    } catch (error) {
      console.error('Could not access microphone:', error);
      // The app can still work without a mic (manual text input later)
    }
  }

  // Animate the circular wave visualizer using canvas
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
      ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--text').trim() || '#00bcd4';
      ctx.beginPath();

      const sliceWidth = width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      ctx.lineTo(width, height / 2);
      ctx.stroke();
    };

    draw();
  }

  // Simple ambient sound classifier (music detection simulated)
  soundClassifyLoop() {
    setInterval(() => {
      if (!this.isRunning) return;

      // In a full version, run YAMNet on a short audio buffer here.
      // For now, we simulate a music detection event occasionally.
      // The cooldown prevents spamming "What song is this?".
      if (Math.random() < 0.05 && !this.musicCooldown) {
        if (this.onUserSpeech) {
          this.onUserSpeech('__MUSIC_DETECTED__');
        }
        this.musicCooldown = true;
        setTimeout(() => {
          this.musicCooldown = false;
        }, 30000);   // 30 seconds cooldown
      }
    }, 5000);
  }

  // Speak a phrase using TTS with character-specific voice, pitch and rate
  speak(text, characterId) {
    if (!this.isRunning) return;

    const utterance = new SpeechSynthesisUtterance(text);

    // Get the best matching voice
    const voice = getVoiceForCharacter(characterId);
    if (voice) utterance.voice = voice;

    // Apply pitch and rate from character config
    const config = (window.CHARACTERS && window.CHARACTERS[characterId]?.voiceConfig) || {};
    utterance.pitch = config.pitch || 1;
    utterance.rate = config.rate || 1;

    speechSynthesis.speak(utterance);
  }

  // Clean up all resources
  stop() {
    this.isRunning = false;

    if (this.recognition) {
      this.recognition.stop();
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
    }

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
  }
}