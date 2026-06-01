// llm.js
export class LLMEngine {
  constructor(state) {
    this.state = state;
    this.systemPrompt = '';
    this.exhausted = { groq: false, cerebras: false, openrouter: false };
  }

  setSystemPrompt(prompt) {
    this.systemPrompt = prompt;
  }

  async chat(userMessage) {
    if (!this.state.llmKeys.groq && !this.state.llmKeys.cerebras && !this.state.llmKeys.openrouter) {
      return "I need an API key. Set it in settings.";
    }

    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.state.compactedContext
        .filter(m => m.role !== 'system')
        .slice(-5),
      { role: 'user', content: userMessage }
    ];

    let response;

    // 1. Groq (free: llama-3.1-8b-instant)
    if (!this.exhausted.groq && this.state.llmKeys.groq) {
      try {
        response = await this.callGroq(messages);
      } catch (e) {
        console.error('Groq error:', e.message);
        if (e.message.includes('429') || e.message.includes('quota')) this.exhausted.groq = true;
      }
    }

    // 2. Cerebras
    if (!response && !this.exhausted.cerebras && this.state.llmKeys.cerebras) {
      try {
        response = await this.callCerebras(messages);
      } catch (e) {
        console.error('Cerebras error:', e.message);
        if (e.message.includes('429') || e.message.includes('quota')) this.exhausted.cerebras = true;
      }
    }

    // 3. OpenRouter (free fallback)
    if (!response && !this.exhausted.openrouter && this.state.llmKeys.openrouter) {
      try {
        response = await this.callOpenRouter(messages);
      } catch (e) {
        console.error('OpenRouter error:', e.message);
        if (e.message.includes('429') || e.message.includes('quota')) this.exhausted.openrouter = true;
      }
    }

    if (!response) {
      document.getElementById('face-circle').textContent = '😴';
      return "Looks like we're out of free tokens. Let's talk later... 😴";
    }
    return response;
  }

  async callGroq(messages) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.state.llmKeys.groq}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',   // ✅ current free model on Groq
        messages,
        max_tokens: 150,
        temperature: 0.9
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 429) throw new Error('429');
      throw new Error(`Groq API error (${res.status}): ${JSON.stringify(err)}`);
    }
    const data = await res.json();
    return data.choices[0].message.content;
  }

  async callCerebras(messages) {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.state.llmKeys.cerebras}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-oss-120b',
        messages,
        max_tokens: 150,
        temperature: 0.9
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 429) throw new Error('429');
      throw new Error(`Cerebras API error (${res.status}): ${JSON.stringify(err)}`);
    }
    const data = await res.json();
    return data.choices[0].message.content;
  }

  async callOpenRouter(messages) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.state.llmKeys.openrouter}`,
        'HTTP-Referer': 'https://chatter-box-theta-lake.vercel.app',
        'X-Title': 'Friend AI',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'mistralai/mistral-7b-instruct:free',
        messages,
        max_tokens: 150,
        temperature: 0.9
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 429) throw new Error('429');
      throw new Error(`OpenRouter API error (${res.status}): ${JSON.stringify(err)}`);
    }
    const data = await res.json();
    return data.choices[0].message.content;
  }
}
