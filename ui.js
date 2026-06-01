// ui.js
import { downloadMarkdown, FriendState } from './state.js';
import { CHARACTERS } from './characters.js';

// ---------- Modal helpers ----------
export function showModal(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

export function hideModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

// ---------- User display ----------
export function updateUserDisplay(state) {
  const avatar = document.getElementById('user-avatar');
  const nameSpan = document.getElementById('user-name-display');
  if (state.email || state.name) {
    avatar.style.display = 'inline-block';
    avatar.src = state.avatarUrl || 'https://via.placeholder.com/30';
    nameSpan.textContent = state.name || 'Friend';
  } else {
    avatar.style.display = 'none';
    nameSpan.textContent = state.name || '';
  }

  // Show Instagram / Spotify buttons if tokens exist? We just keep them visible.
  document.getElementById('btn-instagram').style.display = 'inline-block';
  document.getElementById('btn-spotify').style.display = 'inline-block';
}

// ---------- Settings modal ----------
export function setupSettingsUI(state, llmEngine, onSave) {
  const charSelect = document.getElementById('character-select');
  const groqInput = document.getElementById('groq-key');
  const cerebrasInput = document.getElementById('cerebras-key');
  const themeSelect = document.getElementById('theme-toggle');

  // Pre-fill values
  charSelect.value = state.character;
  groqInput.value = state.llmKeys.groq;
  cerebrasInput.value = state.llmKeys.cerebras;
  themeSelect.value = document.body.classList.contains('dark') ? 'dark' : 'light';

  document.getElementById('btn-save-settings').onclick = () => {
    state.character = charSelect.value;
    state.llmKeys.groq = groqInput.value.trim();
    state.llmKeys.cerebras = cerebrasInput.value.trim();
    if (llmEngine) llmEngine.setSystemPrompt(CHARACTERS[state.character].prompt);
    document.body.className = themeSelect.value;
    window.va && window.va('event', { name: 'settings_saved' });
    hideModal('modal-settings');
    if (onSave) onSave();
  };

  document.getElementById('btn-download-data').onclick = () => {
    downloadMarkdown(state);
    window.va && window.va('event', { name: 'data_downloaded' });
  };

  document.getElementById('btn-close-settings').onclick = () => {
    hideModal('modal-settings');
  };

  themeSelect.addEventListener('change', (e) => {
    document.body.className = e.target.value;
  });
}

// ---------- PKCE helpers ----------
function base64URLEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64URLEncode(hash);
}

// ---------- Instagram Basic Display (no review) ----------
const INSTAGRAM_CLIENT_ID = 'YOUR_INSTAGRAM_CLIENT_ID';   // <-- REPLACE

export function setupInstagramConnect(state, onTokenSaved) {
  const btn = document.getElementById('btn-instagram');
  if (!btn) return;

  btn.onclick = async () => {
    try {
      const redirectUri = window.location.origin + '/instagram-callback';
      const verifier = await generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);

      sessionStorage.setItem('insta_verifier', verifier);
      sessionStorage.setItem('insta_pending', 'true');

      const authUrl = `https://api.instagram.com/oauth/authorize?client_id=${INSTAGRAM_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user_profile,user_media&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`;
      window.location.href = authUrl;
    } catch (err) {
      console.error('Instagram auth error:', err);
    }
  };
}

export async function handleInstagramCallback(state) {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (!code) return false;

  const verifier = sessionStorage.getItem('insta_verifier');
  if (!verifier) return false;

  try {
    const redirectUri = window.location.origin + '/instagram-callback';
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: INSTAGRAM_CLIENT_ID,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    });
    const data = await tokenRes.json();

    if (data.access_token) {
      state.instagramToken = {
        access_token: data.access_token,
        user_id: data.user_id,
      };
      sessionStorage.removeItem('insta_verifier');
      sessionStorage.removeItem('insta_pending');
      window.history.replaceState({}, document.title, window.location.pathname);
      return true;
    }
  } catch (e) {
    console.error('Instagram token exchange failed:', e);
  }
  return false;
}

// ---------- Spotify PKCE ----------
const SPOTIFY_CLIENT_ID = 'YOUR_SPOTIFY_CLIENT_ID';   // <-- REPLACE

export function setupSpotifyConnect(state, onTokenSaved) {
  const btn = document.getElementById('btn-spotify');
  if (!btn) return;

  btn.onclick = async () => {
    try {
      const redirectUri = window.location.origin + '/spotify-callback';
      const verifier = await generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);

      sessionStorage.setItem('spotify_verifier', verifier);
      sessionStorage.setItem('spotify_pending', 'true');

      const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user-read-recently-played%20user-top-read&code_challenge_method=S256&code_challenge=${challenge}`;
      window.location.href = authUrl;
    } catch (err) {
      console.error('Spotify auth error:', err);
    }
  };
}

export async function handleSpotifyCallback(state) {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (!code) return false;

  const verifier = sessionStorage.getItem('spotify_verifier');
  if (!verifier) return false;

  try {
    const redirectUri = window.location.origin + '/spotify-callback';
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    const data = await tokenRes.json();

    if (data.access_token) {
      state.spotifyToken = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
      };
      sessionStorage.removeItem('spotify_verifier');
      sessionStorage.removeItem('spotify_pending');
      window.history.replaceState({}, document.title, window.location.pathname);
      return true;
    }
  } catch (e) {
    console.error('Spotify token exchange failed:', e);
  }
  return false;
}