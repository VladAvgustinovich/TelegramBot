import 'dotenv/config';
import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import axios from 'axios';

const telegramToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const openaiKey = (process.env.OPENROUTER_API_KEY || '').trim();
const openaiBaseUrl = 'https://openrouter.ai/api/v1';
const deepgramKey = (process.env.DEEPGRAM_API_KEY || '').trim();
const webAppUrl = (process.env.WEB_APP_URL || '').trim();


if (!telegramToken || !openaiKey) {
  console.error('Please set TELEGRAM_BOT_TOKEN and OPENROUTER_API_KEY in .env');
  process.exit(1);
}

const bot = new Telegraf(telegramToken);
const openai = new OpenAI({
  apiKey: openaiKey,
  baseURL: openaiBaseUrl,
  defaultHeaders: {
    'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost',
    'X-Title': process.env.OPENROUTER_TITLE || 'Telegram Chatty Bot',
  },
});

const systemPrompt =
  'Ты помощник-редактор. Исправляй орфографию, грамматику и пунктуацию. Верни три строки строго в этом формате без лишнего текста и маркдауна:\n' +
  'Оригинальный текст: <оригинальный текст>\n' +
  'Исправленный текст: <исправленный текст>\n' +
  'Перевод: <если исходный язык английский — переведи на русский; если русский — на английский>\n' +
  'Обьяснение: <1–3 коротких пункта, какие правки внесены и почему>';

// Model and token limits (can be overridden via .env)
const chatModel = process.env.OPENAI_MODEL || 'deepseek/deepseek-chat';
const maxTokens = Number(process.env.OPENAI_MAX_TOKENS ?? 512);

async function correctText(text: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: chatModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    temperature: 0.2,
    max_tokens: isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 512,
  });

  const out = completion.choices[0]?.message?.content?.trim();
  return out || text;
}

async function lookupWordBrief(query: string): Promise<string> {
  const prompt = `Ты двуязычный лингвист. Для фразы или слова:
"${query}"
Дай краткий вывод в 3–5 строках:
1) Translation (RU↔EN)
2) Meaning (кратко)
3) Examples (2 очень коротких примера)
Форматируй кратко, без лишних пояснений.`;
  const completion = await openai.chat.completions.create({
    model: chatModel,
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 256,
  });
  return completion.choices[0]?.message?.content?.trim() || '';
}

bot.start(async (ctx) => {
  await ctx.reply(
    'Привет! Пришли мне текст или голосовое сообщение — я исправлю текст и верну результат.'
  );
  if (webAppUrl) {
    try {
      await bot.telegram.setChatMenuButton({
        menu_button: { type: 'web_app', text: 'Open App', web_app: { url: webAppUrl } },
      });
    } catch {}
    await ctx.reply('Открыть мини‑приложение', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Open', web_app: { url: webAppUrl } }]],
      },
    });
  }
});

// Handle WebApp data (from mini app)
bot.on('message', async (ctx, next) => {
  const anyMsg: any = ctx.message as any;
  const raw = anyMsg?.web_app_data?.data;
  if (!raw) return next();
  try {
    const payload = JSON.parse(raw);
    if (payload?.type === 'text' && typeof payload.text === 'string') {
      await ctx.sendChatAction('typing');
      const text = payload.text.trim();
      if (!text) return ctx.reply('Пустой текст');
      const corrected = await correctText(text);
      return ctx.reply(corrected);
    }
    if (payload?.type === 'lookup' && typeof payload.text === 'string') {
      await ctx.sendChatAction('typing');
      const word = payload.text.trim();
      if (!word) return ctx.reply('Пустой запрос');
      const info = await lookupWordBrief(word);
      return ctx.reply(info || 'Нет данных');
    }
    return ctx.reply('Неподдерживаемый формат данных из WebApp');
  } catch (e) {
    console.error('web_app_data parse error', e);
    return ctx.reply('Не удалось обработать данные мини‑приложения');
  }
});

bot.command('app', async (ctx) => {
  if (!webAppUrl) {
    await ctx.reply('WEB_APP_URL не задан. Укажите HTTPS ссылку в .env');
    return;
  }
  await ctx.reply('Открыть мини‑приложение', {
    reply_markup: { inline_keyboard: [[{ text: 'Open', web_app: { url: webAppUrl } }]] },
  });
});

bot.on('text', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const userText = (ctx.message.text || '').trim();
    if (!userText) {
      await ctx.reply('Пустое сообщение. Отправьте текст для исправления.');
      return;
    }
    const corrected = await correctText(userText);
    await ctx.reply(corrected);
  } catch (err) {
    console.error(err);
    await ctx.reply('Упс! Что-то пошло не так. Попробуйте ещё раз позже.');
  }
});

bot.on('voice', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const voice = ctx.message.voice;
    const fileId = voice.file_id;

    const link = await ctx.telegram.getFileLink(fileId);
    const url = typeof link === 'string' ? link : link.toString();

    const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    let transcript = '';
    if (deepgramKey) {
      const dg = await axios.post(
        'https://api.deepgram.com/v1/listen?smart_format=true',
        buffer,
        {
          headers: {
            Authorization: `Token ${deepgramKey}`,
            'Content-Type': 'audio/ogg',
          },
        }
      );
      transcript =
        (dg.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript as string) || '';
    } else {
      await ctx.reply(
        'Распознавание речи отключено. Укажите DEEPGRAM_API_KEY в .env, чтобы включить.'
      );
    }
    if (!transcript.trim()) {
      await ctx.reply('Не удалось распознать речь. Попробуйте ещё раз.');
      return;
    }
    const corrected = await correctText(transcript);
    const replyText = corrected || transcript || 'Не удалось распознать речь. Попробуйте ещё раз.';
    await ctx.reply(replyText);
  } catch (err) {
    console.error(err);
    await ctx.reply('Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже.');
  }
});

bot.launch().then(() => {
  console.log('Bot started.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));



