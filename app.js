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

// Cache: weather results keyed by location name, expires after 30 minutes
const weatherCache = new Map(); // key -> { result, timestamp }
const WEATHER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes in ms

// Location context: only inject once per session so it doesn't pollute every prompt
let locationInjectedOnce = false;

// ---------------------------------------------------------------------------
// Expression Parser & Emoji Mapping
// ---------------------------------------------------------------------------
const EXPRESSION_MAP = {
  smile: '😊',
  giggle: '😅',
  laugh: '😄',
  grin: '😁',
  chuckle: '😆',
  smirk: '😏',
  wink: '😉',
  gasp: '😮',
  tease: '😜',
  love: '🥰',
  blush: '😊',
  hug: '🤗',
  heart: '😍',
  think: '🤔',
  ponder: '🧐',
  hmm: '🤔',
  confused: '😕',
  sigh: '😔',
  shrug: '🤷',
  sad: '😢',
  cry: '😭',
  angry: '😠',
  mad: '😡',
  annoyed: '😒',
  scared: '😱',
  fear: '😨',
  shocked: '😱',
  tired: '🥱',
  yawn: '🥱',
  sleep: '😴',
};

function parseExpression(text) {
  let emoji = '😊'; // Default smiley emoji for all bots
  let cleanedText = text;

  // 1. Look for enclosed action expressions (e.g. *smiles*, [laughs], (chuckles))
  const actionRegex = /[\*\[\(]([^*\]\)]+)[\*\]\)]/g;
  let match;
  let matchedActions = [];
  while ((match = actionRegex.exec(text)) !== null) {
    matchedActions.push(match[1].toLowerCase().trim());
  }

  // If we found action expressions, map them to emojis
  if (matchedActions.length > 0) {
    const lastAction = matchedActions[matchedActions.length - 1];
    for (const [key, val] of Object.entries(EXPRESSION_MAP)) {
      if (lastAction.includes(key)) {
        emoji = val;
        break;
      }
    }
  } else {
    // 2. Look for emojis in the text itself
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E6}-\u{1F1FF}]/gu;
    const emojis = text.match(emojiRegex);
    if (emojis && emojis.length > 0) {
      emoji = emojis[0];
    } else {
      // 3. Fallback: check general keywords in the text
      const lowerText = text.toLowerCase();
      for (const [key, val] of Object.entries(EXPRESSION_MAP)) {
        if (lowerText.includes(key)) {
          emoji = val;
          break;
        }
      }
    }
  }

  // Clean the text by removing all enclosed action expressions
  cleanedText = text
    .replace(/[\*\[\(][^*\]\)]+[\*\]\)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { emoji, cleanedText };
}

function cleanQueryForSearch(text) {
  return text
    .replace(/^(?:what(?:'s|s|is)?|tell\s+me\s+about|show\s+me|find|search\s+for|do\s+you\s+know\s+about|any\s+news\s+on|situation\s+of|latest\s+on)\s+/i, '')
    .replace(/\?+$/, '')
    .trim();
}

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
    document.getElementById('name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('btn-name-next').click();
      }
    });

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

  // Ensure default smiley emoji is set initially
  const face = document.getElementById('face-circle');
  if (face) face.textContent = '😊';

  audioEngine = new AudioEngine(state, handleUserSpeech);
  await audioEngine.start();

  // Proactive chat – 45 seconds of true silence
  lastSpeechTime = Date.now();
  proactiveInterval = setInterval(async () => {
    if (!audioEngine || !audioEngine.isRunning) return;
    if (isBotSpeaking) return;

    const silenceDuration = (Date.now() - lastSpeechTime) / 1000;
    if (silenceDuration > 45) {
      await proactiveChat();
      lastSpeechTime = Date.now();
    }
  }, 5000);

  window.addEventListener('botFinishedSpeaking', () => {
    lastSpeechTime = Date.now();
  });

  window.addEventListener('clearBotCallouts', () => {
    clearBotCallouts();
  });

  window.addEventListener('beforeunload', () => {
    saveStateToKV();
    downloadMarkdown(state);
    clearInterval(proactiveInterval);
  });
}

// ---------------------------------------------------------------------------
// Speech handler – with real‑time data injection (logged)
// ---------------------------------------------------------------------------
async function handleUserSpeech(transcript) {
  if (!llm || !audioEngine) return;
  lastSpeechTime = Date.now();

  if (transcript === '__MUSIC_DETECTED__') {
    audioEngine.speak("I hear music. What song is this?", state.character);
    return;
  }

  // Clear and hide user callout when response generation begins
  const userCallout = document.getElementById('user-callout');
  if (userCallout) {
    userCallout.classList.remove('visible');
    setTimeout(() => userCallout.classList.add('hidden'), 300);
  }

  state.messageCount++;
  messageCounterSinceSave++;
  console.log('🧑 User:', transcript);

  const messages = [
    { role: 'system', content: llm.systemPrompt },
    ...state.compactedContext.filter(m => m.role !== 'system').slice(-5),
    { role: 'user', content: transcript }
  ];

  // Inject real‑time data and log what was injected
  const injection = await getContextualInjection(transcript);
  if (injection) {
    console.log('📡 Injected system message:', injection);
    messages.splice(1, 0, { role: 'system', content: injection });
  } else {
    console.log('📡 No real‑time data injected for this query.');
  }

  const response = await sendLLMRequest(messages);
  if (!response) return;

  console.log('🤖 Bot:', response);

  showResponseCallouts(response);

  state.compactedContext.push({ role: 'user', content: transcript });
  state.compactedContext.push({ role: 'assistant', content: response });

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
// Context injection (weather, news, location awareness) – with logging
// ---------------------------------------------------------------------------
async function getContextualInjection(userText) {
  const parts = [];
  const lower = userText.toLowerCase();

  // Weather (only if the user explicitly asked about weather, uses cache)
  const weatherInfo = await getWeatherInfo(userText);
  if (weatherInfo) {
    console.log('🌤️ Weather data retrieved (from cache or API):', weatherInfo);
    parts.push(`Current weather: ${weatherInfo}`);
  }

  // News (support search topics or general news/current situation)
  const isNewsQuery = /news|headlines|what'?s\s+(?:happening|going\s+on)|latest\s+(?:events|updates)|current\s+(?:events|situation|status)/i.test(lower);
  if (isNewsQuery) {
    const headlines = await getNewsHeadlines(userText);
    if (headlines) {
      console.log('📰 News headlines retrieved:', headlines);
      parts.push(`Latest news updates: ${headlines}`);
    } else {
      console.log('📰 Failed to fetch news headlines.');
    }
  }

  // Location context: inject only once per session and only when not already
  // providing weather data (which implies location). This prevents the bot from
  // awkwardly shoehorning location into every single unrelated reply.
  if (!weatherInfo && !locationInjectedOnce && state.location) {
    parts.push(`(Context: the user is located in ${state.location.city}, ${state.location.country}. Only mention this if it's actually relevant to the topic.)`);
    locationInjectedOnce = true;
    console.log('📍 Location context injected for the first time this session.');
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo, no key) – ONLY fetches if user asked about weather.
// Results are cached per location name for 30 minutes.
// ---------------------------------------------------------------------------
async function getWeatherInfo(userText) {
  const lower = userText.toLowerCase();
  
  // List of keywords to check if user is asking about weather
  const weatherKeywords = ['weather', 'temp', 'temperature', 'rain', 'raining', 'forecast', 'climate', 'windy', 'cloudy', 'sunny'];
  const isAskingWeather = weatherKeywords.some(k => lower.includes(k));
  if (!isAskingWeather) return null;

  let location = null;
  
  const locationPatterns = [
    /(?:weather|forecast|temperature|temp|rain)\s+(?:in|at|for|of)\s+([a-zA-Z\s]+?)(?:\?|$|today|tomorrow|now|currently|please)/i,
    /(?:in|at|for|of)\s+([a-zA-Z\s]+?)\s+(?:weather|forecast|temperature|temp|rain)/i,
    /\b([a-zA-Z]+)\s+(?:weather|forecast|temp|temperature|rain)\b/i
  ];
  for (const p of locationPatterns) {
    const match = userText.match(p);
    if (match) {
      const candidate = match[1]?.trim();
      if (candidate && !['today', 'tomorrow', 'now', 'the', 'a', 'an', 'this', 'next', 'me', 'us', 'what', 'how'].includes(candidate.toLowerCase())) {
        location = candidate;
        break;
      }
    }
  }

  // Clean up location from common words
  if (location) {
    location = location
      .replace(/\b(today|tomorrow|now|please|right\s+now|currently|forecast|temp|temperature|weather|report|conditions|the|this|next|like|is|how|what|what's)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Fallback to detected state location
  if (!location && state.location) {
    location = state.location.city;
  }

  if (!location) return null;

  const cacheKey = location.toLowerCase();

  // Return cached result if still fresh
  const cached = weatherCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < WEATHER_CACHE_TTL) {
    console.log(`🌤️ Weather cache HIT for "${location}" (${Math.round((Date.now() - cached.timestamp) / 60000)}min old)`);
    return cached.result;
  }

  try {
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`);
    if (!geoRes.ok) throw new Error(`Geocoding failed (${geoRes.status})`);
    const geoData = await geoRes.json();
    if (!geoData.results?.length) {
      console.warn(`🌤️ No geocoding results for "${location}"`);
      return null;
    }
    const { latitude, longitude, country } = geoData.results[0];

    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`);
    if (!weatherRes.ok) throw new Error(`Weather API failed (${weatherRes.status})`);
    const weatherData = await weatherRes.json();
    const current = weatherData.current_weather;
    if (!current) throw new Error('No current weather data');
    const result = `${location} (${country}): ${current.temperature}°C, wind ${current.windspeed} km/h`;

    // Store in cache
    weatherCache.set(cacheKey, { result, timestamp: Date.now() });
    console.log(`🌤️ Weather API fetched and cached for "${location}"`);
    return result;
  } catch (e) {
    console.error('🌤️ Weather fetch error:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// News (Google News Search RSS → rss2json, free, no key)
// ---------------------------------------------------------------------------
async function getNewsHeadlines(query = "") {
  let searchWord = query ? cleanQueryForSearch(query) : "";
  if (!searchWord || searchWord.toLowerCase() === 'news' || searchWord.toLowerCase() === 'headlines') {
    searchWord = "world news";
  }

  console.log(`🔍 Searching Google News RSS for: "${searchWord}"`);
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchWord)}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const encoded = encodeURIComponent(rssUrl);
    const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encoded}`);
    if (!res.ok) {
      console.warn(`📰 rss2json returned ${res.status} for ${searchWord}`);
      return null;
    }
    const data = await res.json();
    if (data.items?.length > 0) {
      return data.items.slice(0, 5).map(item => item.title).join('; ');
    } else {
      console.warn(`📰 Google News RSS returned no items for: ${searchWord}`);
    }
  } catch (e) {
    console.error(`📰 News fetch failed for ${searchWord}:`, e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proactive chat (silence → topic) – also uses the same injection
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
    showResponseCallouts(response);
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

// ---------------------------------------------------------------------------
// Callout Management (Multiple circular and big scrollable callouts)
// ---------------------------------------------------------------------------
function clearBotCallouts() {
  const botCallout = document.getElementById('bot-callout');
  if (botCallout) {
    botCallout.classList.remove('visible');
    setTimeout(() => botCallout.classList.add('hidden'), 300);
  }
  
  const bigCallout = document.getElementById('big-callout');
  if (bigCallout) {
    bigCallout.classList.remove('visible');
    setTimeout(() => bigCallout.classList.add('hidden'), 300);
  }

  const avatarContainer = document.getElementById('avatar-container');
  if (avatarContainer) {
    const circulars = avatarContainer.querySelectorAll('.circular-callout');
    circulars.forEach(el => {
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 300);
    });
  }
}

function extractCodeAndText(text) {
  const codeRegex = /```([\s\S]*?)```/g;
  let match;
  const codeBlocks = [];
  
  while ((match = codeRegex.exec(text)) !== null) {
    codeBlocks.push(match[1].trim());
  }
  
  const plainText = text.replace(/```[\s\S]*?```/g, '').trim();
  return { codeBlocks, plainText };
}

function formatCodeBlock(code) {
  const lines = code.split('\n');
  if (lines.length > 0 && /^[a-zA-Z0-9+#-]+$/.test(lines[0].trim())) {
    lines.shift();
  }
  return lines.join('\n');
}

function splitIntoSentences(text) {
  // Strip action expressions (*smiles*, [laughs])
  let clean = text.replace(/[\*\[\(][^*\]\)]+[\*\]\)]/g, '').trim();
  
  // Split by sentence ending punctuation followed by space
  const sentences = clean.split(/(?<=[.!?])\s+/);
  return sentences
    .map(s => s.trim())
    .filter(s => s.length > 3);
}

function showResponseCallouts(response) {
  // 1. Clear any existing callouts
  clearBotCallouts();

  // 2. Parse expression to change face emoji
  const parsed = parseExpression(response);
  const face = document.getElementById('face-circle');
  if (face) face.textContent = parsed.emoji;

  // 3. Extract code blocks and plain text
  const { codeBlocks, plainText } = extractCodeAndText(parsed.cleanedText);
  const hasCode = codeBlocks.length > 0;
  const isLongText = plainText.length > 220;

  // Handle Big Callout if code exists or dialogue is very long
  const bigCallout = document.getElementById('big-callout');
  const bigCalloutText = document.getElementById('big-callout-text');
  const copyBtn = document.getElementById('btn-copy-code');

  if (bigCallout && bigCalloutText) {
    if (hasCode || isLongText) {
      let contentHtml = '';
      if (hasCode) {
        contentHtml += `<p>${plainText}</p>`;
        codeBlocks.forEach(code => {
          const formatted = formatCodeBlock(code);
          contentHtml += `<pre><code>${formatted.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
        });
        
        // Setup copy button
        if (copyBtn) {
          copyBtn.style.display = 'block';
          copyBtn.onclick = () => {
            const combinedCode = codeBlocks.map(formatCodeBlock).join('\n\n');
            navigator.clipboard.writeText(combinedCode).then(() => {
              copyBtn.textContent = 'Copied! ✅';
              setTimeout(() => { copyBtn.textContent = 'Copy Code'; }, 2000);
            });
          };
        }
      } else {
        contentHtml += `<p>${plainText}</p>`;
        if (copyBtn) copyBtn.style.display = 'none';
      }

      bigCalloutText.innerHTML = contentHtml;
      bigCallout.classList.remove('hidden');
      setTimeout(() => bigCallout.classList.add('visible'), 50);
    } else {
      bigCallout.classList.remove('visible');
      setTimeout(() => bigCallout.classList.add('hidden'), 300);
    }
  }

  // 4. Render text callout(s)
  // If we have code, we show the associated plain text inside the circular arrangement.
  // Otherwise, split the text into sentences for circular distribution.
  const sentences = splitIntoSentences(plainText);
  const avatarContainer = document.getElementById('avatar-container');

  if (sentences.length <= 1 && !hasCode) {
    // Single short sentence: show standard top bot-callout
    const botCallout = document.getElementById('bot-callout');
    if (botCallout && sentences.length > 0) {
      botCallout.textContent = sentences[0];
      botCallout.classList.remove('hidden');
      setTimeout(() => botCallout.classList.add('visible'), 50);
    }
  } else if (avatarContainer) {
    // Multiple sentences or code shared: distribute circularly around visualizer (radius D)
    const D = 280; // Radius outside 400x400 canvas (which has 200px radius)
    let angles = [];
    const N = sentences.length;

    if (N === 2) {
      angles = [-140, -40];
    } else if (N === 3) {
      angles = [-150, -90, -30];
    } else if (N === 4) {
      angles = [-150, -90, -30, 40];
    } else {
      angles = [-150, -90, -30, 40, 140];
    }

    sentences.slice(0, angles.length).forEach((sentence, idx) => {
      const angleDeg = angles[idx];
      const angleRad = (angleDeg * Math.PI) / 180;
      
      const x = 100 + D * Math.cos(angleRad);
      const y = 100 + D * Math.sin(angleRad);
      
      const div = document.createElement('div');
      div.className = 'circular-callout';
      div.textContent = sentence;
      div.style.left = `${x}px`;
      div.style.top = `${y}px`;
      
      // Bubble tail tail-shape pointing towards the center
      if (angleDeg < -90) {
        div.style.borderRadius = '20px 20px 2px 20px'; // Top-left quadrant -> tail bottom-right
      } else if (angleDeg < 0) {
        div.style.borderRadius = '20px 20px 20px 2px'; // Top-right quadrant -> tail bottom-left
      } else if (angleDeg < 90) {
        div.style.borderRadius = '2px 20px 20px 20px'; // Bottom-right quadrant -> tail top-left
      } else {
        div.style.borderRadius = '20px 2px 20px 20px'; // Bottom-left quadrant -> tail top-right
      }

      avatarContainer.appendChild(div);
      setTimeout(() => {
        div.classList.add('visible');
      }, 50 + idx * 100);
    });
  }

  // 5. Speak the conversational (plain text) part
  audioEngine.speak(plainText, state.character);
}
