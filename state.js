// state.js

export class FriendState {
  constructor() {
    this.uuid = crypto.randomUUID();
    this.name = '';
    this.email = '';
    this.avatarUrl = '';
    this.ssoProvider = '';
    this.character = 'max';
    this.personality = {
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      emotionalStability: 0.5,
      humorPlayfulness: 0.5,
      curiosity: 0.5,
      assertiveness: 0.5
    };
    this.llmKeys = {
      groq: '',
      cerebras: ''
    };
    this.instagramToken = null;    // { access_token, user_id }
    this.spotifyToken = null;     // { access_token, refresh_token, expires_in }
    this.lastSummary = '';
    this.compactedContext = [];   // array of { role, content }
    this.messageCount = 0;
    this.sessionStart = Date.now();
  }

  // Serialise to a plain object (used for KV storage and download)
  toJSON() {
    return {
      uuid: this.uuid,
      name: this.name,
      email: this.email,
      avatarUrl: this.avatarUrl,
      ssoProvider: this.ssoProvider,
      character: this.character,
      personality: this.personality,
      llmKeys: this.llmKeys,
      instagramToken: this.instagramToken,
      spotifyToken: this.spotifyToken,
      lastSummary: this.lastSummary,
      compactedContext: this.compactedContext,
      messageCount: this.messageCount
    };
  }

  // Restore from a plain object (or JSON string)
  static fromJSON(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const state = new FriendState();
    Object.assign(state, data);
    return state;
  }

  // Generate a Markdown representation (for manual download)
  toMarkdown() {
    const data = this.toJSON();
    const yamlBlock = Object.entries(data)
      .map(([key, value]) => {
        // format arrays/objects nicely
        return `${key}: ${JSON.stringify(value, null, 2)}`;
      })
      .join('\n');

    const contextBlock = this.compactedContext
      .map(c => `${c.role}: ${c.content}`)
      .join('\n');

    return `---\n${yamlBlock}\n---\n\n## Conversation Context\n${contextBlock}`;
  }
}

// Trigger a browser download of the state as a Markdown file
export function downloadMarkdown(state) {
  const content = state.toMarkdown();
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `friend-ai-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}