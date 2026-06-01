// llm.js (Cerebras model: gpt-oss-120b)
export class LLMEngine {
  constructor(state) {
    this.state = state;
    this.systemPrompt = '';
    this.exhausted = { groq: false, cerebras: false };
  }

  setSystemPrompt(prompt) { this.systemPrompt = prompt; }

  async chat(userMessage) {
    if (!this.state.llmKeys.groq && !this.state.llmKeys.cerebras) {
      return "I need an API key. Set it in settings.";
    }

    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.state.compactedContext.slice(-5),
      { role: 'user', content: userMessage }
    ];

    let response;

    // Try Groq first
    if (!this.exhausted.groq && this.state.llmKeys.groq) {
      try {
        response = await this.callGroq(messages);
      } catch (e) {
        if (e.message.includes('429') || e.message.includes('quota') || e.message.includes('rate')) {
          this.exhausted.groq = true;
          console.warn('Groq quota exhausted, switching to Cerebras.');
        } else {
          console.error('Groq error:', e.message);
        }
      }
    }

    // Fallback to Cerebras
    if (!response && !this.exhausted.cerebras && this.state.llmKeys.cerebras) {
      try {
        response = await this.callCerebras(messages);
      } catch (e) {
        if (e.message.includes('429') || e.message.includes('quota') || e.message.includes('rate')) {
          this.exhausted.cerebras = true;
          console.warn('Cerebras quota exhausted.');
        } else {
          console.error('Cerebras error:', e.message);
        }
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
        model: 'llama3-70b-8192',
        messages,
        max_tokens: 150,
        temperature: 0.9
      })
    });
    if (!res.ok) {
      if (res.status === 429) throw new Error('429');
      const errorText = await res.text();
      throw new Error(`Groq API error (${res.status}): ${errorText}`);
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
      if (res.status === 429) throw new Error('429');
      const errorText = await res.text();
      throw new Error(`Cerebras API error (${res.status}): ${errorText}`);
    }
    const data = await res.json();
    return data.choices[0].message.content;
  }
}
