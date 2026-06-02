// app.js
import { FriendState, downloadMarkdown } from './state.js';
import { CHARACTERS } from './characters.js';
import {
  showModal, hideModal, updateUserDisplay,
  setupSettingsUI
} from './ui.js';
import { AudioEngine, isBotSpeaking } from './audio.js';
import { LLMEngine } from './llm.js';
import { track } from './analytics.js';

// ---------------------------------------------------------------------------
// System theme detection
// ---------------------------------------------------------------------------
(function setInitialTheme() {
  const savedTheme = localStorage.getItem('theme');
  document.body.className = savedTheme || (
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  );
})();

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
let state = new FriendState();
let audioEngine;
let llm;
let messageCounterSinceSave = 0;
let lastSpeechTime = 0;
let proactiveInterval = null;

// ---------------------------------------------------------------------------
// Location detection (asks browser permission)
// ---------------------------------------------------------------------------
async function detectLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      console.warn('Geolocation not supported, defaulting to India');
      return resolve({ city: 'India', country: 'IN' });
    }
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const { latitude, longitude } = position.coords;
          const res = await fetch(
            `https://geocoding-api.open-meteo.com/v1/search?latitude=${latitude}&longitude=${longitude}&count=1&language=en&format=json`
          );
          const data = await res.json();
          if (data.results?.length > 0) {
            const { name, country } = data.results[0];
            resolve({ city: name, country });
          } else {
            resolve({ city: 'India', country: 'IN' });
          }
        } catch (e) {
          resolve({ city: 'India', country: 'IN' });
        }
      },
      (err) => {
        console.warn('Location permission denied or error:', err.message);
        resolve({ city: 'India', country: 'IN' });
      },
      { timeout: 5000 }
    );
  });
}

// ---------------------------------------------------------------------------
// WINDOW LOAD
// ---------------------------------------------------------------------------
window.addEventListener('load', async () => {
  // 1. UUID
  let uuid = localStorage.getItem('friend_uuid');
  if (!uuid) {
    uuid = crypto.randomUUID();
    localStorage.setItem('friend_uuid', uuid);
  }
  state.uuid = uuid;

  // 2. Load state from KV (ignore errors)
  try {
    const res = await fetch(`/api/state?uuid=${uuid}`);
    const data = await res.json();
    if (data) state = FriendState.fromJSON(data);
  } catch (e) {}

  // 3. Detect location
  const location = await detectLocation();
  state.location = location;
  console.log('📍 Detected location:', location);

  // 4. Show appropriate UI
  if (!state.name) {
    showModal('modal-new-existing');

    document.getElementById('btn-new').onclick = () => {
      hideModal('modal-new-existing');
      showModal('modal-name');
    };
    document.getElementById('btn-existing').onclick = () => {
      hideModal('modal-new-existing');
      showModal('modal-upload');
    };
    document.getElementById('btn-name-next').onclick = () => {
      const name = document.getElementById('name-input').value.trim();
      if (!name) return alert('Please enter a name');
      state.name = name;
      hideModal('modal-name');
      showModal('modal-sso');
    };
    document.getElementById('btn-restore').onclick = () => {
      const file = document.getElementById('md-upload').files[0];
      if (!file) return alert('Select a file');
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const restored = FriendState.fromJSON(e.target.result);
          restored.uuid = uuid;
          state = restored;
          saveStateToKV();
          hideModal('modal-upload');
          maybeStartApp();
        } catch (err) {
          alert('Invalid file. Please try again.');
        }
      };
      reader.readAsText(file);
    };
    // SSO dummy buttons
    document.getElementById('btn-google').onclick = () => alert('Google Sign‑In coming soon!');
    document.getElementById('btn-instagram-sso').onclick = () => alert('Instagram connect coming soon!');
    document.getElementById('btn-spotify-sso').onclick = () => alert('Spotify connect coming soon!');
    document.getElementById('btn-skip').onclick = () => {
      hideModal('modal-sso');
      maybeStartApp();
    };
  } else {
    maybeStartApp();
  }

  document.getElementById('settings-btn').onclick = () => {
    setupSettingsUI(state, llm, () => saveStateToKV());
    showModal('modal-settings');
  };
});

// ---------------------------------------------------------------------------
// API key check & main start
// ---------------------------------------------------------------------------
async function maybeStartApp() {
  if (!state.llmKeys.groq && !state.llmKeys.cerebras && !state.llmKeys.openrouter) {
    showModal('modal-settings');
    setupSettingsUI(state, llm, () => {
      hideModal('modal-settings');
      startMain();
    });
    return;
  }
  startMain();
}

async function startMain() {
  updateUserDisplay(state);
  track('main_started', { character: state.character });

  llm = new LLMEngine(state);
  const rawPrompt = CHARACTERS[state.character].prompt;
  llm.setSystemPrompt(rawPrompt.replace('{{userName}}', state.name || 'my friend'));

  audioEngine = new AudioEngine(state, handleUserSpeech);
  await audioEngine.start();

  // Proactive chat – 45 seconds of true silence
  lastSpeechTime = Date.now();
  proactiveInterval = setInterval(async () => {
    if (!audioEngine || !audioEngine.isRunning) return;
    if (isBotSpeaking) return;               // don't interrupt bot

    const silenceDuration = (Date.now() - lastSpeechTime) / 1000;
    if (silenceDuration > 45) {
      await proactiveChat();
      lastSpeechTime = Date.now();
    }
  }, 5000);

  // Reset silence timer when bot finishes speaking
  window.addEventListener('botFinishedSpeaking', () => {
    lastSpeechTime = Date.now();
  });

  window.addEventListener('beforeunload', () => {
    saveStateToKV();
    downloadMarkdown(state);
    clearInterval(proactiveInterval);
  });
}

// ---------------------------------------------------------------------------
// Speech handler – with real‑time data injection
// ---------------------------------------------------------------------------
async function handleUserSpeech(transcript) {
  if (!llm || !audioEngine) return;
  lastSpeechTime = Date.now();   // reset silence timer

  if (transcript === '__MUSIC_DETECTED__') {
    audioEngine.speak("I hear music. What song is this?", state.character);
    return;
  }

  state.messageCount++;
  messageCounterSinceSave++;
  console.log('🧑 User:', transcript);

  const messages = [
    { role: 'system', content: llm.systemPrompt },
    ...state.compactedContext.filter(m => m.role !== 'system').slice(-5),
    { role: 'user', content: transcript }
  ];

  // Inject weather / news / location context
  const injection = await getContextualInjection(transcript);
  if (injection) {
    messages.splice(1, 0, { role: 'system', content: injection });
  }

  const response = await sendLLMRequest(messages);
  if (!response) return;

  console.log('🤖 Bot:', response);
  audioEngine.speak(response, state.character);

  state.compactedContext.push({ role: 'user', content: transcript });
  state.compactedContext.push({ role: 'assistant', content: response });

  // Delayed compaction
  setTimeout(async () => {
    if (!audioEngine || !audioEngine.isRunning) return;
    await maybeCompact();
  }, 2000);

  if (messageCounterSinceSave >= 10) {
    saveStateToKV();
    messageCounterSinceSave = 0;
  }
}

// ---------------------------------------------------------------------------
// Context injection (weather, news, location awareness)
// ---------------------------------------------------------------------------
async function getContextualInjection(userText) {
  const parts = [];
  const lower = userText.toLowerCase();

  // Weather
  const weatherInfo = await getWeatherInfo(userText);
  if (weatherInfo) parts.push(`Current weather: ${weatherInfo}`);

  // News
  if (/news|headlines|what'?s\s+happening/i.test(lower)) {
    const headlines = await getNewsHeadlines();
    if (headlines) parts.push(`Latest headlines: ${headlines}`);
  }

  // Always append general location context (if not already about weather)
  if (!weatherInfo && state.location) {
    parts.push(`The user's approximate location is ${state.location.city}, ${state.location.country}.`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Weather (Open‑Meteo, no key)
// ---------------------------------------------------------------------------
async function getWeatherInfo(userText) {
  const patterns = [
    /weather\s+(?:in|at|for)\s+([a-zA-Z\s]+?)(?:\?|$)/i,
    /what'?s?\s+the\s+weather\s+(?:in|at|for)\s+([a-zA-Z\s]+?)(?:\?|$)/i,
    /weather\s+([a-zA-Z\s]+?)(?:\?|$)/i
  ];
  let location = null;
  for (const p of patterns) {
    const match = userText.match(p);
    if (match) {
      location = match[1].trim();
      break;
    }
  }
  if (!location && state.location) {
    location = state.location.city;
  }
  if (!location) return null;

  try {
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`);
    const geoData = await geoRes.json();
    if (!geoData.results?.length) return null;
    const { latitude, longitude, country } = geoData.results[0];

    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`);
    const weatherData = await weatherRes.json();
    const current = weatherData.current_weather;
    if (!current) return null;
    return `${location} (${country}): ${current.temperature}°C, wind ${current.windspeed} km/h`;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// News (NPR RSS → rss2json, free, no key)
// ---------------------------------------------------------------------------
async function getNewsHeadlines() {
  try {
    const rssUrl = encodeURIComponent('https://feeds.npr.org/1004/rss.xml');
    const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${rssUrl}`);
    const data = await res.json();
    if (data.items?.length) {
      return data.items.slice(0, 5).map(item => item.title).join('; ');
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proactive chat (silence → topic)
// ---------------------------------------------------------------------------
async function proactiveChat() {
  const topics = [
    async () => {
      if (state.location) {
        const info = await getWeatherInfo(`weather in ${state.location.city}`);
        return info ? `Let's talk about the weather: ${info}` : null;
      }
      return null;
    },
    async () => {
      const headlines = await getNewsHeadlines();
      return headlines ? `Here's some news: ${headlines}. Start a conversation about it.` : null;
    },
    () => "What's on your mind today?",
    () => "Tell me something interesting!",
    () => "Any plans for the day?",
  ];

  const topic = topics[Math.floor(Math.random() * topics.length)];
  let prompt = typeof topic === 'function' ? await topic() : topic;
  if (!prompt) return;

  const response = await sendLLMRequest([
    { role: 'system', content: llm.systemPrompt },
    { role: 'user', content: prompt }
  ]);
  if (response) {
    audioEngine.speak(response, state.character);
    state.compactedContext.push({ role: 'assistant', content: response });
    console.log('🤖 Proactive:', response);
  }
}

// ---------------------------------------------------------------------------
// LLM helper (uses chatWithMessages from llm.js)
// ---------------------------------------------------------------------------
async function sendLLMRequest(messages) {
  return llm.chatWithMessages(messages);
}

// ---------------------------------------------------------------------------
// Smart conversation compaction
// ---------------------------------------------------------------------------
async function maybeCompact() {
  const LIMIT = 10;
  if (state.compactedContext.length > LIMIT) {
    const recent = state.compactedContext.slice(-5);
    const older = state.compactedContext.slice(0, -5);
    if (older.length === 0) return;
    const summary = await generateSummary(older, state.lastSummary);
    state.lastSummary = summary;
    state.compactedContext = [
      { role: 'system', content: `[Conversation history: ${summary}]` },
      ...recent
    ];
  }
}

async function generateSummary(messages, existing) {
  if (!llm) return existing || '';
  const prompt = `Summarize this conversation in one paragraph, keeping important facts and names. Previous summary: "${existing}". Messages: ${JSON.stringify(messages)}`;
  try {
    const result = await llm.chat(prompt);
    return result || existing || '';
  } catch (e) {
    return existing || '';
  }
}

// ---------------------------------------------------------------------------
// KV persistence
// ---------------------------------------------------------------------------
async function saveStateToKV() {
  try {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: state.uuid, state: state.toJSON() }),
    });
  } catch (e) {}
}
