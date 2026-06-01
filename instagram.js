// Instagram Basic Display OAuth 2.0 PKCE flow (client-side only)

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

function base64URLEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64URLEncode(hash);
}

export async function initInstagramAuth() {
  // Replace with your Instagram App's client ID and redirect URI
  const clientId = 'YOUR_INSTAGRAM_CLIENT_ID';  // you'll set this
  const redirectUri = window.location.origin + '/instagram-callback'; // make sure this is added to your app's valid redirect URIs
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Store verifier in sessionStorage for the callback
  sessionStorage.setItem('instagram_code_verifier', codeVerifier);

  const authUrl = `https://api.instagram.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user_profile,user_media&response_type=code&code_challenge=${codeChallenge}&code_challenge_method=S256`;
  window.location.href = authUrl;

  // The page will redirect to the callback. We'll handle the callback in app.js on load.
  return new Promise((resolve, reject) => {
    // The resolution happens when the page reloads and we parse the code.
    // We'll store a flag in sessionStorage to indicate we're waiting.
    sessionStorage.setItem('instagram_auth_pending', 'true');
    // We don't resolve here; we'll handle after redirect in app.js startup.
  });
}

export async function handleInstagramCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (!code) return null;

  const codeVerifier = sessionStorage.getItem('instagram_code_verifier');
  if (!codeVerifier) throw new Error('No code verifier found');

  const clientId = 'YOUR_INSTAGRAM_CLIENT_ID';
  const redirectUri = window.location.origin + '/instagram-callback';

  const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier
    })
  });
  const data = await tokenResponse.json();
  // Clean up sessionStorage
  sessionStorage.removeItem('instagram_code_verifier');
  sessionStorage.removeItem('instagram_auth_pending');
  // Clear the URL code parameter
  window.history.replaceState({}, document.title, window.location.pathname);
  return data; // contains access_token and user_id
}