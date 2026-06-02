// app.js
import { FriendState, downloadMarkdown } from './state.js';
import { CHARACTERS } from './characters.js';
import {
  showModal, hideModal, updateUserDisplay,
  setupSettingsUI
} from './ui.js';
import { AudioEngine } from './audio.js';
import { LLMEngine } from './llm.js';
import { track } from './analytics.js';

// ---------------------------------------------------------------------------
// System theme detection (runs before anything else)
// ---------------------------------------------------------------------------
(function setInitialTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    document.body.className = savedTheme;
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.className = prefersDark ? 'dark' : 'light';
  }
})();

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
let state = new FriendState();
let audioEngine;
let llm;
let messageCounterSinceSave = 0;

window.addEventListener('load', async () => {
  // 1. Get or create persistent UUID in localStorage
  let uuid = localStorage.getItem('friend_uuid');
  if (!uuid) {
    uuid = crypto.randomUUID();
    localStorage.setItem('friend_uuid', uuid);
  }
  state.uuid = uuid;

  // 2. Try to restore state from Vercel KV (ignore errors)
  try {
    const res = await fetch(`/api/state?uuid=${uuid}`);
    const data = await res.json();
    if (data) {
      state = FriendState.fromJSON(data);
    }
  } catch (err) {
    console.warn('Could not load state from cloud, using fresh state.');
  }

  // 3. If no name set, show new/existing flow
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

    // Name submitted → show SSO modal (dummy buttons)
    document.getElementById('btn-name-next').onclick = () => {
      const name = document.getElementById('name-input').value.trim();
      if (!name) return alert('Please enter a name');
      state.name = name;
      hideModal('modal-name');
      showModal('modal-sso');
    };

    // Upload Markdown file for restoration
    document.getElementById('btn-restore').onclick = () => {
      const file = document.getElementById('md-upload').files[0];
      if (!file) return alert('Select a file');
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const restored = FriendState.fromJSON(e.target.result);
          restored.uuid = uuid;          // keep our local UUID
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

    // ---------- SSO dummy buttons ----------
    document.getElementById('btn-google').onclick = () => alert('Google Sign‑In coming soon!');
    document.getElementById('btn-instagram-sso').onclick = () => alert('Instagram connect coming soon!');
    document.getElementById('btn-spotify-sso').onclick = () => alert('Spotify connect coming soon!');

    document.getElementById('btn-skip').onclick = () => {
      hideModal('modal-sso');
      maybeStartApp();
    };
  } else {
    // Returning user – go straight to the app
    maybeStartApp();
  }

  // Settings button (always available)
  document.getElementById('settings-btn').onclick = () => {
    setupSettingsUI(state, llm, async () => {
      await saveStateToKV();
    });
    showModal('modal-settings');
  };
});

// ---------------------------------------------------------------------------
// API key check & main start
// ---------------------------------------------------------------------------
async function maybeStartApp() {
  // If NO API keys at all, force settings modal
  if (!state.llmKeys.groq && !state.llmKeys.cerebras && !state.llmKeys.openrouter) {
    showModal('modal-settings');
    setupSettingsUI(state, llm, async () => {
      hideModal('modal-settings');
      await saveStateToKV();
      startMain();
    });
    return;
  }
  startMain();
}

async function startMain() {
  updateUserDisplay(state);
  track('main_started', { character: state.character });

  // Initialize LLM with personalised system prompt
  llm = new LLMEngine(state);
  const rawPrompt = CHARACTERS[state.character].prompt;
  llm.setSystemPrompt(rawPrompt.replace('{{userName}}', state.name || 'my friend'));

  // Initialize audio engine (starts mic, STT, etc.)
  audioEngine = new AudioEngine(state, handleUserSpeech);
  await audioEngine.start();

  // Auto‑save state to Vercel KV on tab close
  window.addEventListener('beforeunload', () => {
    saveStateToKV();
    // optional local backup
    downloadMarkdown(state);
  });

  // Periodic auto‑save every 10 messages
  setInterval(() => {
    if (messageCounterSinceSave >= 10) {
      saveStateToKV();
      messageCounterSinceSave = 0;
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// Speech handler (called after 3s silence + noise gate – see audio.js)
// Now with console logging and delayed compaction
// ---------------------------------------------------------------------------
async function handleUserSpeech(transcript) {
  if (!llm || !audioEngine) return;

  // Special marker for music detection
  if (transcript === '__MUSIC_DETECTED__') {
    const text = "I hear music. What song is this?";
    audioEngine.speak(text, state.character);
    track('music_detected');
    return;
  }

  state.messageCount++;
  messageCounterSinceSave++;

  console.log('🧑 User:', transcript);

  const response = await llm.chat(transcript);
  if (!response) return;

  console.log('🤖 Bot:', response);

  audioEngine.speak(response, state.character);
  state.compactedContext.push({ role: 'user', content: transcript });
  state.compactedContext.push({ role: 'assistant', content: response });
  track('message_exchanged', { count: state.messageCount });

  // Delayed compaction – avoids rapid API calls and gives the user time to hear the reply
  setTimeout(async () => {
    if (!audioEngine || !audioEngine.isRunning) return;
    await maybeCompact();
  }, 2000);
}

// ---------------------------------------------------------------------------
// Smart conversation compaction (summarise old messages, keep last 5 raw)
// ---------------------------------------------------------------------------
async function maybeCompact() {
  const CONTEXT_LIMIT = 10;   // keep the last 10 messages raw, summarise the rest
  if (state.compactedContext.length > CONTEXT_LIMIT) {
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

async function generateSummary(messages, existingSummary) {
  if (!llm) return existingSummary || '';
  const prompt = `Summarize this conversation in one paragraph (max 4 sentences), keeping important facts and names. Previous summary: "${existingSummary}". Messages: ${JSON.stringify(messages)}`;
  try {
    const result = await llm.chat(prompt);
    return result || existingSummary || '';
  } catch (e) {
    return existingSummary || '';
  }
}

// ---------------------------------------------------------------------------
// Cloud persistence (Vercel KV) – harmless if KV not set up
// ---------------------------------------------------------------------------
async function saveStateToKV() {
  try {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: state.uuid,
        state: state.toJSON(),
      }),
    });
  } catch (e) {
    console.error('Failed to save state to cloud', e);
  }
}
