'use strict';

const OpenAI = require('openai');

class OpenAIProvider {
  constructor(apiKey, model) {
    this.client = new OpenAI({ apiKey });
    this.modelName = model || 'gpt-4o-mini';
  }

  async chat(messages, onChunk, options = {}) {
    const DEBUG = process.env.DEBUG_ATTACHMENTS === 'true';
    const modelName = options.modelOverride?.model || this.modelName;

    // ── Build messages ──
    const systemMessages = messages
      .filter(m => m.role === 'system')
      .map(m => ({ role: 'system', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));

    const openaiMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        if (Array.isArray(m.content)) {
          const parts = m.content.map(part => {
            if (part.type === 'text') return { type: 'text', text: part.text };
            if (part.type === 'image_url') {
              return { type: 'image_url', image_url: { url: part.image_url?.url || '' } };
            }
            return { type: 'text', text: JSON.stringify(part) };
          });
          return { role: m.role, content: parts };
        }
        return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      });

    const allMessages = [...systemMessages, ...openaiMessages];

    if (DEBUG) {
      console.log('\n─── [DEBUG] OpenAIProvider.chat() ───');
      console.log('  model:', modelName);
      console.log('  messages:', allMessages.length);
      allMessages.forEach((m, i) => {
        const isArr = Array.isArray(m.content);
        console.log(`    msg[${i}] role=${m.role}: isArray=${isArr}`);
        if (isArr) {
          m.content.forEach((p, j) => {
            if (p.type === 'image_url') {
              const url = p.image_url?.url || '';
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              console.log(`      part[${j}]: image_url mimeType=${match?.[1] || '?'} data_len=${match?.[2]?.length || url.length}`);
            } else {
              console.log(`      part[${j}]: text len=${p.text?.length || 0}`);
            }
          });
        } else {
          console.log(`      content len=${String(m.content || '').length}`);
        }
      });
    }

    // ── Build request params ──
    const params = {
      model: modelName,
      messages: allMessages,
      stream: true,
    };

    // Tool calling: pass tools if available in options
    if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
      params.tools = options.tools;
      if (options.tool_choice) {
        params.tool_choice = options.tool_choice;
      }
    }

    // ── Execute ──
    try {
      const response = await this.client.chat.completions.create(params);

      let fullResponse = '';
      let toolCalls = [];

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta;

        // Text content
        const text = delta?.content;
        if (text) {
          fullResponse += text;
          if (onChunk) onChunk(text, 'text');
        }

        // Tool calls (streaming)
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              while (toolCalls.length <= tc.index) {
                toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
              }
              const existing = toolCalls[tc.index];
              if (tc.id) existing.id = tc.id;
              if (tc.type) existing.type = tc.type;
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            }
          }
        }
      }

      // If tool calls were received, append them to the response
      if (toolCalls.length > 0) {
        const toolCallStr = JSON.stringify(toolCalls);
        fullResponse += toolCallStr;
        if (onChunk) onChunk(toolCallStr, 'tool_calls');
      }

      return fullResponse;
    } catch (err) {
      const msg = err.message || String(err);
      const status = err.status || err.statusCode || 0;

      // Map common errors to descriptive messages
      if (status === 429 || msg.includes('429') || msg.includes('rate_limit')) {
        throw new Error(`OpenAI rate limited (429): ${msg.substring(0, 120)}`);
      }
      if (status === 401 || msg.includes('401') || msg.includes('unauthorized')) {
        throw new Error(`OpenAI authentication failed (401): check OPENAI_API_KEY`);
      }
      if (status === 403 || msg.includes('403') || msg.includes('forbidden')) {
        throw new Error(`OpenAI access denied (403): ${msg.substring(0, 120)}`);
      }
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
        throw new Error(`OpenAI connection failed: ${msg.substring(0, 120)}`);
      }
      if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
        throw new Error(`OpenAI timeout: ${msg.substring(0, 120)}`);
      }

      throw new Error(`OpenAI error (${status || 'unknown'}): ${msg.substring(0, 150)}`);
    }
  }
}

module.exports = OpenAIProvider;
